//! The trees of a flattened tree (remote-format.md §7.2): every folder encoded from the paths
//! below it, deepest first, the root last, so each folder's tree id is known without a walk that
//! recurses (a valid tree can be about 16,000 folders deep).
//!
//! The head sync gives `head_files`' folders their tree ids this way, and checks that `HEAD`'s
//! flattened tree encodes to its commit's tree again (lane decision 4); a commit builds its trees
//! the same way from the tree it commits, and tests write their `HEAD`s with it.

use std::cmp::Reverse;
use std::collections::{HashMap, HashSet};

use crate::store::{Encoded, Name, ObjectId, Side, StoreError, Tree, TreeEntry, ValueError};

/// Why a flattened tree does not make trees.
#[derive(Debug, thiserror::Error)]
pub enum TreeError {
    /// A path whose parent is not a folder of the tree.
    #[error("`{path}` is not below a folder of the tree")]
    Orphan { path: String },
    /// A name the format does not allow (remote-format.md §6.4).
    #[error("`{path}` holds a name the format does not allow: {error}")]
    Name { path: String, error: ValueError },
    /// Two entries of the folder `folder` (empty for the root) with one name.
    #[error("the folder `{folder}` holds one name twice")]
    Twice { folder: String },
    /// A tree over 64 MiB, or `each` failed.
    #[error(transparent)]
    Store(#[from] StoreError),
}

/// Encodes the folders of the flattened tree `rows` (each path, relative to the root, with a
/// file's side or `None` for a folder, in any order) deepest first, and gives each to `each` with
/// its path (empty for the root, which comes last). Returns the root's tree id.
pub fn encode_trees<'a>(
    rows: impl IntoIterator<Item = (&'a str, Option<Side>)>,
    mut each: impl FnMut(&'a str, Encoded) -> Result<(), StoreError>,
) -> Result<ObjectId, TreeError> {
    let mut folders: Vec<&'a str> = Vec::new();
    let mut files: Vec<(&'a str, Side)> = Vec::new();
    for (path, side) in rows {
        match side {
            None => folders.push(path),
            Some(side) => files.push((path, side)),
        }
    }
    let known: HashSet<&str> = folders.iter().copied().collect();
    let all = folders
        .iter()
        .copied()
        .chain(files.iter().map(|&(path, _)| path));
    for path in all {
        let parent = parent_of(path);
        if !parent.is_empty() && !known.contains(parent) {
            return Err(TreeError::Orphan {
                path: path.to_owned(),
            });
        }
    }
    let mut entries: HashMap<&'a str, Vec<TreeEntry>> = HashMap::new();
    for (path, side) in files {
        let entry = TreeEntry::file(name_of(path)?, side);
        entries.entry(parent_of(path)).or_default().push(entry);
    }
    folders.sort_by_cached_key(|path| Reverse(path.matches('/').count()));
    for folder in folders {
        let id = encode(
            folder,
            entries.remove(folder).unwrap_or_default(),
            &mut each,
        )?;
        let entry = TreeEntry::dir(name_of(folder)?, id);
        entries.entry(parent_of(folder)).or_default().push(entry);
    }
    encode("", entries.remove("").unwrap_or_default(), &mut each)
}

/// Encodes the folder `path`'s tree of `entries`, gives it to `each` and returns its id.
fn encode<'a>(
    path: &'a str,
    entries: Vec<TreeEntry>,
    each: &mut impl FnMut(&'a str, Encoded) -> Result<(), StoreError>,
) -> Result<ObjectId, TreeError> {
    let tree = Tree::new(entries).map_err(|_| TreeError::Twice {
        folder: path.to_owned(),
    })?;
    let encoded = tree.encode()?;
    let id = encoded.id();
    each(path, encoded)?;
    Ok(id)
}

/// The path of the folder `path` is in; empty at the root.
fn parent_of(path: &str) -> &str {
    path.rsplit_once('/').map_or("", |(parent, _)| parent)
}

/// The last name of `path`, as the format checks it.
fn name_of(path: &str) -> Result<Name, TreeError> {
    let name = path.rsplit_once('/').map_or(path, |(_, name)| name);
    Name::parse(name).map_err(|error| TreeError::Name {
        path: path.to_owned(),
        error,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::{DEFAULT_PATH_BUDGET, FlatEntry, MemoryTrees, ObjectKind, Size, flatten};

    fn side(content: &str) -> Side {
        Side {
            hash: ObjectId::of(ObjectKind::Blob, content.as_bytes()),
            size: Size::new(content.len() as u64).unwrap(),
            stored: true,
        }
    }

    /// The trees of `rows` in a store in memory, and the root's id.
    fn encoded(rows: &[(&'static str, Option<Side>)]) -> (MemoryTrees, ObjectId, Vec<String>) {
        let mut trees = MemoryTrees::new();
        let mut order = Vec::new();
        let root = encode_trees(rows.iter().copied(), |path, encoded| {
            order.push(path.to_owned());
            let tree = Tree::parse(encoded.bytes()).unwrap();
            assert_eq!(trees.insert(tree).unwrap(), encoded.id());
            Ok(())
        })
        .unwrap();
        (trees, root, order)
    }

    #[test]
    fn folders_encode_deepest_first_and_flatten_back() {
        let rows = [
            ("a", None),
            ("a b", Some(side("1"))),
            ("a/x", None),
            ("a/x/deep.md", Some(side("2"))),
            ("a/y.md", Some(side("3"))),
            ("empty", None),
            ("z.txt", Some(side("4"))),
        ];
        let (trees, root, order) = encoded(&rows);
        assert_eq!(order.first().map(String::as_str), Some("a/x"));
        assert_eq!(order.last().map(String::as_str), Some(""));
        assert_eq!(order.len(), 4);
        let flat = flatten(&trees, root, DEFAULT_PATH_BUDGET).unwrap();
        let expected: Vec<(String, FlatEntry)> = rows
            .iter()
            .map(|(path, side)| {
                let entry = side.map_or(FlatEntry::Dir, FlatEntry::File);
                ((*path).to_owned(), entry)
            })
            .collect();
        assert_eq!(flat.into_iter().collect::<Vec<_>>(), expected);
    }

    #[test]
    fn the_order_of_the_rows_does_not_matter() {
        let rows = [
            ("s/c/b.md", Some(side("b"))),
            ("s", None),
            ("s/c", None),
            ("s/c/a.md", Some(side("a"))),
        ];
        let (_, forward, _) = encoded(&rows);
        let mut reversed = rows;
        reversed.reverse();
        let (_, backward, _) = encoded(&reversed);
        assert_eq!(forward, backward);
        // An empty tree is the root of nothing.
        let (_, empty, order) = encoded(&[]);
        assert_eq!(empty, Tree::default().encode().unwrap().id());
        assert_eq!(order, [""]);
    }

    #[test]
    fn a_deep_chain_encodes_without_recursion() {
        let mut paths = Vec::new();
        let mut path = String::from("d");
        for _ in 0..5_000 {
            paths.push(path.clone());
            path.push_str("/d");
        }
        let rows = paths.iter().map(|path| (path.as_str(), None));
        let mut count = 0;
        encode_trees(rows, |_, _| {
            count += 1;
            Ok(())
        })
        .unwrap();
        assert_eq!(count, 5_001);
    }

    #[test]
    fn broken_flattened_trees_are_refused() {
        let orphan = encode_trees([("a/b.md", Some(side("1")))], |_, _| Ok(()));
        assert!(matches!(orphan, Err(TreeError::Orphan { path }) if path == "a/b.md"));
        let below_file = encode_trees(
            [("a", Some(side("1"))), ("a/b.md", Some(side("2")))],
            |_, _| Ok(()),
        );
        assert!(matches!(below_file, Err(TreeError::Orphan { .. })));
        let name = encode_trees([("con", Some(side("1")))], |_, _| Ok(()));
        assert!(matches!(name, Err(TreeError::Name { path, .. }) if path == "con"));
        let twice = encode_trees([("a", None), ("a", Some(side("1")))], |_, _| Ok(()));
        assert!(matches!(twice, Err(TreeError::Twice { folder }) if folder.is_empty()));
        let failing = encode_trees([("a", None)], |_, _| {
            Err(StoreError::Missing(ObjectId::from_bytes([1; 32])))
        });
        assert!(matches!(
            failing,
            Err(TreeError::Store(StoreError::Missing(_)))
        ));
    }
}
