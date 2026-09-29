use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex, PoisonError};
use std::thread::JoinHandle;
use std::time::{Duration, Instant, SystemTime};

use folio_core::catalog::{self, Catalog};
use folio_core::library::{self as core, CommittedScan, EntryChangeKind, Library, ScanCoverage};
use folio_core::meta::MetaTree;
use folio_core::watch::{Rescan, WatchOptions};
use folio_core::win::{WatchEvent, Watcher, WindowsFileSystem};

use super::{Event, Sink, errors, lock, problems::Problems};
use crate::error::AppError;
use crate::ipc::events::{CatalogChanged, EntryChange};
use crate::ipc::jobs::{JobKind, JobResult};
use crate::ipc::library::{LibraryInfo, LibraryOpened, LibraryStatus};
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
    pending: Mutex<Pending>,
    wake: Condvar,
    active: Arc<AtomicBool>,
    stopped: AtomicBool,
    watcher: Mutex<Option<Watcher>>,
    worker: Mutex<Option<JoinHandle<()>>>,
    emit: Sink,
}

struct Snapshot {
    info: LibraryInfo,
    failure: Option<AppError>,
    revision: u32,
    problems: Problems,
    event: Option<CatalogChanged>,
    last_event: Option<Instant>,
}

impl Snapshot {
    /// Counts one commit and merges its changes into the pending event. Converts entries only
    /// while the event has room: a first scan reports every file, an event at most 200.
    fn changed(
        &mut self,
        entries: impl IntoIterator<Item = EntryChange>,
        complete: bool,
        tags: bool,
        groups: bool,
    ) {
        self.revision = self.revision.wrapping_add(1);
        let revision = self.revision;
        let event = self.event.get_or_insert_with(|| CatalogChanged {
            revision,
            entries: Vec::new(),
            complete: true,
            tags: false,
            groups: false,
        });
        event.revision = revision;
        event.complete &= complete;
        event.tags |= tags;
        event.groups |= groups;
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
    hash: Option<(Instant, Ticket)>,
    failure: Option<AppError>,
}

enum Work {
    Scan(Rescan, Option<Ticket>),
    Hash(Ticket),
    Rebuild(Ticket),
    Failed(AppError),
}

impl Session {
    pub fn prepare(root: &Path, data_dir: &Path, emit: Sink) -> Result<Arc<Self>, AppError> {
        let root = super::directory(root)?;
        let config = super::read_config(&root)?;
        let fs = Arc::new(WindowsFileSystem::open(&root).map_err(errors::io)?);
        let options = WatchOptions::new(fs.has_file_ids());
        let library = Library::new(&root, fs);
        let read_only = MetaTree::read(library.layout())
            .map_err(errors::meta)?
            .is_read_only();
        let path = data_dir
            .join("libraries")
            .join(config.id.as_str())
            .join("catalog.sqlite");
        let opened = Catalog::open(&path, &config.id).map_err(errors::catalog)?;
        let active = Arc::new(AtomicBool::new(false));
        let job_sink = emit.clone();
        let job_active = active.clone();
        let jobs = Registry::new(Arc::new(move |job| {
            if job_active.load(Ordering::Acquire) {
                job_sink(Event::Job(job));
            }
        }));
        let startup = jobs.queue(JobKind::Scan, true)?;
        let session = Arc::new(Self {
            library,
            catalog: Arc::new(opened.catalog),
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
        });
        let weak = Arc::downgrade(&session);
        let watcher = Watcher::start(&root, options, move |event| {
            if let Some(session) = weak.upgrade() {
                session.watch(event);
            }
        })
        .map_err(errors::io)?;
        *lock(&session.watcher) = Some(watcher);
        let worker_session = session.clone();
        let worker = match std::thread::Builder::new()
            .name("folio-library".to_owned())
            .spawn(move || {
                if let Err(error) = worker_session.run() {
                    worker_session.fail(error);
                }
            }) {
            Ok(worker) => worker,
            Err(error) => {
                session.shutdown()?;
                return Err(errors::io(error));
            }
        };
        *lock(&session.worker) = Some(worker);
        Ok(session)
    }

    /// The canonical library root.
    pub fn root(&self) -> &Path {
        self.library.root()
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
    }

    pub fn status(&self) -> LibraryStatus {
        let snapshot = lock(&self.snapshot);
        match &snapshot.failure {
            Some(error) => super::unavailable(self.library.root(), error),
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
            WatchEvent::Failed(error) => pending.failure = Some(errors::io(error)),
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
        if let Some(worker) = worker {
            worker
                .join()
                .map_err(|_| AppError::Internal("library worker panicked".to_owned()))?;
        }
        Ok(())
    }

    fn run(&self) -> Result<(), AppError> {
        loop {
            self.flush();
            let Some(work) = self.next()? else {
                // Cancels a job queued after shutdown's cancel_all, such as a deferred hash.
                self.jobs.cancel_all();
                return Ok(());
            };
            match work {
                Work::Failed(error) => return Err(error),
                Work::Scan(rescan, ticket) => {
                    // A job cancelled while queued has finished: skip its work.
                    if let Some(ticket) = &ticket
                        && !self.jobs.start(ticket)?
                    {
                        continue;
                    }
                    let cancel = ticket
                        .as_ref()
                        .map_or(&self.stopped, |ticket| ticket.cancel.as_ref());
                    let result = self.scan(&rescan, cancel, ticket.as_ref());
                    if let Some(ticket) = &ticket {
                        self.jobs.finish(ticket, result.clone())?;
                    }
                    if result?.is_some() && !matches!(rescan, Rescan::Metadata) {
                        self.queue_hash(Duration::ZERO)?;
                    }
                }
                Work::Hash(ticket) => {
                    if self.jobs.start(&ticket)? {
                        self.hash(&ticket)?;
                    }
                }
                Work::Rebuild(ticket) => {
                    if !self.jobs.start(&ticket)? {
                        continue;
                    }
                    let result = self.rebuild_catalog(&ticket);
                    self.jobs.finish(&ticket, result.clone())?;
                    if result?.is_some() {
                        self.queue_hash(Duration::ZERO)?;
                    }
                }
            }
        }
    }

    fn next(&self) -> Result<Option<Work>, AppError> {
        let mut pending = lock(&self.pending);
        loop {
            if self.stopped.load(Ordering::Acquire) {
                return Ok(None);
            }
            if self.active.load(Ordering::Acquire) {
                if let Some(error) = pending.failure.take() {
                    return Ok(Some(Work::Failed(error)));
                }
                if let Some(ticket) = pending.rebuild.take() {
                    return Ok(Some(Work::Rebuild(ticket)));
                }
                if let Some(rescan) = pending.rescan.take() {
                    // A full scan is a job. Queue it under `pending`, like a rebuild: shutdown
                    // sets `stopped` under this lock before cancel_all, so it cannot miss it.
                    let ticket = match rescan {
                        Rescan::Full => Some(match pending.startup.take() {
                            Some(startup) => startup,
                            None => self.jobs.queue(JobKind::Scan, true)?,
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
    ) -> Result<Option<JobResult>, AppError> {
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
        Ok(completed.then_some(JobResult::Scan {
            changes: count(changes),
            problems: count(problems as u64),
        }))
    }

    /// Hashes the pending files for a started job, and retries files that were too fresh.
    fn hash(&self, ticket: &Ticket) -> Result<(), AppError> {
        let report = self.library.hash_pending_with_commits(
            &self.catalog,
            now_ns(),
            &ticket.cancel,
            &mut |done, total| {
                if let Err(error) = self.jobs.progress(ticket, done, Some(total)) {
                    self.send(Event::Error(error.to_string()));
                }
            },
            // Hashes are not in the entry rows the UI shows; the revision still counts them.
            &mut || self.bump(true, false, false),
        );
        let report = match report.map_err(errors::library) {
            Ok(report) => report,
            Err(error) => {
                self.jobs.finish(ticket, Err(error.clone()))?;
                return Err(error);
            }
        };
        if lock(&self.snapshot)
            .problems
            .hash(report.problems, report.cancelled)
        {
            self.problems_changed();
        }
        let cancelled = report.cancelled || ticket.cancel.load(Ordering::Acquire);
        self.jobs.finish(
            ticket,
            Ok((!cancelled).then_some(JobResult::Hash {
                hashed: count(report.hashed),
                deferred: count(report.deferred),
            })),
        )?;
        if !cancelled && report.deferred > 0 {
            self.queue_hash(HASH_DELAY)?;
        }
        Ok(())
    }

    fn rebuild_catalog(&self, ticket: &Ticket) -> Result<Option<JobResult>, AppError> {
        if ticket.cancel.load(Ordering::Acquire) {
            return Ok(None);
        }
        self.library
            .reset_catalog(&self.catalog)
            .map_err(errors::library)?;
        self.bump(false, true, true);
        if self
            .scan(&Rescan::Full, &ticket.cancel, Some(ticket))?
            .is_none()
        {
            return Ok(None);
        }
        let entries = self
            .catalog
            .read(|tx| catalog::count_entries(tx))
            .map_err(errors::catalog)?;
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
            let invalidated = snapshot.problems.invalidate_hash(&report.entries);
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
                snapshot.changed(
                    report.entries.into_iter().map(entry_change),
                    true,
                    report.tags,
                    report.groups,
                );
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

    /// Counts a commit whose entries the UI need not refetch one by one.
    fn bump(&self, complete: bool, tags: bool, groups: bool) {
        lock(&self.snapshot).changed([], complete, tags, groups);
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
            self.send(Event::Catalog(event));
        }
    }

    fn problems_changed(&self) {
        let total = lock(&self.snapshot).problems.total();
        self.send(Event::Problems(count(total as u64)));
    }

    fn queue_hash(&self, delay: Duration) -> Result<(), AppError> {
        let mut pending = lock(&self.pending);
        // A queued rebuild scans and hashes afterwards; a stopped session does nothing more.
        if self.stopped.load(Ordering::Acquire) || self.jobs.busy(JobKind::Rebuild) {
            return Ok(());
        }
        // A hash job cancelled while it waited has already finished: queue a new one.
        if pending
            .hash
            .as_ref()
            .is_none_or(|(_, ticket)| !self.jobs.live(ticket))
        {
            let ticket = self.jobs.queue(JobKind::Hash, true)?;
            pending.hash = Some((Instant::now() + delay, ticket));
        }
        Ok(())
    }

    fn fail(&self, error: AppError) {
        {
            let _pending = lock(&self.pending);
            self.stopped.store(true, Ordering::Release);
        }
        lock(&self.snapshot).failure = Some(error.clone());
        self.jobs.cancel_all();
        self.send(Event::Error(error.to_string()));
        self.send(Event::Library(super::unavailable(
            self.library.root(),
            &error,
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

fn now_ns() -> i64 {
    folio_core::fs::unix_ns(SystemTime::now()).unwrap_or(i64::MAX)
}

#[cfg(test)]
mod tests {
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
}
