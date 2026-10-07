//! The property of bound items (versioning.md §6.3, §7.2): on random `HEAD` trees changed by
//! random disk changes, every chosen set of items builds a valid tree, committing sets one after
//! the other (each recomputed after the post-commit pairing) and then the rest gives the disk, and
//! committing everything at once gives the disk too.
//!
//! The model: the disk is a tree of entries with ids (file ids survive moves when an operation
//! keeps them); `HEAD` is a tree whose rows pair with entries by id, then by path (§6.1). The
//! comparison passes every row, as the loader may. After a commit the rows pair by their sources
//! (§7.5 step 6, [`Source`]), then by path. Names come from a small pool so that places collide
//! often; neither tree ever holds two names NTFS takes for each other, so neither may a commit's.

use std::collections::BTreeMap;

use proptest::prelude::*;

use super::*;
use crate::paths::PathKey;

const NAMES: &[&str] = &["a", "b", "c", "d"];

/// A file's content: bytes from a number, so that equal numbers are equal content.
fn content(number: u8) -> Vec<u8> {
    vec![number; 1 + usize::from(number % 3)]
}

/// An entry of the model's disk.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Entry {
    id: i64,
    /// `None` for a folder.
    content: Option<u8>,
}

/// The model's disk: entries by path.
#[derive(Debug, Clone, Default)]
struct Disk {
    entries: BTreeMap<String, Entry>,
    next: i64,
}

/// A change to the disk. Indices pick among what exists, so most operations do something.
#[derive(Debug, Clone)]
enum Op {
    /// Writes a file (keeps its id).
    Edit {
        target: usize,
        content: u8,
    },
    /// Moves a file or folder into a folder, under a name; without file ids everything moved
    /// is new to the catalog.
    Move {
        target: usize,
        into: usize,
        name: usize,
        ids: bool,
    },
    /// Changes the case of a name.
    Case {
        target: usize,
        ids: bool,
    },
    Delete {
        target: usize,
    },
    Create {
        into: usize,
        name: usize,
        folder: bool,
        content: u8,
    },
    /// Deletes an entry and creates another, of either kind, at its path.
    Replace {
        target: usize,
        folder: bool,
        content: u8,
    },
    /// Exchanges the paths of two entries, neither inside the other.
    Swap {
        a: usize,
        b: usize,
    },
    /// Deletes an entry and creates it again, empty if a folder: new ids at the same path.
    Recreate {
        target: usize,
    },
    /// Moves an entry out of its folder to the root, then deletes the folder.
    Escape {
        target: usize,
        name: usize,
    },
    /// Moves a folder's child folder to the root, then the folder into it: a folder inside its
    /// former child.
    Nest {
        target: usize,
        name: usize,
    },
    /// Takes a folder's child out, moves the folder away (or deletes it and moves another folder
    /// to its place), makes the folder again and puts the child back: the child is in place
    /// below a folder that left. `echo` puts a name where the child would meet it if the folder
    /// stayed.
    Return {
        target: usize,
        name: usize,
        delete: bool,
        echo: bool,
    },
}

fn parent_of(path: &str) -> Option<&str> {
    path.rsplit_once('/').map(|(parent, _)| parent)
}

fn name_of(path: &str) -> &str {
    path.rsplit_once('/').map_or(path, |(_, name)| name)
}

fn join(parent: Option<&str>, name: &str) -> String {
    match parent {
        Some(parent) => format!("{parent}/{name}"),
        None => name.to_owned(),
    }
}

fn is_within(path: &str, folder: &str) -> bool {
    path == folder
        || path
            .strip_prefix(folder)
            .is_some_and(|rest| rest.starts_with('/'))
}

impl Disk {
    fn fresh(&mut self) -> i64 {
        self.next += 1;
        self.next
    }

    /// A root name no entry has, to park an entry while others move.
    fn parking(&mut self) -> String {
        format!("~{}", self.fresh())
    }

    /// Every parent is a folder and no folder holds two names NTFS takes for each other.
    fn check(&self) -> Result<(), TestCaseError> {
        let mut names = HashSet::new();
        for path in self.entries.keys() {
            if let Some(parent) = parent_of(path) {
                let folder = self
                    .entries
                    .get(parent)
                    .map(|entry| entry.content.is_none());
                prop_assert_eq!(folder, Some(true), "the disk's parent of {}", path);
            }
            let name = (parent_of(path), name_of(path).to_ascii_lowercase());
            prop_assert!(names.insert(name), "the disk has twins at {}", path);
        }
        Ok(())
    }

    /// The entry picked by `index`, among all or among files only.
    fn pick(&self, index: usize, files_only: bool) -> Option<String> {
        let candidates: Vec<&String> = self
            .entries
            .iter()
            .filter(|(_, entry)| !files_only || entry.content.is_some())
            .map(|(path, _)| path)
            .collect();
        (!candidates.is_empty()).then(|| candidates[index % candidates.len()].clone())
    }

    /// A folder picked by `index`, the root among them (`None`).
    fn pick_folder(&self, index: usize) -> Option<String> {
        let folders: Vec<Option<&String>> = std::iter::once(None)
            .chain(
                self.entries
                    .iter()
                    .filter(|(_, entry)| entry.content.is_none())
                    .map(|(path, _)| Some(path)),
            )
            .collect();
        folders[index % folders.len()].cloned()
    }

    /// No entry in `folder` has a name NTFS takes for `name`, except `except`.
    fn free(&self, folder: Option<&str>, name: &str, except: Option<&str>) -> bool {
        !self.entries.keys().any(|path| {
            parent_of(path) == folder
                && Some(path.as_str()) != except
                && name_of(path).eq_ignore_ascii_case(name)
        })
    }

    fn subtree(&self, folder: &str) -> Vec<String> {
        self.entries
            .keys()
            .filter(|path| is_within(path, folder))
            .cloned()
            .collect()
    }

    fn remove(&mut self, folder: &str) -> Vec<(String, Entry)> {
        self.subtree(folder)
            .into_iter()
            .filter_map(|path| self.entries.remove(&path).map(|entry| (path, entry)))
            .collect()
    }

    /// Moves `from` and everything in it to `to`.
    fn relocate(&mut self, from: &str, to: &str, ids: bool) {
        for (path, mut entry) in self.remove(from) {
            if !ids {
                entry.id = self.fresh();
            }
            self.entries
                .insert(format!("{to}{}", &path[from.len()..]), entry);
        }
    }

    fn create(&mut self, path: String, content: Option<u8>) {
        let id = self.fresh();
        self.entries.insert(path, Entry { id, content });
    }

    fn apply(&mut self, op: &Op) {
        match *op {
            Op::Edit { target, content } => {
                if let Some(path) = self.pick(target, true)
                    && let Some(entry) = self.entries.get_mut(&path)
                {
                    entry.content = Some(content);
                }
            }
            Op::Move {
                target,
                into,
                name,
                ids,
            } => {
                let (Some(path), folder) = (self.pick(target, false), self.pick_folder(into))
                else {
                    return;
                };
                let name = NAMES[name % NAMES.len()];
                let inside = folder
                    .as_deref()
                    .is_some_and(|folder| is_within(folder, &path));
                if !inside && self.free(folder.as_deref(), name, None) {
                    self.relocate(&path, &join(folder.as_deref(), name), ids);
                }
            }
            Op::Case { target, ids } => {
                if let Some(path) = self.pick(target, false) {
                    let name = name_of(&path);
                    let toggled = if name.starts_with(|c: char| c.is_ascii_lowercase()) {
                        name.to_ascii_uppercase()
                    } else {
                        name.to_ascii_lowercase()
                    };
                    let to = join(parent_of(&path), &toggled);
                    self.relocate(&path, &to, ids);
                }
            }
            Op::Delete { target } => {
                if let Some(path) = self.pick(target, false) {
                    self.remove(&path);
                }
            }
            Op::Create {
                into,
                name,
                folder,
                content,
            } => {
                let parent = self.pick_folder(into);
                let name = NAMES[name % NAMES.len()];
                if self.free(parent.as_deref(), name, None) {
                    let path = join(parent.as_deref(), name);
                    self.create(path, (!folder).then_some(content));
                }
            }
            Op::Replace {
                target,
                folder,
                content,
            } => {
                if let Some(path) = self.pick(target, false) {
                    self.remove(&path);
                    self.create(path, (!folder).then_some(content));
                }
            }
            Op::Swap { a, b } => {
                let (Some(a), Some(b)) = (self.pick(a, false), self.pick(b, false)) else {
                    return;
                };
                if is_within(&a, &b) || is_within(&b, &a) {
                    return;
                }
                let parked = self.parking();
                self.relocate(&a, &parked, true);
                self.relocate(&b, &a, true);
                self.relocate(&parked, &b, true);
            }
            Op::Recreate { target } => {
                if let Some(path) = self.pick(target, false) {
                    let content = self.entries.get(&path).and_then(|entry| entry.content);
                    self.remove(&path);
                    self.create(path, content);
                }
            }
            Op::Escape { target, name } => {
                let Some(path) = self.pick(target, false) else {
                    return;
                };
                let Some(parent) = parent_of(&path).map(str::to_owned) else {
                    return;
                };
                let name = NAMES[name % NAMES.len()];
                if self.free(None, name, None) {
                    self.relocate(&path, name, true);
                    self.remove(&parent);
                }
            }
            Op::Nest { target, name } => {
                let Some((folder, child)) = self.folder_with_child(target, true) else {
                    return;
                };
                let name = NAMES[name % NAMES.len()];
                if !self.free(None, name, None) {
                    return;
                }
                self.relocate(&child, name, true);
                if self.free(Some(name), name_of(&folder), None) {
                    self.relocate(&folder, &join(Some(name), name_of(&folder)), true);
                }
            }
            Op::Return {
                target,
                name,
                delete,
                echo,
            } => {
                let Some((folder, child)) = self.folder_with_child(target, false) else {
                    return;
                };
                let child_name = name_of(&child).to_owned();
                let parked = self.parking();
                self.relocate(&child, &parked, true);
                // Where `echo` adds a file with the child's name: the place the child's old
                // folder now has, where it would meet the child if that folder stayed.
                let mut echo_at = None;
                if delete {
                    // Another folder takes the deleted one's place (a new folder there would
                    // pair with its row again, by path). `echo` deletes that folder's own file
                    // or folder of the child's name, which the child replaces.
                    self.remove(&folder);
                    let other = (1..=self.entries.len())
                        .filter_map(|offset| self.pick_folder(name + offset))
                        .find(|other| !is_within(other, &parked) && !is_within(&folder, other));
                    match other {
                        Some(other) => {
                            if echo {
                                let same = self.entries.keys().find(|path| {
                                    parent_of(path) == Some(other.as_str())
                                        && name_of(path).eq_ignore_ascii_case(&child_name)
                                });
                                if let Some(same) = same.cloned() {
                                    self.remove(&same);
                                }
                            }
                            self.relocate(&other, &folder, true);
                        }
                        None => self.create(folder.clone(), None),
                    }
                } else {
                    let name = NAMES[name % NAMES.len()];
                    let parent = parent_of(&folder);
                    if !self.free(parent, name, None) {
                        self.relocate(&parked, &child, true);
                        return;
                    }
                    let moved = join(parent, name);
                    self.relocate(&folder, &moved, true);
                    self.create(folder.clone(), None);
                    echo_at = echo.then(|| join(Some(moved.as_str()), &child_name));
                }
                if self.free(Some(&folder), &child_name, None) {
                    self.relocate(&parked, &child, true);
                }
                if let Some(path) = echo_at
                    && self.free(parent_of(&path), &child_name, None)
                {
                    self.create(path, Some(0));
                }
            }
        }
    }

    /// A folder picked by `index` among those with a child (a child folder when `folder`), and
    /// that child.
    fn folder_with_child(&self, index: usize, folder: bool) -> Option<(String, String)> {
        let pairs: Vec<(String, String)> = self
            .entries
            .iter()
            .filter(|(_, entry)| !folder || entry.content.is_none())
            .filter_map(|(path, _)| {
                let parent = parent_of(path)?;
                Some((parent.to_owned(), path.clone()))
            })
            .collect();
        (!pairs.is_empty()).then(|| pairs[index % pairs.len()].clone())
    }

    fn row(&self, path: &str) -> DiskRow {
        let entry = &self.entries[path];
        let at = super::path(path);
        let rules = VersioningRules::default();
        match entry.content {
            Some(number) => {
                let bytes = content(number);
                DiskRow {
                    entry: EntryId(entry.id),
                    class: rules.class_of(&at),
                    path: at,
                    kind: EntryKind::File,
                    size: bytes.len() as u64,
                    hash: Some(ContentHash::of(&bytes)),
                    blocked: None,
                    empty: false,
                }
            }
            None => {
                let below = format!("{path}/");
                DiskRow {
                    entry: EntryId(entry.id),
                    path: at,
                    kind: EntryKind::Folder,
                    class: FileClass::Other,
                    size: 0,
                    hash: None,
                    blocked: None,
                    empty: !self.entries.keys().any(|other| other.starts_with(&below)),
                }
            }
        }
    }

    /// The disk as a commit would hold it: each path's kind and content.
    fn tree(&self) -> BTreeMap<String, Option<(ContentHash, u64)>> {
        self.entries
            .keys()
            .map(|path| {
                let row = self.row(path);
                let file = row.hash.map(|hash| (hash, row.size));
                (path.clone(), file)
            })
            .collect()
    }
}

/// `HEAD`'s tree and its pairing with the disk's entries, as `head_files` holds them.
#[derive(Debug, Clone)]
struct History {
    rows: BTreeMap<RelPath, HeadRow>,
    pairing: HashMap<RelPath, i64>,
}

impl History {
    /// The first commit of `disk`: every row paired with its entry.
    fn of(disk: &Disk) -> Self {
        let mut rows = BTreeMap::new();
        let mut pairing = HashMap::new();
        for (path, entry) in &disk.entries {
            let row = disk.row(path);
            rows.insert(row.path.clone(), head_row(&row));
            pairing.insert(row.path, entry.id);
        }
        Self { rows, pairing }
    }

    /// Pairs each unpaired row with the unpaired entry at exactly its path and of its kind.
    fn pair_by_path(&mut self, disk: &Disk) {
        let paired: HashSet<i64> = self.pairing.values().copied().collect();
        for (path, row) in &self.rows {
            if self.pairing.contains_key(path) {
                continue;
            }
            if let Some(entry) = disk.entries.get(path.as_str())
                && !paired.contains(&entry.id)
                && (entry.content.is_some()) == (row.kind() == EntryKind::File)
            {
                self.pairing.insert(path.clone(), entry.id);
            }
        }
    }

    /// Rows lose the entries the disk no longer has, then pair by path.
    fn follow(&mut self, disk: &Disk) {
        let ids: HashSet<i64> = disk.entries.values().map(|entry| entry.id).collect();
        self.pairing.retain(|_, id| ids.contains(id));
        self.pair_by_path(disk);
    }

    /// What the loader reads: every row (rows in place may come), the rows without an entry, and
    /// the entries no row pairs with.
    fn comparison(&self, disk: &Disk) -> Comparison {
        let by_id: HashMap<i64, &String> = disk
            .entries
            .iter()
            .map(|(path, entry)| (entry.id, path))
            .collect();
        let mut comparison = Comparison::default();
        for (path, row) in &self.rows {
            match self.pairing.get(path) {
                Some(id) => comparison.paired.push((row.clone(), disk.row(by_id[id]))),
                None => comparison.deleted.push(row.clone()),
            }
        }
        let paired: HashSet<i64> = self.pairing.values().copied().collect();
        comparison.added = disk
            .entries
            .iter()
            .filter(|(_, entry)| !paired.contains(&entry.id))
            .map(|(path, _)| disk.row(path))
            .collect();
        comparison
    }

    fn workspace(&self, disk: &Disk) -> Workspace {
        Workspace::new(self.comparison(disk), &VersioningRules::default())
    }

    /// The history after committing `applied`, with the post-commit pairing.
    fn commit(&self, applied: &Applied, disk: &Disk) -> Result<Self, TestCaseError> {
        let mut rows = BTreeMap::new();
        let mut pairing = HashMap::new();
        for (path, source) in applied.nodes() {
            let (row, entry) = match source {
                Source::Head(row) => (
                    HeadRow {
                        path: path.clone(),
                        file: row.file.clone(),
                    },
                    self.pairing.get(&row.path).copied(),
                ),
                Source::Disk(entry) => {
                    let mut row = head_row(entry);
                    row.path = path.clone();
                    (row, Some(entry.entry.0))
                }
                Source::Created => (
                    HeadRow {
                        path: path.clone(),
                        file: None,
                    },
                    None,
                ),
            };
            rows.insert(path.clone(), row);
            if let Some(id) = entry {
                pairing.insert(path.clone(), id);
            }
        }
        let mut seen = HashSet::new();
        for (path, id) in &pairing {
            prop_assert!(seen.insert(*id), "entry {id} paired twice, at {path} too");
        }
        let mut next = Self { rows, pairing };
        next.pair_by_path(disk);
        Ok(next)
    }

    fn tree(&self) -> BTreeMap<String, Option<(ContentHash, u64)>> {
        self.rows
            .iter()
            .map(|(path, row)| {
                let file = row.file.as_ref().map(|file| (file.hash.clone(), file.size));
                (path.to_string(), file)
            })
            .collect()
    }
}

/// The row a commit writes for an entry the disk has.
fn head_row(entry: &DiskRow) -> HeadRow {
    let rules = VersioningRules::default();
    HeadRow {
        path: entry.path.clone(),
        file: entry.hash.clone().map(|hash| HeadFile {
            hash,
            size: entry.size,
            stored: rules.is_stored(entry.class, entry.size),
        }),
    }
}

/// Checks a chosen set's tree: no two names NTFS takes for each other in a folder, every parent a
/// folder, every row of `HEAD` kept unless a chosen change deletes it, and the entries of the
/// chosen changes written, those and no others.
fn check_tree(
    history: &History,
    workspace: &Workspace,
    chosen: &Chosen,
    applied: &Applied,
) -> Result<(), TestCaseError> {
    let nodes = applied.nodes();
    let mut names: HashMap<(Option<RelPath>, PathKey), &RelPath> = HashMap::new();
    for path in nodes.keys() {
        if let Some(twin) = names.insert((path.parent(), path.name_key()), path) {
            prop_assert!(false, "{twin} and {path} are one name on NTFS");
        }
        if let Some(parent) = path.parent() {
            let kind = nodes.get(&parent).map(Source::kind);
            prop_assert_eq!(kind, Some(EntryKind::Folder), "the parent of {}", path);
        }
    }

    let mut deleted: HashSet<&RelPath> = HashSet::new();
    let mut written: HashSet<EntryId> = HashSet::new();
    for item in workspace.chosen_items(chosen) {
        for change in item.changes() {
            if change.op() == ChangeOp::Delete {
                deleted.extend(change.head().map(|row| &row.path));
                deleted.extend(change.covered());
            }
            written.extend(change.entry());
        }
    }
    let mut kept: HashSet<&RelPath> = HashSet::new();
    let mut found: HashSet<EntryId> = HashSet::new();
    let paired_rows: HashMap<i64, &RelPath> = history
        .pairing
        .iter()
        .map(|(path, id)| (*id, path))
        .collect();
    for source in nodes.values() {
        match source {
            Source::Head(row) => {
                prop_assert!(kept.insert(&row.path), "{} kept twice", row.path);
            }
            Source::Disk(entry) => {
                prop_assert!(found.insert(entry.entry), "{:?} written twice", entry.entry);
                if let Some(path) = paired_rows.get(&entry.entry.0) {
                    prop_assert!(kept.insert(path), "{} kept twice", path);
                }
            }
            Source::Created => {}
        }
    }
    for path in history.rows.keys() {
        prop_assert_eq!(
            kept.contains(path),
            !deleted.contains(path),
            "HEAD's row {} kept or deleted",
            path
        );
    }
    prop_assert!(
        written.is_subset(&found),
        "{written:?} not all in {found:?}"
    );
    // And nothing else of the disk: a change left out keeps `HEAD`'s content and place.
    prop_assert!(
        found.is_subset(&written),
        "{found:?} written but only {written:?} chosen"
    );
    Ok(())
}

fn op() -> impl Strategy<Value = Op> {
    let index = || 0usize..64;
    prop_oneof![
        2 => (index(), index(), any::<bool>()).prop_map(|(target, name, delete)| Op::Return {
            target,
            name,
            delete,
            echo: true,
        }),
        1 => (index(), 0u8..6).prop_map(|(target, content)| Op::Edit { target, content }),
        1 => (index(), index(), index(), any::<bool>()).prop_map(|(target, into, name, ids)| {
            Op::Move {
                target,
                into,
                name,
                ids,
            }
        }),
        1 => (index(), any::<bool>()).prop_map(|(target, ids)| Op::Case { target, ids }),
        1 => index().prop_map(|target| Op::Delete { target }),
        1 => (index(), index(), any::<bool>(), 0u8..6).prop_map(|(into, name, folder, content)| {
            Op::Create {
                into,
                name,
                folder,
                content,
            }
        }),
        1 => (index(), any::<bool>(), 0u8..6).prop_map(|(target, folder, content)| Op::Replace {
            target,
            folder,
            content,
        }),
        1 => (index(), index()).prop_map(|(a, b)| Op::Swap { a, b }),
        1 => index().prop_map(|target| Op::Recreate { target }),
        1 => (index(), index()).prop_map(|(target, name)| Op::Escape { target, name }),
        2 => (index(), index()).prop_map(|(target, name)| Op::Nest { target, name }),
        1 => (index(), index(), any::<bool>()).prop_map(|(target, name, delete)| Op::Return {
            target,
            name,
            delete,
            echo: false,
        }),
    ]
}

/// A tree to start from: entries created into random folders.
fn seed() -> impl Strategy<Value = Vec<Op>> {
    prop::collection::vec(
        (0usize..64, 0usize..64, any::<bool>(), 0u8..6).prop_map(
            |(into, name, folder, content)| Op::Create {
                into,
                name,
                folder,
                content,
            },
        ),
        1..14,
    )
}

/// Which items each partial commit chooses, cycled over the items.
fn masks() -> impl Strategy<Value = Vec<Vec<bool>>> {
    prop::collection::vec(prop::collection::vec(any::<bool>(), 1..8), 0..4)
}

fn chosen_by(mask: &[bool], workspace: &Workspace) -> Chosen {
    Chosen::from_picked(
        (0..workspace.items().len())
            .map(|index| mask[index % mask.len()])
            .collect(),
    )
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(512))]

    #[test]
    fn every_chosen_set_builds_a_valid_tree_and_the_rest_gives_the_disk(
        seed in seed(),
        ops in prop::collection::vec(op(), 0..10),
        masks in masks(),
    ) {
        let mut disk = Disk::default();
        for op in &seed {
            disk.apply(op);
        }
        disk.check()?;
        let mut history = History::of(&disk);
        for op in &ops {
            disk.apply(op);
            disk.check()?;
        }
        history.follow(&disk);
        let head_rows = || history.rows.values().cloned().collect::<Vec<_>>();

        // Nothing chosen is HEAD; everything at once is the disk.
        let workspace = history.workspace(&disk);
        let none = Chosen::from_picked(vec![false; workspace.items().len()]);
        let unchanged = workspace.apply(head_rows(), &none).map_err(|error| {
            TestCaseError::fail(format!("nothing chosen: {error}"))
        })?;
        prop_assert_eq!(history.commit(&unchanged, &disk)?.tree(), history.tree());
        let all = Chosen::from_picked(vec![true; workspace.items().len()]);
        let at_once = workspace.apply(head_rows(), &all).map_err(|error| {
            TestCaseError::fail(format!("everything: {error}"))
        })?;
        check_tree(&history, &workspace, &all, &at_once)?;
        prop_assert_eq!(history.commit(&at_once, &disk)?.tree(), disk.tree());

        // Chosen sets one after the other, then the rest.
        let mut current = history.clone();
        for mask in masks.iter().map(Some).chain([None]) {
            let workspace = current.workspace(&disk);
            let chosen = match mask {
                Some(mask) => chosen_by(mask, &workspace),
                None => Chosen::from_picked(vec![true; workspace.items().len()]),
            };
            let applied = workspace
                .apply(current.rows.values().cloned(), &chosen)
                .map_err(|error| {
                    let items: Vec<String> = workspace.items().iter().map(describe_item).collect();
                    TestCaseError::fail(format!("{error}; items {items:#?}"))
                })?;
            check_tree(&current, &workspace, &chosen, &applied)?;
            current = current.commit(&applied, &disk)?;
        }
        prop_assert_eq!(current.tree(), disk.tree());
        let left = current.workspace(&disk);
        prop_assert!(left.items().is_empty(), "left: {:?}", left.items());
    }
}
