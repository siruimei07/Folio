//! State-level IPC contracts, using only disposable folders and captured shell events.

use std::sync::mpsc;
use std::thread;

use folio_core::catalog::{self, Catalog, Entry};
use folio_core::meta::PresetTag;
use folio_core::paths::RelPath;
use tempfile::TempDir;

use crate::ipc::events::EntryChange;
use crate::ipc::jobs::{JobKind, JobResult, JobStatus};
use crate::ipc::library::PresetTagNames;
use crate::ipc::problems::{Problem, ReadFailure};
use crate::ipc::types::PageRequest;

use super::*;

struct Fixture {
    state: LibraryState,
    events: Arc<Mutex<Vec<Event>>>,
    root: PathBuf,
    data: PathBuf,
    dir: TempDir,
}

impl Fixture {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("library");
        let data = dir.path().join("data");
        fs::create_dir(&root).unwrap();
        fs::create_dir(&data).unwrap();
        let events = Arc::new(Mutex::new(Vec::new()));
        let capture = events.clone();
        let state = LibraryState::new(
            Ok(data.clone()),
            Arc::new(move |event| capture.lock().unwrap().push(event)),
        );
        Self {
            state,
            events,
            root,
            data,
            dir,
        }
    }

    // Only the choice authority is injected; create/open use their real token-consumption path.
    fn grant(&self, root: &Path) -> String {
        let token = crate::jobs::id().unwrap();
        self.state.0.choices.lock().unwrap().insert(
            token.clone(),
            Choice {
                root: root.canonicalize().unwrap(),
                chosen: Instant::now(),
            },
        );
        token
    }

    fn create(&self) -> LibraryOpened {
        self.state.create(request(self.grant(&self.root))).unwrap()
    }

    fn done(&self, id: &str) -> Job {
        let job = until("job to finish", || {
            self.state.list_jobs().unwrap().into_iter().find(|job| {
                job.id == id && !matches!(job.status, JobStatus::Queued | JobStatus::Running { .. })
            })
        });
        assert!(matches!(job.status, JobStatus::Done { .. }), "{job:?}");
        job
    }

    fn kind_done(&self, kind: JobKind) {
        let job = until("job kind to finish", || {
            self.state.list_jobs().unwrap().into_iter().find(|job| {
                job.kind == kind
                    && !matches!(job.status, JobStatus::Queued | JobStatus::Running { .. })
            })
        });
        assert!(matches!(job.status, JobStatus::Done { .. }), "{job:?}");
    }

    fn restart(&mut self) {
        self.state.shutdown().unwrap();
        let capture = self.events.clone();
        self.state = LibraryState::new(
            Ok(self.data.clone()),
            Arc::new(move |event| capture.lock().unwrap().push(event)),
        );
        self.state.initialize();
    }

    // Open an inspection connection only after the session has released its writer.
    fn persisted_entry(&self, path: &str) -> Entry {
        assert!(self.state.is_closed());
        let config = Layout::new(&self.root).read_library().unwrap().unwrap();
        let path_in_library = RelPath::parse(path).unwrap();
        let file = self
            .data
            .join("libraries")
            .join(config.id.as_str())
            .join("catalog.sqlite");
        let opened = Catalog::open(&file, &config.id).unwrap();
        assert!(opened.recovered.is_none());
        opened
            .catalog
            .read(|tx| catalog::entry(tx, &path_in_library))
            .unwrap()
            .unwrap()
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let result = self.state.shutdown();
        if !thread::panicking() {
            result.unwrap();
        }
    }
}

fn request(folder: String) -> CreateLibrary {
    CreateLibrary {
        folder,
        name: "Course library".to_owned(),
        preset_tags: PresetTagNames {
            notes: "Notes".to_owned(),
            slides: "Slides".to_owned(),
            homework: "Homework".to_owned(),
            exam: "Exam".to_owned(),
            reference: "Reference".to_owned(),
        },
    }
}

fn core_library(root: &Path) {
    let names = ["Notes", "Slides", "Homework", "Exam", "Reference"]
        .map(|name| DisplayName::parse(name).unwrap());
    state::create(root, DisplayName::parse("Existing library").unwrap(), names).unwrap();
}

fn newer_library(root: &Path) -> Vec<u8> {
    core_library(root);
    let file = Layout::new(root).library_file();
    let mut value: serde_json::Value = serde_json::from_slice(&fs::read(&file).unwrap()).unwrap();
    value["format_version"] = 999.into();
    let bytes = serde_json::to_vec(&value).unwrap();
    fs::write(file, &bytes).unwrap();
    bytes
}

fn page(offset: u32, limit: u32) -> ListProblems {
    ListProblems {
        page: PageRequest { offset, limit },
    }
}

pub(super) fn until<T>(what: &str, mut poll: impl FnMut() -> Option<T>) -> T {
    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        if let Some(value) = poll() {
            return value;
        }
        assert!(Instant::now() < deadline, "timed out waiting for {what}");
        thread::sleep(Duration::from_millis(20));
    }
}

#[test]
fn startup_waits_for_initialization_and_preserves_unreadable_settings() {
    let f = Fixture::new();
    let waiting = f.state.clone();
    let (send, receive) = mpsc::channel();
    let waiter = thread::spawn(move || send.send(waiting.status()).unwrap());
    assert!(matches!(
        receive.recv_timeout(Duration::from_millis(30)),
        Err(mpsc::RecvTimeoutError::Timeout)
    ));
    f.state.initialize();
    assert_eq!(
        receive
            .recv_timeout(Duration::from_secs(3))
            .unwrap()
            .unwrap(),
        LibraryStatus::None
    );
    waiter.join().unwrap();

    for bytes in [
        b"{".as_slice(),
        br#"{"format_version":999,"library_root":null}"#,
        br#"{"format_version":1,"library_root":"relative"}"#,
    ] {
        let f = Fixture::new();
        let file = f.data.join("settings.json");
        fs::write(&file, bytes).unwrap();
        f.state.initialize();
        assert!(matches!(
            f.state.status(),
            Err(AppError::DataDirUnavailable(_))
        ));
        assert_eq!(fs::read(&file).unwrap(), bytes);
        assert!(!Layout::new(&f.root).folio_dir().exists());
    }

    let unavailable = LibraryState::new(
        Err(AppError::DataDirUnavailable(
            "test data directory failure".to_owned(),
        )),
        Arc::new(|_| {}),
    );
    unavailable.initialize();
    assert!(matches!(
        unavailable.status(),
        Err(AppError::DataDirUnavailable(_))
    ));
    unavailable.shutdown().unwrap();
}

#[test]
fn unavailable_status_retry_reopens_without_saving_settings() {
    let f = Fixture::new();
    Settings {
        library_root: Some(f.root.clone()),
        ..Settings::default()
    }
    .save(&f.data)
    .unwrap();
    let before = fs::read(f.data.join("settings.json")).unwrap();
    f.state.initialize();
    assert!(matches!(
        f.state.status().unwrap(),
        LibraryStatus::Unavailable { .. }
    ));
    core_library(&f.root);
    assert!(matches!(
        f.state.retry_status().unwrap(),
        LibraryStatus::Open { .. }
    ));
    let session = lock(&f.state.0.state).session.clone().unwrap();
    f.done(&session.opened().scan);
    assert_eq!(fs::read(f.data.join("settings.json")).unwrap(), before);
    assert!(
        f.events
            .lock()
            .unwrap()
            .iter()
            .any(|event| matches!(event, Event::Library(LibraryStatus::Open { .. })))
    );
    let attempt = lock(&f.state.0.state).attempt;
    f.state.retry_status().unwrap();
    assert_eq!(lock(&f.state.0.state).attempt, attempt);
    assert!(Arc::ptr_eq(
        &session,
        lock(&f.state.0.state).session.as_ref().unwrap()
    ));
}

#[test]
fn retry_coalesces_identical_failures_and_does_not_retry_startup() {
    let f = Fixture::new();
    Settings {
        library_root: Some(f.root.clone()),
        ..Settings::default()
    }
    .save(&f.data)
    .unwrap();
    let before = fs::read(f.data.join("settings.json")).unwrap();
    // This call entered before startup was ready, so it must return startup's failure.
    let waiting = f.state.clone();
    let (send, receive) = mpsc::channel();
    let waiter = thread::spawn(move || send.send(waiting.retry_observed(None)).unwrap());
    f.state.initialize();
    let first = receive
        .recv_timeout(Duration::from_secs(3))
        .unwrap()
        .unwrap();
    waiter.join().unwrap();
    assert_eq!(lock(&f.state.0.state).attempt, 0);
    let observed = Some(lock(&f.state.0.state).attempt);
    // Two calls saw this same unavailable generation before either acquired transition.
    assert_eq!(f.state.retry_observed(observed).unwrap(), first);
    assert_eq!(f.state.retry_observed(observed).unwrap(), first);
    assert_eq!(lock(&f.state.0.state).attempt, 1);
    f.state.retry_status().unwrap();
    assert_eq!(lock(&f.state.0.state).attempt, 2);
    assert_eq!(fs::read(f.data.join("settings.json")).unwrap(), before);
    f.state.begin_close();
    assert!(matches!(f.state.retry_status(), Err(AppError::Busy(_))));
    assert!(lock(&f.state.0.state).session.is_none());
}

#[test]
fn retry_none_is_read_unchanged() {
    let f = Fixture::new();
    f.state.initialize();
    assert_eq!(f.state.retry_status().unwrap(), LibraryStatus::None);
    assert_eq!(lock(&f.state.0.state).attempt, 0);
}

#[test]
fn shutdown_drains_an_operation_and_rejects_the_next_one() {
    let f = Fixture::new();
    f.state.initialize();
    let opened = f.create();
    f.done(&opened.scan);
    let active = f.state.clone();
    let closing = f.state.clone();
    let (started, start) = mpsc::channel();
    let (release, released) = mpsc::channel::<()>();
    let command = thread::spawn(move || {
        active.with_operations(|session| {
            session.mutate(|_, _| {
                started.send(()).unwrap();
                released.recv_timeout(Duration::from_secs(3)).unwrap();
                Ok(folio_core::library::operations::Outcome {
                    value: (),
                    committed: folio_core::library::CommittedScan::default(),
                })
            })
        })
    });
    start.recv_timeout(Duration::from_secs(3)).unwrap();
    let (closed, receive) = mpsc::channel();
    let drain = thread::spawn(move || closed.send(closing.shutdown()).unwrap());
    assert!(matches!(
        receive.recv_timeout(Duration::from_millis(40)),
        Err(mpsc::RecvTimeoutError::Timeout)
    ));
    assert!(!f.state.is_closed());
    release.send(()).unwrap();
    command.join().unwrap().unwrap();
    receive
        .recv_timeout(Duration::from_secs(3))
        .unwrap()
        .unwrap();
    drain.join().unwrap();
    assert!(matches!(
        f.state
            .with_operations::<()>(|_| panic!("operation after close")),
        Err(AppError::Busy(_))
    ));
}

/// The reason comes from where opening failed, never from the error code alone.
#[test]
fn startup_reports_why_the_configured_root_is_unavailable_without_replacing_it() {
    /// Makes the configured root inside the fixture's library folder.
    type Configured = fn(&Path) -> PathBuf;
    let cases: [(Configured, Unavailable); 5] = [
        (|root| root.join("missing"), Unavailable::Missing),
        // A file where the library folder was; it used to read as a catalog failure.
        (
            |root| {
                let file = root.join("library.txt");
                fs::write(&file, b"not a folder").unwrap();
                file
            },
            Unavailable::Missing,
        ),
        (Path::to_path_buf, Unavailable::NotALibrary),
        // A damaged library.json; it used to read as a catalog failure.
        (
            |root| {
                core_library(root);
                fs::write(Layout::new(root).library_file(), b"{").unwrap();
                root.to_path_buf()
            },
            Unavailable::NotALibrary,
        ),
        (
            |root| {
                newer_library(root);
                root.to_path_buf()
            },
            Unavailable::NewerFormat,
        ),
    ];
    for (configured, reason) in cases {
        let f = Fixture::new();
        let root = configured(&f.root);
        let library_json = fs::read(Layout::new(&root).library_file()).ok();
        Settings {
            library_root: Some(root.clone()),
            ..Settings::default()
        }
        .save(&f.data)
        .unwrap();
        let settings_before = fs::read(f.data.join("settings.json")).unwrap();
        f.state.initialize();
        assert_eq!(
            f.state.status().unwrap(),
            LibraryStatus::Unavailable {
                root: root.display().to_string(),
                reason
            }
        );
        assert!(matches!(f.state.list_jobs(), Err(AppError::NoLibrary(_))));
        assert_eq!(
            fs::read(f.data.join("settings.json")).unwrap(),
            settings_before
        );
        assert_eq!(
            fs::read(Layout::new(&root).library_file()).ok(),
            library_json
        );
        assert!(
            f.events
                .lock()
                .unwrap()
                .iter()
                .any(|event| matches!(event, Event::Error(_)))
        );
    }
}

#[test]
fn an_incomplete_library_is_reported_and_finished_in_place() {
    let f = Fixture::new();
    f.state.initialize();
    // A creation that stopped before library.json, with the tags it had written.
    let layout = Layout::new(&f.root);
    fs::create_dir(layout.folio_dir()).unwrap();
    let tags = folio_core::meta::TagDefinitions::with_presets(|preset| {
        DisplayName::parse(&format!("Kept {preset:?}")).unwrap()
    });
    layout.write_tags(&tags).unwrap();
    fs::create_dir(f.root.join("Fall")).unwrap();
    fs::write(f.root.join("notes.md"), b"untouched").unwrap();

    let choice = f.state.choose(f.root.clone()).unwrap();
    assert_eq!(
        choice.content,
        FolderContent::Incomplete {
            folders: 1,
            files: 1
        }
    );
    assert!(matches!(
        f.state.open(OpenLibrary {
            folder: f.grant(&f.root)
        }),
        Err(AppError::NotALibrary(_))
    ));

    let opened = f.state.create(request(choice.token)).unwrap();
    assert_eq!(opened.library.name, "Course library");
    assert_eq!(layout.read_tags().unwrap(), Some(tags));
    assert_eq!(fs::read(f.root.join("notes.md")).unwrap(), b"untouched");
    f.done(&opened.scan);
    assert!(matches!(
        f.state.choose(f.root.clone()).unwrap().content,
        FolderContent::Library { .. }
    ));
}

#[test]
fn choosing_classifies_empty_content_existing_and_nested_libraries() {
    let f = Fixture::new();
    f.state.initialize();
    let empty = f.state.choose(f.root.clone()).unwrap();
    assert_eq!(empty.content, FolderContent::Empty);
    assert_eq!(empty.token.len(), 32);
    assert!(
        empty
            .token
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    );

    let child = f.root.join("Fall");
    fs::create_dir(&child).unwrap();
    fs::write(f.root.join("notes.md"), b"untouched").unwrap();
    assert_eq!(
        f.state.choose(f.root.clone()).unwrap().content,
        FolderContent::Folders {
            folders: 1,
            files: 1
        }
    );
    core_library(&f.root);
    let existing = f.state.choose(f.root.clone()).unwrap();
    assert_eq!(
        existing.content,
        FolderContent::Library {
            name: "Existing library".to_owned()
        }
    );
    let nested = f.state.choose(child.clone()).unwrap();
    let root = shown(&f.root.canonicalize().unwrap());
    assert!(!root.starts_with(r"\\?\"), "{root}");
    assert_eq!(nested.content, FolderContent::InsideLibrary { root });
    assert!(matches!(
        f.state.create(request(existing.token)),
        Err(AppError::AlreadyALibrary(_))
    ));
    assert!(matches!(
        f.state.create(request(nested.token)),
        Err(AppError::AlreadyALibrary(_))
    ));
    assert!(!Layout::new(&child).folio_dir().exists());
    assert_eq!(fs::read(f.root.join("notes.md")).unwrap(), b"untouched");
    assert!(matches!(
        f.state.choose(PathBuf::from("relative")),
        Err(AppError::InvalidArgument(_))
    ));
    assert!(matches!(
        f.state.choose(f.root.join("notes.md")),
        Err(AppError::InvalidArgument(_))
    ));
}

#[test]
fn create_validates_all_names_before_writing_and_normalizes_them() {
    let f = Fixture::new();
    f.state.initialize();
    let base = request(f.grant(&f.root));
    for (name, expected) in [
        (" \t ".to_owned(), "NameEmpty"),
        ("x".repeat(129), "NameTooLong"),
        ("bad\nname".to_owned(), "NameInvalidCharacter"),
    ] {
        for field in 0..6 {
            let mut invalid = base.clone();
            match field {
                0 => invalid.name = name.clone(),
                1 => invalid.preset_tags.notes = name.clone(),
                2 => invalid.preset_tags.slides = name.clone(),
                3 => invalid.preset_tags.homework = name.clone(),
                4 => invalid.preset_tags.exam = name.clone(),
                _ => invalid.preset_tags.reference = name.clone(),
            }
            let error = f.state.create(invalid).unwrap_err();
            assert_eq!(serde_json::to_value(error).unwrap()["code"], expected);
            assert!(!Layout::new(&f.root).folio_dir().exists());
            assert!(!f.data.join("settings.json").exists());
        }
    }
    let mut valid = base;
    valid.name = "  Cafe\u{301}  ".to_owned();
    valid.preset_tags.notes = "  No\u{308}tes  ".to_owned();
    valid.preset_tags.reference = "参".repeat(128);
    let opened = f.state.create(valid).unwrap();
    assert_eq!(opened.library.name, "Café");
    let tags = Layout::new(&f.root).read_tags().unwrap().unwrap();
    assert_eq!(tags.tags[&PresetTag::Notes.id()].name.as_str(), "Nötes");
    assert_eq!(tags.tags.len(), 5);
    assert_eq!(
        tags.tags[&PresetTag::Reference.id()].name.as_str(),
        "参".repeat(128)
    );
}

#[test]
fn create_takes_over_files_and_publishes_scan_and_hash_jobs() {
    let f = Fixture::new();
    f.state.initialize();
    fs::create_dir_all(f.root.join("Fall/Math")).unwrap();
    let file = f.root.join("Fall/Math/notes.md");
    fs::write(&file, b"# source content").unwrap();
    let opened = f.create();
    assert!(!opened.scan.is_empty());
    assert!(matches!(
        f.done(&opened.scan).status,
        JobStatus::Done {
            result: JobResult::Scan { .. }
        }
    ));
    f.kind_done(JobKind::Hash);
    assert_eq!(fs::read(&file).unwrap(), b"# source content");
    assert_eq!(
        Settings::load(&f.data).unwrap().library_root,
        Some(f.root.canonicalize().unwrap())
    );
    assert_eq!(
        f.state.status().unwrap(),
        LibraryStatus::Open {
            library: opened.library.clone()
        }
    );
    let events = f.events.lock().unwrap();
    assert!(events.iter().any(|event| matches!(
        event, Event::Library(LibraryStatus::Open { library }) if library.id == opened.library.id
    )));
    assert!(events.iter().any(|event| matches!(
        event, Event::Job(job) if job.id == opened.scan && matches!(job.status, JobStatus::Queued)
    )));
}

#[test]
fn open_requires_live_single_use_folder_choices_and_keeps_rejected_content() {
    let f = Fixture::new();
    f.state.initialize();
    for token in [
        "".to_owned(),
        "0".repeat(32),
        "import:unissued".to_owned(),
        f.root.display().to_string(),
    ] {
        assert!(matches!(
            f.state.create(request(token.clone())),
            Err(AppError::ChoiceExpired(_))
        ));
        assert!(matches!(
            f.state.open(OpenLibrary { folder: token }),
            Err(AppError::ChoiceExpired(_))
        ));
    }
    for create in [false, true] {
        let expired = f.grant(&f.root);
        f.state
            .0
            .choices
            .lock()
            .unwrap()
            .get_mut(&expired)
            .unwrap()
            .chosen = Instant::now() - CHOICE_TTL - Duration::from_secs(1);
        let result = if create {
            f.state.create(request(expired))
        } else {
            f.state.open(OpenLibrary { folder: expired })
        };
        assert!(matches!(result, Err(AppError::ChoiceExpired(_))));
    }
    let nonlibrary = f.grant(&f.root);
    assert!(matches!(
        f.state.open(OpenLibrary {
            folder: nonlibrary.clone()
        }),
        Err(AppError::NotALibrary(_))
    ));
    assert!(matches!(
        f.state.open(OpenLibrary { folder: nonlibrary }),
        Err(AppError::ChoiceExpired(_))
    ));

    let future = f.dir.path().join("future");
    fs::create_dir(&future).unwrap();
    let bytes = newer_library(&future);
    assert!(matches!(
        f.state.open(OpenLibrary {
            folder: f.grant(&future)
        }),
        Err(AppError::NewerFormat(_))
    ));
    assert_eq!(
        fs::read(Layout::new(&future).library_file()).unwrap(),
        bytes
    );

    core_library(&f.root);
    let used = f.grant(&f.root);
    let forgotten = f.grant(&future);
    let opened = f
        .state
        .open(OpenLibrary {
            folder: used.clone(),
        })
        .unwrap();
    assert_eq!(opened.library.name, "Existing library");
    f.done(&opened.scan);
    for token in [used, forgotten] {
        assert!(matches!(
            f.state.create(request(token.clone())),
            Err(AppError::ChoiceExpired(_))
        ));
        assert!(matches!(
            f.state.open(OpenLibrary { folder: token }),
            Err(AppError::ChoiceExpired(_))
        ));
    }
}

#[test]
fn job_commands_expose_progress_and_reject_unknown_finished_or_uncancellable_jobs() {
    let f = Fixture::new();
    f.state.initialize();
    assert!(matches!(f.state.list_jobs(), Err(AppError::NoLibrary(_))));
    assert!(matches!(f.state.rebuild(), Err(AppError::NoLibrary(_))));
    assert!(matches!(
        f.state.cancel(CancelJob {
            job: "unknown".to_owned()
        }),
        Err(AppError::NotFound(_))
    ));
    fs::write(f.root.join("notes.md"), b"notes").unwrap();
    let opened = f.create();
    f.done(&opened.scan);
    f.kind_done(JobKind::Hash);
    let session = f.state.session().unwrap();
    let ticket = session.jobs.queue(JobKind::Import, true).unwrap();
    assert!(session.jobs.start(&ticket).unwrap());
    session.jobs.progress(&ticket, 2, Some(3)).unwrap();
    assert!(f.state.list_jobs().unwrap().iter().any(|job| matches!(
        &job.status, JobStatus::Running { progress }
            if job.id == ticket.id && progress.done == 2 && progress.total == Some(3)
    )));
    f.state
        .cancel(CancelJob {
            job: ticket.id.clone(),
        })
        .unwrap();
    assert!(ticket.cancel.load(Ordering::Acquire));
    session.jobs.finish(&ticket, Ok(None)).unwrap();
    assert!(matches!(
        f.state.cancel(CancelJob {
            job: ticket.id.clone()
        }),
        Err(AppError::NotFound(_))
    ));
    let fixed = session.jobs.queue(JobKind::Import, false).unwrap();
    assert!(matches!(
        f.state.cancel(CancelJob {
            job: fixed.id.clone()
        }),
        Err(AppError::InvalidArgument(_))
    ));
    session
        .jobs
        .finish(&fixed, Err(AppError::Internal("test failure".to_owned())))
        .unwrap();
    assert!(f.events.lock().unwrap().iter().any(|event| matches!(
        event, Event::Job(job) if job.id == ticket.id && matches!(job.status, JobStatus::Cancelled { result: None })
    )));
}

#[test]
fn problem_pages_keep_totals_stable_ids_and_the_catalog_revision() {
    let f = Fixture::new();
    f.state.initialize();
    assert!(matches!(
        f.state.problems(page(0, 0)),
        Err(AppError::NoLibrary(_))
    ));
    assert!(matches!(
        f.state.problems(page(0, 501)),
        Err(AppError::InvalidArgument(_))
    ));
    fs::write(f.root.join("e\u{301}.md"), b"invalid NFC name").unwrap();
    fs::write(f.root.join("notes.md"), b"valid").unwrap();
    let opened = f.create();
    f.done(&opened.scan);
    let first = f.state.problems(page(0, 500)).unwrap();
    assert_eq!(first.total, 1);
    assert!(
        matches!(&first.items[0].problem, Problem::NotNfc { name, .. } if name == "e\u{301}.md")
    );
    let total = f.state.problems(page(0, 0)).unwrap();
    assert!(total.items.is_empty());
    assert_eq!(total.total, first.total);
    assert!(
        f.state
            .problems(page(u32::MAX, 1))
            .unwrap()
            .items
            .is_empty()
    );
    assert_eq!(
        f.state.problems(page(0, 1)).unwrap().items[0].id,
        first.items[0].id
    );
    assert!(
        f.events
            .lock()
            .unwrap()
            .iter()
            .any(|event| matches!(event, Event::Problems(1)))
    );

    fs::write(f.root.join("outside.txt"), b"outside change").unwrap();
    until("outside change to reach the catalog", || {
        f.events
            .lock()
            .unwrap()
            .iter()
            .any(|event| {
                matches!(
                    event, Event::Catalog(change) if change.entries.iter().any(|entry| matches!(
                        entry, EntryChange::Added { entry } if entry.path == "outside.txt"
                    ))
                )
            })
            .then_some(())
    });
    let after = f.state.problems(page(0, 500)).unwrap();
    assert!(after.revision > first.revision);
    assert_eq!(after.items[0].id, first.items[0].id);
    until("page revision to be emitted", || {
        f.events
            .lock()
            .unwrap()
            .iter()
            .any(|event| {
                matches!(
                    event, Event::Catalog(change) if change.revision >= after.revision
                )
            })
            .then_some(())
    });
}

#[test]
fn rebuild_replaces_entry_ids_without_changing_library_metadata_or_file_bytes() {
    let mut f = Fixture::new();
    f.state.initialize();
    let file = f.root.join("notes.md");
    fs::write(&file, b"# must survive rebuild").unwrap();
    let opened = f.create();
    f.done(&opened.scan);
    f.state.shutdown().unwrap();
    let before = f.persisted_entry("notes.md");
    let config = fs::read(Layout::new(&f.root).library_file()).unwrap();
    let tags = fs::read(Layout::new(&f.root).tags_file()).unwrap();
    f.restart();
    f.kind_done(JobKind::Scan);
    let start = f.events.lock().unwrap().len();
    let rebuild = f.state.rebuild().unwrap();
    assert!(matches!(
        f.done(&rebuild).status,
        JobStatus::Done { result: JobResult::Rebuild { entries } } if entries >= 1
    ));
    until("rebuild catalog invalidation", || {
        f.events.lock().unwrap()[start..]
            .iter()
            .any(|event| {
                matches!(
                    event, Event::Catalog(change) if !change.complete
                )
            })
            .then_some(())
    });
    f.state.shutdown().unwrap();
    let after = f.persisted_entry("notes.md");
    assert!(after.id > before.id);
    assert_eq!(fs::read(file).unwrap(), b"# must survive rebuild");
    assert_eq!(
        fs::read(Layout::new(&f.root).library_file()).unwrap(),
        config
    );
    assert_eq!(fs::read(Layout::new(&f.root).tags_file()).unwrap(), tags);
}

#[test]
fn shutdown_drains_work_and_restart_reconciles_changes_made_while_closed() {
    let mut f = Fixture::new();
    f.state.initialize();
    for index in 0..64 {
        fs::write(f.root.join(format!("notes-{index}.md")), b"source").unwrap();
    }
    f.create();
    assert!(f.state.begin_close());
    assert!(!f.state.begin_close());
    f.state.shutdown().unwrap();
    assert!(f.state.is_closed());
    assert!(matches!(
        f.state.choose(f.root.clone()),
        Err(AppError::Busy(_))
    ));
    let count = f.events.lock().unwrap().len();
    fs::write(f.root.join("while-closed.md"), b"created outside Folio").unwrap();
    thread::sleep(Duration::from_millis(100));
    assert_eq!(f.events.lock().unwrap().len(), count);
    assert!(Layout::new(&f.root).read_library().unwrap().is_some());
    assert_eq!(
        Layout::new(&f.root)
            .read_tags()
            .unwrap()
            .unwrap()
            .tags
            .len(),
        5
    );

    // Exercise activation against shutdown without letting the first scan settle.
    for _ in 0..8 {
        f.restart();
        f.state.shutdown().unwrap();
        assert!(f.state.is_closed());
    }
    f.restart();
    assert!(matches!(
        f.state.status().unwrap(),
        LibraryStatus::Open { .. }
    ));
    f.kind_done(JobKind::Scan);
    f.state.shutdown().unwrap();
    assert_eq!(
        f.persisted_entry("while-closed.md").record.size,
        b"created outside Folio".len() as u64
    );
    for index in 0..64 {
        assert_eq!(
            fs::read(f.root.join(format!("notes-{index}.md"))).unwrap(),
            b"source"
        );
    }
}

#[test]
fn a_failed_switch_reopens_the_configured_library() {
    let f = Fixture::new();
    f.state.initialize();
    let opened = f.create();
    f.done(&opened.scan);
    let other = f.dir.path().join("other");
    fs::create_dir(&other).unwrap();
    core_library(&other);
    // A file where the other library's catalog folder belongs makes its session fail to open.
    let id = Layout::new(&other).read_library().unwrap().unwrap().id;
    fs::create_dir_all(f.data.join("libraries")).unwrap();
    fs::write(f.data.join("libraries").join(id.as_str()), b"not a folder").unwrap();
    let settings = fs::read(f.data.join("settings.json")).unwrap();

    assert!(
        f.state
            .open(OpenLibrary {
                folder: f.grant(&other)
            })
            .is_err()
    );
    let LibraryStatus::Open { library } = f.state.status().unwrap() else {
        panic!("the configured library must be open again");
    };
    assert_eq!(library.id, opened.library.id);
    assert!(f.state.list_jobs().is_ok());
    assert_eq!(fs::read(f.data.join("settings.json")).unwrap(), settings);
    assert!(f.events.lock().unwrap().iter().any(|event| matches!(
        event, Event::Library(LibraryStatus::Open { library }) if library.id == opened.library.id
    )));
}

#[test]
fn shutdown_completes_behind_a_poisoned_lock() {
    let f = Fixture::new();
    f.state.initialize();
    f.create();
    let state = f.state.clone();
    thread::spawn(move || {
        let _transition = state.0.transition.lock().unwrap();
        panic!("poison the transition lock");
    })
    .join()
    .unwrap_err();
    assert!(f.state.0.transition.is_poisoned());
    f.state.shutdown().unwrap();
    assert!(f.state.is_closed());
}

#[test]
fn paths_for_the_ui_have_no_verbatim_prefix() {
    for (canonical, shown_as) in [
        (r"\\?\E:\资料\课程", r"E:\资料\课程"),
        (r"\\?\E:\", r"E:\"),
        (r"\\?\UNC\nas\home\资料", r"\\nas\home\资料"),
        (r"C:\plain", r"C:\plain"),
        (r"\\?\Volume{0f1e2d3c}\资料", r"\\?\Volume{0f1e2d3c}\资料"),
    ] {
        assert_eq!(shown(Path::new(canonical)), shown_as);
    }
    let f = Fixture::new();
    f.state.initialize();
    let choice = f.state.choose(f.root.clone()).unwrap();
    let opened = f.state.create(request(choice.token)).unwrap();
    for path in [choice.path, opened.library.root] {
        assert!(!path.starts_with(r"\\?\"), "{path}");
        assert_eq!(
            Path::new(&path).canonicalize().unwrap(),
            f.root.canonicalize().unwrap()
        );
    }
}

fn file_reference(f: &Fixture, path: &str) -> crate::ipc::types::EntryRef {
    until("catalogued file reference", || {
        f.events.lock().unwrap().iter().find_map(|event| {
            if let Event::Catalog(change) = event {
                change.entries.iter().find_map(|change| match change {
                    EntryChange::Added { entry } if entry.path == path => Some(entry.clone()),
                    _ => None,
                })
            } else {
                None
            }
        })
    })
}

#[test]
fn file_actions_use_the_current_catalog_pair_and_hold_shutdown_until_they_return() {
    use crate::ipc::types::EntryRef;
    let f = Fixture::new();
    f.state.initialize();
    fs::write(f.root.join("notes.txt"), b"catalogued bytes").unwrap();
    let opened = f.create();
    f.done(&opened.scan);
    let reference = file_reference(&f, "notes.txt");
    assert_eq!(
        f.state
            .with_entry(&reference, |root, entry| {
                assert_eq!(root, f.root.canonicalize().unwrap());
                let pinned = crate::open::PinnedEntry::resolve(root, entry)?;
                assert_eq!(entry.record.file_id, Some(pinned.file_id()));
                Ok(entry.record.path.to_string())
            })
            .unwrap(),
        "notes.txt"
    );
    for (id, path, invalid) in [
        ("999999", "notes.txt", false),
        (reference.id.as_str(), "wrong.txt", false),
        (reference.id.as_str(), ".folio/library.json", false),
        ("-1", "notes.txt", true),
        (reference.id.as_str(), "../outside", true),
    ] {
        let result: Result<(), AppError> = f.state.with_entry(
            &EntryRef {
                id: id.into(),
                path: path.into(),
            },
            |_, _| panic!("a rejected reference reached a file action"),
        );
        if invalid {
            assert!(matches!(result, Err(AppError::InvalidArgument(_))));
        } else {
            assert!(matches!(result, Err(AppError::NotFound(_))));
        }
    }
    let active = f.state.clone();
    let closing = f.state.clone();
    let (started, start) = mpsc::channel();
    let (release, released) = mpsc::channel::<()>();
    let action = thread::spawn(move || {
        active.with_entry(&reference, |_, _| {
            started.send(()).unwrap();
            released.recv_timeout(Duration::from_secs(3)).unwrap();
            Ok(())
        })
    });
    start.recv_timeout(Duration::from_secs(3)).unwrap();
    let (closed, receive) = mpsc::channel();
    let shutdown = thread::spawn(move || closed.send(closing.shutdown()).unwrap());
    assert!(matches!(
        receive.recv_timeout(Duration::from_millis(30)),
        Err(mpsc::RecvTimeoutError::Timeout)
    ));
    assert!(!f.state.is_closed());
    release.send(()).unwrap();
    action.join().unwrap().unwrap();
    receive
        .recv_timeout(Duration::from_secs(3))
        .unwrap()
        .unwrap();
    shutdown.join().unwrap();
    assert!(f.state.is_closed());
}

#[test]
fn scheme_checks_catalog_before_disk_and_reports_real_lock_and_offline_failures() {
    use crate::file_scheme;
    use crate::ipc::entries::FILE_ERROR_HEADER;
    use crate::open::tests::set_offline;
    use std::os::windows::fs::OpenOptionsExt;
    let f = Fixture::new();
    f.state.initialize();
    let path = f.root.join("notes.txt");
    fs::write(&path, b"0123456789").unwrap();
    let opened = f.create();
    f.done(&opened.scan);
    let reference = file_reference(&f, "notes.txt");
    let cache = crate::thumbnail::Cache::new(Ok(f.data.join("cache/thumbnails")));
    let req = |id: &str, path: &str| {
        tauri::http::Request::builder()
            .uri(format!("http://folio-file.localhost/content/{id}/{path}"))
            .body(Vec::new())
            .unwrap()
    };
    let (response, error) =
        file_scheme::respond(&f.state, &cache, &req(&reference.id, &reference.path));
    assert!(error.is_none(), "{error:?}");
    assert_eq!(response.body(), b"0123456789");
    for path in ["wrong.txt", ".folio/library.json"] {
        let (response, _) = file_scheme::respond(&f.state, &cache, &req(&reference.id, path));
        assert_eq!(response.headers()[FILE_ERROR_HEADER], "NotFound");
        assert!(response.body().is_empty());
    }
    let held = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .share_mode(0)
        .open(&path)
        .unwrap();
    let (response, _) =
        file_scheme::respond(&f.state, &cache, &req(&reference.id, &reference.path));
    assert_eq!(response.status().as_u16(), 409);
    assert_eq!(response.headers()[FILE_ERROR_HEADER], "InUse");
    drop(held);
    set_offline(&path, true);
    let (response, _) =
        file_scheme::respond(&f.state, &cache, &req(&reference.id, &reference.path));
    assert_eq!(response.headers()[FILE_ERROR_HEADER], "NotLocal");
    assert!(response.body().is_empty());
    set_offline(&path, false);
    fs::remove_file(&path).unwrap();
    let (response, _) =
        file_scheme::respond(&f.state, &cache, &req(&reference.id, &reference.path));
    assert_eq!(response.headers()[FILE_ERROR_HEADER], "NotFound");
}

/// The intent of a file move that stopped before the file moved, naming a catalog identity the
/// catalog does not hold (as after a rebuild), so recovery cannot reconcile it.
const UNFINISHED_MOVE: &[u8] = br#"{"format_version":3,"id":"interrupted","before":[],"after":[],
"intent":{"from":"s/a.md","to":"s/b.md","entries":[{"id":999999,"from":"s/a.md","to":"s/b.md",
"kind":"file","class":"text","size":0,"mtime_ns":null,"file_id":null,"hash":null,"added_ns":1,
"disk":{"size":0,"modified_ns":null,"created_ns":null,"file_id":null}}]}}"#;

/// A library holding `s/a.md`, restarted with `journal` left in `.folio/local/journal/`.
fn restart_with_journal(journal: &[u8]) -> Fixture {
    let mut f = Fixture::new();
    f.state.initialize();
    fs::create_dir(f.root.join("s")).unwrap();
    fs::write(f.root.join("s/a.md"), b"the user's file").unwrap();
    let opened = f.create();
    f.done(&opened.scan);
    f.state.shutdown().unwrap();
    let file = Layout::new(&f.root).scan_journal_file();
    fs::create_dir_all(file.parent().unwrap()).unwrap();
    fs::write(&file, journal).unwrap();
    f.restart();
    f
}

fn unavailable_for(f: &Fixture, reason: Unavailable) -> LibraryStatus {
    until("the library to become unavailable", || {
        let status = f.state.status().unwrap();
        matches!(&status, LibraryStatus::Unavailable { reason: found, .. } if *found == reason)
            .then_some(status)
    })
}

#[test]
fn an_unfinished_move_has_its_own_reason_and_discarding_it_reopens_the_library() {
    use std::os::windows::fs::OpenOptionsExt;
    use windows_sys::Win32::Storage::FileSystem::{FILE_SHARE_READ, FILE_SHARE_WRITE};
    let f = restart_with_journal(UNFINISHED_MOVE);
    let journal = Layout::new(&f.root).scan_journal_file();
    let settings = fs::read(f.data.join("settings.json")).unwrap();
    let status = unavailable_for(&f, Unavailable::UnfinishedMove);
    assert!(
        f.events
            .lock()
            .unwrap()
            .iter()
            .any(|event| matches!(event, Event::Library(sent) if *sent == status))
    );
    assert_eq!(fs::read(&journal).unwrap(), UNFINISHED_MOVE);
    assert!(matches!(f.state.list_jobs(), Err(AppError::NoLibrary(_))));

    // Discarding stops halfway: the move, the status and the session stay for another try.
    let held = fs::OpenOptions::new()
        .read(true)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
        .open(&journal)
        .unwrap();
    assert!(matches!(
        f.state.discard_unfinished_move(),
        Err(AppError::InUse(_))
    ));
    drop(held);
    assert_eq!(f.state.status().unwrap(), status);
    assert_eq!(fs::read(&journal).unwrap(), UNFINISHED_MOVE);
    assert!(lock(&f.state.0.state).session.is_some());

    let attempt = lock(&f.state.0.state).attempt;
    let opened = f.state.discard_unfinished_move().unwrap();
    assert!(matches!(opened, LibraryStatus::Open { .. }), "{opened:?}");
    assert!(lock(&f.state.0.state).attempt != attempt);
    assert!(!journal.exists());
    assert_eq!(fs::read(f.data.join("settings.json")).unwrap(), settings);
    assert_eq!(fs::read(f.root.join("s/a.md")).unwrap(), b"the user's file");
    let session = lock(&f.state.0.state).session.clone().unwrap();
    f.done(&session.opened().scan);
    let entry = f
        .state
        .read_catalog(|catalog| {
            catalog
                .read(|tx| catalog::entry(tx, &RelPath::parse("s/a.md").unwrap()))
                .map_err(catalog_error)
        })
        .unwrap();
    assert!(entry.is_some());
    assert!(f.events.lock().unwrap().iter().any(|event| matches!(
        event,
        Event::Error(record) if record.starts_with("discarded an unfinished move from s/a.md to s/b.md")
    )));

    // A second call finds the library open and changes nothing.
    let attempt = lock(&f.state.0.state).attempt;
    assert_eq!(f.state.discard_unfinished_move().unwrap(), opened);
    assert_eq!(lock(&f.state.0.state).attempt, attempt);
    assert!(Arc::ptr_eq(
        &session,
        lock(&f.state.0.state).session.as_ref().unwrap()
    ));
}

#[test]
fn discarding_answers_any_other_status_as_it_is_and_keeps_a_damaged_journal() {
    let f = Fixture::new();
    f.state.initialize();
    assert_eq!(
        f.state.discard_unfinished_move().unwrap(),
        LibraryStatus::None
    );

    // A journal that cannot be read is no move to let go of.
    let damaged = br#"{"format_version":3,"id":"damaged","before":[["../other.json",null]],"after":[["../other.json",null]]}"#;
    let f = restart_with_journal(damaged);
    let status = unavailable_for(&f, Unavailable::CatalogFailed);
    let attempt = lock(&f.state.0.state).attempt;
    assert_eq!(f.state.discard_unfinished_move().unwrap(), status);
    assert_eq!(lock(&f.state.0.state).attempt, attempt);
    assert_eq!(
        fs::read(Layout::new(&f.root).scan_journal_file()).unwrap(),
        damaged
    );

    let f = Fixture::new();
    Settings {
        library_root: Some(f.root.join("gone")),
        ..Settings::default()
    }
    .save(&f.data)
    .unwrap();
    f.state.initialize();
    let missing = f.state.status().unwrap();
    assert!(matches!(
        missing,
        LibraryStatus::Unavailable {
            reason: Unavailable::Missing,
            ..
        }
    ));
    assert_eq!(f.state.discard_unfinished_move().unwrap(), missing);
    assert_eq!(lock(&f.state.0.state).attempt, 0);

    f.state.begin_close();
    assert!(matches!(
        f.state.discard_unfinished_move(),
        Err(AppError::Busy(_))
    ));
}

#[test]
fn discard_requests_observed_before_an_unfinished_session_do_not_touch_it() {
    let f = restart_with_journal(UNFINISHED_MOVE);
    let status = unavailable_for(&f, Unavailable::UnfinishedMove);
    let attempt = lock(&f.state.0.state).attempt;
    let session = lock(&f.state.0.state).session.clone().unwrap();
    for observed in [None, Some(attempt.wrapping_sub(1))] {
        assert_eq!(f.state.discard_observed(observed).unwrap(), status);
        assert_eq!(lock(&f.state.0.state).attempt, attempt);
        assert!(Arc::ptr_eq(
            &session,
            lock(&f.state.0.state).session.as_ref().unwrap()
        ));
        assert_eq!(
            fs::read(Layout::new(&f.root).scan_journal_file()).unwrap(),
            UNFINISHED_MOVE
        );
    }
}

#[test]
fn discarding_revalidates_a_record_changed_since_recovery_and_preserves_the_error_state() {
    let f = restart_with_journal(UNFINISHED_MOVE);
    let status = unavailable_for(&f, Unavailable::UnfinishedMove);
    let journal = Layout::new(&f.root).scan_journal_file();
    let outside = f.dir.path().join("outside.json");
    fs::write(&outside, b"outside sentinel").unwrap();
    let malformed = br#"{"format_version":3,"id":"tampered","before":[["../../outside.json","changed"]],"after":[["../../outside.json","changed"]]}"#;
    fs::write(&journal, malformed).unwrap();
    assert!(matches!(
        f.state.discard_unfinished_move(),
        Err(AppError::Internal(_))
    ));
    assert_eq!(f.state.status().unwrap(), status);
    assert_eq!(fs::read(&journal).unwrap(), malformed);
    assert_eq!(fs::read(&outside).unwrap(), b"outside sentinel");
    assert!(lock(&f.state.0.state).session.is_some());
}

#[test]
fn discarding_a_record_replaced_with_a_newer_format_keeps_it_and_its_status() {
    let f = restart_with_journal(UNFINISHED_MOVE);
    let status = unavailable_for(&f, Unavailable::UnfinishedMove);
    let journal = Layout::new(&f.root).scan_journal_file();
    let newer = br#"{"format_version":4,"id":"newer","before":[]}"#;
    fs::write(&journal, newer).unwrap();
    assert!(matches!(
        f.state.discard_unfinished_move(),
        Err(AppError::NewerFormat(_))
    ));
    assert_eq!(f.state.status().unwrap(), status);
    assert_eq!(fs::read(&journal).unwrap(), newer);
    assert!(lock(&f.state.0.state).session.is_some());
}

/// Writes `bytes` to `path` and dates the file an hour back, so the hash job takes it at once
/// instead of waiting for a file that was just written to settle.
pub(super) fn settled(path: &Path, bytes: &[u8]) {
    fs::write(path, bytes).unwrap();
    fs::File::options()
        .write(true)
        .open(path)
        .unwrap()
        .set_modified(std::time::SystemTime::now() - Duration::from_secs(3600))
        .unwrap();
}

/// What search finds for `text`: each hit's path and the matched text of its body snippet,
/// joined by `|`, if its body matched.
fn found(f: &Fixture, text: &str) -> Vec<(String, Option<String>)> {
    let query = folio_core::search::SearchQuery::parse(text)
        .unwrap()
        .unwrap();
    f.state
        .read_catalog(|catalog| {
            catalog
                .read(|tx| {
                    let mut found = Vec::new();
                    for hit in catalog::search(tx, &query, 10, 0)? {
                        let snippet = catalog::hit_text(tx, &query, hit.entry.id)?
                            .and_then(|text| text.snippet)
                            .map(|spans| {
                                let matched = spans.into_iter().filter(|span| span.matched);
                                matched.map(|span| span.text).collect::<Vec<_>>().join("|")
                            });
                        found.push((hit.entry.record.path.as_str().to_owned(), snippet));
                    }
                    Ok(found)
                })
                .map_err(catalog_error)
        })
        .unwrap()
}

/// A Word document with these paragraphs, as a ZIP archive of stored parts (the shell has no ZIP
/// writer; the core's tests build documents with `zip`).
fn docx(paragraphs: &[&str]) -> Vec<u8> {
    let body: String = paragraphs
        .iter()
        .map(|text| format!("<w:p><w:r><w:t>{text}</w:t></w:r></w:p>"))
        .collect();
    stored_zip(&[
        (
            "[Content_Types].xml",
            r#"<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>"#.to_owned(),
        ),
        (
            "_rels/.rels",
            r#"<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>"#.to_owned(),
        ),
        (
            "word/document.xml",
            format!(
                r#"<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>{body}</w:body></w:document>"#
            ),
        ),
    ])
}

/// A ZIP archive of `parts`, stored (not compressed), with ASCII names.
fn stored_zip(parts: &[(&str, String)]) -> Vec<u8> {
    let mut archive = Vec::new();
    let mut directory = Vec::new();
    for (name, content) in parts {
        let offset = u32::try_from(archive.len()).unwrap();
        // From "version needed" to the extra field's length, the same in both headers: version
        // 2.0, no flags, stored, 2026-10-06 00:00, the CRC-32 and both sizes, no extra field.
        let mut fields = Vec::new();
        for value in [20_u16, 0, 0, 0, (46 << 9) | (10 << 5) | 6] {
            fields.extend(value.to_le_bytes());
        }
        let size = u32::try_from(content.len()).unwrap();
        for value in [crc32(content.as_bytes()), size, size] {
            fields.extend(value.to_le_bytes());
        }
        fields.extend(u16::try_from(name.len()).unwrap().to_le_bytes());
        fields.extend(0_u16.to_le_bytes());
        archive.extend(0x0403_4b50_u32.to_le_bytes());
        archive.extend(&fields);
        archive.extend(name.as_bytes());
        archive.extend(content.as_bytes());
        directory.extend(0x0201_4b50_u32.to_le_bytes());
        directory.extend(20_u16.to_le_bytes());
        directory.extend(&fields);
        // No comment, disk 0, no attributes; then where the local header starts.
        directory.extend([0; 10]);
        directory.extend(offset.to_le_bytes());
        directory.extend(name.as_bytes());
    }
    let start = u32::try_from(archive.len()).unwrap();
    let entries = u16::try_from(parts.len()).unwrap();
    let length = u32::try_from(directory.len()).unwrap();
    archive.extend(directory);
    archive.extend(0x0605_4b50_u32.to_le_bytes());
    archive.extend([0; 4]);
    archive.extend(entries.to_le_bytes());
    archive.extend(entries.to_le_bytes());
    archive.extend(length.to_le_bytes());
    archive.extend(start.to_le_bytes());
    archive.extend([0; 2]);
    archive
}

fn crc32(bytes: &[u8]) -> u32 {
    let mut crc = u32::MAX;
    for &byte in bytes {
        crc ^= u32::from(byte);
        for _ in 0..8 {
            crc = (crc >> 1) ^ (0xEDB8_8320 & (crc & 1).wrapping_neg());
        }
    }
    !crc
}

#[test]
fn a_new_library_finds_markdown_by_its_text_once_its_hash_job_is_done() {
    let f = Fixture::new();
    f.state.initialize();
    fs::create_dir_all(f.root.join("Fall/Math")).unwrap();
    settled(
        &f.root.join("Fall/Math/notes.md"),
        "# 第三周\n\nThe eigenvalues of a symmetric matrix are real.\n".as_bytes(),
    );
    let opened = f.create();
    f.done(&opened.scan);
    // Extraction runs inside the hash job: its body is there when the job is done.
    f.kind_done(JobKind::Hash);
    assert_eq!(
        found(&f, "eigenvalues"),
        [(
            "Fall/Math/notes.md".to_owned(),
            Some("eigenvalues".to_owned())
        )]
    );
    assert_eq!(found(&f, "三周").len(), 1);
    assert_eq!(f.state.problems(page(0, 500)).unwrap().total, 0);
}

#[test]
fn a_damaged_word_document_is_a_problem_until_it_is_repaired() {
    let f = Fixture::new();
    f.state.initialize();
    fs::create_dir_all(f.root.join("Fall/Math")).unwrap();
    let report = f.root.join("Fall/Math/report.docx");
    settled(&report, b"not really a document");
    let opened = f.create();
    f.done(&opened.scan);
    f.kind_done(JobKind::Hash);
    let problems = f.state.problems(page(0, 500)).unwrap();
    assert_eq!(
        problems
            .items
            .iter()
            .map(|item| &item.problem)
            .collect::<Vec<_>>(),
        [&Problem::Unreadable {
            path: "Fall/Math/report.docx".to_owned(),
            failure: ReadFailure::Damaged,
        }]
    );
    assert!(
        f.events
            .lock()
            .unwrap()
            .iter()
            .any(|event| matches!(event, Event::Problems(1)))
    );

    // The same document repaired: the scan sees new content, and the hash job reads it.
    settled(
        &report,
        &docx(&[
            "Spectral theorem",
            "Every symmetric matrix is diagonalizable.",
        ]),
    );
    until("the repaired document's text", || {
        (f.state.problems(page(0, 500)).unwrap().total == 0
            && !found(&f, "diagonalizable").is_empty())
        .then_some(())
    });
    assert_eq!(
        found(&f, "diagonalizable"),
        [(
            "Fall/Math/report.docx".to_owned(),
            Some("diagonalizable".to_owned())
        )]
    );
    assert!(
        f.events
            .lock()
            .unwrap()
            .iter()
            .any(|event| matches!(event, Event::Problems(0)))
    );
}
