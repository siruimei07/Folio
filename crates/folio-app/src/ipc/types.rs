//! Types every area of the contract shares (docs/specs/ipc-m1.md §4–§5).

use serde::{Deserialize, Serialize};
use specta::Type;

use crate::error::AppError;

/// The limits the shell enforces, exported to the UI as `LIMITS` (spec §4.1).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Limits {
    /// The most items in one page.
    pub page_size: u32,
    /// The most search results in all: `offset + limit` of a search page.
    pub search_results: u32,
    /// Search text, in characters.
    pub query_chars: u32,
    /// Entries in one batch command.
    pub batch: u32,
    /// Tags in one filter.
    pub filter_tags: u32,
    /// A file or folder name, in UTF-16 code units.
    pub name_units: u32,
    /// A library or tag name, in characters.
    pub display_name_chars: u32,
    /// A course badge, in grapheme clusters.
    pub abbr_graphemes: u32,
    /// A course code, in characters.
    pub course_code_chars: u32,
    /// Changes listed in one `CatalogChanged`.
    pub event_entries: u32,
}

pub const LIMITS: Limits = Limits {
    page_size: 500,
    search_results: 500,
    query_chars: to_u32(folio_core::search::MAX_QUERY_CHARS),
    batch: 10_000,
    filter_tags: 16,
    name_units: to_u32(folio_core::paths::MAX_NAME_UNITS),
    // The next three are rules of the core's `meta` values, which has no constants for them yet:
    // `DisplayName` allows 128 characters; `Abbr` allows only 2 grapheme clusters until the lane
    // that implements course settings widens it and adds the course code (spec §20). That lane
    // turns these rules into core constants and takes them from there, like the two above.
    display_name_chars: 128,
    abbr_graphemes: 3,
    course_code_chars: 32,
    event_entries: 200,
};

/// A core limit as a `u32`; a limit that does not fit fails the build.
const fn to_u32(value: usize) -> u32 {
    assert!(value <= u32::MAX as usize);
    value as u32
}

/// An entry as the UI names it: its catalog id and the path where the UI saw it. The shell acts
/// only if the catalog has that id at that path; otherwise the command fails with `NotFound`
/// (spec §5.1).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct EntryRef {
    /// The catalog id, in decimal. Kept when the entry moves or is renamed.
    pub id: String,
    /// The path below the library root: NFC, `/` between names.
    pub path: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum EntryKind {
    File,
    Folder,
}

/// What a file is, from its extension (library core §4.2): whether its versions are kept.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum FileClass {
    Text,
    Word,
    /// Everything else, folders included.
    Other,
}

/// A file or folder as lists show it (spec §5.2).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct EntryRow {
    pub id: String,
    pub path: String,
    /// The last name of the path.
    pub name: String,
    pub kind: EntryKind,
    pub class: FileClass,
    /// Bytes, in decimal; `"0"` for folders.
    pub size: String,
    /// Milliseconds since the Unix epoch, in decimal. A hint only (ADR-0003 §10).
    pub modified_ms: Option<String>,
    /// When the entry came into the library, in milliseconds since the Unix epoch.
    pub added_ms: String,
    /// Its own tag ids, in tag order. Ids that `list_tags` does not know are shown as unknown.
    pub tags: Vec<String>,
    /// Tag ids it gets from the folders above it (spec §8.2), not repeating `tags`.
    pub folder_tags: Vec<String>,
}

/// A window into a list. `limit` 0 returns only the total.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct PageRequest {
    pub offset: u32,
    /// At most `LIMITS.pageSize`.
    pub limit: u32,
}

/// One window of a sorted list.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
pub struct Page<T> {
    pub items: Vec<T>,
    pub offset: u32,
    /// Items in the whole list.
    pub total: u32,
    /// The catalog revision the page was read at (spec §15.2).
    pub revision: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct EntrySort {
    pub key: SortKey,
    pub descending: bool,
}

/// Ties go to the path, so pages never overlap. Missing modification times sort last.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum SortKey {
    /// Without case, digits by value (`hw2` before `hw10`), as File Explorer sorts.
    Name,
    /// For building a tree from flat pages.
    Path,
    Modified,
    Size,
    /// By extension, then name.
    #[serde(rename = "type")]
    FileType,
    Added,
}

/// What a batch command did: items are independent, so some may fail while others succeed.
#[derive(Debug, Clone, Serialize, Type)]
pub struct BatchResult {
    pub done: u32,
    /// Every item that failed.
    pub failed: Vec<ItemFailure>,
}

#[derive(Debug, Clone, Serialize, Type)]
pub struct ItemFailure {
    pub entry: EntryRef,
    pub error: AppError,
}

/// A point in the window's client area, in CSS pixels.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Type)]
pub struct Point {
    pub x: i32,
    pub y: i32,
}
