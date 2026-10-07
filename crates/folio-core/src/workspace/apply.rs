//! What a selection commits (versioning.md §7.1–§7.2, ipc-m2.md §5.1).
//!
//! [`Workspace::resolve`] checks a selection against the workspace the UI read, in the order of
//! ipc-m2.md §5.1, and gives the items it includes ([`Chosen`]). [`Workspace::apply`] gives the
//! commit's flattened tree for chosen items ([`Applied`]): every path, with where its content
//! comes from ([`Source`]).
//!
//! Places follow *folder frames* (lane decision 7, versioning.md §7.2's "where the commit holds it
//! now" extended to new paths). Every row of `HEAD` stays in its frame (below its parent folder,
//! wherever the commit puts that folder) unless the change that decides its own place is chosen:
//!
//! - A row whose own move is chosen goes to its entry's place, translated into the commit's tree:
//!   the entry's parent folder is wherever the commit puts that folder (`HEAD`'s folder it is
//!   paired with, wherever the selection puts that one; a new folder, below where its own parent
//!   goes). A chosen addition goes to its entry's place the same way.
//! - A row in place below a folder that left goes to its entry's place, its own path translated
//!   the same way, when the change that decides where that folder goes is chosen.
//! - A row whose deletion is chosen (its own, or the folder deletion that covers it) is gone.
//! - So a row with no change stays at its path unless a folder above it moves; a folder move
//!   held back keeps what is chosen inside it at the folder's committed place, and a chosen
//!   folder move takes along what moved with it, edited or not.
//! - Missing parent folders are created.
//!
//! The bound items (`bind`) are what keeps every chosen set's tree valid: no two entries at one
//! path, no entry below a file, no new names that NTFS takes for each other, no file dropped. A
//! tree that breaks the first two anyway is refused ([`ApplyError`]) rather than built; the
//! property test checks all of it.
//!
//! After the commit, its rows pair with the catalog's entries by their sources (versioning.md §7.5
//! step 6): see [`Source`].

use std::collections::{BTreeMap, HashMap, HashSet};

use super::changes::{DiskFolder, Fate};
use super::{Change, ChangeAt, DiskRow, HeadRow, Item, MAX_KEY_CHARS, Workspace};
use crate::library::operations::MAX_BATCH;
use crate::meta::EntryKind;
use crate::paths::{PathError, RelPath};
use crate::store::ChangeOp;

/// The items a command names (ipc-m2.md §5.1). Metadata changes are never named: every commit
/// records them.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Selection {
    /// Every includable item (ready or hashing) but these keys.
    AllExcept(Vec<String>),
    /// These items only.
    Only(Vec<String>),
}

impl Selection {
    pub fn keys(&self) -> &[String] {
        match self {
            Self::AllExcept(keys) | Self::Only(keys) => keys,
        }
    }

    /// The limits of ipc-m2.md §5.1, which hold before anything is read: at most `LIMITS.batch`
    /// keys, none longer than `LIMITS.keyChars` characters. [`Workspace::resolve`] checks them
    /// first too.
    pub fn check(&self) -> Result<(), SelectionError> {
        let keys = self.keys();
        if keys.len() > MAX_BATCH {
            return Err(SelectionError::InvalidArgument(
                "a selection names more keys than LIMITS.batch",
            ));
        }
        if keys
            .iter()
            .any(|key| key.len() > MAX_KEY_CHARS && key.chars().count() > MAX_KEY_CHARS)
        {
            return Err(SelectionError::InvalidArgument(
                "a key is longer than LIMITS.keyChars",
            ));
        }
        Ok(())
    }
}

/// Why a selection was refused, in the order ipc-m2.md §5.1 checks.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum SelectionError {
    /// Over `LIMITS.batch` keys or a key over `LIMITS.keyChars`, before anything is read; with
    /// the current fingerprint, a key that names no item: the UI made it up.
    #[error("{0}")]
    InvalidArgument(&'static str),
    /// The fingerprint is not the workspace's: it changed since the UI read it.
    #[error("the workspace changed since the UI read it")]
    WorkspaceChanged,
}

/// The items a selection includes, by their indices in the workspace it was resolved on.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Chosen {
    picked: Vec<bool>,
}

impl Chosen {
    /// Exactly the items `picked` says, by index; the UI's selections go through
    /// [`Workspace::resolve`].
    #[cfg(test)]
    pub(super) fn from_picked(picked: Vec<bool>) -> Self {
        Self { picked }
    }

    pub fn contains(&self, item: usize) -> bool {
        self.picked.get(item).copied().unwrap_or(false)
    }

    /// The indices of the chosen items, in order.
    pub fn indices(&self) -> impl Iterator<Item = usize> + '_ {
        self.picked
            .iter()
            .enumerate()
            .filter_map(|(index, &picked)| picked.then_some(index))
    }

    fn has(&self, change: ChangeAt) -> bool {
        self.contains(change.item)
    }
}

/// The commit's flattened tree: every path, in UTF-8 byte order, with where its content comes
/// from.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Applied {
    nodes: BTreeMap<RelPath, Source>,
}

impl Applied {
    pub fn nodes(&self) -> &BTreeMap<RelPath, Source> {
        &self.nodes
    }

    pub fn into_nodes(self) -> BTreeMap<RelPath, Source> {
        self.nodes
    }
}

/// Where a path of the commit's tree comes from, and how its row pairs after the commit
/// (versioning.md §7.5 step 6).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Source {
    /// `HEAD`'s row (at its path in `HEAD`), kept: `HEAD`'s content. Its row keeps its pairing.
    Head(HeadRow),
    /// The disk's entry: the commit reads the file, or takes the folder. Its row pairs with the
    /// entry (when the entry still exists as read; else by path).
    Disk(DiskRow),
    /// A folder no change writes, created as the parent of what the commit holds. Its row pairs
    /// by path.
    Created,
}

impl Source {
    pub fn kind(&self) -> EntryKind {
        match self {
            Self::Head(row) => row.kind(),
            Self::Disk(entry) => entry.kind,
            Self::Created => EntryKind::Folder,
        }
    }
}

/// A chosen set whose tree cannot be built: a bug in binding, never the user's doing, except
/// [`ApplyProblem::Path`] for a path that a folder frame makes too long.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("the commit's tree cannot hold {path:?}: {problem}")]
pub struct ApplyError {
    pub path: String,
    pub problem: ApplyProblem,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ApplyProblem {
    /// Two changes put something at the path.
    #[error("two changes put something there")]
    Taken,
    /// The path is below a file.
    #[error("it is below a file")]
    BelowFile,
    /// The path is not valid: longer than a path may be.
    #[error(transparent)]
    Path(#[from] PathError),
    /// Its folder has no place in the tree: it is gone, or the folders would hold each other.
    #[error("its folder has no place in the tree")]
    Unplaced,
}

impl ApplyError {
    fn at(path: impl ToString, problem: ApplyProblem) -> Self {
        Self {
            path: path.to_string(),
            problem,
        }
    }
}

impl Workspace {
    /// The items `selection` includes, checked as ipc-m2.md §5.1 says: the limits, then the
    /// fingerprint (`fingerprint` is the text the UI read), then the keys. `allExcept` includes
    /// every includable item it does not list, `only` the items it lists; both include every
    /// required item.
    pub fn resolve(
        &self,
        selection: &Selection,
        fingerprint: &str,
    ) -> Result<Chosen, SelectionError> {
        selection.check()?;
        let keys = selection.keys();
        if fingerprint != self.fingerprint.to_string() {
            return Err(SelectionError::WorkspaceChanged);
        }
        let listed: HashSet<&str> = keys.iter().map(String::as_str).collect();
        let all_except = matches!(selection, Selection::AllExcept(_));
        let mut named = 0;
        let picked = self
            .items
            .iter()
            .map(|item| {
                let is_listed = listed.contains(item.key());
                named += usize::from(is_listed);
                item.required
                    || if all_except {
                        item.is_includable() && !is_listed
                    } else {
                        is_listed
                    }
            })
            .collect();
        if named != listed.len() {
            return Err(SelectionError::InvalidArgument(
                "a key names no item of the workspace",
            ));
        }
        Ok(Chosen { picked })
    }

    /// The chosen items, in order.
    pub fn chosen_items<'a>(&'a self, chosen: &'a Chosen) -> impl Iterator<Item = &'a Item> + 'a {
        chosen.indices().filter_map(|index| self.items.get(index))
    }

    /// The commit's flattened tree for the chosen items, from `head`, every row of `HEAD`'s tree
    /// (`head_files`, `.folio/` included: it is kept as it is).
    pub fn apply(
        &self,
        head: impl IntoIterator<Item = HeadRow>,
        chosen: &Chosen,
    ) -> Result<Applied, ApplyError> {
        let mut placer = Placer {
            workspace: self,
            chosen,
            rows: HashMap::new(),
            folders: HashMap::new(),
        };
        let mut nodes = BTreeMap::new();
        for row in head {
            let Some(at) = placer.row(&row.path)? else {
                continue;
            };
            let source = match self.fates.get(&row.path) {
                Some(
                    &Fate::Moved(change)
                    | &Fate::Edited(change)
                    | &Fate::Carried { edit: Some(change) }
                    | &Fate::Pinned {
                        edit: Some(change), ..
                    },
                ) if chosen.has(change) => match self.change(change).and_then(Change::disk) {
                    Some(entry) => Source::Disk(entry.clone()),
                    None => return Err(ApplyError::at(&row.path, ApplyProblem::Unplaced)),
                },
                _ => Source::Head(row),
            };
            put(&mut nodes, at, source)?;
        }
        for item in self.chosen_items(chosen) {
            for change in item.changes() {
                if let (ChangeOp::Add, Some(entry)) = (change.op(), change.disk()) {
                    let at = placer.entry(&entry.path)?;
                    put(&mut nodes, at, Source::Disk(entry.clone()))?;
                }
            }
        }
        create_parents(&mut nodes)?;
        Ok(Applied { nodes })
    }
}

/// Adds `source` at `at`, which must be free.
fn put(
    nodes: &mut BTreeMap<RelPath, Source>,
    at: RelPath,
    source: Source,
) -> Result<(), ApplyError> {
    if nodes.contains_key(&at) {
        return Err(ApplyError::at(&at, ApplyProblem::Taken));
    }
    nodes.insert(at, source);
    Ok(())
}

/// Creates every missing parent folder; a parent that is a file is refused.
fn create_parents(nodes: &mut BTreeMap<RelPath, Source>) -> Result<(), ApplyError> {
    let paths: Vec<RelPath> = nodes.keys().cloned().collect();
    for path in paths {
        let mut next = path.parent();
        while let Some(parent) = next {
            match nodes.get(&parent) {
                Some(source) if source.kind() == EntryKind::Folder => break,
                Some(_) => return Err(ApplyError::at(&path, ApplyProblem::BelowFile)),
                None => {
                    next = parent.parent();
                    nodes.insert(parent, Source::Created);
                }
            }
        }
    }
    Ok(())
}

/// `path`'s name below `parent`.
fn child(parent: &RelPath, path: &RelPath) -> Result<RelPath, ApplyError> {
    if path.as_str().rsplit_once('/').map(|(parent, _)| parent) == Some(parent.as_str()) {
        return Ok(path.clone());
    }
    let shown = || format!("{parent}/{}", path.name());
    RelPath::parse(path.name())
        .and_then(|name| parent.join(&name))
        .map_err(|error| ApplyError::at(shown(), error.into()))
}

/// What a place depends on: `HEAD`'s row at a path, or the disk's new folder at a path.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
enum Node {
    Row(RelPath),
    NewFolder(RelPath),
}

/// Finds where things go in the commit's tree, remembering every place found. Places depend on
/// other places, as deep as paths go, so they are found with a stack rather than recursion.
struct Placer<'a> {
    workspace: &'a Workspace,
    chosen: &'a Chosen,
    /// Where `HEAD`'s rows go: `None` when the commit deletes them.
    rows: HashMap<RelPath, Option<RelPath>>,
    /// Where the disk's new folders go.
    folders: HashMap<RelPath, RelPath>,
}

/// One step of finding a place: found, or another place needed first.
enum Step {
    Found,
    Needs(Node),
}

impl Placer<'_> {
    /// Where `HEAD`'s row at `path` goes; `None` when the commit deletes it.
    fn row(&mut self, path: &RelPath) -> Result<Option<RelPath>, ApplyError> {
        if !self.rows.contains_key(path) {
            self.find(Node::Row(path.clone()))?;
        }
        Ok(self.rows.get(path).cloned().flatten())
    }

    /// Where the disk's entry at `path` goes.
    fn entry(&mut self, path: &RelPath) -> Result<RelPath, ApplyError> {
        loop {
            match self.entry_place(path)? {
                Ok(at) => return Ok(at),
                Err(needed) => self.find(needed)?,
            }
        }
    }

    /// Finds the place of `start` and of everything it depends on.
    fn find(&mut self, start: Node) -> Result<(), ApplyError> {
        let mut pending = HashSet::from([start.clone()]);
        let mut stack = vec![start];
        while let Some(node) = stack.last() {
            match self.step(node)? {
                Step::Found => {
                    if let Some(node) = stack.pop() {
                        pending.remove(&node);
                    }
                }
                Step::Needs(needed) => {
                    if !pending.insert(needed.clone()) {
                        let path = match needed {
                            Node::Row(path) | Node::NewFolder(path) => path,
                        };
                        return Err(ApplyError::at(path, ApplyProblem::Unplaced));
                    }
                    stack.push(needed);
                }
            }
        }
        Ok(())
    }

    /// Finds the place of `node` if what it depends on is found.
    fn step(&mut self, node: &Node) -> Result<Step, ApplyError> {
        match node {
            Node::Row(path) => {
                let place = match self.workspace.fates.get(path) {
                    Some(&Fate::Deleted(change)) if self.chosen.has(change) => None,
                    Some(&Fate::Moved(change)) if self.chosen.has(change) => {
                        let Some(entry) = self.workspace.change(change).and_then(Change::disk)
                        else {
                            return Err(ApplyError::at(path, ApplyProblem::Unplaced));
                        };
                        match self.entry_place(&entry.path)? {
                            Ok(at) => Some(at),
                            Err(needed) => return Ok(Step::Needs(needed)),
                        }
                    }
                    // Its entry is at its own path.
                    Some(&Fate::Pinned { leaver, .. }) if self.chosen.has(leaver) => {
                        match self.entry_place(path)? {
                            Ok(at) => Some(at),
                            Err(needed) => return Ok(Step::Needs(needed)),
                        }
                    }
                    // In its frame.
                    _ => match path.parent() {
                        None => Some(path.clone()),
                        Some(parent) => match self.rows.get(&parent) {
                            None => return Ok(Step::Needs(Node::Row(parent))),
                            Some(None) => return Err(ApplyError::at(path, ApplyProblem::Unplaced)),
                            Some(Some(at)) => Some(child(at, path)?),
                        },
                    },
                };
                self.rows.insert(path.clone(), place);
            }
            Node::NewFolder(path) => match self.entry_place(path)? {
                Ok(at) => {
                    self.folders.insert(path.clone(), at);
                }
                Err(needed) => return Ok(Step::Needs(needed)),
            },
        }
        Ok(Step::Found)
    }

    /// Where the disk's entry at `path` goes, once the place of its parent folder is found; else
    /// what that place needs first.
    fn entry_place(&self, path: &RelPath) -> Result<Result<RelPath, Node>, ApplyError> {
        let Some(parent) = path.parent() else {
            return Ok(Ok(path.clone()));
        };
        let head = match self.workspace.folders.get(&parent) {
            // Paired with the row at its own path.
            None => Some(&parent),
            Some(DiskFolder::Paired(head)) => Some(head),
            Some(DiskFolder::New) => None,
        };
        let folder = match head {
            Some(head) => match self.rows.get(head) {
                None => return Ok(Err(Node::Row(head.clone()))),
                Some(None) => return Err(ApplyError::at(path, ApplyProblem::Unplaced)),
                Some(Some(at)) => at.clone(),
            },
            None => match self.folders.get(&parent) {
                None => return Ok(Err(Node::NewFolder(parent.clone()))),
                Some(at) => at.clone(),
            },
        };
        child(&folder, path).map(Ok)
    }
}
