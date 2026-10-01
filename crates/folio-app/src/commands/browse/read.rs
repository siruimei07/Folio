use folio_core::catalog::{Catalog, EntryId, ReadStamp, Span as HitSpan, queries};
use folio_core::meta::TagId;
use folio_core::paths::RelPath;
use folio_core::search::SearchQuery;

use crate::error::AppError;
use crate::ipc::entries::{GetEntry, ListChildren, ListFiles, ResolvePaths, TagFilter};
use crate::ipc::search::{Search, SearchHit, SearchPage, Span};
use crate::ipc::types::{self, EntryRef, EntryRow, Page};
use crate::library::{LibraryState, catalog_error, entry_reference};

fn reference(entry: &EntryRef) -> Result<(EntryId, RelPath), AppError> {
    entry_reference(entry).map(|entry| (entry.id, entry.path))
}

fn sort(sort: types::EntrySort) -> queries::EntrySort {
    queries::EntrySort {
        key: match sort.key {
            types::SortKey::Name => queries::SortKey::Name,
            types::SortKey::Path => queries::SortKey::Path,
            types::SortKey::Modified => queries::SortKey::Modified,
            types::SortKey::Size => queries::SortKey::Size,
            types::SortKey::FileType => queries::SortKey::FileType,
            types::SortKey::Added => queries::SortKey::Added,
        },
        descending: sort.descending,
    }
}

fn window(page: types::PageRequest) -> queries::PageRequest {
    queries::PageRequest {
        offset: page.offset,
        limit: page.limit,
    }
}

fn row(row: queries::Row) -> EntryRow {
    let record = row.entry.record;
    EntryRow {
        id: row.entry.id.to_string(),
        name: record.path.name().to_owned(),
        path: record.path.into(),
        kind: match record.kind {
            folio_core::meta::EntryKind::File => types::EntryKind::File,
            folio_core::meta::EntryKind::Folder => types::EntryKind::Folder,
        },
        class: match record.class {
            folio_core::meta::FileClass::Text => types::FileClass::Text,
            folio_core::meta::FileClass::Word => types::FileClass::Word,
            folio_core::meta::FileClass::Other => types::FileClass::Other,
        },
        size: record.size.to_string(),
        modified_ms: record
            .mtime_ns
            .map(|ns| ns.div_euclid(1_000_000).to_string()),
        added_ms: row.entry.added_ns.div_euclid(1_000_000).to_string(),
        tags: row.tags.into_iter().map(String::from).collect(),
        folder_tags: row.folder_tags.into_iter().map(String::from).collect(),
    }
}

fn page(result: queries::Page, offset: u32, stamp: ReadStamp) -> Page<EntryRow> {
    Page {
        items: result.items.into_iter().map(row).collect(),
        offset,
        total: result.total,
        revision: stamp.revision,
    }
}

fn query_error(error: queries::QueryError) -> AppError {
    match error {
        queries::QueryError::NotFound => AppError::NotFound(error.to_string()),
        queries::QueryError::InvalidArgument(_) => AppError::InvalidArgument(error.to_string()),
        queries::QueryError::Catalog(error) => catalog_error(error),
    }
}

/// Runs `query` on the open library's catalog, inside its switch/shutdown boundary.
fn read<T>(
    state: &LibraryState,
    query: impl FnOnce(&Catalog) -> Result<T, queries::QueryError>,
) -> Result<T, AppError> {
    state.read_catalog(|catalog| query(catalog).map_err(query_error))
}

pub(super) fn children(
    state: &LibraryState,
    request: ListChildren,
) -> Result<Page<EntryRow>, AppError> {
    let window = window(request.page);
    queries::check_page(window).map_err(query_error)?;
    let folder = request.folder.as_ref().map(reference).transpose()?;
    read(state, |catalog| {
        catalog.read_stamped(|tx, stamp| {
            let folder = folder.as_ref().map(|(id, path)| (*id, path));
            let result = queries::list_children(tx, folder, sort(request.sort), window)?;
            Ok(page(result, window.offset, stamp))
        })
    })
}

pub(super) fn files(state: &LibraryState, request: ListFiles) -> Result<Page<EntryRow>, AppError> {
    let window = window(request.page);
    queries::check_page(window).map_err(query_error)?;
    let filter = queries::FileFilter {
        tags: match request.filter.tags {
            Some(TagFilter::Untagged) => Some(queries::TagFilter::Untagged),
            Some(TagFilter::WithAll { tags }) => {
                // Count before parsing, so an oversized list is refused without reading it.
                queries::check_filter_tags(tags.len()).map_err(query_error)?;
                let tags = tags
                    .iter()
                    .map(|tag| {
                        TagId::parse(tag)
                            .map_err(|error| AppError::InvalidArgument(error.to_string()))
                    })
                    .collect::<Result<_, _>>()?;
                Some(queries::TagFilter::WithAll(tags))
            }
            None => None,
        },
        added_after_ms: request
            .filter
            .added_after_ms
            .as_ref()
            .map(|text| {
                if text.len() > 20 {
                    return Err(AppError::InvalidArgument("invalid addedAfterMs".to_owned()));
                }
                text.parse::<i64>()
                    .map_err(|_| AppError::InvalidArgument("invalid addedAfterMs".to_owned()))
            })
            .transpose()?,
    };
    let scope = request.scope.as_ref().map(reference).transpose()?;
    read(state, |catalog| {
        catalog.read_stamped(|tx, stamp| {
            let scope = scope.as_ref().map(|(id, path)| (*id, path));
            let result = queries::list_files(tx, scope, &filter, sort(request.sort), window)?;
            Ok(page(result, window.offset, stamp))
        })
    })
}

pub(super) fn get(state: &LibraryState, request: GetEntry) -> Result<EntryRow, AppError> {
    let (id, path) = reference(&request.entry)?;
    read(state, |catalog| {
        catalog.read_stamped(|tx, _| queries::get_entry(tx, id, &path).map(row))
    })
}

pub(super) fn find(state: &LibraryState, request: Search) -> Result<SearchPage, AppError> {
    // QueryTooLong wins over page/reference/library errors.
    let query = SearchQuery::parse(&request.text)
        .map_err(|error| AppError::QueryTooLong(error.to_string()))?;
    let window = window(request.page);
    queries::check_search_page(window).map_err(query_error)?;
    let scope = request.scope.as_ref().map(reference).transpose()?;
    read(state, |catalog| {
        catalog.read_stamped(|tx, stamp| {
            let scope = scope.as_ref().map(|(id, path)| (*id, path));
            let Some(query) = &query else {
                // Text without searchable words still checks its scope.
                queries::folder(tx, scope)?;
                return Ok(SearchPage {
                    items: Vec::new(),
                    offset: window.offset,
                    more: false,
                    revision: stamp.revision,
                });
            };
            let result = queries::search_page(tx, query, scope, window, stamp.ranked_at_secs)?;
            let spans = |spans: Vec<HitSpan>| {
                spans
                    .into_iter()
                    .map(|span| Span {
                        text: span.text,
                        matched: span.matched,
                    })
                    .collect()
            };
            Ok(SearchPage {
                items: result
                    .items
                    .into_iter()
                    .map(|hit| SearchHit {
                        entry: row(hit.entry),
                        name: spans(hit.text.name),
                        snippet: hit.text.snippet.map(spans),
                    })
                    .collect(),
                offset: window.offset,
                more: result.more,
                revision: stamp.revision,
            })
        })
    })
}

pub(super) fn paths(
    state: &LibraryState,
    request: ResolvePaths,
) -> Result<Vec<Option<EntryRow>>, AppError> {
    queries::check_paths(&request.paths).map_err(query_error)?;
    let (id, path) = reference(&request.base)?;
    read(state, |catalog| {
        catalog.read_stamped(|tx, _| {
            let rows = queries::resolve_paths(tx, (id, &path), &request.paths)?;
            Ok(rows.into_iter().map(|entry| entry.map(row)).collect())
        })
    })
}
