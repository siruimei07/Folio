//! Events from the shell to the UI (docs/specs/ipc-m1.md §15). The UI only listens: the window
//! may not emit, and the shell listens to none of these.

use serde::Serialize;
use specta::Type;

use super::import::ImportSource;
use super::jobs::Job;
use super::library::LibraryStatus;
use super::types::{EntryRef, Point};

/// The library opened, was created, or became unavailable or read-only. Drop every cached page
/// and reference.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type, tauri_specta::Event)]
pub struct LibraryStateChanged {
    pub status: LibraryStatus,
}

/// Committed catalog changes, Folio's own or from other programs; at most ten a second, merged
/// (spec §15).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type, tauri_specta::Event)]
pub struct CatalogChanged {
    /// The catalog revision after these changes.
    pub revision: u32,
    /// At most `LIMITS.eventEntries` changes.
    pub entries: Vec<EntryChange>,
    /// `false`: more changed than `entries` lists, or the catalog was rebuilt. Refetch
    /// everything.
    pub complete: bool,
    /// Tag definitions changed: names, colours, order or deletions.
    pub tags: bool,
    /// Semesters or courses changed: their folders, settings or order.
    pub groups: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum EntryChange {
    Added {
        entry: EntryRef,
    },
    /// Its size, modification time or file id changed.
    Modified {
        entry: EntryRef,
    },
    /// The reference as it was.
    Removed {
        entry: EntryRef,
    },
    /// Its own tags changed; for a folder, the folder tags of everything below it too.
    Tagged {
        entry: EntryRef,
    },
    Moved {
        entry: EntryRef,
        from: String,
    },
}

/// A job changed state, or made progress (at most every 250 ms).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type, tauri_specta::Event)]
pub struct JobChanged {
    pub job: Job,
}

/// The problem list changed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Type, tauri_specta::Event)]
pub struct ProblemsChanged {
    pub total: u32,
}

/// Files or folders were dropped on the window. Import them with `check_import` and
/// `import_files`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type, tauri_specta::Event)]
pub struct FilesDropped {
    pub source: ImportSource,
    pub position: Point,
}

/// Files are dragged over the window; `position` is `null` when they leave or the drag ends.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Type, tauri_specta::Event)]
pub struct DropHover {
    pub position: Option<Point>,
}
