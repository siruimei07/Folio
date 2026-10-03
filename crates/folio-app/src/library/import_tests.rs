//! Import command contracts against disposable sources and libraries.

use std::fs;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use folio_core::library::state::{self, Settings};
use folio_core::meta::DisplayName;
use tempfile::TempDir;

use super::*;
use crate::ipc::groups::{CreateCourse, CreateSemester};
use crate::ipc::jobs::{Job, JobKind, JobResult, JobStatus};
use crate::ipc::library::{CreateLibrary, PresetTagNames};
use crate::ipc::types::{EntryKind, EntryRef};

struct Fixture {
    dir: TempDir,
    root: PathBuf,
    state: LibraryState,
    target: EntryRef,
    events: Arc<Mutex<Vec<Event>>>,
}

impl Fixture {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("library");
        let data = dir.path().join("data");
        fs::create_dir(&root).unwrap();
        state::create(
            &root,
            DisplayName::parse("Import tests").unwrap(),
            ["Notes", "Slides", "Homework", "Exam", "Reference"]
                .map(|text| DisplayName::parse(text).unwrap()),
        )
        .unwrap();
        Settings {
            library_root: Some(root.clone()),
            ..Settings::default()
        }
        .save(&data)
        .unwrap();
        let events = Arc::new(Mutex::new(Vec::new()));
        let capture = events.clone();
        let state = LibraryState::new(Ok(data), Arc::new(move |event| lock(&capture).push(event)));
        state.initialize();
        wait(|| {
            state
                .list_jobs()
                .unwrap()
                .iter()
                .all(|job| !matches!(job.status, JobStatus::Queued | JobStatus::Running { .. }))
        });
        let semester = state
            .create_semester(CreateSemester {
                name: "Fall".into(),
            })
            .unwrap();
        let target = state
            .create_course(CreateCourse {
                semester: semester.folder,
                name: "Course".into(),
                abbr: None,
                code: None,
                color: None,
            })
            .unwrap()
            .folder;
        Self {
            dir,
            root,
            state,
            target,
            events,
        }
    }

    fn source(&self, name: &str) -> PathBuf {
        let source = self.dir.path().join(name);
        fs::write(&source, b"verified source bytes").unwrap();
        source
    }

    fn check(&self, token: &str) -> CheckImport {
        CheckImport {
            source: token.into(),
            target: self.target.clone(),
        }
    }

    fn import(&self, token: &str) -> ImportFiles {
        ImportFiles {
            source: token.into(),
            target: self.target.clone(),
            tags: vec!["notes".into()],
            on_conflict: ConflictPolicy::KeepBoth,
            delete_originals: false,
        }
    }

    fn finished(&self, id: &str) -> Job {
        let mut found = None;
        wait(|| {
            found = self.state.list_jobs().unwrap().into_iter().find(|job| {
                job.id == id && !matches!(job.status, JobStatus::Queued | JobStatus::Running { .. })
            });
            found.is_some()
        });
        found.unwrap()
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        self.state.shutdown().unwrap();
    }
}

fn wait(mut done: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(20);
    while !done() {
        assert!(Instant::now() < deadline, "import worker timed out");
        thread::sleep(Duration::from_millis(10));
    }
}

#[test]
fn core_import_entry_kinds_preserve_the_ipc_discriminants() {
    for (core, expected, encoded) in [
        (
            folio_core::meta::EntryKind::File,
            EntryKind::File,
            "\"file\"",
        ),
        (
            folio_core::meta::EntryKind::Folder,
            EntryKind::Folder,
            "\"folder\"",
        ),
    ] {
        let actual = EntryKind::from(core);
        assert_eq!(actual, expected);
        assert_eq!(serde_json::to_string(&actual).unwrap(), encoded);
    }
}

#[test]
fn sources_include_folder_flags_and_only_the_first_ten_display_names() {
    let f = Fixture::new();
    let folder = f.dir.path().join("folder");
    fs::create_dir(&folder).unwrap();
    let mut paths = vec![folder];
    paths.extend((0..12).map(|index| f.source(&format!("{index}.txt"))));
    let source = f.state.choose_import(paths).unwrap();
    assert_eq!(
        (source.files, source.folders, source.names.len()),
        (12, 1, 10)
    );
    assert_eq!(source.names[0].kind, EntryKind::Folder);
    assert!(
        source.names[1..]
            .iter()
            .all(|item| item.kind == EntryKind::File)
    );
    assert_eq!(source.token.len(), 32);
    assert!(
        source
            .token
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    );
    assert!(f.state.choose_import(Vec::new()).is_err());
}

#[test]
fn checks_are_repeatable_but_successfully_queued_imports_consume_the_token() {
    let f = Fixture::new();
    let source = f
        .state
        .choose_import(vec![f.source("lecture.txt")])
        .unwrap();
    for _ in 0..2 {
        let check = f.state.check_import(f.check(&source.token)).unwrap();
        assert_eq!(
            (check.files, check.folders, check.bytes.as_str()),
            (1, 0, "21")
        );
    }
    let id = f.state.import_files(f.import(&source.token)).unwrap();
    let job = f.finished(&id);
    let JobStatus::Done {
        result: JobResult::Import(result),
    } = job.status
    else {
        panic!("{job:?}");
    };
    assert_eq!(
        (
            result.imported,
            result.replaced,
            result.renamed,
            result.failure_count
        ),
        (1, 0, 0, 0)
    );
    assert_eq!(
        fs::read(f.root.join("Fall/Course/lecture.txt")).unwrap(),
        b"verified source bytes"
    );
    assert!(f.dir.path().join("lecture.txt").exists());
    assert!(matches!(
        f.state.check_import(f.check(&source.token)),
        Err(AppError::ChoiceExpired(_))
    ));
    assert!(matches!(
        f.state.import_files(f.import(&source.token)),
        Err(AppError::ChoiceExpired(_))
    ));
    wait(|| {
        lock(&f.events).iter().any(|event| matches!(event, Event::Catalog(event) if event.entries.iter().any(|entry| matches!(entry, crate::ipc::events::EntryChange::Added { entry } if entry.path == "Fall/Course/lecture.txt"))))
    });
}

#[test]
fn concurrent_claims_use_one_token_once_and_busy_rejection_preserves_it() {
    let f = Fixture::new();
    let source = f
        .state
        .choose_import(vec![f.source("single-use.txt")])
        .unwrap();
    let session = f.state.session().unwrap();
    let rebuild = session.jobs.queue(JobKind::Rebuild, true).unwrap();
    assert!(matches!(
        f.state.import_files(f.import(&source.token)),
        Err(AppError::Busy(_))
    ));
    assert!(f.state.check_import(f.check(&source.token)).is_ok());
    session.jobs.cancel(&rebuild.id).unwrap();
    let barrier = std::sync::Barrier::new(2);
    let request = f.import(&source.token);
    let results = thread::scope(|scope| {
        let run = || {
            barrier.wait();
            f.state.import_files(request.clone())
        };
        let first = scope.spawn(run);
        let second = scope.spawn(run);
        [first.join().unwrap(), second.join().unwrap()]
    });
    assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
    assert_eq!(
        results
            .iter()
            .filter(|result| matches!(result, Err(AppError::ChoiceExpired(_))))
            .count(),
        1
    );
    let id = results.into_iter().find_map(Result::ok).unwrap();
    assert!(matches!(
        f.finished(&id).status,
        JobStatus::Done {
            result: JobResult::Import(_)
        }
    ));
}

#[test]
fn choices_expire_keep_to_their_kind_and_reject_arbitrary_page_paths() {
    let f = Fixture::new();
    let source = f.state.choose_import(vec![f.source("choice.txt")]).unwrap();
    lock(&f.state.0.import_choices)
        .get_mut(&source.token)
        .unwrap()
        .chosen = Instant::now() - CHOICE_TTL;
    assert!(matches!(
        f.state.check_import(f.check(&source.token)),
        Err(AppError::ChoiceExpired(_))
    ));
    assert!(matches!(
        f.state.import_files(f.import(&source.token)),
        Err(AppError::ChoiceExpired(_))
    ));
    let other = f.dir.path().join("other");
    fs::create_dir(&other).unwrap();
    let folder_token = f.state.choose(other).unwrap().token;
    for token in [
        folder_token,
        f.dir.path().join("choice.txt").display().to_string(),
        "invented".into(),
    ] {
        assert!(matches!(
            f.state.check_import(f.check(&token)),
            Err(AppError::ChoiceExpired(_))
        ));
        assert!(matches!(
            f.state.import_files(f.import(&token)),
            Err(AppError::ChoiceExpired(_))
        ));
    }
}

#[test]
fn rejected_targets_and_tags_preserve_the_selection_and_write_nothing() {
    let f = Fixture::new();
    let source = f.state.choose_import(vec![f.source("safe.txt")]).unwrap();
    let mut stale = f.import(&source.token);
    stale.target.path = "Fall/elsewhere".into();
    assert!(matches!(
        f.state.import_files(stale),
        Err(AppError::NotFound(_))
    ));
    let mut invalid = f.import(&source.token);
    invalid.target.path = ".folio/library.json".into();
    assert!(matches!(
        f.state.import_files(invalid),
        Err(AppError::NotFound(_))
    ));
    for tag in ["unknown", "../invalid"] {
        let mut request = f.import(&source.token);
        request.tags = vec![tag.into()];
        assert!(matches!(
            f.state.import_files(request),
            Err(AppError::NotFound(_) | AppError::InvalidArgument(_))
        ));
    }
    assert!(!f.root.join("Fall/Course/safe.txt").exists());
    assert!(f.state.check_import(f.check(&source.token)).is_ok());
}

#[test]
fn a_library_switch_forgets_all_import_choices() {
    let f = Fixture::new();
    let source = f.state.choose_import(vec![f.source("switch.txt")]).unwrap();
    let other = f.dir.path().join("new-library");
    fs::create_dir(&other).unwrap();
    let folder = f.state.choose(other).unwrap();
    f.state
        .create(CreateLibrary {
            folder: folder.token,
            name: "Other".into(),
            preset_tags: PresetTagNames {
                notes: "Notes".into(),
                slides: "Slides".into(),
                homework: "Homework".into(),
                exam: "Exam".into(),
                reference: "Reference".into(),
            },
        })
        .unwrap();
    wait(|| {
        !f.state.list_jobs().unwrap().iter().any(|job| {
            job.kind == JobKind::Scan
                && matches!(job.status, JobStatus::Queued | JobStatus::Running { .. })
        })
    });
    assert!(matches!(
        f.state.check_import(f.check(&source.token)),
        Err(AppError::ChoiceExpired(_))
    ));
}

#[test]
fn native_hover_positions_are_css_pixels_and_end_without_granting_paths() {
    let f = Fixture::new();
    f.state.native_drop(
        &tauri::DragDropEvent::Enter {
            paths: vec![f.source("native.txt")],
            position: tauri::PhysicalPosition::new(120.0, 80.0),
        },
        2.0,
    );
    f.state.native_drop(&tauri::DragDropEvent::Leave, 2.0);
    let events = lock(&f.events);
    assert!(events.iter().any(|event| matches!(event, Event::DropHover(event) if event.position == Some(Point { x: 60, y: 40 }))));
    assert!(
        events
            .iter()
            .any(|event| matches!(event, Event::DropHover(event) if event.position.is_none()))
    );
    assert!(lock(&f.state.0.import_choices).is_empty());
    assert!(
        !events
            .iter()
            .any(|event| matches!(event, Event::FilesDropped(_)))
    );
}

#[test]
fn a_native_drop_issues_a_choice_without_paths_in_the_typed_event() {
    let f = Fixture::new();
    f.state.native_drop(
        &tauri::DragDropEvent::Drop {
            paths: vec![f.source("dropped.txt")],
            position: tauri::PhysicalPosition::new(20.0, 10.0),
        },
        1.0,
    );
    wait(|| {
        lock(&f.events)
            .iter()
            .any(|event| matches!(event, Event::FilesDropped(_)))
    });
    let events = lock(&f.events);
    let source = events
        .iter()
        .find_map(|event| match event {
            Event::FilesDropped(event) => Some(event.clone()),
            _ => None,
        })
        .unwrap();
    drop(events);
    let serialized = serde_json::to_string(&source).unwrap();
    assert!(!serialized.contains(&f.dir.path().to_string_lossy().replace('\\', "\\\\")));
    assert_eq!(source.source.names[0].name, "dropped.txt");
    assert_eq!(source.position, Point { x: 20, y: 10 });
    assert!(f.state.check_import(f.check(&source.source.token)).is_ok());
}

#[test]
fn a_rejected_native_drop_tells_the_page_why_without_a_choice() {
    let f = Fixture::new();
    f.state.native_drop(
        &tauri::DragDropEvent::Drop {
            paths: vec![f.dir.path().join("missing.txt")],
            position: tauri::PhysicalPosition::new(20.0, 10.0),
        },
        1.0,
    );
    wait(|| {
        lock(&f.events)
            .iter()
            .any(|event| matches!(event, Event::DropFailed(_)))
    });
    let events = lock(&f.events);
    let failed = events
        .iter()
        .find_map(|event| match event {
            Event::DropFailed(event) => Some(event.clone()),
            _ => None,
        })
        .unwrap();
    assert!(
        !events
            .iter()
            .any(|event| matches!(event, Event::FilesDropped(_)))
    );
    drop(events);
    let serialized = serde_json::to_string(&failed).unwrap();
    assert!(!serialized.contains(&f.dir.path().to_string_lossy().replace('\\', "\\\\")));
    assert!(lock(&f.state.0.import_choices).is_empty());
}
