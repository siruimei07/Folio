//! What extracting the text of each text and Word file gave (versioning.md §10.2–§10.3,
//! docs/specs/library-core.md §5.2): the `extracts` table. The text itself is the body of the
//! entry's `search` row, which [`record_extract`] and [`record_extracts`] set with the row.
//!
//! A row keeps the entry's hash and class it was extracted from and the extractor's version, so a
//! file is extracted again only when one of them changes ([`pending_extracts`]). Failures are kept
//! the same way, and tried again only then. Every write is guarded by the entry's id, hash and
//! class, so a file deleted or changed while it was read is passed over, never an error. A row goes
//! with its entry (a cascading reference), and with its search body when the entry stops being a
//! text or Word file (the trigger `entries_not_extractable`, in the same write).

use rusqlite::{Connection, named_params, params};

use super::entries::{COLUMNS, from_row};
use super::fulltext::set_body;
use super::{CatalogError, Entry, EntryId};
use crate::meta::{EntryKind, FileClass};
use crate::paths::RelPath;

/// The most characters of a failure's detail kept.
const MAX_DETAIL_CHARS: usize = 500;

/// The entries the extractor reads: hashed text and Word files. For a query on `entries` alone;
/// the partial index `entries_extractable` has the same condition, which SQLite needs to see in a
/// query to use it.
const EXTRACTABLE: &str = "kind = 'file' AND class IN ('text', 'word') AND hash IS NOT NULL";

/// An `extracts` row that holds for its entry as it is now, derived by the extractor `:version`.
const CURRENT: &str = "extracts.entry_id = entries.id AND extracts.hash = entries.hash
    AND extracts.class = entries.class AND extracts.version = :version";

/// The failed rows. The partial index `extracts_failed` has the same condition, which SQLite needs
/// to see in a query to use it.
const FAILED: &str = "extracts.status = 'failed'";

/// Why the text of a file could not be extracted (the `failure` column): what the file's content
/// decides. A reading that fails, or runs out of time, is not recorded and is tried again.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExtractFailure {
    /// The file is not what its class says, or is a kind the extractor refuses: not a ZIP, no main
    /// part, bad XML, a DTD, an unknown entity, an encrypted or unsupported entry.
    Invalid,
    /// Over a cap: expanded bytes, entries or nesting.
    TooLarge,
}

/// What extracting a file's text gave, to record with [`record_extract`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ExtractState {
    /// The file's text, its search body; the catalog keeps the first
    /// [`MAX_BODY_BYTES`](super::MAX_BODY_BYTES).
    Text(String),
    /// No text: an empty file, or nothing but white space.
    Empty,
    /// Not text: a NUL in the first 8 KiB without a byte order mark.
    Binary,
    /// Generated, like a lockfile or a minified file: not worth searching.
    Skipped,
    /// The text could not be read. `detail` says why, for logs; the catalog keeps its first 500
    /// characters.
    Failed {
        failure: ExtractFailure,
        detail: String,
    },
}

impl ExtractState {
    /// The `status` column.
    fn status(&self) -> &'static str {
        match self {
            Self::Text(_) => "text",
            Self::Empty => "empty",
            Self::Binary => "binary",
            Self::Skipped => "skipped",
            Self::Failed { .. } => "failed",
        }
    }
}

/// A file whose text could not be extracted, as its current content and class are
/// ([`failed_extracts`]).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FailedExtract {
    pub path: RelPath,
    pub failure: ExtractFailure,
    pub detail: String,
}

/// Up to `limit` files above `after` whose text the extractor `version` has still to extract, by
/// id: hashed text and Word files without a row, or whose row has another hash, class or version.
/// Never folders, other files or files without a hash.
pub fn pending_extracts(
    conn: &Connection,
    after: EntryId,
    limit: u32,
    version: u32,
) -> Result<Vec<Entry>, CatalogError> {
    let mut statement = conn.prepare_cached(&format!(
        "SELECT {COLUMNS} FROM entries
         WHERE {EXTRACTABLE} AND id > :after AND NOT EXISTS (SELECT 1 FROM extracts WHERE {CURRENT})
         ORDER BY id LIMIT :limit"
    ))?;
    let rows = statement.query_map(
        named_params! {":after": after.0, ":limit": limit, ":version": version},
        from_row,
    )?;
    Ok(rows.collect::<Result<_, _>>()?)
}

/// How many files [`pending_extracts`] has still to give for `version`.
///
/// With nothing pending this is most of a pass's work, so it reads the extractable entries (from
/// the covering index `entries_extractable`) and the rows, both in id order, and pairs them here.
/// Looking up each entry's row instead overflows SQLite's page cache on a large library: 85 ms
/// against 5 for 21,600 files.
pub fn count_pending_extracts(conn: &Connection, version: u32) -> Result<u64, CatalogError> {
    let (entries, rows) = count_queries();
    let mut entries = conn.prepare_cached(&entries)?;
    let mut entries = entries.query([])?;
    let mut rows = conn.prepare_cached(&rows)?;
    let mut rows = rows.query([])?;
    // The row with the smallest entry id not below the entries read so far, if any is left.
    let mut row: Option<(i64, String, String, i64)> = None;
    let mut rows_left = true;
    let mut pending = 0;
    while let Some(entry) = entries.next()? {
        let (id, hash, class): (i64, String, String) =
            (entry.get(0)?, entry.get(1)?, entry.get(2)?);
        // Rows of entries that are not extractable now, such as unhashed ones, are passed over.
        while rows_left && row.as_ref().is_none_or(|(entry_id, ..)| *entry_id < id) {
            row = match rows.next()? {
                Some(next) => Some((next.get(0)?, next.get(1)?, next.get(2)?, next.get(3)?)),
                None => {
                    rows_left = false;
                    None
                }
            };
        }
        let current = matches!(&row, Some((entry_id, row_hash, row_class, at))
            if *entry_id == id && *row_hash == hash && *row_class == class
                && *at == i64::from(version));
        pending += u64::from(!current);
    }
    Ok(pending)
}

/// [`count_pending_extracts`]'s two scans: the extractable entries and the rows, by id.
fn count_queries() -> (String, String) {
    (
        format!("SELECT id, hash, class FROM entries WHERE {EXTRACTABLE} ORDER BY id"),
        "SELECT entry_id, hash, class, version FROM extracts ORDER BY entry_id".to_owned(),
    )
}

/// Records what the extractor `version` gave for `file`, and sets its search body to the text, or
/// clears it, if the entry still has the id, hash and class `file` has; returns whether it did. An
/// entry that is gone or changed keeps its row and its body, for the next pass to extract again.
/// `file` must be a hashed text or Word file, as [`pending_extracts`] gives them.
pub fn record_extract(
    conn: &Connection,
    file: &Entry,
    version: u32,
    state: &ExtractState,
) -> Result<bool, CatalogError> {
    Ok(record_extracts(conn, version, &[(file, state)])?[0])
}

/// [`record_extract`] for many files at once; returns whether each was recorded.
///
/// Every row is written before any body. Each row's insert opens a statement savepoint (the table
/// has a foreign key), and FTS5 writes what it holds at each savepoint as a new index segment: a
/// body between two rows would cost a segment, and the merges that follow it, per file, which
/// grows with the index (a first pass over 21,600 files took minutes instead of seconds).
pub fn record_extracts(
    conn: &Connection,
    version: u32,
    outcomes: &[(&Entry, &ExtractState)],
) -> Result<Vec<bool>, CatalogError> {
    let recorded = outcomes
        .iter()
        .map(|(file, state)| record_row(conn, file, version, state))
        .collect::<Result<Vec<_>, _>>()?;
    for ((file, state), _) in outcomes.iter().zip(&recorded).filter(|(_, done)| **done) {
        let body = match state {
            ExtractState::Text(text) => Some(text.as_str()),
            _ => None,
        };
        set_body(conn, file.id, body)?;
    }
    Ok(recorded)
}

/// The guarded row write of [`record_extracts`]; whether the entry still had `file`'s id, hash
/// and class.
fn record_row(
    conn: &Connection,
    file: &Entry,
    version: u32,
    state: &ExtractState,
) -> Result<bool, CatalogError> {
    let record = &file.record;
    let (EntryKind::File, FileClass::Text | FileClass::Word, Some(hash)) =
        (record.kind, record.class, &record.hash)
    else {
        return Err(CatalogError::Invalid(format!(
            "entry {} is not a hashed text or Word file",
            file.id
        )));
    };
    let (failure, detail) = match state {
        ExtractState::Failed { failure, detail } => (Some(*failure), Some(cut_detail(detail))),
        _ => (None, None),
    };
    // `WHERE` before `ON CONFLICT` also keeps SQLite from reading `ON` as part of a join.
    let changed = conn
        .prepare_cached(
            "INSERT INTO extracts (entry_id, hash, class, version, status, failure, detail)
             SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7
             WHERE EXISTS (
                 SELECT 1 FROM entries WHERE id = ?1 AND kind = 'file' AND hash = ?2 AND class = ?3)
             ON CONFLICT (entry_id) DO UPDATE SET
                 hash = excluded.hash, class = excluded.class, version = excluded.version,
                 status = excluded.status, failure = excluded.failure, detail = excluded.detail",
        )?
        .execute(params![
            file.id.0,
            hash,
            record.class,
            version,
            state.status(),
            failure,
            detail
        ])?;
    Ok(changed != 0)
}

/// The first [`MAX_DETAIL_CHARS`] characters of `detail`.
fn cut_detail(detail: &str) -> &str {
    detail
        .char_indices()
        .nth(MAX_DETAIL_CHARS)
        .map_or(detail, |(end, _)| &detail[..end])
}

/// The files whose text could not be extracted, by path: the failed rows that hold for their
/// entry's current hash and class and were derived by the extractor `version`, so exactly the
/// failures [`pending_extracts`] does not give to extract again.
pub fn failed_extracts(
    conn: &Connection,
    version: u32,
) -> Result<Vec<FailedExtract>, CatalogError> {
    let mut statement = conn.prepare_cached(&failed_query())?;
    let rows = statement.query_map(named_params! {":version": version}, |row| {
        Ok(FailedExtract {
            path: row.get(0)?,
            failure: row.get(1)?,
            detail: row.get(2)?,
        })
    })?;
    Ok(rows.collect::<Result<_, _>>()?)
}

/// [`failed_extracts`]'s query, which reads only the failed rows through their partial index.
fn failed_query() -> String {
    format!(
        "SELECT entries.path, extracts.failure, extracts.detail
         FROM extracts JOIN entries ON {CURRENT}
         WHERE {FAILED}
         ORDER BY entries.path"
    )
}

#[cfg(test)]
mod tests;
