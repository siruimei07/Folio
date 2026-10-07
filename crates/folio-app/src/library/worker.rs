use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, PoisonError};
use std::thread::JoinHandle;
use std::time::{Duration, Instant, SystemTime};

use folio_core::catalog::{self, Catalog};
use folio_core::library::operations::import as import_core;
use folio_core::library::operations::{OperationError, Outcome};
use folio_core::library::{
    self as core, CommittedScan, EntryChangeKind, ExtractReport, Library, ScanCoverage,
};
use folio_core::meta::MetaTree;
use folio_core::watch::{Rescan, WatchOptions};
use folio_core::win::{WatchEvent, Watcher, WindowsFileSystem};

use super::errors::{self, Failure};
use super::workspace::Tracker;
use super::{Event, Sink, lock, problems::Problems};
use crate::error::AppError;
use crate::ipc::events::{CatalogChanged, EntryChange};
use crate::ipc::jobs::{JobKind, JobResult};
use crate::ipc::library::{LibraryInfo, LibraryOpened, LibraryStatus, Unavailable};
use crate::ipc::problems::ProblemItem;
use crate::ipc::types::{EntryRef, LIMITS, Page, PageRequest};
use crate::jobs::{Registry, Ticket, count};

const EVENT_INTERVAL: Duration = Duration::from_millis(100);
const HASH_DELAY: Duration = Duration::from_secs(3);

pub(super) struct Session {
    library: Library,
    catalog: Arc<Catalog>,
    pub jobs: Registry,
    startup: String,
    snapshot: Mutex<Snapshot>,
    // ponytail: one session-wide disk/metadata lock; split only if measured latency requires it.
    operation: Mutex<()>,
    recovering: AtomicBool,
    pending: Mutex<Pending>,
    wake: Condvar,
    active: Arc<AtomicBool>,
    stopped: AtomicBool,
    watcher: Mutex<Option<Watcher>>,
    worker: Mutex<Option<JoinHandle<()>>>,
    emit: Sink,
    /// The workspace (ipc-m2.md §6): told of every commit, sent `CatalogChanged` and rebuild.
    pub(super) workspace: Tracker,
}

struct Snapshot {
    info: LibraryInfo,
    failure: Option<Unavailable>,
    revision: u32,
    problems: Problems,
    event: Option<CatalogChanged>,
    last_event: Option<Instant>,
}

impl Snapshot {
    /// Takes the catalog's revision after a commit (`Catalog::stamp`, read after the commit, so
    /// pages at that revision hold the change) and merges the commit's changes into the pending
    /// event. Converts entries only while the event has room: a first scan reports every file,
    /// an event at most 200. A flag once on (`complete` once off) stays so until the event goes
    /// out.
    fn changed(
        &mut self,
        revision: u32,
        entries: impl IntoIterator<Item = EntryChange>,
        complete: bool,
        tags: bool,
        groups: bool,
        bodies: bool,
    ) {
        self.revision = revision;
        let event = self.event.get_or_insert_with(|| CatalogChanged {
            revision,
            entries: Vec::new(),
            complete: true,
            tags: false,
            groups: false,
            bodies: false,
        });
        event.revision = revision;
        event.complete &= complete;
        event.tags |= tags;
        event.groups |= groups;
        event.bodies |= bodies;
        for entry in entries {
            if event.entries.len() < LIMITS.event_entries as usize {
                event.entries.push(entry);
            } else {
                event.complete = false;
                break;
            }
        }
    }
}

#[derive(Default)]
struct Pending {
    startup: Option<Ticket>,
    rescan: Option<Rescan>,
    rebuild: Option<Ticket>,
    imports: std::collections::VecDeque<(Ticket, import_core::Request)>,
    hash: Option<(Instant, Ticket)>,
    /// The running hash job has hashed and is extracting text, without the operation lock, so
    /// changes can commit meanwhile; each sets `rehash`, and the job queues another when it ends.
    extracting: bool,
    rehash: bool,
    failure: Option<Failure>,
}

enum Work {
    Scan(Rescan, Option<Ticket>),
    Hash(Ticket),
    Rebuild(Ticket),
    Import(Ticket, import_core::Request),
    Failed(Failure),
}

impl Session {
    /// Each step says why it failed, so the unavailable reason never comes from a guess.
    pub fn prepare(root: &Path, data_dir: &Path, emit: Sink) -> Result<Arc<Self>, Failure> {
        let root = super::directory(root).map_err(Failure::root)?;
        let config = super::read_config(&root)?;
        let fs = Arc::new(
            WindowsFileSystem::open(&root)
                .map_err(errors::io)
                .map_err(Failure::root)?,
        );
        let options = WatchOptions::new(fs.has_file_ids());
        let library = Library::new(&root, fs);
        let read_only = MetaTree::read(library.layout())
            .map_err(Failure::metadata)?
            .is_read_only();
        let path = data_dir
            .join("libraries")
            .join(config.id.as_str())
            .join("catalog.sqlite");
        let opened = Catalog::open(&path, &config.id)
            .map_err(errors::catalog)
            .map_err(Failure::own)?;
        let active = Arc::new(AtomicBool::new(false));
        let job_sink = emit.clone();
        let job_active = active.clone();
        let jobs = Registry::new(Arc::new(move |job| {
            if job_active.load(Ordering::Acquire) {
                job_sink(Event::Job(job));
            }
        }));
        let startup = jobs.queue(JobKind::Scan, true).map_err(Failure::own)?;
        let catalog = Arc::new(opened.catalog);
        let workspace = Tracker::new(
            catalog.clone(),
            library.layout().clone(),
            config.id.clone(),
            emit.clone(),
            active.clone(),
        );
        let session = Arc::new(Self {
            library,
            catalog,
            jobs,
            startup: startup.id.clone(),
            snapshot: Mutex::new(Snapshot {
                info: LibraryInfo {
                    id: config.id.as_str().to_owned(),
                    name: config.name.as_str().to_owned(),
                    root: super::shown(&root),
                    read_only,
                    recovered: opened.recovered.is_some(),
                },
                failure: None,
                revision: 0,
                problems: Problems::default(),
                event: None,
                last_event: None,
            }),
            operation: Mutex::new(()),
            recovering: AtomicBool::new(false),
            pending: Mutex::new(Pending {
                startup: Some(startup),
                ..Pending::default()
            }),
            wake: Condvar::new(),
            active,
            stopped: AtomicBool::new(false),
            watcher: Mutex::new(None),
            worker: Mutex::new(None),
            emit,
            workspace,
        });
        let weak = Arc::downgrade(&session);
        let watcher = Watcher::start(&root, options, move |event| {
            if let Some(session) = weak.upgrade() {
                session.watch(event);
            }
        })
        .map_err(errors::io)
        .map_err(Failure::root)?;
        *lock(&session.watcher) = Some(watcher);
        let worker_session = session.clone();
        let worker = match std::thread::Builder::new()
            .name("folio-library".to_owned())
            .spawn(move || {
                if let Err(failure) = worker_session.run() {
                    worker_session.fail(failure);
                }
            }) {
            Ok(worker) => worker,
            Err(error) => {
                session.shutdown().map_err(Failure::own)?;
                return Err(Failure::own(errors::io(error)));
            }
        };
        *lock(&session.worker) = Some(worker);
        if let Err(error) = session.workspace.start() {
            session.shutdown().map_err(Failure::own)?;
            return Err(Failure::own(error));
        }
        Ok(session)
    }

    /// The canonical library root.
    pub fn root(&self) -> &Path {
        self.library.root()
    }

    pub(super) fn catalog(&self) -> &Catalog {
        &self.catalog
    }

    pub(super) fn with_entry<T>(
        &self,
        id: i64,
        path: &folio_core::paths::RelPath,
        action: impl FnOnce(&Path, &catalog::Entry) -> Result<T, AppError>,
    ) -> Result<T, AppError> {
        // Use the existing writer transaction without exposing its connection or a stale
        // session handle to callers. The wrapper preserves action errors and rollback.
        struct ActionError(AppError);
        impl From<catalog::CatalogError> for ActionError {
            fn from(error: catalog::CatalogError) -> Self {
                Self(errors::catalog(error))
            }
        }
        self.catalog
            .write_with(|tx| {
                let entry = catalog::entry_by_id(tx, catalog::EntryId(id))?
                    .filter(|entry| entry.record.path == *path)
                    .ok_or_else(|| {
                        ActionError(AppError::NotFound(
                            "the entry moved or disappeared".to_owned(),
                        ))
                    })?;
                action(self.root(), &entry).map_err(ActionError)
            })
            .map_err(|error: ActionError| error.0)
    }

    pub(super) fn read_operation<T>(
        &self,
        call: impl FnOnce(&Library, &Catalog) -> Result<T, OperationError>,
    ) -> Result<T, AppError> {
        call(&self.library, &self.catalog).map_err(super::operations::operation_error)
    }

    pub(super) fn mutate<T>(
        &self,
        call: impl FnOnce(&Library, &Catalog) -> Result<Outcome<T>, OperationError>,
    ) -> Result<T, AppError> {
        self.mutate_map(call, |_, value| Ok(value))
    }

    /// Publish the commit before mapping the response: a failed row read cannot hide a write
    /// that already committed. Mapping still holds the operation mutex for one coherent row.
    pub(super) fn mutate_map<T, U>(
        &self,
        call: impl FnOnce(&Library, &Catalog) -> Result<Outcome<T>, OperationError>,
        map: impl FnOnce(&Catalog, T) -> Result<U, OperationError>,
    ) -> Result<U, AppError> {
        let _operation = lock(&self.operation);
        if self.stopped.load(Ordering::Acquire) {
            return Err(AppError::NoLibrary("the library is unavailable".to_owned()));
        }
        if let Some(rescan) = self.writes_blocked() {
            if rescan {
                self.watch(WatchEvent::Rescan(Rescan::Full));
            }
            return Err(AppError::Busy(
                "catalog is reconciling or rebuilding".to_owned(),
            ));
        }
        if let Err(failure) = self.recover() {
            let error = failure.error.clone();
            self.fail(failure);
            return Err(error);
        }
        match call(&self.library, &self.catalog) {
            Ok(outcome) => {
                let hash = outcome.committed.entries.iter().any(|entry| {
                    matches!(
                        entry.kind,
                        EntryChangeKind::Added
                            | EntryChangeKind::Modified
                            | EntryChangeKind::Moved { .. }
                    )
                });
                self.committed(outcome.committed);
                if hash && let Err(failure) = self.queue_hash(Duration::ZERO) {
                    self.fail(failure);
                }
                // The worker also owns delayed CatalogChanged delivery and hash scheduling.
                let _pending = lock(&self.pending);
                self.wake.notify_one();
                drop(_pending);
                map(&self.catalog, outcome.value).map_err(|error| {
                    self.reconcile_error(&error);
                    super::operations::operation_error(error)
                })
            }
            Err(error) => {
                self.reconcile_error(&error);
                Err(super::operations::operation_error(error))
            }
        }
    }

    /// `Some` while reconciliation or a rebuild blocks writes; `true` asks for the full scan
    /// again. The reconciling scan is a job the user may cancel, so writes are not blocked
    /// until some other full scan happens to complete.
    fn writes_blocked(&self) -> Option<bool> {
        let recovering = self.recovering.load(Ordering::Acquire);
        let rebuilding = self.jobs.busy(JobKind::Rebuild);
        (recovering || rebuilding)
            .then(|| recovering && !rebuilding && !self.jobs.busy(JobKind::Scan))
    }

    pub(super) fn reconcile_error(&self, error: &OperationError) {
        if matches!(
            error,
            OperationError::DiskChanged { .. } | OperationError::RecoveryRequired { .. }
        ) {
            self.require_reconciliation();
            self.send(Event::Error(error.to_string()));
        }
    }

    fn require_reconciliation(&self) {
        self.recovering.store(true, Ordering::Release);
        self.watch(WatchEvent::Rescan(Rescan::Full));
    }

    fn recover(&self) -> Result<(), Failure> {
        let report = self
            .library
            .recover_pending(&self.catalog)
            .map_err(|error| match &error {
                core::LibraryError::Meta(folio_core::meta::MetaError::Invalid { path, .. })
                    if *path == self.library.layout().scan_journal_file()
                        || *path == self.library.layout().import_journal_file() =>
                {
                    Failure::own(AppError::Internal(error.to_string()))
                }
                _ => errors::library(error),
            })?;
        self.committed(report);
        Ok(())
    }

    /// Lets go of the unfinished move that stopped this session (ipc-m1 §6); the caller has
    /// drained it and opens the library again, whose start-up scan reconciles the catalog.
    pub(super) fn discard_move(&self) -> Result<(), AppError> {
        let discarded = self
            .library
            .discard_move(&self.catalog)
            .map_err(|error| errors::library(error).error)?;
        if let Some(discarded) = discarded {
            // The log keeps what the user let go of.
            (self.emit)(Event::Error(format!(
                "discarded an unfinished move from {} to {}; metadata {}",
                discarded.from.as_str(),
                discarded.to.as_str(),
                if discarded.restored {
                    "put back"
                } else {
                    "left as it was"
                }
            )));
        }
        Ok(())
    }

    pub fn opened(&self) -> LibraryOpened {
        LibraryOpened {
            library: lock(&self.snapshot).info.clone(),
            scan: self.startup.clone(),
        }
    }

    pub fn activate(&self) {
        let _pending = lock(&self.pending);
        if self.stopped.load(Ordering::Acquire) {
            return;
        }
        for job in self.jobs.list() {
            (self.emit)(Event::Job(job));
        }
        self.active.store(true, Ordering::Release);
        self.wake.notify_one();
        self.workspace.activate();
    }

    pub fn status(&self) -> LibraryStatus {
        let snapshot = lock(&self.snapshot);
        match snapshot.failure {
            Some(reason) => super::unavailable(self.library.root(), reason),
            None => LibraryStatus::Open {
                library: snapshot.info.clone(),
            },
        }
    }

    fn send(&self, event: Event) {
        if self.active.load(Ordering::Acquire) {
            (self.emit)(event);
        }
    }

    fn watch(&self, event: WatchEvent) {
        if self.stopped.load(Ordering::Acquire) {
            return;
        }
        // The callback only coalesces bounded work; disk access stays on the worker.
        let mut pending = lock(&self.pending);
        match event {
            WatchEvent::Rescan(rescan) => {
                pending.rescan = Some(match pending.rescan.take() {
                    Some(queued) => queued.merge(rescan),
                    None => rescan,
                });
            }
            // A watch ends when the folder cannot be watched any more, say because it went away.
            WatchEvent::Failed(error) => pending.failure = Some(Failure::root(errors::io(error))),
        }
        self.wake.notify_one();
    }

    pub fn rebuild(&self) -> Result<String, AppError> {
        let mut pending = lock(&self.pending);
        if self.stopped.load(Ordering::Acquire) {
            return Err(AppError::NoLibrary("library is closing".to_owned()));
        }
        if self.jobs.busy(JobKind::Rebuild) {
            return Err(AppError::Busy("catalog is rebuilding".to_owned()));
        }
        self.jobs.cancel_all();
        let ticket = self.jobs.queue(JobKind::Rebuild, true)?;
        let id = ticket.id.clone();
        pending.rebuild = Some(ticket);
        self.wake.notify_one();
        Ok(id)
    }

    /// The caller holds the library transition through read-only preflight and token use.
    pub(super) fn queue_import(&self, request: import_core::Request) -> Result<String, AppError> {
        let mut pending = lock(&self.pending);
        if self.stopped.load(Ordering::Acquire) {
            return Err(AppError::NoLibrary("library is closing".into()));
        }
        if let Some(rescan) = self.writes_blocked() {
            // `watch` takes `pending`, which this call already holds.
            if rescan {
                pending.rescan = Some(Rescan::Full);
                self.wake.notify_one();
            }
            return Err(AppError::Busy(
                "catalog is reconciling or rebuilding".into(),
            ));
        }
        let ticket = self.jobs.queue(JobKind::Import, true)?;
        let id = ticket.id.clone();
        pending.imports.push_back((ticket, request));
        self.wake.notify_one();
        Ok(id)
    }

    pub fn problems(&self, page: PageRequest) -> Page<ProblemItem> {
        let snapshot = lock(&self.snapshot);
        let items = snapshot.problems.items();
        Page {
            total: count(items.len() as u64),
            items: items
                .into_iter()
                .skip(page.offset as usize)
                .take(page.limit as usize)
                .collect(),
            offset: page.offset,
            revision: snapshot.revision,
        }
    }

    pub fn shutdown(&self) -> Result<(), AppError> {
        {
            // Change the wait predicate under the same mutex used by Condvar::wait.
            let _pending = lock(&self.pending);
            self.active.store(false, Ordering::Release);
            self.stopped.store(true, Ordering::Release);
            self.wake.notify_all();
        }
        self.jobs.cancel_all();
        let watcher = lock(&self.watcher).take();
        if let Some(watcher) = watcher {
            watcher.stop();
        }
        let worker = lock(&self.worker).take();
        let joined = worker.map_or(Ok(()), |worker| {
            worker
                .join()
                .map_err(|_| AppError::Internal("library worker panicked".to_owned()))
        });
        // A head sync or a computation that runs stops at its next check, without another write.
        let tracked = self.workspace.stop();
        // Commands wait for the operation mutex outside the library transition. A write that
        // holds it finishes before the drain does; a later one sees `stopped` under it.
        drop(lock(&self.operation));
        joined.and(tracked)
    }

    /// Library and catalog failures keep the reason they got where they happened; a failure of
    /// the job registry is Folio's own state failing.
    fn run(&self) -> Result<(), Failure> {
        loop {
            self.flush();
            let Some(work) = self.next()? else {
                // Cancels a job queued after shutdown's cancel_all, such as a deferred hash.
                self.jobs.cancel_all();
                return Ok(());
            };
            // Hold through walking and committing: otherwise a pre-operation snapshot could
            // commit afterwards and undo the operation's catalog result. The hash job lets go
            // of it to extract text, whose writes are guarded instead (`hash`).
            let operation = lock(&self.operation);
            if !matches!(&work, Work::Failed(_)) {
                self.recover()?;
            }
            match work {
                Work::Failed(failure) => return Err(failure),
                Work::Scan(rescan, ticket) => {
                    // A job cancelled while queued has finished: skip its work.
                    if let Some(ticket) = &ticket
                        && !self.jobs.start(ticket).map_err(Failure::own)?
                    {
                        continue;
                    }
                    let cancel = ticket
                        .as_ref()
                        .map_or(&self.stopped, |ticket| ticket.cancel.as_ref());
                    let result = self.scan(&rescan, cancel, ticket.as_ref());
                    if let Some(ticket) = &ticket {
                        self.finish(ticket, result.as_ref().cloned())?;
                    }
                    if result?.is_some() && !matches!(rescan, Rescan::Metadata) {
                        self.queue_hash(Duration::ZERO)?;
                    }
                }
                Work::Hash(ticket) => {
                    if self.jobs.start(&ticket).map_err(Failure::own)? {
                        self.hash(&ticket, operation)?;
                    }
                }
                Work::Rebuild(ticket) => {
                    if !self.jobs.start(&ticket).map_err(Failure::own)? {
                        continue;
                    }
                    // The workspace waits while the catalog is reset and filled again, then
                    // derives `HEAD`'s rows anew (versioning.md §13.2).
                    self.workspace.rebuilding();
                    let result = self.rebuild_catalog(&ticket);
                    self.workspace.rebuilt();
                    self.finish(&ticket, result.as_ref().cloned())?;
                    if result?.is_some() {
                        self.queue_hash(Duration::ZERO)?;
                    }
                }
                Work::Import(ticket, request) => {
                    if !self.jobs.start(&ticket).map_err(Failure::own)? {
                        continue;
                    }
                    self.import_files(&ticket, &request)?;
                }
            }
        }
    }

    /// Records a job's outcome; a failed job reports its error without the unavailable reason.
    fn finish(
        &self,
        ticket: &Ticket,
        result: Result<Option<JobResult>, &Failure>,
    ) -> Result<(), Failure> {
        let result = result.map_err(|failure| failure.error.clone());
        self.jobs.finish(ticket, result).map_err(Failure::own)
    }

    fn next(&self) -> Result<Option<Work>, Failure> {
        let mut pending = lock(&self.pending);
        loop {
            if self.stopped.load(Ordering::Acquire) {
                return Ok(None);
            }
            if self.active.load(Ordering::Acquire) {
                if let Some(failure) = pending.failure.take() {
                    return Ok(Some(Work::Failed(failure)));
                }
                if let Some(ticket) = pending.rebuild.take() {
                    return Ok(Some(Work::Rebuild(ticket)));
                }
                if self.recovering.load(Ordering::Acquire) {
                    if !pending.imports.is_empty() && pending.rescan.is_none() {
                        // A queued write needs reconciliation even if its previous scan was cancelled.
                        pending.rescan = Some(Rescan::Full);
                    }
                } else if let Some((ticket, request)) = pending.imports.pop_front() {
                    return Ok(Some(Work::Import(ticket, request)));
                }
                if let Some(rescan) = pending.rescan.take() {
                    // A full scan is a job. Queue it under `pending`, like a rebuild: shutdown
                    // sets `stopped` under this lock before cancel_all, so it cannot miss it.
                    let ticket = match rescan {
                        Rescan::Full => Some(match pending.startup.take() {
                            Some(startup) => startup,
                            None => self.jobs.queue(JobKind::Scan, true).map_err(Failure::own)?,
                        }),
                        Rescan::Scopes(_) | Rescan::Metadata => None,
                    };
                    return Ok(Some(Work::Scan(rescan, ticket)));
                }
                if pending
                    .hash
                    .as_ref()
                    .is_some_and(|(due, _)| *due <= Instant::now())
                    && let Some((_, ticket)) = pending.hash.take()
                {
                    return Ok(Some(Work::Hash(ticket)));
                }
            }
            let event_due = lock(&self.snapshot).event.is_some();
            let hash_wait = pending
                .hash
                .as_ref()
                .map(|(due, _)| due.saturating_duration_since(Instant::now()));
            let wait = if !self.active.load(Ordering::Acquire) {
                None
            } else if event_due {
                Some(hash_wait.map_or(EVENT_INTERVAL, |wait| wait.min(EVENT_INTERVAL)))
            } else {
                hash_wait
            };
            pending = if let Some(wait) = wait {
                let (guard, _) = self
                    .wake
                    .wait_timeout(pending, wait)
                    .unwrap_or_else(PoisonError::into_inner);
                drop(guard);
                self.flush();
                lock(&self.pending)
            } else {
                self.wake
                    .wait(pending)
                    .unwrap_or_else(PoisonError::into_inner)
            };
        }
    }

    fn scan(
        &self,
        rescan: &Rescan,
        cancel: &AtomicBool,
        ticket: Option<&Ticket>,
    ) -> Result<Option<JobResult>, Failure> {
        let mut changes = 0_u64;
        let completed = self
            .library
            .rescan_with_control(
                &self.catalog,
                rescan,
                now_ns(),
                cancel,
                &mut |done| {
                    if let Some(ticket) = ticket
                        && let Err(error) = self.jobs.progress(ticket, done, None)
                    {
                        self.send(Event::Error(error.to_string()));
                    }
                },
                &mut |report| {
                    changes = changes.saturating_add(report.entries.len() as u64);
                    self.committed(report);
                },
            )
            .map_err(errors::library)?;
        let problems = lock(&self.snapshot).problems.total();
        if completed && matches!(rescan, Rescan::Full) {
            self.recovering.store(false, Ordering::Release);
        }
        Ok(completed.then_some(JobResult::Scan {
            changes: count(changes),
            problems: count(problems as u64),
        }))
    }

    fn import_files(&self, ticket: &Ticket, request: &import_core::Request) -> Result<(), Failure> {
        // A foreground write can require recovery after `next` selected this import but before
        // the worker acquired `operation`. Apply the same guard as every other write.
        if let Some(rescan) = self.writes_blocked() {
            if rescan {
                self.watch(WatchEvent::Rescan(Rescan::Full));
            }
            self.jobs
                .finish(
                    ticket,
                    Err(AppError::Busy(
                        "catalog is reconciling or rebuilding".into(),
                    )),
                )
                .map_err(Failure::own)?;
            return Ok(());
        }
        let report = self.library.import_files(
            &self.catalog,
            request,
            &folio_core::win::WindowsRecycleBin,
            now_ns(),
            &ticket.cancel,
            &mut |progress| {
                let permille = (progress.total_bytes > 0).then(|| {
                    ((u128::from(progress.bytes) * 1_000 / u128::from(progress.total_bytes))
                        .min(1_000)) as u32
                });
                if let Err(error) = self.jobs.report_progress(
                    ticket,
                    crate::ipc::jobs::Progress {
                        done: progress.done,
                        total: Some(progress.total),
                        permille,
                        bytes: None,
                        current: Some(progress.current),
                    },
                ) {
                    self.send(Event::Error(error.to_string()));
                }
            },
            &mut |committed| self.committed(committed),
        );
        match report {
            Ok(report) => {
                // The uncapped flag covers every failure; the job result carries the details.
                if report.needs_reconciliation {
                    self.require_reconciliation();
                }
                let cancelled = report.cancelled;
                let result = JobResult::Import(super::import::result(report));
                // A cancelled import still reports what it copied and what failed (ipc-m1 §13).
                if cancelled {
                    self.jobs.finish_cancelled(ticket, result)
                } else {
                    self.jobs.finish(ticket, Ok(Some(result)))
                }
                .map_err(Failure::own)?;
            }
            Err(error) => {
                self.reconcile_error(&error);
                self.jobs
                    .finish(ticket, Err(super::operations::operation_error(error)))
                    .map_err(Failure::own)?;
                return Ok(());
            }
        }
        self.queue_hash(Duration::ZERO)?;
        Ok(())
    }

    /// Hashes the pending files for a started job under the operation lock, then lets go of it
    /// and extracts the text of the text and Word files for search (versioning.md §10.2–§10.3),
    /// so that a long first pass never holds up the user's operations: every write extraction
    /// makes is guarded by the entry's id, hash and class instead. Retries files that were too
    /// fresh, and runs again for changes committed while it extracted, or when it stopped early
    /// to make way for a scan, an import or a rebuild.
    ///
    /// The job's progress counts steps (ipc-m1 §13): each file hashed, then each text or Word
    /// file whose text is read. The text to read is counted before hashing, so the total is known
    /// from the first report; extraction then goes on after the files hashing counted with its
    /// own count, usually smaller, and `done` never falls back.
    fn hash(&self, ticket: &Ticket, operation: MutexGuard<'_, ()>) -> Result<(), Failure> {
        let mut hashing = 0;
        let report = self
            .catalog
            .read(|tx| catalog::count_extract_work(tx, folio_core::extract::VERSION))
            .map_err(core::LibraryError::from)
            .and_then(|text| {
                self.library.hash_pending_with_commits(
                    &self.catalog,
                    now_ns(),
                    &ticket.cancel,
                    &mut |done, total| {
                        hashing = total;
                        self.progress(ticket, done, total.saturating_add(text));
                    },
                    // Hashes are not in the entry rows the UI shows; the revision still counts
                    // them.
                    &mut || self.bump(true, false, false, false),
                )
            });
        let report = match report.map_err(errors::library) {
            Ok(report) => report,
            Err(failure) => {
                self.finish(ticket, Err(&failure))?;
                return Err(failure);
            }
        };
        if lock(&self.snapshot)
            .problems
            .hash(report.problems, report.cancelled)
        {
            self.problems_changed();
        }
        let extracted = if report.cancelled {
            None
        } else {
            // Before the lock goes, so a change committed from now on sets `rehash`.
            lock(&self.pending).extracting = true;
            drop(operation);
            Some(self.extract(ticket, hashing))
        };
        // Whether extraction stopped early to make way for other work.
        let mut stopped = false;
        let mut cancelled = report.cancelled;
        match extracted {
            Some(Err(failure)) => {
                let finished = self.finish(ticket, Err(&failure));
                let mut pending = lock(&self.pending);
                (pending.extracting, pending.rehash) = (false, false);
                drop(pending);
                finished?;
                return Err(failure);
            }
            Some(Ok(extracted)) => {
                stopped = !extracted.complete && !extracted.cancelled;
                cancelled |= extracted.cancelled;
                if lock(&self.snapshot)
                    .problems
                    .extract(extracted.problems, extracted.complete)
                {
                    self.problems_changed();
                }
            }
            None => {}
        }
        cancelled |= ticket.cancel.load(Ordering::Acquire);
        let finished = self.finish(
            ticket,
            Ok((!cancelled).then_some(JobResult::Hash {
                hashed: count(report.hashed),
                deferred: count(report.deferred),
            })),
        );
        // Only now that the job has finished: a change committed before this point set
        // `rehash`, and one committed after it finds no hash job and queues its own.
        let mut pending = lock(&self.pending);
        pending.extracting = false;
        let again = std::mem::take(&mut pending.rehash) || (stopped && !cancelled);
        finished?;
        if again {
            self.queue_hash_in(&mut pending, Duration::ZERO)?;
        } else if !cancelled && report.deferred > 0 {
            self.queue_hash_in(&mut pending, HASH_DELAY)?;
        }
        Ok(())
    }

    /// Extracts the text of the files that have none for their content yet, for a started job
    /// whose progress already counts `offset` files hashed. Stops early, incomplete, when work it
    /// makes way for is waiting (`waiting`).
    fn extract(&self, ticket: &Ticket, offset: u64) -> Result<ExtractReport, Failure> {
        self.library
            .extract_pending_with_commits(
                &self.catalog,
                &ticket.cancel,
                &mut || self.waiting(),
                &mut |done, total| {
                    self.progress(
                        ticket,
                        offset.saturating_add(done),
                        offset.saturating_add(total),
                    )
                },
                // Search bodies are not in the entry rows either, so the event says they changed.
                &mut || self.bump(true, false, false, true),
            )
            .map_err(errors::library)
    }

    /// Whether a scan, an import, a rebuild or a failure is waiting for the worker.
    fn waiting(&self) -> bool {
        let pending = lock(&self.pending);
        pending.rescan.is_some()
            || !pending.imports.is_empty()
            || pending.rebuild.is_some()
            || pending.failure.is_some()
    }

    fn progress(&self, ticket: &Ticket, done: u64, total: u64) {
        if let Err(error) = self.jobs.progress(ticket, done, Some(total)) {
            self.send(Event::Error(error.to_string()));
        }
    }

    fn rebuild_catalog(&self, ticket: &Ticket) -> Result<Option<JobResult>, Failure> {
        if ticket.cancel.load(Ordering::Acquire) {
            return Ok(None);
        }
        self.library
            .reset_catalog(&self.catalog)
            .map_err(errors::library)?;
        // `complete: false` says the bodies went too (ipc-m1 §15.1).
        self.bump(false, true, true, false);
        if self
            .scan(&Rescan::Full, &ticket.cancel, Some(ticket))?
            .is_none()
        {
            return Ok(None);
        }
        let entries = self
            .catalog
            .read(|tx| catalog::count_entries(tx))
            .map_err(errors::catalog)
            .map_err(Failure::own)?;
        Ok(Some(JobResult::Rebuild {
            entries: count(entries),
        }))
    }

    fn committed(&self, report: CommittedScan) {
        // A scope inside `.folio/` scans nothing and reports no state.
        if report.coverage == ScanCoverage::None {
            return;
        }
        let changed = report.changed();
        let (problems_changed, status) = {
            let mut snapshot = lock(&self.snapshot);
            let invalidated = snapshot.problems.invalidate_reads(&report.entries);
            let problems_changed = snapshot
                .problems
                .scan(&report.coverage, report.report.problems)
                || invalidated;
            let status = if snapshot.info.read_only != report.read_only {
                snapshot.info.read_only = report.read_only;
                Some(LibraryStatus::Open {
                    library: snapshot.info.clone(),
                })
            } else {
                None
            };
            if changed {
                let revision = self.catalog.stamp().revision;
                snapshot.changed(
                    revision,
                    report.entries.into_iter().map(entry_change),
                    true,
                    report.tags,
                    report.groups,
                    false,
                );
                self.workspace.catalog_changed(revision);
            } else {
                // A metadata rescan that changed no row may still change `library.json` or
                // `.folio/ignore`, which the workspace reads from the disk.
                self.workspace.changed();
            }
            (problems_changed, status)
        };
        self.flush();
        if problems_changed {
            self.problems_changed();
        }
        if let Some(status) = status {
            self.send(Event::Library(status));
        }
    }

    /// Reports a commit whose entries the UI need not refetch one by one; `bodies`: it changed
    /// search bodies alone (text extraction), which the UI's searches read (ipc-m1 §15.1) and the
    /// workspace does not. Every other commit here changed what the workspace reads (hashes and
    /// readiness, versioning.md §6.2).
    fn bump(&self, complete: bool, tags: bool, groups: bool, bodies: bool) {
        let mut snapshot = lock(&self.snapshot);
        let revision = self.catalog.stamp().revision;
        snapshot.changed(revision, [], complete, tags, groups, bodies);
        if bodies {
            self.workspace.search_changed(revision);
        } else {
            self.workspace.catalog_changed(revision);
        }
        drop(snapshot);
        self.flush();
    }

    fn flush(&self) {
        let mut snapshot = lock(&self.snapshot);
        if snapshot
            .last_event
            .is_some_and(|last| last.elapsed() < EVENT_INTERVAL)
        {
            return;
        }
        let event = snapshot.event.take();
        if event.is_some() {
            snapshot.last_event = Some(Instant::now());
        }
        drop(snapshot);
        if let Some(event) = event {
            let revision = event.revision;
            self.send(Event::Catalog(event));
            // Only now may a `WorkspaceChanged` of this revision follow (ipc-m2.md §14).
            self.workspace.catalog_sent(revision);
        }
    }

    fn problems_changed(&self) {
        let total = lock(&self.snapshot).problems.total();
        self.send(Event::Problems(count(total as u64)));
    }

    fn queue_hash(&self, delay: Duration) -> Result<(), Failure> {
        let mut pending = lock(&self.pending);
        self.queue_hash_in(&mut pending, delay)
    }

    /// `queue_hash` with `pending` held.
    fn queue_hash_in(&self, pending: &mut Pending, delay: Duration) -> Result<(), Failure> {
        // A queued rebuild scans and hashes afterwards; a stopped session does nothing more.
        if self.stopped.load(Ordering::Acquire) || self.jobs.busy(JobKind::Rebuild) {
            return Ok(());
        }
        // A job extracting text has hashed without this change: it queues another as it ends.
        if pending.extracting {
            pending.rehash = true;
            return Ok(());
        }
        // A queued hash job sees this change too, also one the worker already took but has not
        // started when a command runs. A job cancelled while it waited has finished and does
        // not count, so a new one replaces it.
        if self.jobs.busy(JobKind::Hash) {
            return Ok(());
        }
        let ticket = self.jobs.queue(JobKind::Hash, true).map_err(Failure::own)?;
        pending.hash = Some((Instant::now() + delay, ticket));
        Ok(())
    }

    fn fail(&self, failure: Failure) {
        {
            let _pending = lock(&self.pending);
            self.stopped.store(true, Ordering::Release);
            self.wake.notify_all();
        }
        lock(&self.snapshot).failure = Some(failure.reason);
        self.jobs.cancel_all();
        self.send(Event::Error(failure.error.to_string()));
        self.send(Event::Library(super::unavailable(
            self.library.root(),
            failure.reason,
        )));
    }
}

fn entry_change(change: core::EntryChange) -> EntryChange {
    let entry = EntryRef {
        id: change.id.0.to_string(),
        path: change.path.as_str().to_owned(),
    };
    match change.kind {
        EntryChangeKind::Added => EntryChange::Added { entry },
        EntryChangeKind::Modified => EntryChange::Modified { entry },
        EntryChangeKind::Removed => EntryChange::Removed { entry },
        EntryChangeKind::Tagged => EntryChange::Tagged { entry },
        EntryChangeKind::Moved { from } => EntryChange::Moved {
            entry,
            from: from.as_str().to_owned(),
        },
    }
}

pub(super) fn now_ns() -> i64 {
    folio_core::fs::unix_ns(SystemTime::now()).unwrap_or(i64::MAX)
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::AtomicUsize;
    use std::sync::{Barrier, mpsc};
    use std::thread;

    use folio_core::library::state;
    use folio_core::meta::DisplayName;
    use tempfile::TempDir;

    use super::*;

    fn inactive_session() -> (TempDir, Arc<Session>) {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("library");
        let data = dir.path().join("data");
        std::fs::create_dir(&root).unwrap();
        std::fs::create_dir(&data).unwrap();
        state::create(
            &root,
            DisplayName::parse("Library").unwrap(),
            ["Notes", "Slides", "Homework", "Exam", "Reference"]
                .map(|name| DisplayName::parse(name).unwrap()),
        )
        .unwrap();
        let session = Session::prepare(&root, &data, Arc::new(|_| {})).unwrap();
        (dir, session)
    }

    #[test]
    fn operations_wait_for_the_whole_walk_but_reads_remain_available() {
        let (_dir, session) = inactive_session();
        // Represents the worker after walking begins but before it acquires the writer.
        let walk = lock(&session.operation);
        assert_eq!(
            session
                .read_operation(|library, catalog| library.list_tags(catalog))
                .unwrap()
                .len(),
            0
        );
        let (started, start) = mpsc::channel();
        let (finished, finish) = mpsc::channel();
        let changing = session.clone();
        let command = thread::spawn(move || {
            started.send(()).unwrap();
            finished
                .send(changing.mutate(|_, _| {
                    Ok(Outcome {
                        value: 7,
                        committed: CommittedScan::default(),
                    })
                }))
                .unwrap();
        });
        start.recv_timeout(Duration::from_secs(3)).unwrap();
        assert!(matches!(
            finish.recv_timeout(Duration::from_millis(40)),
            Err(mpsc::RecvTimeoutError::Timeout)
        ));
        drop(walk);
        assert_eq!(
            finish
                .recv_timeout(Duration::from_secs(3))
                .unwrap()
                .unwrap(),
            7
        );
        command.join().unwrap();
        session.shutdown().unwrap();
    }

    #[test]
    fn import_queue_is_fifo_and_rejects_rebuild_recovery_and_shutdown() {
        let (dir, session) = inactive_session();
        let source = dir.path().join("queued.txt");
        std::fs::write(&source, b"source").unwrap();
        let request = import_core::Request {
            sources: vec![import_core::Source::select(source).unwrap()],
            target: folio_core::library::operations::EntryRef {
                id: catalog::EntryId(1),
                path: folio_core::paths::RelPath::parse("Fall/Course").unwrap(),
            },
            tags: Default::default(),
            on_conflict: import_core::Conflict::KeepBoth,
            delete_originals: false,
        };
        let ids: Vec<_> = (0..3)
            .map(|_| session.queue_import(request.clone()).unwrap())
            .collect();
        session.jobs.cancel(&ids[1]).unwrap();
        let queued: Vec<_> = lock(&session.pending).imports.drain(..).collect();
        assert_eq!(
            queued
                .iter()
                .map(|(ticket, _)| &ticket.id)
                .collect::<Vec<_>>(),
            ids.iter().collect::<Vec<_>>()
        );
        let mut started = Vec::new();
        for (ticket, _) in queued {
            if session.jobs.start(&ticket).unwrap() {
                started.push(ticket.id.clone());
                session.jobs.finish(&ticket, Ok(None)).unwrap();
            }
        }
        assert_eq!(started, [ids[0].clone(), ids[2].clone()]);
        let rebuild = session.rebuild().unwrap();
        assert!(matches!(
            session.queue_import(request.clone()),
            Err(AppError::Busy(_))
        ));
        session.jobs.cancel(&rebuild).unwrap();
        session.recovering.store(true, Ordering::Release);
        assert!(matches!(
            session.queue_import(request.clone()),
            Err(AppError::Busy(_))
        ));
        assert!(matches!(lock(&session.pending).rescan, Some(Rescan::Full)));
        session.shutdown().unwrap();
        assert!(matches!(
            session.queue_import(request),
            Err(AppError::NoLibrary(_))
        ));
    }

    #[test]
    fn queued_imports_wait_for_reconciliation_even_after_a_scan_is_cancelled() {
        let (dir, session) = inactive_session();
        // Drive the actual scheduler synchronously, without a live watcher or worker racing it.
        session.shutdown().unwrap();
        session.stopped.store(false, Ordering::Release);
        session.active.store(true, Ordering::Release);
        let source = dir.path().join("queued.txt");
        std::fs::write(&source, b"source").unwrap();
        let id = session
            .queue_import(import_core::Request {
                sources: vec![import_core::Source::select(source).unwrap()],
                target: folio_core::library::operations::EntryRef {
                    id: catalog::EntryId(1),
                    path: folio_core::paths::RelPath::parse("Fall/Course").unwrap(),
                },
                tags: Default::default(),
                on_conflict: import_core::Conflict::KeepBoth,
                delete_originals: false,
            })
            .unwrap();
        session.reconcile_error(&OperationError::DiskChanged {
            path: folio_core::paths::RelPath::parse("Fall/Course/old.txt").unwrap(),
            source: Box::new(OperationError::NotFound),
        });
        let Work::Scan(Rescan::Full, Some(cancelled)) = session.next().unwrap().unwrap() else {
            panic!("a queued import ran before reconciliation");
        };
        assert!(!session.jobs.start(&cancelled).unwrap());
        let Work::Scan(rescan @ Rescan::Full, Some(scan)) = session.next().unwrap().unwrap() else {
            panic!("a cancelled scan let a queued import bypass reconciliation");
        };
        assert!(session.jobs.start(&scan).unwrap());
        let result = session.scan(&rescan, &scan.cancel, Some(&scan)).unwrap();
        assert!(result.is_some());
        session.jobs.finish(&scan, Ok(result)).unwrap();
        let Work::Import(import, _) = session.next().unwrap().unwrap() else {
            panic!("the queued import did not resume after reconciliation");
        };
        assert_eq!(import.id, id);
        session.shutdown().unwrap();
    }

    #[test]
    fn an_import_selected_before_recovery_rechecks_the_write_guard_before_copying() {
        let (dir, session) = inactive_session();
        let source = dir.path().join("retained.txt");
        std::fs::write(&source, b"source").unwrap();
        let request = import_core::Request {
            sources: vec![import_core::Source::select(source.clone()).unwrap()],
            target: folio_core::library::operations::EntryRef {
                id: catalog::EntryId(1),
                path: folio_core::paths::RelPath::parse("Fall/Course").unwrap(),
            },
            tags: Default::default(),
            on_conflict: import_core::Conflict::KeepBoth,
            delete_originals: false,
        };
        session.queue_import(request.clone()).unwrap();
        let (ticket, request) = lock(&session.pending).imports.pop_front().unwrap();
        assert!(session.jobs.start(&ticket).unwrap());
        // A foreground operation requires reconciliation while this import waits for the lock.
        session.reconcile_error(&OperationError::DiskChanged {
            path: request.target.path.clone(),
            source: Box::new(OperationError::NotFound),
        });
        let _operation = lock(&session.operation);
        session.import_files(&ticket, &request).unwrap();
        drop(_operation);
        assert!(session.jobs.list().iter().any(|job| job.id == ticket.id
            && matches!(
                &job.status,
                crate::ipc::jobs::JobStatus::Failed {
                    error: AppError::Busy(_),
                    ..
                }
            )));
        assert!(matches!(lock(&session.pending).rescan, Some(Rescan::Full)));
        assert_eq!(std::fs::read(&source).unwrap(), b"source");
        assert!(!session.root().join("Fall/Course/retained.txt").exists());
        session.shutdown().unwrap();
    }

    #[test]
    fn rebuilding_and_recovery_reject_writes_before_running_them() {
        let (_dir, session) = inactive_session();
        let rebuild = session.jobs.queue(JobKind::Rebuild, true).unwrap();
        assert!(matches!(
            session.mutate::<()>(|_, _| panic!("write during rebuild")),
            Err(AppError::Busy(_))
        ));
        session.jobs.cancel(&rebuild.id).unwrap();
        session.reconcile_error(&OperationError::RecoveryRequired {
            source: Box::new(OperationError::InvalidArgument("failed reconciliation")),
            cleanup: None,
        });
        assert!(matches!(lock(&session.pending).rescan, Some(Rescan::Full)));
        assert!(matches!(
            session.mutate::<()>(|_, _| panic!("write before recovery")),
            Err(AppError::Busy(_))
        ));
        session.shutdown().unwrap();
    }

    #[test]
    fn a_write_asks_again_for_a_cancelled_reconciling_scan() {
        let (_dir, session) = inactive_session();
        session.jobs.cancel(&session.startup).unwrap();
        session.reconcile_error(&OperationError::RecoveryRequired {
            source: Box::new(OperationError::InvalidArgument("failed reconciliation")),
            cleanup: None,
        });
        // The worker took the scan, and the user cancelled it before it completed.
        lock(&session.pending).rescan = None;
        assert!(matches!(
            session.mutate::<()>(|_, _| panic!("write before reconciliation")),
            Err(AppError::Busy(_))
        ));
        assert!(matches!(lock(&session.pending).rescan, Some(Rescan::Full)));
        session.shutdown().unwrap();
    }

    #[test]
    fn a_write_waiting_for_the_worker_leaves_reads_available() {
        let (dir, session) = inactive_session();
        let state = super::super::LibraryState::new(Ok(dir.path().join("data")), Arc::new(|_| {}));
        {
            let mut current = lock(&state.0.state);
            current.ready = true;
            current.session = Some(session.clone());
        }
        // Represents the worker walking or hashing.
        let walk = lock(&session.operation);
        let (done, read) = mpsc::channel();
        thread::scope(|scope| {
            let write = scope.spawn(|| {
                state.create_tag(crate::ipc::tags::CreateTag {
                    name: "Queued".to_owned(),
                    color: "blue".to_owned(),
                })
            });
            // Let the write reach the operation mutex before reading.
            thread::sleep(Duration::from_millis(50));
            scope.spawn(|| done.send(state.list_tags().map(|tags| tags.len())).unwrap());
            assert_eq!(
                read.recv_timeout(Duration::from_secs(3)).unwrap().unwrap(),
                0
            );
            assert!(!write.is_finished());
            drop(walk);
            assert_eq!(write.join().unwrap().unwrap().name, "Queued");
        });
        state.shutdown().unwrap();
    }

    #[test]
    fn the_drain_waits_for_a_running_write() {
        let (_dir, session) = inactive_session();
        // Represents a write in progress.
        let write = lock(&session.operation);
        let (done, drained) = mpsc::channel();
        thread::scope(|scope| {
            scope.spawn(|| done.send(session.shutdown()).unwrap());
            assert!(matches!(
                drained.recv_timeout(Duration::from_millis(40)),
                Err(mpsc::RecvTimeoutError::Timeout)
            ));
            drop(write);
            drained
                .recv_timeout(Duration::from_secs(3))
                .unwrap()
                .unwrap();
        });
        assert!(matches!(
            session.mutate::<()>(|_, _| panic!("write after the drain")),
            Err(AppError::NoLibrary(_))
        ));
    }

    #[test]
    fn mutation_hash_scheduling_reuses_a_ticket_already_taken_by_the_worker() {
        let (_dir, session) = inactive_session();
        let hash = session.jobs.queue(JobKind::Hash, true).unwrap();
        assert!(lock(&session.pending).hash.is_none());
        session.queue_hash(Duration::ZERO).unwrap();
        let hashes: Vec<_> = session
            .jobs
            .list()
            .into_iter()
            .filter(|job| job.kind == JobKind::Hash)
            .collect();
        assert_eq!(hashes.len(), 1);
        assert_eq!(hashes[0].id, hash.id);
        session.shutdown().unwrap();
    }

    /// A change committed within 100 ms of the last `CatalogChanged` waits for the next one; a
    /// command makes the tracker compute at once, but the `WorkspaceChanged` waits for that
    /// `CatalogChanged` (ipc-m2.md §14).
    #[test]
    fn a_workspace_event_waits_for_a_catalog_changed_its_interval_holds_back() {
        use crate::ipc::entries::CreateFolder;
        let f = super::super::workspace::testing::Fixture::new();
        f.write("Fall/MAT232/a.md", b"a");
        f.commit(None);
        f.open();
        super::super::tests::until("the first WorkspaceChanged", || {
            (!f.workspace_events().is_empty()).then_some(())
        });
        // Past both intervals, then a CatalogChanged that changes nothing in the workspace.
        thread::sleep(Duration::from_millis(300));
        let session = f.session();
        session.bump(true, false, false, false);
        let bumped = session.catalog().stamp().revision;
        let course = f.reference("Fall/MAT232");
        f.state
            .create_folder(CreateFolder {
                parent: course,
                name: "Week 1".to_owned(),
            })
            .unwrap();
        // A command makes the tracker compute at once, before the CatalogChanged goes out.
        assert_eq!(f.workspace().workspace().totals().items, 1);
        // The folder's WorkspaceChanged and its CatalogChanged, held back by the interval.
        let position = |log: &[(Instant, Event)], wanted: &dyn Fn(&Event) -> bool| {
            log.iter().position(|(_, event)| wanted(event))
        };
        let is_folder =
            |event: &Event| matches!(event, Event::Workspace(event) if event.total == 1);
        let is_after_bump =
            |event: &Event| matches!(event, Event::Catalog(event) if event.revision > bumped);
        let (workspace, catalog) = super::super::tests::until("both events", || {
            let log = f.events.lock().unwrap();
            Some((position(&log, &is_folder)?, position(&log, &is_after_bump)?))
        });
        let log = f.events.lock().unwrap();
        let (Event::Workspace(sent), Event::Catalog(changed)) =
            (&log[workspace].1, &log[catalog].1)
        else {
            unreachable!()
        };
        assert!(changed.revision <= sent.revision, "{changed:?} {sent:?}");
        assert!(
            catalog < workspace,
            "CatalogChanged {} came after WorkspaceChanged {}",
            changed.revision,
            sent.revision
        );
    }

    #[test]
    fn a_failed_response_read_keeps_the_commit_and_requests_reconciliation() {
        let (_dir, session) = inactive_session();
        let result: Result<(), AppError> = session.mutate_map(
            |library, catalog| library.create_tag(catalog, "Committed tag", "blue"),
            |_, _| {
                Err(OperationError::DiskChanged {
                    path: folio_core::paths::RelPath::parse("s/c/file.md").unwrap(),
                    source: Box::new(OperationError::NotFound),
                })
            },
        );
        assert!(matches!(result, Err(AppError::NotFound(_))));
        assert_eq!(lock(&session.snapshot).revision, 1);
        assert!(
            session
                .read_operation(|library, catalog| library.list_tags(catalog))
                .unwrap()
                .iter()
                .any(|tag| tag.definition.name.as_str() == "Committed tag")
        );
        assert!(session.recovering.load(Ordering::Acquire));
        assert!(matches!(lock(&session.pending).rescan, Some(Rescan::Full)));
        session.shutdown().unwrap();
    }

    #[test]
    fn a_conflicting_recovery_journal_stops_writes_without_losing_the_record() {
        let (_dir, session) = inactive_session();
        let path = session.library.layout().scan_journal_file();
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        let bytes = br#"{"format_version":3,"id":"conflict","before":[["../other.json",null]],"after":[["../other.json",null]]}"#;
        std::fs::write(&path, bytes).unwrap();
        assert!(matches!(
            session.mutate::<()>(|_, _| panic!("write despite conflicting journal")),
            Err(AppError::Internal(_))
        ));
        assert!(matches!(
            session.status(),
            LibraryStatus::Unavailable {
                reason: Unavailable::CatalogFailed,
                ..
            }
        ));
        assert_eq!(std::fs::read(path).unwrap(), bytes);
        session.shutdown().unwrap();
    }

    #[test]
    fn an_unreconcilable_move_stops_writes_with_its_own_reason_and_keeps_the_record() {
        let (_dir, session) = inactive_session();
        let path = session.library.layout().scan_journal_file();
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        // Neither end of the move is on disk any more.
        let bytes = br#"{"format_version":3,"id":"gone","before":[],"after":[],"intent":{"from":"a.md","to":"b.md","entries":[{"id":1,"from":"a.md","to":"b.md","kind":"file","class":"text","size":0,"mtime_ns":null,"file_id":null,"hash":null,"added_ns":1,"disk":{"size":0,"modified_ns":null,"created_ns":null,"file_id":null}}]}}"#;
        std::fs::write(&path, bytes).unwrap();
        assert!(matches!(
            session.mutate::<()>(|_, _| panic!("write despite an unfinished move")),
            Err(AppError::Internal(_))
        ));
        assert!(matches!(
            session.status(),
            LibraryStatus::Unavailable {
                reason: Unavailable::UnfinishedMove,
                ..
            }
        ));
        assert_eq!(std::fs::read(&path).unwrap(), bytes);
        session.shutdown().unwrap();
        session.discard_move().unwrap();
        assert!(!path.exists());
    }

    fn state_with_unfinished_move() -> (TempDir, super::super::LibraryState) {
        let (dir, session) = inactive_session();
        let journal = session.library.layout().scan_journal_file();
        std::fs::create_dir_all(journal.parent().unwrap()).unwrap();
        let bytes = br#"{"format_version":3,"id":"gone","before":[],"after":[],"intent":{"from":"a.md","to":"b.md","entries":[{"id":1,"from":"a.md","to":"b.md","kind":"file","class":"text","size":0,"mtime_ns":null,"file_id":null,"hash":null,"added_ns":1,"disk":{"size":0,"modified_ns":null,"created_ns":null,"file_id":null}}]}}"#;
        std::fs::write(&journal, bytes).unwrap();
        assert!(matches!(
            session.mutate::<()>(|_, _| panic!("write despite an unfinished move")),
            Err(AppError::Internal(_))
        ));
        session.shutdown().unwrap();
        let state = super::super::LibraryState::new(Ok(dir.path().join("data")), Arc::new(|_| {}));
        lock(&state.0.state).ready = true;
        // Preserve the cached Open status that publish sets before recovery fails.
        state.publish(session);
        (dir, state)
    }

    #[test]
    fn status_stays_unavailable_while_discard_waits_and_when_it_fails() {
        use std::os::windows::fs::OpenOptionsExt;
        use windows_sys::Win32::Storage::FileSystem::{FILE_SHARE_READ, FILE_SHARE_WRITE};
        let (_dir, state) = state_with_unfinished_move();
        let status = state.status().unwrap();
        let session = lock(&state.0.state).session.clone().unwrap();
        let journal = session.library.layout().scan_journal_file();
        let before = std::fs::read(&journal).unwrap();
        let held = std::fs::OpenOptions::new()
            .read(true)
            .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
            .open(&journal)
            .unwrap();
        let operation = lock(&session.operation);
        let discard = thread::spawn({
            let state = state.clone();
            move || state.discard_unfinished_move()
        });
        super::super::tests::until("discard to acquire the transition", || {
            state.0.transition.try_lock().is_err().then_some(())
        });
        assert_eq!(state.status().unwrap(), status);
        assert!(Arc::ptr_eq(
            &session,
            lock(&state.0.state).session.as_ref().unwrap()
        ));
        drop(operation);
        assert!(matches!(discard.join().unwrap(), Err(AppError::InUse(_))));
        drop(held);
        assert_eq!(state.status().unwrap(), status);
        assert_eq!(std::fs::read(&journal).unwrap(), before);
        state.shutdown().unwrap();
    }

    #[test]
    fn a_discard_drain_error_keeps_the_status_session_and_record() {
        let (_dir, state) = state_with_unfinished_move();
        let status = state.status().unwrap();
        let session = lock(&state.0.state).session.clone().unwrap();
        let journal = session.library.layout().scan_journal_file();
        let before = std::fs::read(&journal).unwrap();
        *lock(&session.worker) = Some(thread::spawn(|| panic!("injected worker panic")));
        assert!(matches!(
            state.discard_unfinished_move(),
            Err(AppError::Internal(message)) if message == "library worker panicked"
        ));
        assert_eq!(state.status().unwrap(), status);
        assert!(Arc::ptr_eq(
            &session,
            lock(&state.0.state).session.as_ref().unwrap()
        ));
        assert_eq!(std::fs::read(&journal).unwrap(), before);
        state.shutdown().unwrap();
    }

    #[test]
    fn import_recovery_reports_in_use_and_settles_the_intent_on_retry() {
        use folio_core::fs::{DirEntry, FileSystem, Metadata};
        use std::io::{self, Read};
        use std::path::PathBuf;

        struct LockedDestination {
            base: WindowsFileSystem,
            destination: PathBuf,
            locked: AtomicBool,
        }

        impl FileSystem for LockedDestination {
            fn read_dir(&self, folder: &Path) -> io::Result<Vec<DirEntry>> {
                self.base.read_dir(folder)
            }

            fn metadata(&self, path: &Path) -> io::Result<Metadata> {
                self.base.metadata(path)
            }

            fn open(&self, path: &Path) -> io::Result<Box<dyn Read + '_>> {
                if path == self.destination && self.locked.load(Ordering::Relaxed) {
                    return Err(io::Error::from_raw_os_error(32));
                }
                self.base.open(path)
            }
        }

        let (dir, mut session) = inactive_session();
        // Join the inactive worker before replacing its adapter; recovery itself stays real.
        session.shutdown().unwrap();
        let root = session.library.root().to_owned();
        std::fs::create_dir_all(root.join("Fall/Course")).unwrap();
        session.library.scan(&session.catalog, None, 10).unwrap();
        let target = session
            .catalog
            .read(|tx| {
                catalog::entry(
                    tx,
                    &folio_core::paths::RelPath::parse("Fall/Course").unwrap(),
                )
            })
            .unwrap()
            .unwrap();
        let source = dir.path().join("source.md");
        std::fs::write(&source, b"verified").unwrap();
        let request = import_core::Request {
            sources: vec![import_core::Source::select(source).unwrap()],
            target: folio_core::library::operations::EntryRef::from(&target),
            tags: Default::default(),
            on_conflict: import_core::Conflict::KeepBoth,
            delete_originals: false,
        };
        session.catalog.write(|tx| -> Result<(), catalog::CatalogError> {
            tx.execute_batch("CREATE TRIGGER stop_import BEFORE INSERT ON entries WHEN NEW.path = 'Fall/Course/source.md' BEGIN SELECT RAISE(ABORT, 'leave a published import intent'); END;")?;
            Ok(())
        }).unwrap();
        assert!(matches!(
            session.library.import_files(
                &session.catalog,
                &request,
                &folio_core::win::WindowsRecycleBin,
                12,
                &AtomicBool::new(false),
                &mut |_| {},
                &mut |_| {},
            ),
            Err(OperationError::RecoveryRequired { .. })
        ));
        session
            .catalog
            .write(|tx| -> Result<(), catalog::CatalogError> {
                tx.execute_batch("DROP TRIGGER stop_import")?;
                Ok(())
            })
            .unwrap();
        let adapter = Arc::new(LockedDestination {
            base: WindowsFileSystem::open(&root).unwrap(),
            destination: root.join("Fall/Course/source.md"),
            locked: AtomicBool::new(true),
        });
        Arc::get_mut(&mut session).unwrap().library = Library::new(&root, adapter.clone());
        let journal = session.library.layout().import_journal_file();
        let intent = std::fs::read(&journal).unwrap();
        let failure = session.recover().unwrap_err();
        assert!(matches!(failure.error, AppError::InUse(_)));
        assert_eq!(std::fs::read(&journal).unwrap(), intent);
        adapter.locked.store(false, Ordering::Relaxed);
        session.recover().unwrap();
        assert!(!journal.exists());
        assert_eq!(
            std::fs::read(adapter.destination.clone()).unwrap(),
            b"verified"
        );
        assert!(
            session
                .catalog
                .read(|tx| {
                    catalog::entry(
                        tx,
                        &folio_core::paths::RelPath::parse("Fall/Course/source.md").unwrap(),
                    )
                })
                .unwrap()
                .is_some()
        );
    }

    #[test]
    fn a_cancelled_import_ends_with_its_result_and_keeps_the_original() {
        let (dir, session) = inactive_session();
        let root = session.library.root().to_owned();
        std::fs::create_dir_all(root.join("Fall/Course")).unwrap();
        session.library.scan(&session.catalog, None, 10).unwrap();
        let target = session
            .catalog
            .read(|tx| {
                catalog::entry(
                    tx,
                    &folio_core::paths::RelPath::parse("Fall/Course").unwrap(),
                )
            })
            .unwrap()
            .unwrap();
        let source = dir.path().join("stopped.md");
        std::fs::write(&source, b"source").unwrap();
        session
            .queue_import(import_core::Request {
                sources: vec![import_core::Source::select(source.clone()).unwrap()],
                target: folio_core::library::operations::EntryRef::from(&target),
                tags: Default::default(),
                on_conflict: import_core::Conflict::KeepBoth,
                delete_originals: true,
            })
            .unwrap();
        let (ticket, request) = lock(&session.pending).imports.pop_front().unwrap();
        assert!(session.jobs.start(&ticket).unwrap());
        session.jobs.cancel(&ticket.id).unwrap();
        session.import_files(&ticket, &request).unwrap();

        let job = session
            .jobs
            .list()
            .into_iter()
            .find(|job| job.id == ticket.id)
            .unwrap();
        let crate::ipc::jobs::JobStatus::Cancelled {
            result: Some(JobResult::Import(result)),
        } = job.status
        else {
            panic!("a cancelled import lost its result: {:?}", job.status);
        };
        assert_eq!((result.imported, result.originals_deleted), (0, 0));
        assert_eq!(std::fs::read(&source).unwrap(), b"source");
        session.shutdown().unwrap();
    }

    #[test]
    fn a_malformed_import_journal_stops_writes_and_preserves_the_evidence() {
        let (_dir, session) = inactive_session();
        let journal = session.library.layout().import_journal_file();
        std::fs::create_dir_all(journal.parent().unwrap()).unwrap();
        let bytes = br#"{"format_version":1,"stage":"../outside"}"#;
        std::fs::write(&journal, bytes).unwrap();
        assert!(matches!(
            session.mutate::<()>(|_, _| panic!("write despite malformed import journal")),
            Err(AppError::Internal(_))
        ));
        assert!(matches!(
            session.status(),
            LibraryStatus::Unavailable {
                reason: Unavailable::CatalogFailed,
                ..
            }
        ));
        assert_eq!(std::fs::read(journal).unwrap(), bytes);
        session.shutdown().unwrap();
    }

    #[test]
    fn status_that_failed_after_call_entry_returns_without_retrying() {
        let (dir, session) = inactive_session();
        let state = super::super::LibraryState::new(Ok(dir.path().join("data")), Arc::new(|_| {}));
        {
            let mut current = lock(&state.0.state);
            current.ready = true;
            current.session = Some(session.clone());
        }
        session.fail(Failure::root(AppError::NotFound("watch stopped".into())));
        assert!(matches!(
            state.retry_observed(None).unwrap(),
            LibraryStatus::Unavailable { .. }
        ));
        assert_eq!(lock(&state.0.state).attempt, 0);
        assert!(Arc::ptr_eq(
            &session,
            lock(&state.0.state).session.as_ref().unwrap()
        ));
        state.shutdown().unwrap();
    }

    /// A failure while the library runs keeps the reason of where it happened: a watch that ends
    /// because the drive is not ready is `missing` (it used to read as a catalog failure).
    #[test]
    fn a_failed_watch_reports_its_own_reason() {
        let (_dir, session) = inactive_session();
        // ERROR_NOT_READY
        session.watch(WatchEvent::Failed(std::io::Error::from_raw_os_error(21)));
        session.activate();
        let status = super::super::tests::until("the library to become unavailable", || {
            let status = session.status();
            matches!(status, LibraryStatus::Unavailable { .. }).then_some(status)
        });
        session.shutdown().unwrap();
        assert!(
            matches!(
                status,
                LibraryStatus::Unavailable {
                    reason: Unavailable::Missing,
                    ..
                }
            ),
            "{status:?}"
        );
    }

    #[test]
    fn shutdown_waits_for_the_condvar_predicate_mutex_before_stopping() {
        let (_dir, session) = inactive_session();
        let pending = session.pending.lock().unwrap();
        let started = Arc::new(Barrier::new(2));
        let (send, receive) = mpsc::channel();
        let shutdown_session = session.clone();
        let shutdown_started = started.clone();
        let shutdown = thread::spawn(move || {
            shutdown_started.wait();
            send.send(shutdown_session.shutdown()).unwrap();
        });

        started.wait();
        let while_locked = receive.recv_timeout(Duration::from_millis(100));
        let stopped_while_locked = session.stopped.load(Ordering::Acquire);
        drop(pending);
        let result = match while_locked {
            Ok(result) => result,
            Err(mpsc::RecvTimeoutError::Timeout) => receive
                .recv_timeout(Duration::from_secs(5))
                .expect("shutdown must wake and join the inactive worker"),
            Err(error) => panic!("shutdown exited without a result: {error}"),
        };
        result.unwrap();
        shutdown.join().unwrap();
        assert!(
            !stopped_while_locked,
            "changing stopped outside pending can lose the shutdown notification"
        );
    }

    #[test]
    fn activation_waits_for_the_condvar_predicate_mutex_before_starting() {
        let (_dir, session) = inactive_session();
        let pending = session.pending.lock().unwrap();
        let started = Arc::new(Barrier::new(2));
        let (send, receive) = mpsc::channel();
        let activate_session = session.clone();
        let activate_started = started.clone();
        let activation = thread::spawn(move || {
            activate_started.wait();
            activate_session.activate();
            send.send(()).unwrap();
        });

        started.wait();
        let while_locked = receive.recv_timeout(Duration::from_millis(100));
        let active_while_locked = session.active.load(Ordering::Acquire);
        drop(pending);
        match while_locked {
            Ok(()) => {}
            Err(mpsc::RecvTimeoutError::Timeout) => receive
                .recv_timeout(Duration::from_secs(5))
                .expect("activation must finish after pending is released"),
            Err(error) => panic!("activation exited without a result: {error}"),
        }
        activation.join().unwrap();

        let (send, receive) = mpsc::channel();
        let shutdown = thread::spawn(move || send.send(session.shutdown()).unwrap());
        receive
            .recv_timeout(Duration::from_secs(5))
            .expect("shutdown must wake and join the activated worker")
            .unwrap();
        shutdown.join().unwrap();
        assert!(
            !active_while_locked,
            "changing active outside pending can lose the activation notification"
        );
    }

    /// Which reads of its file a [`Gate`] holds up.
    #[derive(Clone, Copy)]
    enum Hold {
        /// The first `open_seekable`, which only extraction calls: a Word document's.
        Document,
        /// The first this many `open`s: hashing reads each file first, then extraction a text
        /// file.
        Opens(usize),
    }

    /// The library's adapter, holding up reads of the file named `name` as `Hold` says: a held
    /// read says it was reached and waits to be let go. Listings come sorted by name, so scans
    /// give entries their ids, and hashing and extraction their order, by name.
    struct Gate {
        base: WindowsFileSystem,
        name: &'static str,
        /// Whether `open_seekable` holds, once.
        armed: AtomicBool,
        /// How many more `open`s hold.
        opens: AtomicUsize,
        reached: Mutex<mpsc::Sender<()>>,
        release: Mutex<mpsc::Receiver<()>>,
    }

    impl Gate {
        fn hold(&self) {
            lock(&self.reached).send(()).unwrap();
            lock(&self.release)
                .recv_timeout(Duration::from_secs(10))
                .unwrap();
        }
    }

    impl folio_core::fs::FileSystem for Gate {
        fn read_dir(&self, folder: &Path) -> std::io::Result<Vec<folio_core::fs::DirEntry>> {
            let mut entries = self.base.read_dir(folder)?;
            entries.sort_by(|a, b| a.name.cmp(&b.name));
            Ok(entries)
        }

        fn metadata(&self, path: &Path) -> std::io::Result<folio_core::fs::Metadata> {
            self.base.metadata(path)
        }

        fn open(&self, path: &Path) -> std::io::Result<Box<dyn std::io::Read + '_>> {
            if path.file_name() == Some(std::ffi::OsStr::new(self.name))
                && self
                    .opens
                    .fetch_update(Ordering::AcqRel, Ordering::Acquire, |left| {
                        left.checked_sub(1)
                    })
                    .is_ok()
            {
                self.hold();
            }
            self.base.open(path)
        }

        fn open_seekable(
            &self,
            path: &Path,
        ) -> std::io::Result<Box<dyn folio_core::fs::ReadSeek + '_>> {
            if path.file_name() == Some(std::ffi::OsStr::new(self.name))
                && self.armed.swap(false, Ordering::AcqRel)
            {
                self.hold();
            }
            self.base.open_seekable(path)
        }
    }

    /// An inactive session whose library holds `Fall/Course/` with `files`, settled, and the
    /// adapter `Gate` holding up the extraction of the Word document `gate`; the worker is
    /// drained, so the test drives the scheduler itself. Returns the session, the "reached"
    /// receiver and the "release" sender.
    fn gated_session(
        files: &[(&str, &[u8])],
        gate: &'static str,
    ) -> (TempDir, Arc<Session>, mpsc::Receiver<()>, mpsc::Sender<()>) {
        gated_session_holding(files, gate, Hold::Document)
    }

    /// [`gated_session`], the `Gate` holding up the reads of `gate` that `hold` says.
    fn gated_session_holding(
        files: &[(&str, &[u8])],
        gate: &'static str,
        hold: Hold,
    ) -> (TempDir, Arc<Session>, mpsc::Receiver<()>, mpsc::Sender<()>) {
        let (dir, mut session) = inactive_session();
        session.shutdown().unwrap();
        let root = session.root().to_owned();
        let course = root.join("Fall").join("Course");
        std::fs::create_dir_all(&course).unwrap();
        for (name, bytes) in files {
            super::super::tests::settled(&course.join(name), bytes);
        }
        let (reached, on_reach) = mpsc::channel();
        let (on_release, release) = mpsc::channel();
        let adapter = Gate {
            base: WindowsFileSystem::open(&root).unwrap(),
            name: gate,
            armed: AtomicBool::new(matches!(hold, Hold::Document)),
            opens: AtomicUsize::new(match hold {
                Hold::Document => 0,
                Hold::Opens(opens) => opens,
            }),
            reached: Mutex::new(reached),
            release: Mutex::new(release),
        };
        Arc::get_mut(&mut session).unwrap().library = Library::new(&root, Arc::new(adapter));
        session.stopped.store(false, Ordering::Release);
        session.active.store(true, Ordering::Release);
        session
            .scan(&Rescan::Full, &AtomicBool::new(false), None)
            .unwrap()
            .unwrap();
        (dir, session, on_reach, on_release)
    }

    /// The hash job the scheduler gives next, which must be due: `next` waits for work.
    fn next_hash(session: &Session) -> Ticket {
        assert!(
            lock(&session.pending)
                .hash
                .as_ref()
                .is_some_and(|(due, _)| *due <= Instant::now()),
            "no hash job is due"
        );
        match session.next().unwrap() {
            Some(Work::Hash(ticket)) => ticket,
            _ => panic!("the next work is not a hash job"),
        }
    }

    /// Runs a hash job as the worker does: started, under the operation lock.
    fn run_hash(session: &Session, ticket: &Ticket) -> Result<(), Failure> {
        assert!(session.jobs.start(ticket).unwrap());
        session.hash(ticket, lock(&session.operation))
    }

    fn status(session: &Session, ticket: &Ticket) -> crate::ipc::jobs::JobStatus {
        session
            .jobs
            .list()
            .into_iter()
            .find(|job| job.id == ticket.id)
            .unwrap()
            .status
    }

    fn pending_extracts(session: &Session) -> u64 {
        session
            .catalog
            .read(|tx| catalog::count_pending_extracts(tx, folio_core::extract::VERSION))
            .unwrap()
    }

    #[test]
    fn a_change_committed_during_extraction_gets_its_own_hash_job() {
        let (_dir, session, reached, release) = gated_session(
            &[
                ("a.docx", b"not really a document"),
                ("b.md", b"The spectral theorem, again."),
            ],
            "a.docx",
        );
        session.queue_hash(Duration::ZERO).unwrap();
        let first = next_hash(&session);
        let b = session
            .catalog
            .read(|tx| {
                catalog::entry(
                    tx,
                    &folio_core::paths::RelPath::parse("Fall/Course/b.md").unwrap(),
                )
            })
            .unwrap()
            .unwrap();
        let (done, renamed) = mpsc::channel();
        thread::scope(|scope| {
            let job = scope.spawn(|| run_hash(&session, &first));
            reached.recv_timeout(Duration::from_secs(10)).unwrap();
            // Extracting, the job holds no operation lock: a rename does not wait for it.
            scope.spawn(|| {
                let reference = folio_core::library::operations::EntryRef::from(&b);
                done.send(session.mutate(|library, catalog| {
                    library.rename_entry(catalog, &reference, "c.md", now_ns())
                }))
                .unwrap();
            });
            renamed
                .recv_timeout(Duration::from_secs(5))
                .expect("a rename waited for extraction")
                .unwrap();
            {
                let pending = lock(&session.pending);
                assert!(pending.extracting && pending.rehash);
                // The running job counts as busy, but it has hashed already.
                assert!(pending.hash.is_none());
            }
            release.send(()).unwrap();
            job.join().unwrap().unwrap();
        });
        assert!(matches!(
            status(&session, &first),
            crate::ipc::jobs::JobStatus::Done {
                result: JobResult::Hash { .. }
            }
        ));
        {
            let pending = lock(&session.pending);
            assert!(!pending.extracting && !pending.rehash);
        }
        // b.md moved while it waited its turn: the job passed it over, and the next job reads it.
        assert_eq!(pending_extracts(&session), 1);
        let second = next_hash(&session);
        assert_ne!(second.id, first.id);
        run_hash(&session, &second).unwrap();
        assert_eq!(pending_extracts(&session), 0);
        let query = folio_core::search::SearchQuery::parse("spectral")
            .unwrap()
            .unwrap();
        let hits = session
            .catalog
            .read(|tx| catalog::search(tx, &query, 10, 0))
            .unwrap();
        assert_eq!(
            hits.iter()
                .map(|hit| hit.entry.record.path.as_str())
                .collect::<Vec<_>>(),
            ["Fall/Course/c.md"]
        );
        // No third job: nothing changed while the second extracted.
        assert!(lock(&session.pending).hash.is_none());
        assert!(!session.jobs.busy(JobKind::Hash));
    }

    #[test]
    fn a_failed_extraction_write_fails_the_job_and_keeps_what_hashing_committed() {
        let (_dir, session, _reached, _release) =
            gated_session(&[("a.md", b"The spectral theorem.")], "none.docx");
        session
            .catalog
            .write(|tx| -> Result<(), catalog::CatalogError> {
                tx.execute_batch(
                    "CREATE TRIGGER stop_extract BEFORE INSERT ON extracts
                     BEGIN SELECT RAISE(ABORT, 'injected extraction failure'); END;",
                )?;
                Ok(())
            })
            .unwrap();
        session.queue_hash(Duration::ZERO).unwrap();
        let ticket = next_hash(&session);
        let failure = run_hash(&session, &ticket).unwrap_err();
        assert!(
            failure
                .error
                .to_string()
                .contains("injected extraction failure"),
            "{:?}",
            failure.error
        );
        assert!(matches!(
            status(&session, &ticket),
            crate::ipc::jobs::JobStatus::Failed { .. }
        ));
        let a = session
            .catalog
            .read(|tx| {
                catalog::entry(
                    tx,
                    &folio_core::paths::RelPath::parse("Fall/Course/a.md").unwrap(),
                )
            })
            .unwrap()
            .unwrap();
        assert!(a.record.hash.is_some());
        assert_eq!(pending_extracts(&session), 1);
        let pending = lock(&session.pending);
        assert!(!pending.extracting && !pending.rehash && pending.hash.is_none());
    }

    /// The running job's `done` and `total`.
    fn progress(session: &Session, ticket: &Ticket) -> (u32, Option<u32>) {
        match status(session, ticket) {
            crate::ipc::jobs::JobStatus::Running { progress } => (progress.done, progress.total),
            other => panic!("the hash job is not running: {other:?}"),
        }
    }

    /// A hash job's progress counts steps known from its start (ipc-m1 §13): each file hashed,
    /// then each text or Word file whose text is read, so its total holds when reading starts.
    #[test]
    fn a_hash_job_counts_the_text_it_will_read_from_its_start() {
        let files: [(&str, &[u8]); 5] = [
            ("a.md", b"Lecture 1 on eigenvalues"),
            ("b.md", b"Lecture 2 on eigenvalues"),
            ("c.md", b"Lecture 3 on eigenvalues"),
            ("x.pdf", b"%PDF-1.7 not really a paper"),
            ("y.pdf", b"%PDF-1.7 not really a paper either"),
        ];
        // Hashing's read of b.md, then extraction's.
        let (_dir, session, reached, release) =
            gated_session_holding(&files, "b.md", Hold::Opens(2));
        session.queue_hash(Duration::ZERO).unwrap();
        let job = next_hash(&session);
        thread::scope(|scope| {
            let running = scope.spawn(|| run_hash(&session, &job));
            // a.md hashed, of five files to hash and three to read.
            reached.recv_timeout(Duration::from_secs(10)).unwrap();
            assert_eq!(progress(&session, &job), (1, Some(8)));
            release.send(()).unwrap();
            // The five hashed and a.md read: the total as it was.
            reached.recv_timeout(Duration::from_secs(10)).unwrap();
            assert_eq!(progress(&session, &job), (6, Some(8)));
            release.send(()).unwrap();
            running.join().unwrap().unwrap();
        });
        assert_eq!(
            status(&session, &job),
            crate::ipc::jobs::JobStatus::Done {
                result: JobResult::Hash {
                    hashed: 5,
                    deferred: 0
                }
            }
        );
        assert_eq!(pending_extracts(&session), 0);
    }

    /// A text file hashing leaves unhashed (here changed since the scan; too fresh, not local or
    /// unreadable alike) leaves its text unread: the total shrinks when reading starts, and
    /// `done` goes on from hashing's.
    #[test]
    fn a_file_left_unhashed_shrinks_the_total_when_reading_starts_and_done_goes_on() {
        let files: [(&str, &[u8]); 3] = [
            ("a.md", b"Lecture 1 on eigenvalues"),
            ("b.md", b"Lecture 2 on eigenvalues"),
            ("c.md", b"Lecture 3 on eigenvalues"),
        ];
        let (_dir, session, reached, release) =
            gated_session_holding(&files, "b.md", Hold::Opens(2));
        super::super::tests::settled(
            &session.root().join("Fall/Course/c.md"),
            b"Lecture 3 on eigenvalues, longer now",
        );
        session.queue_hash(Duration::ZERO).unwrap();
        let job = next_hash(&session);
        thread::scope(|scope| {
            let running = scope.spawn(|| run_hash(&session, &job));
            reached.recv_timeout(Duration::from_secs(10)).unwrap();
            assert_eq!(progress(&session, &job), (1, Some(6)));
            release.send(()).unwrap();
            // Three files hashing went through, a.md read, of the two left to read.
            reached.recv_timeout(Duration::from_secs(10)).unwrap();
            assert_eq!(progress(&session, &job), (4, Some(5)));
            release.send(()).unwrap();
            running.join().unwrap().unwrap();
        });
        assert_eq!(
            status(&session, &job),
            crate::ipc::jobs::JobStatus::Done {
                result: JobResult::Hash {
                    hashed: 2,
                    deferred: 0
                }
            }
        );
    }

    /// The text to read is counted before hashing: when the count fails, the job fails as a
    /// failed hashing does, before any file is read.
    #[test]
    fn a_failed_count_of_the_text_to_read_fails_the_job_before_hashing() {
        let (_dir, session, _reached, _release) =
            gated_session(&[("a.md", b"The spectral theorem.")], "none.docx");
        session
            .catalog
            .write(|tx| -> Result<(), catalog::CatalogError> {
                tx.execute_batch("DROP TABLE extracts;")?;
                Ok(())
            })
            .unwrap();
        session.queue_hash(Duration::ZERO).unwrap();
        let ticket = next_hash(&session);
        let failure = run_hash(&session, &ticket).unwrap_err();
        assert!(
            failure
                .error
                .to_string()
                .contains("no such table: extracts"),
            "{:?}",
            failure.error
        );
        assert_eq!(failure.reason, Unavailable::CatalogFailed);
        assert!(matches!(
            status(&session, &ticket),
            crate::ipc::jobs::JobStatus::Failed { .. }
        ));
        let a = session
            .catalog
            .read(|tx| {
                catalog::entry(
                    tx,
                    &folio_core::paths::RelPath::parse("Fall/Course/a.md").unwrap(),
                )
            })
            .unwrap()
            .unwrap();
        assert!(a.record.hash.is_none());
        let pending = lock(&session.pending);
        assert!(!pending.extracting && !pending.rehash && pending.hash.is_none());
    }

    /// `CatalogChanged.bodies` (ipc-m1 §15.1): extraction's writes say it, so open searches
    /// refresh though no row changed; a scan's, hashing's and a rebuild's do not, the rebuild's
    /// saying `complete: false` instead.
    #[test]
    fn only_extraction_says_that_search_bodies_changed() {
        let (_dir, mut session, reached, release) = gated_session(
            &[
                ("a.docx", b"not really a document"),
                ("b.md", b"The spectral theorem."),
            ],
            "a.docx",
        );
        let log: Arc<Mutex<Vec<CatalogChanged>>> = Arc::default();
        let sink = log.clone();
        Arc::get_mut(&mut session).unwrap().emit = Arc::new(move |event| {
            if let Event::Catalog(event) = event {
                lock(&sink).push(event);
            }
        });
        // The events sent since the last call, the pending one included, whatever the interval.
        let sent = || {
            lock(&session.snapshot).last_event = None;
            session.flush();
            std::mem::take(&mut *lock(&log))
        };
        sent();
        super::super::tests::settled(&session.root().join("Fall/Course/c.md"), b"Eigenvalues.");
        session
            .scan(&Rescan::Full, &AtomicBool::new(false), None)
            .unwrap()
            .unwrap();
        let scanned = sent();
        assert!(
            scanned.iter().any(|event| !event.entries.is_empty())
                && scanned.iter().all(|event| !event.bodies),
            "{scanned:?}"
        );
        session.queue_hash(Duration::ZERO).unwrap();
        let job = next_hash(&session);
        let (hashed, extracted) = thread::scope(|scope| {
            let running = scope.spawn(|| run_hash(&session, &job));
            // Every file hashed; the document is read first, so nothing is extracted yet.
            reached.recv_timeout(Duration::from_secs(10)).unwrap();
            let hashed = sent();
            release.send(()).unwrap();
            running.join().unwrap().unwrap();
            (hashed, sent())
        });
        assert_eq!(pending_extracts(&session), 0);
        let says = |events: &[CatalogChanged], bodies: bool| {
            !events.is_empty()
                && events.iter().all(|event| {
                    event.bodies == bodies && event.complete && event.entries.is_empty()
                })
        };
        assert!(says(&hashed, false), "{hashed:?}");
        assert!(says(&extracted, true), "{extracted:?}");

        let rebuild = session.jobs.queue(JobKind::Rebuild, true).unwrap();
        assert!(session.jobs.start(&rebuild).unwrap());
        session.rebuild_catalog(&rebuild).unwrap().unwrap();
        let rebuilt = sent();
        assert!(
            !rebuilt.is_empty()
                && !rebuilt[0].complete
                && rebuilt.iter().all(|event| !event.bodies),
            "{rebuilt:?}"
        );
    }

    /// Merged into one pending event, a commit's entries and another's bodies both stay.
    #[test]
    fn a_bodies_commit_merged_with_entry_changes_keeps_both() {
        let (_dir, session) = inactive_session();
        session.shutdown().unwrap();
        let entry = |id: &str| EntryRef {
            id: id.to_owned(),
            path: format!("Fall/Course/{id}.md"),
        };
        let mut snapshot = lock(&session.snapshot);
        snapshot.event = None;
        let added = EntryChange::Added { entry: entry("7") };
        let modified = EntryChange::Modified { entry: entry("8") };
        snapshot.changed(4, [added.clone()], true, false, false, false);
        snapshot.changed(5, [], true, false, false, true);
        snapshot.changed(6, [modified.clone()], true, false, true, false);
        assert_eq!(
            snapshot.event.take(),
            Some(CatalogChanged {
                revision: 6,
                entries: vec![added, modified],
                complete: true,
                tags: false,
                groups: true,
                bodies: true,
            })
        );
        // The next event starts over.
        let removed = EntryChange::Removed { entry: entry("7") };
        snapshot.changed(7, [removed], true, false, false, false);
        assert!(snapshot.event.as_ref().is_some_and(|event| !event.bodies));
    }

    /// `bump` tells the workspace of each commit by its `bodies` flag (ipc-m2.md §14,
    /// versioning.md §13.3): hashing's commits change hashes and readiness, which the workspace
    /// reads, so it computes again; extraction's change search bodies alone, so it computes
    /// nothing for them, yet a `WorkspaceChanged` that reads their revision waits for their
    /// `CatalogChanged`.
    #[test]
    fn the_workspace_follows_hashing_and_waits_for_the_event_of_extracted_text() {
        use std::collections::HashSet;

        use super::super::workspace::Current;
        use super::super::workspace::testing::{HeadTree, write_head};
        use crate::ipc::events::WorkspaceChanged;

        let (_dir, mut session, reached, release) = gated_session(
            &[
                ("a.docx", b"not really a document"),
                ("b.md", b"The spectral theorem."),
                // Extraction never reads it: only hashing's commits make it ready.
                ("c.pdf", b"%PDF-1.7 not really a paper"),
            ],
            "a.docx",
        );
        // `HEAD` holds the folders, so the workspace lists the three files as additions.
        let mut tree = HeadTree::of_disk(session.root());
        tree.rows
            .retain(|path, side| side.is_none() || !path.starts_with("Fall/"));
        let kept: HashSet<_> = tree.rows.values().flatten().map(|side| side.hash).collect();
        tree.blobs.retain(|hash, _| kept.contains(hash));
        write_head(session.library.layout(), &tree, None);
        #[derive(Debug)]
        enum Seen {
            Catalog(CatalogChanged),
            Workspace(WorkspaceChanged),
        }
        let log: Arc<Mutex<Vec<Seen>>> = Arc::default();
        let sink: Sink = {
            let log = log.clone();
            Arc::new(move |event| match event {
                Event::Catalog(event) => lock(&log).push(Seen::Catalog(event)),
                Event::Workspace(event) => lock(&log).push(Seen::Workspace(event)),
                _ => {}
            })
        };
        // The session's tracker stopped with its worker (`gated_session`): a live one instead,
        // whose events go to the same log as the session's, in the order the UI gets them.
        let id = session.library.layout().read_library().unwrap().unwrap().id;
        let tracker = Tracker::new(
            session.catalog.clone(),
            session.library.layout().clone(),
            id,
            sink.clone(),
            session.active.clone(),
        );
        {
            let session = Arc::get_mut(&mut session).unwrap();
            session.emit = sink;
            session.workspace = tracker;
        }
        session.workspace.start().unwrap();
        session.workspace.activate();
        // Sends the session's pending event, whatever the interval.
        let flush = || {
            lock(&session.snapshot).last_event = None;
            session.flush();
        };
        let totals = |current: &Current| {
            let totals = current.workspace().totals();
            (totals.items, totals.hashing)
        };
        assert_eq!(totals(&session.workspace.current().unwrap()), (3, 3));
        session.queue_hash(Duration::ZERO).unwrap();
        let job = next_hash(&session);
        let hashed = thread::scope(|scope| {
            let running = scope.spawn(|| run_hash(&session, &job));
            // Every file hashed; extraction holds at its first read, the document's, before it
            // writes anything.
            reached.recv_timeout(Duration::from_secs(10)).unwrap();
            flush();
            let hashed = session.workspace.current().unwrap();
            // From now on the session's events wait for the test.
            lock(&session.snapshot).last_event = Some(Instant::now() + Duration::from_secs(3600));
            release.send(()).unwrap();
            running.join().unwrap().unwrap();
            hashed
        });
        assert_eq!(totals(&hashed), (3, 0), "computed nothing for hashing");
        let extracted = session.catalog.stamp().revision;
        assert!(extracted > hashed.revision());
        assert!(
            lock(&session.snapshot)
                .event
                .as_ref()
                .is_some_and(|event| event.bodies && event.revision == extracted)
        );
        assert_eq!(
            session.workspace.current().unwrap().revision(),
            hashed.revision(),
            "computed again for search bodies"
        );

        // A change the workspace reads that sends no `CatalogChanged` (as a metadata rescan that
        // changed no row): its workspace reads extraction's revision too, so its event waits.
        super::super::tests::settled(&session.root().join("Fall/Course/d.md"), b"Eigenvalues.");
        session
            .library
            .scan(&session.catalog, None, now_ns())
            .unwrap();
        session.workspace.changed();
        let later = session.workspace.current().unwrap();
        assert!(later.revision() > extracted);
        assert_eq!(totals(&later), (4, 1));
        let sent = |log: &[Seen]| {
            log.iter().any(
                |seen| matches!(seen, Seen::Workspace(event) if event.revision == later.revision()),
            )
        };
        // Longer than the tracker's event interval: an event it did not hold back is out.
        thread::sleep(Duration::from_millis(400));
        {
            let log = lock(&log);
            assert!(!sent(&log), "sent before extraction's event: {log:?}");
        }
        flush();
        super::super::tests::until("the workspace's event", || sent(&lock(&log)).then_some(()));
        session.workspace.stop().unwrap();
        let log = lock(&log);
        let bodies = log
            .iter()
            .position(|seen| matches!(seen, Seen::Catalog(event) if event.bodies));
        let held = log.iter().position(|seen| sent(std::slice::from_ref(seen)));
        assert!(
            bodies.is_some_and(|bodies| held.is_some_and(|held| bodies < held)),
            "{log:?}"
        );
        // No `CatalogChanged` came after a `WorkspaceChanged` that read its revision.
        for (index, seen) in log.iter().enumerate() {
            let Seen::Workspace(workspace) = seen else {
                continue;
            };
            for next in &log[index + 1..] {
                if let Seen::Catalog(catalog) = next {
                    assert!(catalog.revision > workspace.revision, "{log:?}");
                }
            }
        }
    }

    #[test]
    fn a_waiting_rescan_stops_extraction_and_the_next_hash_job_resumes_it() {
        let files: Vec<(String, Vec<u8>)> =
            std::iter::once(("a.docx".to_owned(), b"not really a document".to_vec()))
                .chain((0..5).map(|index| {
                    (
                        format!("b{index}.md"),
                        format!("Lecture {index} on eigenvalues").into_bytes(),
                    )
                }))
                .collect();
        let files: Vec<(&str, &[u8])> = files
            .iter()
            .map(|(name, bytes)| (name.as_str(), bytes.as_slice()))
            .collect();
        let (_dir, session, reached, release) = gated_session(&files, "a.docx");
        // Extraction goes by entry id: the document comes first, so files remain when it is done.
        let ids: Vec<_> = files
            .iter()
            .map(|(name, _)| {
                let path = folio_core::paths::RelPath::parse(&format!("Fall/Course/{name}"));
                session
                    .catalog
                    .read(|tx| catalog::entry(tx, &path.unwrap()))
                    .unwrap()
                    .unwrap()
                    .id
            })
            .collect();
        assert!(ids[1..].iter().all(|id| *id > ids[0]), "{ids:?}");
        session.queue_hash(Duration::ZERO).unwrap();
        let first = next_hash(&session);
        thread::scope(|scope| {
            let job = scope.spawn(|| run_hash(&session, &first));
            reached.recv_timeout(Duration::from_secs(10)).unwrap();
            session.watch(WatchEvent::Rescan(Rescan::Full));
            // Past the pass's write interval, so it writes, and asks, after the document.
            thread::sleep(Duration::from_millis(400));
            release.send(()).unwrap();
            job.join().unwrap().unwrap();
        });
        // It made way: the job is done, the document's failure was recorded and listed, and the
        // Markdown files wait for the next job, queued behind the scan.
        assert!(matches!(
            status(&session, &first),
            crate::ipc::jobs::JobStatus::Done { .. }
        ));
        assert_eq!(pending_extracts(&session), 5);
        use crate::ipc::problems::{Problem, ReadFailure};
        let damaged = Problem::Unreadable {
            path: "Fall/Course/a.docx".to_owned(),
            failure: ReadFailure::Damaged,
        };
        let listed = || -> Vec<Problem> {
            lock(&session.snapshot)
                .problems
                .items()
                .into_iter()
                .map(|item| item.problem)
                .collect()
        };
        assert_eq!(listed(), std::slice::from_ref(&damaged));
        assert!(lock(&session.pending).hash.is_some());
        let Some(Work::Scan(rescan, _)) = session.next().unwrap() else {
            panic!("the hash job went before the scan it made way for");
        };
        session
            .scan(&rescan, &AtomicBool::new(false), None)
            .unwrap()
            .unwrap();
        let second = next_hash(&session);
        assert_ne!(second.id, first.id);
        run_hash(&session, &second).unwrap();
        assert_eq!(pending_extracts(&session), 0);
        // A complete pass lists the stored failure again.
        assert_eq!(listed(), [damaged]);
        assert!(lock(&session.pending).hash.is_none());
    }

    #[test]
    fn extraction_makes_way_for_a_scan_an_import_a_rebuild_or_a_failure() {
        let (dir, session) = inactive_session();
        // Without a live watcher or worker racing the test.
        session.shutdown().unwrap();
        session.stopped.store(false, Ordering::Release);
        let idle = || {
            let mut pending = lock(&session.pending);
            pending.rescan = None;
            pending.imports.clear();
            pending.rebuild = None;
            pending.failure = None;
        };
        idle();
        assert!(!session.waiting());

        session.watch(WatchEvent::Rescan(Rescan::Full));
        assert!(session.waiting(), "a scan");
        idle();
        let source = dir.path().join("queued.txt");
        std::fs::write(&source, b"source").unwrap();
        session
            .queue_import(import_core::Request {
                sources: vec![import_core::Source::select(source).unwrap()],
                target: folio_core::library::operations::EntryRef {
                    id: catalog::EntryId(1),
                    path: folio_core::paths::RelPath::parse("Fall/Course").unwrap(),
                },
                tags: Default::default(),
                on_conflict: import_core::Conflict::KeepBoth,
                delete_originals: false,
            })
            .unwrap();
        assert!(session.waiting(), "an import");
        idle();
        session.rebuild().unwrap();
        assert!(session.waiting(), "a rebuild");
        idle();
        let gone = std::io::Error::other("the folder went away");
        session.watch(WatchEvent::Failed(gone));
        assert!(session.waiting(), "a failure");
        idle();
        session.shutdown().unwrap();
    }

    #[test]
    fn cancelling_the_hash_job_stops_extraction_whose_bar_counts_on_from_hashing() {
        let files: [(&str, &[u8]); 5] = [
            ("a0.md", b"Lecture 0 on eigenvalues"),
            ("a1.md", b"Lecture 1 on eigenvalues"),
            ("m.docx", b"not really a document"),
            ("z0.md", b"Lecture 2 on eigenvalues"),
            ("z1.md", b"Lecture 3 on eigenvalues"),
        ];
        let (_dir, session, reached, release) = gated_session(&files, "m.docx");
        session.queue_hash(Duration::ZERO).unwrap();
        let job = next_hash(&session);
        thread::scope(|scope| {
            let running = scope.spawn(|| run_hash(&session, &job));
            reached.recv_timeout(Duration::from_secs(10)).unwrap();
            // The five files hashed, then two of the five extracted.
            let crate::ipc::jobs::JobStatus::Running { progress } = status(&session, &job) else {
                panic!("the hash job is not running");
            };
            assert_eq!((progress.done, progress.total), (7, Some(10)));
            session.jobs.cancel(&job.id).unwrap();
            release.send(()).unwrap();
            running.join().unwrap().unwrap();
        });
        assert!(matches!(
            status(&session, &job),
            crate::ipc::jobs::JobStatus::Cancelled { .. }
        ));
        // The document's reading stopped, and the files after it were not read.
        assert_eq!(pending_extracts(&session), 3);
    }
}
