//! The four workspace commands against libraries in temporary folders with a `HEAD` written
//! through folio-core's store (ipc-m2.md §6, §18 "each implementation lane").

use std::collections::BTreeSet;
use std::fs;
use std::os::windows::fs::OpenOptionsExt;

use folio_core::meta::{
    CourseCode, CourseMeta, CourseSettings, GroupMeta, GroupSettings, LibraryConfig, TagId,
    VersioningRules,
};
use folio_core::paths::{CoursePath, RelPath, SemesterPath};
use folio_core::workspace::Readiness as CoreReadiness;

use super::read::{items, metadata, readiness, summarize, summary};
use crate::error::AppError;
use crate::ipc::entries::RenameEntry;
use crate::ipc::history::ChangeKind;
use crate::ipc::types::{EntryKind, EntryRef, FileClass, LIMITS, PageRequest};
use crate::ipc::workspace::{
    ChangeCounts, HistoryState, ItemPart, ItemSide, ListMetadataChanges, ListWorkspaceItems,
    MetadataSubject, Place, Readiness, Selection, SummarizeSelection, WorkspaceItem,
};
use crate::library::workspace::testing::Fixture;
use crate::open::tests::set_offline;

const ZEROS: &str = "00000000000000000000000000000000";

fn page(offset: u32, limit: u32) -> PageRequest {
    PageRequest { offset, limit }
}

fn all_items(f: &Fixture) -> Vec<WorkspaceItem> {
    items(
        &f.state,
        ListWorkspaceItems {
            page: page(0, LIMITS.page_size),
        },
    )
    .unwrap()
    .items
}

fn all_except(keys: &[&str], fingerprint: &str) -> SummarizeSelection {
    SummarizeSelection {
        selection: Selection::AllExcept {
            keys: keys.iter().map(|key| (*key).to_owned()).collect(),
        },
        fingerprint: fingerprint.to_owned(),
    }
}

fn only(keys: &[&str], fingerprint: &str) -> SummarizeSelection {
    SummarizeSelection {
        selection: Selection::Only {
            keys: keys.iter().map(|key| (*key).to_owned()).collect(),
        },
        fingerprint: fingerprint.to_owned(),
    }
}

fn tags<const N: usize>(ids: [&str; N]) -> BTreeSet<TagId> {
    ids.into_iter()
        .map(|id| TagId::parse(id).unwrap())
        .collect()
}

fn rel(path: &str) -> RelPath {
    RelPath::parse(path).unwrap()
}

fn counts(added: u32, modified: u32, deleted: u32, moved: u32) -> ChangeCounts {
    ChangeCounts {
        added,
        modified,
        deleted,
        moved,
    }
}

fn side(size: &str, stored: bool) -> Option<ItemSide> {
    Some(ItemSide {
        size: size.to_owned(),
        stored,
    })
}

fn invalid(result: Result<impl std::fmt::Debug, AppError>) {
    assert!(
        matches!(result, Err(AppError::InvalidArgument(_))),
        "{result:?}"
    );
}

/// Over `batch` keys, and a key over `keyChars` characters.
fn oversized() -> [SummarizeSelection; 2] {
    let many = vec!["k".to_owned(); LIMITS.batch as usize + 1];
    let long = "字".repeat(LIMITS.key_chars as usize + 1);
    [
        SummarizeSelection {
            selection: Selection::Only { keys: many },
            fingerprint: ZEROS.to_owned(),
        },
        SummarizeSelection {
            selection: Selection::AllExcept { keys: vec![long] },
            fingerprint: "stale".to_owned(),
        },
    ]
}

#[test]
fn limits_come_before_no_library_and_no_library_before_the_rest() {
    let f = Fixture::without_library();
    invalid(items(
        &f.state,
        ListWorkspaceItems {
            page: page(0, LIMITS.page_size + 1),
        },
    ));
    invalid(metadata(
        &f.state,
        ListMetadataChanges {
            page: page(0, LIMITS.page_size + 1),
        },
    ));
    for request in oversized() {
        invalid(summarize(&f.state, request));
    }
    let no_library = |result: Result<_, AppError>| {
        assert!(matches!(result, Err(AppError::NoLibrary(_))), "{result:?}");
    };
    no_library(summary(&f.state).map(|_| ()));
    no_library(items(&f.state, ListWorkspaceItems { page: page(0, 10) }).map(|_| ()));
    no_library(metadata(&f.state, ListMetadataChanges { page: page(0, 10) }).map(|_| ()));
    no_library(summarize(&f.state, all_except(&[], ZEROS)).map(|_| ()));
}

#[test]
fn a_library_without_history_lists_nothing() {
    let f = Fixture::new();
    f.write("Fall/MAT232/notes.md", b"notes\n");
    f.open();
    let summary = summary(&f.state).unwrap();
    assert_eq!(summary.history_state, HistoryState::None);
    assert_eq!(summary.head, None);
    assert_eq!(summary.fingerprint, ZEROS);
    assert_eq!(
        (
            summary.items,
            summary.metadata,
            summary.includable,
            summary.hashing,
            summary.not_local,
            summary.unreadable
        ),
        (0, 0, 0, 0, 0, 0)
    );
    let listed = items(&f.state, ListWorkspaceItems { page: page(0, 10) }).unwrap();
    assert_eq!((listed.items.len(), listed.total, listed.offset), (0, 0, 0));
    assert_eq!(listed.revision, summary.revision);
    assert_eq!(
        metadata(&f.state, ListMetadataChanges { page: page(0, 10) },)
            .unwrap()
            .total,
        0
    );
    let selection = summarize(&f.state, all_except(&[], ZEROS)).unwrap();
    assert_eq!((selection.items, selection.metadata), (0, 0));
    assert!(selection.groups.is_empty());
    assert!(matches!(
        summarize(&f.state, all_except(&[], "1")),
        Err(AppError::WorkspaceChanged(_))
    ));
}

/// The library of the conversion tests, open, with the file `locked.md` held by another program
/// while it was hashed (the handle is returned) and `cloud.md` offline. `HEAD` was committed under
/// rules that store text files of at most 16 bytes; the disk's are the defaults.
fn changed_library(f: &Fixture) -> fs::File {
    let layout = f.layout();
    let config = layout.read_library().unwrap().unwrap();
    layout
        .write_library(&LibraryConfig {
            versioning: VersioningRules {
                text_max_size: 16,
                ..VersioningRules::default()
            },
            ..config.clone()
        })
        .unwrap();
    for (path, bytes) in [
        ("root.md", &b"root\n"[..]),
        ("Fall/loose.md", b"loose\n"),
        ("Fall/rules.md", b"twenty bytes of text"),
        ("Fall/MAT232/notes.md", b"notes v1\n"),
        ("Fall/MAT232/old.md", b"old\n"),
        ("Fall/MAT232/plain.md", b"plain\n"),
        ("Fall/MAT232/A.md", b"a\n"),
        ("Fall/MAT232/B.md", b"b\n"),
        ("Fall/MAT232/Lectures/l1.md", b"lecture 1\n"),
    ] {
        f.write(path, bytes);
    }
    f.commit(None);

    layout
        .write_library(&LibraryConfig {
            versioning: VersioningRules::default(),
            ..config
        })
        .unwrap();
    f.write("Fall/MAT232/notes.md", b"notes v2, longer\n");
    f.write("Fall/rules.md", b"twenty-one bytes, now");
    fs::remove_file(f.native("Fall/MAT232/old.md")).unwrap();
    fs::remove_file(f.native("Fall/MAT232/A.md")).unwrap();
    f.write("Winter/new.docx", b"not really a Word document");
    f.write("cloud.md", b"in the cloud\n");
    set_offline(&f.native("cloud.md"), true);
    f.write("locked.md", b"held by another program\n");
    fs::create_dir(f.native("Empty")).unwrap();
    let mut course = CourseMeta {
        course: Some(CourseSettings {
            abbr: None,
            archived: false,
            code: Some(CourseCode::parse("MAT232").unwrap()),
            color: None,
            order: 0,
        }),
        tags: Default::default(),
    };
    course.tags.set(rel("notes.md"), tags(["notes"]));
    course.tags.set(rel("plain.md"), tags(["homework"]));
    layout
        .write_course_meta(&CoursePath::new(rel("Fall/MAT232")).unwrap(), &course)
        .unwrap();
    let locked = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .share_mode(0)
        .open(f.native("locked.md"))
        .unwrap();
    f.open();
    // Moves need the catalog to know the entries, and `HEAD`'s rows paired with them, first.
    for (path, name) in [
        ("Fall/MAT232/Lectures", "Slides"),
        ("Fall/MAT232/B.md", "A.md"),
    ] {
        f.state
            .rename_entry(RenameEntry {
                entry: f.reference(path),
                name: name.to_owned(),
            })
            .unwrap();
    }
    // The hash jobs the moves queue change nothing, but move the revision while they run.
    f.wait_for_jobs();
    locked
}

fn reference(f: &Fixture, path: &str) -> Option<EntryRef> {
    Some(f.reference(path))
}

#[test]
fn items_and_metadata_changes_convert_every_field() {
    let f = Fixture::new();
    let _locked = changed_library(&f);
    let listed = all_items(&f);
    let file = |change, path: &str| WorkspaceItem {
        key: String::new(),
        change,
        kind: EntryKind::File,
        path: path.to_owned(),
        from_path: None,
        entry: (change != ChangeKind::Deleted).then(|| f.reference(path)),
        class: FileClass::Text,
        content_changed: false,
        before: None,
        after: None,
        readiness: Readiness::Ready,
        files: 0,
        parts: Vec::new(),
        required: false,
        tags_changed: false,
    };
    let expected = vec![
        WorkspaceItem {
            kind: EntryKind::Folder,
            class: FileClass::Other,
            ..file(ChangeKind::Added, "Empty")
        },
        WorkspaceItem {
            from_path: Some("Fall/MAT232/B.md".to_owned()),
            before: side("2", true),
            after: side("2", true),
            parts: vec![ItemPart::Entry {
                change: ChangeKind::Deleted,
                entry_kind: EntryKind::File,
                path: "Fall/MAT232/A.md".to_owned(),
                from_path: None,
            }],
            ..file(ChangeKind::Moved, "Fall/MAT232/A.md")
        },
        WorkspaceItem {
            kind: EntryKind::Folder,
            class: FileClass::Other,
            from_path: Some("Fall/MAT232/Lectures".to_owned()),
            files: 1,
            ..file(ChangeKind::Moved, "Fall/MAT232/Slides")
        },
        WorkspaceItem {
            content_changed: true,
            before: side("9", true),
            after: side("17", true),
            tags_changed: true,
            ..file(ChangeKind::Modified, "Fall/MAT232/notes.md")
        },
        WorkspaceItem {
            before: side("4", true),
            ..file(ChangeKind::Deleted, "Fall/MAT232/old.md")
        },
        WorkspaceItem {
            content_changed: true,
            before: side("20", false),
            after: side("21", true),
            parts: vec![ItemPart::VersioningRules],
            required: true,
            ..file(ChangeKind::Modified, "Fall/rules.md")
        },
        WorkspaceItem {
            class: FileClass::Word,
            after: side("26", true),
            ..file(ChangeKind::Added, "Winter/new.docx")
        },
        WorkspaceItem {
            after: side("0", true),
            readiness: Readiness::NotLocal,
            ..file(ChangeKind::Added, "cloud.md")
        },
        WorkspaceItem {
            after: side("24", true),
            readiness: Readiness::Unreadable,
            ..file(ChangeKind::Added, "locked.md")
        },
    ];
    let keys: Vec<String> = listed.iter().map(|item| item.key.clone()).collect();
    let without_keys: Vec<WorkspaceItem> = listed
        .into_iter()
        .map(|item| WorkspaceItem {
            key: String::new(),
            ..item
        })
        .collect();
    assert_eq!(without_keys, expected);
    assert_eq!(
        keys.iter().collect::<BTreeSet<_>>().len(),
        keys.len(),
        "{keys:?}"
    );
    assert!(
        keys.iter()
            .all(|key| key.chars().count() <= LIMITS.key_chars as usize)
    );

    let summary = summary(&f.state).unwrap();
    assert_eq!(summary.history_state, HistoryState::Ready);
    assert!(
        summary
            .head
            .as_deref()
            .is_some_and(|head| head.starts_with("b3:"))
    );
    assert_eq!(summary.fingerprint.len(), 32);
    assert_ne!(summary.fingerprint, ZEROS);
    assert_eq!(
        (
            summary.items,
            summary.metadata,
            summary.includable,
            summary.hashing,
            summary.not_local,
            summary.unreadable
        ),
        (9, 3, 7, 0, 1, 1)
    );

    let rows = metadata(&f.state, ListMetadataChanges { page: page(0, 10) }).unwrap();
    assert_eq!((rows.total, rows.revision), (3, summary.revision));
    let subjects: Vec<(ChangeKind, MetadataSubject)> = rows
        .items
        .into_iter()
        .map(|row| (row.change, row.subject))
        .collect();
    assert_eq!(
        subjects,
        [
            (
                ChangeKind::Added,
                MetadataSubject::Tags {
                    path: "Fall/MAT232/plain.md".to_owned(),
                    entry_kind: EntryKind::File,
                    entry: reference(&f, "Fall/MAT232/plain.md"),
                }
            ),
            (
                ChangeKind::Added,
                MetadataSubject::Course {
                    path: "Fall/MAT232".to_owned(),
                    folder: reference(&f, "Fall/MAT232"),
                }
            ),
            (ChangeKind::Modified, MetadataSubject::Library),
        ]
    );
}

/// The metadata subjects the test above does not meet: semester settings, tag definitions and
/// ignore rules.
#[test]
fn the_other_metadata_subjects_convert_too() {
    let f = Fixture::new();
    f.write("Fall/MAT232/a.md", b"a\n");
    f.commit(None);
    let layout = f.layout();
    let fall = SemesterPath::new(rel("Fall")).unwrap();
    layout
        .write_group_meta(
            &fall,
            &GroupMeta {
                group: Some(GroupSettings {
                    archived: false,
                    order: 3,
                }),
                tags: Default::default(),
            },
        )
        .unwrap();
    let mut definitions = layout.read_tags().unwrap().unwrap();
    definitions.tags.pop_first().unwrap();
    layout.write_tags(&definitions).unwrap();
    layout.write_ignore("*.tmp\n").unwrap();
    f.open();
    let rows = metadata(&f.state, ListMetadataChanges { page: page(0, 10) }).unwrap();
    let subjects: Vec<(ChangeKind, MetadataSubject)> = rows
        .items
        .into_iter()
        .map(|row| (row.change, row.subject))
        .collect();
    assert_eq!(
        subjects,
        [
            (
                ChangeKind::Added,
                MetadataSubject::Semester {
                    path: "Fall".to_owned(),
                    folder: reference(&f, "Fall"),
                }
            ),
            (ChangeKind::Deleted, MetadataSubject::TagDefinitions),
            (ChangeKind::Added, MetadataSubject::IgnoreRules),
        ]
    );
}

/// Each readiness as the contract writes it. The live tests meet ready, not local and unreadable
/// items; a file stays hashing only for the hash job's moment, too short to catch reliably.
#[test]
fn every_readiness_converts() {
    assert_eq!(
        [
            CoreReadiness::Ready,
            CoreReadiness::Hashing,
            CoreReadiness::NotLocal,
            CoreReadiness::Unreadable,
        ]
        .map(readiness),
        [
            Readiness::Ready,
            Readiness::Hashing,
            Readiness::NotLocal,
            Readiness::Unreadable,
        ]
    );
}

#[test]
fn summaries_count_per_place_and_check_keys_after_the_fingerprint() {
    let f = Fixture::new();
    let _locked = changed_library(&f);
    let listed = all_items(&f);
    let key = |path: &str| {
        listed
            .iter()
            .find(|item| item.path == path)
            .unwrap()
            .key
            .clone()
    };
    let fingerprint = summary(&f.state).unwrap().fingerprint;
    let everything = summarize(&f.state, all_except(&[], &fingerprint)).unwrap();
    assert_eq!((everything.items, everything.metadata), (7, 3));
    assert!(everything.library && !everything.tag_definitions && !everything.ignore_rules);
    let places: Vec<&Place> = everything.groups.iter().map(|group| &group.place).collect();
    assert_eq!(
        places,
        [
            &Place::Library,
            &Place::Semester {
                path: "Empty".to_owned(),
                folder: reference(&f, "Empty"),
                name: "Empty".to_owned(),
            },
            &Place::Semester {
                path: "Fall".to_owned(),
                folder: reference(&f, "Fall"),
                name: "Fall".to_owned(),
            },
            &Place::Course {
                path: "Fall/MAT232".to_owned(),
                folder: reference(&f, "Fall/MAT232"),
                name: "MAT232".to_owned(),
                code: Some("MAT232".to_owned()),
            },
            &Place::Semester {
                path: "Winter".to_owned(),
                folder: reference(&f, "Winter"),
                name: "Winter".to_owned(),
            },
        ]
    );
    let counted: Vec<_> = everything
        .groups
        .iter()
        .map(|group| {
            (
                group.files,
                group.folders,
                group.tags,
                group.settings,
                [group.items, group.available, group.selected, group.required],
            )
        })
        .collect();
    let none = counts(0, 0, 0, 0);
    assert_eq!(
        counted,
        [
            (none, none, 0, false, [2, 0, 0, 0]),
            (none, counts(1, 0, 0, 0), 0, false, [1, 1, 1, 0]),
            (counts(0, 1, 0, 0), none, 0, false, [1, 1, 1, 1]),
            (
                counts(0, 1, 1, 1),
                counts(0, 0, 0, 1),
                2,
                true,
                [4, 4, 4, 0]
            ),
            (counts(1, 0, 0, 0), none, 0, false, [1, 1, 1, 0]),
        ]
    );

    // `only` with a blocked item counts it as selected, not available (§6.4), and the required
    // item always.
    let blocked = summarize(&f.state, only(&[&key("locked.md")], &fingerprint)).unwrap();
    assert_eq!(blocked.items, 2);
    assert_eq!(
        [blocked.groups[0].available, blocked.groups[0].selected],
        [0, 1]
    );
    // Leaving the modified, tagged file out keeps its tag change in the commit (§6.4).
    let left_out = summarize(
        &f.state,
        all_except(&[&key("Fall/MAT232/notes.md")], &fingerprint),
    )
    .unwrap();
    let course = &left_out.groups[3];
    assert_eq!((course.selected, course.tags), (3, 2));

    // The fingerprint first, then the keys; limits before both.
    assert!(matches!(
        summarize(&f.state, only(&["no such key"], ZEROS)),
        Err(AppError::WorkspaceChanged(_))
    ));
    invalid(summarize(&f.state, only(&["no such key"], &fingerprint)));
    for request in oversized() {
        invalid(summarize(&f.state, request));
    }

    // A key whose item went: with the new fingerprint it names nothing.
    let gone = key("Empty");
    f.state
        .rename_entry(RenameEntry {
            entry: f.reference("Empty"),
            name: "Vide".to_owned(),
        })
        .unwrap();
    let renamed = summary(&f.state).unwrap().fingerprint;
    assert_ne!(renamed, fingerprint);
    assert!(matches!(
        summarize(&f.state, all_except(&[&gone], &fingerprint)),
        Err(AppError::WorkspaceChanged(_))
    ));
    invalid(summarize(&f.state, all_except(&[&gone], &renamed)));
    assert_eq!(
        summarize(&f.state, all_except(&[], &renamed))
            .unwrap()
            .items,
        7
    );
}

#[test]
fn pages_follow_the_request_and_carry_the_revision() {
    let f = Fixture::new();
    let _locked = changed_library(&f);
    let listed = all_items(&f);
    let revision = summary(&f.state).unwrap().revision;
    let window = items(&f.state, ListWorkspaceItems { page: page(2, 3) }).unwrap();
    assert_eq!(
        (window.offset, window.total, window.revision),
        (2, 9, revision)
    );
    assert_eq!(window.items, listed[2..5]);
    let past = items(&f.state, ListWorkspaceItems { page: page(50, 10) }).unwrap();
    assert!(past.items.is_empty());
    assert_eq!((past.offset, past.total), (50, 9));
    invalid(items(
        &f.state,
        ListWorkspaceItems {
            page: page(0, LIMITS.page_size + 1),
        },
    ));
    set_offline(&f.native("cloud.md"), false);
}

#[test]
fn a_swap_is_one_item_as_blocked_as_its_worst_change() {
    let f = Fixture::new();
    f.write("Fall/MAT232/p.md", b"p\n");
    f.write("Fall/MAT232/q.md", b"q\n");
    f.commit(None);
    // Edited and offline: it waits unhashed, not local.
    f.write("Fall/MAT232/p.md", b"p edited\n");
    set_offline(&f.native("Fall/MAT232/p.md"), true);
    f.open();
    for (path, name) in [
        ("Fall/MAT232/p.md", "t.md"),
        ("Fall/MAT232/q.md", "p.md"),
        ("Fall/MAT232/t.md", "q.md"),
    ] {
        f.state
            .rename_entry(RenameEntry {
                entry: f.reference(path),
                name: name.to_owned(),
            })
            .unwrap();
    }
    let listed = all_items(&f);
    set_offline(&f.native("Fall/MAT232/q.md"), false);
    assert_eq!(listed.len(), 1, "{listed:?}");
    let item = &listed[0];
    assert_eq!(
        (
            item.change,
            item.path.as_str(),
            item.from_path.as_deref(),
            item.content_changed
        ),
        (
            ChangeKind::Moved,
            "Fall/MAT232/p.md",
            Some("Fall/MAT232/q.md"),
            false
        )
    );
    assert_eq!(item.entry, reference(&f, "Fall/MAT232/p.md"));
    // The main change is ready; the part it is bound to is not local, and so is the item.
    assert_eq!(item.readiness, Readiness::NotLocal);
    assert_eq!(
        item.parts,
        [ItemPart::Entry {
            change: ChangeKind::Moved,
            entry_kind: EntryKind::File,
            path: "Fall/MAT232/q.md".to_owned(),
            from_path: Some("Fall/MAT232/p.md".to_owned()),
        }]
    );
    let summary = summary(&f.state).unwrap();
    assert_eq!(
        (summary.items, summary.includable, summary.not_local),
        (1, 0, 1)
    );
}
