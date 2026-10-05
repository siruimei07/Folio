//! Matching the disk to the catalog (docs/specs/library-scan.md §6.1–§6.2).

use std::collections::{HashMap, HashSet};

use super::Change;
use super::walk::Snapshot;
use crate::catalog::{Entry, EntryChanges, EntryId, EntryRecord};
use crate::fs::{FileKind, Metadata};
use crate::hash::ContentHash;
use crate::meta::{EntryKind, FileClass, Moves, VersioningRules, moved_under, relocated};
use crate::paths::RelPath;

/// What a scan changes.
#[derive(Debug, Default)]
pub(super) struct Plan {
    pub entries: EntryChanges,
    /// Every moved entry: old path → new path and kind, for the metadata files. An entry that
    /// stayed at its path below a folder that moved is a move to itself: tags and settings
    /// follow the nearest move, so without it they would leave with the folder.
    pub moves: Moves,
    pub changes: Vec<Change>,
}

/// Where a catalog entry is now.
enum Found<'a> {
    /// At this path on disk.
    At(&'a RelPath),
    /// Below a folder that could not be listed: nobody knows, so it stays, at the path its
    /// nearest moved ancestor took it to if any.
    Unknown(Option<RelPath>),
    Gone,
}

/// Matches the catalog entries in the scope (`current`) to what the walk found. `added_ns`
/// dates new entries.
pub(super) fn plan(
    snapshot: &Snapshot,
    current: Vec<Entry>,
    rules: &VersioningRules,
    added_ns: impl Fn(&Metadata) -> i64,
) -> Plan {
    let on_disk = unique(
        snapshot
            .entries
            .iter()
            .filter_map(|(path, metadata)| Some((metadata.file_id.as_deref()?, path))),
    );
    let in_catalog = unique(
        current
            .iter()
            .filter_map(|entry| Some((entry.record.file_id.as_deref()?, &entry.record.path))),
    );

    // 1. By file id.
    let mut found: Vec<Found<'_>> = current.iter().map(|_| Found::Gone).collect();
    let mut claimed = HashSet::new();
    for (entry, found) in current.iter().zip(&mut found) {
        let Some(id) = entry.record.file_id.as_deref() else {
            continue;
        };
        if let (Some(_), Some(&path)) = (in_catalog.get(id), on_disk.get(id))
            && same_kind(&snapshot.entries[path], entry.record.kind)
        {
            *found = Found::At(path);
            claimed.insert(path);
        }
    }
    // Folders that moved by id carry their descendants along.
    let moved_folders: Moves = current
        .iter()
        .zip(&found)
        .filter_map(|(entry, found)| match found {
            Found::At(path)
                if entry.record.kind == EntryKind::Folder && **path != entry.record.path =>
            {
                Some((
                    entry.record.path.clone(),
                    ((*path).clone(), EntryKind::Folder),
                ))
            }
            _ => None,
        })
        .collect();
    // 2. By the path each entry should have now: below a folder that moved by id first, so
    //    they win over entries that stayed, then everything at its own path.
    for below_moved_folder in [true, false] {
        for (entry, found) in current.iter().zip(&mut found) {
            if !matches!(found, Found::Gone) {
                continue;
            }
            let moved = relocated(&moved_folders, &entry.record.path);
            if moved.is_some() != below_moved_folder {
                continue;
            }
            let expected = moved.as_ref().unwrap_or(&entry.record.path);
            if snapshot.is_unknown(expected) {
                *found = Found::Unknown(moved);
            } else if let Some((path, metadata)) = snapshot.entries.get_key_value(expected)
                && !claimed.contains(path)
                && same_kind(metadata, entry.record.kind)
            {
                *found = Found::At(path);
                claimed.insert(path);
            }
        }
    }

    let below_moved_folder = moved_under(&moved_folders);
    let mut plan = Plan::default();
    for (entry, found) in current.iter().zip(&found) {
        let old = &entry.record;
        let path = match found {
            Found::At(path) => *path,
            Found::Unknown(None) => continue,
            Found::Unknown(Some(moved)) => {
                plan.moved(entry.id, old, moved);
                continue;
            }
            Found::Gone => {
                plan.entries.removed.push((entry.id, old.path.clone()));
                plan.changes.push(Change::Removed(old.path.clone()));
                continue;
            }
        };
        let metadata = &snapshot.entries[path];
        let modified = old.kind == EntryKind::File
            && (old.size != metadata.size
                || old.mtime_ns != metadata.modified_ns
                || matches!((&old.file_id, &metadata.file_id), (Some(a), Some(b)) if a != b));
        let hash = if modified { None } else { old.hash.clone() };
        let record = record(path, metadata, rules, hash);
        if *path != old.path {
            plan.moved(entry.id, old, path);
        } else if !moved_folders.is_empty() && below_moved_folder(&old.path) {
            // Stayed below a folder that moved: a move to itself (`Plan::moves`).
            plan.moves
                .insert(old.path.clone(), (old.path.clone(), old.kind));
        }
        if modified {
            plan.changes.push(Change::Modified(path.clone()));
        }
        if !same_but_path(&record, old) {
            plan.entries.updated.push((entry.id, record));
        }
    }
    // Paths sort after their folders, so every new entry comes after its parent.
    for (path, metadata) in &snapshot.entries {
        if !claimed.contains(path) {
            let record = record(path, metadata, rules, None);
            plan.entries.added.push((record, added_ns(metadata)));
            plan.changes.push(Change::Added(path.clone()));
        }
    }
    plan
}

impl Plan {
    fn moved(&mut self, id: EntryId, old: &EntryRecord, to: &RelPath) {
        self.entries.moved.push((id, to.clone()));
        self.moves.insert(old.path.clone(), (to.clone(), old.kind));
        self.changes.push(Change::Moved {
            from: old.path.clone(),
            to: to.clone(),
        });
    }
}

/// The ids that occur once, with their paths. An id that occurs twice (hard links) pairs
/// nothing.
fn unique<'a>(ids: impl Iterator<Item = (&'a str, &'a RelPath)>) -> HashMap<&'a str, &'a RelPath> {
    let mut once = HashMap::new();
    let mut twice = HashSet::new();
    for (id, path) in ids {
        if once.insert(id, path).is_some() {
            twice.insert(id);
        }
    }
    once.retain(|id, _| !twice.contains(id));
    once
}

/// Whether two records differ in nothing but their paths.
fn same_but_path(a: &EntryRecord, b: &EntryRecord) -> bool {
    let EntryRecord {
        path: _,
        kind,
        class,
        size,
        mtime_ns,
        file_id,
        hash,
    } = a;
    (kind, class, size, mtime_ns, file_id, hash)
        == (&b.kind, &b.class, &b.size, &b.mtime_ns, &b.file_id, &b.hash)
}

fn same_kind(metadata: &Metadata, kind: EntryKind) -> bool {
    matches!(
        (metadata.kind, kind),
        (FileKind::File, EntryKind::File) | (FileKind::Folder, EntryKind::Folder)
    )
}

fn record(
    path: &RelPath,
    metadata: &Metadata,
    rules: &VersioningRules,
    hash: Option<ContentHash>,
) -> EntryRecord {
    let (kind, class, hash) = match metadata.kind {
        FileKind::Folder => (EntryKind::Folder, FileClass::Other, None),
        _ => (EntryKind::File, rules.class_of(path), hash),
    };
    EntryRecord {
        path: path.clone(),
        kind,
        class,
        size: metadata.size,
        mtime_ns: metadata.modified_ns,
        file_id: metadata.file_id.clone(),
        hash,
    }
}
