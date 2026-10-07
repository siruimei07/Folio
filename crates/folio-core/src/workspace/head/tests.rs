use std::cell::Cell;
use std::fs;

use super::*;
use crate::catalog::has_object;
use crate::catalog::head_files::{HistoryMarks, head_rows as catalog_rows, paired_entry};
use crate::crash::each_point;
use crate::meta::{DisplayName, LibraryConfig, VersioningRules, to_bytes};
use crate::store::{
    FlatEntry, MemoryTrees, ObjectKind, Problem, RuleViolation, Side, Size, TreeEntry,
};
use crate::test_support::path;
use crate::workspace::testing::{
    CancelAt, Fixture, HeadTree, remove_packs, write_head, write_head_bytes,
};

/// A library with a course of a text file, a Word file and a PDF, scanned and hashed.
fn library() -> Fixture {
    let f = Fixture::new();
    f.fs.file("2026 秋/线代/笔记.md", b"# notes");
    f.fs.file("2026 秋/线代/report.docx", b"docx");
    f.fs.file("2026 秋/syllabus.pdf", b"pdf");
    f.fs.folder("empty");
    f.scan();
    f.hash_all();
    f
}

fn marks(f: &Fixture) -> HistoryMarks {
    f.catalog.read(|tx| history_marks(tx)).unwrap()
}

/// The rows of `head_files` with each folder's tree id and each file's side, by path.
fn rows(f: &Fixture) -> Vec<(String, String)> {
    f.catalog
        .read(|tx| {
            let rows = tx
                .prepare(
                    "SELECT path, kind || ' ' || hash || ' ' || coalesce(size, '-') || ' ' ||
                         coalesce(stored, '-') FROM head_files ORDER BY path",
                )?
                .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
                .collect::<Result<_, _>>()?;
            Ok(rows)
        })
        .unwrap()
}

/// The rows `head_files` should hold for `tree`, written as `written`.
fn expected_rows(
    tree: &HeadTree,
    trees: &std::collections::BTreeMap<String, ObjectId>,
) -> Vec<(String, String)> {
    tree.rows
        .iter()
        .map(|(at, side)| {
            let text = match side {
                None => format!("folder {} - -", trees[at]),
                Some(side) => format!(
                    "file {} {} {}",
                    side.hash,
                    side.size.get(),
                    u8::from(side.stored)
                ),
            };
            (at.clone(), text)
        })
        .collect()
}

fn not_ready(state: &HeadState) -> (HistoryStatus, Option<ObjectId>, bool, bool) {
    (
        state.status(),
        state.head(),
        state.lists_items(),
        state.meta().is_some(),
    )
}

/// The catalog holds no `HEAD`: no rows, no marks.
fn assert_cleared(f: &Fixture) {
    assert!(rows(f).is_empty());
    assert_eq!(
        marks(f),
        HistoryMarks {
            head: None,
            version: None
        }
    );
}

#[test]
fn without_head_and_packs_there_is_no_history() {
    let f = library();
    let state = f.sync();
    assert_eq!(not_ready(&state), (HistoryStatus::None, None, false, false));
    assert!(state.problem().is_none());
    assert_cleared(&f);
}

#[test]
fn a_head_sync_flattens_head_with_folder_ids_and_reads_its_metadata() {
    let f = library();
    let tree = f.disk_tree();
    let written = write_head(&f.store(), &tree, None, &|_| false);
    let state = f.sync();
    assert_eq!(
        not_ready(&state),
        (HistoryStatus::Ready, Some(written.commit), true, true)
    );
    assert_eq!(rows(&f), expected_rows(&tree, &written.trees));
    assert_eq!(
        marks(&f),
        HistoryMarks {
            head: Some(written.commit),
            version: Some(HISTORY_VERSION)
        }
    );
    let meta = state.meta().unwrap();
    assert_eq!(meta.library().id, f.id());
    assert_eq!(meta.definitions().tags.len(), 5);
    // Stored as the rules say: the text and Word files, not the PDF.
    let stored: Vec<(String, bool)> = f
        .catalog
        .read(|tx| catalog_rows(tx))
        .unwrap()
        .into_iter()
        .filter_map(|row| Some((row.path.to_string(), row.file?.stored)))
        .filter(|(at, _)| !at.starts_with(".folio"))
        .collect();
    assert_eq!(
        stored,
        [
            ("2026 秋/syllabus.pdf".to_owned(), false),
            ("2026 秋/线代/report.docx".to_owned(), true),
            ("2026 秋/线代/笔记.md".to_owned(), true),
        ]
    );
    // Paired by path.
    let entry = f
        .catalog
        .read(|tx| paired_entry(tx, &path("2026 秋/线代/笔记.md")))
        .unwrap();
    assert_eq!(entry, Some(f.entry("2026 秋/线代/笔记.md").id));
}

/// `.folio/local/` removed, or the library restored without it, while the catalog, which lives
/// outside the library, stays: without `HEAD` the index of the packs still follows `packs/`, so it
/// is emptied, forced or not, and the first commit of a new history stores every object it needs
/// (a writer stores only what `has_object` does not find). Synced again, nothing is written.
#[test]
fn without_head_the_packs_index_follows_the_packs_too() {
    for (forced, head) in [(false, None), (true, None), (false, Some(b"not json"))] {
        let f = library();
        f.commit_all(None);
        let blob = f.disk_tree().rows[".folio/library.json"].unwrap().hash;
        assert_eq!(indexed(&f).len(), 1);
        remove_packs(f.layout());
        match head {
            None => fs::remove_file(f.layout().head_file()).unwrap(),
            Some(bytes) => write_head_bytes(f.layout(), bytes),
        }
        let state = if forced { f.sync_forced() } else { f.sync() };
        let expected = match head {
            None => HistoryStatus::None,
            Some(_) => HistoryStatus::Damaged,
        };
        assert_eq!(state.status(), expected);
        assert!(indexed(&f).is_empty(), "forced {forced}, HEAD {head:?}");
        assert!(!f.catalog.read(|tx| has_object(tx, blob)).unwrap());
        assert_cleared(&f);
        let revision = f.catalog.stamp().revision;
        assert_eq!(f.sync().status(), expected);
        assert_eq!(f.catalog.stamp().revision, revision);
    }
}

#[test]
fn packs_without_head_are_damage() {
    let f = library();
    f.commit_all(None);
    fs::remove_file(f.layout().head_file()).unwrap();
    let state = f.sync();
    assert_eq!(
        not_ready(&state),
        (HistoryStatus::Damaged, None, false, false)
    );
    assert!(matches!(
        state.problem(),
        Some(HeadProblem::PacksWithoutHead)
    ));
    assert_cleared(&f);
}

#[test]
fn a_head_that_does_not_read_is_damage_and_a_newer_one_read_only() {
    let f = library();
    f.commit_all(None);
    write_head_bytes(f.layout(), b"not json");
    let state = f.sync();
    assert_eq!(
        not_ready(&state),
        (HistoryStatus::Damaged, None, false, false)
    );
    assert!(matches!(
        state.problem(),
        Some(HeadProblem::Store(StoreError::Invalid { .. }))
    ));
    assert_cleared(&f);

    f.commit_all(None);
    let newer = format!(
        r#"{{"format_version":2,"head":"{}"}}"#,
        ObjectId::from_bytes([1; 32])
    );
    write_head_bytes(f.layout(), newer.as_bytes());
    let state = f.sync();
    assert_eq!(
        not_ready(&state),
        (HistoryStatus::ReadOnly, None, false, false)
    );
    assert_cleared(&f);
}

#[test]
fn a_missing_commit_or_tree_is_damage() {
    let f = library();
    let tree = f.disk_tree();
    let commit = write_head(&f.store(), &tree, None, &|_| false).commit;
    remove_packs(f.layout());
    let written = write_head(&f.store(), &tree, None, &|id| id == commit);
    let state = f.sync();
    assert_eq!(
        not_ready(&state),
        (HistoryStatus::Damaged, Some(written.commit), false, false)
    );
    assert!(matches!(
        state.problem(),
        Some(HeadProblem::Store(StoreError::Missing(id))) if *id == commit
    ));
    assert_cleared(&f);

    let f = library();
    let tree = f.disk_tree();
    let course = write_head(&f.store(), &tree, None, &|_| false).trees["2026 秋/线代"];
    remove_packs(f.layout());
    write_head(&f.store(), &tree, None, &|id| id == course);
    let state = f.sync();
    assert_eq!(state.status(), HistoryStatus::Damaged);
    assert!(matches!(
        state.problem(),
        Some(HeadProblem::Store(StoreError::Missing(id))) if *id == course
    ));
    assert!(!state.lists_items());
    assert_cleared(&f);
}

/// Damages the pack `name` of `f`: its index no longer reads, as the trailer's hash no longer names
/// it, or a newer Folio wrote it. Returns the pack's path.
fn spoil_pack(f: &Fixture, name: PackName, newer: bool) -> PathBuf {
    let file = f.store().pack_path(name);
    let mut bytes = fs::read(&file).unwrap();
    if newer {
        // remote-format.md §9: the format version follows the 8 bytes of the magic.
        bytes[8..12].copy_from_slice(&2_u32.to_le_bytes());
    } else {
        let last = bytes.len() - 1;
        bytes[last] ^= 1;
    }
    fs::write(&file, bytes).unwrap();
    assert!(f.store().read_pack_index(name).is_err());
    file
}

/// A forced sync, as after a catalog rebuild, empties the index before it adds the packs again: a
/// pack whose index no longer reads leaves it empty.
#[test]
fn a_damaged_pack_is_damage() {
    let f = library();
    f.commit_all(None);
    let pack = f.store().list_packs().unwrap().packs[0];
    spoil_pack(&f, pack, false);
    let state = f.sync_forced();
    assert_eq!(state.status(), HistoryStatus::Damaged);
    assert!(matches!(
        state.problem(),
        Some(HeadProblem::Store(StoreError::Invalid { .. }))
    ));
    assert_cleared(&f);
    assert!(indexed(&f).is_empty());
}

/// Packs of three commits: one gone, one whose index does not read (damaged, or written by a newer
/// Folio) and one good. The index is filled again from the good pack alone, whichever of the other
/// two comes first in name order, and the unreadable pack's problem is the history's; synced again,
/// that pack's index is read again, and nothing is written.
#[test]
fn a_pack_whose_index_does_not_read_is_left_out_and_the_others_indexed() {
    for (newer, spoiled_first) in [(false, true), (false, false), (true, true)] {
        let f = library();
        let (first, _) = f.commit_all(None);
        f.fs.file("2.md", b"2");
        let (second, _) = f.commit_all(Some(first));
        f.fs.file("3.md", b"3");
        let (head, _) = f.commit_all(Some(second));
        let packs = f.store().list_packs().unwrap().packs;
        assert_eq!(packs.len(), 3);
        assert_eq!(indexed(&f), packs);
        fs::remove_file(f.store().pack_path(packs[2])).unwrap();
        let (spoiled, good) = if spoiled_first {
            (packs[0], packs[1])
        } else {
            (packs[1], packs[0])
        };
        let file = spoil_pack(&f, spoiled, newer);
        let case = format!("newer {newer}, first {spoiled_first}");
        let state = f.sync();
        assert_eq!(indexed(&f), [good], "{case}");
        let expected = if newer {
            HistoryStatus::ReadOnly
        } else {
            HistoryStatus::Damaged
        };
        assert_eq!(
            not_ready(&state),
            (expected, Some(head), false, false),
            "{case}"
        );
        match state.problem() {
            Some(HeadProblem::Store(
                StoreError::Invalid {
                    what: Subject::Pack(at),
                    ..
                }
                | StoreError::Newer {
                    what: Subject::Pack(at),
                    ..
                },
            )) => assert_eq!(*at, file, "{case}"),
            other => panic!("{case}: {other:?}"),
        }
        assert_cleared(&f);
        let revision = f.catalog.stamp().revision;
        assert_eq!(f.sync().status(), expected, "{case}");
        assert_eq!(f.catalog.stamp().revision, revision, "{case}");
        assert_eq!(indexed(&f), [good], "{case}");
    }
}

/// A sync that adds no pack clears the index in a write of its own, right after its own question: a
/// forced sync of a library whose one pack's index does not read asks before it starts, before the
/// pack's index is read, before the index is cleared and before the rows are; cancelled at any of
/// them, it has made only the writes of the questions before it.
#[test]
fn a_sync_that_adds_no_pack_clears_the_index_after_its_own_question() {
    let spoiled = || {
        let f = library();
        f.commit_all(None);
        let pack = f.store().list_packs().unwrap().packs[0];
        spoil_pack(&f, pack, false);
        f
    };
    let f = spoiled();
    let revision = f.catalog.stamp().revision;
    let never = CancelAt::new(usize::MAX);
    assert_eq!(
        forced_sync(&f, &never).unwrap().status(),
        HistoryStatus::Damaged
    );
    assert_eq!(never.asked.get(), 4);
    assert_eq!(f.catalog.stamp().revision - revision, 2);
    assert!(indexed(&f).is_empty());
    // The index's clear after question 3, the rows' after question 4.
    let writes_before = |at: usize| [3, 4].into_iter().filter(|&q| q < at).count();
    for at in 1..=4 {
        let f = spoiled();
        let revision = f.catalog.stamp().revision;
        let result = forced_sync(&f, &CancelAt::new(at));
        assert!(
            matches!(result, Err(SyncError::Cancelled)),
            "cancelled at question {at}: {result:?}"
        );
        let writes = f.catalog.stamp().revision - revision;
        assert_eq!(
            usize::try_from(writes).unwrap(),
            writes_before(at),
            "writes before question {at}"
        );
        assert_eq!(indexed(&f).is_empty(), at > 3, "the index at question {at}");
    }
}

/// A crash right before the write that clears the index, which no pack added (all gone, or the one
/// left unreadable): the next sync finds the gone pack still indexed and clears it.
#[test]
fn a_crash_before_the_index_is_cleared_leaves_the_clear_to_the_next_sync() {
    for spoiled in [false, true] {
        let steps = each_point(|arm| {
            let f = library();
            let (first, _) = f.commit_all(None);
            f.fs.file("2.md", b"2");
            f.commit_all(Some(first));
            let packs = f.store().list_packs().unwrap().packs;
            assert_eq!(packs.len(), 2);
            if spoiled {
                fs::remove_file(f.store().pack_path(packs[1])).unwrap();
                spoil_pack(&f, packs[0], false);
            } else {
                remove_packs(f.layout());
                fs::remove_file(f.layout().head_file()).unwrap();
            }
            let _ = arm.run(|| f.sync());
            let expected = if spoiled {
                HistoryStatus::Damaged
            } else {
                HistoryStatus::None
            };
            assert_eq!(f.sync().status(), expected, "spoiled {spoiled}");
            assert!(indexed(&f).is_empty(), "spoiled {spoiled}");
            assert_cleared(&f);
        });
        assert_eq!(steps, ["head.index"], "spoiled {spoiled}");
    }
}

#[test]
fn a_tree_over_the_path_budget_is_too_large() {
    let f = library();
    let written = write_head(&f.store(), &f.disk_tree(), None, &|_| false);
    let state = f.sync_within(Bounds {
        entries: 3,
        ..Bounds::DEFAULT
    });
    assert_eq!(
        not_ready(&state),
        (HistoryStatus::TooLarge, Some(written.commit), false, false)
    );
    assert_cleared(&f);
    // The same history within the default budget.
    assert_eq!(f.sync().status(), HistoryStatus::Ready);
}

/// A link in `.folio/` is refused before anything there is read, as every reader of the
/// metadata refuses it, and the rows stay as they were.
#[test]
fn a_link_in_folio_is_refused_before_head_is_read() {
    let f = library();
    f.commit_all(None);
    let before = rows(&f);
    let outside = tempfile::tempdir().unwrap();
    let meta = f.layout().meta_dir();
    fs::create_dir_all(&meta).unwrap();
    fs::rename(&meta, meta.with_file_name("meta-saved")).unwrap();
    let created = std::process::Command::new("cmd")
        .args(["/C", "mklink", "/J"])
        .arg(&meta)
        .arg(outside.path())
        .output()
        .unwrap();
    assert!(created.status.success(), "{created:?}");
    let synced = sync(
        &f.catalog,
        f.layout(),
        &f.id(),
        true,
        &AtomicBool::new(false),
    );
    fs::remove_dir(&meta).unwrap();
    assert!(matches!(synced, Err(SyncError::Meta(_))), "{synced:?}");
    assert_eq!(rows(&f), before);
}

#[test]
fn a_cancelled_sync_writes_nothing() {
    let f = library();
    write_head(&f.store(), &f.disk_tree(), None, &|_| false);
    let cancelled = sync(
        &f.catalog,
        f.layout(),
        &f.id(),
        false,
        &AtomicBool::new(true),
    );
    assert!(matches!(cancelled, Err(SyncError::Cancelled)));
    assert_cleared(&f);

    // A walk stops at the first tree after the cancel.
    let mut trees = MemoryTrees::new();
    let leaf = trees.insert(Tree::default()).unwrap();
    let name = |text: &str| crate::store::Name::parse(text).unwrap();
    let root = trees
        .insert(
            Tree::new(vec![
                TreeEntry::dir(name("a"), leaf),
                TreeEntry::dir(name("b"), leaf),
            ])
            .unwrap(),
        )
        .unwrap();
    let cancel = AtomicBool::new(false);
    let seen = Cell::new(0);
    struct Counting<'a> {
        trees: &'a MemoryTrees,
        seen: &'a Cell<usize>,
        cancel: &'a AtomicBool,
    }
    impl TreeSource for Counting<'_> {
        fn tree(&self, id: ObjectId) -> Result<Option<Arc<Tree>>, StoreError> {
            self.seen.set(self.seen.get() + 1);
            // The user cancels while the first tree is read.
            self.cancel.store(true, Ordering::Relaxed);
            self.trees.tree(id)
        }
    }
    let source = Cancellable {
        source: Counting {
            trees: &trees,
            seen: &seen,
            cancel: &cancel,
        },
        cancel: &cancel,
    };
    let walked = flatten(&source, root, DEFAULT_PATH_BUDGET);
    assert!(matches!(walked, Err(StoreError::Io { .. })));
    assert_eq!(seen.get(), 1);
}

/// Rows one write adds in the tests that count the head sync's writes.
const RUN_ROWS: usize = 16;

fn forced_sync(f: &Fixture, cancel: &dyn Cancel) -> Result<HeadState, SyncError> {
    let bounds = Bounds {
        run_rows: RUN_ROWS,
        ..Bounds::DEFAULT
    };
    sync_within(&f.catalog, f.layout(), &f.id(), true, cancel, bounds)
}

/// How many times a forced sync of `f`'s `HEAD` asks whether to stop.
fn questions(f: &Fixture) -> usize {
    let never = CancelAt::new(usize::MAX);
    assert_eq!(
        forced_sync(f, &never).unwrap().status(),
        HistoryStatus::Ready
    );
    never.asked.get()
}

#[test]
fn a_sync_stops_at_whichever_question_it_is_cancelled_and_its_walk_asks_at_every_tree() {
    let f = library();
    let mut tree = f.disk_tree();
    write_head(&f.store(), &tree, None, &|_| false);
    let before = questions(&f);
    let runs_before = rows(&f).len().div_ceil(RUN_ROWS);
    // 51 more trees, each of its own: `extra` and its 50 folders of one file each.
    tree.rows.insert("extra".into(), None);
    for n in 0..50_u8 {
        tree.rows.insert(format!("extra/f{n:02}"), None);
        let side = Side {
            hash: ObjectId::from_bytes([n; 32]),
            size: Size::new(1).unwrap(),
            stored: false,
        };
        tree.rows.insert(format!("extra/f{n:02}/x.pdf"), Some(side));
    }
    // Two more metadata files, one in a folder of its own (a 52nd tree), and a second pack.
    tree.put(".folio/ignore", b"*.tmp\n".to_vec());
    tree.put(
        ".folio/meta/_root.json",
        to_bytes(&crate::meta::RootMeta::default()).unwrap(),
    );
    let written = write_head(&f.store(), &tree, None, &|_| false);
    assert_eq!(f.store().list_packs().unwrap().packs.len(), 2);
    let asked = questions(&f);
    // A question at each tree of the walk, two for each pack (before its index is read, and
    // before it is written), one before each metadata blob is read, and one before each write
    // of rows.
    let runs = rows(&f).len().div_ceil(RUN_ROWS);
    assert!(runs > 2);
    assert_eq!(asked, before + 52 + 2 + 2 + runs - runs_before);
    // Each write comes right after its own question: the two packs' (the third and the fifth
    // questions), each run's and the marks' (the last ones). Cancelled at a question, the sync has
    // made the writes of the questions before it and no other: none follows a cancel, also when
    // the user cancels while an index or a tree is read.
    let writes = [3, 5].into_iter().chain(asked - runs..=asked);
    let writes_before = |at: usize| writes.clone().filter(|&question| question < at).count();
    let revision = f.catalog.stamp().revision;
    assert_eq!(
        forced_sync(&f, &CancelAt::new(usize::MAX))
            .unwrap()
            .status(),
        HistoryStatus::Ready
    );
    assert_eq!(
        usize::try_from(f.catalog.stamp().revision - revision).unwrap(),
        writes_before(usize::MAX)
    );
    for at in 1..=asked {
        let revision = f.catalog.stamp().revision;
        let result = forced_sync(&f, &CancelAt::new(at));
        assert!(
            matches!(result, Err(SyncError::Cancelled)),
            "cancelled at question {at}: {result:?}"
        );
        assert_eq!(
            usize::try_from(f.catalog.stamp().revision - revision).unwrap(),
            writes_before(at),
            "writes before question {at}"
        );
    }
    assert_eq!(f.sync().status(), HistoryStatus::Ready);
    assert_eq!(rows(&f), expected_rows(&tree, &written.trees));
}

#[test]
fn rows_another_version_of_the_code_derived_are_derived_again() {
    let f = library();
    let (head, _) = f.commit_all(None);
    let before = rows(&f);
    f.catalog
        .write(|tx| {
            tx.execute(
                "UPDATE head_files SET hash = 'b3:' || substr(hash, 4, 63) || '0'
                 WHERE path = '2026 秋/syllabus.pdf'",
                [],
            )?;
            tx.execute(
                "UPDATE info SET value = ?1 WHERE key = 'history_version'",
                [(HISTORY_VERSION - 1).to_string()],
            )?;
            Ok(())
        })
        .unwrap();
    assert_ne!(rows(&f), before);
    assert_eq!(f.sync().head(), Some(head));
    assert_eq!(rows(&f), before);
    assert_eq!(marks(&f).version, Some(HISTORY_VERSION));
}

#[test]
fn a_root_that_breaks_the_rules_or_encodes_elsewhere_is_damage() {
    let side = |bytes: &[u8]| Side {
        hash: ObjectId::of(ObjectKind::Blob, bytes),
        size: Size::new(bytes.len() as u64).unwrap(),
        stored: true,
    };
    let mut flat = FlatTree::new();
    flat.insert(".folio".into(), FlatEntry::Dir);
    flat.insert(".folio/library.json".into(), FlatEntry::File(side(b"{}")));
    flat.insert("a.md".into(), FlatEntry::File(side(b"a")));
    let mut root = None;
    encode_trees(
        flat.iter().map(|(at, entry)| (at.as_str(), entry.side())),
        |at, encoded| {
            if at.is_empty() {
                root = Some(encoded.id());
            }
            Ok(())
        },
    )
    .unwrap();
    let root = root.unwrap();
    // 29 bytes of paths: `.folio`, `.folio/library.json` and `a.md`.
    let (rows, head) = tree_rows(&flat, root, 29).unwrap();
    assert_eq!(rows.len(), 3);
    assert_eq!(head[2].path, path("a.md"));
    assert!(matches!(
        tree_rows(&flat, root, 28),
        Err(HeadProblem::PathsTooLong {
            bytes: 29,
            limit: 28
        })
    ));

    let other = ObjectId::from_bytes([9; 32]);
    assert!(matches!(
        tree_rows(&flat, other, 29),
        Err(HeadProblem::RootDiffers { expected, found }) if expected == other && found == root
    ));
    flat.remove(".folio/library.json");
    assert!(matches!(
        tree_rows(&flat, root, 29),
        Err(HeadProblem::Root(RuleViolation::FolioMissing))
    ));
}

#[test]
fn another_librarys_head_is_damage() {
    let f = library();
    let mut tree = f.disk_tree();
    let other = LibraryConfig {
        id: LibraryId::parse("fedcba9876543210fedcba9876543210").unwrap(),
        name: DisplayName::parse("别人的").unwrap(),
        versioning: VersioningRules::default(),
    };
    tree.put(".folio/library.json", to_bytes(&other).unwrap());
    let written = write_head(&f.store(), &tree, None, &|_| false);
    let state = f.sync();
    assert_eq!(
        not_ready(&state),
        (HistoryStatus::Damaged, Some(written.commit), false, false)
    );
    assert!(matches!(
        state.problem(),
        Some(HeadProblem::OtherLibrary { found }) if *found == other.id
    ));
    assert_cleared(&f);

    // Whatever else its metadata holds: `library.json` is read first.
    let newer = br#"{"format_version":99}"#.to_vec();
    let invalid = b"not json".to_vec();
    let never_written = b"never written".to_vec();
    let lost = ObjectId::of(ObjectKind::Blob, &never_written);
    for (what, bytes) in [
        ("newer", newer),
        ("invalid", invalid),
        ("missing", never_written),
    ] {
        tree.put(".folio/tags.json", bytes);
        let written = write_head(&f.store(), &tree, None, &|id| id == lost);
        let state = f.sync();
        assert_eq!(
            not_ready(&state),
            (HistoryStatus::Damaged, Some(written.commit), false, false),
            "{what}"
        );
        assert!(
            matches!(state.problem(), Some(HeadProblem::OtherLibrary { .. })),
            "{what}: {:?}",
            state.problem()
        );
        assert_cleared(&f);
    }
}

/// `library.json` is read once: when that read fails for a moment (a pack held by a scanner, the
/// catalog failing to answer), the failure is the sync's at once, an error tried again, and no
/// later read of it passes without the check of its library id. Nor does any other answer come
/// first: not a cap the metadata is over, nor the problem of `.folio/ignore`, which comes before
/// `library.json` in tree order.
#[test]
fn another_librarys_settings_that_fail_to_read_once_are_not_read_again() {
    let f = library();
    let mut tree = f.disk_tree();
    let other = LibraryConfig {
        id: LibraryId::parse("fedcba9876543210fedcba9876543210").unwrap(),
        name: DisplayName::parse("别人的").unwrap(),
        versioning: VersioningRules::default(),
    };
    tree.put(".folio/library.json", to_bytes(&other).unwrap());
    tree.put(".folio/ignore", b"*.tmp\n".to_vec());
    write_head(&f.store(), &tree, None, &|_| false);
    // Indexes the pack.
    assert!(matches!(
        f.sync().problem(),
        Some(HeadProblem::OtherLibrary { .. })
    ));
    let rows: Vec<HeadRow> = tree
        .rows
        .iter()
        .map(|(at, side)| HeadRow {
            path: path(at),
            file: side.map(|side| HeadFile {
                hash: ContentHash::from(side.hash),
                size: side.size.get(),
                stored: side.stored,
            }),
        })
        .collect();
    let ignore = ObjectId::of(ObjectKind::Blob, b"*.tmp\n");
    let store = f.store();
    // Reads the metadata within `bounds`, the first read (`library.json`'s) failing when
    // `fail_first`, and `.folio/ignore`'s blob missing when `ignore_missing`.
    let read = |fail_first: bool, ignore_missing: bool, bounds: Bounds| {
        let mut reads = 0;
        f.catalog
            .read(|tx| {
                let locator = CatalogLocator(tx);
                Ok(read_meta_with(
                    &rows,
                    &f.id(),
                    &AtomicBool::new(false),
                    bounds,
                    &mut |file| {
                        reads += 1;
                        if fail_first && reads == 1 {
                            return Err(StoreError::Io {
                                path: PathBuf::new(),
                                source: io::Error::other("held by another program"),
                            });
                        }
                        if ignore_missing && ObjectId::from(&file.hash) == ignore {
                            return Err(StoreError::Missing(ignore));
                        }
                        read_blob(&store, &locator, file)
                    },
                ))
            })
            .unwrap()
    };
    // One metadata file is all the cap lets through: `library.json` is the second.
    let one_file = Bounds {
        meta_files: 1,
        ..Bounds::DEFAULT
    };
    for (what, ignore_missing, bounds) in [
        ("read", false, Bounds::DEFAULT),
        ("over the cap", false, one_file),
        ("ignore missing", true, Bounds::DEFAULT),
    ] {
        let found = read(false, ignore_missing, bounds);
        assert!(
            matches!(found, Ok(Err(HeadProblem::OtherLibrary { .. }))),
            "{what}: {found:?}"
        );
        let failed = read(true, ignore_missing, bounds);
        assert!(
            matches!(failed, Err(SyncError::Io(_))),
            "{what}: {failed:?}"
        );
    }
}

/// Changes the catalog's revision has after a sync's first write: a cancel while that write runs.
struct AfterFirstWrite<'a> {
    catalog: &'a Catalog,
    revision: u32,
}

impl<'a> AfterFirstWrite<'a> {
    fn new(catalog: &'a Catalog) -> Self {
        Self {
            catalog,
            revision: catalog.stamp().revision,
        }
    }
}

impl Cancel for AfterFirstWrite<'_> {
    fn cancelled(&self) -> bool {
        self.catalog.stamp().revision != self.revision
    }
}

/// The user cancels while the first write, the packs' index, runs: no write follows, so the rows
/// and marks of the `HEAD` before stay, also when the new `HEAD` names a commit no pack holds,
/// which an uncancelled sync clears them for.
#[test]
fn a_cancel_while_the_packs_are_indexed_stops_the_sync_before_its_next_write() {
    for damaged in [false, true] {
        let f = library();
        f.commit_all(None);
        let before = (rows(&f), marks(&f));
        if damaged {
            f.store().write_head(ObjectId::from_bytes([7; 32])).unwrap();
        }
        let cancelled = forced_sync(&f, &AfterFirstWrite::new(&f.catalog));
        assert!(
            matches!(cancelled, Err(SyncError::Cancelled)),
            "{cancelled:?}"
        );
        assert_eq!((rows(&f), marks(&f)), before);
        let expected = if damaged {
            HistoryStatus::Damaged
        } else {
            HistoryStatus::Ready
        };
        assert_eq!(f.sync().status(), expected);
    }
}

/// A forced sync of a `HEAD` naming a commit no pack holds asks five times: before it starts,
/// before the pack's index is read and before it is written, before `HEAD`'s tree is read, and
/// before the rows are cleared. Cancelled at any of them, it stops there, and the rows and marks of
/// the `HEAD` before stay; only the pack's index is written, once its own question passed.
#[test]
fn a_sync_of_a_damaged_head_stops_at_whichever_question_it_is_cancelled() {
    let damaged = || {
        let f = library();
        f.commit_all(None);
        f.store().write_head(ObjectId::from_bytes([7; 32])).unwrap();
        f
    };
    let f = damaged();
    let never = CancelAt::new(usize::MAX);
    assert_eq!(
        forced_sync(&f, &never).unwrap().status(),
        HistoryStatus::Damaged
    );
    assert_cleared(&f);
    assert_eq!(never.asked.get(), 5);
    for at in 1..=5 {
        let f = damaged();
        let before = (rows(&f), marks(&f));
        let revision = f.catalog.stamp().revision;
        let cancel = CancelAt::new(at);
        let result = forced_sync(&f, &cancel);
        assert!(
            matches!(result, Err(SyncError::Cancelled)),
            "cancelled at question {at}: {result:?}"
        );
        assert_eq!(cancel.asked.get(), at);
        assert_eq!((rows(&f), marks(&f)), before);
        let writes = u32::from(at > 3);
        assert_eq!(
            f.catalog.stamp().revision - revision,
            writes,
            "writes before question {at}"
        );
    }
}

/// The names of the packs the catalog indexes.
fn indexed(f: &Fixture) -> Vec<PackName> {
    f.catalog
        .read(|tx| indexed_packs(tx))
        .unwrap()
        .into_iter()
        .map(|pack| pack.name)
        .collect()
}

/// A `HEAD` that stays damaged, or too large, is found so again at every sync without a write:
/// the packs it indexed are not indexed again, and its rows are gone already.
#[test]
fn a_head_that_stays_damaged_or_too_large_is_synced_again_without_a_write() {
    let f = library();
    f.commit_all(None);
    f.store().write_head(ObjectId::from_bytes([7; 32])).unwrap();
    assert_eq!(f.sync().status(), HistoryStatus::Damaged);
    let revision = f.catalog.stamp().revision;
    assert_eq!(f.sync().status(), HistoryStatus::Damaged);
    assert_eq!(f.catalog.stamp().revision, revision, "a damaged HEAD");

    let f = library();
    write_head(&f.store(), &f.disk_tree(), None, &|_| false);
    let small = Bounds {
        entries: 3,
        ..Bounds::DEFAULT
    };
    assert_eq!(f.sync_within(small).status(), HistoryStatus::TooLarge);
    let revision = f.catalog.stamp().revision;
    assert_eq!(f.sync_within(small).status(), HistoryStatus::TooLarge);
    assert_eq!(f.catalog.stamp().revision, revision, "a HEAD too large");
}

/// Each new pack is indexed by itself; once a pack the catalog indexes is gone, the index is filled
/// again from the others, where the objects the two shared are found then.
#[test]
fn the_packs_index_follows_the_packs() {
    let f = library();
    let (first, _) = f.commit_all(None);
    let old = f.store().list_packs().unwrap().packs;
    assert_eq!(old.len(), 1);
    f.fs.file("new.md", b"new");
    let (_, state) = f.commit_all(Some(first));
    assert_eq!(state.status(), HistoryStatus::Ready);
    let both = f.store().list_packs().unwrap().packs;
    assert_eq!(both.len(), 2);
    assert_eq!(indexed(&f), both);

    // `library.json`'s blob, in both packs, is found in the old one, indexed first.
    fs::remove_file(f.store().pack_path(old[0])).unwrap();
    assert_eq!(f.sync().status(), HistoryStatus::Ready);
    let left: Vec<PackName> = both.into_iter().filter(|name| *name != old[0]).collect();
    assert_eq!(indexed(&f), left);
}

/// A commit stores only the objects the index does not find, so `HEAD`'s tree spans the packs of
/// several commits: a forced sync, as after a catalog rebuild, indexes every one of them, whatever
/// order their names come in.
#[test]
fn a_forced_sync_indexes_every_pack_heads_tree_spans() {
    let f = library();
    let (first, _) = f.commit_all(None);
    f.fs.file("2026 秋/线代/新.md", b"new");
    f.scan();
    f.hash_all();
    let tree = f.disk_tree();
    let stored = |id| f.catalog.read(|tx| has_object(tx, id)).unwrap();
    let written = write_head(&f.store(), &tree, Some(first), &stored);
    let packs = f.store().list_packs().unwrap().packs;
    assert_eq!(packs.len(), 2);
    assert_eq!(f.sync().status(), HistoryStatus::Ready);
    // The new note's blob, the folders above it and the commit are in the new pack; every other
    // file, `.folio/` and `empty` are in the first one.
    let first_pack = f.catalog.read(|tx| object_location(tx, first)).unwrap();
    let library_blob = tree.rows[".folio/library.json"].unwrap().hash;
    let in_first = f
        .catalog
        .read(|tx| object_location(tx, library_blob))
        .unwrap();
    assert_eq!(in_first.map(|at| at.pack), first_pack.map(|at| at.pack));
    for _ in 0..2 {
        let state = f.sync_forced();
        assert_eq!(
            not_ready(&state),
            (HistoryStatus::Ready, Some(written.commit), true, true)
        );
        assert_eq!(rows(&f), expected_rows(&tree, &written.trees));
        assert_eq!(indexed(&f), packs);
    }
}

/// Swaps the offsets of the root tree's entry in the index of `written`'s one pack and of the
/// entry after it: the index still reads, and the full check refuses the pack. Returns the pack's
/// path and its good bytes.
fn swap_root_offsets(
    f: &Fixture,
    written: &crate::workspace::testing::Written,
) -> (PathBuf, Vec<u8>) {
    let packs = f.store().list_packs().unwrap().packs;
    assert_eq!(packs.len(), 1);
    let pack = f.store().pack_path(packs[0]);
    let good = fs::read(&pack).unwrap();
    // remote-format.md §9: the index's entries (an id and an offset, 40 bytes each) end 48 bytes
    // before the end, where the trailer states their count.
    let len = good.len();
    let count = usize::try_from(u64::from_le_bytes(
        good[len - 48..len - 40].try_into().unwrap(),
    ))
    .unwrap();
    let index_at = len - 48 - 40 * count;
    let root = written.trees[""];
    let entry = (0..count)
        .find(|k| good[index_at + 40 * k..index_at + 40 * k + 32] == root.as_bytes()[..])
        .unwrap();
    let (a, b) = (
        index_at + 40 * entry + 32,
        index_at + 40 * ((entry + 1) % count) + 32,
    );
    let mut bad = good.clone();
    bad[a..a + 8].copy_from_slice(&good[b..b + 8]);
    bad[b..b + 8].copy_from_slice(&good[a..a + 8]);
    fs::write(&pack, &bad).unwrap();
    assert!(
        f.store().read_pack_index(packs[0]).is_ok(),
        "the damaged index reads"
    );
    assert!(
        f.store().verify_pack(packs[0]).is_err(),
        "the full check refuses it"
    );
    (pack, good)
}

/// A pack whose index reads but is damaged makes the history damaged, and synced again it stays so
/// without a write; once a good copy of its name replaces it, as `LocalStore::publish` replaces a
/// damaged pack, the next sync reads its index again, indexes it again and finds `HEAD` ready.
#[test]
fn a_pack_replaced_by_a_good_copy_is_indexed_again() {
    let f = library();
    let tree = f.disk_tree();
    let written = write_head(&f.store(), &tree, None, &|_| false);
    let (pack, good) = swap_root_offsets(&f, &written);
    let state = f.sync();
    assert_eq!(state.status(), HistoryStatus::Damaged);
    assert!(
        matches!(
            state.problem(),
            Some(HeadProblem::Store(StoreError::Invalid { .. }))
        ),
        "{:?}",
        state.problem()
    );
    let revision = f.catalog.stamp().revision;
    assert_eq!(f.sync().status(), HistoryStatus::Damaged);
    assert_eq!(
        f.catalog.stamp().revision,
        revision,
        "a pack that stays damaged"
    );

    fs::write(&pack, &good).unwrap();
    let state = f.sync();
    assert_eq!(
        not_ready(&state),
        (HistoryStatus::Ready, Some(written.commit), true, true)
    );
    assert_eq!(rows(&f), expected_rows(&tree, &written.trees));
    let revision = f.catalog.stamp().revision;
    assert_eq!(f.sync().status(), HistoryStatus::Ready);
    assert_eq!(f.catalog.stamp().revision, revision);
}

/// The sync that indexes a replaced pack again asks the questions of the sync that found it
/// damaged, then one before the index is written: cancelled at any of them, it writes nothing,
/// and after it, the index is written.
#[test]
fn a_pack_indexed_again_asks_before_its_write() {
    // The questions of a sync that finds the pack damaged; the last is before its index is read
    // again.
    let replaced = |cancel: &dyn Cancel| {
        let f = library();
        let written = write_head(&f.store(), &f.disk_tree(), None, &|_| false);
        let (pack, good) = swap_root_offsets(&f, &written);
        assert_eq!(f.sync().status(), HistoryStatus::Damaged);
        let damaged = CancelAt::new(usize::MAX);
        let synced = sync_within(
            &f.catalog,
            f.layout(),
            &f.id(),
            false,
            &damaged,
            Bounds::DEFAULT,
        );
        assert_eq!(synced.unwrap().status(), HistoryStatus::Damaged);
        fs::write(&pack, &good).unwrap();
        let revision = f.catalog.stamp().revision;
        let result = sync_within(
            &f.catalog,
            f.layout(),
            &f.id(),
            false,
            cancel,
            Bounds::DEFAULT,
        );
        (
            damaged.asked.get(),
            result,
            f.catalog.stamp().revision - revision,
        )
    };
    let (asked, result, _) = replaced(&CancelAt::new(usize::MAX));
    assert_eq!(result.unwrap().status(), HistoryStatus::Ready);
    for at in 1..=asked + 2 {
        let (_, result, writes) = replaced(&CancelAt::new(at));
        assert!(
            matches!(result, Err(SyncError::Cancelled)),
            "cancelled at question {at}: {result:?}"
        );
        assert_eq!(
            writes,
            u32::from(at > asked + 1),
            "writes before question {at}"
        );
    }
}

/// A crash at any step of the sync that indexes a replaced pack again: the next sync finds the
/// pack's old index in the catalog, or its new one, and ends with `HEAD` ready either way.
#[test]
fn a_crash_while_a_replaced_pack_is_indexed_again_leaves_it_to_the_next_sync() {
    let steps = each_point(|arm| {
        let f = library();
        let tree = f.disk_tree();
        let written = write_head(&f.store(), &tree, None, &|_| false);
        let (pack, good) = swap_root_offsets(&f, &written);
        assert_eq!(f.sync().status(), HistoryStatus::Damaged);
        fs::write(&pack, &good).unwrap();
        let _ = arm.run(|| f.sync());
        assert_eq!(f.sync().status(), HistoryStatus::Ready);
        assert_eq!(rows(&f), expected_rows(&tree, &written.trees));
    });
    assert_eq!(steps, ["head.index", "head.files", "head.marks"]);
}

/// A crash at any step of a forced sync of a library whose marks are current: the next sync, which
/// finds them current, completes the index first, where `HEAD`'s new metadata blob is.
#[test]
fn a_crash_while_the_packs_are_indexed_leaves_the_rest_to_the_next_sync() {
    let steps = each_point(|arm| {
        let f = library();
        let (first, _) = f.commit_all(None);
        let mut config = f.layout().read_library().unwrap().unwrap();
        config.name = DisplayName::parse("改名").unwrap();
        f.layout().write_library(&config).unwrap();
        let (_, state) = f.commit_all(Some(first));
        assert_eq!(state.status(), HistoryStatus::Ready);
        let expected = rows(&f);
        let _ = arm.run(|| f.sync_forced());
        assert_eq!(f.sync().status(), HistoryStatus::Ready);
        assert_eq!(rows(&f), expected);
        assert_eq!(indexed(&f), f.store().list_packs().unwrap().packs);
    });
    assert_eq!(steps[..2], ["head.index", "head.index"]);
    assert_eq!(steps.last(), Some(&"head.marks"));
}

#[test]
fn metadata_a_newer_folio_wrote_is_read_only_and_invalid_metadata_damage_but_items_list() {
    let f = library();
    let mut tree = f.disk_tree();
    tree.put(".folio/tags.json", br#"{"format_version":99}"#.to_vec());
    let written = write_head(&f.store(), &tree, None, &|_| false);
    let state = f.sync();
    assert_eq!(
        not_ready(&state),
        (HistoryStatus::ReadOnly, Some(written.commit), true, false)
    );
    assert!(matches!(
        state.problem(),
        Some(HeadProblem::Meta(HeadMetaError::Newer { .. }))
    ));
    assert_eq!(marks(&f).head, Some(written.commit));

    let mut tree = f.disk_tree();
    tree.put(".folio/meta/_root.json", b"not json".to_vec());
    let written = write_head(&f.store(), &tree, Some(written.commit), &|_| false);
    let state = f.sync();
    assert_eq!(
        not_ready(&state),
        (HistoryStatus::Damaged, Some(written.commit), true, false)
    );
    assert!(matches!(
        state.problem(),
        Some(HeadProblem::Meta(HeadMetaError::Invalid { .. }))
    ));
    assert_eq!(rows(&f), expected_rows(&tree, &written.trees));
}

#[test]
fn metadata_over_the_caps_or_of_another_size_than_its_tree_says_is_damage() {
    let f = library();
    let mut tree = f.disk_tree();
    let tags = tree.rows[".folio/tags.json"].unwrap();
    let huge = Side {
        size: Size::new(MAX_META_FILE_BYTES + 1).unwrap(),
        ..tags
    };
    tree.rows.insert(".folio/tags.json".into(), Some(huge));
    write_head(&f.store(), &tree, None, &|_| false);
    let state = f.sync();
    assert_eq!(state.status(), HistoryStatus::Damaged);
    assert!(state.lists_items());
    assert!(matches!(
        state.problem(),
        Some(HeadProblem::MetaTooLarge { path: at }) if at.as_str() == ".folio/tags.json"
    ));

    let short = Side {
        size: Size::new(tags.size.get() - 1).unwrap(),
        ..tags
    };
    tree.rows.insert(".folio/tags.json".into(), Some(short));
    write_head(&f.store(), &tree, None, &|_| false);
    let state = f.sync();
    assert!(matches!(
        state.problem(),
        Some(HeadProblem::SizeDiffers { tree, blob, .. }) if *tree + 1 == *blob
    ));
    // A blob that is not what its id says is damage too.
    let invalid = HeadProblem::Store(StoreError::Invalid {
        what: crate::store::Subject::Object(tags.hash),
        problem: Problem::FormatVersion,
    });
    assert_eq!(invalid.status(), HistoryStatus::Damaged);
}

/// The problem the head sync within `bounds` finds in `tree`, written as `HEAD` of `f`.
fn problem_of(f: &Fixture, tree: &HeadTree, bounds: Bounds) -> String {
    write_head(&f.store(), tree, None, &|_| false);
    let state = f.sync_within(bounds);
    assert!(state.lists_items());
    match state.problem() {
        Some(HeadProblem::MetaTooLarge { path: at }) => format!("too large at {at}"),
        Some(HeadProblem::SizeDiffers { path: at, .. }) => format!("size differs at {at}"),
        Some(HeadProblem::Store(StoreError::Missing(_))) => "missing".to_owned(),
        other => panic!("{other:?}"),
    }
}

#[test]
fn more_metadata_files_than_the_cap_is_damage() {
    // The caps are checked on the tree's sizes, before any blob is read: course files of HEAD's
    // tree without blobs, which the sync misses once it reads them.
    let f = library();
    let bounds = Bounds {
        meta_files: 20,
        ..Bounds::DEFAULT
    };
    let side = |n: u64| {
        Some(Side {
            hash: ObjectId::from_bytes([5; 32]),
            size: Size::new(n).unwrap(),
            stored: true,
        })
    };
    let mut tree = f.disk_tree();
    tree.rows.insert(".folio/meta".into(), None);
    tree.rows.insert(".folio/meta/2026 秋".into(), None);
    // `library.json` and `tags.json` besides: 20 files.
    for n in 0..18 {
        tree.rows
            .insert(format!(".folio/meta/2026 秋/c{n:02}.json"), side(10));
    }
    assert_eq!(problem_of(&f, &tree, bounds), "missing");
    // One more: the cap is reached at the last file in tree order.
    tree.rows
        .insert(".folio/meta/2026 秋/c99.json".into(), side(10));
    assert_eq!(
        problem_of(&f, &tree, bounds),
        "too large at .folio/tags.json"
    );
}

#[test]
fn more_bytes_of_metadata_than_the_cap_is_damage() {
    let f = library();
    let mut tree = f.disk_tree();
    let resize = |tree: &mut HeadTree, at: &str, size: u64| {
        let side = tree.rows[at].unwrap();
        tree.rows.insert(
            at.into(),
            Some(Side {
                size: Size::new(size).unwrap(),
                ..side
            }),
        );
    };
    // Two files of the most one may have: the most all may have, which the blobs then belie.
    resize(&mut tree, ".folio/library.json", MAX_META_FILE_BYTES);
    resize(&mut tree, ".folio/tags.json", MAX_META_FILE_BYTES);
    assert_eq!(MAX_META_FILE_BYTES * 2, MAX_META_BYTES);
    assert_eq!(
        problem_of(&f, &tree, Bounds::DEFAULT),
        "size differs at .folio/library.json"
    );
    // One byte more in a file between them in tree order: the total is over at `tags.json`.
    tree.put(".folio/meta/_root.json", b"{".to_vec());
    assert_eq!(
        problem_of(&f, &tree, Bounds::DEFAULT),
        "too large at .folio/tags.json"
    );
}

#[test]
fn a_synced_head_is_derived_again_only_when_forced_or_changed() {
    let f = library();
    let (head, _) = f.commit_all(None);
    let before = rows(&f);
    let tampered = "UPDATE head_files SET hash = 'b3:' || substr(hash, 4, 63) || '0'
                    WHERE path = '2026 秋/syllabus.pdf'";
    let tamper = || {
        f.catalog
            .write(|tx| {
                tx.execute(tampered, [])?;
                Ok(())
            })
            .unwrap();
    };
    tamper();
    let after = rows(&f);
    assert_ne!(after, before);
    assert_eq!(f.sync().head(), Some(head));
    assert_eq!(rows(&f), after, "the marks say the rows are current");
    assert_eq!(f.sync_forced().status(), HistoryStatus::Ready);
    assert_eq!(rows(&f), before);
    // A new HEAD is derived again.
    tamper();
    f.fs.file("new.md", b"new");
    let (next, state) = f.commit_all(Some(head));
    assert_eq!(state.head(), Some(next));
    let now = rows(&f);
    assert!(now.iter().any(|(at, _)| at == "new.md"));
    let syllabus = |rows: &[(String, String)]| {
        rows.iter()
            .find(|(at, _)| at == "2026 秋/syllabus.pdf")
            .cloned()
    };
    assert_eq!(syllabus(&now), syllabus(&before));
    assert_eq!(marks(&f).head, Some(next));
}

#[test]
fn a_crash_at_any_step_leaves_what_the_next_sync_derives_again() {
    let mut expected = None;
    let steps = each_point(|arm| {
        let f = library();
        let tree = f.disk_tree();
        let written = write_head(&f.store(), &tree, None, &|_| false);
        let result = arm.run(|| f.sync());
        match result {
            Ok(state) => assert_eq!(state.status(), HistoryStatus::Ready),
            // Rows without the marks are not `HEAD`'s.
            Err(_) => assert_eq!(marks(&f), HistoryMarks::default()),
        }
        let state = f.sync();
        assert_eq!(state.status(), HistoryStatus::Ready);
        assert_eq!(rows(&f), expected_rows(&tree, &written.trees));
        expected.get_or_insert(written.commit);
    });
    assert_eq!(steps, ["head.index", "head.files", "head.marks"]);
    assert!(expected.is_some());
}

#[test]
fn a_tree_is_written_in_runs_each_paired_that_a_crash_leaves_to_the_next_sync() {
    let bounds = Bounds {
        run_rows: 4,
        ..Bounds::DEFAULT
    };
    let count = Cell::new(0);
    let steps = each_point(|arm| {
        let f = library();
        f.fs.file("zz.md", b"last");
        f.scan();
        f.hash_all();
        let tree = f.disk_tree();
        count.set(tree.rows.len());
        let written = write_head(&f.store(), &tree, None, &|_| false);
        match arm.run(|| f.sync_within(bounds)) {
            Ok(state) => assert_eq!(state.status(), HistoryStatus::Ready),
            // Rows without the marks are not `HEAD`'s.
            Err(_) => assert_eq!(marks(&f), HistoryMarks::default()),
        }
        assert_eq!(f.sync_within(bounds).status(), HistoryStatus::Ready);
        assert_eq!(rows(&f), expected_rows(&tree, &written.trees));
        // Each run is paired by path, the first and the last.
        for at in tree.rows.keys().filter(|at| !at.starts_with(".folio")) {
            let entry = f.catalog.read(|tx| paired_entry(tx, &path(at))).unwrap();
            assert_eq!(entry, Some(f.entry(at).id), "{at}");
        }
    });
    let runs = count.get().div_ceil(4);
    assert!(runs >= 3, "{runs} runs");
    let mut expected = vec!["head.index"];
    expected.extend(std::iter::repeat_n("head.files", runs));
    expected.push("head.marks");
    assert_eq!(steps, expected);
}

#[test]
fn runs_hold_a_bounded_count_and_bytes_of_rows() {
    let side = Side {
        hash: ObjectId::from_bytes([1; 32]),
        size: Size::new(1).unwrap(),
        stored: false,
    };
    let rows = |lengths: &[usize]| -> Vec<HeadFileRow> {
        lengths
            .iter()
            .enumerate()
            .map(|(n, &length)| HeadFileRow {
                path: path(&format!("{n:02}{}", "y".repeat(length - 2))),
                entry: HeadEntry::File(side),
            })
            .collect()
    };
    let lengths = |rows: &[HeadFileRow], max_rows, max_bytes| {
        runs(rows, max_rows, max_bytes)
            .map(<[_]>::len)
            .collect::<Vec<_>>()
    };
    assert_eq!(lengths(&[], 3, 100), [0]);
    // By count: three rows a run, or two, whatever more the bytes would allow.
    assert_eq!(lengths(&rows(&[4; 7]), 3, 100), [3, 3, 1]);
    assert_eq!(lengths(&rows(&[10; 5]), 2, 35), [2, 2, 1]);
    // By bytes: two paths of 10 bytes fit in 20 or 25, three do not.
    assert_eq!(lengths(&rows(&[10; 5]), 100, 25), [2, 2, 1]);
    assert_eq!(lengths(&rows(&[10; 5]), 100, 20), [2, 2, 1]);
    // A path longer than a run's bytes is a run of its own.
    assert_eq!(lengths(&rows(&[4, 30, 4]), 100, 10), [1, 1, 1]);
    // No run is empty, whatever the count asked.
    assert_eq!(lengths(&rows(&[4; 2]), 0, 100), [1, 1]);
}

#[test]
fn a_tree_over_the_bytes_of_paths_head_files_keeps_is_too_large() {
    let f = library();
    let tree = f.disk_tree();
    let bytes: usize = tree.rows.keys().map(String::len).sum();
    let written = write_head(&f.store(), &tree, None, &|_| false);
    let within = |path_bytes| {
        f.sync_within(Bounds {
            path_bytes,
            ..Bounds::DEFAULT
        })
    };
    let state = within(bytes - 1);
    assert_eq!(
        not_ready(&state),
        (HistoryStatus::TooLarge, Some(written.commit), false, false)
    );
    assert!(matches!(
        state.problem(),
        Some(HeadProblem::PathsTooLong { bytes: found, limit }) if *found == bytes && *limit == bytes - 1
    ));
    assert_cleared(&f);
    assert_eq!(within(bytes).status(), HistoryStatus::Ready);
}

/// A crafted `HEAD` well within the store's path budget: a chain of nested one-letter folders,
/// whose paths add up to the depth squared: past 64 KiB at a depth of 256, and past what
/// `head_files` keeps ([`MAX_HEAD_PATH_BYTES`]) at about 5,800.
#[test]
fn a_chain_of_folders_past_the_bytes_of_paths_folio_keeps_is_too_large() {
    let f = library();
    let limit = 64 << 10;
    let mut tree = f.disk_tree();
    let mut at = String::from("c");
    let mut bytes: usize = tree.rows.keys().map(String::len).sum();
    while bytes <= limit {
        bytes += at.len();
        tree.rows.insert(at.clone(), None);
        at.push_str("/c");
    }
    assert!(tree.rows.len() < 300);
    let written = write_head(&f.store(), &tree, None, &|_| false);
    let state = f.sync_within(Bounds {
        path_bytes: limit,
        ..Bounds::DEFAULT
    });
    assert_eq!(
        not_ready(&state),
        (HistoryStatus::TooLarge, Some(written.commit), false, false)
    );
    assert!(matches!(
        state.problem(),
        Some(HeadProblem::PathsTooLong { bytes: found, limit: cap }) if *found == bytes && *cap == limit
    ));
    assert_cleared(&f);
}

#[test]
fn problems_say_what_state_they_put_the_history_in() {
    let id = ObjectId::from_bytes([3; 32]);
    let store = |error| HeadProblem::Store(error).status();
    assert_eq!(store(StoreError::Missing(id)), HistoryStatus::Damaged);
    assert_eq!(store(StoreError::Pruned(id)), HistoryStatus::Damaged);
    assert_eq!(
        store(StoreError::Newer {
            what: crate::store::Subject::Object(id),
            version: "2".into()
        }),
        HistoryStatus::ReadOnly
    );
    assert_eq!(
        store(StoreError::TooLarge {
            what: crate::store::Subject::Object(id),
            limit: crate::store::Limit::Paths(1)
        }),
        HistoryStatus::TooLarge
    );
    assert_eq!(
        HeadProblem::Meta(HeadMetaError::NoLibrary).status(),
        HistoryStatus::Damaged
    );
    assert_eq!(HeadState::none().status(), HistoryStatus::None);
}
