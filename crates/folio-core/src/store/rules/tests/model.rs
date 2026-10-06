//! Random libraries for the property tests. A library is a flattened tree whose files and folders
//! carry an identity, so that a test can move them around and a writer can record the moves, as
//! Folio pairs entries by their NTFS file id (library-scan.md §6.1).

use std::collections::{BTreeMap, BTreeSet, HashMap};

use proptest::prelude::*;
use proptest::sample::Index;

use crate::store::{
    Change, FlatEntry, FlatTree, MemoryTrees, Name, ObjectId, Side, Size, Tree, TreeEntry, TreePath,
};

/// Names that sort around `/` in UTF-8 byte order (`!`, `-` and `.` before it), by case, and
/// differently in UTF-16 (`😀`): the order a walk and a range over paths must get right.
const NAMES: &[&str] = &["a", "b", "a!", "a-b", "a.c", "B", "é", "😀"];

/// A path's entry with the identity of the file or folder it is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct Node {
    pub(super) entry: FlatEntry,
    pub(super) identity: u32,
}

/// A library: every path with its node, each path's parent a folder.
pub(super) type Library = BTreeMap<String, Node>;

/// The file content numbered `seed`. Small seeds repeat across a library, so that equal files and
/// equal folders (trees of one id at two paths) are common.
pub(super) fn content(seed: u32, stored: bool) -> Side {
    let mut bytes = [0; 32];
    bytes[..4].copy_from_slice(&seed.to_le_bytes());
    Side {
        hash: ObjectId::from_bytes(bytes),
        size: Size::new(u64::from(seed % 5)).expect("a small size"),
        stored,
    }
}

pub(super) fn flat(library: &Library) -> FlatTree {
    library
        .iter()
        .map(|(path, node)| (path.clone(), node.entry))
        .collect()
}

fn join(folder: &str, name: &str) -> String {
    if folder.is_empty() {
        name.to_owned()
    } else {
        format!("{folder}/{name}")
    }
}

/// Whether `path` is `top` or lies below it.
fn within(path: &str, top: &str) -> bool {
    path == top || (path.starts_with(top) && path.as_bytes().get(top.len()) == Some(&b'/'))
}

/// Adds the trees of a flattened tree (every path's parent a folder of it) to `trees`, and returns
/// the root's id.
pub(super) fn build(trees: &mut MemoryTrees, tree: &FlatTree) -> ObjectId {
    let mut children: HashMap<&str, Vec<(&str, FlatEntry)>> = HashMap::new();
    for (path, entry) in tree {
        let (parent, name) = path.rsplit_once('/').unwrap_or(("", path.as_str()));
        children.entry(parent).or_default().push((name, *entry));
    }
    let mut folders: Vec<&str> = tree
        .iter()
        .filter(|(_, entry)| **entry == FlatEntry::Dir)
        .map(|(path, _)| path.as_str())
        .collect();
    // The deepest folders first, the root last.
    folders.sort_by_key(|path| std::cmp::Reverse(path.matches('/').count()));
    folders.push("");
    let mut ids: HashMap<String, ObjectId> = HashMap::new();
    for folder in folders {
        let entries = children
            .get(folder)
            .into_iter()
            .flatten()
            .map(|&(name, entry)| {
                let child = join(folder, name);
                let name = Name::parse(name).expect("a valid name");
                match entry {
                    FlatEntry::File(side) => TreeEntry::file(name, side),
                    FlatEntry::Dir => TreeEntry::dir(name, ids[&child]),
                }
            })
            .collect();
        let id = trees
            .insert(Tree::new(entries).expect("names of one folder are distinct"))
            .expect("a small tree");
        ids.insert(folder.to_owned(), id);
    }
    ids[""]
}

/// The shape of a library's `.folio`: as Folio writes it, or broken in one way.
#[derive(Debug, Clone)]
pub(super) enum Folio {
    Standard {
        tags: bool,
        groups: Vec<usize>,
    },
    /// Standard but breaking a rule of remote-format.md §7.4, by number.
    Broken(u8),
}

impl Folio {
    fn add(&self, library: &mut Library, next: &mut u32) {
        let mut put = |path: &str, entry: FlatEntry| {
            library.insert(
                path.to_owned(),
                Node {
                    entry,
                    identity: *next,
                },
            );
            *next += 1;
        };
        let meta = FlatEntry::File(content(90, true));
        put(".folio", FlatEntry::Dir);
        put(".folio/library.json", meta);
        match self {
            Self::Standard { tags, groups } => {
                if *tags {
                    put(".folio/tags.json", meta);
                }
                if !groups.is_empty() {
                    put(".folio/meta", FlatEntry::Dir);
                    put(".folio/meta/_root.json", meta);
                }
                for &group in groups {
                    let folder = format!(".folio/meta/{}", NAMES[group]);
                    put(&folder, FlatEntry::Dir);
                    put(&format!("{folder}/_group.json"), meta);
                }
            }
            Self::Broken(how) => match how % 10 {
                0 => put(".Folio", FlatEntry::Dir),
                1 => {
                    library.remove(".folio/library.json");
                }
                2 => {
                    library.remove(".folio/library.json");
                    library.insert(
                        ".folio".to_owned(),
                        Node {
                            entry: meta,
                            identity: 0,
                        },
                    );
                }
                3 => put(".folio/local", FlatEntry::Dir),
                4 => put(".folio/STORE", meta),
                5 => put(".folio/ſtore", FlatEntry::Dir),
                6 => put(".folio/cache", FlatEntry::Dir),
                7 => {
                    put(".folio/meta", FlatEntry::Dir);
                    put(".folio/meta/s", FlatEntry::Dir);
                    put(".folio/meta/s/c", FlatEntry::Dir);
                }
                8 => put(".folio/tags.json", FlatEntry::File(content(91, false))),
                _ => put(".folıo", FlatEntry::Dir),
            },
        }
    }
}

fn folio() -> impl Strategy<Value = Folio> {
    prop_oneof![
        4 => (any::<bool>(), prop::collection::vec(0..NAMES.len(), 0..3))
            .prop_map(|(tags, groups)| Folio::Standard { tags, groups }),
        1 => any::<u8>().prop_map(Folio::Broken),
    ]
}

/// A random library: up to 14 items of up to three names, files and folders, and its `.folio`.
pub(super) fn library() -> impl Strategy<Value = Library> {
    let item = (
        prop::collection::vec(0..NAMES.len(), 1..=3),
        any::<bool>(),
        0..6_u32,
        any::<bool>(),
    );
    (prop::collection::vec(item, 0..14), folio()).prop_map(|(items, folio)| {
        let mut library = Library::new();
        let mut next = 1;
        for (names, dir, seed, stored) in items {
            let mut path = String::new();
            for (depth, &name) in names.iter().enumerate() {
                path = join(&path, NAMES[name]);
                let last = depth + 1 == names.len();
                match library.get(&path) {
                    // A file where a folder is needed: the item goes no further.
                    Some(node) if !last && node.entry != FlatEntry::Dir => break,
                    Some(_) => {}
                    None => {
                        let entry = if last && !dir {
                            FlatEntry::File(content(seed, stored))
                        } else {
                            FlatEntry::Dir
                        };
                        library.insert(
                            path.clone(),
                            Node {
                                entry,
                                identity: next,
                            },
                        );
                        next += 1;
                    }
                }
            }
        }
        folio.add(&mut library, &mut next);
        library
    })
}

/// What a moved file or folder leaves at its old path.
#[derive(Debug, Clone, Copy)]
pub(super) enum Leave {
    Nothing,
    /// A new empty folder of the old name.
    Folder,
    /// An identical copy: the same file, or the folder with the same content.
    Copy,
}

/// One change to a library.
#[derive(Debug, Clone)]
pub(super) enum Op {
    /// New content for a file, or only its `stored` flipped.
    Edit {
        at: Index,
        flip: bool,
    },
    Add {
        under: Index,
        name: usize,
        dir: bool,
        seed: u32,
    },
    Delete {
        at: Index,
    },
    /// A move into a folder under a name; then, for a folder, maybe an edit of a file it holds.
    Move {
        at: Index,
        under: Index,
        name: usize,
        leave: Leave,
        edit: Option<Index>,
    },
    /// A file becomes a folder, or a folder a file.
    Kind {
        at: Index,
    },
    /// A folder moves into another folder under a name, then something it held moves out of it
    /// into a third folder: two moves, one nested in the other in the parent's paths.
    Nest {
        at: Index,
        under: Index,
        name: usize,
        inner: Index,
        out: Index,
        out_name: usize,
    },
}

pub(super) fn op() -> impl Strategy<Value = Op> {
    let leave = prop_oneof![
        3 => Just(Leave::Nothing),
        1 => Just(Leave::Folder),
        1 => Just(Leave::Copy),
    ];
    prop_oneof![
        2 => (any::<Index>(), prop::bool::weighted(0.2)).prop_map(|(at, flip)| Op::Edit { at, flip }),
        2 => (any::<Index>(), 0..NAMES.len(), any::<bool>(), 0..6_u32)
            .prop_map(|(under, name, dir, seed)| Op::Add { under, name, dir, seed }),
        1 => any::<Index>().prop_map(|at| Op::Delete { at }),
        4 => (
            any::<Index>(),
            any::<Index>(),
            0..NAMES.len(),
            leave,
            proptest::option::weighted(0.4, any::<Index>()),
        )
            .prop_map(|(at, under, name, leave, edit)| Op::Move { at, under, name, leave, edit }),
        1 => any::<Index>().prop_map(|at| Op::Kind { at }),
        2 => (
            any::<Index>(),
            any::<Index>(),
            0..NAMES.len(),
            any::<Index>(),
            any::<Index>(),
            0..NAMES.len(),
        )
            .prop_map(|(at, under, name, inner, out, out_name)| Op::Nest {
                at,
                under,
                name,
                inner,
                out,
                out_name,
            }),
    ]
}

/// Moves `from` (a path of `library`) with what it holds into `folder` under `name`, and returns
/// what moved by its old paths; `None`, changing nothing, when the folder lies in what moves or
/// the name is taken.
fn move_into(
    library: &mut Library,
    from: &str,
    folder: &str,
    name: &str,
) -> Option<Vec<(String, Node)>> {
    let to = join(folder, name);
    if within(folder, from) || library.contains_key(&to) {
        return None;
    }
    let moved: Vec<(String, Node)> = library
        .iter()
        .filter(|(path, _)| within(path, from))
        .map(|(path, node)| (path.clone(), *node))
        .collect();
    library.retain(|path, _| !within(path, from));
    for (path, node) in &moved {
        library.insert(format!("{to}{}", &path[from.len()..]), *node);
    }
    Some(moved)
}

/// Applies `ops` to a copy of `library`. New files and folders get new identities; moved ones
/// keep theirs. `.folio` and its `library.json` stay where they are.
pub(super) fn apply(library: &Library, ops: &[Op]) -> Library {
    fn fresh(next: &mut u32) -> u32 {
        *next += 1;
        *next
    }
    let mut library = library.clone();
    let mut next = 1_000_000;
    let mut seed = 1_000;
    for op in ops {
        let movable: Vec<String> = library
            .keys()
            .filter(|path| !matches!(path.as_str(), ".folio" | ".folio/library.json"))
            .cloned()
            .collect();
        let folders: Vec<String> = std::iter::once(String::new())
            .chain(
                library
                    .iter()
                    .filter(|(_, node)| node.entry == FlatEntry::Dir)
                    .map(|(path, _)| path.clone()),
            )
            .collect();
        match *op {
            Op::Edit { at, flip } => {
                let files: Vec<String> = library
                    .iter()
                    .filter(|(_, node)| matches!(node.entry, FlatEntry::File(_)))
                    .map(|(path, _)| path.clone())
                    .collect();
                if files.is_empty() {
                    continue;
                }
                let node = library
                    .get_mut(&files[at.index(files.len())])
                    .expect("a file");
                if let FlatEntry::File(side) = &mut node.entry {
                    if flip {
                        side.stored = !side.stored;
                    } else {
                        seed += 1;
                        *side = content(seed, side.stored);
                    }
                }
            }
            Op::Add {
                under,
                name,
                dir,
                seed: content_seed,
            } => {
                let path = join(&folders[under.index(folders.len())], NAMES[name]);
                if library.contains_key(&path) {
                    continue;
                }
                let entry = if dir {
                    FlatEntry::Dir
                } else {
                    FlatEntry::File(content(content_seed, true))
                };
                let identity = fresh(&mut next);
                library.insert(path, Node { entry, identity });
            }
            Op::Delete { at } => {
                if movable.is_empty() {
                    continue;
                }
                let top = movable[at.index(movable.len())].clone();
                library.retain(|path, _| !within(path, &top));
            }
            Op::Move {
                at,
                under,
                name,
                leave,
                edit,
            } => {
                if movable.is_empty() {
                    continue;
                }
                let from = movable[at.index(movable.len())].clone();
                let folder = &folders[under.index(folders.len())];
                let to = join(folder, NAMES[name]);
                let Some(moved) = move_into(&mut library, &from, folder, NAMES[name]) else {
                    continue;
                };
                match leave {
                    Leave::Nothing => {}
                    Leave::Folder => {
                        let identity = fresh(&mut next);
                        library.insert(
                            from.clone(),
                            Node {
                                entry: FlatEntry::Dir,
                                identity,
                            },
                        );
                    }
                    Leave::Copy => {
                        for (path, node) in moved {
                            let identity = fresh(&mut next);
                            library.insert(
                                path,
                                Node {
                                    entry: node.entry,
                                    identity,
                                },
                            );
                        }
                    }
                }
                if let Some(which) = edit {
                    let inside: Vec<String> = library
                        .iter()
                        .filter(|(path, node)| {
                            path.as_str() != to
                                && within(path, &to)
                                && matches!(node.entry, FlatEntry::File(_))
                        })
                        .map(|(path, _)| path.clone())
                        .collect();
                    if !inside.is_empty() {
                        seed += 1;
                        let node = library
                            .get_mut(&inside[which.index(inside.len())])
                            .expect("a file");
                        node.entry = FlatEntry::File(content(seed, true));
                    }
                }
            }
            Op::Kind { at } => {
                if movable.is_empty() {
                    continue;
                }
                let top = movable[at.index(movable.len())].clone();
                let was_file = matches!(library[&top].entry, FlatEntry::File(_));
                library.retain(|path, _| !within(path, &top));
                seed += 1;
                let entry = if was_file {
                    FlatEntry::Dir
                } else {
                    FlatEntry::File(content(seed, true))
                };
                let identity = fresh(&mut next);
                library.insert(top, Node { entry, identity });
            }
            Op::Nest {
                at,
                under,
                name,
                inner,
                out,
                out_name,
            } => {
                let outer: Vec<&String> = folders
                    .iter()
                    .filter(|path| {
                        !path.is_empty()
                            && path.as_str() != ".folio"
                            && library
                                .keys()
                                .any(|below| below != *path && within(below, path))
                    })
                    .collect();
                if outer.is_empty() {
                    continue;
                }
                let from = outer[at.index(outer.len())].clone();
                let folder = &folders[under.index(folders.len())];
                let to = join(folder, NAMES[name]);
                if move_into(&mut library, &from, folder, NAMES[name]).is_none() {
                    continue;
                }
                let held: Vec<String> = library
                    .keys()
                    .filter(|path| path.as_str() != to && within(path, &to))
                    .cloned()
                    .collect();
                let thing = &held[inner.index(held.len())];
                let folders: Vec<String> = std::iter::once(String::new())
                    .chain(
                        library
                            .iter()
                            .filter(|(path, node)| {
                                node.entry == FlatEntry::Dir && !within(path, thing)
                            })
                            .map(|(path, _)| path.clone()),
                    )
                    .collect();
                let target = &folders[out.index(folders.len())];
                move_into(&mut library, thing, target, NAMES[out_name]);
            }
        }
    }
    library
}

/// The change records a writer that knows what moved writes from `parent` to `tree`, covering
/// every changed path once (remote-format.md §8): a move for a file or folder whose identity
/// changed path, when its two sides and everything it would carry are still uncovered (outer
/// folders first); `modify`, `delete` and `add` for the rest. A move whose old path holds the same
/// entry again has no from side, so it becomes an `add` (rule 6).
pub(super) fn write_changes(parent: &Library, tree: &Library) -> Vec<Change> {
    let changed = |side: &Library, other: &Library| -> BTreeMap<String, FlatEntry> {
        side.iter()
            .filter(|(path, node)| other.get(*path).map(|other| other.entry) != Some(node.entry))
            .map(|(path, node)| (path.clone(), node.entry))
            .collect()
    };
    let from = changed(parent, tree);
    let to = changed(tree, parent);
    let new_paths: HashMap<u32, &str> = tree
        .iter()
        .map(|(path, node)| (node.identity, path.as_str()))
        .collect();
    let mut from_covered: BTreeSet<String> = BTreeSet::new();
    let mut to_covered: BTreeSet<String> = BTreeSet::new();
    let mut records = Vec::new();
    // Parent paths in order: a folder before what it holds.
    for (old, node) in parent {
        let Some(&new) = new_paths.get(&node.identity) else {
            continue;
        };
        let (Some(old_entry), Some(new_entry)) = (from.get(old), to.get(new)) else {
            continue;
        };
        if new == old.as_str()
            || from_covered.contains(old)
            || to_covered.contains(new)
            || old_entry.kind() != new_entry.kind()
        {
            continue;
        }
        let carried: Vec<(String, String)> = from
            .iter()
            .filter(|(path, _)| path.as_str() != old && within(path, old))
            .filter_map(|(path, entry)| {
                let moved = format!("{new}{}", &path[old.len()..]);
                (to.get(&moved) == Some(entry)).then(|| (path.clone(), moved))
            })
            .collect();
        if *old_entry == FlatEntry::Dir
            && carried
                .iter()
                .any(|(path, moved)| from_covered.contains(path) || to_covered.contains(moved))
        {
            continue;
        }
        let (from_path, to_path) = (tree_path(old), tree_path(new));
        records.push(match (old_entry, new_entry) {
            (FlatEntry::File(old), FlatEntry::File(new)) => Change::MoveFile {
                from: from_path,
                path: to_path,
                old: *old,
                new: *new,
            },
            _ => Change::MoveDir {
                from: from_path,
                path: to_path,
            },
        });
        from_covered.insert(old.clone());
        to_covered.insert(new.to_owned());
        if *old_entry == FlatEntry::Dir {
            for (path, moved) in carried {
                from_covered.insert(path);
                to_covered.insert(moved);
            }
        }
    }
    let paths: BTreeSet<&String> = from.keys().chain(to.keys()).collect();
    for path in paths {
        let old = from.get(path).filter(|_| !from_covered.contains(path));
        let new = to.get(path).filter(|_| !to_covered.contains(path));
        match (old, new) {
            (Some(FlatEntry::File(old)), Some(FlatEntry::File(new))) => {
                records.push(Change::ModifyFile {
                    path: tree_path(path),
                    old: *old,
                    new: *new,
                });
            }
            (old, new) => {
                if let Some(old) = old {
                    records.push(match old {
                        FlatEntry::Dir => Change::DeleteDir {
                            path: tree_path(path),
                        },
                        FlatEntry::File(old) => Change::DeleteFile {
                            path: tree_path(path),
                            old: *old,
                        },
                    });
                }
                if let Some(new) = new {
                    records.push(match new {
                        FlatEntry::Dir => Change::AddDir {
                            path: tree_path(path),
                        },
                        FlatEntry::File(new) => Change::AddFile {
                            path: tree_path(path),
                            new: *new,
                        },
                    });
                }
            }
        }
    }
    records
}

fn tree_path(text: &str) -> TreePath {
    TreePath::parse(text).expect("a library path is a short valid path")
}
