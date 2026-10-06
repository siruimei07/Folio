//! Command contracts against disposable libraries; no test touches the Windows Recycle Bin.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use folio_core::library::state::{self, Settings};
use folio_core::meta::{DisplayName, Layout};
use folio_core::recycle::{RecycleError, RecycleFailure, Recycled};
use tempfile::TempDir;

use super::*;
use crate::ipc::events::EntryChange;
use crate::ipc::jobs::JobStatus;
use crate::library::{Event, lock};

struct Fixture {
    state: LibraryState,
    events: Arc<Mutex<Vec<Event>>>,
    root: PathBuf,
    _dir: TempDir,
}

impl Fixture {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("library");
        let data = dir.path().join("data");
        fs::create_dir(&root).unwrap();
        fs::create_dir(&data).unwrap();
        state::create(
            &root,
            DisplayName::parse("Test library").unwrap(),
            ["Notes", "Slides", "Homework", "Exam", "Reference"]
                .map(|name| DisplayName::parse(name).unwrap()),
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
        let state = LibraryState::new(
            Ok(data),
            Arc::new(move |event| capture.lock().unwrap().push(event)),
        );
        state.initialize();
        wait(|| {
            state
                .list_jobs()
                .unwrap()
                .iter()
                .all(|job| !matches!(job.status, JobStatus::Queued | JobStatus::Running { .. }))
        });
        Self {
            state,
            events,
            root,
            _dir: dir,
        }
    }

    fn semester(&self, name: &str) -> Semester {
        self.state
            .create_semester(CreateSemester { name: name.into() })
            .unwrap()
    }

    fn course(&self, semester: &Semester, name: &str) -> Course {
        self.state
            .create_course(CreateCourse {
                semester: semester.folder.clone(),
                name: name.into(),
                abbr: None,
                code: None,
                color: None,
            })
            .unwrap()
    }

    fn catalog_event(&self, matches: impl Fn(&crate::ipc::events::CatalogChanged) -> bool) {
        wait(|| {
            lock(&self.events).iter().any(|event| match event {
                Event::Catalog(change) => change.revision > 0 && matches(change),
                _ => false,
            })
        });
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

fn wait(mut done: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(15);
    while !done() {
        assert!(Instant::now() < deadline, "operation contract timed out");
        thread::sleep(Duration::from_millis(20));
    }
}

fn stale(reference: &EntryRef) -> EntryRef {
    EntryRef {
        id: reference.id.clone(),
        path: "gone".into(),
    }
}

fn code(error: &AppError) -> String {
    serde_json::to_value(error).unwrap()["code"]
        .as_str()
        .unwrap()
        .to_owned()
}

#[test]
fn every_command_requires_an_open_library() {
    let dir = tempfile::tempdir().unwrap();
    let state = LibraryState::new(Ok(dir.path().to_owned()), Arc::new(|_| {}));
    state.initialize();
    let entry = EntryRef {
        id: "1".into(),
        path: "s/c".into(),
    };
    let errors = [
        state.list_semesters().map(|_| ()),
        state
            .create_semester(CreateSemester {
                name: "Semester".into(),
            })
            .map(|_| ()),
        state
            .update_semester(UpdateSemester {
                semester: entry.clone(),
                archived: true,
            })
            .map(|_| ()),
        state
            .reorder_semesters(ReorderSemesters { semesters: vec![] })
            .map(|_| ()),
        state
            .list_courses(ListCourses { semester: None })
            .map(|_| ()),
        state
            .create_course(CreateCourse {
                semester: entry.clone(),
                name: "Course".into(),
                abbr: None,
                code: None,
                color: None,
            })
            .map(|_| ()),
        state
            .update_course(UpdateCourse {
                course: entry.clone(),
                abbr: None,
                code: None,
                color: None,
                archived: false,
            })
            .map(|_| ()),
        state
            .reorder_courses(ReorderCourses {
                semester: entry.clone(),
                courses: vec![],
            })
            .map(|_| ()),
        state.list_tags().map(|_| ()),
        state
            .create_tag(CreateTag {
                name: "Tag".into(),
                color: "blue".into(),
            })
            .map(|_| ()),
        state
            .update_tag(UpdateTag {
                id: "notes".into(),
                name: "Tag".into(),
                color: "blue".into(),
            })
            .map(|_| ()),
        state.reorder_tags(ReorderTags { tags: vec![] }).map(|_| ()),
        state
            .delete_tag(DeleteTag { id: "notes".into() })
            .map(|_| ()),
        state
            .set_entry_tags(SetEntryTags {
                entries: vec![],
                add: vec![],
                remove: vec![],
            })
            .map(|_| ()),
        state
            .create_folder(CreateFolder {
                parent: entry.clone(),
                name: "Folder".into(),
            })
            .map(|_| ()),
        state
            .rename_entry(RenameEntry {
                entry: entry.clone(),
                name: "New".into(),
            })
            .map(|_| ()),
        state
            .move_entries(MoveEntries {
                entries: vec![],
                to: None,
            })
            .map(|_| ()),
        state
            .delete_entries(DeleteEntries { entries: vec![] })
            .map(|_| ()),
    ];
    for result in errors {
        assert_eq!(code(&result.unwrap_err()), "NoLibrary");
    }
    state.shutdown().unwrap();
}

#[test]
fn semester_and_course_commands_normalize_replace_archive_and_reorder() {
    let f = Fixture::new();
    let a = f.semester(" Café ");
    let b = f.semester("Winter");
    assert_eq!(a.name, "Café");
    assert_eq!(
        serde_json::to_value(&a).unwrap()["folder"]["id"],
        a.folder.id
    );
    let archived = f
        .state
        .update_semester(UpdateSemester {
            semester: a.folder.clone(),
            archived: true,
        })
        .unwrap();
    assert!(archived.archived);
    assert!(f.root.join("Café").is_dir());
    let ordered = f
        .state
        .reorder_semesters(ReorderSemesters {
            semesters: vec![b.folder.clone(), a.folder.clone()],
        })
        .unwrap();
    assert_eq!(
        ordered
            .iter()
            .map(|item| item.name.as_str())
            .collect::<Vec<_>>(),
        ["Winter", "Café"]
    );
    assert_eq!(f.state.list_semesters().unwrap(), ordered);

    let c = f
        .state
        .create_course(CreateCourse {
            semester: a.folder.clone(),
            name: " Calculus ".into(),
            abbr: Some(" éC ".into()),
            code: Some(" MAT é ".into()),
            color: Some("stone".into()),
        })
        .unwrap();
    assert_eq!(
        (c.abbr.as_deref(), c.code.as_deref(), c.color.as_deref()),
        (Some("éC"), Some("MAT é"), Some("stone"))
    );
    let other = f.course(&a, "Algebra");
    let updated = f
        .state
        .update_course(UpdateCourse {
            course: c.folder.clone(),
            abbr: None,
            code: None,
            color: None,
            archived: true,
        })
        .unwrap();
    assert!(updated.archived);
    assert_eq!(
        (updated.abbr, updated.code, updated.color),
        (None, None, None)
    );
    let ordered = f
        .state
        .reorder_courses(ReorderCourses {
            semester: a.folder.clone(),
            courses: vec![other.folder.clone(), c.folder.clone()],
        })
        .unwrap();
    assert_eq!(
        f.state
            .list_courses(ListCourses {
                semester: Some(a.folder.clone())
            })
            .unwrap(),
        ordered
    );
    assert_eq!(
        f.state
            .list_courses(ListCourses { semester: None })
            .unwrap(),
        ordered
    );
    let meta = Layout::new(&f.root)
        .read_course_meta(
            &folio_core::paths::CoursePath::new(RelPath::parse(&c.folder.path).unwrap()).unwrap(),
        )
        .unwrap()
        .unwrap()
        .course
        .unwrap();
    assert_eq!((meta.abbr, meta.code, meta.color), (None, None, None));
    f.catalog_event(|change| change.groups);
}

#[test]
fn tag_folder_rename_and_move_commands_return_partial_results_and_ordered_tags() {
    let f = Fixture::new();
    let semester = f.semester("s");
    let course = f.course(&semester, "c");
    let folder = f
        .state
        .create_folder(CreateFolder {
            parent: course.folder.clone(),
            name: "Work".into(),
        })
        .unwrap();
    let parent = EntryRef {
        id: folder.id.clone(),
        path: folder.path.clone(),
    };
    let custom = f
        .state
        .create_tag(CreateTag {
            name: " Revisión ".into(),
            color: "blue".into(),
        })
        .unwrap();
    assert_eq!(custom.name, "Revisión");
    let updated = f
        .state
        .update_tag(UpdateTag {
            id: custom.id.clone(),
            name: "Reading".into(),
            color: "stone".into(),
        })
        .unwrap();
    assert_eq!(updated.color, "stone");
    let mut order = f
        .state
        .list_tags()
        .unwrap()
        .into_iter()
        .map(|tag| tag.id)
        .collect::<Vec<_>>();
    order.reverse();
    let tags = f
        .state
        .reorder_tags(ReorderTags {
            tags: order.clone(),
        })
        .unwrap();
    assert_eq!(
        tags.into_iter().map(|tag| tag.id).collect::<Vec<_>>(),
        order
    );
    let partial = f
        .state
        .set_entry_tags(SetEntryTags {
            entries: vec![parent.clone(), semester.folder.clone(), stale(&parent)],
            add: vec!["notes".into(), custom.id.clone()],
            remove: vec![],
        })
        .unwrap();
    assert_eq!(partial.done, 1);
    assert_eq!(
        partial
            .failed
            .iter()
            .map(|item| code(&item.error))
            .collect::<Vec<_>>(),
        ["InvalidArgument", "NotFound"]
    );
    let child = f
        .state
        .create_folder(CreateFolder {
            parent: parent.clone(),
            name: "Child".into(),
        })
        .unwrap();
    assert!(child.tags.is_empty());
    assert_eq!(child.folder_tags, [custom.id.clone(), "notes".into()]);
    let own = EntryRef {
        id: child.id.clone(),
        path: child.path.clone(),
    };
    f.state
        .set_entry_tags(SetEntryTags {
            entries: vec![own.clone()],
            add: vec![custom.id.clone()],
            remove: vec![],
        })
        .unwrap();
    let renamed = f
        .state
        .rename_entry(RenameEntry {
            entry: own.clone(),
            name: "Renamed".into(),
        })
        .unwrap();
    assert_eq!(renamed.id, own.id);
    assert_eq!(renamed.tags, std::slice::from_ref(&custom.id));
    assert_eq!(renamed.folder_tags, ["notes"]);
    let old = own;
    let renamed_ref = EntryRef {
        id: renamed.id.clone(),
        path: renamed.path.clone(),
    };
    let moved = f
        .state
        .move_entries(MoveEntries {
            entries: vec![renamed_ref.clone(), old],
            to: Some(course.folder.clone()),
        })
        .unwrap();
    assert_eq!(moved.done, 1);
    assert_eq!(code(&moved.failed[0].error), "NotFound");
    let deleted = f
        .state
        .delete_tag(DeleteTag {
            id: custom.id.clone(),
        })
        .unwrap();
    assert_eq!(deleted.assignments, 2);
    assert!(
        f.state
            .list_tags()
            .unwrap()
            .iter()
            .all(|tag| tag.id != custom.id)
    );
    assert!(f.root.join("s/c/Renamed").is_dir());
    f.catalog_event(|change| change.tags);
    f.catalog_event(|change| {
        change.entries.iter().any(
            |entry| matches!(entry, EntryChange::Moved { from, .. } if from == "s/c/Work/Renamed"),
        )
    });
}

/// Reversible disposal into a test-owned sibling directory; production uses WindowsRecycleBin.
struct TestBin {
    destination: PathBuf,
    refuse: Option<String>,
}

impl RecycleBin for TestBin {
    fn recycle(&self, path: &Path) -> Result<Recycled, RecycleError> {
        if self.refuse.as_deref() == path.file_name().and_then(|name| name.to_str()) {
            return Err(RecycleError {
                path: path.to_owned(),
                failure: RecycleFailure::Unrecyclable,
                detail: "test bin refuses this item".into(),
            });
        }
        fs::create_dir_all(&self.destination).unwrap();
        fs::rename(path, self.destination.join(path.file_name().unwrap())).unwrap();
        Ok(Recycled::RecycleBin)
    }
}

#[test]
fn deletion_recycles_only_and_retains_metadata_with_every_item_failure() {
    let f = Fixture::new();
    let semester = f.semester("s");
    let course = f.course(&semester, "c");
    let a = f
        .state
        .create_folder(CreateFolder {
            parent: course.folder.clone(),
            name: "a".into(),
        })
        .unwrap();
    let b = f
        .state
        .create_folder(CreateFolder {
            parent: course.folder.clone(),
            name: "b".into(),
        })
        .unwrap();
    let a = EntryRef {
        id: a.id,
        path: a.path,
    };
    let b = EntryRef {
        id: b.id,
        path: b.path,
    };
    f.state
        .set_entry_tags(SetEntryTags {
            entries: vec![a.clone()],
            add: vec!["notes".into()],
            remove: vec![],
        })
        .unwrap();
    let bin = TestBin {
        destination: f.root.parent().unwrap().join("test-bin"),
        refuse: Some("b".into()),
    };
    let result = f
        .state
        .delete_entries_with_bin(
            DeleteEntries {
                entries: vec![a.clone(), b.clone(), stale(&a)],
            },
            &bin,
        )
        .unwrap();
    assert_eq!(result.done, 1);
    assert_eq!(
        result
            .failed
            .iter()
            .map(|item| code(&item.error))
            .collect::<Vec<_>>(),
        ["NotRecyclable", "NotFound"]
    );
    assert!(!f.root.join(&a.path).exists());
    assert!(bin.destination.join("a").is_dir());
    assert!(f.root.join(&b.path).is_dir());
    let meta = Layout::new(&f.root)
        .read_course_meta(
            &folio_core::paths::CoursePath::new(RelPath::parse(&course.folder.path).unwrap())
                .unwrap(),
        )
        .unwrap()
        .unwrap();
    assert!(
        meta.tags
            .get(&RelPath::parse("a").unwrap())
            .unwrap()
            .contains(&TagId::parse("notes").unwrap())
    );
    let wire = serde_json::to_value(&result).unwrap();
    assert_eq!(wire["failed"][0]["error"]["code"], "NotRecyclable");
    assert_eq!(
        wire["failed"][0]["entry"],
        serde_json::to_value(&b).unwrap()
    );
    f.catalog_event(|change| {
        change
            .entries
            .iter()
            .any(|entry| matches!(entry, EntryChange::Removed { entry } if entry == &a))
    });
}

#[test]
fn validation_precedes_library_access_and_preserves_typed_codes() {
    for (name, expected) in [
        ("", "NameEmpty"),
        (" ", "NameEmpty"),
        ("CON", "NameReserved"),
        ("bad/name", "NameInvalidCharacter"),
        ("bad.", "NameTrailingDotOrSpace"),
    ] {
        assert_eq!(code(&file_name(name).unwrap_err()), expected);
    }
    assert_eq!(
        code(&file_name(&"x".repeat(256)).unwrap_err()),
        "NameTooLong"
    );
    assert_eq!(
        code(&course_fields(Some("ABCD".into()), None, None).unwrap_err()),
        "NameTooLong"
    );
    assert_eq!(
        code(&course_fields(Some("A B".into()), None, None).unwrap_err()),
        "NameInvalidCharacter"
    );
    assert_eq!(
        code(&course_fields(None, Some("字".repeat(33)), None).unwrap_err()),
        "NameTooLong"
    );
    assert_eq!(
        code(&course_fields(None, Some("a\nb".into()), None).unwrap_err()),
        "NameInvalidCharacter"
    );
    assert_eq!(
        code(&crate::library::display_name(&"字".repeat(129)).unwrap_err()),
        "NameTooLong"
    );
    for id in ["", "0", "-1", "+1", "1a", "9223372036854775808"] {
        assert_eq!(
            code(
                &reference(&EntryRef {
                    id: id.into(),
                    path: "s".into()
                })
                .unwrap_err()
            ),
            "InvalidArgument"
        );
    }
    for path in ["../x", "s//x", "C:/x", "café"] {
        assert_eq!(
            code(
                &reference(&EntryRef {
                    id: "1".into(),
                    path: path.into()
                })
                .unwrap_err()
            ),
            "InvalidArgument"
        );
    }
    assert_eq!(
        code(
            &reference(&EntryRef {
                id: "1".into(),
                path: ".folio/x".into()
            })
            .unwrap_err()
        ),
        "NotFound"
    );
}

#[test]
fn stale_references_permutations_limits_and_read_only_never_change_disk() {
    let f = Fixture::new();
    let semester = f.semester("s");
    let course = f.course(&semester, "c");
    let stale = stale(&course.folder);
    assert_eq!(
        code(
            &f.state
                .update_course(UpdateCourse {
                    course: stale.clone(),
                    abbr: None,
                    code: None,
                    color: None,
                    archived: true
                })
                .unwrap_err()
        ),
        "NotFound"
    );
    assert_eq!(
        code(
            &f.state
                .update_semester(UpdateSemester {
                    semester: stale.clone(),
                    archived: true
                })
                .unwrap_err()
        ),
        "NotFound"
    );
    assert_eq!(
        code(
            &f.state
                .list_courses(ListCourses {
                    semester: stale.clone().into()
                })
                .unwrap_err()
        ),
        "NotFound"
    );
    assert_eq!(
        code(
            &f.state
                .reorder_semesters(ReorderSemesters {
                    semesters: vec![semester.folder.clone(), semester.folder.clone()]
                })
                .unwrap_err()
        ),
        "InvalidArgument"
    );
    assert_eq!(
        code(
            &f.state
                .reorder_courses(ReorderCourses {
                    semester: semester.folder.clone(),
                    courses: vec![]
                })
                .unwrap_err()
        ),
        "InvalidArgument"
    );
    assert_eq!(
        code(
            &f.state
                .reorder_tags(ReorderTags {
                    tags: vec!["notes".into()]
                })
                .unwrap_err()
        ),
        "InvalidArgument"
    );
    assert_eq!(
        code(
            &f.state
                .move_entries(MoveEntries {
                    entries: vec![],
                    to: Some(stale.clone())
                })
                .unwrap_err()
        ),
        "NotFound"
    );
    assert_eq!(
        code(
            &f.state
                .rename_entry(RenameEntry {
                    entry: stale.clone(),
                    name: "New".into()
                })
                .unwrap_err()
        ),
        "NotFound"
    );
    assert_eq!(
        code(
            &f.state
                .create_folder(CreateFolder {
                    parent: stale.clone(),
                    name: "New".into()
                })
                .unwrap_err()
        ),
        "NotFound"
    );
    let over = vec![course.folder.clone(); LIMITS.batch as usize + 1];
    assert_eq!(
        code(
            &f.state
                .delete_entries(DeleteEntries {
                    entries: over.clone()
                })
                .unwrap_err()
        ),
        "InvalidArgument"
    );
    assert_eq!(
        code(
            &f.state
                .move_entries(MoveEntries {
                    entries: over.clone(),
                    to: None
                })
                .unwrap_err()
        ),
        "InvalidArgument"
    );
    assert_eq!(
        code(
            &f.state
                .set_entry_tags(SetEntryTags {
                    entries: over,
                    add: vec![],
                    remove: vec![]
                })
                .unwrap_err()
        ),
        "InvalidArgument"
    );
    assert_eq!(
        code(
            &f.state
                .set_entry_tags(SetEntryTags {
                    entries: vec![],
                    add: vec!["notes".into()],
                    remove: vec!["notes".into()]
                })
                .unwrap_err()
        ),
        "InvalidArgument"
    );
    let file = Layout::new(&f.root).tags_file();
    fs::write(&file, r#"{"format_version":999,"tags":{}}"#).unwrap();
    let before = fs::read(&file).unwrap();
    assert_eq!(
        code(
            &f.state
                .create_tag(CreateTag {
                    name: "New".into(),
                    color: "blue".into()
                })
                .unwrap_err()
        ),
        "ReadOnly"
    );
    assert_eq!(
        code(
            &f.state
                .create_semester(CreateSemester { name: "New".into() })
                .unwrap_err()
        ),
        "ReadOnly"
    );
    assert_eq!(fs::read(&file).unwrap(), before);
    assert!(!f.root.join("New").exists());
}

#[test]
fn nested_recovery_errors_keep_the_original_ipc_code() {
    let error = OperationError::RecoveryRequired {
        source: Box::new(OperationError::DiskChanged {
            path: RelPath::parse("s/c/a").unwrap(),
            source: Box::new(OperationError::Io {
                path: PathBuf::from("catalog"),
                source: std::io::ErrorKind::StorageFull.into(),
            }),
        }),
        cleanup: Some(Box::new(OperationError::NotAttempted)),
    };
    assert_eq!(code(&operation_error(error)), "DiskFull");
}

#[test]
fn list_commands_do_not_advance_the_revision() {
    let f = Fixture::new();
    let revision = || {
        f.state
            .problems(crate::ipc::problems::ListProblems {
                page: types::PageRequest {
                    offset: 0,
                    limit: 0,
                },
            })
            .unwrap()
            .revision
    };
    let before = revision();
    assert!(f.state.list_semesters().unwrap().is_empty());
    assert!(
        f.state
            .list_courses(ListCourses { semester: None })
            .unwrap()
            .is_empty()
    );
    assert_eq!(f.state.list_tags().unwrap().len(), 5);
    assert_eq!(revision(), before);
}

#[test]
fn entry_rows_keep_unknown_tags_after_known_tags_and_stop_inheritance_at_course() {
    let f = Fixture::new();
    let semester = f.semester("s");
    let course = f.course(&semester, "c");
    let parent = f
        .state
        .create_folder(CreateFolder {
            parent: course.folder.clone(),
            name: "Parent".into(),
        })
        .unwrap();
    let parent_ref = EntryRef {
        id: parent.id.clone(),
        path: parent.path.clone(),
    };
    let child = f
        .state
        .create_folder(CreateFolder {
            parent: parent_ref.clone(),
            name: "Child".into(),
        })
        .unwrap();
    let child_ref = EntryRef {
        id: child.id.clone(),
        path: child.path.clone(),
    };
    let semester = reference(&semester.folder).unwrap();
    let course = reference(&course.folder).unwrap();
    let parent = reference(&parent_ref).unwrap();
    let child = reference(&child_ref).unwrap();
    let row = f
        .state
        .with_operations(|session| {
            session.mutate_map(
                |_, catalog| {
                    let value = catalog.write(|tx| {
                        let mut definitions = catalog::tag_definitions(tx)?;
                        definitions
                            .tags
                            .get_mut(&TagId::parse("notes").unwrap())
                            .unwrap()
                            .order = u32::MAX;
                        catalog::replace_tag_definitions(tx, &definitions)?;
                        let tags =
                            |ids: &[&str]| ids.iter().map(|id| TagId::parse(id).unwrap()).collect();
                        // These two assignments must never leak through the course boundary, even if a
                        // damaged derived catalog happens to contain them.
                        catalog::set_entry_tags(tx, semester.id, &tags(&["homework"]))?;
                        catalog::set_entry_tags(tx, course.id, &tags(&["exam"]))?;
                        catalog::set_entry_tags(
                            tx,
                            parent.id,
                            &tags(&["notes", "a-unknown", "z-unknown"]),
                        )?;
                        catalog::set_entry_tags(
                            tx,
                            child.id,
                            &tags(&["slides", "notes", "x-unknown"]),
                        )?;
                        Ok(catalog::entry_by_id(tx, child.id)?.unwrap())
                    })?;
                    Ok(core::Outcome {
                        value,
                        committed: folio_core::library::CommittedScan::default(),
                    })
                },
                entry_row,
            )
        })
        .unwrap();
    assert_eq!(row.tags, ["slides", "notes", "x-unknown"]);
    assert_eq!(row.folder_tags, ["a-unknown", "z-unknown"]);
    assert_eq!(
        serde_json::to_value(&row).unwrap()["folderTags"],
        serde_json::json!(["a-unknown", "z-unknown"])
    );
}

#[test]
fn recovery_cleanup_does_not_replace_in_use_or_access_denied() {
    for (source, expected) in [
        (
            OperationError::InUse {
                path: PathBuf::from("item"),
            },
            "InUse",
        ),
        (
            OperationError::Io {
                path: PathBuf::from("item"),
                source: std::io::ErrorKind::PermissionDenied.into(),
            },
            "AccessDenied",
        ),
    ] {
        let error = OperationError::RecoveryRequired {
            source: Box::new(source),
            cleanup: Some(Box::new(OperationError::Io {
                path: PathBuf::from("journal"),
                source: std::io::ErrorKind::StorageFull.into(),
            })),
        };
        assert_eq!(code(&operation_error(error)), expected);
    }
}

#[test]
fn recycling_adapter_invalid_input_is_internal_and_newer_metadata_is_read_only() {
    let invalid = OperationError::Recycle(RecycleError {
        path: PathBuf::from("invalid"),
        failure: RecycleFailure::Invalid,
        detail: "guard refused".into(),
    });
    assert_eq!(code(&operation_error(invalid)), "Internal");
    let cloud_only = OperationError::Recycle(RecycleError {
        path: PathBuf::from("course"),
        failure: RecycleFailure::CloudOnly,
        detail: "course/hw1.pdf is only in the cloud".into(),
    });
    assert_eq!(code(&operation_error(cloud_only)), "NotRecyclable");
    let newer = || folio_core::meta::MetaError::NewerFormat {
        path: PathBuf::from("tags.json"),
        found: 999,
    };
    assert_eq!(
        code(&operation_error(OperationError::Meta(newer()))),
        "ReadOnly"
    );
    assert_eq!(
        code(&operation_error(OperationError::Library(
            folio_core::library::LibraryError::Meta(newer())
        ))),
        "ReadOnly"
    );
    assert_eq!(code(&file_name(".").unwrap_err()), "NameReserved");
    assert_eq!(code(&file_name("..").unwrap_err()), "NameReserved");
}
