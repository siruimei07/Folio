//! Why the hashing pass left a file unhashed (versioning.md §6.2): the `unhashed` table.
//!
//! The catalog keeps no presence and the hashing pass reports a file it cannot read only to the
//! shell, yet the workspace needs each file's readiness, in catalog transactions, to list it, count
//! it and fingerprint it (lane decision 3). So the pass records here each file whose content is not
//! on this disk (`not_local`) or that it could not read (`unreadable`), with the entry's size,
//! modification time and file id at the time ([`record_unhashed`]), and removes the row when it
//! stores the file's hash ([`clear_unhashed`]).
//!
//! A row holds while its entry has no hash and the size, modification time and file id it was
//! recorded with: once the scan sees the file change, the row is stale and the file is waiting
//! for the hashing pass again, until that pass records it anew. Readers check this with
//! [`VALID`]; nothing removes a stale row but the next pass or the entry's removal (the reference
//! cascades).

use rusqlite::{Connection, OptionalExtension, params};

use super::{CatalogError, Entry, EntryId};
use crate::workspace::Blocked;

/// Whether the `unhashed` row `u` holds for the entry `e`: the entry has no hash, and the size,
/// modification time and file id the row was recorded with. For a join of `entries AS e` with
/// `unhashed AS u` on `u.entry_id = e.id`.
pub(super) const VALID: &str = "e.hash IS NULL AND u.size = e.size AND u.mtime_ns IS e.mtime_ns
    AND u.file_id IS e.file_id";

/// The `reason` column's word for `blocked`.
fn word(blocked: Blocked) -> &'static str {
    match blocked {
        Blocked::NotLocal => "not_local",
        Blocked::Unreadable => "unreadable",
    }
}

/// The reason a `reason` column holds.
pub(super) fn reason(word: &str) -> rusqlite::Result<Blocked> {
    match word {
        "not_local" => Ok(Blocked::NotLocal),
        "unreadable" => Ok(Blocked::Unreadable),
        other => Err(rusqlite::Error::FromSqlConversionFailure(
            0,
            rusqlite::types::Type::Text,
            format!("unknown unhashed reason {other:?}").into(),
        )),
    }
}

/// Records why the hashing pass left `file` unhashed, if the entry still has no hash and the path,
/// size, modification time and file id it was read with. Returns whether a row changed: recording
/// what the row says already changes nothing, so the catalog's revision stays.
pub fn record_unhashed(
    conn: &Connection,
    file: &Entry,
    blocked: Blocked,
) -> Result<bool, CatalogError> {
    let record = &file.record;
    // The `WHERE` of the `SELECT` also settles the upsert's parsing ambiguity.
    let changed = conn
        .prepare_cached(
            "INSERT INTO unhashed (entry_id, reason, size, mtime_ns, file_id)
             SELECT id, ?2, size, mtime_ns, file_id FROM entries
             WHERE id = ?1 AND hash IS NULL AND kind = 'file' AND size = ?3 AND mtime_ns IS ?4
               AND file_id IS ?5 AND path = ?6
             ON CONFLICT (entry_id) DO UPDATE
             SET reason = excluded.reason, size = excluded.size, mtime_ns = excluded.mtime_ns,
                 file_id = excluded.file_id
             WHERE unhashed.reason <> excluded.reason OR unhashed.size <> excluded.size
                OR unhashed.mtime_ns IS NOT excluded.mtime_ns
                OR unhashed.file_id IS NOT excluded.file_id",
        )?
        .execute(params![
            file.id.0,
            word(blocked),
            record.size,
            record.mtime_ns,
            record.file_id,
            record.path
        ])?;
    Ok(changed == 1)
}

/// Removes the row of `entry`, once its hash is stored; returns whether there was one.
pub fn clear_unhashed(conn: &Connection, entry: EntryId) -> Result<bool, CatalogError> {
    let removed = conn
        .prepare_cached("DELETE FROM unhashed WHERE entry_id = ?1")?
        .execute([entry.0])?;
    Ok(removed == 1)
}

/// Why the hashing pass left `entry` unhashed, if a row says so and holds for the entry as it is
/// now; `None` while the pass has yet to reach it, or once it is hashed.
pub fn unhashed_reason(conn: &Connection, entry: EntryId) -> Result<Option<Blocked>, CatalogError> {
    let word: Option<String> = conn
        .prepare_cached(&format!(
            "SELECT u.reason FROM unhashed AS u JOIN entries AS e ON e.id = u.entry_id
             WHERE u.entry_id = ?1 AND {VALID}"
        ))?
        .query_row([entry.0], |row| row.get(0))
        .optional()?;
    Ok(word.as_deref().map(reason).transpose()?)
}

#[cfg(test)]
mod tests;
