//! Files and folders (docs/specs/library-core.md §5.2). Every entry has a row in `search` with
//! the same id; these functions keep the two in step.

use std::fmt;

use rusqlite::{Connection, OptionalExtension, Row, params};

use super::{BELOW, CatalogError};
use crate::hash::ContentHash;
use crate::meta::{EntryKind, FileClass};
use crate::paths::RelPath;

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
    /// When the catalog first saw the entry, in seconds since the Unix epoch.
    pub first_seen_at: i64,
}

pub(super) const COLUMNS: &str =
    "id, path, kind, class, size, mtime_ns, file_id, hash, first_seen_at";

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
        first_seen_at: row.get(8)?,
    })
}

/// Inserts the entry at `record.path`, or updates it and keeps its id and `first_seen_at`. A new
/// entry's parent folder must already be in the catalog. A folder that becomes a file loses its
/// descendants.
pub fn upsert_entry(
    conn: &Connection,
    record: &EntryRecord,
    now: i64,
) -> Result<EntryId, CatalogError> {
    let existing = conn
        .prepare_cached("SELECT id, kind FROM entries WHERE path = ?1")?
        .query_row([&record.path], |row| {
            Ok((row.get::<_, i64>(0)?, row.get::<_, EntryKind>(1)?))
        })
        .optional()?;
    if let Some((id, kind)) = existing {
        if kind == EntryKind::Folder && record.kind == EntryKind::File {
            delete_where(conn, BELOW, &record.path)?;
        }
        conn.prepare_cached(
            "UPDATE entries
             SET kind = ?2, class = ?3, size = ?4, mtime_ns = ?5, file_id = ?6, hash = ?7
             WHERE id = ?1",
        )?
        .execute(params![
            id,
            record.kind,
            record.class,
            record.size,
            record.mtime_ns,
            record.file_id,
            record.hash
        ])?;
        return Ok(EntryId(id));
    }

    let folder = record.path.parent();
    let parent_id = folder
        .as_ref()
        .map(|folder| folder_id(conn, folder))
        .transpose()?;
    // No `RETURNING`: it makes SQLite open a statement journal, and with it FTS5 flushes its
    // pending terms on every insert, which slows a full scan down about twenty times.
    let id = conn
        .prepare_cached(
            "INSERT INTO entries (path, path_key, parent_id, name, kind, class, size, mtime_ns,
                                  file_id, hash, first_seen_at)
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
            now
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

/// Removes the entry at `path` and everything below it; returns how many entries went.
pub fn delete_entry(conn: &Connection, path: &RelPath) -> Result<usize, CatalogError> {
    Ok(delete_where(conn, &format!("path = ?1 OR {BELOW}"), path)?)
}

/// Deletes the entries that `condition` selects for `?1` = `path`, and returns how many. A
/// trigger removes their search rows; no foreign key cascades, so the count is exact.
fn delete_where(conn: &Connection, condition: &str, path: &RelPath) -> rusqlite::Result<usize> {
    conn.execute(&format!("DELETE FROM entries WHERE {condition}"), [path])
}

pub fn entry(conn: &Connection, path: &RelPath) -> Result<Option<Entry>, CatalogError> {
    Ok(conn
        .prepare_cached(&format!("SELECT {COLUMNS} FROM entries WHERE path = ?1"))?
        .query_row([path], from_row)
        .optional()?)
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
