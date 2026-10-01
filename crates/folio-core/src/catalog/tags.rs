//! Tag definitions and assignments, mirrored from `.folio/` (docs/specs/library-core.md §5.2).
//! An entry's search row carries the names of its tags, so searching `作业` finds homework.

use std::collections::{BTreeMap, BTreeSet};

use rusqlite::{Connection, params};

use super::{CatalogError, EntryId};
use crate::meta::{TagDefinition, TagDefinitions, TagId};

/// Replaces the definitions with those of `tags.json`, and refreshes the search text of entries
/// whose tags were renamed, added or removed.
pub fn replace_tag_definitions(
    conn: &Connection,
    definitions: &TagDefinitions,
) -> Result<(), CatalogError> {
    let old_names = conn
        .prepare("SELECT id, name FROM tags")?
        .query_map([], |row| {
            Ok((row.get::<_, TagId>(0)?, row.get::<_, String>(1)?))
        })?
        .collect::<Result<BTreeMap<_, _>, _>>()?;

    conn.execute("DELETE FROM tags", [])?;
    let mut insert =
        conn.prepare("INSERT INTO tags (id, name, color, sort_order) VALUES (?1, ?2, ?3, ?4)")?;
    for (id, tag) in &definitions.tags {
        insert.execute(params![id, tag.name, tag.color, tag.order])?;
    }

    let new_name = |id: &TagId| definitions.tags.get(id).map(|tag| tag.name.as_str());
    let changed = old_names
        .keys()
        .chain(definitions.tags.keys())
        .filter(|id| old_names.get(*id).map(String::as_str) != new_name(id))
        .collect::<BTreeSet<_>>();
    let mut tagged = conn.prepare("SELECT entry_id FROM entry_tags WHERE tag_id = ?1")?;
    let mut affected = BTreeSet::new();
    for id in changed {
        for entry in tagged.query_map([id], |row| row.get::<_, i64>(0))? {
            affected.insert(entry?);
        }
    }
    for entry in affected {
        refresh_search_tags(conn, EntryId(entry))?;
    }
    Ok(())
}

pub fn tag_definitions(conn: &Connection) -> Result<TagDefinitions, CatalogError> {
    let tags = conn
        .prepare("SELECT id, color, name, sort_order FROM tags")?
        .query_map([], |row| {
            let definition = TagDefinition {
                color: row.get(1)?,
                name: row.get(2)?,
                order: row.get(3)?,
            };
            Ok((row.get(0)?, definition))
        })?
        .collect::<Result<_, _>>()?;
    Ok(TagDefinitions { tags })
}

/// Replaces the tags of one entry. Tags that `tags.json` does not define are kept, but have no
/// name to search for.
pub fn set_entry_tags(
    conn: &Connection,
    entry: EntryId,
    tags: &BTreeSet<TagId>,
) -> Result<(), CatalogError> {
    let exists: bool = conn
        .prepare_cached("SELECT EXISTS (SELECT 1 FROM entries WHERE id = ?1)")?
        .query_row([entry.0], |row| row.get(0))?;
    if !exists {
        return Err(CatalogError::NoEntry(entry));
    }
    // Refreshing the search text re-indexes the whole row, body included.
    if entry_tags(conn, entry)? == *tags {
        return Ok(());
    }
    conn.prepare_cached("DELETE FROM entry_tags WHERE entry_id = ?1")?
        .execute([entry.0])?;
    let mut insert =
        conn.prepare_cached("INSERT INTO entry_tags (entry_id, tag_id) VALUES (?1, ?2)")?;
    for tag in tags {
        insert.execute(params![entry.0, tag])?;
    }
    refresh_search_tags(conn, entry)
}

/// The tags of every entry that has any.
pub fn all_entry_tags(
    conn: &Connection,
) -> Result<BTreeMap<EntryId, BTreeSet<TagId>>, CatalogError> {
    let mut tags = BTreeMap::<EntryId, BTreeSet<TagId>>::new();
    let mut statement = conn.prepare_cached("SELECT entry_id, tag_id FROM entry_tags")?;
    for row in statement.query_map([], |row| Ok((EntryId(row.get(0)?), row.get(1)?)))? {
        let (entry, tag) = row?;
        tags.entry(entry).or_default().insert(tag);
    }
    Ok(tags)
}

/// How many entries carry each tag themselves; tags nobody carries are left out.
pub fn tag_usage(conn: &Connection) -> Result<BTreeMap<TagId, u32>, CatalogError> {
    let usage = conn
        .prepare_cached("SELECT tag_id, count(*) FROM entry_tags GROUP BY tag_id")?
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
        .collect::<Result<_, _>>()?;
    Ok(usage)
}

pub fn entry_tags(conn: &Connection, entry: EntryId) -> Result<BTreeSet<TagId>, CatalogError> {
    let tags = conn
        .prepare_cached("SELECT tag_id FROM entry_tags WHERE entry_id = ?1")?
        .query_map([entry.0], |row| row.get(0))?
        .collect::<Result<_, _>>()?;
    Ok(tags)
}

fn refresh_search_tags(conn: &Connection, entry: EntryId) -> Result<(), CatalogError> {
    let changed = conn
        .prepare_cached(
            "UPDATE search SET tags = (
             SELECT coalesce(group_concat(tags.name, ' ' ORDER BY tags.sort_order, tags.id), '')
             FROM entry_tags JOIN tags ON tags.id = entry_tags.tag_id
             WHERE entry_tags.entry_id = ?1)
         WHERE rowid = ?1",
        )?
        .execute([entry.0])?;
    if changed == 0 {
        return Err(CatalogError::NoEntry(entry));
    }
    Ok(())
}
