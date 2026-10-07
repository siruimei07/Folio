//! Bound items (versioning.md §6.3): changes that cannot be committed without each other, grouped
//! into one row so that no selection builds an invalid tree or drops a file.
//!
//! Places are named in *frame* terms, independent of the selection: a folder of the commit's tree
//! is `HEAD`'s folder (by its path in `HEAD`) wherever the selection puts it, or a new folder of
//! the disk (by its path on the disk); a place is a folder and a name, compared as NTFS compares
//! names ([`RelPath::name_key`]). A row of `HEAD` is at its place in its parent's frame; an entry
//! of the disk is at its place in the frame of its parent folder, which is `HEAD`'s folder that
//! folder is paired with, or a new folder.
//!
//! The rules, as built:
//!
//! 1. A change that **writes** a place, or a new folder above it, that another change **frees**
//!    is bound to it. Deletions and moves free their row's place; additions and moves write their
//!    entry's place and the place of every new folder above it, up to the first folder that is
//!    `HEAD`'s. A row in place below a folder that left ([`Pinned`]) is a move no item shows,
//!    made when the change that decides where that folder goes (its *leaver*) is committed: the
//!    leaver frees the row's place in the folder's frame and writes its place on the disk. This
//!    binds a file replaced by a moved file, a swap of two names, a file replaced by a folder
//!    (with every addition into the new folder) and back, an addition where a held-back rename
//!    inside a moved folder leaves the old name, and a deletion and an addition whose names differ
//!    only in case (a case-only rename the disk reported without file ids).
//! 2. A folder deletion is bound to every move that takes something out of it.
//! 3. A folder move that would put the folder inside itself under some selection is bound to the
//!    change that decides where its destination folder goes. A folder moved into a folder `Z`
//!    depends on where `Z` goes; `Z`, when the change that decides its place (its move, the move
//!    it goes with, or a pinned folder's leaver) is held back, follows its parent in `HEAD`, up to
//!    the root. A cycle of such dependencies needs each of its moves to be committed with its
//!    destination's deciding change (else the folders would hold each other), so every folder
//!    move on a possible cycle (a strongly connected part of the graph of moves and the changes
//!    above their destinations) is bound to its destination's deciding change, and the
//!    dependencies then follow the disk, which has no cycle. A pinned folder counts as a move of
//!    its leaver.
//!
//! 4. A change of the versioning rules (§6.3's third case, §5.2) is bound to every change that,
//!    held back, keeps a file of `HEAD`'s whose content is no longer on the disk (a modification,
//!    an edited move, a deletion, or the folder deletion that covers it) when the disk's rules
//!    store that file and `HEAD`'s did not: the commit records the new rules, so it would need the
//!    file's blob, which neither `HEAD` nor the disk has. The rules change is metadata, which
//!    every commit records, so the change's item is **required** ([`required`]) and the shell
//!    shows the part `versioningRules`. A held-back move without an edit is not bound: the commit
//!    reads the same content from the file's new path.
//!
//! Groups are found with a union-find; a group's **main** change is its first writer (a move, an
//! addition or a modification) by path, else its first change by path, and the others are its
//! parts.

use std::collections::{HashMap, HashSet};

use super::changes::{Change, Compared, DiskFolder, Fate, Frame};
use crate::meta::EntryKind;
use crate::paths::{PathKey, RelPath};
use crate::store::ChangeOp;

/// A folder of the commit's tree, named independently of the selection.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
enum Folder {
    Root,
    /// `HEAD`'s folder at this path in `HEAD`.
    Head(RelPath),
    /// A new folder of the disk at this path on the disk.
    New(RelPath),
}

/// A name in a folder, compared as NTFS compares names.
type Place = (Folder, PathKey);

/// Who frees and who writes a place.
#[derive(Debug, Default)]
struct Uses {
    freers: Vec<usize>,
    writers: Vec<usize>,
    /// New folders at this place: every change below them writes it too.
    folders: Vec<RelPath>,
}

/// The changes of `compared` grouped into items: each group's main change first, then its parts
/// by path and key.
pub(super) fn groups(compared: &Compared) -> Vec<Vec<usize>> {
    let changes = &compared.changes;
    let mut sets = UnionFind::new(changes.len());
    let mut places = Places::new(compared);
    for (index, change) in changes.iter().enumerate() {
        match change.op() {
            ChangeOp::Delete => places.frees(index, change_head_path(change)),
            ChangeOp::Move => {
                places.frees(index, change_head_path(change));
                places.writes(index, change_disk_path(change));
            }
            ChangeOp::Add => places.writes(index, change_disk_path(change)),
            ChangeOp::Modify => {}
        }
    }
    for pinned in &compared.pinned {
        places.frees(pinned.leaver, &pinned.path);
        places.writes(pinned.leaver, &pinned.path);
    }
    for (path, folder) in &compared.folders {
        if *folder == DiskFolder::New {
            places.new_folder(path);
        }
    }
    places.bind(&mut sets);
    for &(escape, root) in &compared.escapes {
        sets.union(escape, root);
    }
    for (moved, decider) in cycles(compared) {
        sets.union(moved, decider);
    }

    let mut groups: HashMap<usize, Vec<usize>> = HashMap::new();
    for index in 0..changes.len() {
        groups.entry(sets.find(index)).or_default().push(index);
    }
    groups
        .into_values()
        .map(|mut group| {
            let by_path = |&a: &usize, &b: &usize| {
                let (a, b) = (&changes[a], &changes[b]);
                (a.path(), a.key()).cmp(&(b.path(), b.key()))
            };
            group.sort_unstable_by(by_path);
            let main = group
                .iter()
                .position(|&index| changes[index].op() != ChangeOp::Delete)
                .unwrap_or(0);
            group[..=main].rotate_right(1);
            group
        })
        .collect()
}

/// Rule 4: whether each group is bound to the change of the versioning rules, which every
/// commit records, so that every selection includes it.
pub(super) fn required(groups: &[Vec<usize>], compared: &Compared) -> Vec<bool> {
    let bound: HashSet<usize> = compared.rules_bound.iter().copied().collect();
    groups
        .iter()
        .map(|group| group.iter().any(|index| bound.contains(index)))
        .collect()
}

/// The path of the row a deletion or a move changes.
fn change_head_path(change: &Change) -> &RelPath {
    change.head().map_or(change.path(), |row| &row.path)
}

/// The path of the entry an addition or a move writes.
fn change_disk_path(change: &Change) -> &RelPath {
    change.disk().map_or(change.path(), |entry| &entry.path)
}

/// The places changes free and write (rule 1).
struct Places<'a> {
    folders: &'a HashMap<RelPath, DiskFolder>,
    uses: HashMap<Place, Uses>,
    /// The changes that write directly into each new folder, and the new folders directly in it.
    below: HashMap<RelPath, (Vec<usize>, Vec<RelPath>)>,
}

impl<'a> Places<'a> {
    fn new(compared: &'a Compared) -> Self {
        Self {
            folders: &compared.folders,
            uses: HashMap::new(),
            below: HashMap::new(),
        }
    }

    /// The folder of the commit's tree that the disk's folder at `path` is (`None`: the root).
    fn disk_folder(&self, path: Option<RelPath>) -> Folder {
        let Some(path) = path else {
            return Folder::Root;
        };
        match self.folders.get(&path) {
            Some(DiskFolder::Paired(head)) => Folder::Head(head.clone()),
            Some(DiskFolder::New) => Folder::New(path),
            // Not passed: paired with the row at its own path.
            None => Folder::Head(path),
        }
    }

    /// `HEAD`'s row at `path` leaves its place when `change` is committed.
    fn frees(&mut self, change: usize, path: &RelPath) {
        let folder = path.parent().map_or(Folder::Root, Folder::Head);
        self.uses
            .entry((folder, path.name_key()))
            .or_default()
            .freers
            .push(change);
    }

    /// The disk's entry at `path` comes to its place when `change` is committed.
    fn writes(&mut self, change: usize, path: &RelPath) {
        let folder = self.disk_folder(path.parent());
        if let Folder::New(parent) = &folder {
            self.below.entry(parent.clone()).or_default().0.push(change);
        }
        self.uses
            .entry((folder, path.name_key()))
            .or_default()
            .writers
            .push(change);
    }

    /// The disk's new folder at `path`, which every change below it brings.
    fn new_folder(&mut self, path: &RelPath) {
        let folder = self.disk_folder(path.parent());
        if let Folder::New(parent) = &folder {
            self.below
                .entry(parent.clone())
                .or_default()
                .1
                .push(path.clone());
        }
        self.uses
            .entry((folder, path.name_key()))
            .or_default()
            .folders
            .push(path.clone());
    }

    /// Binds the writers of each freed place to its freers.
    fn bind(self, sets: &mut UnionFind) {
        for uses in self.uses.values() {
            let Some((&first, others)) = uses.freers.split_first() else {
                continue;
            };
            if uses.writers.is_empty() && uses.folders.is_empty() {
                continue;
            }
            for &other in others.iter().chain(&uses.writers) {
                sets.union(first, other);
            }
            for folder in &uses.folders {
                let mut stack = vec![folder];
                while let Some(folder) = stack.pop() {
                    if let Some((changes, folders)) = self.below.get(folder) {
                        for &change in changes {
                            sets.union(first, change);
                        }
                        stack.extend(folders);
                    }
                }
            }
        }
    }
}

/// Rule 3: each folder move on a possible cycle, with the change that decides where its
/// destination folder goes. A folder in place below a folder that left ([`Pinned`]) moves with
/// its leaver, so it counts as a move of that change.
///
/// A move depends on every change met on the way up from its destination: `HEAD`'s folders, each
/// followed by the folder its frame follows, and the changes that decide where they go
/// ([`Walks`]). The way up from a folder is the same for every move that meets it, so each folder
/// is a node of the graph, met once, with an edge to its decider and one to the next folder up;
/// each move has an edge to its destination's node. The changes on a cycle of that graph are those
/// on a cycle of the moves' dependencies, and the work follows the bytes of the folders met, not
/// the moves times the depth.
fn cycles(compared: &Compared) -> Vec<(usize, usize)> {
    let changes = &compared.changes;
    // Each folder that moves when a change is committed: that change.
    let moves = changes
        .iter()
        .enumerate()
        .filter(|(_, change)| change.op() == ChangeOp::Move && change.kind() == EntryKind::Folder)
        .map(|(index, change)| (index, change_disk_path(change)));
    let pinned = compared
        .pinned
        .iter()
        .filter(|pinned| pinned.folder)
        .map(|pinned| (pinned.leaver, &pinned.path));
    let mut walks = Walks::new(compared);
    // Each move with the nearest change that may decide where its destination goes.
    let mut sources: Vec<(usize, usize)> = Vec::new();
    for (change, path) in moves.chain(pinned) {
        let Some(node) = walks.destination(path) else {
            continue;
        };
        if let Some(nearest) = walks.nearest(node) {
            walks.edge(change, node);
            sources.push((change, nearest));
        }
    }
    let cyclic = on_cycles(&walks.edges, walks.len());
    let mut bound: Vec<(usize, usize)> = sources
        .into_iter()
        .filter(|&(change, _)| cyclic[change])
        .collect();
    bound.sort_unstable();
    bound
}

#[cfg(test)]
thread_local! {
    /// The folders the ways up of rule 3 stepped through on this thread, new and known: a test
    /// checks that each is met once, however many moves pass it.
    pub(super) static WALKED: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

/// Counts a step of a way up (`WALKED`); nothing outside tests.
#[inline]
fn walked() {
    #[cfg(test)]
    WALKED.set(WALKED.get() + 1);
}

/// The ways up from the moves' destinations (rule 3), as a graph whose first nodes are the
/// changes and whose other nodes are `HEAD`'s folders met on the way.
struct Walks<'a> {
    compared: &'a Compared,
    /// `HEAD`'s folders met, by their paths in `HEAD`, with their nodes.
    heads: HashMap<RelPath, usize>,
    /// The disk's new folders met, with the node of the first of `HEAD`'s folders above them
    /// (`None`: the root).
    news: HashMap<RelPath, Option<usize>>,
    /// The nearest change that decides where each folder node goes, or one above it, by node less
    /// the count of changes.
    nearest: Vec<Option<usize>>,
    edges: HashMap<usize, Vec<usize>>,
}

impl<'a> Walks<'a> {
    fn new(compared: &'a Compared) -> Self {
        Self {
            compared,
            heads: HashMap::new(),
            news: HashMap::new(),
            nearest: Vec::new(),
            edges: HashMap::new(),
        }
    }

    /// How many nodes the graph has.
    fn len(&self) -> usize {
        self.compared.changes.len() + self.nearest.len()
    }

    fn edge(&mut self, from: usize, to: usize) {
        self.edges.entry(from).or_default().push(to);
    }

    /// The nearest decider at or above the folder `node`.
    fn nearest(&self, node: usize) -> Option<usize> {
        self.nearest[node - self.compared.changes.len()]
    }

    /// The node of the first folder above the disk's entry at `path` that is `HEAD`'s (`None`:
    /// the root).
    fn destination(&mut self, path: &RelPath) -> Option<usize> {
        // The new folders on the way, nearest first, which all lead where it ends.
        let mut met = Vec::new();
        let mut parent = path.parent();
        let found = loop {
            let Some(folder) = parent else {
                break None;
            };
            walked();
            if let Some(&known) = self.news.get(&folder) {
                break known;
            }
            match self.compared.folders.get(&folder) {
                Some(DiskFolder::Paired(head)) => break Some(self.head(head.clone())),
                Some(DiskFolder::New) => {
                    parent = folder.parent();
                    met.push(folder);
                }
                // Paired with the row at its own path.
                None => break Some(self.head(folder)),
            }
        };
        for folder in met {
            self.news.insert(folder, found);
        }
        found
    }

    /// The node of `HEAD`'s folder at `path`, with the nodes of the folders on its way up, each
    /// met once: a folder held back follows the folder its frame follows, whose decider is the
    /// next change met.
    fn head(&mut self, path: RelPath) -> usize {
        let changes = self.compared.changes.len();
        // The new nodes on the way, lowest first, and the known node it ends at.
        let mut met: Vec<usize> = Vec::new();
        let mut at = Some(path);
        let mut known = None;
        while let Some(path) = at {
            walked();
            if let Some(&node) = self.heads.get(&path) {
                known = Some(node);
                break;
            }
            let (decider, next) = self.step(&path);
            let node = changes + self.nearest.len();
            self.nearest.push(decider);
            if let Some(decider) = decider {
                self.edge(node, decider);
            }
            if let Some(&below) = met.last() {
                self.edge(below, node);
            }
            self.heads.insert(path, node);
            met.push(node);
            at = next;
        }
        if let (Some(&last), Some(known)) = (met.last(), known) {
            self.edge(last, known);
        }
        let mut nearest = known.and_then(|node| self.nearest(node));
        for &node in met.iter().rev() {
            let own = &mut self.nearest[node - changes];
            nearest = own.or(nearest);
            *own = nearest;
        }
        met.first().copied().or(known).expect("a folder")
    }

    /// The change that decides where `HEAD`'s folder at `path` goes, if one does, and the folder
    /// whose way it follows when that change is held back.
    fn step(&self, path: &RelPath) -> (Option<usize>, Option<RelPath>) {
        match self.compared.frames.get(path) {
            Some(Frame::Moved { carrier, .. }) => (
                Some(*carrier),
                change_head_path(&self.compared.changes[*carrier]).parent(),
            ),
            // A deleted folder held back follows its parent; so does a folder in place, which a
            // pinned folder above it can move.
            Some(Frame::Deleted { .. }) => (None, path.parent()),
            None => match self.compared.fates.get(path) {
                Some(&Fate::Pinned { leaver, .. }) => (Some(leaver), path.parent()),
                _ => (None, path.parent()),
            },
        }
    }
}

/// Which of `len` nodes are on a cycle of `edges` (Tarjan's strongly connected components,
/// without recursion: a chain of moves can be as long as a path is deep).
fn on_cycles(edges: &HashMap<usize, Vec<usize>>, len: usize) -> Vec<bool> {
    struct Tarjan {
        order: Vec<usize>,
        low: Vec<usize>,
        on_stack: Vec<bool>,
        stack: Vec<usize>,
        seen: usize,
    }
    impl Tarjan {
        fn visit(&mut self, node: usize) {
            self.order[node] = self.seen;
            self.low[node] = self.seen;
            self.seen += 1;
            self.on_stack[node] = true;
            self.stack.push(node);
        }
    }
    const UNSEEN: usize = usize::MAX;
    let mut t = Tarjan {
        order: vec![UNSEEN; len],
        low: vec![0; len],
        on_stack: vec![false; len],
        stack: Vec::new(),
        seen: 0,
    };
    let mut cyclic = vec![false; len];
    let no_edges: &[usize] = &[];
    let mut starts: Vec<usize> = edges.keys().copied().collect();
    starts.sort_unstable();
    for start in starts {
        if t.order[start] != UNSEEN {
            continue;
        }
        t.visit(start);
        // The nodes being visited, each with the position of its next edge.
        let mut calls = vec![(start, 0)];
        while let Some(&(node, next)) = calls.last() {
            let targets = edges.get(&node).map_or(no_edges, Vec::as_slice);
            if let Some(&target) = targets.get(next) {
                if let Some(call) = calls.last_mut() {
                    call.1 = next + 1;
                }
                if t.order[target] == UNSEEN {
                    t.visit(target);
                    calls.push((target, 0));
                } else if t.on_stack[target] {
                    t.low[node] = t.low[node].min(t.order[target]);
                }
                continue;
            }
            calls.pop();
            if let Some(&(caller, _)) = calls.last() {
                t.low[caller] = t.low[caller].min(t.low[node]);
            }
            if t.low[node] == t.order[node] {
                let mut members = Vec::new();
                while let Some(member) = t.stack.pop() {
                    t.on_stack[member] = false;
                    members.push(member);
                    if member == node {
                        break;
                    }
                }
                if members.len() > 1 || targets.contains(&node) {
                    for member in members {
                        cyclic[member] = true;
                    }
                }
            }
        }
    }
    cyclic
}

/// Disjoint sets of changes.
struct UnionFind {
    parent: Vec<usize>,
}

impl UnionFind {
    fn new(len: usize) -> Self {
        Self {
            parent: (0..len).collect(),
        }
    }

    fn find(&mut self, mut node: usize) -> usize {
        while self.parent[node] != node {
            self.parent[node] = self.parent[self.parent[node]];
            node = self.parent[node];
        }
        node
    }

    fn union(&mut self, a: usize, b: usize) {
        let (a, b) = (self.find(a), self.find(b));
        if a != b {
            self.parent[a.max(b)] = a.min(b);
        }
    }
}
