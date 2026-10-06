//! generate.mjs's rules on whole flattened trees (docs/specs/remote-format-vectors/generate.mjs:
//! `flatten`, `rootProblem`, `changesProblem`, `commitContextProblem`, `absentBlob`,
//! `deletable`), ported line by line: the oracle the checker must agree with. Nothing here is
//! quick; it flattens every tree whole and scans every path.

use std::collections::{BTreeSet, HashSet};

use crate::store::{
    Change, ChangeOp, Changes, Commit, CommitKind, FlatEntry, FlatTree, MemoryTrees, ObjectId,
    TreeEntry, TreeSource, same_ntfs_name,
};

/// What generate.mjs says of a commit read with its parent.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum Outcome {
    Valid,
    Missing,
    Invalid(&'static str),
}

/// Every path of the tree `root` with its entry; `Err` with the first tree absent.
pub(super) fn flatten(trees: &MemoryTrees, root: ObjectId) -> Result<FlatTree, ObjectId> {
    fn into(
        trees: &MemoryTrees,
        id: ObjectId,
        prefix: &str,
        out: &mut FlatTree,
    ) -> Result<(), ObjectId> {
        let tree = trees.tree(id).expect("memory never fails").ok_or(id)?;
        for entry in tree.entries() {
            let path = format!("{prefix}{}", entry.name());
            match entry {
                TreeEntry::Dir { tree, .. } => {
                    out.insert(path.clone(), FlatEntry::Dir);
                    into(trees, *tree, &format!("{path}/"), out)?;
                }
                TreeEntry::File { .. } => {
                    out.insert(path, FlatEntry::from(entry));
                }
            }
        }
        Ok(())
    }
    let mut out = FlatTree::new();
    into(trees, root, "", &mut out)?;
    Ok(out)
}

fn utf16_length(text: &str) -> usize {
    text.encode_utf16().count()
}

/// `rootProblem`.
pub(super) fn root_problem(tree: &FlatTree) -> Option<&'static str> {
    for path in tree.keys() {
        if !path.contains('/') && same_ntfs_name(path, ".folio") && path != ".folio" {
            return Some("folio-name");
        }
        if utf16_length(path) > 32767 {
            return Some("path-too-long");
        }
    }
    if tree.get(".folio") != Some(&FlatEntry::Dir)
        || !matches!(tree.get(".folio/library.json"), Some(FlatEntry::File(_)))
    {
        return Some("folio-missing");
    }
    for (path, entry) in tree {
        if !path.starts_with(".folio/") {
            continue;
        }
        let names: Vec<&str> = path.split('/').skip(1).collect();
        if names.len() == 1
            && (same_ntfs_name(names[0], "local") || same_ntfs_name(names[0], "store"))
        {
            return Some("folio-private");
        }
        let folder_allowed =
            (names.len() == 1 && names[0] == "meta") || (names.len() == 2 && names[0] == "meta");
        let misplaced = match entry {
            FlatEntry::Dir => !folder_allowed,
            FlatEntry::File(_) => names.len() > 3,
        };
        if misplaced {
            return Some("folio-path");
        }
        if let FlatEntry::File(side) = entry
            && !side.stored
        {
            return Some("folio-not-stored");
        }
    }
    None
}

/// `changesProblem`.
pub(super) fn changes_problem(
    changes: Option<&Changes>,
    parent: &FlatTree,
    tree: &FlatTree,
) -> Option<&'static str> {
    let changes = changes?;
    let from: BTreeSet<&String> = parent
        .iter()
        .filter(|(path, entry)| tree.get(*path) != Some(entry))
        .map(|(path, _)| path)
        .collect();
    let to: BTreeSet<&String> = tree
        .iter()
        .filter(|(path, entry)| parent.get(*path) != Some(entry))
        .map(|(path, _)| path)
        .collect();
    let mut seen_from: HashSet<String> = HashSet::new();
    let mut seen_to: HashSet<String> = HashSet::new();
    let cover = |seen: &mut HashSet<String>, all: &BTreeSet<&String>, path: &str| {
        if !all.contains(&path.to_owned()) || seen.contains(path) {
            return false;
        }
        seen.insert(path.to_owned());
        true
    };
    for change in changes.records() {
        if change.op() != ChangeOp::Add {
            let from_path = match change {
                Change::MoveFile { from, .. } | Change::MoveDir { from, .. } => from.as_str(),
                _ => change.path().as_str(),
            };
            if !cover(&mut seen_from, &from, from_path) || parent[from_path].kind() != change.kind()
            {
                return Some("coverage");
            }
            if let (FlatEntry::File(side), Some(old)) = (parent[from_path], change.old_side())
                && side != old
            {
                return Some("side");
            }
        }
        if change.op() != ChangeOp::Delete {
            let path = change.path().as_str();
            if !cover(&mut seen_to, &to, path) || tree[path].kind() != change.kind() {
                return Some("coverage");
            }
            if let (FlatEntry::File(side), Some(new)) = (tree[path], change.new_side())
                && side != new
            {
                return Some("side");
            }
        }
        if let Change::MoveDir {
            from: moved_from,
            path: moved_to,
        } = change
        {
            let (moved_from, moved_to) = (moved_from.as_str(), moved_to.as_str());
            for (path, entry) in parent {
                if !path.starts_with(&format!("{moved_from}/")) {
                    continue;
                }
                let moved = format!("{moved_to}/{}", &path[moved_from.len() + 1..]);
                if !from.contains(path) || !to.contains(&moved) || tree.get(&moved) != Some(entry) {
                    continue;
                }
                if !cover(&mut seen_from, &from, path) || !cover(&mut seen_to, &to, &moved) {
                    return Some("coverage");
                }
            }
        }
    }
    if seen_from.len() == from.len() && seen_to.len() == to.len() {
        None
    } else {
        Some("coverage")
    }
}

/// `commitContextProblem`.
pub(super) fn commit_problem(
    commit: &Commit,
    parent: Option<&Commit>,
    trees: &MemoryTrees,
) -> Outcome {
    let (Ok(tree), Ok(parent_tree)) = (
        flatten(trees, commit.tree),
        parent.map_or(Ok(FlatTree::new()), |parent| flatten(trees, parent.tree)),
    ) else {
        return Outcome::Missing;
    };
    if let Some(reason) = root_problem(&tree) {
        return Outcome::Invalid(reason);
    }
    if let CommitKind::Prune { pruned, .. } = &commit.kind {
        if Some(commit.tree) != parent.map(|parent| parent.tree) {
            return Outcome::Invalid("prune-tree");
        }
        let stored: HashSet<ObjectId> = tree
            .values()
            .filter_map(|entry| {
                entry
                    .side()
                    .filter(|side| side.stored)
                    .map(|side| side.hash)
            })
            .collect();
        if pruned.ids().iter().any(|id| stored.contains(id)) {
            return Outcome::Invalid("prune-current");
        }
        return Outcome::Valid;
    }
    if parent.is_some_and(|parent| commit.tree == parent.tree) {
        return Outcome::Invalid("empty-commit");
    }
    let changes = commit
        .message()
        .and_then(|message| message.changes.as_ref());
    match changes_problem(changes, &parent_tree, &tree) {
        Some(reason) => Outcome::Invalid(reason),
        None => Outcome::Valid,
    }
}

/// `absentBlob`: `true` for pruned.
pub(super) fn absent_blob_pruned(chain: &[Commit], index: usize, blob: ObjectId) -> bool {
    chain[index + 1..].iter().any(|commit| {
        commit
            .pruned()
            .is_some_and(|pruned| pruned.ids().contains(&blob))
    })
}

/// `deletable`, with each commit's flattened tree.
pub(super) fn deletable(chain: &[(Commit, FlatTree)], blob: ObjectId) -> bool {
    let mut last_stored = None;
    let mut last_prune = None;
    for (i, (commit, flat)) in chain.iter().enumerate() {
        if flat.values().any(|entry| {
            entry
                .side()
                .is_some_and(|side| side.stored && side.hash == blob)
        }) {
            last_stored = Some(i);
        }
        if commit
            .pruned()
            .is_some_and(|pruned| pruned.ids().contains(&blob))
        {
            last_prune = Some(i);
        }
    }
    // generate.mjs starts both at -1 and asks lastPrune > lastStored.
    last_prune.map_or(-1, |i| i as i64) > last_stored.map_or(-1, |i| i as i64)
}
