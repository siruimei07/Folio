//! Files and folders (docs/specs/library-core.md §5.2, library-scan.md §6.3). Every entry has a
//! row in `search` with the same id; these functions keep the two in step.

use std::collections::HashMap;
use std::fmt;

use rusqlite::{Connection, OptionalExtension, Row, params};

use super::{BELOW, CatalogError};
use crate::hash::ContentHash;
use crate::meta::{EntryKind, FileClass};
use crate::paths::{PathKey, RelPath};

/// An entry's row id: stable while the entry exists, and the rowid of its search row.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct EntryId(pub i64);

impl fmt::Display for EntryId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.fmt(f)
    }
}

/// What a scan knows about an entry.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EntryRecord {
    pub path: RelPath,
    pub kind: EntryKind,
    pub class: FileClass,
    /// Bytes; 0 for folders.
    pub size: u64,
    /// Modification time in nanoseconds since the Unix epoch; a hint only (ADR-0003 §10).
    pub mtime_ns: Option<i64>,
    /// The file system's id for the file, used to pair renames; opaque.
    pub file_id: Option<String>,
    pub hash: Option<ContentHash>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Entry {
    pub id: EntryId,
    pub record: EntryRecord,
    /// When the entry came into the library as far as Folio knows, in nanoseconds since the
    /// Unix epoch, for "recently added" (docs/specs/library-scan.md §6.3).
    pub added_ns: i64,
}

pub(super) const COLUMNS: &str = "id, path, kind, class, size, mtime_ns, file_id, hash, added_ns";

pub(super) fn from_row(row: &Row<'_>) -> rusqlite::Result<Entry> {
    Ok(Entry {
        id: EntryId(row.get(0)?),
        record: EntryRecord {
            path: row.get(1)?,
            kind: row.get(2)?,
            class: row.get(3)?,
            size: row.get(4)?,
            mtime_ns: row.get(5)?,
            file_id: row.get(6)?,
            hash: row.get(7)?,
        },
        added_ns: row.get(8)?,
    })
}

/// Inserts the entry at `record.path`, added at `added_ns`, or updates it and keeps its id and
/// the time it was added. A new entry's parent folder must already be in the catalog. A folder
/// that becomes a file loses its descendants.
pub fn upsert_entry(
    conn: &Connection,
    record: &EntryRecord,
    added_ns: i64,
) -> Result<EntryId, CatalogError> {
    let existing = conn
        .prepare_cached("SELECT id, kind FROM entries WHERE path = ?1")?
        .query_row([&record.path], |row| {
            Ok((EntryId(row.get(0)?), row.get::<_, EntryKind>(1)?))
        })
        .optional()?;
    match existing {
        Some((id, kind)) => {
            if kind == EntryKind::Folder && record.kind == EntryKind::File {
                delete_where(conn, BELOW, &record.path)?;
            }
            update_entry(conn, id, record)?;
            Ok(id)
        }
        None => {
            let parent = record
                .path
                .parent()
                .map(|folder| folder_id(conn, &folder))
                .transpose()?;
            insert_entry(conn, record, added_ns, parent)
        }
    }
}

/// Inserts a new entry and its search row below `parent_id`, the id of its parent folder.
fn insert_entry(
    conn: &Connection,
    record: &EntryRecord,
    added_ns: i64,
    parent_id: Option<i64>,
) -> Result<EntryId, CatalogError> {
    let folder = record.path.parent();
    // No `RETURNING`: it makes SQLite open a statement journal, and with it FTS5 flushes its
    // pending terms on every insert, which slows a full scan down about twenty times.
    let id = conn
        .prepare_cached(
            "INSERT INTO entries (path, path_key, parent_id, name, kind, class, size, mtime_ns,
                                  file_id, hash, added_ns)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
        )?
        .insert(params![
            record.path,
            record.path.key().as_str(),
            parent_id,
            record.path.name(),
            record.kind,
            record.class,
            record.size,
            record.mtime_ns,
            record.file_id,
            record.hash,
            added_ns
        ])?;
    conn.prepare_cached(
        "INSERT INTO search (rowid, name, path, tags, body) VALUES (?1, ?2, ?3, '', NULL)",
    )?
    .execute(params![
        id,
        record.path.name(),
        folder.as_ref().map_or("", RelPath::as_str)
    ])?;
    Ok(EntryId(id))
}

/// Replaces everything but the path of an entry and the time it was added.
fn update_entry(conn: &Connection, id: EntryId, record: &EntryRecord) -> Result<(), CatalogError> {
    let changed = conn
        .prepare_cached(
            "UPDATE entries
             SET kind = ?2, class = ?3, size = ?4, mtime_ns = ?5, file_id = ?6, hash = ?7
             WHERE id = ?1",
        )?
        .execute(params![
            id.0,
            record.kind,
            record.class,
            record.size,
            record.mtime_ns,
            record.file_id,
            record.hash
        ])?;
    if changed == 0 {
        return Err(CatalogError::NoEntry(id));
    }
    Ok(())
}

/// Removes the entry at `path` and everything below it; returns how many entries went.
pub fn delete_entry(conn: &Connection, path: &RelPath) -> Result<usize, CatalogError> {
    Ok(delete_where(conn, &format!("path = ?1 OR {BELOW}"), path)?)
}

/// Deletes the entries that `condition` selects for `?1` = `path`, and returns how many. A
/// trigger removes their search rows; no foreign key cascades, so the count is exact.
fn delete_where(conn: &Connection, condition: &str, path: &RelPath) -> rusqlite::Result<usize> {
    conn.execute(&format!("DELETE FROM entries WHERE {condition}"), [path])
}

/// What a scan changes, applied together by [`apply_changes`].
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct EntryChanges {
    /// Entries now at another path, descendants of a moved folder included.
    pub moved: Vec<(EntryId, RelPath)>,
    /// Entries that are gone, descendants included; they may come in any order.
    pub removed: Vec<(EntryId, RelPath)>,
    /// New entries and when they were added, each after its parent folder unless that is
    /// already in the catalog.
    pub added: Vec<(EntryRecord, i64)>,
    /// New metadata for entries, at their new path if they moved. The kind must not change.
    pub updated: Vec<(EntryId, EntryRecord)>,
}

/// Applies a scan's changes in an order that keeps `UNIQUE(path)` and the `parent_id` foreign
/// key intact, and gives every entry the folder entry at its parent path (docs/specs/
/// library-scan.md §6.3).
pub fn apply_changes(conn: &Connection, changes: &EntryChanges) -> Result<(), CatalogError> {
    // Entries that stay where they are while their folder entry moves or goes: another entry
    // may take the folder's path, say one renamed to its name.
    let leaving = id_list(changes.moved.iter().chain(&changes.removed));
    let staying: Vec<(EntryId, RelPath)> = conn
        .prepare_cached(
            "SELECT id, path FROM entries
             WHERE parent_id IN (SELECT value FROM json_each(?1))
               AND id NOT IN (SELECT value FROM json_each(?1))",
        )?
        .query_map([&leaving], |row| Ok((EntryId(row.get(0)?), row.get(1)?)))?
        .collect::<Result<_, _>>()?;

    // Out of the way first: a temporary path that is never a valid one, and no parent, so
    // neither swaps nor removals of the old parent get in the way.
    let mut park = conn.prepare_cached(
        "UPDATE entries SET path = char(1) || id, parent_id = NULL WHERE id = ?1",
    )?;
    for (id, _) in &changes.moved {
        if park.execute([id.0])? == 0 {
            return Err(CatalogError::NoEntry(*id));
        }
    }
    let mut detach = conn.prepare_cached("UPDATE entries SET parent_id = NULL WHERE id = ?1")?;
    for (id, _) in &staying {
        detach.execute([id.0])?;
    }

    // One statement for all: one per entry would make FTS5 flush the search rows the trigger
    // deletes every time, about a millisecond each. SQLite checks the foreign key at the end of
    // the statement, so the order of parents and children does not matter.
    if !changes.removed.is_empty() {
        let ids = id_list(&changes.removed);
        let missing = conn
            .prepare_cached(
                "SELECT value FROM json_each(?1) WHERE value NOT IN (SELECT id FROM entries)",
            )?
            .query_row([&ids], |row| row.get(0))
            .optional()?;
        if let Some(missing) = missing {
            return Err(CatalogError::NoEntry(EntryId(missing)));
        }
        conn.prepare_cached("DELETE FROM entries WHERE id IN (SELECT value FROM json_each(?1))")?
            .execute([&ids])?;
    }

    let mut relocate = conn
        .prepare_cached("UPDATE entries SET path = ?2, path_key = ?3, name = ?4 WHERE id = ?1")?;
    let mut rename_search =
        conn.prepare_cached("UPDATE search SET name = ?2, path = ?3 WHERE rowid = ?1")?;
    for (id, path) in &changes.moved {
        relocate.execute(params![id.0, path, path.key().as_str(), path.name()])?;
        let folder = path.parent();
        rename_search.execute(params![
            id.0,
            path.name(),
            folder.as_ref().map_or("", RelPath::as_str)
        ])?;
    }

    // The ids of the folders added so far, so that their children need no lookup.
    let mut added = HashMap::new();
    for (record, added_ns) in &changes.added {
        let parent = match record.path.parent() {
            None => None,
            Some(folder) => Some(match added.get(&folder) {
                Some(id) => *id,
                None => folder_id(conn, &folder)?,
            }),
        };
        let id = insert_entry(conn, record, *added_ns, parent)?;
        if record.kind == EntryKind::Folder {
            added.insert(record.path.clone(), id.0);
        }
    }

    // Every folder is at its final path now.
    let mut reparent = conn.prepare_cached("UPDATE entries SET parent_id = ?2 WHERE id = ?1")?;
    for (id, path) in changes.moved.iter().chain(&staying) {
        let parent = path
            .parent()
            .map(|folder| folder_id(conn, &folder))
            .transpose()?;
        reparent.execute(params![id.0, parent])?;
    }

    for (id, record) in &changes.updated {
        update_entry(conn, *id, record)?;
    }
    Ok(())
}

/// The ids of `entries` as a JSON array, for `json_each`.
fn id_list<'a>(entries: impl IntoIterator<Item = &'a (EntryId, RelPath)>) -> String {
    let ids: Vec<i64> = entries.into_iter().map(|(id, _)| id.0).collect();
    serde_json::to_string(&ids).expect("numbers always serialize")
}

pub fn entry_by_id(conn: &Connection, id: EntryId) -> Result<Option<Entry>, CatalogError> {
    Ok(conn
        .prepare_cached(&format!("SELECT {COLUMNS} FROM entries WHERE id = ?1"))?
        .query_row([id.0], from_row)
        .optional()?)
}

/// Whether the catalog has no entries, like a new or a replaced one.
pub fn has_no_entries(conn: &Connection) -> Result<bool, CatalogError> {
    Ok(conn
        .prepare_cached("SELECT NOT EXISTS (SELECT 1 FROM entries)")?
        .query_row([], |row| row.get(0))?)
}

pub fn entry(conn: &Connection, path: &RelPath) -> Result<Option<Entry>, CatalogError> {
    Ok(conn
        .prepare_cached(&format!("SELECT {COLUMNS} FROM entries WHERE path = ?1"))?
        .query_row([path], from_row)
        .optional()?)
}

/// The entries whose paths differ from `key`'s only in case, usually one.
pub fn entries_with_key(conn: &Connection, key: &PathKey) -> Result<Vec<Entry>, CatalogError> {
    let mut statement = conn.prepare_cached(&format!(
        "SELECT {COLUMNS} FROM entries WHERE path_key = ?1 ORDER BY path"
    ))?;
    let rows = statement.query_map([key.as_str()], from_row)?;
    Ok(rows.collect::<Result<_, _>>()?)
}

/// `folder` and everything below it, or every entry for `None`, by path.
pub fn entries_in(conn: &Connection, folder: Option<&RelPath>) -> Result<Vec<Entry>, CatalogError> {
    let entries = match folder {
        None => conn
            .prepare_cached(&format!("SELECT {COLUMNS} FROM entries ORDER BY path"))?
            .query_map([], from_row)?
            .collect::<Result<_, _>>()?,
        Some(folder) => conn
            .prepare_cached(&format!(
                "SELECT {COLUMNS} FROM entries WHERE path = ?1 OR {BELOW} ORDER BY path"
            ))?
            .query_map([folder], from_row)?
            .collect::<Result<_, _>>()?,
    };
    Ok(entries)
}

/// The entries directly in `folder`, or at the library root for `None`, by name.
pub fn children(conn: &Connection, folder: Option<&RelPath>) -> Result<Vec<Entry>, CatalogError> {
    let parent_id = folder.map(|folder| folder_id(conn, folder)).transpose()?;
    let mut statement = conn.prepare_cached(&format!(
        "SELECT {COLUMNS} FROM entries WHERE parent_id IS ?1 ORDER BY name"
    ))?;
    let rows = statement.query_map([parent_id], from_row)?;
    Ok(rows.collect::<Result<_, _>>()?)
}

fn folder_id(conn: &Connection, folder: &RelPath) -> Result<i64, CatalogError> {
    conn.prepare_cached("SELECT id FROM entries WHERE path = ?1 AND kind = 'folder'")?
        .query_row([folder], |row| row.get(0))
        .optional()?
        .ok_or_else(|| CatalogError::MissingParent(folder.clone()))
}

/// The files the hashing pass still has to read. The partial index `entries_unhashed` has the
/// same condition, which SQLite needs to see in a query to use it.
const UNHASHED: &str = "hash IS NULL AND kind = 'file'";

/// Up to `limit` files without a hash whose id is above `after`, by id: the hashing pass's work
/// (docs/specs/library-scan.md §8).
pub fn unhashed_files(
    conn: &Connection,
    after: EntryId,
    limit: u32,
) -> Result<Vec<Entry>, CatalogError> {
    let mut statement = conn.prepare_cached(&format!(
        "SELECT {COLUMNS} FROM entries WHERE {UNHASHED} AND id > ?1 ORDER BY id LIMIT ?2"
    ))?;
    let rows = statement.query_map(params![after.0, limit], from_row)?;
    Ok(rows.collect::<Result<_, _>>()?)
}

pub fn count_unhashed_files(conn: &Connection) -> Result<u64, CatalogError> {
    Ok(conn
        .prepare_cached(&format!("SELECT count(*) FROM entries WHERE {UNHASHED}"))?
        .query_row([], |row| row.get(0))?)
}

/// Stores the hash of `file` if the entry still has no hash and the size, modification time
/// and file id it was hashed with; returns whether it did.
pub fn set_hash(conn: &Connection, file: &Entry, hash: &ContentHash) -> Result<bool, CatalogError> {
    let record = &file.record;
    let changed = conn
        .prepare_cached(&format!(
            "UPDATE entries SET hash = ?2
             WHERE id = ?1 AND {UNHASHED} AND size = ?3 AND mtime_ns IS ?4 AND file_id IS ?5"
        ))?
        .execute(params![
            file.id.0,
            hash,
            record.size,
            record.mtime_ns,
            record.file_id
        ])?;
    Ok(changed == 1)
}

/// Recomputes every `path_key` after `PATHS_VERSION` changed. Reading the paths checks them
/// against the current rules too.
pub(super) fn recompute_path_keys(conn: &Connection) -> rusqlite::Result<()> {
    let mut select = conn.prepare("SELECT id, path FROM entries")?;
    let paths = select
        .query_map([], |row| {
            Ok((row.get::<_, i64>(0)?, row.get::<_, RelPath>(1)?))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    let mut update = conn.prepare("UPDATE entries SET path_key = ?2 WHERE id = ?1")?;
    for (id, path) in paths {
        update.execute(params![id, path.key().as_str()])?;
    }
    Ok(())
}
