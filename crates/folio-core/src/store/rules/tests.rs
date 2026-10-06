//! Tests of the rules that need trees: each rule on small trees, the checker against generate.mjs's
//! rules ported to whole flattened trees (`reference`) on random libraries with moves (`model`),
//! and walks far deeper than recursion could go.

mod model;
mod reference;

use std::cell::RefCell;
use std::collections::HashMap;

use proptest::prelude::*;
use proptest::sample::Index;

use self::model::Library;
use self::reference::Outcome;
use super::*;
use crate::store::{
    ChangeOp, Device, DeviceId, DeviceName, Message, Name, Pruned, Size, Summary, Timestamp,
};

const DIR: FlatEntry = FlatEntry::Dir;

fn id(byte: u8) -> ObjectId {
    ObjectId::from_bytes([byte; 32])
}

fn side(byte: u8) -> Side {
    Side {
        hash: id(byte),
        size: Size::new(u64::from(byte)).unwrap(),
        stored: true,
    }
}

fn file(byte: u8) -> FlatEntry {
    FlatEntry::File(side(byte))
}

fn name(text: &str) -> Name {
    Name::parse(text).unwrap()
}

fn path(text: &str) -> TreePath {
    TreePath::parse(text).unwrap()
}

fn flat(entries: &[(&str, FlatEntry)]) -> FlatTree {
    entries
        .iter()
        .map(|&(path, entry)| (path.to_owned(), entry))
        .collect()
}

/// A root with the smallest `.folio` (remote-format.md §7.4) and `entries`.
fn library(entries: &[(&str, FlatEntry)]) -> FlatTree {
    let mut tree = flat(&[(".folio", DIR), (".folio/library.json", file(0xf0))]);
    tree.extend(flat(entries));
    tree
}

fn build(trees: &mut MemoryTrees, tree: &FlatTree) -> ObjectId {
    model::build(trees, tree)
}

fn changes(records: Vec<Change>) -> Changes {
    Changes::new(records).unwrap()
}

fn device() -> Device {
    Device {
        id: DeviceId::parse("8c1e0d2b4a6f43e19d7c5b3a2f1e0d9c").unwrap(),
        name: DeviceName::parse("G16").unwrap(),
    }
}

fn time() -> Timestamp {
    Timestamp::parse("2026-10-05T21:00:00Z").unwrap()
}

/// A `commit` of `tree` on `parent`, with these change records.
fn commit(tree: ObjectId, parent: Option<&Commit>, records: Option<Vec<Change>>) -> Commit {
    Commit {
        tree,
        device: device(),
        time: time(),
        rebased_from: None,
        kind: CommitKind::Commit {
            parent: parent.map(id_of),
            message: Message {
                summary: Summary::parse("Edit").unwrap(),
                body: None,
                changes: records.map(changes),
            },
        },
    }
}

/// `commit` as an `import` (ADR-0003 §7): the same tree, parent and message.
fn as_import(commit: Commit) -> Commit {
    let CommitKind::Commit { parent, message } = commit.kind else {
        panic!("not a commit: {commit:?}");
    };
    Commit {
        kind: CommitKind::Import { parent, message },
        ..commit
    }
}

fn prune(tree: ObjectId, parent: &Commit, blobs: &[ObjectId]) -> Commit {
    Commit {
        tree,
        device: device(),
        time: time(),
        rebased_from: None,
        kind: CommitKind::Prune {
            parent: id_of(parent),
            pruned: Pruned::new(blobs.iter().copied()).unwrap(),
        },
    }
}

fn id_of(commit: &Commit) -> ObjectId {
    commit.encode().unwrap().id()
}

/// Checks `commit` on `parent` with a fresh checker over `trees`.
fn check(trees: &MemoryTrees, commit: &Commit, parent: Option<&Commit>) -> Result<(), StoreError> {
    HistoryChecker::new(trees).check_commit(id_of(commit), commit, parent)
}

/// The rule a check broke; panics on any other outcome.
fn broken(result: Result<(), StoreError>) -> RuleViolation {
    match result {
        Err(StoreError::Invalid {
            problem: Problem::Rule(rule),
            ..
        }) => rule,
        other => panic!("expected a broken rule, got {other:?}"),
    }
}

fn missing(result: Result<(), StoreError>) -> ObjectId {
    match result {
        Err(StoreError::Missing(id)) => id,
        other => panic!("expected a missing object, got {other:?}"),
    }
}

/// A source that counts the reads of each tree.
struct Counting<'a> {
    trees: &'a MemoryTrees,
    reads: RefCell<HashMap<ObjectId, usize>>,
}

impl<'a> Counting<'a> {
    fn new(trees: &'a MemoryTrees) -> Self {
        Self {
            trees,
            reads: RefCell::default(),
        }
    }

    fn reads(&self, id: ObjectId) -> usize {
        self.reads.borrow().get(&id).copied().unwrap_or_default()
    }

    fn total(&self) -> usize {
        self.reads.borrow().values().sum()
    }
}

impl TreeSource for Counting<'_> {
    fn tree(&self, id: ObjectId) -> Result<Option<Arc<Tree>>, StoreError> {
        *self.reads.borrow_mut().entry(id).or_default() += 1;
        self.trees.tree(id)
    }
}

#[test]
fn memory_trees_hold_trees_by_their_ids() {
    let mut trees = MemoryTrees::new();
    assert!(trees.is_empty());
    let tree = Tree::new(vec![TreeEntry::file(name("a.md"), side(1))]).unwrap();
    let held = trees.insert(tree.clone()).unwrap();
    assert_eq!(held, tree.encode().unwrap().id());
    assert_eq!(trees.len(), 1);
    assert!(trees.contains(held));
    assert_eq!(trees.tree(held).unwrap().as_deref(), Some(&tree));
    // A source by reference is a source too.
    fn read(source: impl TreeSource, id: ObjectId) -> Option<Arc<Tree>> {
        source.tree(id).unwrap()
    }
    assert_eq!(read(&trees, held).as_deref(), Some(&tree));
    // An absent tree is missing, not an error.
    assert_eq!(trees.tree(id(7)).unwrap(), None);
    assert!(trees.remove(held).is_some());
    assert_eq!(trees.tree(held).unwrap(), None);
}

#[test]
fn flattens_every_path_with_its_entry() {
    let expected = flat(&[
        ("a.md", file(1)),
        ("x", DIR),
        ("x/empty", DIR),
        ("x/y", DIR),
        ("x/y/b.md", file(2)),
        ("x/y/c.md", file(3)),
        ("z", file(4)),
    ]);
    let mut trees = MemoryTrees::new();
    let root = build(&mut trees, &expected);
    assert_eq!(
        flatten(&trees, root, DEFAULT_PATH_BUDGET).unwrap(),
        expected
    );
    // The empty tree has no paths. The walk holds it, its id and its frame, so a budget of 1, whose
    // 256 bytes hold less, is too small even for it.
    let empty = trees.insert(Tree::default()).unwrap();
    let holds = kept_size(&Tree::default()) + TREE_ID_BYTES + FRAME_BYTES;
    assert!(holds > PATH_BYTES_PER_ENTRY && holds <= 2 * PATH_BYTES_PER_ENTRY);
    assert!(flatten(&trees, empty, 2).unwrap().is_empty());
    assert!(matches!(
        flatten(&trees, empty, 1),
        Err(StoreError::TooLarge {
            limit: Limit::PathBytes(PATH_BYTES_PER_ENTRY),
            ..
        })
    ));
}

#[test]
fn a_tree_may_hold_one_folder_tree_at_two_paths() {
    let mut trees = MemoryTrees::new();
    let same = flat(&[("a", DIR), ("a/f", file(1)), ("b", DIR), ("b/f", file(1))]);
    let root = build(&mut trees, &same);
    assert_eq!(trees.len(), 2, "both folders are one tree");
    assert_eq!(flatten(&trees, root, DEFAULT_PATH_BUDGET).unwrap(), same);
}

#[test]
fn an_absent_tree_is_missing() {
    let mut trees = MemoryTrees::new();
    let tree = flat(&[("a", DIR), ("a/f", file(1)), ("b", DIR), ("b/g", file(2))]);
    let root = build(&mut trees, &tree);
    let [a, b] = ["a", "b"].map(|name| {
        let root = trees.tree(root).unwrap().unwrap();
        folder(root.get(name).unwrap()).unwrap()
    });
    trees.remove(b);
    assert_eq!(missing(flatten(&trees, root, 100).map(drop)), b);
    // The first absent in the walk's order, as generate.mjs reports it.
    trees.remove(a);
    assert_eq!(missing(flatten(&trees, root, 100).map(drop)), a);
    trees.remove(root);
    assert_eq!(missing(flatten(&trees, root, 100).map(drop)), root);
}

/// The path budget bounds the entries a walk looks at: a walk of short paths in folders that share
/// one tree, which keeps far less than its budget's bytes, stops at the count.
#[test]
fn the_path_budget_bounds_a_walk() {
    let mut trees = MemoryTrees::new();
    // 100 folders of one tree of 10 files: 1,100 entries, paths of at most 4 bytes.
    let files = (0..10)
        .map(|n| TreeEntry::file(name(&n.to_string()), side(1)))
        .collect();
    let files = trees.insert(Tree::new(files).unwrap()).unwrap();
    let folders = (0..100)
        .map(|n| TreeEntry::dir(name(&format!("{n:02}")), files))
        .collect();
    let root = trees.insert(Tree::new(folders).unwrap()).unwrap();
    assert_eq!(flatten(&trees, root, 1_100).unwrap().len(), 1_100);
    let error = flatten(&trees, root, 1_099).unwrap_err();
    assert!(
        matches!(
            error,
            StoreError::TooLarge {
                what: Subject::Object(what),
                limit: Limit::Paths(1_099),
            } if what == root
        ),
        "{error:?}"
    );
}

/// Folders of `levels` levels that each hold two folders `a` and `b` of the same tree, the last a
/// file `f`: 2^(levels + 1) - 1 paths in `levels + 1` trees.
fn doubling(trees: &mut MemoryTrees, levels: usize) -> ObjectId {
    let leaf = Tree::new(vec![TreeEntry::file(name("f"), side(1))]).unwrap();
    let mut top = trees.insert(leaf).unwrap();
    for _ in 0..levels {
        let tree = Tree::new(vec![
            TreeEntry::dir(name("a"), top),
            TreeEntry::dir(name("b"), top),
        ])
        .unwrap();
        top = trees.insert(tree).unwrap();
    }
    top
}

/// `root` with the smallest `.folio` added, as a root tree.
fn with_folio(trees: &mut MemoryTrees, entries: Vec<TreeEntry>) -> ObjectId {
    let folio = Tree::new(vec![TreeEntry::file(name("library.json"), side(0xf0))]).unwrap();
    let folio = trees.insert(folio).unwrap();
    let mut entries = entries;
    entries.push(TreeEntry::dir(name(".folio"), folio));
    trees.insert(Tree::new(entries).unwrap()).unwrap()
}

#[test]
fn repeated_folders_run_into_the_budget_not_out_of_memory() {
    const BUDGET: usize = 10_000;
    let mut trees = MemoryTrees::new();
    // 2^61 - 1 paths in 61 trees. Paths of about 120 bytes reach the budget's bytes before its
    // count.
    let doubled = doubling(&mut trees, 60);
    let bytes = BUDGET * PATH_BYTES_PER_ENTRY;
    let error = flatten(&trees, doubled, BUDGET).unwrap_err();
    assert!(
        matches!(error, StoreError::TooLarge { what: Subject::Object(what), limit: Limit::PathBytes(limit) } if what == doubled && limit == bytes),
        "{error:?}"
    );
    // Presence and path lengths look at each tree once: a first commit without change records
    // passes.
    let root = with_folio(&mut trees, vec![TreeEntry::dir(name("d"), doubled)]);
    let first = commit(root, None, None);
    let counting = Counting::new(&trees);
    let mut checker = HistoryChecker::with_budget(&counting, BUDGET);
    checker.check_commit(id_of(&first), &first, None).unwrap();
    assert_eq!(checker.longest_path(doubled).unwrap(), 2 * 60 + 1);
    // 61 trees, the root and `.folio` for presence; the root and `.folio` again for §7.4.
    assert_eq!(counting.total(), 61 + 2 + 2);
    // Change records need the paths: the walk stops at the budget.
    let records = vec![Change::AddDir { path: path("d") }];
    let with_records = commit(root, None, Some(records));
    let error = checker
        .check_commit(id_of(&with_records), &with_records, None)
        .unwrap_err();
    assert!(
        matches!(
            error,
            StoreError::TooLarge {
                limit: Limit::PathBytes(limit),
                ..
            } if limit == bytes
        ),
        "{error:?}"
    );
    // So do the records a reader would make without them.
    let error = diff_trees(&trees, None, root, 1_000).unwrap_err();
    assert!(
        matches!(
            error,
            StoreError::TooLarge {
                limit: Limit::PathBytes(limit),
                ..
            } if limit == 1_000 * PATH_BYTES_PER_ENTRY
        ),
        "{error:?}"
    );
}

/// A name of 255 UTF-16 code units, the longest a name may be, ending in `last`.
fn longest_name(last: char) -> Name {
    name(&format!("{}{last}", "n".repeat(254)))
}

/// Trees a hostile writer could send: `chain` folders one in another, then `doublings` levels
/// whose folders each hold one tree under two names, then the file `f`, every folder name 255
/// units long. A few hundred bytes a tree, and 2^(`doublings` + 1) paths at the bottom, each 256
/// units longer for every level. Returns the top tree.
fn long_named_doubling(trees: &mut MemoryTrees, chain: usize, doublings: usize) -> ObjectId {
    let leaf = Tree::new(vec![TreeEntry::file(name("f"), side(1))]).unwrap();
    let mut top = trees.insert(leaf).unwrap();
    for _ in 0..doublings {
        let tree = Tree::new(vec![
            TreeEntry::dir(longest_name('a'), top),
            TreeEntry::dir(longest_name('b'), top),
        ])
        .unwrap();
        top = trees.insert(tree).unwrap();
    }
    for _ in 0..chain {
        let tree = Tree::new(vec![TreeEntry::dir(longest_name('c'), top)]).unwrap();
        top = trees.insert(tree).unwrap();
    }
    top
}

#[test]
fn long_names_in_repeated_folders_run_into_the_bytes_of_the_budget() {
    const BUDGET: usize = 4_000;
    let bytes = BUDGET * PATH_BYTES_PER_ENTRY;
    let over = |error: StoreError, tree: ObjectId| {
        assert!(
            matches!(
                error,
                StoreError::TooLarge { what: Subject::Object(what), limit: Limit::PathBytes(limit) }
                    if what == tree && limit == bytes
            ),
            "{error:?}"
        );
    };
    let mut trees = MemoryTrees::new();
    // In a root folder: 127 levels, paths of up to 32,513 units (§7.4 allows them), about 196,000
    // paths of 6 GB in all, in 131 trees. The walks stop at 1,024,000 bytes of paths, within the
    // first hundred, far from 4,000 entries.
    let dag = long_named_doubling(&mut trees, 110, 16);
    let root = with_folio(&mut trees, vec![TreeEntry::dir(longest_name('r'), dag)]);
    let small = with_folio(&mut trees, Vec::new());
    // Under `.folio` one level less, for `.folio/`.
    let dag = long_named_doubling(&mut trees, 109, 16);
    let folio = Tree::new(vec![
        TreeEntry::file(name("library.json"), side(0xf0)),
        TreeEntry::dir(longest_name('x'), dag),
    ])
    .unwrap();
    let folio = trees.insert(folio).unwrap();
    let in_folio = trees
        .insert(Tree::new(vec![TreeEntry::dir(name(".folio"), folio)]).unwrap())
        .unwrap();
    let chain = long_named_doubling(&mut trees, 126, 0);

    let mut checker = HistoryChecker::with_budget(&trees, BUDGET);
    assert_eq!(checker.longest_path(root).unwrap(), 127 * 256 + 1);
    assert_eq!(checker.longest_path(in_folio).unwrap(), 7 + 126 * 256 + 1);
    over(flatten(&trees, root, BUDGET).unwrap_err(), root);
    over(diff_trees(&trees, None, root, BUDGET).unwrap_err(), root);
    // A first commit passes without change records, which need the paths.
    let first = commit(root, None, None);
    checker.check_commit(id_of(&first), &first, None).unwrap();
    let record = Change::AddDir {
        path: TreePath::parse(longest_name('r').as_str()).unwrap(),
    };
    let with_records = commit(root, None, Some(vec![record.clone()]));
    over(
        checker
            .check_commit(id_of(&with_records), &with_records, None)
            .unwrap_err(),
        root,
    );
    // A commit that adds the folder to a small library walks the new folder whole.
    let parent = commit(small, None, None);
    checker.check_commit(id_of(&parent), &parent, None).unwrap();
    let child = commit(root, Some(&parent), Some(vec![record]));
    over(
        checker
            .check_commit(id_of(&child), &child, Some(&parent))
            .unwrap_err(),
        root,
    );
    // §7.4's walk keeps every path under `.folio` before it checks them.
    let first = commit(in_folio, None, None);
    over(
        checker
            .check_commit(id_of(&first), &first, None)
            .unwrap_err(),
        in_folio,
    );
    // The default budget keeps a long chain without repeats: 127 paths, 2 MB.
    assert_eq!(
        flatten(&trees, chain, DEFAULT_PATH_BUDGET).unwrap().len(),
        127
    );
}

/// A root with a folder named `n` repeated `folder` times that holds a file named `f` repeated
/// `file` times, of `content`; and the folder's tree.
fn folder_with_file(
    trees: &mut MemoryTrees,
    (folder, file): (usize, usize),
    content: u8,
) -> (ObjectId, ObjectId) {
    let leaf = Tree::new(vec![TreeEntry::file(
        name(&"f".repeat(file)),
        side(content),
    )])
    .unwrap();
    let leaf = trees.insert(leaf).unwrap();
    let top = Tree::new(vec![TreeEntry::dir(name(&"n".repeat(folder)), leaf)]).unwrap();
    (trees.insert(top).unwrap(), leaf)
}

/// The first lengths of a folder name and a file name (100 bytes, then 1 to 254) whose `count` is
/// a whole number of a budget's entries, and the budget.
fn whole_count(count: impl Fn((usize, usize)) -> usize) -> ((usize, usize), usize) {
    (1..=254)
        .map(|file| (100, file))
        .find(|&lengths| count(lengths).is_multiple_of(PATH_BYTES_PER_ENTRY))
        .map(|lengths| (lengths, count(lengths) / PATH_BYTES_PER_ENTRY))
        .expect("lengths whose count is whole")
}

/// What a walk counts, to the byte. Down a folder to its file: the trees of the root and of the
/// folder on each side that has them, with their ids; two frames; the path at its longest, three
/// bytes for each of its bytes; and the paths reported, their bytes and a map entry for each side
/// that has them, as `flatten` keeps a path once and [`Differences`] once in `from` and once in
/// `to`. A walk whose count is exactly its budget's bytes passes, and one whose folder name is a
/// byte longer is too large.
#[test]
fn a_walk_counts_what_it_keeps_to_the_byte() {
    let mut trees = MemoryTrees::new();
    let tree_bytes = |trees: &MemoryTrees, ids: &[ObjectId]| -> usize {
        ids.iter()
            .map(|&id| kept_size(&trees.tree(id).unwrap().unwrap()) + TREE_ID_BYTES)
            .sum()
    };
    let over = |result: Result<(), StoreError>, tree: ObjectId, budget: usize| match result {
        Err(StoreError::TooLarge {
            what: Subject::Object(what),
            limit: Limit::PathBytes(limit),
        }) if what == tree && limit == budget * PATH_BYTES_PER_ENTRY => {}
        other => panic!("{other:?}"),
    };
    // One side: `flatten` keeps the folder and the file.
    let count = |(folder, file): (usize, usize)| {
        let mut trees = MemoryTrees::new();
        let (root, leaf) = folder_with_file(&mut trees, (folder, file), 1);
        let path = folder + 1 + file;
        let paths = (folder + MAP_ENTRY_BYTES) + (path + MAP_ENTRY_BYTES);
        tree_bytes(&trees, &[root, leaf]) + 2 * FRAME_BYTES + 3 * path + paths
    };
    let ((folder, file), budget) = whole_count(count);
    let (root, _) = folder_with_file(&mut trees, (folder, file), 1);
    assert_eq!(flatten(&trees, root, budget).unwrap().len(), 2);
    let (longer, _) = folder_with_file(&mut trees, (folder + 1, file), 1);
    over(flatten(&trees, longer, budget).map(drop), longer, budget);
    // Both sides: the folder is a folder on each, the same entry, and the file differs, kept twice.
    let count = |(folder, file): (usize, usize)| {
        let mut trees = MemoryTrees::new();
        let (old, old_leaf) = folder_with_file(&mut trees, (folder, file), 1);
        let (new, new_leaf) = folder_with_file(&mut trees, (folder, file), 2);
        let path = folder + 1 + file;
        let held = tree_bytes(&trees, &[old, new, old_leaf, new_leaf]);
        held + 2 * FRAME_BYTES + 3 * path + 2 * (path + MAP_ENTRY_BYTES)
    };
    let ((folder, file), budget) = whole_count(count);
    let (old, _) = folder_with_file(&mut trees, (folder, file), 1);
    let (new, _) = folder_with_file(&mut trees, (folder, file), 2);
    let differences = Differences::of_trees(&trees, Some(old), new, budget).unwrap();
    let path = format!("{}/{}", "n".repeat(folder), "f".repeat(file));
    assert_eq!(differences.from.keys().collect::<Vec<_>>(), [&path]);
    assert_eq!(differences.to.keys().collect::<Vec<_>>(), [&path]);
    let (old, _) = folder_with_file(&mut trees, (folder + 1, file), 1);
    let (new, _) = folder_with_file(&mut trees, (folder + 1, file), 2);
    over(
        Differences::of_trees(&trees, Some(old), new, budget).map(drop),
        new,
        budget,
    );
}

/// `diff_trees` counts its records beside the paths they are made from, to the byte, before it
/// makes them: each a [`Change`] and its path's bytes. Folders that repeat each other's trees list
/// 256 files from 18 trees, so the records, not the trees the walk holds, decide.
#[test]
fn diff_trees_counts_its_records_to_the_byte() {
    // Eight levels of folders `a` and `b` of one tree, over a file of a name 60 bytes long.
    let doubled = |trees: &mut MemoryTrees, content: u8| {
        let leaf = TreeEntry::file(name(&"f".repeat(60)), side(content));
        let mut top = trees.insert(Tree::new(vec![leaf]).unwrap()).unwrap();
        for _ in 0..8 {
            let entries = vec![
                TreeEntry::dir(name("a"), top),
                TreeEntry::dir(name("b"), top),
            ];
            top = trees.insert(Tree::new(entries).unwrap()).unwrap();
        }
        top
    };
    let mut trees = MemoryTrees::new();
    let (old, new) = (doubled(&mut trees, 1), doubled(&mut trees, 2));
    let records = diff_trees(&trees, Some(old), new, DEFAULT_PATH_BUDGET).unwrap();
    assert_eq!(records.len(), 256);
    let differences = Differences::of_trees(&trees, Some(old), new, DEFAULT_PATH_BUDGET).unwrap();
    let paths: usize = differences
        .from
        .keys()
        .chain(differences.to.keys())
        .map(|path| path.len() + MAP_ENTRY_BYTES)
        .sum();
    let made: usize = records
        .iter()
        .map(|record| size_of::<Change>() + record.path().as_str().len())
        .sum();
    // Each record and its two paths take a whole number of the budget's bytes for each path.
    assert!((paths + made).is_multiple_of(PATH_BYTES_PER_ENTRY));
    let budget = (paths + made) / PATH_BYTES_PER_ENTRY;
    assert_eq!(diff_trees(&trees, Some(old), new, budget).unwrap(), records);
    // A budget's entry less: the walk passes, the records do not fit.
    let less = budget - 1;
    assert!(Differences::of_trees(&trees, Some(old), new, less).is_ok());
    match diff_trees(&trees, Some(old), new, less) {
        Err(StoreError::TooLarge {
            what: Subject::Object(what),
            limit: Limit::PathBytes(limit),
        }) if what == new && limit == less * PATH_BYTES_PER_ENTRY => {}
        other => panic!("{other:?}"),
    }
}

/// What the check of presence holds, to the byte: the folders of the tree it is in, its stack of
/// steps at its tallest and its set of open trees at its largest. A tree whose folders all hold
/// complete trees adds one step; one of `pending` folders of a tree not checked yet adds a step for
/// each, and a second open tree. A check whose count is exactly its budget's bytes passes, and one
/// with a folder more is too large.
#[test]
fn the_check_of_presence_counts_what_it_holds_to_the_byte() {
    let mut trees = MemoryTrees::new();
    let complete = trees
        .insert(Tree::new(vec![TreeEntry::file(name("f"), side(1))]).unwrap())
        .unwrap();
    let fresh = trees
        .insert(Tree::new(vec![TreeEntry::file(name("g"), side(2))]).unwrap())
        .unwrap();
    // `done` folders of the complete tree and `pending` of the fresh one.
    let root = |trees: &mut MemoryTrees, done: usize, pending: usize| {
        let entries = (0..done + pending)
            .map(|n| {
                let tree = if n < done { complete } else { fresh };
                TreeEntry::dir(name(&format!("d{n:04}")), tree)
            })
            .collect();
        trees.insert(Tree::new(entries).unwrap()).unwrap()
    };
    for pending in [0, 3] {
        let open = if pending == 0 { 1 } else { 2 };
        let held = |done: usize| {
            FOLDER_BYTES * (done + pending) + STEP_BYTES * (pending + 1) + OPEN_BYTES * open
        };
        let (done, budget) = (1..1_000)
            .find(|&done| held(done).is_multiple_of(PATH_BYTES_PER_ENTRY))
            .map(|done| (done, held(done) / PATH_BYTES_PER_ENTRY))
            .expect("a count of folders whose bytes are whole");
        let fits = root(&mut trees, done, pending);
        let mut checker = HistoryChecker::with_budget(&trees, budget);
        assert_eq!(checker.longest_path(complete).unwrap(), 1);
        assert_eq!(checker.longest_path(fits).unwrap(), "d0000/f".len());
        let over = root(&mut trees, done + 1, pending);
        let mut checker = HistoryChecker::with_budget(&trees, budget);
        checker.longest_path(complete).unwrap();
        let too_large = |result: Result<usize, StoreError>, tree: ObjectId| match result {
            Err(StoreError::TooLarge {
                what: Subject::Object(what),
                limit: Limit::PathBytes(limit),
            }) if what == tree && limit == budget * PATH_BYTES_PER_ENTRY => {}
            other => panic!("{pending} pending: {other:?}"),
        };
        too_large(checker.longest_path(over), over);
        // The steps for the trees still to enter count before any of them is read: a tree whose
        // steps alone go beyond the bytes is too large, though the trees it names are missing.
        if pending > 0 {
            let gone = id(0xee);
            let entries = (0..done + 4 + pending)
                .map(|n| {
                    let tree = if n < done + 4 { complete } else { gone };
                    TreeEntry::dir(name(&format!("d{n:04}")), tree)
                })
                .collect();
            let names_gone = trees.insert(Tree::new(entries).unwrap()).unwrap();
            let mut checker = HistoryChecker::with_budget(&trees, budget);
            checker.longest_path(complete).unwrap();
            too_large(checker.longest_path(names_gone), names_gone);
        }
    }
}

/// A walk may keep exactly the bytes of its budget, and not one more.
#[test]
fn a_walk_keeps_up_to_exactly_the_bytes_of_its_budget() {
    let trees = MemoryTrees::new();
    let mut kept = Kept::new(&trees, 512, id(7));
    kept.add(500).unwrap();
    kept.add(12).unwrap();
    match kept.add(1) {
        Err(StoreError::TooLarge {
            what: Subject::Object(what),
            limit: Limit::PathBytes(512),
        }) if what == id(7) => {}
        other => panic!("{other:?}"),
    }
}

/// A chain of `depth` distinct trees, each holding the next as its first entry `0` and then `files`
/// files of `content`; the deepest holds the file `0`. A walk goes down the whole chain before it
/// looks at the files of any tree.
fn deep_chain(trees: &mut MemoryTrees, depth: usize, files: usize, content: u8) -> ObjectId {
    let leaf = Tree::new(vec![TreeEntry::file(name("0"), side(content))]).unwrap();
    let mut below = trees.insert(leaf).unwrap();
    for _ in 1..depth {
        let mut entries: Vec<TreeEntry> = (0..files)
            .map(|n| TreeEntry::file(name(&format!("f{n:04}")), side(content)))
            .collect();
        entries.push(TreeEntry::dir(name("0"), below));
        below = trees.insert(Tree::new(entries).unwrap()).unwrap();
    }
    below
}

/// The trees of the folders a walk is in count against the bytes of its budget while it is in
/// them: going down a chain of distinct trees, each entered through its first entry, the walk looks
/// at one entry a tree, and stops at the tree that takes it beyond the bytes, never at the bottom.
/// A library folder that comes from elsewhere can hold such trees: up to 64 MiB each, from a few
/// hundred kilobytes of pack.
#[test]
fn the_trees_of_the_folders_a_walk_is_in_count_against_the_bytes_of_its_budget() {
    const BUDGET: usize = 2_000;
    const DEPTH: usize = 40;
    let bytes = BUDGET * PATH_BYTES_PER_ENTRY;
    let mut trees = MemoryTrees::new();
    let old = deep_chain(&mut trees, DEPTH, 500, 1);
    let new = deep_chain(&mut trees, DEPTH, 500, 2);
    let level = kept_size(&trees.tree(new).unwrap().unwrap());
    assert!(level * DEPTH > 2 * bytes, "{level} bytes a tree");
    let over = |result: Result<(), StoreError>, tree: ObjectId| match result {
        Err(StoreError::TooLarge {
            what: Subject::Object(what),
            limit: Limit::PathBytes(limit),
        }) if what == tree && limit == bytes => {}
        other => panic!("{other:?}"),
    };
    let counting = Counting::new(&trees);
    over(flatten(&counting, new, BUDGET).map(drop), new);
    assert!(
        counting.total() <= bytes / level + 1,
        "{} reads",
        counting.total()
    );
    // Down both chains, two trees a level.
    let counting = Counting::new(&trees);
    over(
        Differences::of_trees(&counting, Some(old), new, BUDGET).map(drop),
        new,
    );
    assert!(
        counting.total() <= bytes / level + 2,
        "{} reads",
        counting.total()
    );
    over(diff_trees(&trees, Some(old), new, BUDGET).map(drop), new);
    // A first commit whose change records need the chain's paths.
    let root = with_folio(&mut trees, vec![TreeEntry::dir(name("c"), new)]);
    let first = commit(root, None, Some(vec![Change::AddDir { path: path("c") }]));
    over(
        HistoryChecker::with_budget(&trees, BUDGET).check_commit(id_of(&first), &first, None),
        root,
    );
    // The default budget walks every path.
    assert_eq!(
        flatten(&trees, new, DEFAULT_PATH_BUDGET).unwrap().len(),
        (DEPTH - 1) * 501 + 1
    );
}

/// A walk counts a folder's trees only while it is in the folder: the folders of a wide tree, each
/// a distinct tree, are walked one after another within bytes that could not hold all their trees
/// beside the paths in their map.
#[test]
fn a_walk_counts_the_trees_of_a_folder_only_while_it_is_in_it() {
    let mut trees = MemoryTrees::new();
    let long = "n".repeat(17);
    let folders: Vec<ObjectId> = (0..20_u8)
        .map(|n| {
            let entries = (0..100)
                .map(|i| TreeEntry::file(name(&format!("{long}{i:03}")), side(n)))
                .collect();
            trees.insert(Tree::new(entries).unwrap()).unwrap()
        })
        .collect();
    let entries = folders
        .iter()
        .enumerate()
        .map(|(n, &folder)| TreeEntry::dir(name(&format!("d{n:02}")), folder))
        .collect();
    let root = trees.insert(Tree::new(entries).unwrap()).unwrap();
    let budget = 20 + 20 * 100;
    let flat = flatten(&trees, root, budget).unwrap();
    assert_eq!(flat.len(), budget);
    let paths: usize = flat.keys().map(|path| path.len() + MAP_ENTRY_BYTES).sum();
    let all: usize = folders
        .iter()
        .map(|&folder| kept_size(&trees.tree(folder).unwrap().unwrap()))
        .sum();
    assert!(
        paths + all > budget * PATH_BYTES_PER_ENTRY,
        "{paths} bytes of paths and {all} of trees"
    );
}

/// A chain of `depth` distinct trees that each hold `width` folders of one small tree and, last in
/// name order, the next tree of the chain, which the check of presence enters first: the folders of
/// every tree above it wait while it goes down.
fn wide_chain(trees: &mut MemoryTrees, depth: usize, width: usize) -> ObjectId {
    let small = Tree::new(vec![TreeEntry::file(name("f"), side(1))]).unwrap();
    let small = trees.insert(small).unwrap();
    let mut below = small;
    for level in 0..depth {
        let mut entries: Vec<TreeEntry> = (0..width)
            .map(|n| TreeEntry::dir(name(&format!("d{n:05}")), small))
            .collect();
        entries.push(TreeEntry::dir(name(&format!("z{level:05}")), below));
        below = trees.insert(Tree::new(entries).unwrap()).unwrap();
    }
    below
}

/// The check of presence and path lengths holds the folders of the trees it is in, and the trees it
/// has still to enter, within the bytes of the budget: down a chain of trees of many folders it
/// stops after a few trees, while such trees side by side it enters one after another.
#[test]
fn the_check_of_presence_holds_its_folders_within_the_bytes_of_its_budget() {
    const BUDGET: usize = 4_000;
    const DEPTH: usize = 50;
    let mut trees = MemoryTrees::new();
    let top = wide_chain(&mut trees, DEPTH, 1_000);
    let over = |result: Result<usize, StoreError>, tree: ObjectId| match result {
        Err(StoreError::TooLarge {
            what: Subject::Object(what),
            limit: Limit::PathBytes(limit),
        }) if what == tree && limit == BUDGET * PATH_BYTES_PER_ENTRY => {}
        other => panic!("{other:?}"),
    };
    let counting = Counting::new(&trees);
    over(
        HistoryChecker::with_budget(&counting, BUDGET).longest_path(top),
        top,
    );
    assert!(counting.total() < DEPTH / 2, "{} reads", counting.total());
    // So does the check of a commit, which starts with it.
    let root = with_folio(&mut trees, vec![TreeEntry::dir(name("w"), top)]);
    let first = commit(root, None, None);
    over(
        HistoryChecker::with_budget(&trees, BUDGET)
            .check_commit(id_of(&first), &first, None)
            .map(|()| 0),
        root,
    );
    // The default budget holds them: each tree read once, the longest path through the chain.
    let counting = Counting::new(&trees);
    let longest = HistoryChecker::new(&counting).longest_path(top).unwrap();
    assert_eq!(longest, DEPTH * "z00000/".len() + 1);
    assert_eq!(counting.total(), DEPTH + 1);
    // Side by side rather than one in another: 40 distinct trees of 1,000 folders each, of a tree
    // of their own, are entered one after another within bytes that could not hold them all.
    let wide: Vec<TreeEntry> = (0..40_u8)
        .map(|n| {
            let leaf = Tree::new(vec![TreeEntry::file(name("f"), side(n))]).unwrap();
            let leaf = trees.insert(leaf).unwrap();
            let folders = (0..1_000)
                .map(|m| TreeEntry::dir(name(&format!("d{m:04}")), leaf))
                .collect();
            let tree = trees.insert(Tree::new(folders).unwrap()).unwrap();
            TreeEntry::dir(name(&format!("w{n:02}")), tree)
        })
        .collect();
    let side_by_side = trees.insert(Tree::new(wide).unwrap()).unwrap();
    let mut checker = HistoryChecker::with_budget(&trees, BUDGET);
    assert_eq!(
        checker.longest_path(side_by_side).unwrap(),
        "w00/d0000/f".len()
    );
}

/// A tree of 300 folders named `{prefix}000`… that all hold the tree `below`.
fn folders_of(trees: &mut MemoryTrees, prefix: &str, below: ObjectId) -> ObjectId {
    let entries = (0..300)
        .map(|n| TreeEntry::dir(name(&format!("{prefix}{n:03}")), below))
        .collect();
    trees.insert(Tree::new(entries).unwrap()).unwrap()
}

/// Folders that repeat each other's trees cost a walk two reads of each distinct tree at most, the
/// second of which it keeps, however many folders name it: reading a tree from the store costs a
/// pack record each time.
#[test]
fn a_walk_reads_a_tree_it_meets_again_once_more_and_no_more() {
    fn reads(counting: &Counting, ids: &[ObjectId]) -> Vec<usize> {
        ids.iter().map(|&id| counting.reads(id)).collect()
    }
    let mut trees = MemoryTrees::new();
    let empty = trees.insert(Tree::default()).unwrap();
    // 90,300 paths in three trees.
    let shared = folders_of(&mut trees, "e", empty);
    let top = folders_of(&mut trees, "s", shared);
    // The same trees under `.folio/meta`, which §7.4 does not allow (`meta` holds folders of files
    // only), and beside `.folio`.
    let library = TreeEntry::file(name("library.json"), side(0xf0));
    let folio = Tree::new(vec![library.clone(), TreeEntry::dir(name("meta"), top)]).unwrap();
    let folio = trees.insert(folio).unwrap();
    let in_folio = trees
        .insert(Tree::new(vec![TreeEntry::dir(name(".folio"), folio)]).unwrap())
        .unwrap();
    let small_folio = trees.insert(Tree::new(vec![library]).unwrap()).unwrap();
    let beside = with_folio(&mut trees, vec![TreeEntry::dir(name("big"), top)]);

    let counting = Counting::new(&trees);
    assert_eq!(
        flatten(&counting, top, DEFAULT_PATH_BUDGET).unwrap().len(),
        300 + 300 * 300
    );
    assert_eq!(reads(&counting, &[top, shared, empty]), [1, 2, 2]);
    let walked = Differences::of_trees(&counting, None, top, DEFAULT_PATH_BUDGET).unwrap();
    assert_eq!(walked.to.len(), 300 + 300 * 300);
    assert_eq!(reads(&counting, &[top, shared, empty]), [2, 4, 4]);

    // The first commit with the trees in `.folio/meta` is refused after a read or two of each.
    let counting = Counting::new(&trees);
    let first = commit(in_folio, None, None);
    let error = HistoryChecker::new(&counting)
        .check_commit(id_of(&first), &first, None)
        .unwrap_err();
    assert!(
        matches!(&error, StoreError::Invalid { problem: Problem::Rule(RuleViolation::FolioPath { path }), .. } if path == ".folio/meta/s000/e000"),
        "{error:?}"
    );
    // Presence reads each tree once; §7.4 the root again, then `.folio` and what it holds.
    assert_eq!(
        reads(&counting, &[in_folio, folio, top, shared, empty]),
        [2, 2, 2, 3, 3]
    );

    // Beside `.folio`, in a first commit with change records, which need every path.
    let counting = Counting::new(&trees);
    let records = vec![Change::AddDir { path: path("big") }];
    let first = commit(beside, None, Some(records));
    let rule = broken(HistoryChecker::new(&counting).check_commit(id_of(&first), &first, None));
    assert!(matches!(rule, RuleViolation::NotCovered { .. }), "{rule:?}");
    // Presence once; §7.4 the root and `.folio` again; the change walk the root and `.folio`
    // once more, and the repeated trees twice.
    assert_eq!(
        reads(&counting, &[beside, small_folio, top, shared, empty]),
        [3, 3, 2, 3, 3]
    );
}

/// The trees a walk keeps count against the bytes of its budget for the rest of the walk, as the
/// paths do: a walk that meets trees of long names a second time keeps each, though it lists few
/// paths, while the trees of a folder it has left no longer count.
#[test]
fn trees_a_walk_keeps_count_against_the_bytes_of_its_budget() {
    let mut trees = MemoryTrees::new();
    // Names of 255 units, three bytes each but for the last three.
    let long = "课".repeat(252);
    // Three pairs of trees of 40 such files, the last one changed in the second of each pair.
    let mut tree_of = |pair: u8, last: u8| {
        let entries = (0..40_u8)
            .map(|n| {
                let content = if n == 39 { last } else { pair };
                TreeEntry::file(name(&format!("{long}{n:03}")), side(content))
            })
            .collect();
        trees.insert(Tree::new(entries).unwrap()).unwrap()
    };
    let pairs: Vec<(ObjectId, ObjectId)> = (0..3_u8)
        .map(|pair| (tree_of(pair, 200 + pair), tree_of(pair, 210 + pair)))
        .collect();
    // Each tree of a pair under the folders `aN` and `bN`: a walk reads it at `aN` and leaves it,
    // then keeps it from `bN` on.
    let root_of = |trees: &mut MemoryTrees, pick: fn(&(ObjectId, ObjectId)) -> ObjectId| {
        let entries = pairs
            .iter()
            .enumerate()
            .flat_map(|(n, pair)| {
                [
                    TreeEntry::dir(name(&format!("a{n}")), pick(pair)),
                    TreeEntry::dir(name(&format!("b{n}")), pick(pair)),
                ]
            })
            .collect();
        trees.insert(Tree::new(entries).unwrap()).unwrap()
    };
    let parent = root_of(&mut trees, |pair| pair.0);
    let tree = root_of(&mut trees, |pair| pair.1);
    let size = kept_size(&trees.tree(pairs[0].0).unwrap().unwrap());
    // Bytes for a folder's two trees and every path, with room to spare, but not for the four trees
    // the walk keeps once it is at `b1`; 246 entries looked at.
    let budget = (4 * size).div_ceil(PATH_BYTES_PER_ENTRY);
    assert!(budget > 6 + 6 * 40, "{budget}");
    match Differences::of_trees(&trees, Some(parent), tree, budget) {
        Err(StoreError::TooLarge {
            what: Subject::Object(what),
            limit: Limit::PathBytes(limit),
        }) if what == tree && limit == budget * PATH_BYTES_PER_ENTRY => {}
        other => panic!("{other:?}"),
    }
    // Bytes for all six trees take the walk to its end.
    let enough = (7 * size).div_ceil(PATH_BYTES_PER_ENTRY);
    let differences = Differences::of_trees(&trees, Some(parent), tree, enough).unwrap();
    let paths: Vec<String> = ["a0", "a1", "a2", "b0", "b1", "b2"]
        .iter()
        .map(|folder| format!("{folder}/{long}039"))
        .collect();
    assert_eq!(
        differences.from.keys().collect::<Vec<_>>(),
        paths.iter().collect::<Vec<_>>()
    );
    assert_eq!(
        differences.to.keys().collect::<Vec<_>>(),
        paths.iter().collect::<Vec<_>>()
    );
}

#[test]
fn differences_walk_only_what_changed() {
    // A large folder that no commit touches, and a small one that changes.
    let mut big: Vec<(String, FlatEntry)> = vec![("big".to_owned(), DIR)];
    for i in 0..200_u8 {
        big.push((format!("big/f{i}"), file(i)));
    }
    let big: Vec<(&str, FlatEntry)> = big.iter().map(|(p, e)| (p.as_str(), *e)).collect();
    let mut before = library(&big);
    before.extend(flat(&[
        ("small", DIR),
        ("small/a", file(1)),
        ("small/b", file(2)),
    ]));
    let mut after = before.clone();
    after.insert("small/a".into(), file(3));
    after.remove("small/b");
    after.insert("small/c".into(), DIR);
    let mut trees = MemoryTrees::new();
    let (parent, tree) = (build(&mut trees, &before), build(&mut trees, &after));
    let counting = Counting::new(&trees);
    let walked = Differences::of_trees(&counting, Some(parent), tree, DEFAULT_PATH_BUDGET).unwrap();
    // Only the two roots, the two `small` folders and the new folder in one are read; `big` is
    // skipped by its equal tree id.
    assert_eq!(counting.total(), 5);
    let big_id = folder(trees.tree(tree).unwrap().unwrap().get("big").unwrap()).unwrap();
    assert_eq!(counting.reads(big_id), 0);
    assert_eq!(
        walked,
        Differences {
            from: flat(&[("small/a", file(1)), ("small/b", file(2))]),
            to: flat(&[("small/a", file(3)), ("small/c", DIR)]),
        }
    );
    assert_eq!(walked, Differences::between(&before, &after));
    // Equal trees have none; a first commit's are all its paths.
    assert!(
        Differences::of_trees(&trees, Some(tree), tree, 0)
            .unwrap()
            .is_empty()
    );
    let first = Differences::of_trees(&trees, None, tree, DEFAULT_PATH_BUDGET).unwrap();
    assert!(first.from.is_empty());
    assert_eq!(first.to, after);
}

#[test]
fn a_file_that_becomes_a_folder_differs_on_both_sides() {
    let before = flat(&[("n", file(1)), ("m", DIR), ("m/x", file(2))]);
    let after = flat(&[("n", DIR), ("n/x", file(1)), ("m", file(3))]);
    let mut trees = MemoryTrees::new();
    let (parent, tree) = (build(&mut trees, &before), build(&mut trees, &after));
    let walked = Differences::of_trees(&trees, Some(parent), tree, DEFAULT_PATH_BUDGET).unwrap();
    assert_eq!(
        walked,
        Differences {
            from: flat(&[("m", DIR), ("m/x", file(2)), ("n", file(1))]),
            to: flat(&[("m", file(3)), ("n", DIR), ("n/x", file(1))]),
        }
    );
    assert_eq!(walked, Differences::between(&before, &after));
    assert_eq!(
        walked.records().unwrap(),
        [
            Change::DeleteDir { path: path("m") },
            Change::AddFile {
                path: path("m"),
                new: side(3)
            },
            Change::DeleteFile {
                path: path("m/x"),
                old: side(2)
            },
            Change::DeleteFile {
                path: path("n"),
                old: side(1)
            },
            Change::AddDir { path: path("n") },
            Change::AddFile {
                path: path("n/x"),
                new: side(1)
            },
        ]
    );
}

#[test]
fn diff_trees_records_no_moves() {
    let before = flat(&[("a", file(1)), ("b", DIR), ("b/c", file(2)), ("r", file(4))]);
    let mut stored_only = side(4);
    stored_only.stored = false;
    let after = flat(&[
        ("a", file(5)),
        ("d", DIR),
        ("d/c", file(2)),
        ("r", FlatEntry::File(stored_only)),
    ]);
    let mut trees = MemoryTrees::new();
    let (parent, tree) = (build(&mut trees, &before), build(&mut trees, &after));
    let records = diff_trees(&trees, Some(parent), tree, DEFAULT_PATH_BUDGET).unwrap();
    assert_eq!(
        records,
        [
            Change::ModifyFile {
                path: path("a"),
                old: side(1),
                new: side(5)
            },
            Change::DeleteDir { path: path("b") },
            Change::DeleteFile {
                path: path("b/c"),
                old: side(2)
            },
            Change::AddDir { path: path("d") },
            Change::AddFile {
                path: path("d/c"),
                new: side(2)
            },
            Change::ModifyFile {
                path: path("r"),
                old: side(4),
                new: stored_only
            },
        ]
    );
    // They are in the order of rule 5 already, and they cover the differences.
    let records = changes(records);
    Differences::between(&before, &after)
        .check(&records)
        .unwrap();
    assert!(diff_trees(&trees, Some(tree), tree, 0).unwrap().is_empty());
}

/// A chain of `depth` folders named `folder_name` under a root with the smallest `.folio`; the
/// deepest holds the file `f` of `content`.
fn chain(trees: &mut MemoryTrees, depth: usize, folder_name: &str, content: u8) -> ObjectId {
    chain_to(trees, depth, folder_name, "f", content)
}

/// [`chain`] with the file named `file_name`.
fn chain_to(
    trees: &mut MemoryTrees,
    depth: usize,
    folder_name: &str,
    file_name: &str,
    content: u8,
) -> ObjectId {
    let mut tree = Tree::new(vec![TreeEntry::file(name(file_name), side(content))]).unwrap();
    for _ in 1..depth {
        let below = trees.insert(tree).unwrap();
        tree = Tree::new(vec![TreeEntry::dir(name(folder_name), below)]).unwrap();
    }
    let top = trees.insert(tree).unwrap();
    with_folio(trees, vec![TreeEntry::dir(name(folder_name), top)])
}

#[test]
fn a_path_too_long_makes_its_tree_invalid() {
    let long = "a".repeat(200);
    let mut trees = MemoryTrees::new();
    // 164 folders of 200 units and the file: 164 × 201 + 1 = 32,965 units.
    let too_deep = chain(&mut trees, 164, &long, 1);
    let at_limit = chain(&mut trees, 163, &long, 1);
    let mut checker = HistoryChecker::new(&trees);
    assert_eq!(checker.longest_path(too_deep).unwrap(), 32_965);
    assert_eq!(checker.longest_path(at_limit).unwrap(), 32_764);
    let rule = broken(check(&trees, &commit(too_deep, None, None), None));
    assert_eq!(rule, RuleViolation::PathTooLong { units: 32_965 });
    check(&trees, &commit(at_limit, None, None), None).unwrap();
    // A path of exactly 32,767 units, the longest §6.5 allows (163 folders and a file of four
    // units), and one a unit longer.
    let longest = chain_to(&mut trees, 163, &long, "ffff", 1);
    let one_more = chain_to(&mut trees, 163, &long, "fffff", 1);
    let mut checker = HistoryChecker::new(&trees);
    assert_eq!(checker.longest_path(longest).unwrap(), MAX_PATH_UNITS);
    assert_eq!(checker.longest_path(one_more).unwrap(), MAX_PATH_UNITS + 1);
    check(&trees, &commit(longest, None, None), None).unwrap();
    let rule = broken(check(&trees, &commit(one_more, None, None), None));
    let too_long = RuleViolation::PathTooLong {
        units: MAX_PATH_UNITS + 1,
    };
    assert_eq!(rule, too_long);
    let flat = |root| flatten(&trees, root, DEFAULT_PATH_BUDGET).unwrap();
    assert_eq!(check_root(&flat(longest)), Ok(()));
    assert_eq!(check_root(&flat(one_more)), Err(too_long));
    let records = diff_trees(&trees, None, longest, DEFAULT_PATH_BUDGET).unwrap();
    check(&trees, &commit(longest, None, Some(records)), None).unwrap();
    // A reader's records cannot name such a path; the error names the tree that holds it.
    let error = diff_trees(&trees, None, too_deep, DEFAULT_PATH_BUDGET).unwrap_err();
    assert!(
        matches!(
            error,
            StoreError::Invalid { what: Subject::Object(what), problem: Problem::Value(ValueError::PathTooLong) }
                if what == too_deep
        ),
        "{error:?}"
    );
    let error = diff_trees(&trees, Some(too_deep), at_limit, DEFAULT_PATH_BUDGET).unwrap_err();
    assert!(
        matches!(error, StoreError::Invalid { what: Subject::Object(what), .. } if what == too_deep),
        "{error:?}"
    );
}

#[test]
fn a_10000_folder_chain_is_walked_without_recursion() {
    const DEPTH: usize = 10_000;
    let mut trees = MemoryTrees::new();
    let first = chain(&mut trees, DEPTH, "a", 1);
    let second = chain(&mut trees, DEPTH, "a", 2);
    let deepest = path(&format!("{}f", "a/".repeat(DEPTH)));
    let c1 = commit(first, None, None);
    let edit = Change::ModifyFile {
        path: deepest,
        old: side(1),
        new: side(2),
    };
    let c2 = commit(second, Some(&c1), Some(vec![edit.clone()]));
    let (c1_id, c2_id) = (id_of(&c1), id_of(&c2));
    // A stack this small overflows long before 10,000 nested calls of any walk.
    let walks = std::thread::Builder::new()
        .stack_size(256 * 1024)
        .spawn(move || {
            let counting = Counting::new(&trees);
            let mut checker = HistoryChecker::new(&counting);
            assert_eq!(checker.longest_path(first).unwrap(), 2 * DEPTH + 1);
            checker.check_commit(c1_id, &c1, None).unwrap();
            checker.check_commit(c2_id, &c2, Some(&c1)).unwrap();
            // Presence read each tree of both chains once (the chains share no folder), §7.4
            // the roots and `.folio`, and the walk of the change records both chains again.
            let chain_trees = DEPTH + 1;
            let expected = (2 * chain_trees + 1) + 2 * 2 + 2 * chain_trees;
            assert_eq!(counting.total(), expected);
            let records = diff_trees(&trees, Some(first), second, DEFAULT_PATH_BUDGET).unwrap();
            assert_eq!(records, [edit]);
            // Without the second chain, the second commit is missing a tree 10,000 folders down.
            let mut some = trees.clone();
            let mut below = second;
            for _ in 0..DEPTH {
                let tree = some.tree(below).unwrap().unwrap();
                below = folder(tree.get("a").unwrap()).unwrap();
            }
            some.remove(below);
            let mut checker = HistoryChecker::new(&some);
            checker.check_commit(c1_id, &c1, None).unwrap();
            let error = checker.check_commit(c2_id, &c2, Some(&c1)).unwrap_err();
            assert!(
                matches!(error, StoreError::Missing(id) if id == below),
                "{error:?}"
            );
        })
        .unwrap();
    walks.join().unwrap();
}

#[test]
fn a_tree_that_holds_itself_ends_the_walk() {
    /// Gives the same tree for every id: a source that breaks its contract.
    struct Lying(Arc<Tree>);
    impl TreeSource for Lying {
        fn tree(&self, _: ObjectId) -> Result<Option<Arc<Tree>>, StoreError> {
            Ok(Some(Arc::clone(&self.0)))
        }
    }
    let lying = Lying(Arc::new(
        Tree::new(vec![TreeEntry::dir(name("a"), id(1))]).unwrap(),
    ));
    let error = HistoryChecker::new(&lying).longest_path(id(9)).unwrap_err();
    assert!(
        matches!(
            error,
            StoreError::Invalid { problem: Problem::Rule(RuleViolation::TreeCycle { tree }), .. }
                if tree == id(1)
        ),
        "{error:?}"
    );
    // Walks that list paths end at their budget.
    let error = flatten(&lying, id(9), 1_000).unwrap_err();
    assert!(matches!(error, StoreError::TooLarge { .. }), "{error:?}");
}

#[test]
fn the_root_follows_section_7_4() {
    let meta = file(0xf0);
    let mut not_stored = side(0xf1);
    not_stored.stored = false;
    let valid: &[&[(&str, FlatEntry)]] = &[
        &[],
        &[
            (".folio/tags.json", meta),
            (".folio/ignore", meta),
            (".folio/meta", DIR),
            (".folio/meta/_root.json", meta),
            (".folio/meta/2026 秋", DIR),
            (".folio/meta/2026 秋/_group.json", meta),
        ],
        &[(".folio/views.json", meta)],
        // Files may sit anywhere the layout reaches, `meta` included.
        &[(".folio/meta", meta)],
        &[
            (".folio/meta", DIR),
            (".folio/meta/s", DIR),
            (".folio/meta/s/notes.txt", meta),
        ],
        // Names close to the protected ones are fine.
        &[
            (".folio/locals", meta),
            (".folio/storeroom.json", meta),
            (".folios", DIR),
        ],
        // Files outside `.folio` need not be stored.
        &[("a.pdf", FlatEntry::File(not_stored))],
    ];
    for entries in valid {
        let tree = library(entries);
        assert_eq!(check_root(&tree), Ok(()), "{tree:?}");
        assert_eq!(reference::root_problem(&tree), None, "{tree:?}");
    }
    let invalid: &[(&[(&str, FlatEntry)], RuleViolation)] = &[
        (
            &[(".FOLIO", DIR)],
            RuleViolation::FolioName {
                name: ".FOLIO".into(),
            },
        ),
        (
            &[(".folıo", meta)],
            RuleViolation::FolioName {
                name: ".folıo".into(),
            },
        ),
        (
            &[(".folio/cache", DIR)],
            RuleViolation::FolioPath {
                path: ".folio/cache".into(),
            },
        ),
        (
            &[(".folio/META", DIR)],
            RuleViolation::FolioPath {
                path: ".folio/META".into(),
            },
        ),
        (
            &[
                (".folio/meta", DIR),
                (".folio/meta/s", DIR),
                (".folio/meta/s/c", DIR),
            ],
            RuleViolation::FolioPath {
                path: ".folio/meta/s/c".into(),
            },
        ),
        (
            &[(".folio/local", meta)],
            RuleViolation::FolioPrivate {
                name: "local".into(),
            },
        ),
        (
            &[(".folio/Store", DIR)],
            RuleViolation::FolioPrivate {
                name: "Store".into(),
            },
        ),
        (
            &[(".folio/ſtore", DIR)],
            RuleViolation::FolioPrivate {
                name: "ſtore".into(),
            },
        ),
        (
            &[(".folio/tags.json", FlatEntry::File(not_stored))],
            RuleViolation::FolioNotStored {
                path: ".folio/tags.json".into(),
            },
        ),
    ];
    for (entries, rule) in invalid {
        let tree = library(entries);
        assert_eq!(check_root(&tree).as_ref(), Err(rule), "{tree:?}");
        assert!(reference::root_problem(&tree).is_some(), "{tree:?}");
    }
    for tree in [
        flat(&[]),
        flat(&[(".folio", DIR)]),
        flat(&[(".folio", meta)]),
        flat(&[(".folio", DIR), (".folio/library.json", DIR)]),
    ] {
        assert_eq!(
            check_root(&tree),
            Err(RuleViolation::FolioMissing),
            "{tree:?}"
        );
    }
    // Path lengths count UTF-16 code units: an emoji is two.
    let at_limit = format!("{}{}", "😀".repeat(16_383), "a");
    let tree = library(&[(at_limit.as_str(), meta)]);
    assert_eq!(check_root(&tree), Ok(()));
    let too_long = format!("{at_limit}b");
    let tree = library(&[(too_long.as_str(), meta)]);
    assert_eq!(
        check_root(&tree),
        Err(RuleViolation::PathTooLong { units: 32_768 })
    );
}

#[test]
fn a_first_commit_is_checked_against_its_tree() {
    let tree = library(&[("a.md", file(1)), ("x", DIR), ("x/b.md", file(2))]);
    let mut trees = MemoryTrees::new();
    let root = build(&mut trees, &tree);
    check(&trees, &commit(root, None, None), None).unwrap();
    let records = diff_trees(&trees, None, root, DEFAULT_PATH_BUDGET).unwrap();
    assert!(records.iter().all(|record| record.op() == ChangeOp::Add));
    check(&trees, &commit(root, None, Some(records.clone())), None).unwrap();
    // One record short is not complete.
    let rule = broken(check(
        &trees,
        &commit(root, None, Some(records[1..].to_vec())),
        None,
    ));
    assert!(matches!(rule, RuleViolation::NotCovered { .. }), "{rule:?}");
    // A first commit given a parent is still a first commit.
    let other = commit(root, None, None);
    check(&trees, &commit(root, None, None), Some(&other)).unwrap();
}

#[test]
fn trees_and_parents_must_be_present() {
    let before = library(&[("x", DIR), ("x/a", file(1))]);
    let after = library(&[("x", DIR), ("x/a", file(2)), ("y", DIR), ("y/b", file(3))]);
    let mut trees = MemoryTrees::new();
    let (parent_root, root) = (build(&mut trees, &before), build(&mut trees, &after));
    let parent = commit(parent_root, None, None);
    let edit = commit(root, Some(&parent), None);
    check(&trees, &edit, Some(&parent)).unwrap();
    // The parent it names, not given.
    assert_eq!(missing(check(&trees, &edit, None)), id_of(&parent));
    // A subtree of the commit's tree, of the parent's, or a root.
    let subtree = |trees: &MemoryTrees, root: ObjectId, name: &str| {
        folder(trees.tree(root).unwrap().unwrap().get(name).unwrap()).unwrap()
    };
    for absent in [
        subtree(&trees, root, "y"),
        subtree(&trees, parent_root, "x"),
        subtree(&trees, root, ".folio"),
        root,
        parent_root,
    ] {
        let mut some = trees.clone();
        some.remove(absent);
        assert_eq!(missing(check(&some, &edit, Some(&parent))), absent);
    }
}

#[test]
fn a_commit_changes_its_tree() {
    let tree = library(&[("a", file(1))]);
    let mut trees = MemoryTrees::new();
    let root = build(&mut trees, &tree);
    let parent = commit(root, None, None);
    let empty = commit(root, Some(&parent), None);
    assert_eq!(
        broken(check(&trees, &empty, Some(&parent))),
        RuleViolation::EmptyCommit
    );
    assert_eq!(
        broken(check(&trees, &as_import(empty), Some(&parent))),
        RuleViolation::EmptyCommit
    );
}

#[test]
fn prune_commits_keep_their_tree_and_thin_out_no_current_version() {
    let old = library(&[("w.docx", file(1)), ("x", DIR), ("x/v.docx", file(3))]);
    let new = library(&[("w.docx", file(2)), ("x", DIR), ("x/v.docx", file(3))]);
    let mut trees = MemoryTrees::new();
    let (c1_root, c2_root) = (build(&mut trees, &old), build(&mut trees, &new));
    let c1 = commit(c1_root, None, None);
    let c2 = commit(c2_root, Some(&c1), None);
    check(&trees, &prune(c2_root, &c2, &[side(1).hash]), Some(&c2)).unwrap();
    // A blob nothing holds may be listed too: which blobs to thin out is policy.
    check(&trees, &prune(c2_root, &c2, &[id(0x77)]), Some(&c2)).unwrap();
    let rule = broken(check(
        &trees,
        &prune(c1_root, &c2, &[side(1).hash]),
        Some(&c2),
    ));
    assert_eq!(rule, RuleViolation::PruneTree);
    // A current version, also in a folder.
    for current in [side(2).hash, side(3).hash, side(0xf0).hash] {
        let rule = broken(check(
            &trees,
            &prune(c2_root, &c2, &[side(1).hash, current]),
            Some(&c2),
        ));
        assert_eq!(rule, RuleViolation::PruneCurrent { blob: current });
    }
    // A current file that is not stored has no version to thin out.
    let mut unstored = side(4);
    unstored.stored = false;
    let with_unstored = library(&[("n.pdf", FlatEntry::File(unstored))]);
    let root = build(&mut trees, &with_unstored);
    let c3 = commit(root, Some(&c2), None);
    check(&trees, &prune(root, &c3, &[unstored.hash]), Some(&c3)).unwrap();
}

/// The second commit of the example library in miniature: an edit, a file moved out of a folder
/// that then goes, a folder renamed with one of its files edited, and a deletion.
fn example() -> (FlatTree, FlatTree, Vec<Change>) {
    let before = library(&[
        ("a.md", file(1)),
        ("c", DIR),
        ("c/n.md", file(2)),
        ("c/作业", DIR),
        ("c/作业/hw2.pdf", file(3)),
        ("c/Lectures", DIR),
        ("c/Lectures/L1.md", file(4)),
        ("c/Lectures/L2.md", file(5)),
    ]);
    let after = library(&[
        ("c", DIR),
        ("c/n.md", file(6)),
        ("c/hw2.pdf", file(3)),
        ("c/讲义", DIR),
        ("c/讲义/L1.md", file(4)),
        ("c/讲义/L2.md", file(7)),
    ]);
    let records = vec![
        Change::DeleteFile {
            path: path("a.md"),
            old: side(1),
        },
        Change::ModifyFile {
            path: path("c/n.md"),
            old: side(2),
            new: side(6),
        },
        Change::MoveFile {
            from: path("c/作业/hw2.pdf"),
            path: path("c/hw2.pdf"),
            old: side(3),
            new: side(3),
        },
        Change::DeleteDir {
            path: path("c/作业"),
        },
        Change::MoveDir {
            from: path("c/Lectures"),
            path: path("c/讲义"),
        },
        Change::MoveFile {
            from: path("c/Lectures/L2.md"),
            path: path("c/讲义/L2.md"),
            old: side(5),
            new: side(7),
        },
    ];
    (before, after, records)
}

#[test]
fn change_records_cover_the_differences() {
    let (before, after, records) = example();
    let differences = Differences::between(&before, &after);
    differences.check(&changes(records.clone())).unwrap();
    let mut trees = MemoryTrees::new();
    let (parent_root, root) = (build(&mut trees, &before), build(&mut trees, &after));
    let parent = commit(parent_root, None, None);
    check(
        &trees,
        &commit(root, Some(&parent), Some(records.clone())),
        Some(&parent),
    )
    .unwrap();
    // An import's change records are held to the same rules (§7.3, §8).
    let import =
        |records: &[Change]| as_import(commit(root, Some(&parent), Some(records.to_vec())));
    check(&trees, &import(&records), Some(&parent)).unwrap();
    let rule = broken(check(&trees, &import(&records[1..]), Some(&parent)));
    assert!(matches!(rule, RuleViolation::NotCovered { .. }), "{rule:?}");
    let without = |skip: usize| {
        let mut records = records.clone();
        records.remove(skip);
        changes(records)
    };
    // Each record is needed: the edited file in the renamed folder included.
    for skip in 0..records.len() {
        let rule = differences.check(&without(skip)).unwrap_err();
        assert!(
            matches!(rule, RuleViolation::NotCovered { .. }),
            "{skip}: {rule:?}"
        );
    }
    let with = |record: Change| {
        let mut records = records.clone();
        records.push(record);
        changes(records)
    };
    // What the folder move carries has no record of its own.
    let carried = with(Change::MoveFile {
        from: path("c/Lectures/L1.md"),
        path: path("c/讲义/L1.md"),
        old: side(4),
        new: side(4),
    });
    assert!(matches!(
        differences.check(&carried),
        Err(RuleViolation::CoveredTwice { .. })
    ));
    // A path that did not change.
    let unchanged = with(Change::DeleteFile {
        path: path(".folio/library.json"),
        old: side(0xf0),
    });
    assert!(matches!(
        differences.check(&unchanged),
        Err(RuleViolation::NotChanged { .. })
    ));
    // A record whose sides or kind are not the entries'.
    let mut wrong = records.clone();
    wrong[1] = Change::ModifyFile {
        path: path("c/n.md"),
        old: side(9),
        new: side(6),
    };
    let rule = differences.check(&changes(wrong)).unwrap_err();
    assert_eq!(
        rule,
        RuleViolation::SideDiffers {
            path: "c/n.md".into()
        }
    );
    let mut wrong = records.clone();
    wrong[0] = Change::DeleteDir { path: path("a.md") };
    let rule = differences.check(&changes(wrong)).unwrap_err();
    assert_eq!(
        rule,
        RuleViolation::KindDiffers {
            path: "a.md".into()
        }
    );
    // A move written as a delete and an add, and an edit as a delete and an add, are fine.
    let mut split = records.clone();
    split[2] = Change::DeleteFile {
        path: path("c/作业/hw2.pdf"),
        old: side(3),
    };
    split.push(Change::AddFile {
        path: path("c/hw2.pdf"),
        new: side(3),
    });
    split[1] = Change::DeleteFile {
        path: path("c/n.md"),
        old: side(2),
    };
    split.push(Change::AddFile {
        path: path("c/n.md"),
        new: side(6),
    });
    differences.check(&changes(split)).unwrap();
}

#[test]
fn nested_folder_moves_each_carry_their_own_content() {
    // `a` became `c`, and `a/b`, moved out of it, became `d`.
    let before = flat(&[
        ("a", DIR),
        ("a/b", DIR),
        ("a/b/x", file(1)),
        ("a/y", file(2)),
        ("a-z", file(3)),
    ]);
    let after = flat(&[
        ("c", DIR),
        ("c/y", file(2)),
        ("d", DIR),
        ("d/x", file(1)),
        ("a-z", file(3)),
    ]);
    let differences = Differences::between(&before, &after);
    let moves = vec![
        Change::MoveDir {
            from: path("a"),
            path: path("c"),
        },
        Change::MoveDir {
            from: path("a/b"),
            path: path("d"),
        },
    ];
    differences.check(&changes(moves.clone())).unwrap();
    assert_eq!(
        reference::changes_problem(Some(&changes(moves)), &before, &after),
        None
    );
    // `a/b` moved along with `a` to `c/b` cannot also move to `d`.
    let after = flat(&[
        ("c", DIR),
        ("c/y", file(2)),
        ("c/b", DIR),
        ("c/b/x", file(1)),
        ("d", DIR),
        ("d/x", file(1)),
        ("a-z", file(3)),
    ]);
    let differences = Differences::between(&before, &after);
    let records = changes(vec![
        Change::MoveDir {
            from: path("a"),
            path: path("c"),
        },
        Change::MoveDir {
            from: path("a/b"),
            path: path("d"),
        },
    ]);
    assert!(matches!(
        differences.check(&records),
        Err(RuleViolation::CoveredTwice { .. })
    ));
    assert_eq!(
        reference::changes_problem(Some(&records), &before, &after),
        Some("coverage")
    );
}

#[test]
fn folder_moves_nested_in_their_new_place_each_carry_their_own_content() {
    let moves = changes(vec![
        Change::MoveDir {
            from: path("a"),
            path: path("c"),
        },
        Change::MoveDir {
            from: path("b"),
            path: path("c/d"),
        },
    ]);
    // `a` became `c`, and `b` moved into it as `d`: each move carries its own file.
    let before = flat(&[("a", DIR), ("a/x", file(1)), ("b", DIR), ("b/y", file(2))]);
    let after = flat(&[
        ("c", DIR),
        ("c/d", DIR),
        ("c/d/y", file(2)),
        ("c/x", file(1)),
    ]);
    Differences::between(&before, &after).check(&moves).unwrap();
    assert_eq!(
        reference::changes_problem(Some(&moves), &before, &after),
        None
    );
    // A file `a/d` is not the folder `c/d`: deleted on its own, while `b` brings `c/d`.
    let before = flat(&[("a", DIR), ("a/d", file(3)), ("b", DIR), ("b/y", file(2))]);
    let after = flat(&[("c", DIR), ("c/d", DIR), ("c/d/y", file(2))]);
    let mut records = moves.records().to_vec();
    records.insert(
        0,
        Change::DeleteFile {
            path: path("a/d"),
            old: side(3),
        },
    );
    let records = changes(records);
    Differences::between(&before, &after)
        .check(&records)
        .unwrap();
    assert_eq!(
        reference::changes_problem(Some(&records), &before, &after),
        None
    );
    // A folder `a/d` moves along with `a` to `c/d`, which `b` cannot become too: what lies below
    // `c/d` is `b`'s to carry, but `c/d` itself is covered twice.
    let before = flat(&[
        ("a", DIR),
        ("a/d", DIR),
        ("a/d/y", file(2)),
        ("b", DIR),
        ("b/y", file(2)),
    ]);
    assert_eq!(
        Differences::between(&before, &after).check(&moves),
        Err(RuleViolation::CoveredTwice { path: "c/d".into() })
    );
    assert_eq!(
        reference::changes_problem(Some(&moves), &before, &after),
        Some("coverage")
    );
}

#[test]
fn a_folder_moved_whole_is_one_record() {
    let mut before = library(&[("old", DIR), ("old/sub", DIR)]);
    for i in 0..50_u8 {
        before.insert(format!("old/sub/{i}.md"), file(i));
    }
    let after: FlatTree = before
        .iter()
        .map(|(p, e)| (p.replacen("old", "new", 1), *e))
        .collect();
    let mut trees = MemoryTrees::new();
    let (parent_root, root) = (build(&mut trees, &before), build(&mut trees, &after));
    let parent = commit(parent_root, None, None);
    let moved = commit(
        root,
        Some(&parent),
        Some(vec![Change::MoveDir {
            from: path("old"),
            path: path("new"),
        }]),
    );
    check(&trees, &moved, Some(&parent)).unwrap();
}

#[test]
fn absent_blobs_are_pruned_only_after_a_prune_commit() {
    let old = library(&[("w.docx", file(1))]);
    let new = library(&[("w.docx", file(2))]);
    let mut trees = MemoryTrees::new();
    let (r1, r2) = (build(&mut trees, &old), build(&mut trees, &new));
    let c1 = commit(r1, None, None);
    let c2 = commit(r2, Some(&c1), None);
    let c3 = prune(r2, &c2, &[side(1).hash]);
    let c4 = commit(r1, Some(&c3), None);
    let chain = [c1.clone(), c2.clone(), c3.clone(), c4.clone()];
    let (v1, v2) = (side(1).hash, side(2).hash);
    let pruned = |result: StoreError| match result {
        StoreError::Pruned(blob) => Some(blob),
        StoreError::Missing(_) => None,
        other => panic!("{other:?}"),
    };
    assert_eq!(pruned(absent_blob(&chain, 0, v1)), Some(v1));
    assert_eq!(pruned(absent_blob(&chain[..3], 0, v1)), Some(v1));
    assert_eq!(pruned(absent_blob(&chain[..2], 0, v1)), None);
    // The version c4 brought back, and one never thinned out.
    assert_eq!(pruned(absent_blob(&chain, 3, v1)), None);
    assert_eq!(pruned(absent_blob(&chain, 1, v2)), None);
    // Commits by reference work too, and an index past the head finds nothing later.
    let by_ref: Vec<&Commit> = chain.iter().collect();
    assert_eq!(pruned(absent_blob(&by_ref, 0, v1)), Some(v1));
    assert_eq!(pruned(absent_blob(&chain, 9, v1)), None);
    // Deleting.
    assert!(may_delete(&trees, &chain[..3], v1).unwrap());
    assert!(!may_delete(&trees, &chain, v1).unwrap());
    assert!(!may_delete(&trees, &chain[..3], v2).unwrap());
    assert!(!may_delete(&trees, &chain[..2], v1).unwrap());
    // The reference agrees.
    let with_trees: Vec<(Commit, FlatTree)> = chain
        .iter()
        .map(|c| (c.clone(), reference::flatten(&trees, c.tree).unwrap()))
        .collect();
    for (len, blob) in [(3, v1), (4, v1), (3, v2), (2, v1)] {
        assert_eq!(
            may_delete(&trees, &chain[..len], blob).unwrap(),
            reference::deletable(&with_trees[..len], blob),
            "{len} {blob}"
        );
    }
    assert!(reference::absent_blob_pruned(&chain, 0, v1));
    // A tree it needs and does not have.
    let mut some = trees.clone();
    some.remove(r2);
    assert_eq!(missing(may_delete(&some, &chain[..3], v1).map(drop)), r2);

    // Every commit that stores the blob counts, not only the head: after the prune commit c3, c4
    // brings v1 back and c5 replaces it again, so c4's version waits for a prune commit of its own
    // (c6), however the head's tree looks. Each prune commit counts from where it is: the second
    // one, not the first, decides.
    let c5 = commit(r2, Some(&c4), None);
    let c6 = prune(r2, &c5, &[v1]);
    let again = [c1, c2, c3, c4, c5, c6];
    let with_trees: Vec<(Commit, FlatTree)> = again
        .iter()
        .map(|c| (c.clone(), reference::flatten(&trees, c.tree).unwrap()))
        .collect();
    for (len, deletable) in [(5, false), (6, true)] {
        assert_eq!(
            may_delete(&trees, &again[..len], v1).unwrap(),
            deletable,
            "{len}"
        );
        assert_eq!(
            reference::deletable(&with_trees[..len], v1),
            deletable,
            "{len}"
        );
    }
}

/// Runs `check_commit` and generate.mjs's rules on the same commit and says how each ended.
fn both(trees: &MemoryTrees, commit: &Commit, parent: Option<&Commit>) -> (Outcome, Outcome) {
    let ours = match check(trees, commit, parent) {
        Ok(()) => Outcome::Valid,
        Err(StoreError::Missing(_)) => Outcome::Missing,
        Err(StoreError::Invalid {
            problem: Problem::Rule(_),
            ..
        }) => Outcome::Invalid("rule"),
        Err(other) => panic!("unexpected {other:?}"),
    };
    let theirs = match reference::commit_problem(commit, parent, trees) {
        Outcome::Invalid(_) => Outcome::Invalid("rule"),
        outcome => outcome,
    };
    (ours, theirs)
}

/// A change to a list of records, or none.
#[derive(Debug, Clone)]
enum Mutation {
    None,
    Drop(Index),
    /// Another record at the path of one: covering one of its paths twice, or the wrong side.
    Twin(Index, u8),
    /// One record with a side, a kind or a path altered.
    Alter(Index, u8),
    /// A move or a modify written as a delete and an add (§8 rule 6): still valid, except for a
    /// folder move that carried something.
    Split(Index),
}

fn mutation() -> impl Strategy<Value = Mutation> {
    prop_oneof![
        2 => Just(Mutation::None),
        1 => any::<Index>().prop_map(Mutation::Drop),
        1 => (any::<Index>(), any::<u8>()).prop_map(|(at, how)| Mutation::Twin(at, how)),
        1 => (any::<Index>(), any::<u8>()).prop_map(|(at, how)| Mutation::Alter(at, how)),
        1 => any::<Index>().prop_map(Mutation::Split),
    ]
}

fn other_side(side: Side, how: u8) -> Side {
    let mut side = side;
    match how % 3 {
        0 => side.size = Size::new(side.size.get() + 1).unwrap(),
        1 => side.stored = !side.stored,
        _ => side.hash = id(0xee),
    }
    side
}

/// `records` with `mutation` applied; `None` when the result is not a list of records at all
/// (empty, or a path and operation twice).
fn mutate(records: &[Change], mutation: &Mutation) -> Option<Changes> {
    let mut records = records.to_vec();
    match *mutation {
        Mutation::None => {}
        Mutation::Drop(at) => {
            if records.is_empty() {
                return None;
            }
            records.remove(at.index(records.len()));
        }
        Mutation::Split(at) => {
            let at = at.index(records.len().max(1));
            let (delete, add) = match records.get(at)?.clone() {
                Change::ModifyFile { path, old, new } => (
                    Change::DeleteFile {
                        path: path.clone(),
                        old,
                    },
                    Change::AddFile { path, new },
                ),
                Change::MoveFile {
                    from,
                    path,
                    old,
                    new,
                } => (
                    Change::DeleteFile { path: from, old },
                    Change::AddFile { path, new },
                ),
                Change::MoveDir { from, path } => {
                    (Change::DeleteDir { path: from }, Change::AddDir { path })
                }
                _ => return None,
            };
            records[at] = delete;
            records.push(add);
        }
        Mutation::Twin(at, how) => {
            let record = records.get(at.index(records.len().max(1)))?.clone();
            let at = record.path().clone();
            let old = record.old_side().unwrap_or(side(0xe1));
            records.push(match how % 4 {
                0 => Change::DeleteFile { path: at, old },
                1 => Change::DeleteDir { path: at },
                2 => Change::AddFile { path: at, new: old },
                _ => Change::AddDir { path: at },
            });
        }
        Mutation::Alter(at, how) => {
            let at = at.index(records.len().max(1));
            let record = records.get(at)?.clone();
            // A side, the kind, or a path; Changes::new refuses what rule 4 refuses.
            let (what, how) = (how % 3, how / 3);
            records[at] = match (record, what) {
                (Change::AddFile { path, new }, 0) => Change::AddFile {
                    path,
                    new: other_side(new, how),
                },
                (Change::AddFile { path, .. }, 1) => Change::AddDir { path },
                (Change::AddFile { path, new }, _) => Change::AddFile {
                    path: other_path(&path),
                    new,
                },
                (Change::AddDir { path }, 0 | 1) => Change::AddFile {
                    path,
                    new: side(0xe2),
                },
                (Change::AddDir { path }, _) => Change::AddDir {
                    path: other_path(&path),
                },
                (Change::DeleteFile { path, old }, 0) => Change::DeleteFile {
                    path,
                    old: other_side(old, how),
                },
                (Change::DeleteFile { path, .. }, 1) => Change::DeleteDir { path },
                (Change::DeleteFile { path, old }, _) => Change::DeleteFile {
                    path: other_path(&path),
                    old,
                },
                (Change::DeleteDir { path }, 0 | 1) => Change::DeleteFile {
                    path,
                    old: side(0xe3),
                },
                (Change::DeleteDir { path }, _) => Change::DeleteDir {
                    path: other_path(&path),
                },
                (Change::ModifyFile { path, old, new }, 0) => Change::ModifyFile {
                    path,
                    old,
                    new: other_side(new, how),
                },
                (Change::ModifyFile { path, old, new }, 1) => Change::ModifyFile {
                    path,
                    old: other_side(old, how),
                    new,
                },
                (Change::ModifyFile { path, old, new }, _) => Change::ModifyFile {
                    path: other_path(&path),
                    old,
                    new,
                },
                (
                    Change::MoveFile {
                        from,
                        path,
                        old,
                        new,
                    },
                    0,
                ) => Change::MoveFile {
                    from,
                    path,
                    old,
                    new: other_side(new, how),
                },
                (
                    Change::MoveFile {
                        from,
                        path,
                        old,
                        new,
                    },
                    1,
                ) => Change::MoveFile {
                    from,
                    path,
                    old: other_side(old, how),
                    new,
                },
                (
                    Change::MoveFile {
                        from,
                        path,
                        old,
                        new,
                    },
                    _,
                ) => Change::MoveFile {
                    from: other_path(&from),
                    path,
                    old,
                    new,
                },
                (Change::MoveDir { from, path }, 0 | 1) => Change::MoveDir {
                    from,
                    path: other_path(&path),
                },
                (Change::MoveDir { from, path }, _) => Change::MoveDir {
                    from: other_path(&from),
                    path,
                },
            };
        }
    }
    Changes::new(records).ok()
}

/// A path next to `path` that no library of `model` holds.
fn other_path(path: &TreePath) -> TreePath {
    TreePath::parse(&format!("{path}~")).unwrap()
}

/// What the agreement test builds a commit from.
#[derive(Debug, Clone)]
struct Agreement {
    before: Library,
    ops: Vec<model::Op>,
    /// 0: a prune commit, 1: a commit without change records, 2: an import with records, else a
    /// commit with records.
    kind: u8,
    /// A first commit of the changed library, with no parent.
    first: bool,
    mutation: Mutation,
    /// The blobs a prune commit lists, and whether it may pick current versions.
    thinned: Vec<Index>,
    current: bool,
    /// A tree of either side that has not arrived.
    absent: Option<Index>,
}

fn agreement() -> impl Strategy<Value = Agreement> {
    (
        model::library(),
        prop::collection::vec(model::op(), 0..6),
        0..5_u8,
        prop::bool::weighted(0.15),
        mutation(),
        prop::collection::vec(any::<Index>(), 1..3),
        prop::bool::weighted(0.3),
        proptest::option::weighted(0.25, any::<Index>()),
    )
        .prop_map(
            |(before, ops, kind, first, mutation, thinned, current, absent)| Agreement {
                before,
                ops,
                kind,
                first,
                mutation,
                thinned,
                current,
                absent,
            },
        )
}

/// A commit with its parent and the trees it is read with.
struct Case {
    trees: MemoryTrees,
    commit: Commit,
    parent: Option<Commit>,
}

impl Agreement {
    fn case(&self) -> Case {
        let after = model::apply(&self.before, &self.ops);
        let empty = Library::new();
        let base = if self.first { &empty } else { &self.before };
        let records = model::write_changes(base, &after);
        let (before, after) = (model::flat(&self.before), model::flat(&after));
        let mut trees = MemoryTrees::new();
        let parent_root = build(&mut trees, &before);
        let root = build(&mut trees, &after);
        let parent = (!self.first).then(|| commit(parent_root, None, None));
        let candidate = match (self.kind, &parent) {
            (0, Some(parent)) => {
                // Blobs of either tree; current versions of the parent's only when allowed.
                let current: Vec<ObjectId> = before
                    .values()
                    .filter_map(FlatEntry::side)
                    .filter(|side| side.stored)
                    .map(|side| side.hash)
                    .collect();
                let blobs: Vec<ObjectId> = before
                    .values()
                    .chain(after.values())
                    .filter_map(FlatEntry::side)
                    .map(|side| side.hash)
                    .filter(|hash| self.current || !current.contains(hash))
                    .chain([id(0x99)])
                    .collect();
                let pruned: Vec<ObjectId> = self
                    .thinned
                    .iter()
                    .map(|at| blobs[at.index(blobs.len())])
                    .collect();
                let tree = if self.thinned[0].index(3) == 0 {
                    root
                } else {
                    parent_root
                };
                prune(tree, parent, &pruned)
            }
            (1, _) => commit(root, parent.as_ref(), None),
            (kind, _) => {
                let changes = mutate(&records, &self.mutation).map(Changes::into_records);
                let written = commit(root, parent.as_ref(), changes);
                if kind == 2 {
                    as_import(written)
                } else {
                    written
                }
            }
        };
        if let Some(at) = self.absent {
            let mut ids: Vec<ObjectId> = Vec::new();
            for root in [root, parent_root] {
                let mut stack = vec![root];
                while let Some(id) = stack.pop() {
                    ids.push(id);
                    for entry in trees.tree(id).unwrap().unwrap().entries() {
                        stack.extend(folder(entry));
                    }
                }
            }
            trees.remove(ids[at.index(ids.len())]);
        }
        Case {
            trees,
            commit: candidate,
            parent,
        }
    }
}

proptest! {
    // Small trees in memory make a case cost about a tenth of a millisecond, so these run more
    // cases than the store's other property tests.
    #![proptest_config(ProptestConfig::with_cases(256))]

    /// diff_trees gives records that cover the differences (rules 1–3), so a commit with them is
    /// valid; and both ways of finding the differences agree.
    #[test]
    fn diff_trees_records_cover_the_differences(
        before in model::library(),
        ops in prop::collection::vec(model::op(), 0..6),
    ) {
        let after = model::apply(&before, &ops);
        let (before, after) = (model::flat(&before), model::flat(&after));
        let mut trees = MemoryTrees::new();
        let (parent, tree) = (build(&mut trees, &before), build(&mut trees, &after));
        let walked = Differences::of_trees(&trees, Some(parent), tree, DEFAULT_PATH_BUDGET).unwrap();
        prop_assert_eq!(&walked, &Differences::between(&before, &after));
        let records = diff_trees(&trees, Some(parent), tree, DEFAULT_PATH_BUDGET).unwrap();
        prop_assert_eq!(records.is_empty(), parent == tree);
        if !records.is_empty() {
            let sorted = changes(records.clone());
            prop_assert_eq!(sorted.records(), &records[..], "already in rule 5's order");
            prop_assert_eq!(walked.check(&sorted), Ok(()));
            prop_assert_eq!(reference::changes_problem(Some(&sorted), &before, &after), None);
        }
    }

    /// Dropping a record of diff_trees, covering one of its paths again, or altering one makes
    /// the records fail, and a modify written as a delete and an add passes; a record twice is
    /// not a list of records at all.
    #[test]
    fn dropping_repeating_or_altering_a_record_fails(
        before in model::library(),
        ops in prop::collection::vec(model::op(), 1..6),
        mutation in mutation(),
        repeat in any::<Index>(),
    ) {
        let after = model::apply(&before, &ops);
        let (before, after) = (model::flat(&before), model::flat(&after));
        let differences = Differences::between(&before, &after);
        let records = differences.records().unwrap();
        if records.is_empty() {
            return Ok(());
        }
        let mut twice = records.clone();
        twice.push(records[repeat.index(records.len())].clone());
        prop_assert!(Changes::new(twice).is_err());
        if let Some(mutated) = mutate(&records, &mutation) {
            // Without moves, a split modify is the other way to write it; nothing else passes.
            let valid = matches!(mutation, Mutation::None | Mutation::Split(_));
            prop_assert_eq!(differences.check(&mutated).is_ok(), valid, "{:?}", mutated);
            prop_assert_eq!(
                reference::changes_problem(Some(&mutated), &before, &after).is_none(),
                valid
            );
        }
    }

    /// A writer that knows what moved writes valid records; whatever is done to them, the
    /// checker's walk over changed folders and generate.mjs's rules over whole trees agree.
    #[test]
    fn written_moves_are_valid_and_the_checker_agrees_on_changes(
        before in model::library(),
        ops in prop::collection::vec(model::op(), 1..8),
        mutation in mutation(),
    ) {
        let after = model::apply(&before, &ops);
        let records = model::write_changes(&before, &after);
        let (before, after) = (model::flat(&before), model::flat(&after));
        let differences = Differences::between(&before, &after);
        prop_assert_eq!(records.is_empty(), differences.is_empty());
        if records.is_empty() {
            return Ok(());
        }
        let written = changes(records.clone());
        prop_assert_eq!(differences.check(&written), Ok(()), "{:?}", written);
        prop_assert_eq!(reference::changes_problem(Some(&written), &before, &after), None);
        if let Some(mutated) = mutate(&records, &mutation) {
            prop_assert_eq!(
                differences.check(&mutated).is_ok(),
                reference::changes_problem(Some(&mutated), &before, &after).is_none(),
                "{:?}", mutated
            );
        }
    }

    /// The whole check of a commit in its history agrees with generate.mjs's: random libraries
    /// with broken roots, moves, prune commits, and trees that have not arrived.
    #[test]
    fn the_checker_agrees_with_generate_mjs(input in agreement()) {
        let Case { trees, commit, parent } = input.case();
        let (ours, theirs) = both(&trees, &commit, parent.as_ref());
        prop_assert_eq!(ours, theirs, "{:?}", commit);
    }

    /// The longest path the checker keeps per tree is the longest path of the flattened tree.
    #[test]
    fn longest_paths_are_those_of_the_flattened_tree(library in model::library()) {
        let flat = model::flat(&library);
        let mut trees = MemoryTrees::new();
        let root = build(&mut trees, &flat);
        let longest = flat.keys().map(|path| path.encode_utf16().count()).max().unwrap_or(0);
        prop_assert_eq!(HistoryChecker::new(&trees).longest_path(root).unwrap(), longest);
    }
}
