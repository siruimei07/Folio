use std::sync::Arc;
use std::sync::atomic::Ordering;

use proptest::prelude::*;
use tempfile::TempDir;

use super::*;
use crate::fs::{DirEntry, FileSystem, StdFileSystem};
use crate::hash::ContentHash;
use crate::library::ScanCoverage;
use crate::meta::{Assignments, CourseMeta, CourseSettings, DisplayName, LibraryConfig};
use crate::recycle::{RecycleError, RecycleFailure, Recycled};
use crate::test_support::{Trash, course_at, path, presets, tags};

struct Fixture {
    _temp: TempDir,
    library: Library,
    catalog: Catalog,
}

impl Fixture {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("library");
        fs::create_dir(&root).unwrap();
        let library = Library::new(&root, Arc::new(StdFileSystem));
        let config = LibraryConfig::new(DisplayName::parse("Test library").unwrap()).unwrap();
        library.layout().write_library(&config).unwrap();
        library.layout().write_tags(&presets("Slides")).unwrap();
        let catalog = Catalog::open(&temp.path().join("catalog.sqlite"), &config.id)
            .unwrap()
            .catalog;
        Self {
            _temp: temp,
            library,
            catalog,
        }
    }

    fn file(&self, text: &str) {
        let native = path(text).to_native(self.library.root());
        fs::create_dir_all(native.parent().unwrap()).unwrap();
        fs::write(native, b"temporary test content").unwrap();
    }

    fn scan(&self) {
        self.library
            .scan(&self.catalog, None, 1_000_000_000)
            .unwrap();
    }

    fn entry(&self, text: &str) -> Entry {
        self.catalog
            .read(|tx| catalog::entry(tx, &path(text)))
            .unwrap()
            .unwrap()
    }

    fn reference(&self, text: &str) -> EntryRef {
        EntryRef::from(&self.entry(text))
    }

    fn course_meta(&self, text: &str, assignment: &str) {
        let mut assignments = Assignments::default();
        assignments.set(path(assignment), tags(["notes"]));
        self.library
            .layout()
            .write_course_meta(
                &course_at(text),
                &CourseMeta {
                    course: Some(CourseSettings {
                        abbr: None,
                        code: None,
                        color: None,
                        archived: false,
                        order: 2,
                    }),
                    tags: assignments,
                },
            )
            .unwrap();
    }
}

#[test]
fn create_folder_normalizes_name_and_emits_one_committed_identity() {
    let f = Fixture::new();
    f.file("s/c/a.md");
    f.scan();
    let created = f
        .library
        .create_folder(&f.catalog, &f.reference("s/c"), "  cafe\u{301}  ", 77)
        .unwrap();
    assert_eq!(created.value.record.path, path("s/c/café"));
    assert_eq!(created.value.added_ns, 77);
    assert!(f.library.root().join("s/c/café").is_dir());
    assert_eq!(
        created.committed.entries,
        [EntryChange {
            id: created.value.id,
            path: path("s/c/café"),
            kind: EntryChangeKind::Added
        }]
    );
}

#[test]
fn create_folder_refuses_semesters_stale_references_and_disk_collisions() {
    let f = Fixture::new();
    f.file("s/c/a.md");
    f.scan();
    assert!(matches!(
        f.library
            .create_folder(&f.catalog, &f.reference("s"), "child", 1),
        Err(OperationError::InvalidArgument(_))
    ));
    let mut stale = f.reference("s/c");
    stale.path = path("s/old");
    assert!(matches!(
        f.library.create_folder(&f.catalog, &stale, "child", 1),
        Err(OperationError::NotFound)
    ));
    f.file("s/c/Uncatalogued");
    assert!(matches!(
        f.library
            .create_folder(&f.catalog, &f.reference("s/c"), "UNCATALOGUED", 1),
        Err(OperationError::AlreadyExists)
    ));
}

#[test]
fn case_only_rename_preserves_id_hash_and_added_time() {
    let f = Fixture::new();
    f.file("s/c/notes.md");
    f.scan();
    let old = f.entry("s/c/notes.md");
    let hash = ContentHash::of(b"temporary test content");
    f.catalog
        .write(|tx| {
            catalog::set_hash(tx, &old, &hash)?;
            Ok(())
        })
        .unwrap();
    let renamed = f
        .library
        .rename_entry(&f.catalog, &EntryRef::from(&old), "NOTES.md", 3)
        .unwrap();
    assert_eq!(renamed.value.id, old.id);
    assert_eq!(renamed.value.record.hash, Some(hash));
    assert_eq!(renamed.value.added_ns, old.added_ns);
    assert_eq!(renamed.value.record.path, path("s/c/NOTES.md"));
    assert!(
        matches!(&renamed.committed.entries[0].kind, EntryChangeKind::Moved { from } if from == &old.record.path)
    );
    assert!(
        fs::read_dir(f.library.root().join("s/c"))
            .unwrap()
            .any(|entry| entry.unwrap().file_name() == "NOTES.md")
    );
}

#[test]
fn rename_semester_moves_all_descendant_ids_and_authored_metadata() {
    let f = Fixture::new();
    f.file("s/c/sub/a.md");
    f.course_meta("s/c", "sub/a.md");
    f.scan();
    let child = f.entry("s/c/sub/a.md");
    let renamed = f
        .library
        .rename_entry(&f.catalog, &f.reference("s"), "Fall", 4)
        .unwrap();
    assert_eq!(f.entry("Fall/c/sub/a.md").id, child.id);
    assert_eq!(
        f.catalog
            .read(|tx| catalog::entry_tags(tx, child.id))
            .unwrap(),
        tags(["notes"])
    );
    assert!(
        f.library
            .layout()
            .read_course_meta(&course_at("Fall/c"))
            .unwrap()
            .unwrap()
            .course
            .is_some()
    );
    assert!(renamed.committed.groups);
    assert_eq!(renamed.committed.report.changes.len(), 4);
}

#[test]
fn rename_blocks_stale_references_uncatalogued_collisions_and_folio_name() {
    let f = Fixture::new();
    f.file("s/c/a.md");
    f.scan();
    f.file("s/c/B.md");
    assert!(matches!(
        f.library
            .rename_entry(&f.catalog, &f.reference("s/c/a.md"), "b.md", 1),
        Err(OperationError::AlreadyExists)
    ));
    let mut stale = f.reference("s/c/a.md");
    stale.path = path("s/c/missing.md");
    assert!(matches!(
        f.library.rename_entry(&f.catalog, &stale, "new.md", 1),
        Err(OperationError::NotFound)
    ));
    assert!(matches!(
        f.library
            .rename_entry(&f.catalog, &f.reference("s"), ".FOLIO", 1),
        Err(OperationError::Path(PathError::ReservedName))
    ));
    assert!(f.library.root().join("s/c/a.md").exists());
}

#[test]
fn read_only_metadata_blocks_tagged_moves_but_allows_untagged_files() {
    let f = Fixture::new();
    f.file("s/c/tagged.md");
    f.file("s/c/plain.md");
    f.course_meta("s/c", "tagged.md");
    f.scan();
    fs::write(
        f.library.layout().tags_file(),
        r#"{"format_version":3,"tags":{}}"#,
    )
    .unwrap();
    assert!(matches!(
        f.library
            .rename_entry(&f.catalog, &f.reference("s/c/tagged.md"), "new.md", 1),
        Err(OperationError::ReadOnly)
    ));
    let moved = f
        .library
        .move_entries(&f.catalog, &[f.reference("s/c/plain.md")], None, 1)
        .unwrap();
    assert_eq!(moved.value.done, 1);
    assert!(moved.value.failures.is_empty());
    assert!(f.library.root().join("plain.md").exists());
}

#[test]
fn read_only_case_only_course_rename_is_rejected_when_settings_follow() {
    let f = Fixture::new();
    f.file("s/c/a.md");
    f.course_meta("s/c", "a.md");
    f.scan();
    fs::write(
        f.library.layout().tags_file(),
        r#"{"format_version":3,"tags":{}}"#,
    )
    .unwrap();
    assert!(matches!(
        f.library
            .rename_entry(&f.catalog, &f.reference("s/c"), "C", 1),
        Err(OperationError::ReadOnly)
    ));
}

#[test]
fn move_batch_keeps_successes_and_reports_every_item_failure() {
    let f = Fixture::new();
    f.file("s/c/a.md");
    f.file("s/c/b.md");
    f.file("s/d/a.md");
    f.scan();
    let mut missing = f.reference("s/c/a.md");
    missing.id = catalog::EntryId(999_999);
    let moved = f
        .library
        .move_entries(
            &f.catalog,
            &[f.reference("s/c/a.md"), f.reference("s/c/b.md"), missing],
            Some(&f.reference("s/d")),
            1,
        )
        .unwrap();
    assert_eq!(moved.value.done, 1);
    assert_eq!(moved.value.failures.len(), 2);
    assert!(matches!(
        moved.value.failures[0].1,
        OperationError::AlreadyExists
    ));
    assert!(matches!(
        moved.value.failures[1].1,
        OperationError::NotFound
    ));
    assert_eq!(moved.committed.entries.len(), 1);
    assert!(f.library.root().join("s/d/b.md").exists());
    assert!(f.library.root().join("s/c/a.md").exists());
}

#[test]
fn move_rejects_semesters_self_descendants_and_bad_target() {
    let f = Fixture::new();
    f.file("s/c/sub/a.md");
    f.scan();
    for (source, target) in [("s", "s/c"), ("s/c", "s/c"), ("s/c", "s/c/sub")] {
        let result = f
            .library
            .move_entries(
                &f.catalog,
                &[f.reference(source)],
                Some(&f.reference(target)),
                1,
            )
            .unwrap();
        assert!(matches!(
            result.value.failures[0].1,
            OperationError::InvalidMove
        ));
    }
    assert!(matches!(
        f.library
            .move_entries(&f.catalog, &[], Some(&f.reference("s/c/sub/a.md")), 1),
        Err(OperationError::InvalidArgument(_))
    ));
}

#[test]
fn folder_becoming_course_reports_stranded_folder_tags_and_preserves_children() {
    let f = Fixture::new();
    f.file("s/c/sub/a.md");
    f.course_meta("s/c", "sub");
    f.scan();
    let child = f.entry("s/c/sub/a.md");
    let result = f
        .library
        .move_entries(
            &f.catalog,
            &[f.reference("s/c/sub")],
            Some(&f.reference("s")),
            1,
        )
        .unwrap();
    assert_eq!(result.value.done, 1);
    assert_eq!(f.entry("s/sub/a.md").id, child.id);
    assert!(result.committed.groups);
    assert!(
        result
            .committed
            .report
            .problems
            .iter()
            .any(|problem| matches!(
                problem,
                Problem::NotRelocated {
                    cause: StrandedCause::FolderTags,
                    ..
                }
            ))
    );
}

#[test]
fn course_moving_to_another_semester_keeps_settings_and_tags() {
    let f = Fixture::new();
    f.file("s/c/a.md");
    f.file("t/d/b.md");
    f.course_meta("s/c", "a.md");
    f.scan();
    let course = f.entry("s/c");
    let child = f.entry("s/c/a.md");
    let moved = f
        .library
        .move_entries(
            &f.catalog,
            &[EntryRef::from(&course)],
            Some(&f.reference("t")),
            1,
        )
        .unwrap();
    assert_eq!(moved.value.done, 1);
    assert_eq!(f.entry("t/c").id, course.id);
    assert_eq!(f.entry("t/c/a.md").id, child.id);
    assert!(
        f.library
            .layout()
            .read_course_meta(&course_at("t/c"))
            .unwrap()
            .unwrap()
            .course
            .is_some()
    );
    assert_eq!(
        f.catalog
            .read(|tx| catalog::entry_tags(tx, child.id))
            .unwrap(),
        tags(["notes"])
    );
}

#[test]
fn delete_uses_only_recycle_adapter_and_retains_restore_metadata() {
    let f = Fixture::new();
    f.file("s/c/sub/a.md");
    f.course_meta("s/c", "sub/a.md");
    f.scan();
    let course_file = f
        .library
        .layout()
        .tag_file_path(&crate::meta::TagFile::Course(course_at("s/c")))
        .unwrap();
    let authored = fs::read(&course_file).unwrap();
    let deleted = f
        .library
        .delete_entries(&f.catalog, &[f.reference("s/c/sub")], &Trash::new(None))
        .unwrap();
    assert_eq!(deleted.value.done, 1);
    assert_eq!(deleted.committed.entries.len(), 2);
    assert!(
        deleted
            .committed
            .entries
            .iter()
            .all(|entry| entry.kind == EntryChangeKind::Removed)
    );
    assert!(!f.library.root().join("s/c/sub").exists());
    assert_eq!(fs::read(course_file).unwrap(), authored);
}

#[test]
fn a_file_that_went_to_the_cloud_trash_is_deleted_like_a_recycled_one() {
    let f = Fixture::new();
    f.file("s/c/lecture.mp4");
    f.file("s/c/notes.md");
    f.course_meta("s/c", "lecture.mp4");
    f.scan();
    let trash = Trash::new(None).in_the_cloud("lecture.mp4");
    let references = [f.reference("s/c/lecture.mp4"), f.reference("s/c/notes.md")];
    let deleted = f
        .library
        .delete_entries(&f.catalog, &references, &trash)
        .unwrap();
    assert_eq!((deleted.value.done, deleted.value.failures.len()), (2, 0));
    assert_eq!(deleted.committed.entries.len(), 2);
    assert!(!f.library.root().join("s/c/lecture.mp4").exists());
    assert!(
        f.catalog
            .read(|tx| catalog::entry(tx, &path("s/c/lecture.mp4")))
            .unwrap()
            .is_none()
    );
}

#[test]
fn recycle_refusal_keeps_disk_catalog_metadata_and_other_batch_success() {
    let f = Fixture::new();
    f.file("s/c/no.md");
    f.file("s/c/yes.md");
    f.course_meta("s/c", "no.md");
    f.scan();
    let refused = f.entry("s/c/no.md");
    let result = f
        .library
        .delete_entries(
            &f.catalog,
            &[EntryRef::from(&refused), f.reference("s/c/yes.md")],
            &Trash::new(Some("no.md")),
        )
        .unwrap();
    assert_eq!(result.value.done, 1);
    assert!(
        matches!(&result.value.failures[0].1, OperationError::Recycle(error) if error.failure == RecycleFailure::Unrecyclable)
    );
    assert_eq!(f.entry("s/c/no.md"), refused);
    assert!(f.library.root().join("s/c/no.md").exists());
    assert_eq!(
        f.catalog
            .read(|tx| catalog::entry_tags(tx, refused.id))
            .unwrap(),
        tags(["notes"])
    );
    assert_eq!(result.committed.entries.len(), 1);
}

#[test]
fn failed_commit_after_rename_keeps_authored_tags_at_new_path_and_reports_disk_change() {
    let f = Fixture::new();
    f.file("s/c/a.md");
    f.course_meta("s/c", "a.md");
    f.scan();
    let source = f.reference("s/c/a.md");
    f.catalog.with_writer(|conn| -> Result<(), catalog::CatalogError> {
        conn.execute_batch("CREATE TRIGGER fail_move_commit AFTER UPDATE OF parent_id ON entries
            WHEN NEW.path = 's/c/moved.md' BEGIN UPDATE entries SET parent_id = 999999 WHERE id = NEW.id; END;
            PRAGMA defer_foreign_keys = ON;")?;
        Ok(())
    }).unwrap();
    let result = f.library.rename_entry(&f.catalog, &source, "moved.md", 1);
    assert!(matches!(result, Err(OperationError::DiskChanged { .. })));
    assert!(f.library.root().join("s/c/moved.md").exists());
    assert!(f.library.layout().scan_journal_file().exists());
    assert_eq!(f.entry("s/c/a.md").id, source.id);
    assert_eq!(
        f.library
            .layout()
            .read_course_meta(&course_at("s/c"))
            .unwrap()
            .unwrap()
            .tags
            .get(&path("moved.md")),
        Some(&tags(["notes"]))
    );
    f.catalog
        .with_writer(|conn| -> Result<(), catalog::CatalogError> {
            conn.execute_batch("DROP TRIGGER fail_move_commit")?;
            Ok(())
        })
        .unwrap();
    let recovered = f.library.recover_pending(&f.catalog).unwrap();
    assert!(
        recovered
            .entries
            .iter()
            .any(|entry| entry.id == source.id && entry.path == path("s/c/moved.md"))
    );
    assert_eq!(f.entry("s/c/moved.md").id, source.id);
    assert!(!f.library.layout().scan_journal_file().exists());
}

fn crash_after_os_rename(with_ids: bool, source: &str, target: &str) {
    let mut f = Fixture::new();
    if with_ids {
        let adapter = crate::win::WindowsFileSystem::open(f.library.root()).unwrap();
        assert!(adapter.has_file_ids());
        f.library = Library::new(f.library.root(), Arc::new(adapter));
    }
    f.file("s/c/a.md");
    f.course_meta("s/c", "a.md");
    f.scan();
    let settings = f
        .library
        .layout()
        .read_course_meta(&course_at("s/c"))
        .unwrap()
        .unwrap()
        .course;
    let before = f.reference(source);
    let identities = f
        .catalog
        .read(|tx| catalog::entries_in(tx, Some(&before.path)))
        .unwrap();
    let target = path(target);
    let mut changed = None;
    let interrupted = f.catalog.write_with(|tx| {
        let entry = resolve(tx, &before)?;
        f.library
            .relocate_entry(tx, &entry, &target, &mut changed)?;
        // Rollback models the database state after process death. Deliberately skip
        // after_disk_write: the successful OS rename and its pending journal survive.
        Err::<(), _>(OperationError::InvalidArgument("simulated process death"))
    });
    assert!(interrupted.is_err());
    assert_eq!(changed, Some(target.clone()));
    assert!(target.to_native(f.library.root()).exists());
    assert!(f.library.layout().scan_journal_file().exists());
    let restarted = Library::new(f.library.root(), Arc::clone(&f.library.fs));
    restarted.scan(&f.catalog, None, 2_000_000_000).unwrap();
    let moved_file = if source == "s/c" {
        target.join(&path("a.md")).unwrap()
    } else {
        target.clone()
    };
    let moved = f
        .catalog
        .read(|tx| catalog::entry(tx, &moved_file))
        .unwrap()
        .unwrap();
    for original in identities {
        let expected = match original.record.path.strip_prefix(&before.path) {
            Some(tail) => target.join(&tail).unwrap(),
            None => target.clone(),
        };
        let recovered = f
            .catalog
            .read(|tx| catalog::entry(tx, &expected))
            .unwrap()
            .unwrap();
        assert_eq!(recovered.id, original.id);
        assert_eq!(recovered.added_ns, original.added_ns);
        assert_eq!(recovered.record.hash, original.record.hash);
    }
    let course = if source == "s/c" {
        crate::paths::CoursePath::new(target).unwrap()
    } else {
        course_at("s/c")
    };
    assert_eq!(
        restarted
            .layout()
            .read_course_meta(&course)
            .unwrap()
            .and_then(|meta| meta.course),
        settings,
        "an in-app course move must recover its authored settings after a hard crash"
    );
    assert_eq!(
        f.catalog
            .read(|tx| catalog::entry_tags(tx, moved.id))
            .unwrap(),
        tags(["notes"]),
        "an in-app move must recover its authored tags after a hard crash"
    );
}

#[test]
fn crash_after_os_rename_recovers_with_unique_stable_file_ids() {
    crash_after_os_rename(true, "s/c/a.md", "s/c/moved.md");
    crash_after_os_rename(true, "s/c", "s/moved");
}

#[test]
fn crash_after_os_file_rename_must_recover_without_file_ids() {
    crash_after_os_rename(false, "s/c/a.md", "s/c/moved.md");
}

#[test]
fn crash_after_os_course_rename_must_recover_without_file_ids() {
    crash_after_os_rename(false, "s/c", "s/moved");
}

#[test]
fn crash_before_os_rename_puts_the_metadata_back() {
    let f = Fixture::new();
    f.file("s/c/a.md");
    f.course_meta("s/c", "a.md");
    f.scan();
    let before = f.reference("s/c/a.md");
    let target = path("s/c/moved.md");
    let mut changed = None;
    let interrupted = f.catalog.write_with(|tx| {
        let entry = resolve(tx, &before)?;
        f.library
            .relocate_entry(tx, &entry, &target, &mut changed)?;
        Err::<(), _>(OperationError::InvalidArgument("simulated process death"))
    });
    assert!(interrupted.is_err());
    // The process died before the rename: the file is still where the journal found it.
    fs::rename(
        target.to_native(f.library.root()),
        before.path.to_native(f.library.root()),
    )
    .unwrap();
    let restarted = Library::new(f.library.root(), Arc::clone(&f.library.fs));
    restarted.scan(&f.catalog, None, 2_000_000_000).unwrap();
    let meta = restarted
        .layout()
        .read_course_meta(&course_at("s/c"))
        .unwrap()
        .unwrap();
    assert_eq!(meta.tags.get(&path("a.md")), Some(&tags(["notes"])));
    assert_eq!(meta.tags.get(&path("moved.md")), None);
    assert!(!restarted.layout().scan_journal_file().exists());
}

#[test]
fn entry_operations_reject_replaced_junction_ancestors_without_touching_outside() {
    let f = Fixture::new();
    f.file("s/c/a.md");
    f.scan();
    let source = f.reference("s/c/a.md");
    let parent = f.reference("s/c");
    let outside = tempfile::tempdir().unwrap();
    fs::write(outside.path().join("a.md"), b"outside sentinel").unwrap();
    fs::rename(
        f.library.root().join("s/c"),
        f.library.root().join("s/saved"),
    )
    .unwrap();
    let junction = path("s/c").to_native(f.library.root());
    let created = std::process::Command::new("cmd")
        .args(["/C", "mklink", "/J"])
        .arg(&junction)
        .arg(outside.path())
        .output()
        .unwrap();
    assert!(created.status.success(), "{created:?}");
    let rename = f.library.rename_entry(&f.catalog, &source, "other.md", 1);
    let mkdir = f.library.create_folder(&f.catalog, &parent, "child", 1);
    let delete = f
        .library
        .delete_entries(&f.catalog, &[source], &Trash::new(None));
    fs::remove_dir(&junction).unwrap();
    assert!(matches!(rename, Err(OperationError::InvalidArgument(_))));
    assert!(matches!(mkdir, Err(OperationError::InvalidArgument(_))));
    assert!(matches!(
        delete.unwrap().value.failures[0].1,
        OperationError::InvalidArgument(_)
    ));
    assert_eq!(
        fs::read(outside.path().join("a.md")).unwrap(),
        b"outside sentinel"
    );
    assert_eq!(fs::read_dir(outside.path()).unwrap().count(), 1);
}

#[test]
fn failed_reconciliation_stops_batch_and_reports_all_remaining_references() {
    struct JournalBlocker {
        trash: Trash,
        journal: std::path::PathBuf,
    }
    impl RecycleBin for JournalBlocker {
        fn recycle(&self, path: &Path) -> Result<Recycled, RecycleError> {
            let recycled = self.trash.recycle(path)?;
            fs::create_dir_all(&self.journal).unwrap();
            Ok(recycled)
        }
    }
    let f = Fixture::new();
    f.file("s/c/first.md");
    f.file("s/c/second.md");
    f.file("s/c/third.md");
    f.scan();
    let references = [
        f.reference("s/c/first.md"),
        f.reference("s/c/second.md"),
        f.reference("s/c/third.md"),
    ];
    f.catalog.with_writer(|conn| -> Result<(), catalog::CatalogError> {
        conn.execute_batch("CREATE TRIGGER fail_delete_commit AFTER DELETE ON entries
            WHEN OLD.path = 's/c/first.md' BEGIN UPDATE entries SET parent_id = 999999 WHERE path = 's/c/second.md'; END;
            PRAGMA defer_foreign_keys = ON;")?;
        Ok(())
    }).unwrap();
    let journal = f.library.layout().scan_journal_file();
    let trash = JournalBlocker {
        trash: Trash::new(None),
        journal: journal.clone(),
    };
    let result = f
        .library
        .delete_entries(&f.catalog, &references, &trash)
        .unwrap();
    // Remove only the deliberately injected test directory, before fixture cleanup.
    fs::remove_dir(&journal).unwrap();
    assert_eq!(result.value.done, 0);
    assert_eq!(result.value.failures.len(), 3);
    // Both failures are kept: the commit's, and the journal cleanup's after it.
    assert!(matches!(&result.value.failures[0].1,
        OperationError::DiskChanged { source, .. } if matches!(source.as_ref(),
            OperationError::RecoveryRequired { source, cleanup: Some(_) }
                if matches!(source.as_ref(), OperationError::Catalog(_)))));
    assert!(
        result.value.failures[1..]
            .iter()
            .all(|(_, error)| matches!(error, OperationError::NotAttempted))
    );
    assert!(f.library.root().join("s/c/second.md").exists());
    assert!(f.library.root().join("s/c/third.md").exists());
    assert!(result.committed.entries.is_empty());
}

#[test]
fn replaced_file_ids_reject_pending_entry_and_parent_actions() {
    struct Replaced;
    impl FileSystem for Replaced {
        fn read_dir(&self, path: &Path) -> io::Result<Vec<DirEntry>> {
            StdFileSystem.read_dir(path)
        }
        fn metadata(&self, path: &Path) -> io::Result<Metadata> {
            let mut metadata = StdFileSystem.metadata(path)?;
            metadata.file_id = Some("replacement".to_owned());
            Ok(metadata)
        }
        fn open(&self, path: &Path) -> io::Result<Box<dyn io::Read + '_>> {
            Ok(Box::new(fs::File::open(path)?))
        }
    }
    let f = Fixture::new();
    f.file("s/c/a.md");
    f.file("s/d/b.md");
    f.scan();
    for text in ["s", "s/c", "s/c/a.md"] {
        let mut entry = f.entry(text);
        entry.record.file_id = Some("catalogued".to_owned());
        f.catalog
            .write(|tx| {
                catalog::upsert_entry(tx, &entry.record, entry.added_ns)?;
                Ok(())
            })
            .unwrap();
    }
    let library = Library::new(f.library.root(), Arc::new(Replaced));
    let source = f.reference("s/c/a.md");
    assert!(matches!(
        library.rename_entry(&f.catalog, &source, "new.md", 1),
        Err(OperationError::NotFound)
    ));
    assert!(matches!(
        library.create_folder(&f.catalog, &f.reference("s/c"), "child", 1),
        Err(OperationError::NotFound)
    ));
    let moved = library
        .move_entries(
            &f.catalog,
            std::slice::from_ref(&source),
            Some(&f.reference("s/d")),
            1,
        )
        .unwrap();
    assert!(matches!(
        moved.value.failures[0].1,
        OperationError::NotFound
    ));
    let deleted = library
        .delete_entries(&f.catalog, &[source], &Trash::new(None))
        .unwrap();
    assert!(matches!(
        deleted.value.failures[0].1,
        OperationError::NotFound
    ));
    assert!(f.library.root().join("s/c/a.md").exists());
    assert!(!f.library.root().join("s/c/child").exists());
    // Only the selected semester is stale; valid children must not mask its identity guard.
    for text in ["s/c", "s/c/a.md"] {
        let mut entry = f.entry(text);
        entry.record.file_id = Some("replacement".to_owned());
        f.catalog
            .write(|tx| {
                catalog::upsert_entry(tx, &entry.record, entry.added_ns)?;
                Ok(())
            })
            .unwrap();
    }
    assert!(matches!(
        library.create_course(
            &f.catalog,
            &f.reference("s"),
            "new",
            &crate::library::operations::CourseFields::default(),
            1,
        ),
        Err(OperationError::NotFound)
    ));
    assert!(matches!(
        library.reorder_courses(
            &f.catalog,
            &f.reference("s"),
            &[f.reference("s/d"), f.reference("s/c")],
        ),
        Err(OperationError::NotFound)
    ));
    assert!(!f.library.root().join("s/new").exists());
}

#[test]
fn extension_rename_reclassifies_without_losing_hash_or_identity() {
    let f = Fixture::new();
    f.file("s/c/a.md");
    f.scan();
    let before = f.entry("s/c/a.md");
    let hash = ContentHash::of(b"temporary test content");
    f.catalog
        .write(|tx| {
            catalog::set_hash(tx, &before, &hash)?;
            Ok(())
        })
        .unwrap();
    let renamed = f
        .library
        .rename_entry(&f.catalog, &EntryRef::from(&before), "a.png", 1)
        .unwrap();
    assert_eq!(renamed.value.record.class, FileClass::Other);
    assert_eq!(renamed.value.record.hash, Some(hash));
    assert_eq!(renamed.value.id, before.id);
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(24))]
    #[test]
    fn normalized_names_and_case_renames_preserve_entry_identity(text in "[a-z]{1,12}") {
        let f = Fixture::new();
        f.file("s/c/a.md");
        f.scan();
        let created = f.library.create_folder(&f.catalog, &f.reference("s/c"), &format!("  {text}  "), 17).unwrap();
        let renamed = f.library.rename_entry(&f.catalog, &EntryRef::from(&created.value), &text.to_uppercase(), 19).unwrap();
        prop_assert_eq!(renamed.value.id, created.value.id);
        prop_assert_eq!(renamed.value.added_ns, created.value.added_ns);
        prop_assert_eq!(renamed.value.record.path.name(), text.to_uppercase());
    }
}

fn interrupt_move(f: &Fixture, source: &str, target: &str) -> Entry {
    let original = f.entry(source);
    let mut changed = None;
    let result = f.catalog.write_with(|tx| {
        f.library
            .relocate_entry(tx, &original, &path(target), &mut changed)?;
        Err::<(), _>(OperationError::InvalidArgument("simulated process death"))
    });
    assert!(result.is_err());
    assert_eq!(changed, Some(path(target)));
    assert!(f.library.layout().scan_journal_file().exists());
    original
}

fn recovery_fixture() -> Fixture {
    let f = Fixture::new();
    f.file("s/c/a.md");
    f.course_meta("s/c", "a.md");
    f.scan();
    f
}

#[test]
fn recovery_commit_failure_keeps_the_intent_and_a_second_recovery_finishes() {
    for completed in [true, false] {
        for (source, target) in [("s/c/a.md", "s/c/moved.md"), ("s/c", "s/C")] {
            let f = recovery_fixture();
            let original = interrupt_move(&f, source, target);
            if !completed {
                fs::rename(
                    path(target).to_native(f.library.root()),
                    path(source).to_native(f.library.root()),
                )
                .unwrap();
            }
            let journal_before = fs::read(f.library.layout().scan_journal_file()).unwrap();
            f.catalog.with_writer(|conn| -> Result<(), catalog::CatalogError> {
                conn.execute_batch("CREATE TRIGGER fail_recovery_commit AFTER INSERT ON info
                    WHEN NEW.key = 'scan_journal' BEGIN UPDATE entries SET parent_id = 999999 WHERE kind = 'file'; END;
                    PRAGMA defer_foreign_keys = ON;")?;
                Ok(())
            }).unwrap();
            assert!(matches!(
                f.library.recover_pending(&f.catalog),
                Err(crate::library::LibraryError::Catalog(_))
            ));
            assert_eq!(
                fs::read(f.library.layout().scan_journal_file()).unwrap(),
                journal_before
            );
            assert_eq!(f.entry(source), original);
            f.catalog
                .with_writer(|conn| -> Result<(), catalog::CatalogError> {
                    conn.execute_batch("DROP TRIGGER fail_recovery_commit")?;
                    Ok(())
                })
                .unwrap();
            let restarted = Library::new(f.library.root(), Arc::clone(&f.library.fs));
            let recovered = restarted.recover_pending(&f.catalog).unwrap();
            let final_path = if completed { target } else { source };
            assert_eq!(f.entry(final_path).id, original.id);
            if completed {
                assert!(
                    recovered
                        .entries
                        .iter()
                        .any(|entry| entry.id == original.id)
                );
            }
            assert!(!f.library.layout().scan_journal_file().exists());
            let course = if completed && source == "s/c" {
                "s/C"
            } else {
                "s/c"
            };
            let file = if completed && source == "s/c/a.md" {
                "moved.md"
            } else {
                "a.md"
            };
            let metadata = f
                .library
                .layout()
                .read_course_meta(&course_at(course))
                .unwrap()
                .unwrap();
            assert_eq!(metadata.tags.get(&path(file)), Some(&tags(["notes"])));
            assert!(metadata.course.is_some());
        }
    }
}

#[test]
fn ambiguous_or_replaced_move_targets_retain_the_journal_and_authored_bytes() {
    for conflict in ["both", "neither", "replacement", "catalog", "metadata"] {
        let f = recovery_fixture();
        interrupt_move(&f, "s/c/a.md", "s/c/moved.md");
        match conflict {
            "both" => f.file("s/c/a.md"),
            "neither" => fs::rename(
                path("s/c/moved.md").to_native(f.library.root()),
                path("s/c/elsewhere.md").to_native(f.library.root()),
            )
            .unwrap(),
            "replacement" => fs::write(
                path("s/c/moved.md").to_native(f.library.root()),
                b"different competing item",
            )
            .unwrap(),
            "catalog" => {
                let mut record = f.entry("s/c/a.md").record;
                record.path = path("s/c/moved.md");
                f.catalog
                    .write(|tx| {
                        catalog::upsert_entry(tx, &record, 99)?;
                        Ok(())
                    })
                    .unwrap();
            }
            "metadata" => f.course_meta("s/c", "external.md"),
            _ => unreachable!(),
        }
        let journal = fs::read(f.library.layout().scan_journal_file()).unwrap();
        let meta_path = f
            .library
            .layout()
            .tag_file_path(&crate::meta::TagFile::Course(course_at("s/c")))
            .unwrap();
        let authored = fs::read(&meta_path).unwrap();
        let before = f.catalog.read(|tx| catalog::entries_in(tx, None)).unwrap();
        let error = f.library.recover_pending(&f.catalog).unwrap_err();
        assert!(
            matches!(error, crate::library::LibraryError::UnfinishedMove { .. }),
            "{conflict}: {error}"
        );
        assert_eq!(
            fs::read(f.library.layout().scan_journal_file()).unwrap(),
            journal
        );
        assert_eq!(fs::read(&meta_path).unwrap(), authored);
        assert_eq!(
            f.catalog.read(|tx| catalog::entries_in(tx, None)).unwrap(),
            before
        );
        // The item is not (only) at its source, so discarding puts nothing back.
        let files = user_files(&f);
        let discarded = f.library.discard_move(&f.catalog).unwrap().unwrap();
        assert!(!discarded.restored, "{conflict}");
        assert_eq!(fs::read(&meta_path).unwrap(), authored, "{conflict}");
        assert_eq!(user_files(&f), files, "{conflict}");
        assert!(!f.library.layout().scan_journal_file().exists());
        assert_eq!(
            f.catalog.read(|tx| catalog::entries_in(tx, None)).unwrap(),
            before
        );
        f.scan();
    }
}

/// Every file and folder of the library outside `.folio/`, with the bytes of each file.
fn user_files(f: &Fixture) -> Vec<(std::path::PathBuf, Option<Vec<u8>>)> {
    fn walk(folder: &Path, root: &Path, out: &mut Vec<(std::path::PathBuf, Option<Vec<u8>>)>) {
        for entry in fs::read_dir(folder).unwrap() {
            let path = entry.unwrap().path();
            let relative = path.strip_prefix(root).unwrap().to_owned();
            if relative == Path::new(".folio") {
                continue;
            }
            if path.is_dir() {
                out.push((relative, None));
                walk(&path, root, out);
            } else {
                out.push((relative, Some(fs::read(&path).unwrap())));
            }
        }
    }
    let mut files = Vec::new();
    walk(f.library.root(), f.library.root(), &mut files);
    files.sort();
    files
}

#[test]
fn an_empty_catalog_and_a_fresh_operation_cannot_discard_a_pending_intent() {
    let f = recovery_fixture();
    interrupt_move(&f, "s/c/a.md", "s/c/moved.md");
    let journal = fs::read(f.library.layout().scan_journal_file()).unwrap();
    let config = f.library.layout().read_library().unwrap().unwrap();
    let empty = Catalog::open(&f._temp.path().join("empty.sqlite"), &config.id)
        .unwrap()
        .catalog;
    assert!(f.library.scan(&empty, None, 2).is_err());
    assert!(f.library.reset_catalog(&empty).is_err());
    assert!(
        f.library
            .create_folder(&f.catalog, &f.reference("s/c"), "blocked", 3)
            .is_err()
    );
    assert!(!path("s/c/blocked").to_native(f.library.root()).exists());
    assert_eq!(
        fs::read(f.library.layout().scan_journal_file()).unwrap(),
        journal
    );
}

#[test]
fn untagged_case_only_moves_still_publish_an_explicit_identity_intent() {
    let f = Fixture::new();
    f.file("s/c/a.md");
    f.scan();
    let original = interrupt_move(&f, "s/c/a.md", "s/c/A.md");
    let journal: serde_json::Value =
        serde_json::from_slice(&fs::read(f.library.layout().scan_journal_file()).unwrap()).unwrap();
    assert_eq!(journal["format_version"], 3);
    assert_eq!(journal["intent"]["entries"][0]["id"], original.id.0);
    let recovered = f.library.recover_pending(&f.catalog).unwrap();
    assert_eq!(recovered.entries[0].id, original.id);
    assert_eq!(f.entry("s/c/A.md").id, original.id);
}

#[test]
fn recovery_preserves_hash_body_and_identity_high_water() {
    let f = recovery_fixture();
    let before = f.entry("s/c/a.md");
    let hash = ContentHash::of(b"temporary test content");
    f.catalog
        .write(|tx| {
            catalog::set_hash(tx, &before, &hash)?;
            catalog::set_body(tx, before.id, Some("retained extraction"))?;
            Ok(())
        })
        .unwrap();
    let high: String = f
        .catalog
        .read(|tx| {
            Ok(tx.query_row(
                "SELECT value FROM info WHERE key = 'entry_id_high_water'",
                [],
                |row| row.get(0),
            )?)
        })
        .unwrap();
    let original = interrupt_move(&f, "s/c", "s/moved");
    f.library.scan(&f.catalog, None, 2).unwrap();
    assert_eq!(f.entry("s/moved").id, original.id);
    let moved = f.entry("s/moved/a.md");
    assert_eq!(moved.id, before.id);
    assert_eq!(moved.record.hash, Some(hash));
    let body: String = f
        .catalog
        .read(|tx| {
            Ok(tx.query_row(
                "SELECT body FROM search WHERE rowid = ?1",
                [moved.id.0],
                |row| row.get(0),
            )?)
        })
        .unwrap();
    assert_eq!(body, "retained extraction");
    let after: String = f
        .catalog
        .read(|tx| {
            Ok(tx.query_row(
                "SELECT value FROM info WHERE key = 'entry_id_high_water'",
                [],
                |row| row.get(0),
            )?)
        })
        .unwrap();
    assert_eq!(after, high);
}

#[test]
fn legacy_v2_completed_moves_recover_without_rewriting_authored_metadata() {
    let f = recovery_fixture();
    let original = interrupt_move(&f, "s/c/a.md", "s/c/moved.md");
    let file = f.library.layout().scan_journal_file();
    let mut journal: serde_json::Value = serde_json::from_slice(&fs::read(&file).unwrap()).unwrap();
    journal["format_version"] = serde_json::json!(2);
    journal["moved"] = serde_json::json!(["s/c/a.md", "s/c/moved.md"]);
    for key in ["intent", "after", "renames"] {
        journal.as_object_mut().unwrap().remove(key);
    }
    fs::write(&file, journal.to_string()).unwrap();
    let meta_path = f
        .library
        .layout()
        .tag_file_path(&crate::meta::TagFile::Course(course_at("s/c")))
        .unwrap();
    let authored = fs::read(&meta_path).unwrap();
    f.library.recover_pending(&f.catalog).unwrap();
    assert_eq!(f.entry("s/c/moved.md").id, original.id);
    assert_eq!(fs::read(meta_path).unwrap(), authored);
    assert_eq!(
        f.catalog
            .read(|tx| catalog::entry_tags(tx, original.id))
            .unwrap(),
        tags(["notes"])
    );
    assert!(!file.exists());
}

#[test]
fn rescan_delivers_recovery_before_the_following_cancelled_scan() {
    let f = recovery_fixture();
    let original = interrupt_move(&f, "s/c/a.md", "s/c/moved.md");
    let mut reports = Vec::new();
    let finished = f
        .library
        .rescan_with_control(
            &f.catalog,
            &crate::watch::Rescan::Full,
            2,
            &std::sync::atomic::AtomicBool::new(true),
            &mut |_| {},
            &mut |report| reports.push(report),
        )
        .unwrap();
    assert!(!finished);
    assert_eq!(reports.len(), 1);
    assert!(
        reports[0]
            .entries
            .iter()
            .any(|entry| entry.id == original.id)
    );
    assert_eq!(f.entry("s/c/moved.md").id, original.id);
}

#[test]
fn unreadable_move_ancestors_retain_the_intent() {
    struct Denied;
    impl FileSystem for Denied {
        fn read_dir(&self, native: &Path) -> io::Result<Vec<DirEntry>> {
            if native.file_name().is_some_and(|name| name == "c") {
                return Err(io::Error::new(
                    io::ErrorKind::PermissionDenied,
                    "injected inaccessible folder",
                ));
            }
            StdFileSystem.read_dir(native)
        }
        fn metadata(&self, native: &Path) -> io::Result<Metadata> {
            StdFileSystem.metadata(native)
        }
        fn open(&self, native: &Path) -> io::Result<Box<dyn io::Read + '_>> {
            Ok(Box::new(fs::File::open(native)?))
        }
    }
    let f = recovery_fixture();
    interrupt_move(&f, "s/c/a.md", "s/c/moved.md");
    let journal = fs::read(f.library.layout().scan_journal_file()).unwrap();
    let blocked = Library::new(f.library.root(), Arc::new(Denied));
    // A folder that cannot be listed fails as that folder: no reason to discard the move.
    assert!(matches!(
        blocked.recover_pending(&f.catalog),
        Err(crate::library::LibraryError::Root { .. })
    ));
    assert!(matches!(
        blocked.discard_move(&f.catalog),
        Err(crate::library::LibraryError::Root { .. })
    ));
    assert_eq!(
        fs::read(f.library.layout().scan_journal_file()).unwrap(),
        journal
    );
}

#[test]
fn recovery_never_lists_an_ancestor_reported_as_a_link() {
    struct Link;
    impl FileSystem for Link {
        fn read_dir(&self, native: &Path) -> io::Result<Vec<DirEntry>> {
            assert!(
                !native.file_name().is_some_and(|name| name == "c"),
                "recovery followed a link"
            );
            let mut entries = StdFileSystem.read_dir(native)?;
            if native.file_name().is_some_and(|name| name == "s") {
                for entry in &mut entries {
                    if entry.name == "c" {
                        entry.metadata.kind = FileKind::Link;
                    }
                }
            }
            Ok(entries)
        }
        fn metadata(&self, native: &Path) -> io::Result<Metadata> {
            let mut metadata = StdFileSystem.metadata(native)?;
            if native.file_name().is_some_and(|name| name == "c") {
                metadata.kind = FileKind::Link;
            }
            Ok(metadata)
        }
        fn open(&self, _: &Path) -> io::Result<Box<dyn io::Read + '_>> {
            panic!("recovery opened user content")
        }
    }
    let f = recovery_fixture();
    interrupt_move(&f, "s/c/a.md", "s/c/moved.md");
    let bytes = fs::read(f.library.layout().scan_journal_file()).unwrap();
    let library = Library::new(f.library.root(), Arc::new(Link));
    assert!(library.recover_pending(&f.catalog).is_err());
    assert_eq!(
        fs::read(f.library.layout().scan_journal_file()).unwrap(),
        bytes
    );
}

#[test]
fn rescan_delivers_recovery_before_a_subsequent_walk_error() {
    struct FailsAfterRecovery(Arc<std::sync::atomic::AtomicBool>);
    impl FileSystem for FailsAfterRecovery {
        fn read_dir(&self, native: &Path) -> io::Result<Vec<DirEntry>> {
            if self.0.load(Ordering::Relaxed)
                && native.file_name().is_some_and(|name| name == "library")
            {
                return Err(io::Error::new(
                    io::ErrorKind::PermissionDenied,
                    "injected root read failure",
                ));
            }
            StdFileSystem.read_dir(native)
        }
        fn metadata(&self, native: &Path) -> io::Result<Metadata> {
            StdFileSystem.metadata(native)
        }
        fn open(&self, native: &Path) -> io::Result<Box<dyn io::Read + '_>> {
            Ok(Box::new(fs::File::open(native)?))
        }
    }
    let f = recovery_fixture();
    let original = interrupt_move(&f, "s/c/a.md", "s/c/moved.md");
    let fail = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let library = Library::new(
        f.library.root(),
        Arc::new(FailsAfterRecovery(Arc::clone(&fail))),
    );
    let mut reports = Vec::new();
    let result = library.rescan_with_control(
        &f.catalog,
        &crate::watch::Rescan::Full,
        2,
        &std::sync::atomic::AtomicBool::new(false),
        &mut |_| {},
        &mut |report| {
            reports.push(report);
            fail.store(true, Ordering::Relaxed);
        },
    );
    assert!(matches!(
        result,
        Err(crate::library::LibraryError::Root { .. })
    ));
    assert_eq!(reports.len(), 1);
    assert!(
        reports[0]
            .entries
            .iter()
            .any(|entry| entry.id == original.id)
    );
    assert_eq!(f.entry("s/c/moved.md").id, original.id);
}

#[test]
fn committed_journal_cleanup_problem_is_publishable_and_preserves_read_only() {
    use std::os::windows::fs::OpenOptionsExt;
    use windows_sys::Win32::Storage::FileSystem::{FILE_SHARE_READ, FILE_SHARE_WRITE};
    let f = recovery_fixture();
    let original = interrupt_move(&f, "s/c/a.md", "s/c/moved.md");
    let file = f.library.layout().scan_journal_file();
    let pending = ScanJournal::read(f.library.layout()).unwrap().unwrap();
    f.catalog
        .write(|tx| {
            catalog::apply_changes(
                tx,
                &EntryChanges {
                    moved: vec![(original.id, path("s/c/moved.md"))],
                    ..EntryChanges::default()
                },
            )?;
            catalog::set_committed_scan_journal(tx, pending.id())
        })
        .unwrap();
    let mut config: serde_json::Value =
        serde_json::from_slice(&fs::read(f.library.layout().tags_file()).unwrap()).unwrap();
    config["format_version"] = serde_json::json!(99);
    fs::write(f.library.layout().tags_file(), config.to_string()).unwrap();
    let held = fs::OpenOptions::new()
        .read(true)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
        .open(&file)
        .unwrap();
    let report = f.library.recover_pending(&f.catalog).unwrap();
    assert_eq!(report.coverage, ScanCoverage::Metadata);
    assert!(report.read_only);
    assert!(!report.report.problems.is_empty());
    assert!(file.exists());
    drop(held);
    f.library.recover_pending(&f.catalog).unwrap();
    assert!(!file.exists());
}

#[test]
fn interrupted_restore_keeps_mixed_images_and_a_restart_finishes() {
    use std::os::windows::fs::OpenOptionsExt;
    use windows_sys::Win32::Storage::FileSystem::{FILE_SHARE_READ, FILE_SHARE_WRITE};
    let f = recovery_fixture();
    let source_meta = f
        .library
        .layout()
        .tag_file_path(&crate::meta::TagFile::Course(course_at("s/c")))
        .unwrap();
    let before = fs::read(&source_meta).unwrap();
    let original = interrupt_move(&f, "s/c", "s/moved");
    // Model an interruption before the user-folder rename, after metadata publication.
    fs::rename(
        path("s/moved").to_native(f.library.root()),
        path("s/c").to_native(f.library.root()),
    )
    .unwrap();
    let target_meta = f
        .library
        .layout()
        .tag_file_path(&crate::meta::TagFile::Course(course_at("s/moved")))
        .unwrap();
    let after = fs::read(&target_meta).unwrap();
    let journal = fs::read(f.library.layout().scan_journal_file()).unwrap();
    let held = fs::OpenOptions::new()
        .read(true)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
        .open(&target_meta)
        .unwrap();
    assert!(matches!(
        f.library.recover_pending(&f.catalog),
        Err(crate::library::LibraryError::Meta(
            crate::meta::MetaError::Io { .. }
        ))
    ));
    // The first image was restored; the second could not be deleted. SQL is still old.
    assert_eq!(fs::read(&source_meta).unwrap(), before);
    assert_eq!(fs::read(&target_meta).unwrap(), after);
    assert_eq!(
        fs::read(f.library.layout().scan_journal_file()).unwrap(),
        journal
    );
    assert_eq!(f.entry("s/c"), original);
    drop(held);
    let restarted = Library::new(f.library.root(), Arc::clone(&f.library.fs));
    restarted.recover_pending(&f.catalog).unwrap();
    assert_eq!(f.entry("s/c"), original);
    assert_eq!(fs::read(source_meta).unwrap(), before);
    assert!(!target_meta.exists());
    assert!(!f.library.layout().scan_journal_file().exists());
    let file = f.entry("s/c/a.md");
    assert_eq!(
        f.catalog
            .read(|tx| catalog::entry_tags(tx, file.id))
            .unwrap(),
        tags(["notes"])
    );
}

/// Directory listings suffice for discard; individual metadata probes may open file handles.
struct ListOnly;

impl FileSystem for ListOnly {
    fn read_dir(&self, native: &Path) -> io::Result<Vec<DirEntry>> {
        StdFileSystem.read_dir(native)
    }
    fn metadata(&self, _: &Path) -> io::Result<Metadata> {
        panic!("discarding a move opened an item for its attributes")
    }
    fn open(&self, _: &Path) -> io::Result<Box<dyn io::Read + '_>> {
        panic!("discarding a move opened a user file")
    }
}

/// A course move that stopped before the folder moved: the metadata holds the move's images.
/// With `edit`, a file in the course changed since, so recovery cannot tell it is the item the
/// move recorded. Returns the course's metadata file, the one the move wrote, and what the
/// course's file held before.
fn unmoved_course(f: &Fixture, edit: bool) -> (std::path::PathBuf, std::path::PathBuf, Vec<u8>) {
    let layout = f.library.layout();
    let course = |text| {
        layout
            .tag_file_path(&crate::meta::TagFile::Course(course_at(text)))
            .unwrap()
    };
    let before = fs::read(course("s/c")).unwrap();
    interrupt_move(f, "s/c", "s/moved");
    fs::rename(
        path("s/moved").to_native(f.library.root()),
        path("s/c").to_native(f.library.root()),
    )
    .unwrap();
    if edit {
        fs::write(
            path("s/c/a.md").to_native(f.library.root()),
            b"edited while Folio was closed",
        )
        .unwrap();
    }
    assert!(course("s/moved").exists());
    (course("s/c"), course("s/moved"), before)
}

fn unfinished(result: Result<CommittedScan, crate::library::LibraryError>) -> bool {
    matches!(
        result,
        Err(crate::library::LibraryError::UnfinishedMove { .. })
    )
}

#[test]
fn a_recreated_catalog_cannot_reconcile_a_move_and_discarding_lets_a_scan_rebuild_it() {
    for moved in [true, false] {
        let f = recovery_fixture();
        interrupt_move(&f, "s/c/a.md", "s/c/moved.md");
        if !moved {
            fs::rename(
                path("s/c/moved.md").to_native(f.library.root()),
                path("s/c/a.md").to_native(f.library.root()),
            )
            .unwrap();
        }
        let config = f.library.layout().read_library().unwrap().unwrap();
        let fresh = Catalog::open(&f._temp.path().join("fresh.sqlite"), &config.id)
            .unwrap()
            .catalog;
        assert!(unfinished(f.library.recover_pending(&fresh)), "{moved}");
        let discarded = f.library.discard_move(&fresh).unwrap().unwrap();
        assert_eq!(
            discarded,
            crate::library::DiscardedMove {
                from: path("s/c/a.md"),
                to: path("s/c/moved.md"),
                restored: !moved,
            }
        );
        assert!(!f.library.layout().scan_journal_file().exists());
        f.library.scan(&fresh, None, 2).unwrap();
        let (here, gone) = if moved {
            ("s/c/moved.md", "s/c/a.md")
        } else {
            ("s/c/a.md", "s/c/moved.md")
        };
        let entry = fresh
            .read(|tx| catalog::entry(tx, &path(here)))
            .unwrap()
            .unwrap();
        assert_eq!(
            fresh.read(|tx| catalog::entry_tags(tx, entry.id)).unwrap(),
            tags(["notes"]),
            "{moved}: the tags are where the file is"
        );
        assert!(
            fresh
                .read(|tx| catalog::entry(tx, &path(gone)))
                .unwrap()
                .is_none()
        );
    }
}

#[test]
fn discarding_an_unmoved_item_puts_back_what_the_move_wrote_and_never_opens_user_files() {
    let f = recovery_fixture();
    let (source_meta, target_meta, before) = unmoved_course(&f, true);
    assert!(unfinished(f.library.recover_pending(&f.catalog)));
    let files = user_files(&f);
    let library = Library::new(f.library.root(), Arc::new(ListOnly));
    let discarded = library.discard_move(&f.catalog).unwrap().unwrap();
    assert!(discarded.restored);
    assert_eq!(fs::read(&source_meta).unwrap(), before);
    assert!(!target_meta.exists());
    assert!(!f.library.layout().scan_journal_file().exists());
    assert_eq!(user_files(&f), files);
    // The scan finds the edited file where it was, with its id, its tags and its course.
    let original = f.entry("s/c/a.md");
    f.scan();
    let file = f.entry("s/c/a.md");
    assert_eq!(file.id, original.id);
    assert_eq!(
        f.catalog
            .read(|tx| catalog::entry_tags(tx, file.id))
            .unwrap(),
        tags(["notes"])
    );
    let meta = f
        .library
        .layout()
        .read_course_meta(&course_at("s/c"))
        .unwrap()
        .unwrap();
    assert!(meta.course.is_some());
}

#[test]
fn discarding_a_legacy_move_with_a_recreated_catalog_leaves_metadata_unchanged() {
    let f = recovery_fixture();
    let (source_meta, target_meta, _) = unmoved_course(&f, true);
    let journal_file = f.library.layout().scan_journal_file();
    let mut journal: serde_json::Value =
        serde_json::from_slice(&fs::read(&journal_file).unwrap()).unwrap();
    journal["format_version"] = serde_json::json!(2);
    journal["moved"] = serde_json::json!(["s/c", "s/moved"]);
    for key in ["intent", "after", "renames"] {
        journal.as_object_mut().unwrap().remove(key);
    }
    fs::write(&journal_file, serde_json::to_vec(&journal).unwrap()).unwrap();
    let config = f.library.layout().read_library().unwrap().unwrap();
    let fresh = Catalog::open(&f._temp.path().join("fresh.sqlite"), &config.id)
        .unwrap()
        .catalog;
    assert!(unfinished(f.library.recover_pending(&fresh)));
    let source = fs::read(&source_meta).ok();
    let target = fs::read(&target_meta).unwrap();
    let files = user_files(&f);
    let library = Library::new(f.library.root(), Arc::new(ListOnly));
    assert!(!library.discard_move(&fresh).unwrap().unwrap().restored);
    assert_eq!(fs::read(&source_meta).ok(), source);
    assert_eq!(fs::read(&target_meta).unwrap(), target);
    assert_eq!(user_files(&f), files);
    assert!(!journal_file.exists());
    f.library.scan(&fresh, None, 2).unwrap();
    assert!(
        fresh
            .read(|tx| catalog::entry(tx, &path("s/c/a.md")))
            .unwrap()
            .is_some()
    );
}

#[test]
fn discarding_leaves_every_metadata_file_when_one_holds_something_else() {
    let f = recovery_fixture();
    let (source_meta, target_meta, _) = unmoved_course(&f, false);
    // Edited elsewhere after the crash: the file holds none of the journal's images.
    f.course_meta("s/moved", "edited.md");
    let edited = fs::read(&target_meta).unwrap();
    let source = fs::read(&source_meta).ok();
    assert!(unfinished(f.library.recover_pending(&f.catalog)));
    let files = user_files(&f);
    let discarded = f.library.discard_move(&f.catalog).unwrap().unwrap();
    assert!(!discarded.restored);
    assert_eq!(fs::read(&target_meta).unwrap(), edited);
    assert_eq!(fs::read(&source_meta).ok(), source);
    assert_eq!(user_files(&f), files);
    assert!(!f.library.layout().scan_journal_file().exists());
    f.scan();
    assert_eq!(fs::read(&target_meta).unwrap(), edited);
}

#[test]
fn discarding_keeps_metadata_when_the_source_endpoint_changed_kind() {
    struct ChangedKind(FileKind);
    impl FileSystem for ChangedKind {
        fn read_dir(&self, native: &Path) -> io::Result<Vec<DirEntry>> {
            let mut entries = StdFileSystem.read_dir(native)?;
            if native.file_name().is_some_and(|name| name == "s") {
                for entry in &mut entries {
                    if entry.name == "c" {
                        entry.metadata.kind = self.0;
                    }
                }
            }
            Ok(entries)
        }
        fn metadata(&self, native: &Path) -> io::Result<Metadata> {
            let mut metadata = StdFileSystem.metadata(native)?;
            if native.file_name().is_some_and(|name| name == "c") {
                metadata.kind = self.0;
            }
            Ok(metadata)
        }
        fn open(&self, _: &Path) -> io::Result<Box<dyn io::Read + '_>> {
            panic!("discarding a move opened user content")
        }
    }
    for kind in [FileKind::Link, FileKind::Other, FileKind::File] {
        let f = recovery_fixture();
        let (source_meta, target_meta, _) = unmoved_course(&f, false);
        let source = fs::read(&source_meta).ok();
        let target = fs::read(&target_meta).unwrap();
        let files = user_files(&f);
        let library = Library::new(f.library.root(), Arc::new(ChangedKind(kind)));
        assert!(unfinished(library.recover_pending(&f.catalog)), "{kind:?}");
        let discarded = library.discard_move(&f.catalog).unwrap().unwrap();
        assert!(!discarded.restored, "{kind:?}");
        assert_eq!(fs::read(&source_meta).ok(), source, "{kind:?}");
        assert_eq!(fs::read(&target_meta).unwrap(), target, "{kind:?}");
        assert_eq!(user_files(&f), files, "{kind:?}");
        assert!(!f.library.layout().scan_journal_file().exists());
    }
}

#[test]
fn discarding_retains_the_record_when_restoring_a_case_rename_fails_validation() {
    let f = recovery_fixture();
    unmoved_course(&f, true);
    let journal_file = f.library.layout().scan_journal_file();
    let mut journal: serde_json::Value =
        serde_json::from_slice(&fs::read(&journal_file).unwrap()).unwrap();
    journal["before"] = serde_json::json!([]);
    journal["after"] = serde_json::json!([]);
    journal["renames"] = serde_json::json!([["s/absent.json", "s/Absent.json"]]);
    let bytes = serde_json::to_vec(&journal).unwrap();
    fs::write(&journal_file, &bytes).unwrap();
    let files = user_files(&f);
    assert!(matches!(
        f.library.discard_move(&f.catalog),
        Err(crate::library::LibraryError::Meta(
            crate::meta::MetaError::Invalid { .. }
        ))
    ));
    assert_eq!(fs::read(&journal_file).unwrap(), bytes);
    assert_eq!(user_files(&f), files);
}

#[test]
fn discarding_a_case_only_course_move_keeps_tags_at_the_item() {
    for moved in [false, true] {
        let f = recovery_fixture();
        interrupt_move(&f, "s/c", "s/C");
        if !moved {
            fs::rename(f.library.root().join("s/C"), f.library.root().join("s/c")).unwrap();
        }
        let here = if moved { "s/C/a.md" } else { "s/c/a.md" };
        fs::write(
            f.library.root().join(here),
            b"edited after the interrupted move",
        )
        .unwrap();
        assert!(unfinished(f.library.recover_pending(&f.catalog)));
        let files = user_files(&f);
        let library = Library::new(f.library.root(), Arc::new(ListOnly));
        assert_eq!(
            library.discard_move(&f.catalog).unwrap().unwrap().restored,
            !moved
        );
        assert_eq!(user_files(&f), files);
        f.scan();
        let file = f.entry(here);
        assert_eq!(
            f.catalog
                .read(|tx| catalog::entry_tags(tx, file.id))
                .unwrap(),
            tags(["notes"])
        );
    }
}

#[test]
fn an_interrupted_discard_keeps_the_journal_and_a_second_one_finishes() {
    use std::os::windows::fs::OpenOptionsExt;
    use windows_sys::Win32::Storage::FileSystem::{FILE_SHARE_READ, FILE_SHARE_WRITE};
    // Open without delete sharing, so nothing can remove the file meanwhile.
    let hold = |file: &Path| {
        fs::OpenOptions::new()
            .read(true)
            .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
            .open(file)
            .unwrap()
    };
    let io_error = |result: Result<_, crate::library::LibraryError>| {
        matches!(
            result,
            Err(crate::library::LibraryError::Meta(
                crate::meta::MetaError::Io { .. }
            ))
        )
    };
    let f = recovery_fixture();
    let (source_meta, target_meta, before) = unmoved_course(&f, true);
    let journal_file = f.library.layout().scan_journal_file();
    let journal = fs::read(&journal_file).unwrap();
    let after = fs::read(&target_meta).unwrap();

    // Stopped while putting the images back: the first is back, the second is the move's.
    let held = hold(&target_meta);
    assert!(io_error(f.library.discard_move(&f.catalog)));
    drop(held);
    assert_eq!(fs::read(&source_meta).unwrap(), before);
    assert_eq!(fs::read(&target_meta).unwrap(), after);
    assert_eq!(fs::read(&journal_file).unwrap(), journal);

    // Stopped after the images, before the journal went.
    let held = hold(&journal_file);
    assert!(io_error(f.library.discard_move(&f.catalog)));
    drop(held);
    assert_eq!(fs::read(&source_meta).unwrap(), before);
    assert!(!target_meta.exists());
    assert_eq!(fs::read(&journal_file).unwrap(), journal);

    // Recovery still cannot reconcile it, and discarding again finishes.
    assert!(unfinished(f.library.recover_pending(&f.catalog)));
    assert!(
        f.library
            .discard_move(&f.catalog)
            .unwrap()
            .unwrap()
            .restored
    );
    assert_eq!(fs::read(&source_meta).unwrap(), before);
    assert!(!journal_file.exists());
    f.scan();
    let file = f.entry("s/c/a.md");
    assert_eq!(
        f.catalog
            .read(|tx| catalog::entry_tags(tx, file.id))
            .unwrap(),
        tags(["notes"])
    );
}

#[test]
fn discarding_needs_a_pending_move_and_never_reverts_a_committed_one() {
    struct NoInspection;
    impl FileSystem for NoInspection {
        fn read_dir(&self, _: &Path) -> io::Result<Vec<DirEntry>> {
            panic!("a committed discard inspected user paths")
        }
        fn metadata(&self, _: &Path) -> io::Result<Metadata> {
            panic!("a committed discard opened an item for its attributes")
        }
        fn open(&self, _: &Path) -> io::Result<Box<dyn io::Read + '_>> {
            panic!("a committed discard opened user content")
        }
    }
    let f = recovery_fixture();
    assert_eq!(f.library.discard_move(&f.catalog).unwrap(), None);
    // A scan's journal is the next scan's to settle.
    let journal_file = f.library.layout().scan_journal_file();
    fs::create_dir_all(journal_file.parent().unwrap()).unwrap();
    let scan = br#"{"format_version":3,"id":"scan","before":[],"after":[]}"#;
    fs::write(&journal_file, scan).unwrap();
    assert_eq!(f.library.discard_move(&f.catalog).unwrap(), None);
    assert_eq!(fs::read(&journal_file).unwrap(), scan);
    fs::remove_file(&journal_file).unwrap();

    // A move whose catalog update committed keeps what it wrote, even with the item back at
    // its source.
    interrupt_move(&f, "s/c/a.md", "s/c/moved.md");
    let pending = ScanJournal::read(f.library.layout()).unwrap().unwrap();
    f.catalog
        .write(|tx| catalog::set_committed_scan_journal(tx, pending.id()))
        .unwrap();
    fs::rename(
        path("s/c/moved.md").to_native(f.library.root()),
        path("s/c/a.md").to_native(f.library.root()),
    )
    .unwrap();
    let meta_path = f
        .library
        .layout()
        .tag_file_path(&crate::meta::TagFile::Course(course_at("s/c")))
        .unwrap();
    let authored = fs::read(&meta_path).unwrap();
    let library = Library::new(f.library.root(), Arc::new(NoInspection));
    let discarded = library.discard_move(&f.catalog).unwrap().unwrap();
    assert!(!discarded.restored);
    assert_eq!(fs::read(&meta_path).unwrap(), authored);
    assert!(!journal_file.exists());
}
