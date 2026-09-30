//! Importing files from outside the library (docs/specs/ipc-m1.md §12).

use serde::{Deserialize, Serialize};
use specta::Type;

use super::types::{EntryKind, EntryRef};
use crate::error::AppError;

/// Files or folders the user picked in the shell's dialog or dropped on the window. `token`
/// stands for them in `check_import` and `import_files`; the paths stay in the shell.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
pub struct ImportSource {
    pub token: String,
    pub files: u32,
    pub folders: u32,
    /// The first ten top-level items, for display.
    pub names: Vec<ImportName>,
}

/// A top-level item of an import source.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
pub struct ImportName {
    pub name: String,
    /// What the item is itself: a link is a `file`, whatever it points to.
    pub kind: EntryKind,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct CheckImport {
    /// An `ImportSource` token.
    pub source: String,
    /// The folder to import into.
    pub target: EntryRef,
}

/// What an import would do: run it before `import_files` and ask once how to handle clashes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ImportCheck {
    pub files: u32,
    pub folders: u32,
    /// Bytes to copy, in decimal.
    pub bytes: String,
    /// Items that stay out: ignored by the library's rules, links and special files.
    pub skipped: u32,
    /// The first 100 clashes.
    pub conflicts: Vec<ImportConflict>,
    pub conflict_count: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
pub struct ImportConflict {
    /// A file in the library that the import would replace.
    pub path: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ImportFiles {
    /// An `ImportSource` token.
    pub source: String,
    pub target: EntryRef,
    /// Tags for every top-level item the import creates; a new folder passes them on.
    pub tags: Vec<String>,
    /// For every clash, also those that appear after the check.
    pub on_conflict: ConflictPolicy,
    /// Moves each source that was imported completely to the Recycle Bin.
    pub delete_originals: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum ConflictPolicy {
    /// The file in the library goes to the Recycle Bin; the new one takes its path and tags.
    Replace,
    /// The new file takes the first free name: `name (2).ext`, `name (3).ext`, …
    KeepBoth,
    /// The new file stays out.
    Skip,
}

/// The result of an import job.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ImportResult {
    pub imported: u32,
    pub replaced: u32,
    /// Imported under a new name (`KeepBoth`).
    pub renamed: u32,
    pub skipped: u32,
    pub originals_deleted: u32,
    /// The first 100 failures.
    pub failures: Vec<ImportFailure>,
    pub failure_count: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
pub struct ImportFailure {
    /// The item's path below its source.
    pub name: String,
    pub error: AppError,
}
