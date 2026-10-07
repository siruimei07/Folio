//! `HEAD`'s tree in the catalog (versioning.md §6.1, §13.1): the `head_files` table, each path of
//! the tree paired with the catalog entry that *is* that file or folder, and what the workspace
//! reads of it.
//!
//! - [`insert_head_files`] writes the rows of a flattened tree, `.folio/` included, with each
//!   folder's tree id, in runs of short writes after [`clear_head_files`]; [`set_history_marks`]
//!   then records the `HEAD` they hold and the version of the code that derived them (`info`'s
//!   `history_head` and `history_version`), so that rows without marks are derived again.
//! - Pairing: an entry's id survives moves and saves, so its row stays paired. Removing the entry
//!   unpairs the row (the reference sets it to null, inside the `DELETE` the scan runs anyway), and
//!   [`pair_by_path`] pairs each row without an entry with the entry at exactly its path, of its
//!   kind, that no row pairs with: a file deleted and created again, a catalog rebuilt. No trigger
//!   on `entries` does this (lane decision 2): one would make every insert of a scan flush the
//!   full-text index's pending terms.
//! - [`comparison`] is the workspace's read of the two (versioning.md §6.3): the paired rows whose
//!   entries differ from them or that lie below a folder row that is not in place, the rows without
//!   an entry, and the entries no row pairs with, each entry with whether it is an empty folder and
//!   why it is unhashed ([`unhashed`](super::unhashed)).
//! - [`comparison_and_tags`] adds, in the same pass, the tagged entries, which with
//!   [`group_folders`] are the pairing the metadata comparison follows (versioning.md §6.4).

use std::collections::{BTreeSet, HashMap, HashSet};

use rusqlite::types::ValueRef;
use rusqlite::{Connection, OptionalExtension, Row, params};

use super::unhashed::{self, VALID};
use super::{CatalogError, EntryId, object_location};
use crate::hash::ContentHash;
use crate::meta::{EntryKind, TagId};
use crate::paths::RelPath;
use crate::store::{ObjectId, PackIndex, Side};
use crate::workspace::{Comparison, DiskRow, HeadFile, HeadRow, PairedEntry};

/// The version of the code that derives the catalog's history tables from `HEAD` (versioning.md
/// §13.1): `head_files` today. A catalog that holds another version's rows derives them again,
/// as a new `tokenizer_version` makes the search index tokenize again.
pub const HISTORY_VERSION: u32 = 1;

/// `info` keys: the `HEAD` the history tables hold, and the version that derived them.
const HISTORY_HEAD: &str = "history_head";
const HISTORY_VERSION_KEY: &str = "history_version";

/// `info` key: the digest of what the workspace last read of the disk's `.folio/` files that the
/// catalog does not mirror (`library.json`, `ignore`, the metadata files that do not read).
const DISK_FILES: &str = "workspace_disk_files";

/// Pairs each row without an entry with the entry at exactly its path and of its kind that no row
/// pairs with (versioning.md §6.1); [`insert_head_files`] adds a range of paths to it.
const PAIR_BY_PATH: &str = "UPDATE head_files SET entry_id = e.id FROM entries AS e
     WHERE head_files.entry_id IS NULL AND e.path = head_files.path
       AND e.kind = head_files.kind
       AND NOT EXISTS (SELECT 1 FROM head_files AS o WHERE o.entry_id = e.id)";

/// A row's columns, for [`head_row`]: `h` is `head_files`.
const HEAD_COLUMNS: &str = "h.path, h.kind, h.hash, h.size, h.stored";

/// An entry's columns, for [`disk_row`]: `e` is `entries`. Why it is unhashed, when an `unhashed`
/// row holds for it, and whether it is a folder with nothing below it.
fn disk_columns() -> String {
    format!(
        "e.id, e.path, e.kind, e.class, e.size, e.hash,
         (SELECT u.reason FROM unhashed AS u WHERE u.entry_id = e.id AND {VALID}),
         e.kind = 'folder' AND NOT EXISTS (SELECT 1 FROM entries AS c WHERE c.parent_id = e.id)"
    )
}

/// Whether a row is `.folio/` or in it, where no entry is: `HEAD` spells the folder exactly
/// (remote-format §7.4), so an exact comparison finds it.
fn in_folio(path: &RelPath) -> bool {
    let path = path.as_str();
    path == ".folio" || path.starts_with(".folio/")
}

/// A path of `HEAD`'s tree as `head_files` keeps it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HeadFileRow {
    pub path: RelPath,
    pub entry: HeadEntry,
}

/// What a path of `HEAD`'s tree is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HeadEntry {
    /// A folder, by the id of its tree.
    Folder(ObjectId),
    /// A file: its content hash, size and `stored`.
    File(Side),
}

/// What `info` says the history tables hold; by default, nothing.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct HistoryMarks {
    /// The `HEAD` they hold; `None` when they hold none.
    pub head: Option<ObjectId>,
    /// The version of the code that derived them; `None` when nothing did.
    pub version: Option<u32>,
}

/// What `info` says the history tables hold. A mark that does not read is no mark: the tables are
/// derived again.
pub fn history_marks(conn: &Connection) -> Result<HistoryMarks, CatalogError> {
    let head = super::info(conn, HISTORY_HEAD)?.and_then(|text| ObjectId::parse(&text).ok());
    let version = super::info(conn, HISTORY_VERSION_KEY)?.and_then(|text| text.parse().ok());
    Ok(HistoryMarks { head, version })
}

/// Records that the history tables hold `head`, derived by [`HISTORY_VERSION`]: in the write that
/// fills them.
pub fn set_history_marks(conn: &Connection, head: ObjectId) -> Result<(), CatalogError> {
    super::set_info(conn, HISTORY_HEAD, &head.to_string())?;
    super::set_info(conn, HISTORY_VERSION_KEY, &HISTORY_VERSION.to_string())?;
    Ok(())
}

/// Adds `rows`, a run of a flattened tree in path order whose paths `head_files` does not hold,
/// and pairs them by path as [`pair_by_path`] does: what a catalog without moves since the commit
/// holds (versioning.md §13.2). The head sync writes a tree in such runs, each in a short write of
/// its own, after [`clear_head_files`].
pub fn insert_head_files(conn: &Connection, rows: &[HeadFileRow]) -> Result<(), CatalogError> {
    let (Some(first), Some(last)) = (rows.first(), rows.last()) else {
        return Ok(());
    };
    let mut insert = conn.prepare_cached(
        "INSERT INTO head_files (path, kind, hash, size, stored) VALUES (?1, ?2, ?3, ?4, ?5)",
    )?;
    for row in rows {
        match row.entry {
            HeadEntry::Folder(tree) => insert.execute(params![
                row.path,
                EntryKind::Folder,
                tree,
                None::<u64>,
                None::<bool>
            ])?,
            HeadEntry::File(side) => insert.execute(params![
                row.path,
                EntryKind::File,
                side.hash,
                side.size.get(),
                side.stored
            ])?,
        };
    }
    // The run's own rows, through the key's range: the same pairs as `pair_by_path`, as an entry
    // has one path and pairs only with the row there.
    conn.prepare_cached(&format!(
        "{PAIR_BY_PATH} AND head_files.path BETWEEN ?1 AND ?2"
    ))?
    .execute([&first.path, &last.path])?;
    Ok(())
}

/// The digest the workspace last recorded of the disk's `.folio/` files it reads beside the
/// catalog, if any.
pub fn disk_files(conn: &Connection) -> Result<Option<String>, CatalogError> {
    Ok(super::info(conn, DISK_FILES)?)
}

/// Records that digest: written when it changes, so that the change moves the catalog revision
/// like a change of the rows (versioning.md §6.5).
pub fn set_disk_files(conn: &Connection, digest: &str) -> Result<(), CatalogError> {
    Ok(super::set_info(conn, DISK_FILES, digest)?)
}

/// Removes every row and the marks: the history tables hold no `HEAD` (none, or one that cannot be
/// read). Changes nothing, and so not the revision, when they hold none already.
pub fn clear_head_files(conn: &Connection) -> Result<(), CatalogError> {
    conn.execute("DELETE FROM head_files", [])?;
    conn.execute(
        "DELETE FROM info WHERE key IN (?1, ?2)",
        [HISTORY_HEAD, HISTORY_VERSION_KEY],
    )?;
    Ok(())
}

/// Whether `head_files` holds a tree: a commit's root always holds `.folio/library.json`
/// (remote-format §7.4).
pub fn has_head_tree(conn: &Connection) -> Result<bool, CatalogError> {
    Ok(conn
        .prepare_cached(
            "SELECT EXISTS (SELECT 1 FROM head_files WHERE path = '.folio/library.json')",
        )?
        .query_row([], |row| row.get(0))?)
}

/// Whether the catalog indexes `index`'s pack as `index` lists it (versioning.md §4.3): the pack
/// of its size and count, each object it lists located (in it, at the offset it lists, or in
/// another pack), and no other object located in it. The head sync asks it of a pack a record of
/// which did not read as the index said, a pack that may have been replaced since it was indexed
/// (`LocalStore::publish` replaces a damaged pack with a good copy of its name).
pub fn pack_indexed_as(conn: &Connection, index: &PackIndex) -> Result<bool, CatalogError> {
    let name = index.name();
    let pack: Option<(u64, usize)> = conn
        .prepare_cached("SELECT size, objects FROM packs WHERE name = ?1")?
        .query_row([name], |row| Ok((row.get(0)?, row.get(1)?)))
        .optional()?;
    if pack != Some((index.size(), index.object_count())) {
        return Ok(false);
    }
    let mut held = 0_usize;
    for entry in index.entries() {
        match object_location(conn, entry.id)? {
            None => return Ok(false),
            Some(location) if location.pack == name => {
                if location.offset != entry.offset {
                    return Ok(false);
                }
                held += 1;
            }
            Some(_) => {}
        }
    }
    let located: usize = conn
        .prepare_cached("SELECT count(*) FROM objects WHERE pack = ?1")?
        .query_row([name], |row| row.get(0))?;
    Ok(located == held)
}

/// Pairs each row without an entry with the entry at exactly its path and of its kind that no row
/// pairs with (versioning.md §6.1); returns how many rows it paired. With nothing to pair it
/// changes no row, and so not the revision.
pub fn pair_by_path(conn: &Connection) -> Result<usize, CatalogError> {
    Ok(conn.prepare_cached(PAIR_BY_PATH)?.execute([])?)
}

/// Every row of `head_files`, by path: what `HEAD`'s metadata is resolved against.
pub fn head_rows(conn: &Connection) -> Result<Vec<HeadRow>, CatalogError> {
    let rows = conn
        .prepare_cached(&format!(
            "SELECT {HEAD_COLUMNS} FROM head_files AS h ORDER BY h.path"
        ))?
        .query_map([], |row| head_row(row, 0))?
        .collect::<Result<_, _>>()?;
    Ok(rows)
}

/// The id of the entry paired with the row at `path`, if there is that row and it is paired.
pub fn paired_entry(conn: &Connection, path: &RelPath) -> Result<Option<EntryId>, CatalogError> {
    let entry: Option<Option<i64>> = conn
        .prepare_cached("SELECT entry_id FROM head_files WHERE path = ?1")?
        .query_row([path], |row| row.get(0))
        .optional()?;
    Ok(entry.flatten().map(EntryId))
}

/// The entries whose tags the metadata comparison follows, each with its tags, by entry id.
pub type TaggedEntries = Vec<(PairedEntry, BTreeSet<TagId>)>;

/// What the workspace compares (versioning.md §6.3), in the caller's read: every paired row whose
/// entry has another path, kind or size, or a known other hash; every row below a folder row that
/// is not in place (whose entry is elsewhere or of the other kind, or that has none), as frames
/// need them ([`Comparison`]); every row without an entry outside `.folio/`; and every entry no row
/// pairs with.
pub fn comparison(conn: &Connection) -> Result<Comparison, CatalogError> {
    Ok(compare(conn, None)?.0)
}

/// [`comparison`], and in the same pass every entry that has tags of its own, with them, and every
/// entry paired with a row at one of `head_tagged`'s paths (the rows `HEAD` has tags for), with its
/// tags or none, each once, by entry id: the entries whose tags the metadata comparison follows
/// (versioning.md §6.4).
pub fn comparison_and_tags<'a>(
    conn: &Connection,
    head_tagged: impl IntoIterator<Item = &'a RelPath>,
) -> Result<(Comparison, TaggedEntries), CatalogError> {
    let head_tagged = head_tagged
        .into_iter()
        .map(|path| path.as_str().as_bytes())
        .collect();
    compare(conn, Some(head_tagged))
}

/// The pass of [`comparison`] and [`comparison_and_tags`]: the entries and the tags in entry id
/// order, and the whole of `head_files` in path order, sorted by entry id here, paired here. On
/// 50,000 files it takes about 45 ms within SQLite's default page cache. Looking up each row's
/// entry instead overflows that cache (250–600 ms, and 160 more for the tags), as in
/// `extracts::count_pending_extracts`; SQLite's sorter takes 150 ms for the rows, and a partial
/// index of `head_files` with a lookup of each row by path 200 (it takes the index of entry ids
/// even with `NOT INDEXED`).
fn compare(
    conn: &Connection,
    head_tagged: Option<HashSet<&[u8]>>,
) -> Result<(Comparison, TaggedEntries), CatalogError> {
    let disk = disk_columns();
    let mut comparison = Comparison::default();
    let mut tagged = Vec::new();
    // Rows with an entry are paired; the others are deleted unless they are in `.folio/`.
    let mut paired = Vec::new();
    let mut statement = conn.prepare_cached(&format!(
        "SELECT h.entry_id, {HEAD_COLUMNS} FROM head_files AS h ORDER BY h.path"
    ))?;
    let mut rows = statement.query([])?;
    while let Some(row) = rows.next()? {
        let head = head_row(row, 1)?;
        match row.get::<_, Option<i64>>(0)? {
            Some(id) => paired.push((id, head)),
            None if !in_folio(&head.path) => comparison.deleted.push(head),
            None => {}
        }
    }
    drop(rows);
    paired.sort_unstable_by_key(|(id, _)| *id);
    let mut rows = paired.into_iter().peekable();
    let mut entries =
        conn.prepare_cached(&format!("SELECT {disk} FROM entries AS e ORDER BY e.id"))?;
    let mut entries = entries.query([])?;
    let mut tag_rows =
        conn.prepare_cached("SELECT entry_id, tag_id FROM entry_tags ORDER BY entry_id")?;
    let mut tags = match head_tagged {
        Some(head_tagged) => Some(TagCursor {
            rows: tag_rows.query([])?,
            next: None,
            done: false,
            head_tagged,
        }),
        None => None,
    };
    // The entries of the paired rows listed, which the rows below displaced folders skip.
    let mut listed: HashSet<i64> = HashSet::new();
    while let Some(entry) = entries.next()? {
        let id: i64 = entry.get(0)?;
        // Every paired row has its entry (the reference), so none is passed over here.
        while rows.next_if(|(row, _)| *row < id).is_some() {}
        let head = rows.next_if(|(row, _)| *row == id).map(|(_, head)| head);
        if let Some(tags) = &mut tags {
            let own = tags.take(id)?;
            let head_has_tags = head
                .as_ref()
                .is_some_and(|head| tags.head_tagged.contains(head.path.as_str().as_bytes()));
            if !own.is_empty() || head_has_tags {
                let kind: EntryKind = entry.get(2)?;
                let paired = PairedEntry {
                    entry: EntryId(id),
                    path: entry.get(1)?,
                    kind,
                    head: head
                        .as_ref()
                        .filter(|head| head.kind() == kind)
                        .map(|head| head.path.clone()),
                };
                tagged.push((paired, own));
            }
        }
        match head {
            Some(head) if differs(entry, &head)? => {
                comparison.paired.push((head, disk_row(entry)?));
                listed.insert(id);
            }
            Some(_) => {}
            None => comparison.added.push(disk_row(entry)?),
        }
    }
    drop((entries, tags));

    // The outermost folder rows that are not in place: a range below each holds the rows below the
    // ones inside it too.
    let outermost = outermost(
        comparison
            .paired
            .iter()
            .filter(|(row, entry)| {
                row.kind() == EntryKind::Folder
                    && (entry.path != row.path || entry.kind != row.kind())
            })
            .map(|(row, _)| row.path.as_str())
            .chain(
                comparison
                    .deleted
                    .iter()
                    .filter(|row| row.kind() == EntryKind::Folder)
                    .map(|row| row.path.as_str()),
            ),
    );
    // The rows below come in path order from the table; the few in place there (the others are
    // listed) look their entries up.
    let mut below = Vec::new();
    let mut statement = conn.prepare_cached(&format!(
        "SELECT h.entry_id, {HEAD_COLUMNS} FROM head_files AS h
         WHERE h.path > (?1 || '/') AND h.path < (?1 || '0')"
    ))?;
    let mut entry =
        conn.prepare_cached(&format!("SELECT {disk} FROM entries AS e WHERE e.id = ?1"))?;
    for folder in outermost {
        let mut rows = statement.query([folder])?;
        while let Some(row) = rows.next()? {
            let id = match row.get::<_, Option<i64>>(0)? {
                Some(id) if !listed.contains(&id) => id,
                _ => continue,
            };
            below.push((head_row(row, 1)?, entry.query_row([id], disk_row)?));
        }
    }
    comparison.paired.extend(below);
    Ok((comparison, tagged))
}

/// The folders of `folders` (paths of `HEAD`'s tree) that lie in none of the others, in no
/// particular order. Each folder's ancestors are probed as slices of its path, nearest first, and
/// what the probes learn of each ancestor is kept, so the work grows with the bytes of the
/// distinct paths probed: never with the depth squared of each folder, which a chain of nested
/// folders in a crafted `HEAD` would make cubic (`.folio/local/` is untrusted input).
fn outermost<'a>(folders: impl IntoIterator<Item = &'a str>) -> Vec<&'a str> {
    // Each folder given, and each ancestor probed: whether it is one of them or lies in one.
    let mut inside: HashMap<&str, bool> =
        folders.into_iter().map(|folder| (folder, true)).collect();
    let folders: Vec<&str> = inside.keys().copied().collect();
    let mut walked = Vec::new();
    let mut found = Vec::new();
    for folder in folders {
        let mut at = folder;
        let lies_inside = loop {
            let Some((parent, _)) = at.rsplit_once('/') else {
                break false;
            };
            if let Some(&known) = inside.get(parent) {
                break known;
            }
            walked.push(parent);
            at = parent;
        };
        inside.extend(walked.drain(..).map(|ancestor| (ancestor, lies_inside)));
        if !lies_inside {
            found.push(folder);
        }
    }
    found
}

/// Whether a paired row's entry (the [`disk_columns`]) has another path, kind or size than the row,
/// or a known other hash.
fn differs(entry: &Row<'_>, head: &HeadRow) -> rusqlite::Result<bool> {
    let path = match entry.get_ref(1)? {
        ValueRef::Text(path) => path,
        _ => return Ok(true),
    };
    if path != head.path.as_str().as_bytes() || entry.get::<_, EntryKind>(2)? != head.kind() {
        return Ok(true);
    }
    let Some(file) = &head.file else {
        return Ok(false);
    };
    let hash: Option<ContentHash> = entry.get(5)?;
    Ok(entry.get::<_, u64>(4)? != file.size || hash.is_some_and(|hash| hash != file.hash))
}

/// The tags in entry id order, for [`compare`].
struct TagCursor<'stmt, 'a> {
    rows: rusqlite::Rows<'stmt>,
    /// The tag with the smallest entry id not below the entries read so far.
    next: Option<(i64, TagId)>,
    done: bool,
    /// The paths of the rows `HEAD` has tags for.
    head_tagged: HashSet<&'a [u8]>,
}

impl TagCursor<'_, '_> {
    /// The tags of the entry `id`, passing over those of the entries before it.
    fn take(&mut self, id: i64) -> rusqlite::Result<BTreeSet<TagId>> {
        let mut own = BTreeSet::new();
        loop {
            if self.next.is_none() && !self.done {
                match self.rows.next()? {
                    Some(row) => self.next = Some((row.get(0)?, row.get(1)?)),
                    None => self.done = true,
                }
            }
            match self.next.take() {
                Some((entry, tag)) if entry <= id => {
                    if entry == id {
                        own.insert(tag);
                    }
                }
                next => {
                    self.next = next;
                    return Ok(own);
                }
            }
        }
    }
}

/// Every folder entry directly in the library or in a folder there, the semesters' and courses'
/// folders, with the row each is paired with.
pub fn group_folders(conn: &Connection) -> Result<Vec<PairedEntry>, CatalogError> {
    let folders = conn
        .prepare_cached(
            "SELECT e.id, e.path, e.kind, h.path, h.kind
             FROM entries AS e LEFT JOIN head_files AS h ON h.entry_id = e.id
             WHERE e.kind = 'folder'
               AND (e.parent_id IS NULL OR e.parent_id IN (
                   SELECT id FROM entries WHERE parent_id IS NULL AND kind = 'folder'))
             ORDER BY e.path",
        )?
        .query_map([], paired_entry_row)?
        .collect::<Result<_, _>>()?;
    Ok(folders)
}

/// A row from the [`HEAD_COLUMNS`] at `at`.
fn head_row(row: &Row<'_>, at: usize) -> rusqlite::Result<HeadRow> {
    let path = row.get(at)?;
    let file = match row.get(at + 1)? {
        EntryKind::Folder => None,
        EntryKind::File => Some(HeadFile {
            hash: row.get(at + 2)?,
            size: row.get(at + 3)?,
            stored: row.get(at + 4)?,
        }),
    };
    Ok(HeadRow { path, file })
}

/// An entry from the [`disk_columns`].
fn disk_row(row: &Row<'_>) -> rusqlite::Result<DiskRow> {
    let blocked: Option<String> = row.get(6)?;
    Ok(DiskRow {
        entry: EntryId(row.get(0)?),
        path: row.get(1)?,
        kind: row.get(2)?,
        class: row.get(3)?,
        size: row.get(4)?,
        hash: row.get(5)?,
        blocked: blocked.as_deref().map(unhashed::reason).transpose()?,
        empty: row.get(7)?,
    })
}

/// An entry and the row paired with it: `e.id, e.path, e.kind, h.path, h.kind`. The row counts
/// only when it is of the entry's kind.
fn paired_entry_row(row: &Row<'_>) -> rusqlite::Result<PairedEntry> {
    let kind: EntryKind = row.get(2)?;
    let head_kind: Option<EntryKind> = row.get(4)?;
    let head: Option<RelPath> = row.get(3)?;
    Ok(PairedEntry {
        entry: EntryId(row.get(0)?),
        path: row.get(1)?,
        kind,
        head: head.filter(|_| head_kind == Some(kind)),
    })
}

#[cfg(test)]
mod tests;
