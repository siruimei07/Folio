//! The open library's workspace for the shell (docs/specs/ipc-m2.md §6, §14; versioning.md §6.5):
//! one tracker per session keeps `HEAD` in the catalog and the workspace computed, answers the
//! commands from what it computed, and sends `WorkspaceChanged`.
//!
//! - **Head sync** (`folio_core::workspace::sync`): when the session activates, after a catalog
//!   rebuild (forced: everything is derived again, versioning.md §13.2), when `HEAD` changes
//!   ([`Tracker::head_changed`], for the commit lane) and when a load finds another `HEAD` in the
//!   catalog. It holds the history lock, which commits, rewords, uncommits and restores take too
//!   ([`Tracker::history`]). A sync that fails is tried again when a command asks, or at a
//!   notification once [`RETRY_INTERVAL`] has passed. Why a history is damaged, read-only or too
//!   large goes to the log, once for each `HEAD` and problem.
//! - **Notifications** come from the worker: every commit it reports (scans, metadata rescans,
//!   hash and readiness batches, imports, operations: [`Tracker::catalog_changed`],
//!   [`Tracker::changed`]), every `CatalogChanged` it sends ([`Tracker::catalog_sent`]), and a
//!   rebuild's start and end. Each bumps a generation, but a commit of search bodies alone, which
//!   the workspace does not read ([`Tracker::search_changed`]).
//! - **Computing** (`Workspace::load`) runs on the tracker's thread only, so it is single-flight:
//!   at once for a command that waits, otherwise at most every [`EVENT_INTERVAL`] while changes
//!   keep coming. The snapshot is kept with the generation it was computed after; a command waits
//!   for the first head sync, then for a snapshot at least as new as the notifications before it.
//!   Before the catalog's first scan the workspace lists nothing (the catalog does not know the
//!   disk yet, and `HEAD`'s files would all show as deleted); while a rebuild runs nothing is
//!   computed, and commands get the last snapshot.
//! - **`WorkspaceChanged`** goes out when a snapshot differs from the last one sent, in its items
//!   or metadata changes, `HEAD` or the history's state: at most every [`EVENT_INTERVAL`], and only
//!   once the worker has sent the `CatalogChanged` of every revision the snapshot read (§14). The
//!   worker reports a commit right after it, so a snapshot read in that gap of microseconds could
//!   still go first; the event waits for the tracker's next send, tens of milliseconds later at
//!   the soonest, and is checked again then.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, PoisonError, TryLockError};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use folio_core::catalog::{self, Catalog, CatalogError};
use folio_core::meta::{Layout, LibraryId};
use folio_core::store::{ObjectId, StoreError};
use folio_core::workspace::{
    HeadState, HistoryStatus, LoadError, Snapshot, SyncError, Workspace, sync,
};

use super::{Event, Sink, catalog_error, io_error, lock};
use crate::error::AppError;
use crate::ipc::events::WorkspaceChanged;
use crate::ipc::workspace::HistoryState;

/// At most four `WorkspaceChanged` a second (ipc-m2.md §14); also how often the tracker computes
/// by itself while changes keep coming.
pub(crate) const EVENT_INTERVAL: Duration = Duration::from_millis(250);

/// How long a failed head sync waits before a notification tries it again; a command tries it
/// again at once.
pub(crate) const RETRY_INTERVAL: Duration = Duration::from_secs(5);

/// The workspace of one library session (see the module's docs).
pub(crate) struct Tracker {
    shared: Arc<Shared>,
    thread: Mutex<Option<JoinHandle<()>>>,
}

struct Shared {
    catalog: Arc<Catalog>,
    layout: Layout,
    library: LibraryId,
    emit: Sink,
    /// The session's: events go out only while it is active.
    active: Arc<AtomicBool>,
    state: Mutex<State>,
    /// Wakes the tracker's thread: a notification, a command that waits, the stop.
    wake: Condvar,
    /// Wakes commands: a head sync or a computation ended, or the tracker stopped.
    done: Condvar,
    /// Stops a head sync or a computation that runs when the session closes.
    cancel: AtomicBool,
    /// Held by every change of the history, so that none runs beside another: the head sync
    /// here, and commits, rewords, uncommits and restores (feat/core-commit-history).
    history: Mutex<()>,
}

#[derive(Default)]
struct State {
    /// The session activated: the tracker works.
    started: bool,
    stopped: bool,
    /// The tracker's thread panicked: commands fail instead of waiting.
    broken: bool,
    /// Bumped by every notification and head sync: what a snapshot was computed after.
    generation: u64,
    /// A head sync is due; `true` derives everything again.
    sync: Option<bool>,
    /// The last head sync failed: when, and whether it was forced.
    failed: Option<(Instant, bool)>,
    /// Head syncs that ended.
    syncs: u64,
    /// What the last head sync found; `None` until the first one ends.
    head: Option<Result<Arc<HeadState>, AppError>>,
    rebuilding: bool,
    /// Rebuilds that started: a computation that saw one start drops what it read.
    rebuilds: u64,
    computed: Option<Computed>,
    /// Computations that ended.
    computes: u64,
    /// A command found a failed computation and asks for another.
    retry: bool,
    /// Commands waiting for a snapshot: the tracker computes for them at once.
    waiting: usize,
    last_compute: Option<Instant>,
    /// The first catalog revision whose `CatalogChanged` the worker has not sent yet.
    unsent: Option<u32>,
    /// The latest revision the worker merged into a `CatalogChanged`.
    merged: u32,
    /// A snapshot that differs from the last one sent, whose event waits for its turn.
    due: Option<Current>,
    sent: Option<Sent>,
    last_event: Option<Instant>,
}

impl State {
    /// Whether the tracker should compute: nothing computed yet, notifications since, or a
    /// command that asks again after a failure.
    fn is_stale(&self) -> bool {
        match &self.computed {
            None => true,
            Some(Computed::Ready(current)) => current.generation < self.generation,
            Some(Computed::Failed { generation, .. }) => {
                *generation < self.generation || (self.retry && self.waiting > 0)
            }
        }
    }

    /// Asks for a head sync, keeping a forced one forced.
    fn ask_sync(&mut self, force: bool) {
        self.sync = Some(self.sync.unwrap_or(false) || force);
    }

    /// A notification: something the workspace depends on may have changed.
    fn notified(&mut self) {
        self.generation += 1;
        if let Some((at, force)) = self.failed
            && at.elapsed() >= RETRY_INTERVAL
        {
            self.failed = None;
            self.ask_sync(force);
        }
    }

    /// The worker merged a commit at `revision` into the `CatalogChanged` it has not sent yet.
    fn merged(&mut self, revision: u32) {
        self.unsent.get_or_insert(revision);
        self.merged = self.merged.max(revision);
    }
}

enum Computed {
    Ready(Current),
    Failed { generation: u64, error: AppError },
}

/// What the last `WorkspaceChanged` said.
struct Sent {
    snapshot: Arc<Snapshot>,
    head: Option<ObjectId>,
    state: HistoryState,
}

impl Sent {
    fn of(current: &Current) -> Self {
        Self {
            snapshot: current.snapshot.clone(),
            head: current.head.head(),
            state: current.history_state(),
        }
    }

    /// Whether `current` says what this event said: the same items and metadata changes (their
    /// keys, sides, readiness and parts), `HEAD` and state.
    fn matches(&self, current: &Current) -> bool {
        self.head == current.head.head()
            && self.state == current.history_state()
            && (Arc::ptr_eq(&self.snapshot, &current.snapshot)
                || self.snapshot.workspace == current.snapshot.workspace)
    }
}

/// The workspace as the commands answer it: a snapshot of the catalog and the head sync's state
/// it was loaded against.
#[derive(Debug, Clone)]
pub(crate) struct Current {
    generation: u64,
    head: Arc<HeadState>,
    snapshot: Arc<Snapshot>,
}

impl Current {
    pub(crate) fn workspace(&self) -> &Workspace {
        &self.snapshot.workspace
    }

    /// The catalog revision the workspace was read at.
    pub(crate) fn revision(&self) -> u32 {
        self.snapshot.stamp.revision
    }

    pub(crate) fn history_state(&self) -> HistoryState {
        history_state(self.head.status())
    }

    /// `HEAD`'s commit id, as the contract writes object ids.
    pub(crate) fn head(&self) -> Option<String> {
        self.head.head().map(|id| id.to_string())
    }

    fn event(&self) -> WorkspaceChanged {
        let totals = self.workspace().totals();
        WorkspaceChanged {
            revision: self.revision(),
            head: self.head(),
            history_state: self.history_state(),
            total: totals.items.saturating_add(totals.metadata),
        }
    }
}

/// The history's state as the contract says it (ipc-m2.md §6.1). `starting` is the first commit's
/// (feat/core-commit-history). A history too large to show is `damaged` until that lane adds a
/// state for it that is not damage (decision m2-too-large-folder).
pub(crate) fn history_state(status: HistoryStatus) -> HistoryState {
    match status {
        HistoryStatus::None => HistoryState::None,
        HistoryStatus::Ready => HistoryState::Ready,
        HistoryStatus::ReadOnly => HistoryState::ReadOnly,
        HistoryStatus::Damaged | HistoryStatus::TooLarge => HistoryState::Damaged,
    }
}

/// Why a head sync stopped (ipc-m2.md §15.2): the catalog as everywhere in the shell (ipc-m1
/// §16.2), the catalog failing to answer the store the same way, a file of the store by its I/O
/// error.
pub(crate) fn sync_error(error: SyncError) -> AppError {
    match error {
        SyncError::Catalog(error) => catalog_error(error),
        SyncError::Io(StoreError::Io { source, .. }) => {
            if source
                .get_ref()
                .is_some_and(|inner| inner.is::<CatalogError>())
            {
                match source
                    .into_inner()
                    .map(|inner| inner.downcast::<CatalogError>())
                {
                    Some(Ok(error)) => catalog_error(*error),
                    _ => AppError::Internal("the catalog failed to answer the store".to_owned()),
                }
            } else {
                io_error(source)
            }
        }
        // `SyncError::Io` holds `StoreError::Io` only.
        SyncError::Io(error) => AppError::Internal(error.to_string()),
        // A link in `.folio/`: as in `load_error`.
        SyncError::Meta(error) => AppError::Internal(error.to_string()),
        SyncError::Cancelled => closing(),
    }
}

/// Why the workspace could not be loaded (ipc-m2.md §15.2): the catalog as everywhere in the
/// shell; `.folio/meta/` that cannot be listed is `Internal` (the problem list names it).
pub(crate) fn load_error(error: LoadError) -> AppError {
    match error {
        LoadError::Catalog(error) => catalog_error(error),
        LoadError::Meta(error) => AppError::Internal(error.to_string()),
        // The tracker syncs again instead; a command never sees it.
        LoadError::HeadChanged => AppError::Internal(error.to_string()),
        LoadError::Cancelled => closing(),
    }
}

fn closing() -> AppError {
    AppError::NoLibrary("the library is closing".to_owned())
}

/// What a command waits for.
enum Answer {
    Ready(Current),
    /// A rebuild runs and nothing was computed: the workspace lists nothing meanwhile.
    Empty(Arc<HeadState>, u64),
    Failed(AppError),
}

impl Tracker {
    /// A tracker for the library whose `.folio/` `layout` describes, with the id `library`, its
    /// catalog, and the session's sink and active flag. It starts working once activated.
    pub(super) fn new(
        catalog: Arc<Catalog>,
        layout: Layout,
        library: LibraryId,
        emit: Sink,
        active: Arc<AtomicBool>,
    ) -> Self {
        Self {
            shared: Arc::new(Shared {
                catalog,
                layout,
                library,
                emit,
                active,
                state: Mutex::default(),
                wake: Condvar::new(),
                done: Condvar::new(),
                cancel: AtomicBool::new(false),
                history: Mutex::new(()),
            }),
            thread: Mutex::new(None),
        }
    }

    /// Starts the tracker's thread, which waits for [`Tracker::activate`].
    pub(super) fn start(&self) -> Result<(), AppError> {
        let shared = self.shared.clone();
        let thread = std::thread::Builder::new()
            .name("folio-workspace".to_owned())
            .spawn(move || {
                let _exit = Exit(&shared);
                shared.run();
            })
            .map_err(io_error)?;
        *lock(&self.thread) = Some(thread);
        Ok(())
    }

    /// The session activated: the first head sync, then the workspace.
    pub(super) fn activate(&self) {
        self.update(|state| {
            state.started = true;
            state.ask_sync(false);
        });
    }

    /// The worker committed a change and merged it into the pending `CatalogChanged`, at
    /// `revision`. Called under the worker's lock of that event, so the tracker knows exactly
    /// which revisions still wait for theirs.
    pub(super) fn catalog_changed(&self, revision: u32) {
        self.update(|state| {
            state.notified();
            state.merged(revision);
        });
    }

    /// The worker committed search bodies alone (text extraction), which the workspace does not
    /// read, and merged them into the pending `CatalogChanged`, at `revision`: nothing to compute,
    /// but a `WorkspaceChanged` that reads the revision still waits for that event.
    pub(super) fn search_changed(&self, revision: u32) {
        self.update(|state| state.merged(revision));
    }

    /// The worker committed something that sends no `CatalogChanged`, such as a metadata rescan
    /// that changed no row: `library.json` and `.folio/ignore` are read from the disk.
    pub(super) fn changed(&self) {
        self.update(State::notified);
    }

    /// The worker sent the `CatalogChanged` of every change it had merged up to `revision`.
    pub(super) fn catalog_sent(&self, revision: u32) {
        self.update(|state| {
            state.unsent = if state.merged <= revision {
                None
            } else {
                // Merged since the event was taken: later than `revision`.
                let next = revision.saturating_add(1);
                Some(state.unsent.map_or(next, |first| first.max(next)))
            };
        });
    }

    /// A catalog rebuild starts: nothing is computed and no event sent until it ends.
    pub(super) fn rebuilding(&self) {
        self.update(|state| {
            state.rebuilding = true;
            state.rebuilds += 1;
        });
    }

    /// The rebuild ended, done or not: a forced head sync, then the workspace again.
    pub(super) fn rebuilt(&self) {
        self.update(|state| {
            state.rebuilding = false;
            state.ask_sync(true);
            state.generation += 1;
        });
    }

    /// `HEAD` changed (a commit, a first commit, an uncommit): a head sync, then the workspace. A
    /// command from now on waits for both.
    #[cfg_attr(
        not(test),
        expect(dead_code, reason = "feat/core-commit-history calls it after a commit")
    )]
    pub(crate) fn head_changed(&self) {
        self.update(|state| {
            state.ask_sync(false);
            state.generation += 1;
        });
    }

    /// The history lock, for a commit, reword, uncommit or restore: `HistoryBusy` while another
    /// one, or a head sync, holds it (ipc-m2.md §15.1).
    #[cfg_attr(
        not(test),
        expect(
            dead_code,
            reason = "feat/core-commit-history takes it for every history change"
        )
    )]
    pub(crate) fn history(&self) -> Result<MutexGuard<'_, ()>, AppError> {
        match self.shared.history.try_lock() {
            Ok(guard) => Ok(guard),
            // A panic while it was held changed nothing the lock guards by itself.
            Err(TryLockError::Poisoned(poisoned)) => Ok(poisoned.into_inner()),
            Err(TryLockError::WouldBlock) => Err(AppError::HistoryBusy(
                "another change of the history is running".to_owned(),
            )),
        }
    }

    /// Stops the tracker: a head sync or a computation that runs stops at its next check (between
    /// the head sync's writes and trees, between the computation's reads), waiting commands get
    /// `NoLibrary`, and the thread is joined, so nothing it does outlives the session. A second
    /// call does nothing.
    pub(super) fn stop(&self) -> Result<(), AppError> {
        self.update(|state| state.stopped = true);
        self.shared.cancel.store(true, Ordering::Release);
        self.shared.done.notify_all();
        let thread = lock(&self.thread).take();
        thread.map_or(Ok(()), |thread| {
            thread
                .join()
                .map_err(|_| AppError::Internal("the workspace tracker panicked".to_owned()))
        })
    }

    /// The workspace at least as new as every notification before this call, once the first head
    /// sync has ended (see the module's docs). Waits for the tracker's thread, which computes it;
    /// while a rebuild runs, the last one.
    pub(crate) fn current(&self) -> Result<Current, AppError> {
        let shared = &self.shared;
        let mut state = lock(&shared.state);
        let wanted = state.generation;
        let (syncs, computes) = (state.syncs, state.computes);
        state.waiting += 1;
        shared.wake.notify_one();
        let answer = loop {
            if state.broken {
                break Answer::Failed(AppError::Internal(
                    "the workspace tracker stopped".to_owned(),
                ));
            }
            if state.stopped {
                break Answer::Failed(closing());
            }
            match &state.head {
                None => {}
                Some(Err(error)) => {
                    if state.syncs > syncs {
                        break Answer::Failed(error.clone());
                    }
                    // Tried again for this call, once.
                    if state.sync.is_none()
                        && let Some((_, force)) = state.failed.take()
                    {
                        state.ask_sync(force);
                        shared.wake.notify_one();
                    }
                }
                Some(Ok(head)) => {
                    if state.rebuilding {
                        break match &state.computed {
                            Some(Computed::Ready(current)) => Answer::Ready(current.clone()),
                            _ => Answer::Empty(head.clone(), wanted),
                        };
                    }
                    match &state.computed {
                        Some(Computed::Ready(current)) if current.generation >= wanted => {
                            break Answer::Ready(current.clone());
                        }
                        Some(Computed::Failed { generation, error }) if *generation >= wanted => {
                            if state.computes > computes {
                                break Answer::Failed(error.clone());
                            }
                            state.retry = true;
                            shared.wake.notify_one();
                        }
                        _ => {}
                    }
                }
            }
            state = shared
                .done
                .wait(state)
                .unwrap_or_else(PoisonError::into_inner);
        };
        state.waiting -= 1;
        drop(state);
        match answer {
            Answer::Ready(current) => Ok(current),
            Answer::Failed(error) => Err(error),
            Answer::Empty(head, generation) => Ok(Current {
                generation,
                head,
                snapshot: Arc::new(Snapshot::empty(&shared.catalog).map_err(catalog_error)?),
            }),
        }
    }

    /// Changes the state and wakes the tracker's thread.
    fn update(&self, change: impl FnOnce(&mut State)) {
        let mut state = lock(&self.shared.state);
        change(&mut state);
        self.shared.wake.notify_one();
    }
}

impl Shared {
    /// The tracker's thread: head syncs, computations and events, until stopped.
    fn run(&self) {
        let mut state = lock(&self.state);
        loop {
            if state.stopped {
                return;
            }
            if !state.started {
                state = self.wait(state, None);
                continue;
            }
            if let Some(force) = state.sync.take() {
                drop(state);
                let synced = self.head_sync(force);
                state = lock(&self.state);
                self.synced(&mut state, force, synced);
                continue;
            }
            let mut timeout = None;
            if let Some(Ok(head)) = &state.head
                && !state.rebuilding
                && state.is_stale()
            {
                let wait = if state.waiting > 0 {
                    Duration::ZERO
                } else {
                    remaining(state.last_compute)
                };
                if wait.is_zero() {
                    let head = head.clone();
                    let started = (state.generation, state.rebuilds);
                    state.retry = false;
                    drop(state);
                    let loaded = self.load(&head);
                    state = lock(&self.state);
                    self.computed(&mut state, started, head, loaded);
                    continue;
                }
                timeout = Some(wait);
            }
            if let Some(due) = &state.due
                && !state.rebuilding
                && state.unsent.is_none_or(|first| first > due.revision())
            {
                let wait = remaining(state.last_event);
                if wait.is_zero() {
                    self.send(&mut state);
                    continue;
                }
                timeout = Some(timeout.map_or(wait, |other: Duration| other.min(wait)));
            }
            state = self.wait(state, timeout);
        }
    }

    fn wait<'a>(
        &self,
        state: MutexGuard<'a, State>,
        timeout: Option<Duration>,
    ) -> MutexGuard<'a, State> {
        match timeout {
            Some(timeout) => {
                self.wake
                    .wait_timeout(state, timeout)
                    .unwrap_or_else(PoisonError::into_inner)
                    .0
            }
            None => self
                .wake
                .wait(state)
                .unwrap_or_else(PoisonError::into_inner),
        }
    }

    fn head_sync(&self, force: bool) -> Result<HeadState, SyncError> {
        let _history = lock(&self.history);
        sync(
            &self.catalog,
            &self.layout,
            &self.library,
            force,
            &self.cancel,
        )
    }

    /// Records what a head sync found.
    fn synced(&self, state: &mut State, force: bool, synced: Result<HeadState, SyncError>) {
        state.syncs += 1;
        state.generation += 1;
        match synced {
            Ok(head) => {
                self.report_problem(state, &head);
                state.head = Some(Ok(Arc::new(head)));
                state.failed = None;
            }
            // Only when the session closes.
            Err(SyncError::Cancelled) => {}
            Err(error) => {
                let error = sync_error(error);
                self.report(&format!("could not read the history's HEAD: {error}"));
                state.head = Some(Err(error));
                state.failed = Some((Instant::now(), force));
            }
        }
        self.done.notify_all();
    }

    /// The workspace against `head`: nothing before the catalog's first scan.
    fn load(&self, head: &HeadState) -> Result<Snapshot, LoadError> {
        if !self.catalog.read(|tx| catalog::was_scanned(tx))? {
            return Ok(Snapshot::empty(&self.catalog)?);
        }
        Workspace::load(&self.catalog, &self.layout, head, &self.cancel)
    }

    /// Records the outcome of a computation that started at the generation and the count of
    /// rebuilds in `started`, and an event when the workspace differs from the last one sent.
    fn computed(
        &self,
        state: &mut State,
        started: (u64, u64),
        head: Arc<HeadState>,
        loaded: Result<Snapshot, LoadError>,
    ) {
        let (generation, rebuilds) = started;
        state.last_compute = Some(Instant::now());
        match loaded {
            // Another `HEAD` is in the catalog: sync, then compute again.
            Err(LoadError::HeadChanged) => state.ask_sync(false),
            // Only when the session closes.
            Err(LoadError::Cancelled) => {}
            Err(error) => {
                let error = load_error(error);
                self.report(&format!("could not compute the workspace: {error}"));
                state.computes += 1;
                state.computed = Some(Computed::Failed { generation, error });
            }
            // A rebuild started while it read, so it may have read a catalog half reset, even if
            // the rebuild has ended since (cancelled, or failed right after the reset): dropped,
            // and the rebuild's end computes again.
            Ok(_) if state.rebuilding || state.rebuilds != rebuilds => {}
            Ok(snapshot) => {
                let current = Current {
                    generation,
                    head,
                    snapshot: Arc::new(snapshot),
                };
                let unchanged = state
                    .sent
                    .as_ref()
                    .is_some_and(|sent| sent.matches(&current));
                state.due = (!unchanged).then(|| current.clone());
                state.computes += 1;
                state.computed = Some(Computed::Ready(current));
            }
        }
        self.done.notify_all();
    }

    /// Sends the due event.
    fn send(&self, state: &mut State) {
        let Some(current) = state.due.take() else {
            return;
        };
        state.last_event = Some(Instant::now());
        state.sent = Some(Sent::of(&current));
        if self.active.load(Ordering::Acquire) {
            (self.emit)(Event::Workspace(current.event()));
        }
    }

    fn report(&self, message: &str) {
        if self.active.load(Ordering::Acquire) {
            (self.emit)(Event::Error(message.to_owned()));
        }
    }

    /// Reports why the history `head` found is not ready (versioning.md §4.2), once for each
    /// `HEAD` and problem: the state alone says neither which file is damaged nor whether a
    /// history is too large rather than damaged.
    fn report_problem(&self, state: &State, head: &HeadState) {
        let Some(problem) = head.problem() else {
            return;
        };
        let text = problem.to_string();
        let known = match &state.head {
            Some(Ok(last)) => {
                last.head() == head.head()
                    && last.problem().map(ToString::to_string).as_ref() == Some(&text)
            }
            _ => false,
        };
        if known {
            return;
        }
        let status = match head.status() {
            HistoryStatus::ReadOnly => "read-only",
            HistoryStatus::TooLarge => "too large to show",
            _ => "damaged",
        };
        self.report(&format!("the history is {status}: {text}"));
    }
}

/// What is left of [`EVENT_INTERVAL`] since `since`.
fn remaining(since: Option<Instant>) -> Duration {
    since.map_or(Duration::ZERO, |since| {
        EVENT_INTERVAL.saturating_sub(since.elapsed())
    })
}

/// Marks the tracker broken if its thread panics, so commands fail instead of waiting for it.
struct Exit<'a>(&'a Shared);

impl Drop for Exit<'_> {
    fn drop(&mut self) {
        let mut state = lock(&self.0.state);
        if std::thread::panicking() {
            state.broken = true;
        }
        self.0.done.notify_all();
    }
}

#[cfg(test)]
pub(crate) mod testing;
#[cfg(test)]
mod tests;
