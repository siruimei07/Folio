//! The rules of history format 1 that need trees (remote-format.md §7.3–§7.5 and §8), and the
//! check a reader runs when it first reads a commit (§11, "a commit in its history").
//!
//! - [`TreeSource`] gives trees by id, or `Ok(None)` when it does not have one: the tree is
//!   missing. [`MemoryTrees`] holds trees in memory; the local store is another source.
//! - [`flatten`] gives every path of a tree with its entry ([`FlatTree`], §8's flattened tree).
//! - [`Differences`] are the paths where a commit's tree differs from its parent's: found by
//!   walking both trees and skipping folders whose tree ids are equal at the same path, or from two
//!   flattened trees. [`Differences::check`] is §8's coverage by change records, folder moves and
//!   rule 6 included; [`diff_trees`] gives the records a reader finds without moves (§8 rule 7).
//! - [`check_root`] is §7.4 on a flattened root tree.
//! - [`HistoryChecker`] checks a commit against its trees and its parent.
//! - [`absent_blob`] tells a pruned blob from a missing one and [`may_delete`] says whether a store
//!   may delete a blob (§7.5).
//!
//! Trees are untrusted input, also those of the local store: a library folder can come from
//! anywhere (another computer, a copy, a sync client). No walk recurses, since a valid tree can be
//! about 16,000 folders deep (a path has at most 32,767 UTF-16 code units). Walks that list paths
//! stop at a *path budget*: folders that repeat each other's trees let a tree of a few kilobytes
//! hold more paths than memory can. The budget counts the entries a walk looks at, and the bytes it
//! keeps: [`PATH_BYTES_PER_ENTRY`] for each entry of the budget. What a walk keeps is the paths it
//! lists, each copied whole into the entry of a map, so neither long names nor short ones in
//! repeated folders can fill memory with the paths of a few kilobytes of trees; the change records
//! [`diff_trees`] makes of them; the trees of the folders it is in, so a chain of distinct trees of
//! up to 64 MiB each, each entered through its first entry, cannot hold gigabytes while the walk
//! looks at one entry a tree; each tree it meets again, which it keeps rather than read once more
//! (reading a tree from the store costs a pack record, far more than walking its entries); the ids
//! of the trees it read; and its stack of folders and its current path at their deepest and
//! longest, as a chain of folders makes them. Each is counted at the room it takes, with the slack
//! of the map, table or list that holds it, so what a walk holds stays within the budget's bytes
//! beside the one tree being read. The check of presence and path lengths
//! ([`HistoryChecker::longest_path`]) lists no paths and visits each tree once; what it holds, the
//! folders of the trees it is in, its stack of the trees it has still to enter and the set of the
//! trees it is in, counts against the same bytes.

use std::borrow::Borrow;
use std::cmp::Ordering;
use std::collections::{HashMap, HashSet, btree_map};
use std::ops::Bound;
use std::sync::Arc;

use super::commit::{Change, Changes, Commit, CommitKind};
use super::schema::shown;
use super::tree::{EntryKind, Side, Tree, TreeEntry};
use super::values::{MAX_PATH_UNITS, TreePath, ValueError, same_ntfs_name, utf16_len};
use super::{Limit, ObjectId, Problem, StoreError, Subject};

/// The default path budget: the most tree entries one walk looks at. Twenty times the largest
/// library M2 aims at (50,000 files); a tree whose folders repeat each other can hold far more
/// paths than it has bytes. A walk also keeps at most [`PATH_BYTES_PER_ENTRY`] bytes for each entry
/// of its budget: 256,000,000 bytes at this one.
pub const DEFAULT_PATH_BUDGET: usize = 1_000_000;

/// The bytes a walk may keep for each entry of its path budget (the module's docs say what it
/// keeps). Each path a walk lists is copied whole, and one may be 32,767 UTF-16 code units (up to
/// three bytes each), so without this bound a few thousand paths under long names could fill
/// gigabytes; under short names a path costs about the map entry that keeps it (216 bytes beside
/// its own), so a count of entries alone would let a walk keep several times what it counts. A path
/// of 60 bytes kept once costs 276 of these bytes, and one kept on both sides twice that: at the
/// default budget a walk lists about 930,000 or 460,000 such paths (eighteen and nine times the
/// largest library M2 aims at) before it reaches them. A valid tree can be over it, as it can be
/// over the count: a chain of 16,383 one-letter folders lists 268,435,456 bytes of paths. What the
/// check of presence and path lengths holds counts here too.
pub const PATH_BYTES_PER_ENTRY: usize = 256;

/// What a walk counts for each copy of a path it reports, besides the path's bytes: the entry of
/// the map that keeps it, a `String` and a [`FlatEntry`] in a B-tree node, which holds 5 to 11
/// entries when insertions fill it (at most about 165 bytes an entry, 137 for paths that come in
/// order), and the place a check of change records gives the path in the set of those it covered,
/// a table made at its size (at most about 39 bytes): three slots of a path and its entry.
const MAP_ENTRY_BYTES: usize = 3 * (size_of::<String>() + size_of::<FlatEntry>());

/// What a walk counts for each frame its stack holds beyond any number before: three frames' room,
/// as the stack keeps the room it took, grows by doubling, and holds its old room beside the new
/// one while it moves. Its current path is counted the same way, three bytes for each byte it is
/// longer than ever before.
const FRAME_BYTES: usize = 3 * size_of::<Frame>();

/// What a walk counts for each tree it reads for the first time, besides the tree: its id in the
/// table of the trees the walk read, a slot of a hash table that grows by doubling and keeps up to
/// eight slots for seven ids (at most about 141 bytes an id while it moves).
const TREE_ID_BYTES: usize = 4 * size_of::<(ObjectId, Option<Arc<Tree>>)>();

/// The folder of the library's metadata (remote-format.md §7.4).
const FOLIO: &str = ".folio";

/// The library file every commit's root holds.
const LIBRARY_FILE: &str = ".folio/library.json";

/// Where the rules read trees: the local store, or trees in memory ([`MemoryTrees`]).
///
/// `tree(id)` gives the tree whose id is `id`, or `Ok(None)` when the source does not have it: the
/// tree is *missing* (remote-format.md §11). Errors are for trees the source has but cannot read:
/// I/O, a damaged or newer pack. A source never gives a tree under another id than its own (the
/// store recomputes the id of every object it reads, §11 step 10); one that does can make a walk
/// report a tree that holds itself, or run into its budget.
pub trait TreeSource {
    fn tree(&self, id: ObjectId) -> Result<Option<Arc<Tree>>, StoreError>;
}

impl<S: TreeSource + ?Sized> TreeSource for &S {
    fn tree(&self, id: ObjectId) -> Result<Option<Arc<Tree>>, StoreError> {
        (**self).tree(id)
    }
}

/// Trees in memory, each under the id of its canonical encoding.
#[derive(Debug, Clone, Default)]
pub struct MemoryTrees {
    trees: HashMap<ObjectId, Arc<Tree>>,
}

impl MemoryTrees {
    pub fn new() -> Self {
        Self::default()
    }

    /// Adds a tree under its id, and returns the id. A tree over 64 MiB, which no store holds, is
    /// [`StoreError::TooLarge`].
    pub fn insert(&mut self, tree: Tree) -> Result<ObjectId, StoreError> {
        let id = tree.encode()?.id();
        self.trees.insert(id, Arc::new(tree));
        Ok(id)
    }

    /// Takes a tree out, so that it is missing.
    pub fn remove(&mut self, id: ObjectId) -> Option<Arc<Tree>> {
        self.trees.remove(&id)
    }

    pub fn contains(&self, id: ObjectId) -> bool {
        self.trees.contains_key(&id)
    }

    pub fn len(&self) -> usize {
        self.trees.len()
    }

    pub fn is_empty(&self) -> bool {
        self.trees.is_empty()
    }
}

impl TreeSource for MemoryTrees {
    fn tree(&self, id: ObjectId) -> Result<Option<Arc<Tree>>, StoreError> {
        Ok(self.trees.get(&id).cloned())
    }
}

/// The entry at a path of a flattened tree (remote-format.md §8): a folder, or a file with its
/// hash, size and `stored`. Two entries are the *same* exactly when they are equal: both folders,
/// whatever they hold, or files with equal sides.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum FlatEntry {
    Dir,
    File(Side),
}

impl FlatEntry {
    pub fn kind(&self) -> EntryKind {
        match self {
            Self::Dir => EntryKind::Dir,
            Self::File(_) => EntryKind::File,
        }
    }

    /// A file's hash, size and `stored`; `None` for a folder.
    pub fn side(&self) -> Option<Side> {
        match *self {
            Self::Dir => None,
            Self::File(side) => Some(side),
        }
    }
}

impl From<&TreeEntry> for FlatEntry {
    fn from(entry: &TreeEntry) -> Self {
        entry.side().map_or(Self::Dir, Self::File)
    }
}

/// A flattened tree (remote-format.md §8): every path a tree holds below its root, in UTF-8 byte
/// order, with its entry. Paths are text rather than [`TreePath`]s: a tree that breaks §7.4 rule 5
/// holds a path longer than a path may be.
pub type FlatTree = std::collections::BTreeMap<String, FlatEntry>;

/// Why a commit breaks a rule that needs its trees or its parent (remote-format.md §7.3–§7.5,
/// §8). Paths are shortened to a few dozen characters; the reasons are for logs.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum RuleViolation {
    /// §7.4 rule 1: a root entry other than `.folio` that NTFS takes for it (`.Folio`, `.folıo`).
    #[error("the root holds {name:?}, which NTFS takes for `.folio`")]
    FolioName { name: String },
    /// §7.4 rule 5.
    #[error("a path is {units} UTF-16 code units long, more than {MAX_PATH_UNITS}")]
    PathTooLong { units: usize },
    /// §7.4 rules 1 and 2: the root has no folder `.folio` holding the file `library.json`.
    #[error("the root has no folder `.folio` holding the file `library.json`")]
    FolioMissing,
    /// §7.4 rule 2: `.folio` holds an entry NTFS takes for `local` or `store`.
    #[error("`.folio` holds {name:?}, which NTFS takes for Folio's private `local` or `store`")]
    FolioPrivate { name: String },
    /// §7.4 rules 2 and 3: a folder `.folio` may not hold, or a file deeper than its layout.
    #[error("`.folio` may not hold {path:?}")]
    FolioPath { path: String },
    /// §7.4 rule 4.
    #[error("{path:?} is under `.folio` but not stored")]
    FolioNotStored { path: String },
    /// §7.3: a `commit` or `import` whose tree is its parent's.
    #[error("the commit's tree is its parent's: nothing changed")]
    EmptyCommit,
    /// §7.5: a prune commit's tree is not its parent's.
    #[error("the prune commit's tree is not its parent's")]
    PruneTree,
    /// §7.5: a prune commit thins out a current version.
    #[error("the prune commit thins out {blob}, the content of a stored file of its own tree")]
    PruneCurrent { blob: ObjectId },
    /// §8 rule 2: a record's side covers a path that did not change on that side.
    #[error("a change record covers {path:?}, which did not change on that side")]
    NotChanged { path: String },
    /// §8 rule 2: a path covered twice, by records or by a folder move.
    #[error("{path:?} is covered twice")]
    CoveredTwice { path: String },
    /// §8 rule 2: a path that changed and that nothing covers.
    #[error("no change record covers {path:?}")]
    NotCovered { path: String },
    /// §8 rule 1: a record's kind is not that of the entry it covers.
    #[error("a change record's kind is not that of the entry at {path:?}")]
    KindDiffers { path: String },
    /// §8 rule 1: a record's `old` or `new` is not the file it covers.
    #[error("a change record's old or new is not the file at {path:?}")]
    SideDiffers { path: String },
    /// A tree that holds itself, which no tree can (§4): its source gave it under another id.
    #[error("the tree {tree} holds itself")]
    TreeCycle { tree: ObjectId },
}

/// The tree `id` from `source`, or [`StoreError::Missing`].
fn read_tree<S: TreeSource + ?Sized>(source: &S, id: ObjectId) -> Result<Arc<Tree>, StoreError> {
    source.tree(id)?.ok_or(StoreError::Missing(id))
}

/// A folder entry's tree; `None` for a file.
fn folder(entry: &TreeEntry) -> Option<ObjectId> {
    match *entry {
        TreeEntry::Dir { tree, .. } => Some(tree),
        TreeEntry::File { .. } => None,
    }
}

/// One folder of a walk: its tree on each side, the next entry on each, the length of the path
/// before the folder's name, and the bytes the walk keeps for the folder's trees while it is in the
/// folder ([`Kept::enter`]).
struct Frame {
    parent: Option<Arc<Tree>>,
    tree: Option<Arc<Tree>>,
    next_parent: usize,
    next_tree: usize,
    restore: usize,
    held: usize,
}

impl Frame {
    /// The next name, with its entry on each side that has it. Names come in UTF-8 byte order,
    /// the order of a tree's entries.
    fn next(&mut self) -> Option<(Option<&TreeEntry>, Option<&TreeEntry>)> {
        let old = self
            .parent
            .as_deref()
            .and_then(|tree| tree.entries().get(self.next_parent));
        let new = self
            .tree
            .as_deref()
            .and_then(|tree| tree.entries().get(self.next_tree));
        let order = match (old, new) {
            (None, None) => return None,
            (Some(_), None) => Ordering::Less,
            (None, Some(_)) => Ordering::Greater,
            (Some(old), Some(new)) => old.name().cmp(new.name()),
        };
        if order != Ordering::Greater {
            self.next_parent += 1;
        }
        if order != Ordering::Less {
            self.next_tree += 1;
        }
        Some(match order {
            Ordering::Less => (old, None),
            Ordering::Greater => (None, new),
            Ordering::Equal => (old, new),
        })
    }
}

/// The trees a walk reads, and the bytes it keeps within its budget's: the paths it reports with
/// the map entries that keep them, the trees of the folders it is in, each tree it meets a second
/// time, which it keeps from then on, the ids of the trees it read, and its stack and path at their
/// deepest and longest.
struct Kept<'s, S: ?Sized> {
    source: &'s S,
    /// The trees read, by id: `None` for a tree read once, the tree itself from its second read on.
    trees: HashMap<ObjectId, Option<Arc<Tree>>>,
    bytes: usize,
    limit: usize,
    subject: ObjectId,
    /// The most frames the walk's stack has held, and the most bytes its path has had.
    deepest: usize,
    longest: usize,
}

impl<'s, S: TreeSource + ?Sized> Kept<'s, S> {
    fn new(source: &'s S, limit: usize, subject: ObjectId) -> Self {
        Self {
            source,
            trees: HashMap::new(),
            bytes: 0,
            limit,
            subject,
            deepest: 0,
            longest: 0,
        }
    }

    /// Counts `bytes` more kept; beyond the limit, [`StoreError::TooLarge`] about the subject.
    fn add(&mut self, bytes: usize) -> Result<(), StoreError> {
        self.bytes = self.bytes.saturating_add(bytes);
        if self.bytes > self.limit {
            return Err(StoreError::TooLarge {
                what: Subject::Object(self.subject),
                limit: Limit::PathBytes(self.limit),
            });
        }
        Ok(())
    }

    /// Counts a stack of `depth` frames and a path of `path_len` bytes where either is more than
    /// it has been before in the walk ([`FRAME_BYTES`]): the stack and the path keep the room they
    /// took when they grew.
    fn reach(&mut self, depth: usize, path_len: usize) -> Result<(), StoreError> {
        let frames = depth.saturating_sub(self.deepest);
        let bytes = path_len.saturating_sub(self.longest);
        self.deepest = self.deepest.max(depth);
        self.longest = self.longest.max(path_len);
        self.add(
            frames
                .saturating_mul(FRAME_BYTES)
                .saturating_add(bytes.saturating_mul(3)),
        )
    }

    /// The frame of a folder whose trees are `parent` and `tree` on each side (`None` where a side
    /// has no folder), the path before its name `restore` bytes long. The trees it holds count in
    /// what the walk keeps until the walk leaves the folder ([`Kept::leave`]), each as soon as it is
    /// read: a chain of large trees ends the walk at the bytes of its budget, not at the end of the
    /// chain.
    fn enter(
        &mut self,
        parent: Option<ObjectId>,
        tree: Option<ObjectId>,
        restore: usize,
    ) -> Result<Frame, StoreError> {
        let (parent, parent_held) = self.tree(parent)?;
        let (tree, tree_held) = self.tree(tree)?;
        Ok(Frame {
            parent,
            tree,
            next_parent: 0,
            next_tree: 0,
            restore,
            held: parent_held + tree_held,
        })
    }

    /// Leaves the folder of `frame`: its trees no longer count, unless the walk keeps them.
    fn leave(&mut self, frame: Frame) {
        self.bytes = self.bytes.saturating_sub(frame.held);
    }

    /// The tree `id`, when a side has a folder there, and the bytes it counts in what the walk
    /// keeps while the walk holds it in a frame: a tree read for the first time counts until the
    /// walk leaves its folder, and its id for the rest of the walk ([`TREE_ID_BYTES`]). A tree met
    /// for the second time is read again and kept, counted for the rest of the walk (so it adds
    /// nothing to the frame's): folders that repeat each other's trees cost a read or two of each
    /// distinct tree, not one of each folder (the store reads and checks a pack record for every
    /// tree it gives), and a walk that never meets a tree twice keeps only the trees of the folders
    /// it is in.
    fn tree(&mut self, id: Option<ObjectId>) -> Result<(Option<Arc<Tree>>, usize), StoreError> {
        let Some(id) = id else {
            return Ok((None, 0));
        };
        if let Some(Some(tree)) = self.trees.get(&id) {
            return Ok((Some(Arc::clone(tree)), 0));
        }
        let again = self.trees.contains_key(&id);
        let tree = read_tree(self.source, id)?;
        let size = kept_size(&tree);
        if again {
            self.add(size)?;
            self.trees.insert(id, Some(Arc::clone(&tree)));
            Ok((Some(tree), 0))
        } else {
            self.add(size.saturating_add(TREE_ID_BYTES))?;
            self.trees.insert(id, None);
            Ok((Some(tree), size))
        }
    }
}

/// The bytes a walk keeps for a tree it holds on to: the tree in its `Arc` (two counts beside
/// it), its list of entries at the room the list takes (a list read entry by entry may take up to
/// twice the room of its entries), and their names.
fn kept_size(tree: &Tree) -> usize {
    let names: usize = tree
        .entries()
        .iter()
        .map(|entry| entry.name().as_str().len())
        .sum();
    2 * size_of::<usize>() + size_of::<Tree>() + tree.entries_room() + names
}

/// Walks the paths below `prefix` (empty for a root) where the trees `parent` and `tree` differ,
/// and reports each path whose entries are not the same, with both (§8). Folders on both sides
/// with equal tree ids are skipped; a folder on one side only is walked whole.
///
/// Looks at no more than `budget` entries, and keeps no more than `budget` ×
/// [`PATH_BYTES_PER_ENTRY`] bytes: the paths it reports, a path counted once for each side that
/// has an entry there (what [`Differences`] keeps) with the map entry that keeps it
/// ([`MAP_ENTRY_BYTES`]), the trees of the folders it is in, the trees it meets again and the ids
/// of those it read ([`Kept`]), and its stack and path at their deepest and longest
/// ([`Kept::reach`]); beyond either it stops with [`StoreError::TooLarge`] about `subject`, before
/// the path is reported, the tree is held or the stack or path grows.
fn walk<S: TreeSource + ?Sized>(
    source: &S,
    parent: Option<ObjectId>,
    tree: Option<ObjectId>,
    prefix: &str,
    budget: usize,
    subject: ObjectId,
    mut report: impl FnMut(&str, Option<FlatEntry>, Option<FlatEntry>),
) -> Result<(), StoreError> {
    if parent == tree {
        return Ok(());
    }
    let mut kept = Kept::new(source, budget.saturating_mul(PATH_BYTES_PER_ENTRY), subject);
    let mut path = prefix.to_owned();
    let first = kept.enter(parent, tree, path.len())?;
    kept.reach(1, path.len())?;
    let mut stack = vec![first];
    let mut seen = 0_usize;
    loop {
        let depth = stack.len();
        let Some(frame) = stack.last_mut() else {
            break;
        };
        let Some((old, new)) = frame.next() else {
            path.truncate(frame.restore);
            if let Some(left) = stack.pop() {
                kept.leave(left);
            }
            continue;
        };
        seen += 1;
        if seen > budget {
            return Err(StoreError::TooLarge {
                what: Subject::Object(subject),
                limit: Limit::Paths(budget),
            });
        }
        let restore = path.len();
        let name = old.or(new).map_or("", |entry| entry.name().as_str());
        let separator = !path.is_empty();
        kept.reach(depth, restore + usize::from(separator) + name.len())?;
        if separator {
            path.push('/');
        }
        path.push_str(name);
        let (old_entry, new_entry) = (old.map(FlatEntry::from), new.map(FlatEntry::from));
        let (old_folder, new_folder) = (old.and_then(folder), new.and_then(folder));
        if old_entry != new_entry {
            let copies = usize::from(old_entry.is_some()) + usize::from(new_entry.is_some());
            kept.add(copies.saturating_mul(path.len().saturating_add(MAP_ENTRY_BYTES)))?;
            report(&path, old_entry, new_entry);
        }
        // Equal folders, or no folder at all: nothing below to walk.
        if old_folder == new_folder {
            path.truncate(restore);
        } else {
            let entered = kept.enter(old_folder, new_folder, restore)?;
            kept.reach(depth + 1, path.len())?;
            stack.push(entered);
        }
    }
    Ok(())
}

/// Every path of the tree `root` with its entry (remote-format.md §8). A tree that is absent is
/// [`StoreError::Missing`], the first in the walk's order; a tree of more than `budget` paths, or
/// whose paths in their map, the trees the walk holds and the rest it keeps take more than
/// `budget` × [`PATH_BYTES_PER_ENTRY`] bytes, is [`StoreError::TooLarge`].
pub fn flatten<S: TreeSource + ?Sized>(
    source: &S,
    root: ObjectId,
    budget: usize,
) -> Result<FlatTree, StoreError> {
    let mut flat = FlatTree::new();
    walk(
        source,
        None,
        Some(root),
        "",
        budget,
        root,
        |path, _, entry| {
            if let Some(entry) = entry {
                flat.insert(path.to_owned(), entry);
            }
        },
    )?;
    Ok(flat)
}

/// Where a commit's tree T differs from its parent's tree P (remote-format.md §8): the paths whose
/// entries are not the same on both sides.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Differences {
    /// The from-side paths: paths of P whose entry is not the same in T, with P's entries.
    pub from: FlatTree,
    /// The to-side paths: paths of T whose entry is not the same in P, with T's entries.
    pub to: FlatTree,
}

impl Differences {
    /// The differences between two flattened trees; for a first commit, P is empty.
    pub fn between(parent: &FlatTree, tree: &FlatTree) -> Self {
        let differing = |side: &FlatTree, other: &FlatTree| -> FlatTree {
            side.iter()
                .filter(|&(path, entry)| other.get(path) != Some(entry))
                .map(|(path, entry)| (path.clone(), *entry))
                .collect()
        };
        Self {
            from: differing(parent, tree),
            to: differing(tree, parent),
        }
    }

    /// The differences between the trees `parent` (`None` for a first commit) and `tree`, by
    /// walking both: folders whose tree ids are equal at the same path are skipped, so the walk
    /// reads only what changed. More than `budget` entries looked at, or more than `budget` ×
    /// [`PATH_BYTES_PER_ENTRY`] bytes in the paths of `from` and `to` with their map entries, the
    /// trees the walk holds and the rest it keeps, is [`StoreError::TooLarge`]. Those bytes leave
    /// room for [`Differences::check`]'s sets of the paths it covered.
    pub fn of_trees<S: TreeSource + ?Sized>(
        source: &S,
        parent: Option<ObjectId>,
        tree: ObjectId,
        budget: usize,
    ) -> Result<Self, StoreError> {
        let mut differences = Self::default();
        walk(
            source,
            parent,
            Some(tree),
            "",
            budget,
            tree,
            |path, old, new| {
                if let Some(old) = old {
                    differences.from.insert(path.to_owned(), old);
                }
                if let Some(new) = new {
                    differences.to.insert(path.to_owned(), new);
                }
            },
        )?;
        Ok(differences)
    }

    /// Whether the trees are the same.
    pub fn is_empty(&self) -> bool {
        self.from.is_empty() && self.to.is_empty()
    }

    /// Whether `changes` describes these differences (remote-format.md §8 rules 1–3, 6): every
    /// from-side and every to-side path is covered exactly once, by a record's side or by a
    /// folder move that carries it, and each record's kind, `old` and `new` are the entries it
    /// covers. A move whose old path holds the same entry again has no from side to cover, so it
    /// fails here: a writer records it as an addition (rule 6).
    ///
    /// Its sets of the paths covered are made at the size of each side, which a valid record list
    /// fills: grown by doubling, a set would hold its old table beside the new one while it moves.
    /// [`Differences::of_trees`] counts what they take with each path it keeps; the sets of the
    /// folders moved grow with the commit's own records.
    pub fn check(&self, changes: &Changes) -> Result<(), RuleViolation> {
        let mut from_seen = HashSet::with_capacity(self.from.len());
        let mut to_seen = HashSet::with_capacity(self.to.len());
        let mut moving = Moving::default();
        for record in changes.records() {
            if let Change::MoveDir { from, path } = record {
                moving.from.insert(from.as_str());
                moving.to.insert(path.as_str());
            }
        }
        for record in changes.records() {
            if let Some(path) = record.from_path() {
                let old = record.old_side();
                cover(
                    &self.from,
                    &mut from_seen,
                    path.as_str(),
                    record.kind(),
                    old,
                )?;
            }
            if let Some(path) = record.to_path() {
                let new = record.new_side();
                cover(&self.to, &mut to_seen, path.as_str(), record.kind(), new)?;
            }
            if let Change::MoveDir { from, path } = record {
                self.carry(
                    from.as_str(),
                    path.as_str(),
                    &moving,
                    &mut from_seen,
                    &mut to_seen,
                )?;
            }
        }
        for (side, seen) in [(&self.from, &from_seen), (&self.to, &to_seen)] {
            if seen.len() != side.len()
                && let Some(path) = side.keys().find(|path| !seen.contains(path.as_str()))
            {
                return Err(RuleViolation::NotCovered { path: shown(path) });
            }
        }
        Ok(())
    }

    /// Rule 3: the folder move from `from` to `to` covers each path `from/r` of P together with
    /// `to/r` of T when their entries are the same.
    ///
    /// The paths below `from` and those below `to` are walked side by side: within each folder
    /// they come in the order of what follows its path, so `from/r` meets `to/r` in one pass. No
    /// path `to/r` is built or looked up, which would cost every path below `from` the length of
    /// `to` again: up to 32,767 units, times every path the budget allows.
    ///
    /// What lies below another folder move nested in this one is passed over, on each side, so
    /// each path is looked at by the nearest folder move above it, and the moves of a commit look
    /// at each path once in all. This move could carry a path below such a folder only by
    /// carrying that folder too, `from/s` together with `to/s`, which the folder's own record
    /// then covers again: both are folders, so the same entry, and both changed (T has no folder
    /// `from` and P none `to`, as this record's own sides are changed folders). The folder itself
    /// is looked at here, so the commit is refused all the same.
    fn carry<'a>(
        &'a self,
        from: &str,
        to: &str,
        moving: &Moving<'_>,
        from_seen: &mut HashSet<&'a str>,
        to_seen: &mut HashSet<&'a str>,
    ) -> Result<(), RuleViolation> {
        let mut targets = Below::new(&self.to, to, &moving.to);
        let mut target = targets.next();
        for (path, entry) in Below::new(&self.from, from, &moving.from) {
            let rest = &path[from.len()..];
            while let Some((passed, _)) = target
                && passed[to.len()..] < *rest
            {
                target = targets.next();
            }
            // Nothing left below `to` carries anything.
            let Some((moved, carried)) = target else {
                break;
            };
            if moved[to.len()..] != *rest {
                continue;
            }
            if carried == entry {
                if !from_seen.insert(path.as_str()) {
                    return Err(RuleViolation::CoveredTwice { path: shown(path) });
                }
                if !to_seen.insert(moved.as_str()) {
                    return Err(RuleViolation::CoveredTwice { path: shown(moved) });
                }
            }
            target = targets.next();
        }
        Ok(())
    }

    /// The change records a reader finds when a commit leaves `changes` out (remote-format.md §8
    /// rule 7): no moves, a `delete` for each path only P has, an `add` for each path only T has,
    /// a `modify` for a file changed in place, and a `delete` and an `add` where a file and a
    /// folder trade places; in the order of rule 5. They may be more than a commit holds.
    ///
    /// A path longer than a path may be (in a tree that breaks §7.4 rule 5) is
    /// [`ValueError::PathTooLong`]. The list is made at the size it ends with.
    pub fn records(&self) -> Result<Vec<Change>, ValueError> {
        let count = self
            .paths()
            .map(|(_, old, new)| record_count(old, new))
            .sum();
        let mut records = Vec::with_capacity(count);
        for (path, old, new) in self.paths() {
            let path = TreePath::parse(path)?;
            let deleted = |path, old| match old {
                FlatEntry::Dir => Change::DeleteDir { path },
                FlatEntry::File(old) => Change::DeleteFile { path, old },
            };
            let added = |path, new| match new {
                FlatEntry::Dir => Change::AddDir { path },
                FlatEntry::File(new) => Change::AddFile { path, new },
            };
            match (old, new) {
                (Some(FlatEntry::File(old)), Some(FlatEntry::File(new))) => {
                    records.push(Change::ModifyFile { path, old, new });
                }
                (Some(old), Some(new)) => {
                    records.push(deleted(path.clone(), old));
                    records.push(added(path, new));
                }
                (Some(old), None) => records.push(deleted(path, old)),
                (None, Some(new)) => records.push(added(path, new)),
                (None, None) => {}
            }
        }
        Ok(records)
    }

    /// Each path of `from` or `to` in order, with its entry on each side that has it.
    fn paths(&self) -> impl Iterator<Item = (&str, Option<FlatEntry>, Option<FlatEntry>)> {
        let mut from = self.from.iter().peekable();
        let mut to = self.to.iter().peekable();
        std::iter::from_fn(move || {
            let order = match (from.peek(), to.peek()) {
                (None, None) => return None,
                (Some(_), None) => Ordering::Less,
                (None, Some(_)) => Ordering::Greater,
                (Some((old, _)), Some((new, _))) => old.cmp(new),
            };
            let old = if order == Ordering::Greater {
                None
            } else {
                from.next()
            };
            let new = if order == Ordering::Less {
                None
            } else {
                to.next()
            };
            let path = old.or(new).map_or("", |(path, _)| path.as_str());
            Some((
                path,
                old.map(|(_, entry)| *entry),
                new.map(|(_, entry)| *entry),
            ))
        })
    }

    /// The bytes a walk counted for these paths: each copy's bytes and the map entry that keeps it
    /// ([`MAP_ENTRY_BYTES`]).
    fn paths_size(&self) -> usize {
        self.from
            .keys()
            .chain(self.to.keys())
            .map(|path| path.len().saturating_add(MAP_ENTRY_BYTES))
            .fold(0, usize::saturating_add)
    }

    /// The bytes [`Differences::records`] takes: for each record a [`Change`], and its path's bytes.
    fn records_size(&self) -> usize {
        self.paths()
            .map(|(path, old, new)| {
                let record = size_of::<Change>().saturating_add(path.len());
                record_count(old, new).saturating_mul(record)
            })
            .fold(0, usize::saturating_add)
    }
}

/// The change records a path whose entries are `old` and `new` gets (remote-format.md §8 rule 7):
/// a `modify` for a file on both sides, a `delete` and an `add` where a file and a folder trade
/// places, one record for a path on one side only.
fn record_count(old: Option<FlatEntry>, new: Option<FlatEntry>) -> usize {
    match (old, new) {
        (Some(FlatEntry::File(_)), Some(FlatEntry::File(_))) => 1,
        (Some(_), Some(_)) => 2,
        (Some(_), None) | (None, Some(_)) => 1,
        (None, None) => 0,
    }
}

/// One record's side covering `path` of `side` (the from-side or the to-side paths): the path
/// changed on that side, is covered for the first time, and has the record's kind and file.
fn cover<'a>(
    side: &'a FlatTree,
    seen: &mut HashSet<&'a str>,
    path: &str,
    kind: EntryKind,
    file: Option<Side>,
) -> Result<(), RuleViolation> {
    let Some((path, entry)) = side.get_key_value(path) else {
        return Err(RuleViolation::NotChanged { path: shown(path) });
    };
    if !seen.insert(path.as_str()) {
        return Err(RuleViolation::CoveredTwice { path: shown(path) });
    }
    if entry.kind() != kind {
        return Err(RuleViolation::KindDiffers { path: shown(path) });
    }
    if entry.side() != file {
        return Err(RuleViolation::SideDiffers { path: shown(path) });
    }
    Ok(())
}

/// The folders a commit's records move ([`Change::MoveDir`]), by their path on each side.
#[derive(Debug, Default)]
struct Moving<'c> {
    from: HashSet<&'c str>,
    to: HashSet<&'c str>,
}

/// The paths of one side of [`Differences`] below a folder, in order, without what lies below the
/// folders of `nested` (the other folder moves on that side): such a folder is given, and what lies
/// below it is passed over with one seek when the walk reaches it.
struct Below<'a, 'n> {
    side: &'a FlatTree,
    /// Where the paths below the folder end: its path and `0`, which follows `/`.
    end: String,
    paths: btree_map::Range<'a, String, FlatEntry>,
    nested: &'n HashSet<&'n str>,
    /// The folders of `nested` given, as the bounds of what lies below each (`path/`, `path0`). A
    /// later one lies before what is below an earlier one, so the last is the next to meet.
    passing: Vec<(String, String)>,
}

impl<'a, 'n> Below<'a, 'n> {
    fn new(side: &'a FlatTree, folder: &str, nested: &'n HashSet<&'n str>) -> Self {
        // Built at their length at once: a folder's path may be 97 KB long.
        let end = [folder, "0"].concat();
        let start = [folder, "/"].concat();
        let paths = side.range::<str, _>((
            Bound::Included(start.as_str()),
            Bound::Excluded(end.as_str()),
        ));
        Self {
            side,
            end,
            paths,
            nested,
            passing: Vec::new(),
        }
    }

    /// Where the walk goes on when `path` lies below a nested folder given before: past what lies
    /// below that folder.
    fn past(&mut self, path: &str) -> Option<String> {
        while let Some((below, after)) = self.passing.last() {
            if path.starts_with(below.as_str()) {
                return self.passing.pop().map(|(_, after)| after);
            }
            if path < after.as_str() {
                return None;
            }
            self.passing.pop();
        }
        None
    }
}

impl<'a> Iterator for Below<'a, '_> {
    type Item = (&'a String, &'a FlatEntry);

    fn next(&mut self) -> Option<Self::Item> {
        loop {
            let (path, entry) = self.paths.next()?;
            if let Some(past) = self.past(path) {
                self.paths = self.side.range::<str, _>((
                    Bound::Included(past.as_str()),
                    Bound::Excluded(self.end.as_str()),
                ));
                continue;
            }
            if self.nested.contains(path.as_str()) {
                self.passing
                    .push(([path, "/"].concat(), [path, "0"].concat()));
            }
            return Some((path, entry));
        }
    }
}

/// The change records between the trees `parent` (`None` for a first commit) and `tree` as a
/// reader finds them when a commit leaves `changes` out (remote-format.md §8 rule 7): see
/// [`Differences::records`]. A walk beyond the path budget, as [`Differences::of_trees`] counts
/// it, is [`StoreError::TooLarge`], and so are records that do not fit beside the paths they are
/// made from in `budget` × [`PATH_BYTES_PER_ENTRY`] bytes (each a [`Change`] and its path's
/// bytes), before they are made; a path longer than a path may be makes the tree that holds it
/// [`StoreError::Invalid`].
pub fn diff_trees<S: TreeSource + ?Sized>(
    source: &S,
    parent: Option<ObjectId>,
    tree: ObjectId,
    budget: usize,
) -> Result<Vec<Change>, StoreError> {
    let differences = Differences::of_trees(source, parent, tree, budget)?;
    let limit = budget.saturating_mul(PATH_BYTES_PER_ENTRY);
    let held = differences
        .paths_size()
        .saturating_add(differences.records_size());
    if held > limit {
        return Err(StoreError::TooLarge {
            what: Subject::Object(tree),
            limit: Limit::PathBytes(limit),
        });
    }
    differences.records().map_err(|error| {
        let in_parent = differences
            .from
            .keys()
            .any(|path| utf16_len(path) > MAX_PATH_UNITS);
        let holder = match parent {
            Some(parent) if in_parent => parent,
            _ => tree,
        };
        StoreError::Invalid {
            what: Subject::Object(holder),
            problem: Problem::Value(error),
        }
    })
}

/// §7.4 on a flattened root tree: the root holds the folder `.folio` with `library.json`, nothing
/// else NTFS takes for `.folio`, nothing of Folio's private folders, only stored files under
/// `.folio/`, and no path longer than a path may be. A map with only some of the paths (the root's
/// entries and those under `.folio`) is checked on those: the length of the others is the caller's.
pub fn check_root(tree: &FlatTree) -> Result<(), RuleViolation> {
    for path in tree.keys() {
        if !path.contains('/') && path != FOLIO && same_ntfs_name(path, FOLIO) {
            return Err(RuleViolation::FolioName { name: shown(path) });
        }
        let units = utf16_len(path);
        if units > MAX_PATH_UNITS {
            return Err(RuleViolation::PathTooLong { units });
        }
    }
    if tree.get(FOLIO) != Some(&FlatEntry::Dir)
        || !matches!(tree.get(LIBRARY_FILE), Some(FlatEntry::File(_)))
    {
        return Err(RuleViolation::FolioMissing);
    }
    let below = (Bound::Included(".folio/"), Bound::Excluded(".folio0"));
    for (path, entry) in tree.range::<str, _>(below) {
        let mut names = path[FOLIO.len() + 1..].split('/');
        let first = names.next().unwrap_or_default();
        let depth = 1 + names.count();
        if depth == 1 && (same_ntfs_name(first, "local") || same_ntfs_name(first, "store")) {
            return Err(RuleViolation::FolioPrivate { name: shown(first) });
        }
        // Files anywhere the layout allows; the only folders are `meta` and the folders in it.
        let misplaced = match entry {
            FlatEntry::Dir => first != "meta" || depth > 2,
            FlatEntry::File(_) => depth > 3,
        };
        if misplaced {
            return Err(RuleViolation::FolioPath { path: shown(path) });
        }
        if let FlatEntry::File(side) = entry
            && !side.stored
        {
            return Err(RuleViolation::FolioNotStored { path: shown(path) });
        }
    }
    Ok(())
}

/// A stored file of a tree reachable from `roots` whose hash `wanted` accepts, looking at each tree
/// once (`seen` holds the trees looked at already).
fn find_stored<S: TreeSource + ?Sized>(
    source: &S,
    roots: impl IntoIterator<Item = ObjectId>,
    seen: &mut HashSet<ObjectId>,
    wanted: impl Fn(&ObjectId) -> bool,
) -> Result<Option<ObjectId>, StoreError> {
    let mut stack: Vec<ObjectId> = roots
        .into_iter()
        .filter(|&root| seen.insert(root))
        .collect();
    while let Some(id) = stack.pop() {
        for entry in read_tree(source, id)?.entries() {
            match *entry {
                TreeEntry::File {
                    hash, stored: true, ..
                } if wanted(&hash) => return Ok(Some(hash)),
                TreeEntry::Dir { tree, .. } if seen.insert(tree) => stack.push(tree),
                _ => {}
            }
        }
    }
    Ok(None)
}

/// Whether the absent blob of a stored file entry is *pruned* or *missing* (remote-format.md
/// §7.5), as the error to report: [`StoreError::Pruned`] when a prune commit after the entry's
/// commit lists it (the version shows without a diff or a restore), else [`StoreError::Missing`]
/// (pending on the remote, damage in the local store). `chain` is the history, oldest first, up to
/// the head; `index` is the commit whose tree holds the entry.
pub fn absent_blob<C: Borrow<Commit>>(chain: &[C], index: usize, blob: ObjectId) -> StoreError {
    let thinned_later = chain.iter().skip(index.saturating_add(1)).any(|commit| {
        commit
            .borrow()
            .pruned()
            .is_some_and(|pruned| pruned.contains(&blob))
    });
    if thinned_later {
        StoreError::Pruned(blob)
    } else {
        StoreError::Missing(blob)
    }
}

/// Whether a store may delete `blob` (remote-format.md §7.5): a prune commit of `chain` (the
/// history, oldest first, up to the head) lists it, and no commit from the last such prune commit
/// on stores it, so every commit that stores it is followed by one that lists it. Reads the trees of
/// the commits from that prune commit on.
pub fn may_delete<S: TreeSource + ?Sized, C: Borrow<Commit>>(
    source: &S,
    chain: &[C],
    blob: ObjectId,
) -> Result<bool, StoreError> {
    let lists = |commit: &C| {
        commit
            .borrow()
            .pruned()
            .is_some_and(|pruned| pruned.contains(&blob))
    };
    let Some(last) = chain.iter().rposition(lists) else {
        return Ok(false);
    };
    let roots = chain[last..].iter().map(|commit| commit.borrow().tree);
    let stored = find_stored(source, roots, &mut HashSet::new(), |hash| *hash == blob)?;
    Ok(stored.is_none())
}

/// A tree whose subtrees the check of presence is walking: its longest file or empty-folder name,
/// and each folder's name length with its tree.
struct Open {
    id: ObjectId,
    names: usize,
    folders: Vec<(usize, ObjectId)>,
}

/// A step of the check of presence: a tree to enter, or one to leave once its subtrees are done.
enum Step {
    Enter(ObjectId),
    Leave(Open),
}

/// What the check of presence counts for each folder of a tree it is in: its place in the tree's
/// list of folders, made at its size.
const FOLDER_BYTES: usize = size_of::<(usize, ObjectId)>();

/// What the check of presence counts for each step its stack holds beyond any number before: three
/// steps' room, as for a walk's frames ([`FRAME_BYTES`]).
const STEP_BYTES: usize = 3 * size_of::<Step>();

/// What the check of presence counts for each tree its set of open trees holds beyond any number
/// before: a slot of a hash table that grows by doubling, as for a walk's tree ids
/// ([`TREE_ID_BYTES`]; at most about 113 bytes an id while it moves).
const OPEN_BYTES: usize = 4 * size_of::<ObjectId>();

/// What the check of presence holds, against its limit: the folders of the trees it is in while it
/// is in them, and the room its stack of steps and its set of open trees took at their largest,
/// which they keep.
struct Presence {
    bytes: usize,
    limit: usize,
    tallest: usize,
    widest: usize,
}

impl Presence {
    /// Counts the folders of a tree entered, `folders`, and a stack of `steps` steps and a set of
    /// `open` trees where either is larger than it has been before.
    fn grow(&mut self, folders: usize, steps: usize, open: usize) {
        let more_steps = steps.saturating_sub(self.tallest);
        let more_open = open.saturating_sub(self.widest);
        self.tallest = self.tallest.max(steps);
        self.widest = self.widest.max(open);
        self.bytes = self
            .bytes
            .saturating_add(folders.saturating_mul(FOLDER_BYTES))
            .saturating_add(more_steps.saturating_mul(STEP_BYTES))
            .saturating_add(more_open.saturating_mul(OPEN_BYTES));
    }
}

/// Checks commits against their trees and parents, as a reader does when it first reads a commit
/// (remote-format.md §11, "a commit in its history").
///
/// It remembers the trees it found complete (present with every subtree), with the longest path
/// below each, and the roots that passed §7.4, so that a history checked from its first commit on
/// reads each tree about once for these. Change records are checked by walking only the folders
/// that changed ([`Differences::of_trees`]), within the path budget. What it remembers grows with
/// the distinct trees it checked (about a hundred bytes a tree), as the store's packs grow with
/// them, and lasts as long as the checker; what each check holds beside that stays within the
/// budget's bytes ([`HistoryChecker::with_budget`]).
#[derive(Debug)]
pub struct HistoryChecker<S> {
    source: S,
    budget: usize,
    /// Complete trees, with the longest path below each in UTF-16 code units (0 for an empty one).
    complete: HashMap<ObjectId, usize>,
    /// Root trees that follow §7.4.
    roots: HashSet<ObjectId>,
}

impl<S: TreeSource> HistoryChecker<S> {
    /// A checker reading trees from `source`, with the [`DEFAULT_PATH_BUDGET`].
    pub fn new(source: S) -> Self {
        Self::with_budget(source, DEFAULT_PATH_BUDGET)
    }

    /// A checker whose walks look at no more than `budget` entries and keep no more than `budget`
    /// × [`PATH_BYTES_PER_ENTRY`] bytes: the paths they list with their map entries, the sets a
    /// check of change records makes of them, the trees they hold and the rest they keep (the
    /// module's docs say what), beside the one tree being read. Its check of presence and path
    /// lengths holds no more than those bytes ([`HistoryChecker::longest_path`]).
    pub fn with_budget(source: S, budget: usize) -> Self {
        Self {
            source,
            budget,
            complete: HashMap::new(),
            roots: HashSet::new(),
        }
    }

    pub fn source(&self) -> &S {
        &self.source
    }

    /// Checks the commit `id` against its trees and its parent, the commit it names (`None` for a
    /// first commit, whose `parent` is ignored), in the order of generate.mjs: its tree, its
    /// subtrees and its parent's are present ([`StoreError::Missing`] names the first absent, or the
    /// parent when it is not given); its root follows §7.4; a prune commit keeps its parent's tree
    /// and thins out no current version (§7.5); a `commit` or `import` changes its tree (§7.3); its
    /// change records follow §8. A broken rule is [`StoreError::Invalid`] about the commit, with a
    /// [`RuleViolation`]; a walk beyond the path budget is [`StoreError::TooLarge`].
    pub fn check_commit(
        &mut self,
        id: ObjectId,
        commit: &Commit,
        parent: Option<&Commit>,
    ) -> Result<(), StoreError> {
        let parent = match (commit.parent(), parent) {
            (Some(named), None) => return Err(StoreError::Missing(named)),
            (Some(_), parent) => parent,
            (None, _) => None,
        };
        let invalid = |problem| StoreError::Invalid {
            what: Subject::Object(id),
            problem: Problem::Rule(problem),
        };
        let longest = self.longest_path(commit.tree)?;
        if let Some(parent) = parent {
            self.longest_path(parent.tree)?;
        }
        self.root_rules(commit.tree, longest)
            .map_err(|error| match error {
                Checked::Broken(problem) => invalid(problem),
                Checked::Store(error) => error,
            })?;
        if let CommitKind::Prune { pruned, .. } = &commit.kind {
            // A prune commit always names its parent, so `parent` is there.
            if parent.map(|parent| parent.tree) != Some(commit.tree) {
                return Err(invalid(RuleViolation::PruneTree));
            }
            let listed = |hash: &ObjectId| pruned.contains(hash);
            let mut seen = HashSet::new();
            if let Some(blob) = find_stored(&self.source, [commit.tree], &mut seen, listed)? {
                return Err(invalid(RuleViolation::PruneCurrent { blob }));
            }
            return Ok(());
        }
        if parent.is_some_and(|parent| parent.tree == commit.tree) {
            return Err(invalid(RuleViolation::EmptyCommit));
        }
        if let Some(changes) = commit
            .message()
            .and_then(|message| message.changes.as_ref())
        {
            let parent_tree = parent.map(|parent| parent.tree);
            Differences::of_trees(&self.source, parent_tree, commit.tree, self.budget)?
                .check(changes)
                .map_err(invalid)?;
        }
        Ok(())
    }

    /// The longest path below the tree `id`, in UTF-16 code units (0 for an empty tree), after
    /// making sure the tree and every tree below it are present: [`StoreError::Missing`] names the
    /// first absent. Each tree is read once, by an iterative walk that remembers what it finished.
    ///
    /// What the walk holds stays within the budget's bytes ([`HistoryChecker::with_budget`]): the
    /// folders of the trees it is in, in lists made at their size, and at their largest, as they
    /// keep the room they took, its stack of the trees it has still to enter and its set of the
    /// trees it is in, each with the slack of a list or table that grows by doubling. Beyond them it
    /// stops with [`StoreError::TooLarge`] about `id`: a chain of distinct trees that each list a
    /// great many folders would otherwise make it hold every list of the chain at once, and a chain
    /// of a great many distinct trees a stack and a set as long.
    pub fn longest_path(&mut self, id: ObjectId) -> Result<usize, StoreError> {
        if let Some(&longest) = self.complete.get(&id) {
            return Ok(longest);
        }
        let mut held = Presence {
            bytes: 0,
            limit: self.budget.saturating_mul(PATH_BYTES_PER_ENTRY),
            tallest: 0,
            widest: 0,
        };
        let mut open = HashSet::new();
        let mut stack = vec![Step::Enter(id)];
        held.grow(0, stack.len(), 0);
        while let Some(step) = stack.pop() {
            match step {
                Step::Enter(tree_id) => {
                    if self.complete.contains_key(&tree_id) {
                        continue;
                    }
                    // Everything above a tree's Leave on the stack lies below it, so meeting an
                    // open tree again means it holds itself.
                    if open.contains(&tree_id) {
                        return Err(StoreError::Invalid {
                            what: Subject::Object(tree_id),
                            problem: Problem::Rule(RuleViolation::TreeCycle { tree: tree_id }),
                        });
                    }
                    let tree = read_tree(&self.source, tree_id)?;
                    let folders = tree.entries().iter().filter_map(folder);
                    let count = folders.clone().count();
                    let pending = folders
                        .filter(|child| !self.complete.contains_key(child))
                        .count();
                    // Its folders, its Leave and the subtrees to enter on the stack, itself among
                    // the open trees.
                    held.grow(count, stack.len() + 1 + pending, open.len() + 1);
                    if held.bytes > held.limit {
                        return Err(StoreError::TooLarge {
                            what: Subject::Object(id),
                            limit: Limit::PathBytes(held.limit),
                        });
                    }
                    open.insert(tree_id);
                    let mut entered = Open {
                        id: tree_id,
                        names: 0,
                        folders: Vec::with_capacity(count),
                    };
                    for entry in tree.entries() {
                        let units = utf16_len(entry.name().as_str());
                        match folder(entry) {
                            Some(child) => entered.folders.push((units, child)),
                            None => entered.names = entered.names.max(units),
                        }
                    }
                    // The subtrees above the Leave, in the order of the folders.
                    let below = stack.len();
                    stack.extend(
                        entered
                            .folders
                            .iter()
                            .map(|&(_, child)| child)
                            .filter(|child| !self.complete.contains_key(child))
                            .map(Step::Enter),
                    );
                    stack.push(Step::Leave(entered));
                    stack[below..].rotate_right(1);
                }
                Step::Leave(done) => {
                    held.bytes = held
                        .bytes
                        .saturating_sub(done.folders.len().saturating_mul(FOLDER_BYTES));
                    open.remove(&done.id);
                    let mut longest = done.names;
                    for (units, child) in done.folders {
                        // Every subtree was finished before this Leave came off the stack.
                        let below = self.complete.get(&child).copied().unwrap_or_default();
                        let through = if below == 0 {
                            units
                        } else {
                            units.saturating_add(1).saturating_add(below)
                        };
                        longest = longest.max(through);
                    }
                    self.complete.insert(done.id, longest);
                }
            }
        }
        Ok(self.complete.get(&id).copied().unwrap_or_default())
    }

    /// §7.4 for the root `id`, whose longest path is `longest`: its entries that NTFS takes for
    /// `.folio` and everything under `.folio` flattened (within the path budget), the other paths
    /// by their length. The root's other entries break no rule a flattened root is checked for
    /// (their paths are names, far shorter than a path may be), so they are not kept: a root of a
    /// great many entries costs no map of them.
    fn root_rules(&mut self, id: ObjectId, longest: usize) -> Result<(), Checked> {
        if self.roots.contains(&id) {
            return Ok(());
        }
        if longest > MAX_PATH_UNITS {
            return Err(Checked::Broken(RuleViolation::PathTooLong {
                units: longest,
            }));
        }
        let root = read_tree(&self.source, id)?;
        let mut flat = FlatTree::new();
        for entry in root.entries() {
            if !same_ntfs_name(entry.name().as_str(), FOLIO) {
                continue;
            }
            flat.insert(entry.name().to_string(), FlatEntry::from(entry));
            if let Some(folio) = folder(entry).filter(|_| entry.name().as_str() == FOLIO) {
                walk(
                    &self.source,
                    None,
                    Some(folio),
                    FOLIO,
                    self.budget,
                    id,
                    |path, _, entry| {
                        if let Some(entry) = entry {
                            flat.insert(path.to_owned(), entry);
                        }
                    },
                )?;
            }
        }
        check_root(&flat).map_err(Checked::Broken)?;
        self.roots.insert(id);
        Ok(())
    }
}

/// What a check of rules that reads trees ends with when it does not pass.
enum Checked {
    Broken(RuleViolation),
    Store(StoreError),
}

impl From<StoreError> for Checked {
    fn from(error: StoreError) -> Self {
        Self::Store(error)
    }
}

#[cfg(test)]
mod tests;
