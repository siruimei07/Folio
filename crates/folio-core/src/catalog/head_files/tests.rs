use std::collections::{BTreeMap, HashMap, HashSet};

use proptest::prelude::*;

use super::*;
use crate::catalog::unhashed::unhashed_reason;
use crate::catalog::{Catalog, entries_in};
use crate::fs::Presence;
use crate::meta::is_folio_owned;
use crate::test_support::path;
use crate::workspace::testing::{Fixture, pairing};
use crate::workspace::{HistoryStatus, Workspace};

/// The rows and the paths of the entries paired with them, without `.folio/`.
fn paired(f: &Fixture) -> Vec<(String, Option<String>)> {
    pairing(&f.catalog)
        .into_iter()
        .filter(|(at, _)| !at.starts_with(".folio"))
        .collect()
}

fn row(at: &str, entry: Option<&str>) -> (String, Option<String>) {
    (at.to_owned(), entry.map(str::to_owned))
}

fn pair(f: &Fixture) -> usize {
    f.catalog.write(|tx| pair_by_path(tx)).unwrap()
}

fn pairable(f: &Fixture) -> bool {
    f.catalog.read(|tx| comparison(tx)).unwrap().pairable()
}

/// A library with a course folder and two files, committed whole.
fn committed() -> Fixture {
    let f = Fixture::new();
    f.fs.file("s/c/a.md", b"a");
    f.fs.file("s/c/b.pdf", b"b");
    f.fs.file("top.txt", b"t");
    let (_, state) = f.commit_all(None);
    assert_eq!(state.status(), HistoryStatus::Ready);
    f
}

#[test]
fn a_head_sync_pairs_every_row_by_path() {
    let f = committed();
    assert_eq!(
        paired(&f),
        [
            row("s", Some("s")),
            row("s/c", Some("s/c")),
            row("s/c/a.md", Some("s/c/a.md")),
            row("s/c/b.pdf", Some("s/c/b.pdf")),
            row("top.txt", Some("top.txt")),
        ]
    );
    // `.folio/` is in the tree, and pairs with nothing.
    let folio: Vec<_> = pairing(&f.catalog)
        .into_iter()
        .filter(|(at, _)| at.starts_with(".folio"))
        .collect();
    assert!(folio.contains(&row(".folio/library.json", None)));
    assert!(!pairable(&f));
}

#[test]
fn removing_an_entry_unpairs_its_row() {
    let f = committed();
    f.fs.remove("s/c/a.md");
    f.scan();
    assert_eq!(paired(&f)[2], row("s/c/a.md", None));
    // A folder takes everything below it.
    f.fs.remove("s");
    f.scan();
    assert_eq!(
        paired(&f),
        [
            row("s", None),
            row("s/c", None),
            row("s/c/a.md", None),
            row("s/c/b.pdf", None),
            row("top.txt", Some("top.txt")),
        ]
    );
    assert!(!pairable(&f));
}

#[test]
fn a_row_pairs_again_with_a_new_entry_at_its_path() {
    let f = committed();
    let old = f.entry("top.txt").id;
    f.fs.remove("top.txt");
    f.scan();
    f.fs.file("top.txt", b"again");
    f.scan();
    assert_ne!(f.entry("top.txt").id, old);
    assert_eq!(paired(&f)[4], row("top.txt", None));
    assert!(pairable(&f));
    assert_eq!(pair(&f), 1);
    assert_eq!(paired(&f)[4], row("top.txt", Some("top.txt")));
    let entry = f
        .catalog
        .read(|tx| paired_entry(tx, &path("top.txt")))
        .unwrap();
    assert_eq!(entry, Some(f.entry("top.txt").id));
    // Nothing left to pair: no write, no new revision.
    let revision = f.catalog.stamp().revision;
    assert!(!pairable(&f));
    assert_eq!(pair(&f), 0);
    assert_eq!(f.catalog.stamp().revision, revision);
}

#[test]
fn saves_through_a_temporary_file_and_moves_keep_the_pairing() {
    let f = committed();
    f.fs.replace("s/c/a.md", b"saved");
    f.fs.rename("s/c/b.pdf", "s/c/moved.pdf");
    f.fs.rename("s", "t");
    f.scan();
    assert_eq!(
        paired(&f),
        [
            row("s", Some("t")),
            row("s/c", Some("t/c")),
            row("s/c/a.md", Some("t/c/a.md")),
            row("s/c/b.pdf", Some("t/c/moved.pdf")),
            row("top.txt", Some("top.txt")),
        ]
    );
}

#[test]
fn a_case_only_rename_keeps_the_pairing_only_with_file_ids() {
    let f = committed();
    f.fs.rename("top.txt", "TOP.txt");
    f.scan();
    assert_eq!(paired(&f)[4], row("top.txt", Some("TOP.txt")));

    let f = committed();
    f.fs.without_id("top.txt");
    f.scan();
    f.fs.rename("top.txt", "TOP.txt");
    f.scan();
    // Without file ids the scan sees a deletion and an addition, and paths differ in case.
    assert_eq!(paired(&f)[4], row("top.txt", None));
    assert!(!pairable(&f));
    assert!(
        f.catalog
            .read(|tx| comparison(tx))
            .unwrap()
            .added
            .iter()
            .any(|entry| { entry.path == path("TOP.txt") })
    );
}

#[test]
fn rows_pair_only_with_unpaired_entries_of_their_kind() {
    let f = committed();
    // `top.txt` moves to `s/c/a.md`'s place after that file went: the entry there is paired
    // with the row it came from.
    f.fs.remove("s/c/a.md");
    f.fs.rename("top.txt", "s/c/a.md");
    // A folder takes the place of a file.
    f.fs.remove("s/c/b.pdf");
    f.fs.folder("s/c/b.pdf");
    f.scan();
    assert!(!pairable(&f));
    assert_eq!(pair(&f), 0);
    assert_eq!(
        paired(&f),
        [
            row("s", Some("s")),
            row("s/c", Some("s/c")),
            row("s/c/a.md", None),
            row("s/c/b.pdf", None),
            row("top.txt", Some("s/c/a.md")),
        ]
    );
}

#[test]
fn a_catalog_reset_pairs_by_path() {
    let f = committed();
    f.fs.rename("top.txt", "moved.txt");
    f.scan();
    f.library.reset_catalog(&f.catalog).unwrap();
    assert!(paired(&f).iter().all(|(_, entry)| entry.is_none()));
    f.scan();
    assert_eq!(pair(&f), 4);
    assert_eq!(
        paired(&f),
        [
            row("s", Some("s")),
            row("s/c", Some("s/c")),
            row("s/c/a.md", Some("s/c/a.md")),
            row("s/c/b.pdf", Some("s/c/b.pdf")),
            row("top.txt", None),
        ]
    );
}

#[test]
fn marks_read_back_and_clear() {
    let f = Fixture::new();
    let none = HistoryMarks {
        head: None,
        version: None,
    };
    assert_eq!(f.catalog.read(|tx| history_marks(tx)).unwrap(), none);
    let head = ObjectId::from_bytes([7; 32]);
    f.catalog.write(|tx| set_history_marks(tx, head)).unwrap();
    assert_eq!(
        f.catalog.read(|tx| history_marks(tx)).unwrap(),
        HistoryMarks {
            head: Some(head),
            version: Some(HISTORY_VERSION),
        }
    );
    // A mark that does not read is no mark.
    f.catalog
        .write(|tx| {
            tx.execute(
                "UPDATE info SET value = 'nonsense' WHERE key IN ('history_head', 'history_version')",
                [],
            )?;
            Ok(())
        })
        .unwrap();
    assert_eq!(f.catalog.read(|tx| history_marks(tx)).unwrap(), none);
    f.catalog.write(|tx| clear_head_files(tx)).unwrap();
    assert_eq!(f.catalog.read(|tx| history_marks(tx)).unwrap(), none);
    let revision = f.catalog.stamp().revision;
    f.catalog.write(|tx| clear_head_files(tx)).unwrap();
    assert_eq!(f.catalog.stamp().revision, revision, "clearing nothing");
}

// ---- the outermost displaced folders

fn outermost_of(folders: &[&str]) -> Vec<String> {
    let mut found: Vec<String> = outermost(folders.iter().copied())
        .into_iter()
        .map(str::to_owned)
        .collect();
    found.sort();
    found
}

#[test]
fn the_outermost_folders_lie_in_none_of_the_others() {
    assert_eq!(outermost_of(&[]), Vec::<String>::new());
    assert_eq!(
        outermost_of(&[
            "a/b/c", "a", "a/b", "a b", "ab/c", "x/y", "x/y/z/w", "q/r/s", "q/t"
        ]),
        ["a", "a b", "ab/c", "q/r/s", "q/t", "x/y"]
    );
    // Names that only begin like a folder's are not in it.
    assert_eq!(
        outermost_of(&["s/c", "s/c d/e", "s/cd"]),
        ["s/c", "s/c d/e", "s/cd"]
    );
}

/// A chain of nested folders, as a crafted `HEAD` may hold: the folder at depth d has d - 1
/// ancestors, so probing each by an owned copy of its path, as the comparison first did, costs
/// the depth cubed (76 s for these two in a debug build), while probing slices of the paths and
/// keeping what each probe learns costs their bytes (well under a second).
#[test]
fn the_outermost_folders_of_a_deep_chain_cost_their_bytes() {
    let depth = 3_000;
    let mut chain = Vec::with_capacity(depth);
    let mut at = String::from("c");
    for _ in 0..depth {
        chain.push(at.clone());
        at.push_str("/c");
    }
    // Deleted leaves below a chain that is in place, each with a long path of its own.
    let leaves: Vec<String> = (0..depth).map(|n| format!("{at}/{n}")).collect();
    let started = std::time::Instant::now();
    let found = outermost(chain.iter().map(String::as_str));
    assert_eq!(found, ["c"]);
    let found = outermost(leaves.iter().map(String::as_str));
    assert_eq!(found.len(), depth);
    let took = started.elapsed();
    assert!(
        took < std::time::Duration::from_secs(5),
        "the outermost folders of a {depth}-deep chain took {took:?}"
    );
}

// ---- the comparison's read

/// What the workspace should compare, read the long way: every row and entry, then the rows
/// that differ from their entries or are below a folder row that is not in place, the rows
/// without one, and the entries no row pairs with (workspace::changes' input contract).
fn naive_comparison(catalog: &Catalog) -> Comparison {
    catalog
        .read(|tx| {
            let entries = entries_in(tx, None)?;
            let mut disk = HashMap::new();
            for entry in &entries {
                let below = format!("{}/", entry.record.path);
                let empty = entry.record.kind == EntryKind::Folder
                    && !entries
                        .iter()
                        .any(|other| other.record.path.as_str().starts_with(&below));
                let row = DiskRow {
                    entry: entry.id,
                    path: entry.record.path.clone(),
                    kind: entry.record.kind,
                    class: entry.record.class,
                    size: entry.record.size,
                    hash: entry.record.hash.clone(),
                    blocked: unhashed_reason(tx, entry.id)?,
                    empty,
                };
                disk.insert(entry.id, row);
            }
            let rows: Vec<(HeadRow, Option<EntryId>)> = {
                let mut statement = tx.prepare(&format!(
                    "SELECT {HEAD_COLUMNS}, h.entry_id FROM head_files AS h ORDER BY h.path"
                ))?;
                statement
                    .query_map([], |row| {
                        Ok((
                            head_row(row, 0)?,
                            row.get::<_, Option<i64>>(5)?.map(EntryId),
                        ))
                    })?
                    .collect::<Result<_, _>>()?
            };
            let displaced: HashSet<RelPath> = rows
                .iter()
                .filter(|(row, id)| {
                    row.kind() == EntryKind::Folder
                        && id.is_none_or(|id| {
                            let entry = &disk[&id];
                            entry.path != row.path || entry.kind != row.kind()
                        })
                })
                .map(|(row, _)| row.path.clone())
                .collect();
            let mut comparison = Comparison::default();
            let mut paired_ids = HashSet::new();
            for (row, id) in rows {
                match id {
                    Some(id) => {
                        let entry = &disk[&id];
                        paired_ids.insert(id);
                        let differs = entry.path != row.path
                            || entry.kind != row.kind()
                            || row.file.as_ref().is_some_and(|file| {
                                file.size != entry.size
                                    || entry.hash.as_ref().is_some_and(|hash| *hash != file.hash)
                            });
                        let below = row
                            .path
                            .ancestors()
                            .skip(1)
                            .any(|folder| displaced.contains(&folder));
                        if differs || below {
                            comparison.paired.push((row, entry.clone()));
                        }
                    }
                    None if is_folio_owned(&row.path) => {}
                    None => comparison.deleted.push(row),
                }
            }
            comparison.added = entries
                .iter()
                .filter(|entry| !paired_ids.contains(&entry.id))
                .map(|entry| disk[&entry.id].clone())
                .collect();
            Ok(comparison)
        })
        .unwrap()
}

/// A comparison in a canonical order.
fn sorted(mut comparison: Comparison) -> Comparison {
    comparison
        .paired
        .sort_unstable_by(|a, b| a.0.path.cmp(&b.0.path));
    comparison
        .deleted
        .sort_unstable_by(|a, b| a.path.cmp(&b.path));
    comparison.added.sort_unstable_by_key(|entry| entry.entry);
    comparison
}

/// The tagged entries the long way: a join per tag, and a lookup of each path `HEAD` has tags for.
fn naive_tags(catalog: &Catalog, head_tagged: &[RelPath]) -> TaggedEntries {
    catalog
        .read(|tx| {
            let mut entries: BTreeMap<EntryId, (PairedEntry, BTreeSet<TagId>)> = BTreeMap::new();
            let mut statement = tx.prepare(
                "SELECT e.id, e.path, e.kind, h.path, h.kind, t.tag_id
                 FROM entry_tags AS t JOIN entries AS e ON e.id = t.entry_id
                     LEFT JOIN head_files AS h ON h.entry_id = e.id",
            )?;
            let rows = statement.query_map([], |row| Ok((paired_entry_row(row)?, row.get(5)?)))?;
            for row in rows {
                let (entry, tag): (PairedEntry, TagId) = row?;
                entries
                    .entry(entry.entry)
                    .or_insert_with(|| (entry, BTreeSet::new()))
                    .1
                    .insert(tag);
            }
            let mut statement = tx.prepare(
                "SELECT e.id, e.path, e.kind, h.path, h.kind
                 FROM head_files AS h JOIN entries AS e ON e.id = h.entry_id WHERE h.path = ?1",
            )?;
            for path in head_tagged {
                if let Some(entry) = statement.query_row([path], paired_entry_row).optional()? {
                    entries
                        .entry(entry.entry)
                        .or_insert_with(|| (entry, BTreeSet::new()));
                }
            }
            Ok(entries.into_values().collect())
        })
        .unwrap()
}

/// The loader's comparison is the long way's, and so is the workspace it gives; so are the tagged
/// entries it reads with it, for every path of `HEAD` and for none.
fn check_comparison(f: &Fixture) {
    let read = sorted(f.catalog.read(|tx| comparison(tx)).unwrap());
    let naive = sorted(naive_comparison(&f.catalog));
    assert_eq!(read, naive);
    let rules = crate::meta::VersioningRules::default();
    assert_eq!(
        Workspace::new(read, &rules),
        Workspace::new(naive.clone(), &rules)
    );
    let paths: Vec<RelPath> = f
        .catalog
        .read(|tx| head_rows(tx))
        .unwrap()
        .into_iter()
        .map(|row| row.path)
        .collect();
    for head_tagged in [&paths[..], &[]] {
        let (read, tags) = f
            .catalog
            .read(|tx| comparison_and_tags(tx, head_tagged))
            .unwrap();
        assert_eq!(sorted(read), naive);
        assert_eq!(tags, naive_tags(&f.catalog, head_tagged));
    }
}

#[test]
fn the_tagged_entries_come_with_the_comparison() {
    let f = committed();
    let notes: BTreeSet<TagId> = [TagId::parse("notes").unwrap()].into();
    f.set_tags("s/c/a.md", EntryKind::File, notes.clone());
    f.fs.rename("s/c/b.pdf", "s/c/moved.pdf");
    f.fs.file("new.md", b"n");
    f.scan();
    f.set_tags("new.md", EntryKind::File, notes);
    f.scan();
    check_comparison(&f);
    let head_tagged = [path("s/c/b.pdf"), path("top.txt"), path("gone.md")];
    let (_, tags) = f
        .catalog
        .read(|tx| comparison_and_tags(tx, &head_tagged))
        .unwrap();
    assert_eq!(tags, naive_tags(&f.catalog, &head_tagged));
    let mut described: Vec<(&str, Option<&str>, Vec<&str>)> = tags
        .iter()
        .map(|(entry, tags)| {
            (
                entry.path.as_str(),
                entry.head.as_ref().map(RelPath::as_str),
                tags.iter().map(TagId::as_str).collect(),
            )
        })
        .collect();
    described.sort();
    assert_eq!(
        described,
        [
            ("new.md", None, vec!["notes"]),
            ("s/c/a.md", Some("s/c/a.md"), vec!["notes"]),
            ("s/c/moved.pdf", Some("s/c/b.pdf"), vec![]),
            ("top.txt", Some("top.txt"), vec![]),
        ]
    );
}

#[test]
fn the_comparison_reads_what_differs_and_what_frames_need() {
    let f = Fixture::new();
    for at in [
        "s/c/a.md",
        "s/c/b.pdf",
        "s/c/sub/deep.md",
        "s/d/x.md",
        "s/d/y.md",
        "gone/one.md",
        "gone/two/three.md",
        "keep/k.md",
        "z.txt",
    ] {
        f.fs.file(at, at.as_bytes());
    }
    f.commit_all(None);
    check_comparison(&f);
    assert_eq!(
        f.catalog.read(|tx| comparison(tx)).unwrap(),
        Comparison::default()
    );
    // Edits, a move, a nested folder move, a folder deleted with an escape and a folder in place
    // where it was, a kind change, a new empty folder, files not hashed yet or not local.
    f.fs.file("z.txt", b"edited, longer");
    f.fs.file("keep/k.md", b"same len!");
    f.fs.rename("s/c", "s/renamed");
    f.fs.rename("s/renamed/sub", "elsewhere");
    f.fs.rename("gone/one.md", "escaped.md");
    f.fs.remove("gone");
    f.fs.folder("gone/two");
    f.fs.rename("s/d/x.md", "s/d/x2.md");
    f.fs.remove("s/d/y.md");
    f.fs.folder("s/d/y.md");
    f.fs.folder("new/empty");
    f.fs.file("cloud.md", b"cloud");
    f.fs.set_presence("cloud.md", Presence::Placeholder);
    f.scan();
    check_comparison(&f);
    f.hash_all();
    check_comparison(&f);
    // A folder moved back below one that left: pinned rows.
    f.fs.rename("s/renamed", "s/c");
    f.fs.rename("s", "s2");
    f.fs.folder("s");
    f.fs.rename("s2/c", "s/c");
    f.scan();
    check_comparison(&f);
}

/// The paths random operations pick from, case variants included.
const POOL: &[&str] = &[
    "a.md",
    "A.md",
    "b.txt",
    "s",
    "S",
    "s/x.md",
    "s/c",
    "s/c/y.md",
    "s/c/sub",
    "s/c/sub/z.pdf",
    "s/d",
    "s/d/y.md",
    "t",
    "t/c",
    "t/c/y.md",
    "t/x.md",
];

#[derive(Debug, Clone)]
enum Op {
    Write(usize, u8),
    Replace(usize, u8),
    Folder(usize),
    Remove(usize),
    Rename(usize, usize),
    Cloud(usize),
    Scan,
    Hash,
}

fn op() -> impl Strategy<Value = Op> {
    let index = || 0..POOL.len();
    prop_oneof![
        2 => (index(), any::<u8>()).prop_map(|(at, byte)| Op::Write(at, byte)),
        1 => (index(), any::<u8>()).prop_map(|(at, byte)| Op::Replace(at, byte)),
        1 => index().prop_map(Op::Folder),
        2 => index().prop_map(Op::Remove),
        4 => (index(), index()).prop_map(|(from, to)| Op::Rename(from, to)),
        1 => index().prop_map(Op::Cloud),
        2 => Just(Op::Scan),
        1 => Just(Op::Hash),
    ]
}

/// Applies `op` to the disk when it can be done there: no folder in the way, no file above.
fn apply(f: &Fixture, op: &Op) {
    use crate::fs::FileKind;
    let fs = &f.fs;
    let creatable = |at: &str| {
        let mut prefixes: Vec<&str> = at.match_indices('/').map(|(end, _)| &at[..end]).collect();
        prefixes.push(at);
        prefixes
            .iter()
            .enumerate()
            .all(|(index, prefix)| match fs.kind_of(prefix) {
                Some(FileKind::Folder) => index + 1 < prefixes.len(),
                Some(_) => false,
                None => true,
            })
    };
    match *op {
        Op::Write(at, byte) => {
            let at = POOL[at];
            if fs.kind_of(at) == Some(FileKind::File) || creatable(at) {
                fs.file(at, &vec![byte; usize::from(byte % 4) + 1]);
            }
        }
        Op::Replace(at, byte) => {
            if fs.kind_of(POOL[at]) == Some(FileKind::File) {
                fs.replace(POOL[at], &[byte; 3]);
            }
        }
        Op::Folder(at) => {
            if creatable(POOL[at]) {
                fs.folder(POOL[at]);
            }
        }
        Op::Remove(at) => {
            if fs.kind_of(POOL[at]).is_some() {
                fs.remove(POOL[at]);
            }
        }
        Op::Rename(from, to) => {
            let (from, to) = (POOL[from], POOL[to]);
            let below = to
                .strip_prefix(from)
                .is_some_and(|rest| rest.starts_with('/'));
            if from != to && !below && fs.kind_of(from).is_some() && creatable(to) {
                fs.rename(from, to);
            }
        }
        Op::Cloud(at) => {
            if fs.kind_of(POOL[at]) == Some(FileKind::File) {
                fs.set_presence(POOL[at], Presence::Placeholder);
            }
        }
        Op::Scan => f.scan(),
        Op::Hash => {
            f.hash_all();
        }
    }
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(48))]

    /// After random changes since a commit, the loader reads what the long way reads.
    #[test]
    fn the_comparison_matches_the_long_way(
        seed in prop::collection::vec(0..POOL.len(), 1..6),
        ops in prop::collection::vec(op(), 1..24),
    ) {
        let f = Fixture::new();
        for at in seed {
            apply(&f, &Op::Write(at, 1));
        }
        f.commit_all(None);
        for op in &ops {
            apply(&f, op);
        }
        f.scan();
        check_comparison(&f);
        // What the loader tells from its read is what pairing finds.
        let found = pairable(&f);
        prop_assert_eq!(found, pair(&f) > 0);
        if found {
            check_comparison(&f);
            prop_assert!(!pairable(&f));
        }
    }
}
