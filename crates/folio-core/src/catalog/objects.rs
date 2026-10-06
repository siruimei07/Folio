//! The packs of the local history and where each object is (versioning.md §4.3, §13.1): the
//! `packs` and `objects` tables. Like everything in the catalog they are derived, from the packs'
//! indexes, so they can be cleared and filled again at any time: [`clear_object_index`], then
//! [`add_pack`] for each pack in `.folio/local/packs/` (§13.2).
//!
//! The catalog keeps one location per object: an object that two packs hold is found in the pack
//! indexed first, as a [`MemoryIndex`](crate::store::MemoryIndex) finds it. [`CatalogLocator`] is
//! the [`Locator`] the store reads objects through.

use std::io;
use std::path::PathBuf;

use rusqlite::{Connection, OptionalExtension, params};

use super::CatalogError;
use crate::store::{Location, Locator, ObjectId, PackIndex, PackName, StoreError};

/// A pack the catalog indexes ([`indexed_packs`]).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct IndexedPack {
    pub name: PackName,
    /// The pack file's length in bytes.
    pub size: u64,
    /// How many objects the pack holds, those the catalog finds in another pack included.
    pub objects: usize,
}

/// Indexes `pack` (versioning.md §4.3): records it, and the location of each object it holds that
/// the catalog does not find in another pack. A pack indexed already is indexed again from `pack`,
/// as two packs of one name hold the same bytes, so its objects that lost their location (see
/// [`remove_pack`]) are found in it again.
pub fn add_pack(conn: &Connection, pack: &PackIndex) -> Result<(), CatalogError> {
    remove_pack(conn, pack.name())?;
    let name = pack.name().to_string();
    conn.prepare_cached("INSERT INTO packs (name, size, objects) VALUES (?1, ?2, ?3)")?
        .execute(params![name, pack.size(), pack.object_count()])?;
    // Only an object located already is passed over: any other row the table refuses is an error.
    let mut locate = conn.prepare_cached(
        "INSERT INTO objects (id, pack, offset) VALUES (?1, ?2, ?3) ON CONFLICT (id) DO NOTHING",
    )?;
    for entry in pack.entries() {
        locate.execute(params![entry.id, name, entry.offset])?;
    }
    Ok(())
}

/// Removes the pack `name` from the index, with the location of each object found in it, and
/// returns whether it was indexed. An object that another indexed pack holds too loses its location
/// as well, as the catalog keeps one per object: indexing that pack again finds it there. M2
/// removes only the packs of a first commit that crashed before its commit point (versioning.md
/// §7.5), which share no object with another pack.
pub fn remove_pack(conn: &Connection, name: PackName) -> Result<bool, CatalogError> {
    let removed = conn
        .prepare_cached("DELETE FROM packs WHERE name = ?1")?
        .execute([name])?;
    Ok(removed == 1)
}

/// Where the catalog finds `id`'s record, if an indexed pack holds it.
pub fn object_location(conn: &Connection, id: ObjectId) -> Result<Option<Location>, CatalogError> {
    let location = conn
        .prepare_cached("SELECT pack, offset FROM objects WHERE id = ?1")?
        .query_row([id], |row| {
            Ok(Location {
                pack: row.get(0)?,
                offset: row.get(1)?,
            })
        })
        .optional()?;
    Ok(location)
}

/// Whether the catalog finds `id` in an indexed pack: a writer stores only what it does not.
pub fn has_object(conn: &Connection, id: ObjectId) -> Result<bool, CatalogError> {
    Ok(conn
        .prepare_cached("SELECT EXISTS (SELECT 1 FROM objects WHERE id = ?1)")?
        .query_row([id], |row| row.get(0))?)
}

/// Every indexed pack, ascending by name.
pub fn indexed_packs(conn: &Connection) -> Result<Vec<IndexedPack>, CatalogError> {
    let packs = conn
        .prepare_cached("SELECT name, size, objects FROM packs ORDER BY name")?
        .query_map([], |row| {
            Ok(IndexedPack {
                name: row.get(0)?,
                size: row.get(1)?,
                objects: row.get(2)?,
            })
        })?
        .collect::<Result<_, _>>()?;
    Ok(packs)
}

/// Removes every pack and location, before the index is filled again from the packs (versioning.md
/// §13.2).
pub fn clear_object_index(conn: &Connection) -> Result<(), CatalogError> {
    // The locations first, all at once: removing the packs then cascades to nothing.
    conn.execute_batch("DELETE FROM objects; DELETE FROM packs;")?;
    Ok(())
}

/// The catalog as the store's [`Locator`] (versioning.md §4.3), in the caller's transaction, so
/// that the objects read and the packs indexed in one transaction agree:
/// `store.trees(CatalogLocator(tx))`.
#[derive(Debug, Clone, Copy)]
pub struct CatalogLocator<'a>(pub &'a Connection);

impl Locator for CatalogLocator<'_> {
    /// [`object_location`]. A catalog that fails to answer is [`StoreError::Io`] naming its
    /// database file, with the [`CatalogError`] as the source: Folio's own state on this computer
    /// failed, not the history. A caller tells it from a file's I/O error by downcasting the
    /// source, and maps it as a catalog error (ipc-m1 §16.2: `Internal`).
    fn locate(&self, id: ObjectId) -> Result<Option<Location>, StoreError> {
        object_location(self.0, id).map_err(|error| StoreError::Io {
            path: self.0.path().map(PathBuf::from).unwrap_or_default(),
            source: io::Error::other(error),
        })
    }
}

#[cfg(test)]
mod tests;
