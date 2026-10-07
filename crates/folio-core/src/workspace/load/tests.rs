use super::*;
use crate::fs::Presence;
use crate::meta::{Abbr, Color, CourseCode, CourseSettings, DisplayName, EntryKind, TagDefinition};
use crate::store::ChangeOp;
use crate::test_support::tags;
use crate::workspace::head::Bounds;
use crate::workspace::testing::{CancelAt, Fixture, described, pairing, write_head};
use crate::workspace::{Fingerprint, HistoryStatus, MetadataChange, Readiness, Subject, Totals};

const COURSE: &str = "2026 秋/线代";

fn course(code: &str, order: u32) -> CourseSettings {
    CourseSettings {
        abbr: Some(Abbr::parse("线代").unwrap()),
        archived: false,
        code: Some(CourseCode::parse(code).unwrap()),
        color: Some(Color::parse("blue").unwrap()),
        order,
    }
}

/// A library with a course, tags and settings, committed whole.
fn committed() -> (Fixture, HeadState) {
    let f = Fixture::new();
    f.fs.file("2026 秋/线代/第1讲.md", b"# lecture 1");
    f.fs.file("2026 秋/线代/hw1.pdf", b"homework");
    f.fs.file("2026 秋/线代/notes/a.md", b"a");
    f.fs.file("2026 秋/数据结构/lab.docx", b"lab");
    f.fs.file("readme.txt", b"read me");
    f.scan();
    f.set_course(COURSE, course("MAT 223", 1));
    f.set_tags("2026 秋/线代/hw1.pdf", EntryKind::File, tags(["homework"]));
    f.set_tags("readme.txt", EntryKind::File, tags(["reference"]));
    let (_, state) = f.commit_all(None);
    assert_eq!(state.status(), HistoryStatus::Ready);
    (f, state)
}

/// Scans, hashes and loads.
fn refresh(f: &Fixture, state: &HeadState) -> Workspace {
    f.scan();
    f.hash_all();
    f.load(state).workspace
}

fn metadata(workspace: &Workspace) -> Vec<(String, ChangeOp)> {
    workspace
        .metadata()
        .iter()
        .map(|change| (change.key().to_owned(), change.op()))
        .collect()
}

#[test]
fn a_library_right_after_a_commit_lists_nothing() {
    let (f, state) = committed();
    let snapshot = f.load(&state);
    assert!(snapshot.workspace.items().is_empty());
    assert!(snapshot.workspace.metadata().is_empty());
    assert_eq!(snapshot.workspace.totals(), Totals::default());
    assert_eq!(snapshot.workspace.fingerprint(), Fingerprint::default());
    assert_eq!(snapshot.stamp, f.catalog.stamp());
}

#[test]
fn edits_moves_deletions_and_additions_give_their_items() {
    let (f, state) = committed();
    f.fs.file("readme.txt", b"read me, edited");
    f.fs.rename("2026 秋/线代/hw1.pdf", "2026 秋/线代/作业1.pdf");
    f.fs.rename("2026 秋/线代/notes", "2026 秋/线代/笔记");
    f.fs.remove("2026 秋/数据结构/lab.docx");
    f.fs.file("new.md", b"new");
    f.fs.folder("empty");
    let workspace = refresh(&f, &state);
    assert_eq!(
        described(&workspace),
        [
            "delete file 2026 秋/数据结构/lab.docx",
            "move file 2026 秋/线代/作业1.pdf from 2026 秋/线代/hw1.pdf",
            "move folder 2026 秋/线代/笔记 from 2026 秋/线代/notes files 1",
            "add folder empty",
            "add file new.md",
            "modify file readme.txt",
        ]
    );
    let totals = workspace.totals();
    assert_eq!(
        (totals.items, totals.includable, totals.metadata),
        (6, 6, 0)
    );
    // An edit inside the moved folder is an item of its own; a move back is no change.
    f.fs.file("2026 秋/线代/笔记/a.md", b"a, edited");
    f.fs.rename("2026 秋/线代/作业1.pdf", "2026 秋/线代/hw1.pdf");
    let workspace = refresh(&f, &state);
    assert_eq!(
        described(&workspace),
        [
            "delete file 2026 秋/数据结构/lab.docx",
            "move folder 2026 秋/线代/笔记 from 2026 秋/线代/notes",
            "modify file 2026 秋/线代/笔记/a.md",
            "add folder empty",
            "add file new.md",
            "modify file readme.txt",
        ]
    );
}

#[test]
fn readiness_follows_the_hashing_pass() {
    let (f, state) = committed();
    f.fs.file("cloud.md", b"in the cloud");
    f.fs.file("locked.docx", b"in use");
    f.fs.file("fresh.md", b"fresh");
    f.fs.set_presence("cloud.md", Presence::Placeholder);
    f.fs.fail_reading("locked.docx");
    f.scan();
    let workspace = f.load(&state).workspace;
    assert_eq!(
        described(&workspace),
        [
            "add file cloud.md hashing",
            "add file fresh.md hashing",
            "add file locked.docx hashing",
        ]
    );
    let before = workspace.fingerprint();
    f.hash_all();
    let workspace = f.load(&state).workspace;
    assert_eq!(
        described(&workspace),
        [
            "add file cloud.md notLocal",
            "add file fresh.md",
            "add file locked.docx unreadable",
        ]
    );
    let totals = workspace.totals();
    assert_eq!(
        (
            totals.includable,
            totals.hashing,
            totals.not_local,
            totals.unreadable
        ),
        (1, 0, 1, 1)
    );
    assert_ne!(workspace.fingerprint(), before);
    // The disk side of a file that is not local is 0 bytes.
    let cloud = workspace.items()[0].change();
    assert_eq!(cloud.readiness(), Readiness::NotLocal);
    assert_eq!(cloud.after().unwrap().size, 0);
}

#[test]
fn tags_and_settings_changes_follow_the_pairing() {
    let (f, state) = committed();
    // A moved file keeps its tags: no change.
    f.fs.rename("2026 秋/线代/hw1.pdf", "2026 秋/线代/作业1.pdf");
    f.scan();
    let workspace = refresh(&f, &state);
    assert!(workspace.metadata().is_empty());
    assert!(!workspace.items()[0].tags_changed());
    // Tags of an entry with an item are part of it; of one without, a row of their own.
    f.set_tags(
        "2026 秋/线代/作业1.pdf",
        EntryKind::File,
        tags(["homework", "exam"]),
    );
    f.set_tags("2026 秋/线代/第1讲.md", EntryKind::File, tags(["notes"]));
    f.set_tags("readme.txt", EntryKind::File, tags([]));
    f.set_course(COURSE, course("MAT 224", 1));
    let mut definitions = f.layout().read_tags().unwrap().unwrap();
    definitions.tags.insert(
        crate::meta::TagId::parse("mine").unwrap(),
        TagDefinition {
            color: Color::parse("red").unwrap(),
            name: DisplayName::parse("我的").unwrap(),
            order: 9,
        },
    );
    f.layout().write_tags(&definitions).unwrap();
    f.layout().write_ignore("*.tmp\n").unwrap();
    let mut library = f.layout().read_library().unwrap().unwrap();
    library.name = DisplayName::parse("新名字").unwrap();
    f.layout().write_library(&library).unwrap();
    let workspace = refresh(&f, &state);
    assert!(workspace.items()[0].tags_changed());
    assert_eq!(
        metadata(&workspace),
        [
            ("t:2026 秋/线代/第1讲.md".to_owned(), ChangeOp::Add),
            ("t:readme.txt".to_owned(), ChangeOp::Delete),
            (format!("c:{COURSE}"), ChangeOp::Modify),
            ("T:".to_owned(), ChangeOp::Add),
            ("L:".to_owned(), ChangeOp::Modify),
            ("I:".to_owned(), ChangeOp::Add),
        ]
    );
    let Subject::Course(settings) = workspace.metadata()[2].subject() else {
        panic!("a course's settings");
    };
    assert_eq!(settings.folder, Some(f.entry(COURSE).id));
    assert_eq!(workspace.totals().metadata, 6);
}

#[test]
fn metadata_files_that_cannot_be_read_keep_their_committed_content() {
    let (f, state) = committed();
    // Changed and mirrored, then broken: the catalog keeps what the files gave it last.
    f.set_course(COURSE, course("MAT 224", 2));
    let mut definitions = f.layout().read_tags().unwrap().unwrap();
    definitions.tags.clear();
    f.layout().write_tags(&definitions).unwrap();
    let mut library = f.layout().read_library().unwrap().unwrap();
    library.name = DisplayName::parse("新名字").unwrap();
    f.layout().write_library(&library).unwrap();
    let workspace = refresh(&f, &state);
    let keys: Vec<String> = metadata(&workspace)
        .into_iter()
        .map(|(key, _)| key)
        .collect();
    assert_eq!(keys, [format!("c:{COURSE}"), "T:".into(), "L:".into()]);
    let course_file = f
        .layout()
        .tag_file_path(&crate::meta::TagFile::Course(
            crate::test_support::course_at(COURSE),
        ))
        .unwrap();
    for file in [
        course_file,
        f.layout().tags_file(),
        f.layout().library_file(),
    ] {
        std::fs::write(file, b"not json").unwrap();
    }
    let workspace = f.load(&state).workspace;
    assert!(
        workspace.metadata().is_empty(),
        "{:?}",
        metadata(&workspace)
    );
}

#[test]
fn a_deleted_course_keeps_its_committed_settings_as_a_deletion() {
    let (f, state) = committed();
    f.fs.remove(COURSE);
    let workspace = refresh(&f, &state);
    let rows: Vec<&MetadataChange> = workspace.metadata().iter().collect();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].key(), format!("cg:{COURSE}"));
    assert_eq!(rows[0].op(), ChangeOp::Delete);
    assert_eq!(
        described(&workspace),
        [format!("delete folder {COURSE} files 3")]
    );
}

#[test]
fn a_file_deleted_and_created_again_pairs_again_when_loaded() {
    let (f, state) = committed();
    f.fs.remove("readme.txt");
    let workspace = refresh(&f, &state);
    assert_eq!(described(&workspace), ["delete file readme.txt"]);
    f.fs.file("readme.txt", b"read me");
    f.scan();
    let revision = f.catalog.stamp().revision;
    let snapshot = f.load(&state);
    // Paired by the load's write, which the snapshot's read follows.
    assert_eq!(snapshot.stamp.revision, revision + 1);
    assert!(snapshot.workspace.items().is_empty());
    assert!(
        pairing(&f.catalog).contains(&("readme.txt".to_owned(), Some("readme.txt".to_owned())))
    );
    // The tags file still names the path, so the new file has the row's tags again.
    assert!(snapshot.workspace.metadata().is_empty());
}

#[test]
fn case_only_renames_are_moves_with_file_ids_and_bound_otherwise() {
    let (f, state) = committed();
    f.fs.rename("readme.txt", "README.txt");
    let workspace = refresh(&f, &state);
    assert_eq!(
        described(&workspace),
        ["move file README.txt from readme.txt"]
    );

    let (f, state) = committed();
    f.fs.without_id("readme.txt");
    f.scan();
    f.fs.rename("readme.txt", "README.txt");
    let workspace = refresh(&f, &state);
    assert_eq!(
        described(&workspace),
        ["add file README.txt + delete file readme.txt"]
    );
}

#[test]
fn after_a_catalog_rebuild_moves_show_as_deletions_and_additions() {
    let (f, _) = committed();
    f.fs.rename("readme.txt", "moved.txt");
    f.scan();
    f.library.reset_catalog(&f.catalog).unwrap();
    f.scan();
    f.hash_all();
    let state = f.sync_forced();
    assert_eq!(state.status(), HistoryStatus::Ready);
    let workspace = f.load(&state).workspace;
    assert_eq!(
        described(&workspace),
        ["add file moved.txt", "delete file readme.txt"]
    );
}

#[test]
fn a_load_for_another_head_is_refused() {
    let (f, old) = committed();
    f.fs.file("new.md", b"new");
    f.commit_all(old.head());
    assert!(matches!(
        Workspace::load(&f.catalog, f.layout(), &old, &AtomicBool::new(false)),
        Err(LoadError::HeadChanged)
    ));
}

#[test]
fn without_head_files_the_workspace_lists_nothing() {
    let f = Fixture::new();
    f.fs.file("a.md", b"a");
    f.scan();
    let none = f.sync();
    assert_eq!(none.status(), HistoryStatus::None);
    let snapshot = f.load(&none);
    assert_eq!(snapshot.workspace, Workspace::empty());
    assert_eq!(snapshot.stamp, f.catalog.stamp());

    f.hash_all();
    write_head(&f.store(), &f.disk_tree(), None, &|_| false);
    let too_large = f.sync_within(Bounds {
        entries: 2,
        ..Bounds::DEFAULT
    });
    assert_eq!(too_large.status(), HistoryStatus::TooLarge);
    f.fs.file("b.md", b"b");
    f.scan();
    assert_eq!(f.load(&too_large).workspace, Workspace::empty());
}

#[test]
fn while_head_metadata_does_not_read_only_items_are_listed() {
    let (f, _) = committed();
    let mut tree = f.disk_tree();
    tree.put(".folio/tags.json", br#"{"format_version":99}"#.to_vec());
    write_head(&f.store(), &tree, None, &|_| false);
    let state = f.sync();
    assert_eq!(state.status(), HistoryStatus::ReadOnly);
    f.fs.file("readme.txt", b"read me, edited");
    f.set_course(COURSE, course("MAT 224", 1));
    let workspace = refresh(&f, &state);
    assert_eq!(described(&workspace), ["modify file readme.txt"]);
    assert!(workspace.metadata().is_empty());
}

/// What the workspace reads of `.folio/` beside the catalog moves the catalog revision when it
/// changes, so that two loads at one revision list the same workspace (versioning.md §6.5).
#[test]
fn files_read_beside_the_catalog_move_the_revision_when_they_change() {
    let (f, state) = committed();
    let first = f.load(&state);
    let again = f.load(&state);
    assert_eq!(
        again.stamp.revision, first.stamp.revision,
        "nothing changed"
    );
    assert_eq!(again.workspace, first.workspace);

    let mut seen = vec![first.stamp.revision];
    let mut load = |what: &str| {
        let snapshot = f.load(&state);
        assert!(
            !seen.contains(&snapshot.stamp.revision),
            "{what}: revision {} again",
            snapshot.stamp.revision
        );
        seen.push(snapshot.stamp.revision);
        assert_eq!(f.load(&state).stamp, snapshot.stamp, "{what}: loaded again");
        metadata(&snapshot.workspace)
            .into_iter()
            .map(|(key, _)| key)
            .collect::<Vec<_>>()
    };
    f.layout().write_ignore("*.tmp\n").unwrap();
    assert_eq!(load("the ignore rules"), ["I:"]);
    let mut library = f.layout().read_library().unwrap().unwrap();
    library.versioning.text_max_size = 4;
    f.layout().write_library(&library).unwrap();
    assert_eq!(load("the library settings"), ["L:", "I:"]);
    std::fs::write(f.layout().tags_file(), b"not json").unwrap();
    assert_eq!(load("tag definitions that do not read"), ["L:", "I:"]);

    // A course file that stops reading, and reads again: the catalog's mirror keeps what it gave,
    // so only the list of the files that cannot be read moves the revision.
    f.set_course(COURSE, course("MAT 224", 1));
    f.scan();
    let course_changed = vec![format!("c:{COURSE}"), "L:".into(), "I:".into()];
    assert_eq!(load("a course's settings"), course_changed);
    let file = f
        .layout()
        .tag_file_path(&TagFile::Course(crate::test_support::course_at(COURSE)))
        .unwrap();
    let saved = std::fs::read(&file).unwrap();
    std::fs::write(&file, b"not json").unwrap();
    f.scan();
    assert_eq!(load("a course file that does not read"), ["L:", "I:"]);
    std::fs::write(&file, saved).unwrap();
    f.scan();
    assert_eq!(load("the course file read again"), course_changed);
}

#[test]
fn a_cancelled_load_stops_before_it_reads() {
    let (f, state) = committed();
    let cancelled = Workspace::load(&f.catalog, f.layout(), &state, &AtomicBool::new(true));
    assert!(matches!(cancelled, Err(LoadError::Cancelled)));
}

/// A load that writes the digest of `.folio/` and pairs a file deleted and created again asks
/// whether to stop five times: before it reads the disk, before each of its two writes, before it
/// reads the catalog and before it derives the workspace; cancelled at any of them, it stops there,
/// with only the writes whose own questions came before.
#[test]
fn a_load_stops_at_whichever_question_it_is_cancelled() {
    let recreated = || {
        let (f, state) = committed();
        f.fs.remove("readme.txt");
        f.scan();
        f.fs.file("readme.txt", b"read me");
        f.scan();
        (f, state)
    };
    // The digest's write follows the second question, the pairing's the fourth.
    let writes_before = |at: usize| [2, 4].into_iter().filter(|&question| question < at).count();
    let (f, state) = recreated();
    let revision = f.catalog.stamp().revision;
    let never = CancelAt::new(usize::MAX);
    let snapshot = Workspace::load_asking(&f.catalog, f.layout(), &state, &never).unwrap();
    assert!(snapshot.workspace.items().is_empty(), "paired again");
    assert_eq!(never.asked.get(), 5);
    assert_eq!(
        usize::try_from(f.catalog.stamp().revision - revision).unwrap(),
        writes_before(usize::MAX)
    );
    for at in 1..=5 {
        let (f, state) = recreated();
        let revision = f.catalog.stamp().revision;
        let cancel = CancelAt::new(at);
        let loaded = Workspace::load_asking(&f.catalog, f.layout(), &state, &cancel);
        assert!(
            matches!(loaded, Err(LoadError::Cancelled)),
            "cancelled at question {at}: {loaded:?}"
        );
        assert_eq!(cancel.asked.get(), at);
        assert_eq!(
            usize::try_from(f.catalog.stamp().revision - revision).unwrap(),
            writes_before(at),
            "writes before question {at}"
        );
    }
}

/// A link in `.folio/` is refused before anything there is read, as every reader of the
/// metadata refuses it.
#[test]
fn a_link_in_folio_is_refused_before_it_is_read() {
    let (f, state) = committed();
    let outside = tempfile::tempdir().unwrap();
    std::fs::write(outside.path().join("_root.json"), b"{}").unwrap();
    let meta = f.layout().meta_dir();
    std::fs::rename(&meta, meta.with_file_name("meta-saved")).unwrap();
    let created = std::process::Command::new("cmd")
        .args(["/C", "mklink", "/J"])
        .arg(&meta)
        .arg(outside.path())
        .output()
        .unwrap();
    assert!(created.status.success(), "{created:?}");
    let loaded = Workspace::load(&f.catalog, f.layout(), &state, &AtomicBool::new(false));
    std::fs::remove_dir(&meta).unwrap();
    assert!(matches!(loaded, Err(LoadError::Meta(_))), "{loaded:?}");
}

/// A crafted `HEAD` whose tree holds a chain of thousands of nested folders the disk does not
/// have: its first refresh lists one deleted folder, in time that follows the bytes of the paths.
/// Finding the outermost deleted folders through an owned copy of every ancestor took the depth
/// cubed: 5 s at this depth in a release build and about 50 in a debug one, minutes at the 5,800
/// `head_files` keeps; now 0.2 s and 3 s.
#[test]
fn a_deleted_chain_of_thousands_of_folders_is_one_item_found_in_time() {
    let f = Fixture::new();
    f.fs.file("readme.txt", b"read me");
    f.scan();
    f.hash_all();
    let mut tree = f.disk_tree();
    let mut at = String::from("c");
    for _ in 0..4_000 {
        tree.rows.insert(at.clone(), None);
        at.push_str("/c");
    }
    write_head(&f.store(), &tree, None, &|_| false);
    let state = f.sync();
    assert_eq!(state.status(), HistoryStatus::Ready);
    let started = std::time::Instant::now();
    let workspace = f.load(&state).workspace;
    let took = started.elapsed();
    assert_eq!(described(&workspace), ["delete folder c"]);
    assert!(
        took < std::time::Duration::from_secs(20),
        "a 4,000-deep chain took {took:?}"
    );
}
