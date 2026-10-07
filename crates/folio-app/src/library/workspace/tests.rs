//! The tracker: head syncs, computing, `WorkspaceChanged` and the history lock (ipc-m2.md §6.1,
//! §14, §15). Bare trackers over a catalog of their own let a test play the worker's part
//! exactly; live libraries check what the worker really sends.

use std::fs;
use std::os::windows::fs::OpenOptionsExt;
use std::path::Path;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, mpsc};
use std::thread;
use std::time::{Duration, Instant};

use folio_core::catalog::{Catalog, CatalogError, ReadStamp};
use folio_core::library::Library;
use folio_core::meta::{DisplayName, LibraryConfig, MetaError};
use folio_core::store::StoreError;
use folio_core::win::WindowsFileSystem;
use folio_core::workspace::{HistoryStatus, LoadError, Snapshot, SyncError, Workspace};
use tempfile::TempDir;

use super::testing::{Fixture, Log};
use super::{
    Computed, Current, EVENT_INTERVAL, RETRY_INTERVAL, State, Tracker, history_state, load_error,
    sync_error,
};
use crate::error::AppError;
use crate::ipc::entries::CreateFolder;
use crate::ipc::events::WorkspaceChanged;
use crate::ipc::settings::SetIgnoreRules;
use crate::ipc::workspace::HistoryState;
use crate::library::workspace::testing::until;
use crate::library::{Event, lock};

/// Long enough for an event that is due to have gone out.
const QUIET: Duration = Duration::from_millis(400);

/// The spacing two events keep: the event interval, less the time between the tracker taking its
/// clock and the sink taking its own.
const SPACING: Duration = EVENT_INTERVAL.saturating_sub(Duration::from_millis(5));

/// A tracker over a catalog of its own for the library of `f`, which it never opens: the test
/// scans, hashes and notifies as the worker would.
struct Bare {
    tracker: Tracker,
    catalog: Arc<Catalog>,
    library: Library,
    events: Log,
    _dir: TempDir,
}

impl Bare {
    fn new(f: &Fixture) -> Self {
        Self::with_sink(f, false)
    }

    /// A bare tracker; `panics`: its sink panics at the first `WorkspaceChanged`, on the tracker's
    /// thread.
    fn with_sink(f: &Fixture, panics: bool) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let root = f.root.canonicalize().unwrap();
        let config = f.layout().read_library().unwrap().unwrap();
        let catalog = Arc::new(
            Catalog::open(&dir.path().join("catalog.sqlite"), &config.id)
                .unwrap()
                .catalog,
        );
        let library = Library::new(&root, Arc::new(WindowsFileSystem::open(&root).unwrap()));
        let events: Log = Arc::default();
        let capture = events.clone();
        let tracker = Tracker::new(
            catalog.clone(),
            library.layout().clone(),
            config.id,
            Arc::new(move |event| {
                if panics && matches!(event, Event::Workspace(_)) {
                    panic!("a sink that fails");
                }
                capture.lock().unwrap().push((Instant::now(), event));
            }),
            Arc::new(AtomicBool::new(true)),
        );
        tracker.start().unwrap();
        tracker.activate();
        Self {
            tracker,
            catalog,
            library,
            events,
            _dir: dir,
        }
    }

    /// Scans the whole library as the worker would, and returns the revision after it.
    fn scan(&self) -> u32 {
        self.library
            .scan(&self.catalog, None, crate::library::worker::now_ns())
            .unwrap();
        self.catalog.stamp().revision
    }

    /// A scan, reported as a change whose `CatalogChanged` the worker then sent.
    fn scan_and_report(&self) -> u32 {
        let revision = self.scan();
        self.tracker.catalog_changed(revision);
        self.tracker.catalog_sent(revision);
        revision
    }

    fn events(&self) -> Vec<(Instant, WorkspaceChanged)> {
        workspace_events(&self.events)
    }

    /// Waits for the `count`th event and returns it.
    fn event(&self, count: usize) -> (Instant, WorkspaceChanged) {
        until("a WorkspaceChanged", || {
            self.events().get(count - 1).cloned()
        })
    }

    fn items(&self) -> u32 {
        self.tracker.current().unwrap().workspace().totals().items
    }
}

impl Drop for Bare {
    fn drop(&mut self) {
        let stopped = self.tracker.stop();
        if !thread::panicking() {
            stopped.unwrap();
        }
    }
}

fn workspace_events(log: &Log) -> Vec<(Instant, WorkspaceChanged)> {
    log.lock()
        .unwrap()
        .iter()
        .filter_map(|(at, event)| match event {
            Event::Workspace(event) => Some((*at, event.clone())),
            _ => None,
        })
        .collect()
}

/// No `CatalogChanged` of a revision a `WorkspaceChanged` read comes after it.
fn assert_ordered(log: &Log) {
    let log = log.lock().unwrap();
    for (index, (_, event)) in log.iter().enumerate() {
        let Event::Workspace(workspace) = event else {
            continue;
        };
        for (_, later) in &log[index + 1..] {
            if let Event::Catalog(catalog) = later {
                assert!(
                    catalog.revision > workspace.revision,
                    "CatalogChanged {} came after WorkspaceChanged {}",
                    catalog.revision,
                    workspace.revision
                );
            }
        }
    }
}

/// Every two `WorkspaceChanged` are at least the event interval apart.
fn assert_spaced(events: &[(Instant, WorkspaceChanged)]) {
    for pair in events.windows(2) {
        let gap = pair[1].0.duration_since(pair[0].0);
        assert!(gap >= SPACING, "two events {gap:?} apart: {events:?}");
    }
}

/// A library with `Fall/MAT232/a.md`, `b.md` and `c.md`, committed.
fn committed() -> Fixture {
    let f = Fixture::new();
    for name in ["a", "b", "c"] {
        f.write(&format!("Fall/MAT232/{name}.md"), name.as_bytes());
    }
    f.commit(None);
    f
}

fn remove(f: &Fixture, path: &str) {
    fs::remove_file(f.native(path)).unwrap();
}

#[test]
fn nothing_is_listed_before_the_first_scan() {
    let f = committed();
    remove(&f, "Fall/MAT232/a.md");
    let bare = Bare::new(&f);
    let current = bare.tracker.current().unwrap();
    assert_eq!(current.history_state(), HistoryState::Ready);
    assert!(current.head().is_some());
    // Not every file of HEAD deleted: the catalog does not know the disk yet.
    assert_eq!(current.workspace().totals().items, 0);
    bare.scan();
    bare.tracker.changed();
    assert_eq!(bare.items(), 1);
}

#[test]
fn an_event_waits_for_the_catalog_changed_of_its_revision_and_keeps_its_interval() {
    let f = committed();
    let bare = Bare::new(&f);
    bare.scan_and_report();
    until("the scanned workspace", || {
        (bare.items() == 0).then_some(())
    });
    let first = bare.event(1);
    assert_eq!(first.1.history_state, HistoryState::Ready);
    thread::sleep(QUIET);
    let before = bare.events().len();

    remove(&f, "Fall/MAT232/a.md");
    let revision = bare.scan();
    bare.tracker.catalog_changed(revision);
    // Commands are answered at once; the event waits for its CatalogChanged.
    assert_eq!(bare.items(), 1);
    thread::sleep(QUIET);
    assert_eq!(
        bare.events().len(),
        before,
        "sent before its CatalogChanged"
    );
    bare.tracker.catalog_sent(revision);
    let (sent, event) = bare.event(before + 1);
    assert_eq!((event.revision, event.total), (revision, 1));

    // A change right after: its event keeps the interval.
    remove(&f, "Fall/MAT232/b.md");
    bare.scan_and_report();
    let (next, event) = bare.event(before + 2);
    assert_eq!(event.total, 2);
    assert!(next.duration_since(sent) >= SPACING);

    // A notification that changes nothing sends nothing.
    bare.tracker.changed();
    assert_eq!(bare.items(), 2);
    thread::sleep(QUIET);
    assert_eq!(bare.events().len(), before + 2);
    assert_spaced(&bare.events());
}

#[test]
fn the_catalog_changed_still_unsent_after_a_send_holds_the_next_event_back() {
    let f = committed();
    let bare = Bare::new(&f);
    bare.scan_and_report();
    until("the scanned workspace", || {
        (bare.items() == 0).then_some(())
    });
    bare.event(1);
    let before = bare.events().len();
    // The worker took the event of `first` and sends it; meanwhile `second` merged.
    remove(&f, "Fall/MAT232/a.md");
    let first = bare.scan();
    bare.tracker.catalog_changed(first);
    remove(&f, "Fall/MAT232/b.md");
    let second = bare.scan();
    bare.tracker.catalog_changed(second);
    assert_eq!(bare.items(), 2);
    bare.tracker.catalog_sent(first);
    thread::sleep(QUIET);
    assert_eq!(
        bare.events().len(),
        before,
        "sent before the CatalogChanged of {second}"
    );
    bare.tracker.catalog_sent(second);
    let (_, event) = bare.event(before + 1);
    assert_eq!((event.revision, event.total), (second, 2));
}

#[test]
fn nothing_is_computed_or_sent_while_a_rebuild_runs() {
    let f = committed();
    let bare = Bare::new(&f);
    remove(&f, "Fall/MAT232/a.md");
    bare.scan_and_report();
    until("the scanned workspace and its event", || {
        (bare.items() == 1
            && bare
                .events()
                .last()
                .is_some_and(|(_, event)| event.total == 1))
        .then_some(())
    });
    let before = bare.events().len();
    bare.tracker.rebuilding();
    let computed = lock(&bare.tracker.shared.state).last_compute;
    remove(&f, "Fall/MAT232/b.md");
    bare.scan_and_report();
    // The last snapshot, at once: neither an empty one nor the new one.
    assert_eq!(bare.items(), 1);
    thread::sleep(QUIET);
    assert_eq!(bare.events().len(), before);
    assert_eq!(
        lock(&bare.tracker.shared.state).last_compute,
        computed,
        "computed while the rebuild ran"
    );
    bare.tracker.rebuilt();
    let (_, event) = bare.event(before + 1);
    assert_eq!(event.total, 2);
    assert_eq!(bare.items(), 2);
}

#[test]
fn a_computation_that_saw_a_rebuild_start_is_dropped_even_once_it_ended() {
    let f = committed();
    let bare = Bare::new(&f);
    bare.scan_and_report();
    until("the scanned workspace", || {
        (bare.items() == 0).then_some(())
    });
    let shared = &bare.tracker.shared;
    let (started, head) = {
        let state = lock(&shared.state);
        let Some(Ok(head)) = &state.head else {
            panic!("no head sync");
        };
        ((state.generation, state.rebuilds), head.clone())
    };
    // A computation starts; a rebuild starts and ends (cancelled right after its reset); the
    // computation ends with what it read meanwhile, marked by its revision.
    bare.tracker.rebuilding();
    bare.tracker.rebuilt();
    let read = Snapshot {
        stamp: ReadStamp {
            revision: u32::MAX,
            ranked_at_secs: 0,
        },
        workspace: Workspace::empty(),
    };
    let mut state = lock(&shared.state);
    shared.computed(&mut state, started, head, Ok(read));
    let kept = |computed: Option<&Current>| computed.is_some_and(|c| c.revision() == u32::MAX);
    let ready = match &state.computed {
        Some(Computed::Ready(current)) => Some(current),
        _ => None,
    };
    assert!(!kept(ready), "kept a computation that spanned a rebuild");
    assert!(!kept(state.due.as_ref()), "its event is due");
}

/// The tracker's computation reads with the session's cancel flag, so a library that closes does
/// not wait for it to end.
#[test]
fn a_computation_stops_once_the_tracker_stops() {
    let f = committed();
    let bare = Bare::new(&f);
    bare.scan_and_report();
    until("the scanned workspace", || {
        (bare.items() == 0).then_some(())
    });
    let shared = bare.tracker.shared.clone();
    let head = match &lock(&shared.state).head {
        Some(Ok(head)) => head.clone(),
        _ => panic!("no head sync"),
    };
    assert!(shared.load(&head).is_ok());
    bare.tracker.stop().unwrap();
    assert!(matches!(shared.load(&head), Err(LoadError::Cancelled)));
}

/// Makes a junction at `link` to `target`.
fn junction(link: &Path, target: &Path) {
    let created = std::process::Command::new("cmd")
        .args(["/C", "mklink", "/J"])
        .arg(link)
        .arg(target)
        .output()
        .unwrap();
    assert!(created.status.success(), "{created:?}");
}

/// `current` on another thread, within 10 seconds; else the tracker stops, which answers the
/// command, and the test fails.
fn current_in_time(bare: &Bare) -> Result<Current, AppError> {
    let (answer, answered) = mpsc::channel();
    let answer = thread::scope(|scope| {
        scope.spawn(|| answer.send(bare.tracker.current()).unwrap());
        let answer = answered.recv_timeout(Duration::from_secs(10)).ok();
        if answer.is_none() {
            bare.tracker.stop().unwrap();
        }
        answer
    });
    answer.expect("the command waited for a computation that never came")
}

fn computes(bare: &Bare) -> u64 {
    lock(&bare.tracker.shared.state).computes
}

/// A computation that fails answers the commands that waited for it; a command that finds the
/// failure asks for another, which fails again while the cause stays, and lists the workspace once
/// it is gone, with no notification in between.
#[test]
fn a_failed_computation_is_tried_again_for_the_next_command() {
    let f = committed();
    let bare = Bare::new(&f);
    bare.scan_and_report();
    until("the scanned workspace", || {
        (bare.items() == 0).then_some(())
    });
    // A junction in `.folio/meta/`: the workspace refuses to read through it.
    let outside = tempfile::tempdir().unwrap();
    let meta = f.layout().meta_dir();
    fs::create_dir_all(&meta).unwrap();
    let link = meta.join("Spring");
    junction(&link, outside.path());
    let before = computes(&bare);
    bare.tracker.changed();
    let failed = current_in_time(&bare);
    assert!(matches!(failed, Err(AppError::Internal(_))), "{failed:?}");
    // The notification's computation, or one more when it ended before the command asked.
    let first = computes(&bare);
    assert!(first > before);
    assert!(
        bare.events
            .lock()
            .unwrap()
            .iter()
            .any(|(_, event)| matches!(
                event,
                Event::Error(message) if message.contains("could not compute the workspace")
            ))
    );
    // Asked again while it still fails: the same error, from a new computation.
    let again = current_in_time(&bare);
    assert!(matches!(again, Err(AppError::Internal(_))), "{again:?}");
    assert_eq!(computes(&bare), first + 1);
    fs::remove_dir(&link).unwrap();
    let current = current_in_time(&bare).unwrap();
    assert_eq!(current.workspace().totals().items, 0);
    assert_eq!(computes(&bare), first + 2);
}

/// A tracker whose thread panicked answers a command that waits for it `Internal`, instead of a
/// wait without end, and its stop says it panicked.
#[test]
fn a_tracker_whose_thread_panicked_answers_internal() {
    let f = committed();
    let bare = Bare::with_sink(&f, true);
    // The first event, of the workspace before the first scan, panics in the sink.
    until("the tracker's thread to end", || {
        lock(&bare.tracker.thread)
            .as_ref()
            .is_some_and(|thread| thread.is_finished())
            .then_some(())
    });
    // A notification: the command waits for a computation that no thread makes.
    bare.tracker.changed();
    let answer = current_in_time(&bare);
    assert!(matches!(answer, Err(AppError::Internal(_))), "{answer:?}");
    let stopped = bare.tracker.stop();
    assert!(matches!(stopped, Err(AppError::Internal(_))), "{stopped:?}");
}

/// Search bodies, which text extraction commits, are nothing the workspace reads: they compute
/// nothing, but a `WorkspaceChanged` that reads their revision still waits for their
/// `CatalogChanged`.
#[test]
fn search_bodies_compute_nothing_but_hold_back_the_event_of_their_revision() {
    let f = committed();
    let bare = Bare::new(&f);
    bare.scan_and_report();
    until("the scanned workspace", || {
        (bare.items() == 0).then_some(())
    });
    bare.event(1);
    let before = computes(&bare);
    let extracted = bare.catalog.stamp().revision;
    bare.tracker.search_changed(extracted);
    thread::sleep(QUIET);
    assert_eq!(computes(&bare), before, "computed for search bodies");
    // A notification that sends no `CatalogChanged`: its snapshot reads the extraction's revision.
    remove(&f, "Fall/MAT232/a.md");
    bare.scan();
    bare.tracker.changed();
    assert_eq!(bare.items(), 1);
    thread::sleep(QUIET);
    assert_eq!(
        bare.events().len(),
        1,
        "sent before the search bodies' event"
    );
    bare.tracker.catalog_sent(bare.catalog.stamp().revision);
    let (_, event) = bare.event(2);
    assert_eq!(event.total, 1);
}

/// Why the history is damaged goes to the log, once for each `HEAD` and problem.
#[test]
fn why_the_history_is_damaged_is_logged_once() {
    let f = committed();
    let head = f.layout().head_file();
    fs::write(&head, b"not json").unwrap();
    let bare = Bare::new(&f);
    assert_eq!(
        bare.tracker.current().unwrap().history_state(),
        HistoryState::Damaged
    );
    let logged = || {
        bare.events
            .lock()
            .unwrap()
            .iter()
            .filter(|(_, event)| {
                matches!(event, Event::Error(message) if message.starts_with("the history is damaged: "))
            })
            .count()
    };
    assert_eq!(logged(), 1);
    // The same problem again: not logged again.
    bare.tracker.head_changed();
    assert_eq!(
        bare.tracker.current().unwrap().history_state(),
        HistoryState::Damaged
    );
    assert_eq!(logged(), 1);
}

#[test]
fn a_failed_head_sync_is_tried_again_at_a_notification_once_its_interval_passed() {
    let mut state = State {
        failed: Some((Instant::now(), true)),
        ..State::default()
    };
    state.notified();
    assert_eq!(state.sync, None, "tried again too soon");
    let long_ago = Instant::now().checked_sub(RETRY_INTERVAL).unwrap();
    state.failed = Some((long_ago, true));
    state.notified();
    assert_eq!(state.sync, Some(true), "tried again, forced as it was");
    assert!(state.failed.is_none());
    assert_eq!(state.generation, 2);
}

#[test]
fn a_head_change_syncs_once_the_history_lock_is_free() {
    let f = Fixture::new();
    f.write("Fall/a.md", b"a");
    let bare = Bare::new(&f);
    let none = bare.tracker.current().unwrap();
    assert_eq!(
        (none.history_state(), none.head()),
        (HistoryState::None, None)
    );
    bare.event(1);
    let head = f.commit(None);

    let held = bare.tracker.history().unwrap();
    assert!(matches!(
        bare.tracker.history(),
        Err(AppError::HistoryBusy(_))
    ));
    bare.tracker.head_changed();
    let (answer, answered) = mpsc::channel();
    thread::scope(|scope| {
        scope.spawn(|| answer.send(bare.tracker.current()).unwrap());
        // The sync waits for the lock, and the command for the sync.
        assert!(answered.recv_timeout(QUIET).is_err());
        drop(held);
        let current = answered
            .recv_timeout(Duration::from_secs(10))
            .unwrap()
            .unwrap();
        assert_eq!(current.history_state(), HistoryState::Ready);
        assert_eq!(current.head(), Some(head.to_string()));
    });
    let (_, event) = bare.event(2);
    assert_eq!(
        (event.head, event.history_state),
        (Some(head.to_string()), HistoryState::Ready)
    );
    // The lock is free again.
    drop(bare.tracker.history().unwrap());
}

#[test]
fn a_failed_head_sync_is_tried_again_when_a_command_asks() {
    let f = committed();
    let head = f.layout().head_file();
    let held = fs::OpenOptions::new()
        .read(true)
        .share_mode(0)
        .open(&head)
        .unwrap();
    let bare = Bare::new(&f);
    assert!(matches!(bare.tracker.current(), Err(AppError::InUse(_))));
    // Asked again while it still fails: the same error, from a new attempt.
    assert!(matches!(bare.tracker.current(), Err(AppError::InUse(_))));
    drop(held);
    let current = bare.tracker.current().unwrap();
    assert_eq!(current.history_state(), HistoryState::Ready);
    // The failure went to the log.
    assert!(
        bare.events
            .lock()
            .unwrap()
            .iter()
            .any(|(_, event)| matches!(
                event,
                Event::Error(message) if message.contains("HEAD")
            ))
    );
}

#[test]
fn stopping_answers_a_waiting_command_and_waits_for_the_sync() {
    let f = committed();
    let bare = Bare::new(&f);
    bare.tracker.current().unwrap();
    let held = bare.tracker.history().unwrap();
    bare.tracker.head_changed();
    let (answer, answered) = mpsc::channel();
    let (stop, stopped) = mpsc::channel();
    thread::scope(|scope| {
        scope.spawn(|| answer.send(bare.tracker.current()).unwrap());
        assert!(answered.recv_timeout(QUIET).is_err());
        scope.spawn(|| stop.send(bare.tracker.stop()).unwrap());
        let result = answered.recv_timeout(Duration::from_secs(10)).unwrap();
        assert!(matches!(result, Err(AppError::NoLibrary(_))), "{result:?}");
        // The tracker's thread waits for the lock; the stop for the thread.
        assert!(stopped.recv_timeout(QUIET).is_err());
        drop(held);
        stopped
            .recv_timeout(Duration::from_secs(10))
            .unwrap()
            .unwrap();
    });
    assert!(matches!(
        bare.tracker.current(),
        Err(AppError::NoLibrary(_))
    ));
}

#[test]
fn errors_and_states_map_to_the_contract() {
    let io = |kind: std::io::ErrorKind| {
        sync_error(SyncError::Io(StoreError::Io {
            path: Path::new("packs").to_path_buf(),
            source: kind.into(),
        }))
    };
    assert!(matches!(
        io(std::io::ErrorKind::NotFound),
        AppError::NotFound(_)
    ));
    assert!(matches!(
        io(std::io::ErrorKind::PermissionDenied),
        AppError::AccessDenied(_)
    ));
    assert!(matches!(
        sync_error(SyncError::Io(StoreError::Io {
            path: Path::new("catalog.sqlite").to_path_buf(),
            source: std::io::Error::other(CatalogError::Invalid("broken".to_owned())),
        })),
        AppError::Internal(_)
    ));
    assert!(matches!(
        sync_error(SyncError::Catalog(CatalogError::Invalid(
            "broken".to_owned()
        ))),
        AppError::Internal(_)
    ));
    assert!(matches!(
        sync_error(SyncError::Cancelled),
        AppError::NoLibrary(_)
    ));
    assert!(matches!(
        sync_error(SyncError::Meta(MetaError::Random("a link".to_owned()))),
        AppError::Internal(_)
    ));
    assert!(matches!(
        load_error(LoadError::Meta(MetaError::Random("listing".to_owned()))),
        AppError::Internal(_)
    ));
    assert!(matches!(
        load_error(LoadError::Catalog(CatalogError::Invalid(
            "broken".to_owned()
        ))),
        AppError::Internal(_)
    ));
    assert!(matches!(
        load_error(LoadError::Cancelled),
        AppError::NoLibrary(_)
    ));
    assert_eq!(
        [
            HistoryStatus::None,
            HistoryStatus::Ready,
            HistoryStatus::ReadOnly,
            HistoryStatus::Damaged,
            HistoryStatus::TooLarge,
        ]
        .map(history_state),
        [
            HistoryState::None,
            HistoryState::Ready,
            HistoryState::ReadOnly,
            HistoryState::Damaged,
            HistoryState::Damaged,
        ]
    );
}

#[test]
fn a_new_library_sends_one_event_without_history() {
    let f = Fixture::new();
    f.write("Fall/a.md", b"a");
    f.open();
    let (_, event) = until("a WorkspaceChanged", || {
        f.workspace_events().first().cloned()
    });
    assert_eq!(
        (event.head, event.history_state, event.total),
        (None, HistoryState::None, 0)
    );
    thread::sleep(QUIET);
    assert_eq!(f.workspace_events().len(), 1);
}

#[test]
fn a_live_library_sends_its_events_after_their_catalog_changed_and_spaced() {
    let f = committed();
    f.open();
    let course = f.reference("Fall/MAT232");
    for index in 0..8 {
        f.state
            .create_folder(CreateFolder {
                parent: course.clone(),
                name: format!("Week {index}"),
            })
            .unwrap();
        thread::sleep(Duration::from_millis(40));
    }
    until("the eight new folders", || {
        f.workspace_events()
            .last()
            .is_some_and(|(_, event)| event.total == 8)
            .then_some(())
    });
    let events = f.workspace_events();
    assert!(events.len() >= 2, "{events:?}");
    assert_spaced(&events);
    assert_ordered(&f.events);
    assert_eq!(f.workspace().workspace().totals().items, 8);
}

#[test]
fn a_file_that_finishes_hashing_sends_an_event() {
    let f = committed();
    f.open();
    let before = f.workspace_events().len();
    // Written just now: the hash job waits for it to settle (library-scan.md §8).
    fs::write(f.native("Fall/MAT232/new.md"), b"new").unwrap();
    until("the new file, hashing", || {
        let totals = f.workspace().workspace().totals();
        (totals.items == 1 && totals.hashing == 1).then_some(())
    });
    until("the new file, hashed", || {
        let totals = f.workspace().workspace().totals();
        (totals.items == 1 && totals.hashing == 0).then_some(())
    });
    let hashed = until("its event", || {
        let events = f.workspace_events();
        let later: Vec<_> = events[before..]
            .iter()
            .filter(|(_, event)| event.total == 1)
            .cloned()
            .collect();
        (later.len() >= 2).then_some(later)
    });
    assert!(hashed[1].1.revision > hashed[0].1.revision);
    assert_ordered(&f.events);
}

#[test]
fn a_rebuild_lists_nothing_it_should_not_and_derives_head_again() {
    let f = committed();
    f.open();
    let head = f.workspace().head();
    assert!(head.is_some());
    // A row of `HEAD` the catalog holds wrong: only a head sync that derives everything again
    // (forced, after the rebuild) puts it right.
    let session = f.session();
    session
        .catalog()
        .write(|tx| -> Result<(), CatalogError> {
            tx.execute_batch(
                "UPDATE head_files SET hash = 'b3:0000000000000000000000000000000000000000000000000000000000000000'
                 WHERE path = 'Fall/MAT232/a.md'",
            )?;
            Ok(())
        })
        .unwrap();
    session.workspace.changed();
    assert_eq!(f.workspace().workspace().totals().items, 1);
    drop(session);
    let before = until("the event of the wrong row", || {
        let events = f.workspace_events();
        events
            .last()
            .is_some_and(|(_, event)| event.total == 1)
            .then_some(events.len())
    });
    let rebuild = f.state.rebuild().unwrap();
    until("the rebuild", || {
        f.state.list_jobs().unwrap().into_iter().find(|job| {
            job.id == rebuild && matches!(job.status, crate::ipc::jobs::JobStatus::Done { .. })
        })
    });
    f.wait_for_jobs();
    let current = f.workspace();
    assert_eq!(current.head(), head);
    assert_eq!(current.workspace().totals().items, 0);
    // Never every file deleted while the catalog was empty.
    let events = f.workspace_events();
    assert!(
        events[before..].iter().all(|(_, event)| event.total == 0),
        "{events:?}"
    );
    assert_ordered(&f.events);
}

/// Waits for one metadata change and the `WorkspaceChanged` that says so, sent after `before`
/// events.
fn wait_for_metadata_change(f: &Fixture, before: usize, what: &str) {
    until(what, || {
        (f.workspace().workspace().totals().metadata == 1).then_some(())
    });
    until("its WorkspaceChanged", || {
        f.workspace_events()[before..]
            .iter()
            .any(|(_, event)| event.total == 1)
            .then_some(())
    });
}

/// Ignore rules that hide no file change no catalog row: the worker's metadata rescan still tells
/// the tracker (`Tracker::changed`), which reads `.folio/ignore` from the disk.
#[test]
fn ignore_rules_that_hide_nothing_change_the_workspace() {
    let f = committed();
    f.open();
    assert_eq!(f.workspace().workspace().totals().metadata, 0);
    let before = f.workspace_events().len();
    f.state
        .set_ignore_rules(
            SetIgnoreRules {
                text: "*.tmp\n".to_owned(),
            },
            |_| {},
        )
        .unwrap();
    wait_for_metadata_change(&f, before, "the ignore rules' metadata change");
}

/// The same for library settings edited while the library is open.
#[test]
fn library_settings_edited_while_open_change_the_workspace() {
    let f = committed();
    f.open();
    assert_eq!(f.workspace().workspace().totals().metadata, 0);
    let before = f.workspace_events().len();
    let layout = f.layout();
    let config = layout.read_library().unwrap().unwrap();
    layout
        .write_library(&LibraryConfig {
            name: DisplayName::parse("Renamed library").unwrap(),
            ..config
        })
        .unwrap();
    wait_for_metadata_change(&f, before, "the library settings' metadata change");
}

#[test]
fn a_head_written_while_open_comes_in_with_head_changed() {
    let f = Fixture::new();
    f.write("Fall/a.md", b"a");
    f.open();
    assert_eq!(f.workspace().history_state(), HistoryState::None);
    let head = f.commit(None);
    f.session().workspace.head_changed();
    let current = f.workspace();
    assert_eq!(current.head(), Some(head.to_string()));
    assert_eq!(current.workspace().totals().items, 0);
    until("the event of the new HEAD", || {
        f.workspace_events()
            .iter()
            .any(|(_, event)| event.head == Some(head.to_string()))
            .then_some(())
    });
}
