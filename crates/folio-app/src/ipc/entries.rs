//! Files and folders: listing, changing and opening them (docs/specs/ipc-m1.md §9, §11).

use serde::{Deserialize, Serialize};
use specta::Type;

use super::types::{EntryRef, EntrySort, PageRequest};

/// The children of one folder, folders first.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct ListChildren {
    /// `null`: the library root.
    pub folder: Option<EntryRef>,
    pub sort: EntrySort,
    pub page: PageRequest,
}

/// Files at any depth below a folder, filtered.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct ListFiles {
    /// `null`: the whole library, archived semesters included.
    pub scope: Option<EntryRef>,
    pub filter: EntryFilter,
    pub sort: EntrySort,
    pub page: PageRequest,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct EntryFilter {
    /// `null`: no tag filter.
    pub tags: Option<TagFilter>,
    /// Only files added after this time, in milliseconds since the Unix epoch.
    pub added_after_ms: Option<String>,
}

/// Filters by effective tags: a file's own and those of the folders above it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum TagFilter {
    /// Files that have every one of these tags (1 to `LIMITS.filterTags`).
    WithAll { tags: Vec<String> },
    /// Files without tags.
    Untagged,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct GetEntry {
    pub entry: EntryRef,
}

/// Finds the files a note names by relative path, such as the images next to it (spec §9.1).
/// The answer lists an `EntryRow` or `null` for each path, in the same order.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct ResolvePaths {
    /// The note: a file. Each path is resolved against its folder.
    pub base: EntryRef,
    /// Relative paths as the note writes them, percent-decoded, without `?` or `#` parts: names
    /// between `/` or `\`, with `.` and `..`. At most `LIMITS.resolvePaths`, each at most
    /// `LIMITS.relativePathChars` characters and well-formed: a lone surrogate fails the call.
    pub paths: Vec<String>,
}

/// A folder inside a course; semesters and courses have their own commands.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct CreateFolder {
    pub parent: EntryRef,
    pub name: String,
}

/// A new name in the same folder. A change of case only is a rename too.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct RenameEntry {
    pub entry: EntryRef,
    pub name: String,
}

/// Moves entries into a folder; tags and settings follow them.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct MoveEntries {
    pub entries: Vec<EntryRef>,
    /// `null`: the library root.
    pub to: Option<EntryRef>,
}

/// Moves entries to the Recycle Bin, folders with everything in them.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct DeleteEntries {
    pub entries: Vec<EntryRef>,
}

/// Opens an entry with its default program; programs and scripts never run (spec §11.1).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct OpenEntry {
    pub entry: EntryRef,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
pub struct Opened {
    pub mode: OpenMode,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum OpenMode {
    /// With the program registered to open it.
    Default,
    /// A program or script, opened with its registered editor instead of running it.
    Editor,
}

/// Opens File Explorer with the entry selected.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct RevealEntry {
    pub entry: EntryRef,
}

/// The header in which a failed `folio-file` response names the `AppError` code it failed with
/// (spec §11.2); exported to the UI as `FILE_ERROR_HEADER`.
pub const FILE_ERROR_HEADER: &str = "X-Folio-Error";

/// The codes a failed `folio-file` response carries; exported to the UI as `FILE_ERROR_CODES`.
/// `Pruned` and `HistoryDamaged` come from the version route (ipc-m2.md §11).
pub const FILE_ERROR_CODES: [&str; 11] = [
    "InvalidArgument",
    "NoLibrary",
    "NotFound",
    "AccessDenied",
    "InUse",
    "NotLocal",
    "NoThumbnail",
    "FileSystem",
    "Internal",
    "Pruned",
    "HistoryDamaged",
];
