//! Snapshot-local M1 browsing, tag filters, search windows and note-relative lookups.
//! Call these functions inside one [`super::Catalog::read_stamped`] transaction, whose stamp
//! labels the page and fixes the search ranking time.

mod order;
mod snippet;

use std::collections::{BTreeSet, HashMap};

use rusqlite::{Connection, OptionalExtension, params, params_from_iter, types::Value};
use unicode_normalization::UnicodeNormalization;

pub(super) use snippet::register as register_snippet;

use super::fulltext::{RANK, by_rank, recency_boost};
use super::{CatalogError, Entry, EntryId, HitText, entries, entry_by_id, entry_tags};
use crate::meta::{EntryKind, TagDefinitions, TagId, is_folio_owned};
use crate::paths::RelPath;
use crate::search::SearchQuery;

pub const MAX_PAGE_SIZE: u32 = 500;
pub const SEARCH_RESULTS: u32 = 500;
pub const MAX_FILTER_TAGS: usize = 16;
pub const MAX_RESOLVE_PATHS: usize = 64;
pub const MAX_RELATIVE_PATH_CHARS: usize = 1_024;

#[derive(Debug, thiserror::Error)]
pub enum QueryError {
    #[error(transparent)]
    Catalog(#[from] CatalogError),
    #[error("the entry moved or disappeared")]
    NotFound,
    #[error("{0}")]
    InvalidArgument(&'static str),
}

impl From<rusqlite::Error> for QueryError {
    fn from(error: rusqlite::Error) -> Self {
        Self::Catalog(error.into())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PageRequest {
    pub offset: u32,
    pub limit: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SortKey {
    Name,
    Path,
    Modified,
    Size,
    FileType,
    Added,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct EntrySort {
    pub key: SortKey,
    pub descending: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TagFilter {
    WithAll(Vec<TagId>),
    Untagged,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct FileFilter {
    pub tags: Option<TagFilter>,
    pub added_after_ms: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Row {
    pub entry: Entry,
    pub tags: Vec<TagId>,
    pub folder_tags: Vec<TagId>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Page {
    pub items: Vec<Row>,
    pub total: u32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SearchHit {
    pub entry: Row,
    pub text: HitText,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SearchPage {
    pub items: Vec<SearchHit>,
    pub more: bool,
}

pub fn check_page(page: PageRequest) -> Result<(), QueryError> {
    if page.limit > MAX_PAGE_SIZE {
        return Err(QueryError::InvalidArgument("page limit exceeds pageSize"));
    }
    Ok(())
}

pub fn check_search_page(page: PageRequest) -> Result<(), QueryError> {
    check_page(page)?;
    if page
        .offset
        .checked_add(page.limit)
        .is_none_or(|end| end > SEARCH_RESULTS)
    {
        return Err(QueryError::InvalidArgument(
            "search page exceeds searchResults",
        ));
    }
    Ok(())
}

pub fn check_filter(filter: &FileFilter) -> Result<(), QueryError> {
    match &filter.tags {
        Some(TagFilter::WithAll(tags)) => check_filter_tags(tags.len()),
        _ => Ok(()),
    }
}

/// The number of tags a `withAll` filter may name, duplicates included.
pub fn check_filter_tags(count: usize) -> Result<(), QueryError> {
    if count == 0 || count > MAX_FILTER_TAGS {
        return Err(QueryError::InvalidArgument(
            "withAll needs 1..=filterTags tags",
        ));
    }
    Ok(())
}

pub fn check_paths(paths: &[String]) -> Result<(), QueryError> {
    if paths.len() > MAX_RESOLVE_PATHS
        || paths
            .iter()
            .any(|path| path.chars().count() > MAX_RELATIVE_PATH_CHARS)
    {
        return Err(QueryError::InvalidArgument(
            "relative paths exceed their limits",
        ));
    }
    Ok(())
}

/// Resolve identity and exact case in the same snapshot as the ensuing query.
pub fn resolve(conn: &Connection, id: EntryId, path: &RelPath) -> Result<Entry, QueryError> {
    if is_folio_owned(path) {
        return Err(QueryError::NotFound);
    }
    entry_by_id(conn, id)?
        .filter(|entry| entry.record.path == *path)
        .ok_or(QueryError::NotFound)
}

/// The folder a scope or parent reference names (`None`: the library root).
pub fn folder(
    conn: &Connection,
    reference: Option<(EntryId, &RelPath)>,
) -> Result<Option<Entry>, QueryError> {
    let entry = reference
        .map(|(id, path)| resolve(conn, id, path))
        .transpose()?;
    if entry
        .as_ref()
        .is_some_and(|entry| entry.record.kind != EntryKind::Folder)
    {
        return Err(QueryError::InvalidArgument("scope must be a folder"));
    }
    Ok(entry)
}

pub fn get_entry(conn: &Connection, id: EntryId, path: &RelPath) -> Result<Row, QueryError> {
    let entry = resolve(conn, id, path)?;
    Rows::new(conn)?.row(entry)
}

pub fn list_children(
    conn: &Connection,
    reference: Option<(EntryId, &RelPath)>,
    sort: EntrySort,
    page: PageRequest,
) -> Result<Page, QueryError> {
    check_page(page)?;
    let parent = folder(conn, reference)?;
    let predicate = "e.parent_id IS ?";
    let values = vec![parent.map_or(Value::Null, |entry| Value::Integer(entry.id.0))];
    list(conn, predicate, values, sort, page, true)
}

pub fn list_files(
    conn: &Connection,
    reference: Option<(EntryId, &RelPath)>,
    filter: &FileFilter,
    sort: EntrySort,
    page: PageRequest,
) -> Result<Page, QueryError> {
    check_page(page)?;
    check_filter(filter)?;
    let scope = folder(conn, reference)?;
    let mut predicate = String::from("e.kind = 'file'");
    let mut values = Vec::new();
    if let Some(scope) = scope {
        predicate.push_str(" AND e.path > ? AND e.path < ?");
        values.push(Value::Text(format!("{}/", scope.record.path)));
        values.push(Value::Text(format!("{}0", scope.record.path)));
    }
    if let Some(ms) = filter.added_after_ms {
        // i128 makes the whole signed IPC millisecond range meaningful, without overflow.
        let ns = i128::from(ms) * 1_000_000;
        if ns >= i128::from(i64::MAX) {
            predicate.push_str(" AND 0");
        } else if ns >= i128::from(i64::MIN) {
            // A date-index range causes thousands of random row lookups for a broad recent
            // filter. Unary + lets the path/identity scan win; both operands remain integers.
            predicate.push_str(" AND +e.added_ns > ?");
            values.push(Value::Integer(ns as i64));
        }
    }
    match &filter.tags {
        Some(TagFilter::WithAll(tags)) => {
            for tag in tags.iter().collect::<BTreeSet<_>>() {
                predicate.push_str(&format!(" AND e.id IN ({})", effective_ids(true)));
                values.push(Value::Text(tag.to_string()));
                values.push(Value::Text(tag.to_string()));
            }
        }
        Some(TagFilter::Untagged) => {
            predicate.push_str(&format!(" AND e.id NOT IN ({})", effective_ids(false)));
        }
        None => {}
    }
    list(conn, &predicate, values, sort, page, false)
}

/// Folders deeper than a course (semester/course/…) pass their tags down; semester and
/// course folders do not. In SQL, a path of depth d has d − 1 slashes.
const COURSE_DEPTH: usize = 2;

/// The entries with an effective tag: the one bound twice when `per_tag`, otherwise any.
/// Tag-first range scans use the existing assignment and path indexes, rather than checking
/// every tagged ancestor separately for every file. CROSS JOIN fixes that loop order even
/// when SQLite estimates the dynamic path range poorly.
fn effective_ids(per_tag: bool) -> String {
    let (direct, tagged, from) = if per_tag {
        (
            " WHERE tag_id = ?",
            " AND et.tag_id = ?",
            "entry_tags et CROSS JOIN entries f ON f.id = et.entry_id",
        )
    } else {
        // A full tag set starts with folders, avoiding an entry lookup for every file tag.
        (
            "",
            "",
            "entries f CROSS JOIN entry_tags et ON et.entry_id = f.id",
        )
    };
    format!(
        "SELECT entry_id FROM entry_tags{direct}
         UNION ALL SELECT child.id FROM {from}
         CROSS JOIN entries child ON child.path > (f.path || '/') AND child.path < (f.path || '0')
         WHERE f.kind = 'folder'
           AND length(f.path) - length(replace(f.path, '/', '')) >= {COURSE_DEPTH}{tagged}"
    )
}

fn list(
    conn: &Connection,
    predicate: &str,
    values: Vec<Value>,
    sort: EntrySort,
    page: PageRequest,
    folders_first: bool,
) -> Result<Page, QueryError> {
    let column = match sort.key {
        SortKey::Path => Some("path"),
        SortKey::Modified => Some("mtime_ns"),
        SortKey::Size => Some("size"),
        SortKey::Added => Some("added_ns"),
        SortKey::Name | SortKey::FileType => None,
    };
    // Natural orders select the page in Rust; a count-only page (limit 0) needs no keys.
    let (ids, total) = if column.is_none() && page.limit > 0 {
        let mut keys = conn
            .prepare_cached(&format!(
                "SELECT id, path, path_key, kind FROM entries e WHERE {predicate}"
            ))?
            .query_map(params_from_iter(&values), |row| {
                Ok(order::Key::new(
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    sort.key,
                ))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        let total = u32::try_from(keys.len()).map_err(|_| {
            rusqlite::Error::IntegralValueOutOfRange(
                0,
                i64::try_from(keys.len()).unwrap_or(i64::MAX),
            )
        })?;
        let ids = order::page(&mut keys, sort, page, folders_first)
            .iter()
            .map(|key| key.id)
            .collect::<Vec<_>>();
        (ids, total)
    } else {
        let total = conn
            .prepare_cached(&format!("SELECT count(*) FROM entries e WHERE {predicate}"))?
            .query_row(params_from_iter(&values), |row| row.get::<_, u32>(0))?;
        let Some(primary) = column.filter(|_| page.limit > 0 && page.offset < total) else {
            return Ok(Page {
                items: Vec::new(),
                total,
            });
        };
        let direction = if sort.descending { "DESC" } else { "ASC" };
        let folders = if folders_first {
            "(kind = 'folder') DESC,"
        } else {
            ""
        };
        let nulls = if sort.key == SortKey::Modified {
            "mtime_ns IS NULL,"
        } else {
            ""
        };
        let mut values = values;
        values.extend([
            Value::Integer(i64::from(page.limit)),
            Value::Integer(i64::from(page.offset)),
        ]);
        let ids = conn
            .prepare_cached(&format!(
                "SELECT id FROM entries e WHERE {predicate}
             ORDER BY {folders} {nulls} {primary} {direction}, path ASC LIMIT ? OFFSET ?",
            ))?
            .query_map(params_from_iter(&values), |row| {
                row.get::<_, i64>(0).map(EntryId)
            })?
            .collect::<Result<Vec<_>, _>>()?;
        (ids, total)
    };
    if ids.is_empty() {
        return Ok(Page {
            items: Vec::new(),
            total,
        });
    }
    let mut rows = Rows::new(conn)?;
    Ok(Page {
        items: ids
            .into_iter()
            .map(|id| {
                let entry = entry_by_id(conn, id)?.ok_or(CatalogError::NoEntry(id))?;
                rows.row(entry)
            })
            .collect::<Result<_, _>>()?,
        total,
    })
}

/// Always rank the same 500-result window; scope is applied before the candidate cutoff.
/// `now` must be fixed for a catalog revision, so elapsed time cannot reorder sibling pages.
pub fn search_page(
    conn: &Connection,
    query: &SearchQuery,
    reference: Option<(EntryId, &RelPath)>,
    page: PageRequest,
    now: i64,
) -> Result<SearchPage, QueryError> {
    check_search_page(page)?;
    let scope = folder(conn, reference)?;
    let mut predicate = String::new();
    let mut values = vec![Value::Text(query.expression().to_owned())];
    if let Some(scope) = scope {
        predicate.push_str(" AND scoped.path > ? AND scoped.path < ?");
        values.push(Value::Text(format!("{}/", scope.record.path)));
        values.push(Value::Text(format!("{}0", scope.record.path)));
    }
    let mut hits = conn
        .prepare_cached(&format!(
            "SELECT scoped.id, scoped.path, scoped.mtime_ns, {RANK} AS score
             FROM search JOIN entries scoped ON scoped.id = search.rowid
             WHERE search MATCH ?{predicate}
             ORDER BY score, length(CAST(scoped.path AS BLOB)), scoped.path LIMIT {}",
            SEARCH_RESULTS * 4,
        ))?
        .query_map(params_from_iter(&values), |row| {
            let boost = recency_boost(row.get(2)?, now);
            Ok((
                EntryId(row.get(0)?),
                row.get::<_, String>(1)?,
                -row.get::<_, f64>(3)? * boost,
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    hits.sort_unstable_by(|(_, a_path, a_score), (_, b_path, b_score)| {
        by_rank((*a_score, a_path), (*b_score, b_path))
    });
    hits.truncate(SEARCH_RESULTS as usize);
    let end = page.offset + page.limit;
    let more = (end as usize) < hits.len();
    let visible: Vec<_> = hits
        .into_iter()
        .skip(page.offset as usize)
        .take(page.limit as usize)
        .collect();
    if visible.is_empty() {
        return Ok(SearchPage {
            items: Vec::new(),
            more,
        });
    }
    let ids = serde_json::to_string(&visible.iter().map(|(id, _, _)| id.0).collect::<Vec<_>>())
        .expect("entry IDs always serialize");
    // Unary + keeps the rowid set outside the FTS plan, so MATCH runs once for the page.
    // Every catalog connection registers folio_snippet16 when it opens (`configure`).
    let mut texts = conn
        .prepare_cached(
            "SELECT rowid, highlight(search, 0, char(1), char(2)), folio_snippet16(search)
             FROM search WHERE search MATCH ?1 AND +rowid IN (SELECT value FROM json_each(?2))",
        )?
        .query_map(params![query.expression(), ids], |row| {
            let name = super::fulltext::spans(&row.get::<_, String>(1)?);
            let snippet = row
                .get::<_, Option<String>>(2)?
                .map(|marked| super::fulltext::spans(&marked))
                .filter(|spans| spans.iter().any(|span| span.matched));
            Ok((EntryId(row.get(0)?), HitText { name, snippet }))
        })?
        .collect::<Result<HashMap<_, _>, _>>()?;
    let mut rows = Rows::new(conn)?;
    let items = visible
        .into_iter()
        .map(|(id, _, _)| {
            let entry = entry_by_id(conn, id)?.ok_or(QueryError::NotFound)?;
            let text = texts.remove(&id).ok_or(QueryError::NotFound)?;
            Ok(SearchHit {
                entry: rows.row(entry)?,
                text,
            })
        })
        .collect::<Result<_, QueryError>>()?;
    Ok(SearchPage { items, more })
}

/// Catalog-only lookups, with exact-case names preferred at every path segment.
pub fn resolve_paths(
    conn: &Connection,
    base: (EntryId, &RelPath),
    paths: &[String],
) -> Result<Vec<Option<Row>>, QueryError> {
    check_paths(paths)?;
    let base = resolve(conn, base.0, base.1)?;
    if base.record.kind != EntryKind::File {
        return Err(QueryError::InvalidArgument("base must be a file"));
    }
    let mut rows = Rows::new(conn)?;
    paths.iter().map(|text| {
        let Some(path) = relative_path(&base.record.path, text) else { return Ok(None); };
        let mut parent = None;
        let mut prefix = String::new();
        let mut found = None;
        for name in path.names() {
            if !prefix.is_empty() { prefix.push('/'); }
            prefix.push_str(name);
            let exact = conn.prepare_cached(&format!(
                "SELECT {} FROM entries WHERE parent_id IS ?1 AND name = ?2", entries::COLUMNS,
            ))?.query_row(params![parent, name], entries::from_row).optional()?;
            let entry = match exact {
                Some(entry) => entry,
                None => {
                    // The names already passed RelPath::parse; this cannot fail, but a path that
                    // did would name nothing, so it is null like any other unresolved path.
                    let Ok(parsed) = RelPath::parse(&prefix) else { return Ok(None); };
                    let key = parsed.key();
                    let matches = conn.prepare_cached(&format!(
                        "SELECT {} FROM entries WHERE parent_id IS ?1 AND path_key = ?2 LIMIT 2", entries::COLUMNS,
                    ))?.query_map(params![parent, key.as_str()], entries::from_row)?
                        .collect::<Result<Vec<_>, _>>()?;
                    if matches.len() != 1 { return Ok(None); }
                    let Some(entry) = matches.into_iter().next() else { return Ok(None); };
                    entry
                }
            };
            prefix = entry.record.path.to_string();
            parent = Some(entry.id.0);
            found = Some(entry);
        }
        found.filter(|entry| entry.record.kind == EntryKind::File)
            .map(|entry| rows.row(entry)).transpose()
    }).collect()
}

fn relative_path(base: &RelPath, text: &str) -> Option<RelPath> {
    if text.starts_with(['/', '\\']) || text.contains(':') {
        return None;
    }
    let parent = base.parent();
    let mut names: Vec<String> = parent.as_ref().map_or_else(Vec::new, |parent| {
        parent.names().map(str::to_owned).collect()
    });
    for name in text.split(['/', '\\']) {
        match name {
            "" | "." => {}
            ".." => {
                names.pop()?;
            }
            name => names.push(name.nfc().collect()),
        }
    }
    let path = RelPath::parse(&names.join("/")).ok()?;
    (!is_folio_owned(&path)).then_some(path)
}

struct Rows<'a> {
    conn: &'a Connection,
    definitions: TagDefinitions,
    folders: HashMap<RelPath, BTreeSet<TagId>>,
}

impl<'a> Rows<'a> {
    fn new(conn: &'a Connection) -> Result<Self, QueryError> {
        Ok(Self {
            conn,
            definitions: super::tag_definitions(conn)?,
            folders: HashMap::new(),
        })
    }

    fn row(&mut self, entry: Entry) -> Result<Row, QueryError> {
        let own = entry_tags(self.conn, entry.id)?;
        let mut inherited = BTreeSet::new();
        if let Some(parent) = entry.record.path.parent() {
            for path in parent
                .ancestors()
                .take_while(|path| path.depth() > COURSE_DEPTH)
            {
                if !self.folders.contains_key(&path) {
                    let tags = super::entry(self.conn, &path)?
                        .filter(|entry| entry.record.kind == EntryKind::Folder)
                        .map(|entry| entry_tags(self.conn, entry.id))
                        .transpose()?
                        .unwrap_or_default();
                    self.folders.insert(path.clone(), tags);
                }
                inherited.extend(self.folders[&path].iter().cloned());
            }
        }
        inherited.retain(|tag| !own.contains(tag));
        let ordered = |tags: BTreeSet<TagId>| {
            let mut tags: Vec<_> = tags.into_iter().collect();
            tags.sort_unstable_by(|a, b| {
                let position = |id| {
                    self.definitions
                        .tags
                        .get(id)
                        .map(|tag| (tag.order, tag.name.as_str()))
                };
                let (a_position, b_position) = (position(a), position(b));
                a_position
                    .is_none()
                    .cmp(&b_position.is_none())
                    .then(a_position.cmp(&b_position))
                    .then(a.cmp(b))
            });
            tags
        };
        Ok(Row {
            entry,
            tags: ordered(own),
            folder_tags: ordered(inherited),
        })
    }
}

#[cfg(test)]
mod tests;

#[cfg(test)]
mod snapshot_tests;
