//! The four workspace reads (ipc-m2.md §6): each checks what it can before anything is read
//! (§5.1, §16 rule 6), takes the workspace from the session's tracker, and converts the core's
//! answer to the contract's types.

use folio_core::catalog::{EntryId, queries};
use folio_core::paths::RelPath;
use folio_core::store::ChangeOp;
use folio_core::workspace::{
    self as core, Change, Item, Readiness as CoreReadiness, SelectionError, SettingsChange,
    Subject, Window,
};

use crate::error::AppError;
use crate::ipc::history::ChangeKind;
use crate::ipc::types::{self, EntryRef, Page};
use crate::ipc::workspace::{
    ChangeCounts, ItemPart, ItemSide, ListMetadataChanges, ListWorkspaceItems, MetadataChange,
    MetadataSubject, Place, Readiness, Selection, SelectionSummary, SummarizeSelection,
    SummaryGroup, WorkspaceItem, WorkspaceSummary,
};
use crate::library::LibraryState;
use crate::library::workspace::Current;

pub(super) fn summary(state: &LibraryState) -> Result<WorkspaceSummary, AppError> {
    let current = state.workspace()?;
    let workspace = current.workspace();
    let totals = workspace.totals();
    Ok(WorkspaceSummary {
        revision: current.revision(),
        history_state: current.history_state(),
        // The tracker has no too-large state yet; feat/core-commit-history maps the core's.
        too_large_folder: None,
        head: current.head(),
        fingerprint: workspace.fingerprint().to_string(),
        items: totals.items,
        metadata: totals.metadata,
        includable: totals.includable,
        hashing: totals.hashing,
        not_local: totals.not_local,
        unreadable: totals.unreadable,
    })
}

pub(super) fn items(
    state: &LibraryState,
    request: ListWorkspaceItems,
) -> Result<Page<WorkspaceItem>, AppError> {
    let window = window(request.page)?;
    let current = state.workspace()?;
    let rows = current.workspace().item_page(window).map_err(query_error)?;
    Ok(page(&current, window, rows, item))
}

pub(super) fn metadata(
    state: &LibraryState,
    request: ListMetadataChanges,
) -> Result<Page<MetadataChange>, AppError> {
    let window = window(request.page)?;
    let current = state.workspace()?;
    let rows = current
        .workspace()
        .metadata_page(window)
        .map_err(query_error)?;
    Ok(page(&current, window, rows, metadata_change))
}

pub(super) fn summarize(
    state: &LibraryState,
    request: SummarizeSelection,
) -> Result<SelectionSummary, AppError> {
    let selection = match request.selection {
        Selection::AllExcept { keys } => core::Selection::AllExcept(keys),
        Selection::Only { keys } => core::Selection::Only(keys),
    };
    // Over `batch` keys or a key over `keyChars`: refused before anything is read (§5.1).
    selection.check().map_err(selection_error)?;
    let current = state.workspace()?;
    let workspace = current.workspace();
    let chosen = workspace
        .resolve(&selection, &request.fingerprint)
        .map_err(selection_error)?;
    Ok(selection_summary(workspace.summarize(&chosen)))
}

/// The page a request asks for; a limit over `LIMITS.pageSize` is refused before anything is
/// read, by the rule every list follows (`queries::check_page`).
fn window(page: types::PageRequest) -> Result<queries::PageRequest, AppError> {
    let window = queries::PageRequest {
        offset: page.offset,
        limit: page.limit,
    };
    queries::check_page(window).map_err(query_error)?;
    Ok(window)
}

fn page<T, R>(
    current: &Current,
    window: queries::PageRequest,
    rows: Window<'_, T>,
    convert: impl Fn(&T) -> R,
) -> Page<R> {
    Page {
        items: rows.rows.iter().map(convert).collect(),
        offset: window.offset,
        total: rows.total,
        revision: current.revision(),
    }
}

/// A page outside the limits; nothing else reaches here, as the workspace is in memory.
fn query_error(error: queries::QueryError) -> AppError {
    AppError::InvalidArgument(error.to_string())
}

fn selection_error(error: SelectionError) -> AppError {
    match error {
        SelectionError::InvalidArgument(_) => AppError::InvalidArgument(error.to_string()),
        SelectionError::WorkspaceChanged => AppError::WorkspaceChanged(error.to_string()),
    }
}

fn item(item: &Item) -> WorkspaceItem {
    let change = item.change();
    let mut parts: Vec<ItemPart> = item.parts().iter().map(part).collect();
    // The change of the versioning rules it is bound to (§6.2), after the entries.
    if item.is_required() {
        parts.push(ItemPart::VersioningRules);
    }
    WorkspaceItem {
        key: change.key().to_owned(),
        change: change_kind(change.op()),
        kind: change.kind().into(),
        path: change.path().as_str().to_owned(),
        from_path: change.from_path().map(|path| path.as_str().to_owned()),
        entry: change.disk().map(|disk| entry_ref(disk.entry, &disk.path)),
        class: file_class(change.class()),
        content_changed: change.content_changed(),
        before: change.before().map(side),
        after: change.after().map(side),
        readiness: readiness(item.readiness()),
        files: change.files(),
        parts,
        required: item.is_required(),
        tags_changed: item.tags_changed(),
    }
}

fn part(change: &Change) -> ItemPart {
    ItemPart::Entry {
        change: change_kind(change.op()),
        entry_kind: change.kind().into(),
        path: change.path().as_str().to_owned(),
        from_path: change.from_path().map(|path| path.as_str().to_owned()),
    }
}

fn side(side: core::ItemSide) -> ItemSide {
    ItemSide {
        size: side.size.to_string(),
        stored: side.stored,
    }
}

pub(super) fn readiness(readiness: CoreReadiness) -> Readiness {
    match readiness {
        CoreReadiness::Ready => Readiness::Ready,
        CoreReadiness::Hashing => Readiness::Hashing,
        CoreReadiness::NotLocal => Readiness::NotLocal,
        CoreReadiness::Unreadable => Readiness::Unreadable,
    }
}

fn change_kind(op: ChangeOp) -> ChangeKind {
    match op {
        ChangeOp::Add => ChangeKind::Added,
        ChangeOp::Delete => ChangeKind::Deleted,
        ChangeOp::Modify => ChangeKind::Modified,
        ChangeOp::Move => ChangeKind::Moved,
    }
}

fn file_class(class: folio_core::meta::FileClass) -> types::FileClass {
    match class {
        folio_core::meta::FileClass::Text => types::FileClass::Text,
        folio_core::meta::FileClass::Word => types::FileClass::Word,
        folio_core::meta::FileClass::Other => types::FileClass::Other,
    }
}

/// The entry `id` at `path`, as the UI names entries (ipc-m1 §5.1).
fn entry_ref(id: EntryId, path: &RelPath) -> EntryRef {
    EntryRef {
        id: id.to_string(),
        path: path.as_str().to_owned(),
    }
}

fn metadata_change(change: &core::MetadataChange) -> MetadataChange {
    MetadataChange {
        key: change.key().to_owned(),
        change: change_kind(change.op()),
        subject: match change.subject() {
            Subject::Tags(tags) => MetadataSubject::Tags {
                path: tags.path.as_str().to_owned(),
                entry_kind: tags.kind.into(),
                entry: Some(entry_ref(tags.entry, &tags.path)),
            },
            Subject::Semester(settings) => MetadataSubject::Semester {
                path: settings.path.as_str().to_owned(),
                folder: folder(settings),
            },
            Subject::Course(settings) => MetadataSubject::Course {
                path: settings.path.as_str().to_owned(),
                folder: folder(settings),
            },
            Subject::TagDefinitions { .. } => MetadataSubject::TagDefinitions,
            Subject::Library { .. } => MetadataSubject::Library,
            Subject::IgnoreRules { .. } => MetadataSubject::IgnoreRules,
        },
    }
}

/// A settings change's folder on the disk; `null` once it is gone (§6.3).
fn folder<S>(settings: &SettingsChange<S>) -> Option<EntryRef> {
    settings
        .folder
        .map(|folder| entry_ref(folder, &settings.path))
}

fn selection_summary(summary: core::SelectionSummary) -> SelectionSummary {
    SelectionSummary {
        items: summary.items,
        metadata: summary.metadata,
        groups: summary.groups.into_iter().map(summary_group).collect(),
        tag_definitions: summary.tag_definitions,
        library: summary.library,
        ignore_rules: summary.ignore_rules,
    }
}

fn summary_group(group: core::SummaryGroup) -> SummaryGroup {
    SummaryGroup {
        place: place(group.place),
        files: counts(group.files),
        folders: counts(group.folders),
        tags: group.tags,
        settings: group.settings,
        items: group.items,
        available: group.available,
        selected: group.selected,
        required: group.required,
    }
}

/// A place keeps the name of its path, so a deleted course keeps its committed name (§6.4).
fn place(place: core::Place) -> Place {
    let name = place.name().unwrap_or_default().to_owned();
    match place {
        core::Place::Library => Place::Library,
        core::Place::Semester { path, folder } => Place::Semester {
            folder: folder.map(|folder| entry_ref(folder, &path)),
            path: path.into(),
            name,
        },
        core::Place::Course { path, folder, code } => Place::Course {
            folder: folder.map(|folder| entry_ref(folder, &path)),
            path: path.into(),
            name,
            code: code.map(String::from),
        },
    }
}

fn counts(counts: core::ChangeCounts) -> ChangeCounts {
    ChangeCounts {
        added: counts.added,
        modified: counts.modified,
        deleted: counts.deleted,
        moved: counts.moved,
    }
}
