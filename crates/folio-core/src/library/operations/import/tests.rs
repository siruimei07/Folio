use std::os::windows::ffi::OsStringExt;
use std::os::windows::fs::OpenOptionsExt;
use std::sync::Mutex;
use std::sync::atomic::{AtomicUsize, Ordering};

use proptest::prelude::*;
use tempfile::TempDir;

use super::*;
use crate::fs::DirEntry;
use crate::library::LibraryError;
use crate::meta::{Assignments, CourseMeta, DisplayName, LibraryConfig, MetaError};
use crate::recycle::{RecycleError, RecycleFailure, Recycled};
use crate::test_support::{Trash, course_at, path, presets, tags};

struct Fixture {
    temp: TempDir,
    library: Library,
    catalog: Catalog,
}

impl Fixture {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("library");
        fs::create_dir_all(root.join("s/c")).unwrap();
        let adapter = crate::win::WindowsFileSystem::open(&root).unwrap();
        let library = Library::new(&root, Arc::new(adapter));
        let config = LibraryConfig::new(DisplayName::parse("Import tests").unwrap()).unwrap();
        library.layout().write_library(&config).unwrap();
        library.layout().write_tags(&presets("Slides")).unwrap();
        let catalog = Catalog::open(&temp.path().join("catalog.sqlite"), &config.id)
            .unwrap()
            .catalog;
        library.scan(&catalog, None, 10).unwrap();
        Self {
            temp,
            library,
            catalog,
        }
    }

    fn source_file(&self, name: &str, bytes: &[u8]) -> Source {
        let native = self.temp.path().join("sources").join(name);
        fs::create_dir_all(native.parent().unwrap()).unwrap();
        fs::write(&native, bytes).unwrap();
        Source::select(native).unwrap()
    }

    fn source_folder(&self, name: &str, files: &[(&str, &[u8])]) -> Source {
        let root = self.temp.path().join("sources").join(name);
        fs::create_dir_all(&root).unwrap();
        for (name, bytes) in files {
            let native = root.join(name);
            fs::create_dir_all(native.parent().unwrap()).unwrap();
            fs::write(native, bytes).unwrap();
        }
        Source::select(root).unwrap()
    }

    fn target(&self) -> EntryRef {
        let entry = self
            .catalog
            .read(|tx| catalog::entry(tx, &path("s/c")))
            .unwrap()
            .unwrap();
        EntryRef::from(&entry)
    }

    fn request(&self, sources: Vec<Source>, policy: Conflict) -> Request {
        Request {
            sources,
            target: self.target(),
            tags: BTreeSet::new(),
            on_conflict: policy,
            delete_originals: false,
        }
    }

    fn existing(&self, name: &str, bytes: &[u8]) {
        let native = self.library.root().join("s/c").join(name);
        fs::create_dir_all(native.parent().unwrap()).unwrap();
        fs::write(native, bytes).unwrap();
        self.library.scan(&self.catalog, None, 11).unwrap();
    }

    fn run(&self, request: &Request, trash: &Trash) -> Report {
        self.library
            .import_files(
                &self.catalog,
                request,
                trash,
                12,
                &AtomicBool::new(false),
                &mut |_| {},
                &mut |_| {},
            )
            .unwrap()
    }

    fn authored(&self) -> Assignments {
        self.library
            .layout()
            .read_course_meta(&course_at("s/c"))
            .unwrap()
            .unwrap_or_default()
            .tags
    }

    fn intent(
        &self,
        destination: &str,
        bytes: &[u8],
        replaced: bool,
        assigned: &BTreeSet<TagId>,
    ) -> PathBuf {
        let stage = self.library.layout().staging_dir().join(format!(
            "import-{}.part",
            LibraryId::generate().unwrap().as_str()
        ));
        fs::create_dir_all(stage.parent().unwrap()).unwrap();
        fs::write(&stage, bytes).unwrap();
        fs::OpenOptions::new()
            .write(true)
            .open(&stage)
            .unwrap()
            .sync_all()
            .unwrap();
        let destination = path(&format!("s/c/{destination}"));
        let old = replaced.then(|| {
            self.library
                .disk_path(&destination, EntryKind::File)
                .unwrap()
        });
        let intent = journal::Intent::new(
            &self.library,
            &stage,
            &destination,
            &ContentHash::of(bytes),
            old.as_ref(),
            assigned,
            20,
        )
        .unwrap();
        intent.write(&self.library).unwrap();
        stage
    }
}

#[test]
fn folder_identity_uses_the_manifest_instead_of_a_cached_listing_timestamp() {
    let f = Fixture::new();
    let mut source = f.source_folder("bundle", &[("nested/a.md", b"verified")]);
    // Reproduce the observed NTFS listing/handle timestamp discrepancy without a timing race.
    source.selected.modified_ns = Some(0);
    let mut request = f.request(vec![source], Conflict::KeepBoth);
    request.delete_originals = true;
    let report = f.run(&request, &Trash::new(None));
    assert_eq!(
        (report.imported, report.originals_deleted),
        (1, 1),
        "{report:?}"
    );
    assert_eq!(report.failure_count, 0);
    assert_eq!(
        fs::read(f.library.root().join("s/c/bundle/nested/a.md")).unwrap(),
        b"verified"
    );
}

#[test]
fn a_destination_without_file_ids_imports_and_recovers_with_strict_metadata_and_hash() {
    let mut f = Fixture::new();
    f.library = Library::new(f.library.root(), Arc::new(crate::fs::StdFileSystem));
    f.library.scan(&f.catalog, None, 11).unwrap();
    let source = f.source_file("copied.md", b"verified");
    let request = f.request(vec![source], Conflict::KeepBoth);
    assert_eq!(f.run(&request, &Trash::new(None)).imported, 1);

    let stage = f.intent("recovered.md", b"recovered", false, &BTreeSet::new());
    let published = f.library.root().join("s/c/recovered.md");
    fs::rename(stage, &published).unwrap();
    let report = f.library.recover_pending(&f.catalog).unwrap();
    assert_eq!(report.entries.len(), 1);
    let entry = f
        .catalog
        .read(|tx| catalog::entry(tx, &path("s/c/recovered.md")))
        .unwrap()
        .unwrap();
    assert_eq!(entry.record.file_id, None);
    assert_eq!(entry.record.hash, Some(ContentHash::of(b"recovered")));
    assert_eq!(fs::read(published).unwrap(), b"recovered");
    assert!(!journal::path(&f.library).exists());
}

#[test]
fn check_counts_folder_flags_conflicts_and_default_ignored_content() {
    let f = Fixture::new();
    f.existing("bundle/a.md", b"old");
    let source = f.source_folder(
        "bundle",
        &[("a.md", b"new"), ("node_modules/ignored.md", b"ignored")],
    );
    assert_eq!(
        (source.kind(), source.name()),
        (EntryKind::Folder, "bundle")
    );
    let check = f
        .library
        .check_import(&f.catalog, &[source], &f.target())
        .unwrap();
    assert_eq!(
        (
            check.files,
            check.folders,
            check.bytes,
            check.skipped,
            check.conflict_count
        ),
        (1, 1, 3, 1, 1)
    );
    assert_eq!(check.conflicts, ["s/c/bundle/a.md"]);
}

#[test]
fn a_top_level_non_unicode_name_is_rejected_without_replacing_its_spelling() {
    let f = Fixture::new();
    let name = std::ffi::OsString::from_wide(&[0xd800, u16::from(b'a')]);
    let native = f.temp.path().join(name);
    fs::write(&native, b"original").unwrap();
    assert!(matches!(
        Source::select(native.clone()),
        Err(OperationError::InvalidArgument(
            "source name is not Unicode"
        ))
    ));
    assert_eq!(fs::read(&native).unwrap(), b"original");
}

#[test]
fn replacement_preserves_old_tags_and_imported_includes_replaced_files() {
    let f = Fixture::new();
    f.existing("a.md", b"old");
    let mut assignments = Assignments::default();
    assignments.set(path("a.md"), tags(["notes"]));
    f.library
        .layout()
        .write_course_meta(
            &course_at("s/c"),
            &CourseMeta {
                course: None,
                tags: assignments,
            },
        )
        .unwrap();
    f.library.scan(&f.catalog, None, 11).unwrap();
    let source = f.source_file("a.md", b"new");
    let mut request = f.request(vec![source.clone()], Conflict::Replace);
    request.tags = tags(["slides"]);
    let trash = Trash::new(None);
    let result = f.run(&request, &trash);
    assert_eq!(
        (
            result.imported,
            result.replaced,
            result.renamed,
            result.failure_count
        ),
        (1, 1, 0, 0)
    );
    assert_eq!(fs::read(f.library.root().join("s/c/a.md")).unwrap(), b"new");
    assert_eq!(fs::read(trash.temp.path().join("0")).unwrap(), b"old");
    assert_eq!(
        f.authored().get(&path("a.md")),
        Some(&tags(["notes", "slides"]))
    );
    assert!(source.path().exists());
    assert!(!journal::path(&f.library).exists());
}

#[test]
fn file_folder_clash_keeps_both_even_with_replace_policy() {
    let f = Fixture::new();
    fs::create_dir(f.library.root().join("s/c/a.md")).unwrap();
    f.library.scan(&f.catalog, None, 11).unwrap();
    let request = f.request(vec![f.source_file("a.md", b"copy")], Conflict::Replace);
    let result = f.run(&request, &Trash::new(None));
    assert_eq!(
        (result.imported, result.replaced, result.renamed),
        (1, 0, 1)
    );
    assert!(f.library.root().join("s/c/a.md").is_dir());
    assert_eq!(
        fs::read(f.library.root().join("s/c/a (2).md")).unwrap(),
        b"copy"
    );
}

#[test]
fn folder_file_clash_checks_and_imports_children_under_the_first_free_folder() {
    for numbered_taken in [false, true] {
        let f = Fixture::new();
        f.existing("bundle", b"existing file");
        if numbered_taken {
            f.existing("bundle (2)", b"another existing file");
        }
        let source = f.source_folder("bundle", &[("nested/a.md", b"copy")]);
        let check = f
            .library
            .check_import(&f.catalog, std::slice::from_ref(&source), &f.target())
            .unwrap();
        assert_eq!(
            (
                check.files,
                check.folders,
                check.bytes,
                check.conflict_count
            ),
            (1, 2, 4, 0)
        );
        let report = f.run(
            &f.request(vec![source], Conflict::Replace),
            &Trash::new(None),
        );
        assert_eq!((report.imported, report.failure_count), (1, 0));
        let free = if numbered_taken {
            "bundle (3)"
        } else {
            "bundle (2)"
        };
        assert_eq!(
            fs::read(f.library.root().join("s/c").join(free).join("nested/a.md")).unwrap(),
            b"copy"
        );
        assert_eq!(
            fs::read(f.library.root().join("s/c/bundle")).unwrap(),
            b"existing file"
        );
    }
}

#[test]
fn folder_preflight_avoids_file_names_reserved_by_earlier_sources() {
    let f = Fixture::new();
    let sources = vec![
        f.source_file("bundle", b"first"),
        f.source_file("bundle (2)", b"second"),
        f.source_folder("other/bundle", &[("a.md", b"third")]),
    ];
    let check = f
        .library
        .check_import(&f.catalog, &sources, &f.target())
        .unwrap();
    assert_eq!(
        (check.files, check.folders, check.conflict_count),
        (3, 1, 0)
    );
    let report = f.run(&f.request(sources, Conflict::Replace), &Trash::new(None));
    assert_eq!((report.imported, report.failure_count), (3, 0));
    assert_eq!(
        fs::read(f.library.root().join("s/c/bundle (3)/a.md")).unwrap(),
        b"third"
    );
}

#[test]
fn skip_retains_the_original_and_reports_it_when_deletion_was_requested() {
    let f = Fixture::new();
    f.existing("a.md", b"old");
    let source = f.source_file("a.md", b"new");
    let mut request = f.request(vec![source.clone()], Conflict::Skip);
    request.delete_originals = true;
    let trash = Trash::new(None);
    let result = f.run(&request, &trash);
    assert_eq!(
        (
            result.imported,
            result.skipped,
            result.originals_deleted,
            result.failure_count
        ),
        (0, 1, 0, 1)
    );
    assert_eq!(trash.next.load(Ordering::Relaxed), 0);
    assert!(source.path().exists());
    assert_eq!(fs::read(f.library.root().join("s/c/a.md")).unwrap(), b"old");
}

#[test]
fn replacing_a_file_only_in_the_cloud_publishes_the_new_one() {
    let f = Fixture::new();
    f.existing("a.md", b"old");
    let source = f.source_file("a.md", b"new");
    let request = f.request(vec![source], Conflict::Replace);
    let trash = Trash::new(None).in_the_cloud("a.md");
    let result = f.run(&request, &trash);
    assert_eq!((result.imported, result.failure_count), (1, 0));
    assert_eq!(fs::read(f.library.root().join("s/c/a.md")).unwrap(), b"new");
    assert!(!journal::path(&f.library).exists());
}

#[test]
fn an_original_only_in_the_cloud_counts_as_deleted() {
    let f = Fixture::new();
    let source = f.source_file("lecture.mp4", b"x");
    let mut request = f.request(vec![source.clone()], Conflict::KeepBoth);
    request.delete_originals = true;
    let trash = Trash::new(None).in_the_cloud("lecture.mp4");
    let result = f.run(&request, &trash);
    assert_eq!(
        (
            result.imported,
            result.originals_deleted,
            result.failure_count
        ),
        (1, 1, 0),
        "{result:?}"
    );
    assert!(!source.path().exists());
    assert_eq!(
        fs::read(f.library.root().join("s/c/lecture.mp4")).unwrap(),
        b"x"
    );
}

#[test]
fn failed_recycle_does_not_publish_the_new_file_or_leave_an_intent() {
    let f = Fixture::new();
    f.existing("a.md", b"old");
    let source = f.source_file("a.md", b"new");
    let request = f.request(vec![source.clone()], Conflict::Replace);
    let result = f.run(&request, &Trash::new(Some("a.md")));
    assert_eq!((result.imported, result.failure_count), (0, 1));
    assert!(matches!(result.failures[0].1, OperationError::Recycle(_)));
    assert_eq!(fs::read(f.library.root().join("s/c/a.md")).unwrap(), b"old");
    assert_eq!(fs::read(source.path()).unwrap(), b"new");
    assert!(!journal::path(&f.library).exists());
    assert_eq!(
        fs::read_dir(f.library.layout().staging_dir())
            .unwrap()
            .count(),
        0
    );
}

#[test]
fn failed_intent_abandon_preserves_the_recycle_error_and_recovery_settles_it() {
    struct LockedTrash {
        journal: PathBuf,
        held: Mutex<Option<File>>,
    }
    impl RecycleBin for LockedTrash {
        fn recycle(&self, native: &Path) -> Result<Recycled, RecycleError> {
            *self.held.lock().unwrap() = Some(
                fs::OpenOptions::new()
                    .read(true)
                    .share_mode(3)
                    .open(&self.journal)
                    .unwrap(),
            );
            Err(RecycleError::new(
                native,
                RecycleFailure::Unrecyclable,
                "test refusal",
            ))
        }
    }

    let f = Fixture::new();
    f.existing("a.md", b"old");
    let source = f.source_file("a.md", b"new");
    let later = f.source_file("later.md", b"later");
    let request = f.request(vec![source.clone(), later.clone()], Conflict::Replace);
    let bin = LockedTrash {
        journal: journal::path(&f.library),
        held: Mutex::new(None),
    };
    let result = f.library.import_files(
        &f.catalog,
        &request,
        &bin,
        12,
        &AtomicBool::new(false),
        &mut |_| {},
        &mut |_| {},
    );
    assert!(matches!(
        result,
        Err(OperationError::RecoveryRequired { source, .. })
            if matches!(*source, OperationError::Recycle(ref error)
                if error.failure == RecycleFailure::Unrecyclable && error.detail == "test refusal")
    ));
    assert!(bin.journal.exists());
    let stages: Vec<_> = fs::read_dir(f.library.layout().staging_dir())
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .collect();
    assert_eq!(stages.len(), 1);
    assert_eq!(fs::read(&stages[0]).unwrap(), b"new");
    assert_eq!(fs::read(f.library.root().join("s/c/a.md")).unwrap(), b"old");
    assert!(source.path().exists() && later.path().exists());
    assert!(!f.library.root().join("s/c/later.md").exists());
    drop(bin.held.lock().unwrap().take());
    assert!(!f.library.recover_pending(&f.catalog).unwrap().changed());
    assert!(!bin.journal.exists() && !stages[0].exists());
    assert_eq!(fs::read(f.library.root().join("s/c/a.md")).unwrap(), b"old");
    assert_eq!(f.run(&request, &Trash::new(None)).imported, 2);
}

#[test]
fn failed_intent_abandon_preserves_a_changed_old_file_and_recovery_settles_it() {
    struct ChangedOldFs {
        base: Arc<dyn FileSystem>,
        destination: PathBuf,
        journal: PathBuf,
        change: AtomicBool,
        held: Mutex<Option<File>>,
    }
    impl FileSystem for ChangedOldFs {
        fn read_dir(&self, folder: &Path) -> io::Result<Vec<DirEntry>> {
            self.base.read_dir(folder)
        }
        fn metadata(&self, path: &Path) -> io::Result<Metadata> {
            if path == self.destination
                && self.journal.exists()
                && self.change.swap(false, Ordering::Relaxed)
            {
                *self.held.lock().unwrap() = Some(
                    fs::OpenOptions::new()
                        .read(true)
                        .share_mode(3)
                        .open(&self.journal)?,
                );
                fs::write(&self.destination, b"externally edited old file")?;
            }
            self.base.metadata(path)
        }
        fn open(&self, path: &Path) -> io::Result<Box<dyn Read + '_>> {
            self.base.open(path)
        }
    }

    let mut f = Fixture::new();
    f.existing("a.md", b"old");
    let source = f.source_file("a.md", b"new");
    let adapter = Arc::new(ChangedOldFs {
        base: Arc::clone(&f.library.fs),
        destination: f.library.root().join("s/c/a.md"),
        journal: journal::path(&f.library),
        change: AtomicBool::new(true),
        held: Mutex::new(None),
    });
    f.library.fs = adapter.clone();
    let bin = Trash::new(None);
    let result = f.library.import_files(
        &f.catalog,
        &f.request(vec![source.clone()], Conflict::Replace),
        &bin,
        12,
        &AtomicBool::new(false),
        &mut |_| {},
        &mut |_| {},
    );
    assert!(matches!(
        result,
        Err(OperationError::RecoveryRequired { source, .. })
            if matches!(*source, OperationError::Io { ref source, .. }
                if source.kind() == io::ErrorKind::InvalidData)
    ));
    assert!(adapter.journal.exists());
    assert!(source.path().exists());
    assert_eq!(bin.next.load(Ordering::Relaxed), 0);
    drop(adapter.held.lock().unwrap().take());
    assert!(!f.library.recover_pending(&f.catalog).unwrap().changed());
    assert!(!adapter.journal.exists());
    assert_eq!(
        fs::read_dir(f.library.layout().staging_dir())
            .unwrap()
            .count(),
        0
    );
    assert_eq!(
        fs::read(&adapter.destination).unwrap(),
        b"externally edited old file"
    );
}

#[test]
fn a_new_top_folder_carries_tags_while_a_merge_tags_only_added_files() {
    let f = Fixture::new();
    f.existing("merged/existing.md", b"untagged");
    let mut request = f.request(
        vec![
            f.source_folder("new", &[("a.md", b"one")]),
            f.source_folder("merged", &[("added.md", b"two")]),
        ],
        Conflict::KeepBoth,
    );
    request.tags = tags(["notes"]);
    let result = f.run(&request, &Trash::new(None));
    let authored = f.authored();
    assert_eq!(result.imported, 2);
    assert_eq!(authored.get(&path("new")), Some(&tags(["notes"])));
    assert!(authored.get(&path("new/a.md")).is_none());
    assert_eq!(
        authored.get(&path("merged/added.md")),
        Some(&tags(["notes"]))
    );
    assert!(authored.get(&path("merged")).is_none());
    assert!(authored.get(&path("merged/existing.md")).is_none());
}

#[test]
fn original_recycling_follows_all_copy_and_catalog_notifications() {
    let f = Fixture::new();
    let source = f.source_folder("bundle", &[("one.md", b"one"), ("two.md", b"two")]);
    let mut request = f.request(vec![source.clone()], Conflict::KeepBoth);
    request.delete_originals = true;
    request.tags = tags(["notes"]);
    let trash = Trash::new(None);
    let mut file_commits = 0;
    let result = f
        .library
        .import_files(
            &f.catalog,
            &request,
            &trash,
            12,
            &AtomicBool::new(false),
            &mut |_| {},
            &mut |commit| {
                if commit.entries.iter().any(|entry| {
                    entry.kind == crate::library::EntryChangeKind::Added
                        && entry.path.extension().is_some()
                }) {
                    file_commits += 1;
                    assert!(source.path().exists());
                    assert_eq!(trash.next.load(Ordering::Relaxed), 0);
                }
            },
        )
        .unwrap();
    assert_eq!(
        (
            result.imported,
            result.originals_deleted,
            result.failure_count,
            file_commits
        ),
        (2, 1, 0, 2)
    );
    assert!(!source.path().exists());
    assert_eq!(
        fs::read(trash.temp.path().join("0/one.md")).unwrap(),
        b"one"
    );
}

#[test]
fn skipped_folder_content_prevents_recycling_its_original() {
    let f = Fixture::new();
    let source = f.source_folder("bundle", &[("one.md", b"one"), (".git/secret", b"keep")]);
    let mut request = f.request(vec![source.clone()], Conflict::KeepBoth);
    request.delete_originals = true;
    let result = f.run(&request, &Trash::new(None));
    assert_eq!(
        (result.imported, result.skipped, result.originals_deleted),
        (1, 1, 0)
    );
    assert!(result.failure_count > 0);
    assert_eq!(
        fs::read(source.path().join(".git/secret")).unwrap(),
        b"keep"
    );
}

#[test]
fn overlap_stale_target_read_only_and_undefined_tags_fail_before_writes() {
    let f = Fixture::new();
    let source = f.source_folder("bundle", &[("one.md", b"one")]);
    let child = Source::select(source.path().join("one.md")).unwrap();
    let overlap = f.request(vec![source.clone(), child], Conflict::KeepBoth);
    assert!(matches!(
        f.library.validate_import(&f.catalog, &overlap),
        Err(OperationError::InvalidArgument(_))
    ));
    let containing = f.request(
        vec![Source::select(f.temp.path().to_owned()).unwrap()],
        Conflict::KeepBoth,
    );
    assert!(matches!(
        f.library.validate_import(&f.catalog, &containing),
        Err(OperationError::InvalidArgument(_))
    ));
    let mut stale = f.request(vec![source.clone()], Conflict::KeepBoth);
    stale.target.path = path("s/missing");
    assert!(matches!(
        f.library.validate_import(&f.catalog, &stale),
        Err(OperationError::NotFound)
    ));
    let mut undefined = f.request(vec![source.clone()], Conflict::KeepBoth);
    undefined.tags = tags(["missing"]);
    assert!(matches!(
        f.library.validate_import(&f.catalog, &undefined),
        Err(OperationError::InvalidArgument(_))
    ));
    let mut newer: serde_json::Value =
        serde_json::from_slice(&fs::read(f.library.layout().tags_file()).unwrap()).unwrap();
    newer["format_version"] = serde_json::json!(crate::meta::FORMAT_VERSION + 1);
    fs::write(
        f.library.layout().tags_file(),
        serde_json::to_vec(&newer).unwrap(),
    )
    .unwrap();
    let mut tagged = f.request(vec![source.clone()], Conflict::KeepBoth);
    tagged.tags = tags(["notes"]);
    assert!(matches!(
        f.library.validate_import(&f.catalog, &tagged),
        Err(OperationError::ReadOnly)
    ));
    tagged.tags.clear();
    f.library.validate_import(&f.catalog, &tagged).unwrap();
    assert_eq!(
        fs::read_dir(f.library.root().join("s/c")).unwrap().count(),
        0
    );
    assert!(source.path().exists());
}

#[test]
fn replacement_between_selection_and_job_is_rejected() {
    let f = Fixture::new();
    let source = f.source_file("a.md", b"selected");
    let request = f.request(vec![source.clone()], Conflict::KeepBoth);
    fs::rename(source.path(), source.path().with_extension("saved")).unwrap();
    fs::write(source.path(), b"another file").unwrap();
    assert!(matches!(
        f.library.validate_import(&f.catalog, &request),
        Err(OperationError::Io { .. })
    ));
    assert!(!f.library.root().join("s/c/a.md").exists());
}

#[test]
fn a_changed_same_size_original_is_rehashed_before_recycling() {
    let f = Fixture::new();
    let source = f.source_file("a.md", b"original");
    let modified = fs::metadata(source.path()).unwrap().modified().unwrap();
    let mut request = f.request(vec![source.clone()], Conflict::KeepBoth);
    request.delete_originals = true;
    let trash = Trash::new(None);
    let mut changed = false;
    let result = f
        .library
        .import_files(
            &f.catalog,
            &request,
            &trash,
            12,
            &AtomicBool::new(false),
            &mut |_| {},
            &mut |commit| {
                if !changed
                    && commit
                        .entries
                        .iter()
                        .any(|entry| entry.path == path("s/c/a.md"))
                {
                    fs::write(source.path(), b"modified").unwrap();
                    fs::OpenOptions::new()
                        .write(true)
                        .open(source.path())
                        .unwrap()
                        .set_modified(modified)
                        .unwrap();
                    changed = true;
                }
            },
        )
        .unwrap();
    assert_eq!((result.imported, result.originals_deleted), (1, 0));
    assert!(result.failure_count > 0);
    assert_eq!(fs::read(source.path()).unwrap(), b"modified");
    assert_eq!(
        fs::read(f.library.root().join("s/c/a.md")).unwrap(),
        b"original"
    );
    assert_eq!(trash.next.load(Ordering::Relaxed), 0);
}

#[test]
fn files_arriving_in_a_folder_after_copy_are_not_recycled() {
    let f = Fixture::new();
    let source = f.source_folder("bundle", &[("a.md", b"one")]);
    let mut request = f.request(vec![source.clone()], Conflict::KeepBoth);
    request.delete_originals = true;
    let result = f
        .library
        .import_files(
            &f.catalog,
            &request,
            &Trash::new(None),
            12,
            &AtomicBool::new(false),
            &mut |_| {},
            &mut |commit| {
                if commit
                    .entries
                    .iter()
                    .any(|entry| entry.path == path("s/c/bundle/a.md"))
                {
                    fs::write(source.path().join("new.md"), b"arrived").unwrap();
                }
            },
        )
        .unwrap();
    assert_eq!((result.imported, result.originals_deleted), (1, 0));
    assert!(result.failure_count > 0);
    assert_eq!(fs::read(source.path().join("new.md")).unwrap(), b"arrived");
}

#[test]
fn cancellation_keeps_committed_files_and_all_originals() {
    let f = Fixture::new();
    let source = f.source_folder("bundle", &[("a.md", b"one"), ("b.md", b"two")]);
    let mut request = f.request(vec![source.clone()], Conflict::KeepBoth);
    request.delete_originals = true;
    let cancel = AtomicBool::new(false);
    let result = f
        .library
        .import_files(
            &f.catalog,
            &request,
            &Trash::new(None),
            12,
            &cancel,
            &mut |_| {},
            &mut |commit| {
                if commit
                    .entries
                    .iter()
                    .any(|entry| entry.path == path("s/c/bundle/a.md"))
                {
                    cancel.store(true, Ordering::Relaxed);
                }
            },
        )
        .unwrap();
    assert_eq!(
        (result.imported, result.originals_deleted, result.cancelled),
        (1, 0, true)
    );
    assert!(f.library.root().join("s/c/bundle/a.md").exists());
    assert!(!f.library.root().join("s/c/bundle/b.md").exists());
    assert!(source.path().join("a.md").exists());
    assert!(source.path().join("b.md").exists());
}

#[test]
fn cancellation_at_the_last_commit_keeps_its_success_and_reports_cancelled() {
    let f = Fixture::new();
    let source = f.source_file("a.md", b"one");
    let request = f.request(vec![source.clone()], Conflict::KeepBoth);
    let cancel = AtomicBool::new(false);
    let report = f
        .library
        .import_files(
            &f.catalog,
            &request,
            &Trash::new(None),
            12,
            &cancel,
            &mut |_| {},
            &mut |commit| {
                if commit
                    .entries
                    .iter()
                    .any(|entry| entry.path == path("s/c/a.md"))
                {
                    cancel.store(true, Ordering::Relaxed);
                }
            },
        )
        .unwrap();
    assert_eq!((report.imported, report.cancelled), (1, true));
    assert!(source.path().exists());
    assert_eq!(fs::read(f.library.root().join("s/c/a.md")).unwrap(), b"one");
}

struct AfterHashFs {
    base: Arc<dyn FileSystem>,
    target: PathBuf,
    effect: PathBuf,
    opens: AtomicUsize,
    /// Which open of `target` (from zero) changes `effect` at its EOF.
    open: usize,
}

impl FileSystem for AfterHashFs {
    fn read_dir(&self, folder: &Path) -> io::Result<Vec<DirEntry>> {
        self.base.read_dir(folder)
    }
    fn metadata(&self, path: &Path) -> io::Result<Metadata> {
        self.base.metadata(path)
    }
    fn open(&self, path: &Path) -> io::Result<Box<dyn Read + '_>> {
        let reader = self.base.open(path)?;
        // Publication hashes this destination first; the second read is the verification
        // immediately before original recycling. Change the fixture only after its EOF.
        if path == self.target && self.opens.fetch_add(1, Ordering::Relaxed) == self.open {
            return Ok(Box::new(AfterHashRead {
                reader,
                effect: self.effect.clone(),
                changed: false,
            }));
        }
        Ok(reader)
    }
}

struct AfterHashRead<'a> {
    reader: Box<dyn Read + 'a>,
    effect: PathBuf,
    changed: bool,
}

impl Read for AfterHashRead<'_> {
    fn read(&mut self, bytes: &mut [u8]) -> io::Result<usize> {
        let read = self.reader.read(bytes)?;
        if read == 0 && !self.changed {
            fs::write(&self.effect, b"arrived after hashing")?;
            self.changed = true;
        }
        Ok(read)
    }
}

#[test]
fn a_nested_arrival_during_hash_verification_retains_the_entire_source() {
    let mut f = Fixture::new();
    let source = f.source_folder("bundle", &[("nested/a.md", b"one")]);
    let target = path("s/c/bundle/nested/a.md").to_native(f.library.root());
    f.library.fs = Arc::new(AfterHashFs {
        base: Arc::clone(&f.library.fs),
        target,
        effect: source.path().join("nested/new.md"),
        opens: AtomicUsize::new(0),
        open: 1,
    });
    let mut request = f.request(vec![source.clone()], Conflict::KeepBoth);
    request.delete_originals = true;
    let trash = Trash::new(None);
    let report = f.run(&request, &trash);
    assert_eq!(
        (report.imported, report.originals_deleted),
        (1, 0),
        "{report:?}"
    );
    assert!(report.failure_count > 0);
    assert_eq!(
        fs::read(source.path().join("nested/new.md")).unwrap(),
        b"arrived after hashing"
    );
    assert_eq!(trash.next.load(Ordering::Relaxed), 0);
}

#[test]
fn a_destination_changed_at_hash_eof_keeps_its_original() {
    let mut f = Fixture::new();
    let source = f.source_file("a.md", b"one");
    let target = path("s/c/a.md").to_native(f.library.root());
    f.library.fs = Arc::new(AfterHashFs {
        base: Arc::clone(&f.library.fs),
        target: target.clone(),
        effect: target.clone(),
        opens: AtomicUsize::new(0),
        open: 1,
    });
    let mut request = f.request(vec![source.clone()], Conflict::KeepBoth);
    request.delete_originals = true;
    let trash = Trash::new(None);
    let report = f.run(&request, &trash);
    assert_eq!((report.imported, report.originals_deleted), (1, 0));
    assert!(report.failure_count > 0);
    assert_eq!(fs::read(source.path()).unwrap(), b"one");
    assert_eq!(fs::read(target).unwrap(), b"arrived after hashing");
    assert_eq!(trash.next.load(Ordering::Relaxed), 0);
}

#[test]
fn crash_before_recycling_abandons_only_the_verified_copy() {
    let f = Fixture::new();
    f.existing("a.md", b"old");
    let stage = f.intent("a.md", b"new", true, &BTreeSet::new());
    let restarted = Library::new(f.library.root(), Arc::clone(&f.library.fs));
    let recovered = restarted.recover_import(&f.catalog).unwrap();
    assert!(!recovered.changed());
    assert_eq!(fs::read(f.library.root().join("s/c/a.md")).unwrap(), b"old");
    assert!(!stage.exists());
    assert!(!journal::path(&f.library).exists());
}

#[test]
fn crash_after_recycling_recovers_the_verified_file_and_tags_without_recycling_again() {
    let f = Fixture::new();
    f.existing("a.md", b"old");
    let stage = f.intent("a.md", b"new", true, &tags(["notes"]));
    let old_identity = f
        .library
        .fs
        .metadata(&f.library.root().join("s/c/a.md"))
        .unwrap();
    let staged_identity = f.library.fs.metadata(&stage).unwrap();
    let trash = Trash::new(None);
    trash.recycle(&f.library.root().join("s/c/a.md")).unwrap();
    let restarted = Library::new(f.library.root(), Arc::clone(&f.library.fs));
    let recovered = restarted.recover_import(&f.catalog).unwrap();
    let published_identity = f
        .library
        .fs
        .metadata(&f.library.root().join("s/c/a.md"))
        .unwrap();
    assert_ne!(published_identity.file_id, old_identity.file_id);
    assert!(staged_identity.file_id.is_some());
    assert_eq!(published_identity.file_id, staged_identity.file_id);
    assert_eq!(
        (published_identity.size, published_identity.modified_ns),
        (staged_identity.size, staged_identity.modified_ns)
    );
    assert!(recovered.changed());
    assert_eq!(fs::read(f.library.root().join("s/c/a.md")).unwrap(), b"new");
    assert_eq!(f.authored().get(&path("a.md")), Some(&tags(["notes"])));
    assert_eq!(trash.next.load(Ordering::Relaxed), 1);
    assert_eq!(fs::read(trash.temp.path().join("0")).unwrap(), b"old");
    assert!(!stage.exists());
    assert!(!journal::path(&f.library).exists());
}

#[test]
fn published_copy_survives_failed_catalog_commit_and_recovers_idempotently() {
    let f = Fixture::new();
    let source = f.source_file("a.md", b"new");
    let mut request = f.request(vec![source.clone()], Conflict::KeepBoth);
    request.tags = tags(["notes"]);
    f.catalog.with_writer(|conn| -> Result<(), catalog::CatalogError> {
        conn.execute_batch("CREATE TRIGGER stop_import BEFORE INSERT ON entries WHEN NEW.path = 's/c/a.md' BEGIN SELECT RAISE(ABORT, 'simulated crash after publication'); END;")?;
        Ok(())
    }).unwrap();
    let result = f.library.import_files(
        &f.catalog,
        &request,
        &Trash::new(None),
        12,
        &AtomicBool::new(false),
        &mut |_| {},
        &mut |_| {},
    );
    assert!(matches!(
        result,
        Err(OperationError::RecoveryRequired { .. })
    ));
    assert_eq!(fs::read(f.library.root().join("s/c/a.md")).unwrap(), b"new");
    assert!(source.path().exists());
    assert!(journal::path(&f.library).exists());
    f.catalog
        .with_writer(|conn| -> Result<(), catalog::CatalogError> {
            conn.execute_batch("DROP TRIGGER stop_import")?;
            Ok(())
        })
        .unwrap();
    let restarted = Library::new(f.library.root(), Arc::clone(&f.library.fs));
    assert!(restarted.recover_import(&f.catalog).unwrap().changed());
    assert!(!restarted.recover_import(&f.catalog).unwrap().changed());
    assert_eq!(f.authored().get(&path("a.md")), Some(&tags(["notes"])));
    let entry = f
        .catalog
        .read(|tx| catalog::entry(tx, &path("s/c/a.md")))
        .unwrap()
        .unwrap();
    assert_eq!(entry.record.hash, Some(ContentHash::of(b"new")));
    assert!(!journal::path(&f.library).exists());
}

#[test]
fn recovery_retains_evidence_for_a_tampered_stage() {
    let f = Fixture::new();
    let stage = f.intent("a.md", b"verified", false, &BTreeSet::new());
    fs::write(&stage, b"tampered").unwrap();
    assert!(matches!(
        f.library.recover_import(&f.catalog),
        Err(LibraryError::Meta(crate::meta::MetaError::Invalid { .. }))
    ));
    assert!(journal::path(&f.library).exists());
    assert!(stage.exists());
}

struct RecoveryOpenFs {
    base: Arc<dyn FileSystem>,
    path: PathBuf,
    locked: AtomicBool,
}

impl FileSystem for RecoveryOpenFs {
    fn read_dir(&self, folder: &Path) -> io::Result<Vec<DirEntry>> {
        self.base.read_dir(folder)
    }

    fn metadata(&self, path: &Path) -> io::Result<Metadata> {
        self.base.metadata(path)
    }

    fn open(&self, path: &Path) -> io::Result<Box<dyn Read + '_>> {
        if path == self.path && self.locked.load(Ordering::Relaxed) {
            return Err(io::Error::from_raw_os_error(32));
        }
        self.base.open(path)
    }
}

#[test]
fn recovery_keeps_an_import_intent_after_a_sharing_violation() {
    let f = Fixture::new();
    let stage = f.intent("a.md", b"verified", false, &tags(["notes"]));
    let destination = f.library.root().join("s/c/a.md");
    fs::rename(&stage, &destination).unwrap();
    let adapter = Arc::new(RecoveryOpenFs {
        base: Arc::clone(&f.library.fs),
        path: destination.clone(),
        locked: AtomicBool::new(true),
    });
    let restarted = Library::new(f.library.root(), adapter.clone());
    let journal_path = journal::path(&restarted);
    let intent = fs::read(&journal_path).unwrap();
    assert!(matches!(
        restarted.recover_pending(&f.catalog),
        Err(LibraryError::Meta(MetaError::Io { path, source }))
            if path == destination && source.raw_os_error() == Some(32)
    ));
    assert_eq!(fs::read(&journal_path).unwrap(), intent);
    assert_eq!(fs::read(&destination).unwrap(), b"verified");
    assert!(
        f.catalog
            .read(|tx| catalog::entry(tx, &path("s/c/a.md")))
            .unwrap()
            .is_none()
    );

    adapter.locked.store(false, Ordering::Relaxed);
    assert!(restarted.recover_pending(&f.catalog).unwrap().changed());
    assert!(!journal_path.exists());
    assert_eq!(f.authored().get(&path("a.md")), Some(&tags(["notes"])));
    assert!(!restarted.recover_pending(&f.catalog).unwrap().changed());
}

#[test]
fn recovery_preserves_hash_read_errors_for_staged_and_published_files() {
    for published in [false, true] {
        let f = Fixture::new();
        let stage = f.intent("a.md", b"verified", false, &BTreeSet::new());
        let destination = f.library.root().join("s/c/a.md");
        let failed = if published {
            fs::rename(&stage, &destination).unwrap();
            destination.clone()
        } else {
            stage.clone()
        };
        let restarted = Library::new(
            f.library.root(),
            Arc::new(FailingFs {
                base: Arc::clone(&f.library.fs),
                fail: Some(failed.clone()),
            }),
        );
        let intent = fs::read(journal::path(&f.library)).unwrap();
        assert!(matches!(
            restarted.recover_pending(&f.catalog),
            Err(LibraryError::Meta(MetaError::Io { path, source }))
                if path == failed && source.raw_os_error() == Some(112)
        ));
        assert_eq!(fs::read(journal::path(&f.library)).unwrap(), intent);
        assert_eq!(fs::read(&failed).unwrap(), b"verified");
        assert!(f.library.recover_pending(&f.catalog).unwrap().changed());
        assert!(!journal::path(&f.library).exists());
        assert_eq!(fs::read(destination).unwrap(), b"verified");
    }
}

#[test]
fn recovery_preserves_the_io_error_of_a_locked_tag_holder() {
    let f = Fixture::new();
    let mut metadata = CourseMeta::default();
    metadata.tags.set(path("existing.md"), tags(["homework"]));
    f.library
        .layout()
        .write_course_meta(&course_at("s/c"), &metadata)
        .unwrap();
    f.intent("a.md", b"verified", false, &tags(["notes"]));
    let holder = crate::meta::TagFile::Course(course_at("s/c"));
    let metadata_path = f.library.layout().tag_file_path(&holder).unwrap();
    let held = fs::OpenOptions::new()
        .read(true)
        .share_mode(0)
        .open(&metadata_path)
        .unwrap();
    let tree = crate::meta::MetaTree::read(f.library.layout()).unwrap();
    assert!(matches!(
        tree.broken().get(&holder),
        Some(MetaError::Io { source, .. }) if source.raw_os_error() == Some(32)
    ));
    let intent = fs::read(journal::path(&f.library)).unwrap();
    assert!(matches!(
        f.library.recover_pending(&f.catalog),
        Err(LibraryError::Meta(MetaError::Io { path, source }))
            if path == metadata_path && source.raw_os_error() == Some(32)
    ));
    assert_eq!(fs::read(journal::path(&f.library)).unwrap(), intent);
    assert_eq!(
        fs::read(f.library.root().join("s/c/a.md")).unwrap(),
        b"verified"
    );
    drop(held);
    assert!(f.library.recover_pending(&f.catalog).unwrap().changed());
    assert!(!journal::path(&f.library).exists());
    assert_eq!(f.authored().get(&path("a.md")), Some(&tags(["notes"])));
    assert_eq!(
        f.authored().get(&path("existing.md")),
        Some(&tags(["homework"]))
    );
}

#[test]
fn recovery_keeps_the_stage_when_its_publication_is_in_use() {
    let f = Fixture::new();
    let stage = f.intent("a.md", b"verified", false, &BTreeSet::new());
    // Share reads and writes so verification succeeds, but deny delete/rename sharing.
    let held = fs::OpenOptions::new()
        .read(true)
        .share_mode(3)
        .open(&stage)
        .unwrap();
    let destination = f.library.root().join("s/c/a.md");
    assert!(matches!(
        f.library.recover_pending(&f.catalog),
        Err(LibraryError::Meta(MetaError::Io { path, source }))
            if path == destination && crate::fs::is_in_use(&source)
    ));
    assert!(stage.exists());
    assert!(journal::path(&f.library).exists());
    assert!(!destination.exists());
    drop(held);
    assert!(f.library.recover_pending(&f.catalog).unwrap().changed());
    assert_eq!(fs::read(destination).unwrap(), b"verified");
    assert!(!stage.exists());
    assert!(!journal::path(&f.library).exists());
}

#[test]
fn recovery_abandons_a_copy_whose_destination_changed_without_touching_it() {
    // An unrelated arrival, an edited old file, and a moved destination folder.
    for case in ["arrived", "edited", "moved"] {
        let f = Fixture::new();
        if case == "edited" {
            f.existing("a.md", b"old");
        }
        let stage = f.intent("a.md", b"verified", case == "edited", &BTreeSet::new());
        match case {
            "moved" => fs::rename(
                f.library.root().join("s/c"),
                f.library.root().join("s/moved"),
            )
            .unwrap(),
            _ => fs::write(f.library.root().join("s/c/a.md"), b"external").unwrap(),
        }
        let recovered = f.library.recover_import(&f.catalog).unwrap();
        assert!(!recovered.changed(), "{case}");
        assert!(!journal::path(&f.library).exists(), "{case}");
        assert!(!stage.exists(), "{case}");
        if case == "moved" {
            assert!(!f.library.root().join("s/moved/a.md").exists());
        } else {
            assert_eq!(
                fs::read(f.library.root().join("s/c/a.md")).unwrap(),
                b"external",
                "{case}"
            );
        }
    }
}

#[test]
fn byte_progress_reaches_the_total_when_files_are_skipped() {
    let f = Fixture::new();
    f.existing("a.md", b"old");
    let sources = vec![
        f.source_file("a.md", b"skipped"),
        f.source_file("b.md", b"copied"),
    ];
    let mut last = Progress::default();
    let report = f
        .library
        .import_files(
            &f.catalog,
            &f.request(sources, Conflict::Skip),
            &Trash::new(None),
            12,
            &AtomicBool::new(false),
            &mut |progress| last = progress,
            &mut |_| {},
        )
        .unwrap();
    assert_eq!((report.imported, report.skipped), (1, 1));
    assert_eq!((last.done, last.total), (2, 2));
    assert_eq!(last.bytes, last.total_bytes);
}

#[test]
fn blocked_folder_children_publish_their_finished_progress_and_keep_the_source() {
    let f = Fixture::new();
    let source = f.source_folder("bundle", &[("a.md", b"one"), ("b.md", b"two")]);
    let saved = source.path().with_file_name("saved");
    let mut last = Progress::default();
    let trash = Trash::new(None);
    let mut request = f.request(vec![source.clone()], Conflict::KeepBoth);
    request.delete_originals = true;
    let report = f
        .library
        .import_files(
            &f.catalog,
            &request,
            &trash,
            12,
            &AtomicBool::new(false),
            &mut |progress| {
                if progress.current.is_empty() {
                    // The plan is complete, but the selected folder moves before its first copy.
                    fs::rename(source.path(), &saved).unwrap();
                }
                last = progress;
            },
            &mut |_| {},
        )
        .unwrap();
    assert_eq!((report.imported, report.originals_deleted), (0, 0));
    assert!(report.failure_count > 0);
    assert_eq!(
        (last.done, last.total, last.bytes, last.total_bytes),
        (2, 2, 6, 6)
    );
    assert_eq!(fs::read(saved.join("a.md")).unwrap(), b"one");
    assert_eq!(fs::read(saved.join("b.md")).unwrap(), b"two");
    assert_eq!(trash.next.load(Ordering::Relaxed), 0);
    assert!(!f.library.root().join("s/c/bundle").exists());
}

#[test]
fn an_old_file_edited_during_the_copy_fails_only_that_item() {
    let f = Fixture::new();
    f.existing("a.md", b"old");
    let mut source = f.source_file("a.md", b"new");
    let destination = path("s/c/a.md").to_native(f.library.root());
    source.fs = Arc::new(AfterHashFs {
        base: Arc::clone(&source.fs),
        target: source.path().to_owned(),
        effect: destination.clone(),
        opens: AtomicUsize::new(0),
        open: 0,
    });
    let other = f.source_file("b.md", b"other");
    let trash = Trash::new(None);
    let report = f.run(&f.request(vec![source, other], Conflict::Replace), &trash);
    assert_eq!(
        (report.imported, report.replaced, report.failure_count),
        (1, 0, 1),
        "{report:?}"
    );
    assert_eq!(fs::read(&destination).unwrap(), b"arrived after hashing");
    assert_eq!(
        fs::read(f.library.root().join("s/c/b.md")).unwrap(),
        b"other"
    );
    assert_eq!(trash.next.load(Ordering::Relaxed), 0);
    assert!(!journal::path(&f.library).exists());
    assert!(
        fs::read_dir(f.library.layout().staging_dir())
            .unwrap()
            .all(|entry| !entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .starts_with("import-"))
    );
}

#[test]
fn a_pending_move_blocks_an_import_intent_before_publication() {
    let f = Fixture::new();
    f.existing("moving.md", b"keep");
    let from = path("s/c/moving.md");
    let to = path("s/c/moved.md");
    let entry = f
        .catalog
        .read(|tx| catalog::entry(tx, &from))
        .unwrap()
        .unwrap();
    let disk = f.library.disk_path(&from, EntryKind::File).unwrap();
    let mut tree = MetaTree::read(f.library.layout()).unwrap();
    tree.save_operation(f.library.layout(), &from, &to, &[(entry, to.clone(), disk)])
        .unwrap();
    let stage = f.library.layout().staging_dir().join(format!(
        "import-{}.part",
        LibraryId::generate().unwrap().as_str()
    ));
    fs::create_dir_all(stage.parent().unwrap()).unwrap();
    fs::write(&stage, b"new").unwrap();
    let intent = journal::Intent::new(
        &f.library,
        &stage,
        &path("s/c/new.md"),
        &ContentHash::of(b"new"),
        None,
        &BTreeSet::new(),
        12,
    )
    .unwrap();
    assert!(matches!(
        intent.write(&f.library),
        Err(OperationError::RecoveryRequired { .. })
    ));
    assert!(f.library.layout().scan_journal_file().exists());
    assert!(!journal::path(&f.library).exists());
    assert!(stage.exists());
    assert_eq!(fs::read(from.to_native(f.library.root())).unwrap(), b"keep");
    assert!(!to.to_native(f.library.root()).exists());
}

#[test]
fn a_pending_import_blocks_a_move_before_metadata_or_native_renames() {
    let f = Fixture::new();
    f.existing("moving.md", b"keep");
    let entry = f
        .catalog
        .read(|tx| catalog::entry(tx, &path("s/c/moving.md")))
        .unwrap()
        .unwrap();
    let stage = f.intent("new.md", b"verified", false, &BTreeSet::new());
    assert!(
        f.library
            .rename_entry(&f.catalog, &EntryRef::from(&entry), "moved.md", 12)
            .is_err()
    );
    assert!(journal::path(&f.library).exists());
    assert!(!f.library.layout().scan_journal_file().exists());
    assert!(stage.exists());
    assert_eq!(
        fs::read(f.library.root().join("s/c/moving.md")).unwrap(),
        b"keep"
    );
    assert!(!f.library.root().join("s/c/moved.md").exists());
}

#[test]
fn forged_coexisting_intents_fail_closed_and_preserve_both() {
    let f = Fixture::new();
    let stage = f.intent("new.md", b"verified", false, &BTreeSet::new());
    fs::write(f.library.layout().scan_journal_file(), b"invalid evidence").unwrap();
    assert!(f.library.recover_import(&f.catalog).is_err());
    assert!(journal::path(&f.library).exists());
    assert!(stage.exists());
    assert_eq!(
        fs::read(f.library.layout().scan_journal_file()).unwrap(),
        b"invalid evidence"
    );
    assert!(!f.library.root().join("s/c/new.md").exists());
}

#[test]
fn import_paths_normalize_unicode_and_detect_case_and_nfc_clashes() {
    let f = Fixture::new();
    f.existing("Report.md", b"old");
    let source = f.source_file("report.md", b"new");
    let check = f
        .library
        .check_import(&f.catalog, std::slice::from_ref(&source), &f.target())
        .unwrap();
    assert_eq!(check.conflicts, ["s/c/Report.md"]);
    let report = f.run(
        &f.request(vec![source], Conflict::Replace),
        &Trash::new(None),
    );
    assert_eq!((report.imported, report.replaced), (1, 1));
    assert_eq!(
        fs::read(f.library.root().join("s/c/Report.md")).unwrap(),
        b"new"
    );

    let decomposed = "e\u{301}.md";
    let normalized = "é.md";
    let source = f.source_file(decomposed, b"unicode");
    assert_eq!(
        f.run(
            &f.request(vec![source], Conflict::KeepBoth),
            &Trash::new(None)
        )
        .imported,
        1
    );
    assert_eq!(
        fs::read(f.library.root().join("s/c").join(normalized)).unwrap(),
        b"unicode"
    );
    fs::remove_file(f.library.root().join("s/c").join(normalized)).unwrap();
    fs::write(
        f.library.root().join("s/c").join(decomposed),
        b"existing decomposition",
    )
    .unwrap();
    let request = f.request(
        vec![f.source_file(normalized, b"another")],
        Conflict::Replace,
    );
    let report = f.run(&request, &Trash::new(None));
    assert_eq!((report.imported, report.failure_count), (0, 1));
    assert!(matches!(
        report.failures[0].1,
        OperationError::AlreadyExists
    ));
    assert_eq!(
        fs::read(f.library.root().join("s/c").join(decomposed)).unwrap(),
        b"existing decomposition"
    );
}

#[test]
fn tampered_stage_or_library_identity_cannot_publish_outside_paths() {
    for field in ["stage", "library"] {
        let f = Fixture::new();
        let stage = f.intent("new.md", b"verified", false, &BTreeSet::new());
        let evidence = journal::path(&f.library);
        let mut encoded: serde_json::Value =
            serde_json::from_slice(&fs::read(&evidence).unwrap()).unwrap();
        encoded[field] = serde_json::json!(if field == "stage" {
            "../outside.md"
        } else {
            "00000000000000000000000000000000"
        });
        fs::write(&evidence, serde_json::to_vec(&encoded).unwrap()).unwrap();
        assert!(f.library.recover_import(&f.catalog).is_err());
        assert!(evidence.exists());
        assert!(stage.exists());
        assert!(!f.library.root().join("s/c/new.md").exists());
    }
}

#[test]
fn a_target_replaced_by_a_junction_is_rejected_before_writes() {
    let f = Fixture::new();
    let request = f.request(vec![f.source_file("new.md", b"new")], Conflict::KeepBoth);
    let outside = f.temp.path().join("outside");
    fs::create_dir(&outside).unwrap();
    fs::write(outside.join("sentinel.md"), b"outside").unwrap();
    let target = f.library.root().join("s").join("c");
    fs::rename(&target, f.library.root().join("s").join("saved")).unwrap();
    let created = std::process::Command::new("cmd")
        .args(["/C", "mklink", "/J"])
        .arg(&target)
        .arg(&outside)
        .output()
        .unwrap();
    assert!(created.status.success(), "{created:?}");
    let result = f.library.validate_import(&f.catalog, &request);
    fs::remove_dir(&target).unwrap();
    assert!(result.is_err());
    assert!(!outside.join("new.md").exists());
    assert_eq!(fs::read(outside.join("sentinel.md")).unwrap(), b"outside");
}

#[test]
fn an_empty_folder_is_copied_and_tagged_without_counting_a_file() {
    let f = Fixture::new();
    let mut request = f.request(vec![f.source_folder("empty", &[])], Conflict::KeepBoth);
    request.tags = tags(["notes"]);
    let mut totals = Vec::new();
    let result = f
        .library
        .import_files(
            &f.catalog,
            &request,
            &Trash::new(None),
            12,
            &AtomicBool::new(false),
            &mut |progress| totals.push((progress.total, progress.total_bytes)),
            &mut |_| {},
        )
        .unwrap();
    assert_eq!((result.imported, result.failure_count), (0, 0));
    assert!(f.library.root().join("s/c/empty").is_dir());
    assert_eq!(f.authored().get(&path("empty")), Some(&tags(["notes"])));
    assert!(totals.iter().all(|total| *total == (0, 0)));
}

#[test]
fn a_selected_junction_is_skipped_and_never_followed_or_recycled() {
    let f = Fixture::new();
    let outside = f.temp.path().join("outside");
    fs::create_dir(&outside).unwrap();
    fs::write(outside.join("sentinel.md"), b"outside").unwrap();
    let link = f.temp.path().join("selection");
    let created = std::process::Command::new("cmd")
        .args(["/C", "mklink", "/J"])
        .arg(&link)
        .arg(&outside)
        .output()
        .unwrap();
    assert!(created.status.success(), "{created:?}");
    let source = Source::select(link.clone()).unwrap();
    assert_eq!(source.kind(), EntryKind::File);
    let mut request = f.request(vec![source], Conflict::KeepBoth);
    request.delete_originals = true;
    let trash = Trash::new(None);
    let result = f.run(&request, &trash);
    fs::remove_dir(&link).unwrap();
    assert_eq!(
        (result.imported, result.skipped, result.originals_deleted),
        (0, 1, 0)
    );
    assert_eq!(trash.next.load(Ordering::Relaxed), 0);
    assert_eq!(fs::read(outside.join("sentinel.md")).unwrap(), b"outside");
}

struct FailingFs {
    base: Arc<dyn FileSystem>,
    fail: Option<PathBuf>,
}

impl FileSystem for FailingFs {
    fn read_dir(&self, folder: &Path) -> io::Result<Vec<DirEntry>> {
        self.base.read_dir(folder)
    }
    fn metadata(&self, path: &Path) -> io::Result<Metadata> {
        self.base.metadata(path)
    }
    fn open(&self, path: &Path) -> io::Result<Box<dyn Read + '_>> {
        if self.fail.as_ref().is_none_or(|fail| path == fail) {
            return Ok(Box::new(FailingRead { first: true }));
        }
        self.base.open(path)
    }
}

struct FailingRead {
    first: bool,
}
impl Read for FailingRead {
    fn read(&mut self, bytes: &mut [u8]) -> io::Result<usize> {
        if self.first {
            self.first = false;
            bytes[0] = b'n';
            Ok(1)
        } else {
            Err(io::Error::from_raw_os_error(112))
        }
    }
}

#[test]
fn partial_copy_failure_keeps_the_old_file_and_other_batch_successes() {
    let f = Fixture::new();
    f.existing("bad.md", b"old");
    let mut bad = f.source_file("bad.md", b"new");
    bad.fs = Arc::new(FailingFs {
        base: Arc::clone(&bad.fs),
        fail: Some(bad.path.clone()),
    });
    let good = f.source_file("good.md", b"good");
    let request = f.request(vec![bad.clone(), good], Conflict::Replace);
    let trash = Trash::new(None);
    let result = f.run(&request, &trash);
    assert_eq!((result.imported, result.failure_count), (1, 1));
    assert!(
        matches!(&result.failures[0].1, OperationError::Io { source, .. } if source.raw_os_error() == Some(112))
    );
    assert_eq!(
        fs::read(f.library.root().join("s/c/bad.md")).unwrap(),
        b"old"
    );
    assert_eq!(
        fs::read(f.library.root().join("s/c/good.md")).unwrap(),
        b"good"
    );
    assert!(bad.path().exists());
    assert_eq!(trash.next.load(Ordering::Relaxed), 0);
    assert!(!journal::path(&f.library).exists());
    assert_eq!(
        fs::read_dir(f.library.layout().staging_dir())
            .unwrap()
            .count(),
        0
    );
}

#[test]
fn failed_stage_cleanup_does_not_replace_the_copy_error() {
    let f = Fixture::new();
    f.existing("bad.md", b"old");
    let mut source = f.source_file("bad.md", b"new");
    source.fs = Arc::new(FailingFs {
        base: Arc::clone(&source.fs),
        fail: Some(source.path.clone()),
    });
    let request = f.request(vec![source.clone()], Conflict::Replace);
    let bin = Trash::new(None);
    let mut held = None;
    let report = f
        .library
        .import_files(
            &f.catalog,
            &request,
            &bin,
            12,
            &AtomicBool::new(false),
            &mut |progress| {
                if held.is_none() && progress.bytes == 1 {
                    let stage = fs::read_dir(f.library.layout().staging_dir())
                        .unwrap()
                        .map(|entry| entry.unwrap().path())
                        .find(|path| {
                            path.extension()
                                .is_some_and(|extension| extension == "part")
                        })
                        .unwrap();
                    let file = fs::OpenOptions::new()
                        .read(true)
                        .share_mode(3)
                        .open(&stage)
                        .unwrap();
                    held = Some((stage, file));
                }
            },
            &mut |_| {},
        )
        .unwrap();
    assert_eq!((report.imported, report.failure_count), (0, 1));
    assert!(matches!(
        &report.failures[0].1,
        OperationError::Io { source, .. } if source.raw_os_error() == Some(112)
    ));
    let (stage, file) = held.unwrap();
    assert!(stage.exists());
    assert!(!journal::path(&f.library).exists());
    assert_eq!(
        fs::read(f.library.root().join("s/c/bad.md")).unwrap(),
        b"old"
    );
    assert!(source.path().exists());
    assert_eq!(bin.next.load(Ordering::Relaxed), 0);
    drop(file);
    assert_eq!(fs::read(&stage).unwrap(), b"n");
    fs::remove_file(stage).unwrap();
}

#[test]
fn failure_details_are_capped_while_the_total_counts_every_file() {
    let f = Fixture::new();
    let root = f.temp.path().join("sources/batch");
    fs::create_dir_all(&root).unwrap();
    for number in 0..105 {
        fs::write(root.join(format!("{number}.md")), b"new").unwrap();
    }
    let mut source = Source::select(root).unwrap();
    source.fs = Arc::new(FailingFs {
        base: Arc::clone(&source.fs),
        fail: None,
    });
    let report = f.run(
        &f.request(vec![source.clone()], Conflict::KeepBoth),
        &Trash::new(None),
    );
    assert_eq!(
        (report.imported, report.failure_count, report.failures.len()),
        (0, 105, 100)
    );
    assert_eq!(fs::read_dir(source.path()).unwrap().count(), 105);
    assert!(!journal::path(&f.library).exists());
}

#[test]
fn reconciliation_survives_capped_failures_after_a_recycled_replacement_is_abandoned() {
    struct ArrivalTrash(Trash);
    impl RecycleBin for ArrivalTrash {
        fn recycle(&self, native: &Path) -> Result<Recycled, RecycleError> {
            let recycled = self.0.recycle(native)?;
            fs::write(native, b"external arrival").map_err(|error| {
                RecycleError::new(native, RecycleFailure::Other, error.to_string())
            })?;
            Ok(recycled)
        }
    }

    let f = Fixture::new();
    let root = f.temp.path().join("sources/failing");
    fs::create_dir_all(&root).unwrap();
    for number in 0..RESULTS {
        fs::write(root.join(format!("{number}.md")), b"new").unwrap();
    }
    let mut failing = Source::select(root).unwrap();
    failing.fs = Arc::new(FailingFs {
        base: Arc::clone(&failing.fs),
        fail: None,
    });
    f.existing("late.md", b"old");
    let late = f.source_file("late.md", b"replacement");
    let trash = ArrivalTrash(Trash::new(None));
    let report = f
        .library
        .import_files(
            &f.catalog,
            &f.request(vec![failing, late.clone()], Conflict::Replace),
            &trash,
            12,
            &AtomicBool::new(false),
            &mut |_| {},
            &mut |_| {},
        )
        .unwrap();
    assert_eq!(
        (report.failure_count, report.failures.len()),
        (101, RESULTS)
    );
    assert!(report.needs_reconciliation);
    assert!(
        report
            .failures
            .iter()
            .all(|(_, error)| !matches!(error, OperationError::DiskChanged { .. }))
    );
    assert_eq!(
        fs::read(f.library.root().join("s/c/late.md")).unwrap(),
        b"external arrival"
    );
    assert_eq!(fs::read(trash.0.temp.path().join("0")).unwrap(), b"old");
    assert_eq!(fs::read(late.path()).unwrap(), b"replacement");
    assert!(!journal::path(&f.library).exists());
}

struct PlaceholderFs {
    base: Arc<dyn FileSystem>,
    placeholder: PathBuf,
}

impl FileSystem for PlaceholderFs {
    fn read_dir(&self, folder: &Path) -> io::Result<Vec<DirEntry>> {
        self.base.read_dir(folder)
    }
    fn metadata(&self, path: &Path) -> io::Result<Metadata> {
        let mut metadata = self.base.metadata(path)?;
        if path == self.placeholder {
            metadata.presence = Presence::Placeholder;
        }
        Ok(metadata)
    }
    fn open(&self, path: &Path) -> io::Result<Box<dyn Read + '_>> {
        assert_ne!(
            path, self.placeholder,
            "a placeholder must never be hydrated by import"
        );
        self.base.open(path)
    }
}

#[test]
fn a_nonlocal_source_is_reported_without_opening_or_hydrating_it() {
    let f = Fixture::new();
    let mut source = f.source_file("offline.md", b"untouched");
    source.selected.presence = Presence::Placeholder;
    source.fs = Arc::new(PlaceholderFs {
        base: Arc::clone(&source.fs),
        placeholder: source.path.clone(),
    });
    assert!(matches!(
        f.library
            .check_import(&f.catalog, &[source.clone()], &f.target()),
        Err(OperationError::NotLocal { .. })
    ));
    let report = f.run(
        &f.request(vec![source.clone()], Conflict::KeepBoth),
        &Trash::new(None),
    );
    assert_eq!((report.imported, report.failure_count), (0, 1));
    assert!(matches!(
        &report.failures[0].1,
        OperationError::NotLocal { .. }
    ));
    assert!(source.path().exists());
    assert!(!f.library.root().join("s/c/offline.md").exists());
}

#[test]
fn a_disk_full_writer_stops_the_copy_before_intent_publication() {
    struct FullDisk {
        left: usize,
    }
    impl Write for FullDisk {
        fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
            if self.left == 0 {
                return Err(io::Error::from_raw_os_error(112));
            }
            let written = bytes.len().min(self.left);
            self.left -= written;
            Ok(written)
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }
    let mut state = Progress::default();
    let result = copy_bytes(
        &mut &b"a file larger than the free disk space"[..],
        &mut FullDisk { left: 3 },
        &AtomicBool::new(false),
        &mut state,
        &mut |_| {},
    );
    assert_eq!(result.unwrap_err().raw_os_error(), Some(112));
    assert_eq!(state.bytes, 0);
}

#[test]
fn an_in_use_source_is_retained_and_no_destination_is_published() {
    let f = Fixture::new();
    let source = f.source_file("locked.md", b"keep");
    let request = f.request(vec![source.clone()], Conflict::KeepBoth);
    let held = fs::OpenOptions::new()
        .read(true)
        .share_mode(0)
        .open(source.path())
        .unwrap();
    let result = f.library.import_files(
        &f.catalog,
        &request,
        &Trash::new(None),
        12,
        &AtomicBool::new(false),
        &mut |_| {},
        &mut |_| {},
    );
    drop(held);
    match result {
        Err(OperationError::InUse { .. }) => {}
        Ok(report) => assert!(
            report
                .failures
                .iter()
                .any(|(_, error)| matches!(error, OperationError::InUse { .. }))
        ),
        other => panic!("expected InUse, got {other:?}"),
    }
    assert_eq!(fs::read(source.path()).unwrap(), b"keep");
    assert!(!f.library.root().join("s/c/locked.md").exists());
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(8))]

    #[test]
    fn keep_both_preserves_existing_bytes_and_imported_is_the_renamed_superset(name in "[a-z]{1,12}") {
        let f = Fixture::new();
        let filename = format!("{name}.md");
        f.existing(&filename, b"existing");
        let request = f.request(vec![f.source_file(&filename, b"new")], Conflict::KeepBoth);
        let report = f.run(&request, &Trash::new(None));
        prop_assert_eq!((report.imported, report.renamed, report.replaced), (1, 1, 0));
        prop_assert_eq!(fs::read(f.library.root().join("s/c").join(&filename)).unwrap(), b"existing".to_vec());
        prop_assert_eq!(fs::read(f.library.root().join("s/c").join(format!("{name} (2).md"))).unwrap(), b"new".to_vec());
    }
}
