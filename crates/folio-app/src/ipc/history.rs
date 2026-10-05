//! History: the timeline of commits and operations, commit details, one file's history, reword,
//! uncommit and restore (docs/specs/ipc-m2.md §8, §10, versioning.md §8–§11).

use serde::{Deserialize, Serialize};
use specta::Type;

use super::types::{EntryKind, EntryRef, EntryRow, FileClass, PageRequest};

/// How a file or folder changed. `moved` is the Renamed status.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum ChangeKind {
    Added,
    Deleted,
    Modified,
    Moved,
}

/// What made a commit (history format §7.3).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum CommitKind {
    /// Made on a device.
    Commit,
    /// Direct edits found in the remote, shown as from iCloud (M3).
    Import,
    /// Thinning out old Word versions (M3); no message.
    Prune,
}

/// One version of a file in history. It can be shown, compared and restored when it is
/// `stored` and not `pruned`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
pub struct VersionSide {
    /// The content hash: `b3:` and 64 lowercase hexadecimal digits. The `folio-file` version
    /// route serves it.
    pub hash: String,
    /// Bytes, in decimal.
    pub size: String,
    /// The commit stored this version (versioning.md §5.1).
    pub stored: bool,
    /// Stored, then thinned out: no diff, no restore.
    pub pruned: bool,
}

/// The kinds of entry the timeline can show; `null` in a request shows every kind.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum HistoryType {
    /// Every commit kind.
    Commit,
    /// Message edits.
    Reword,
    /// Undone commits.
    Uncommit,
    /// Restored versions.
    Restore,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct ListHistory {
    pub page: PageRequest,
    /// `null`: every type. "Not synced" asks for `["commit"]` with a page of three.
    pub types: Option<Vec<HistoryType>>,
}

/// One entry of the timeline, newest first by `effectiveMs`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum HistoryItem {
    Commit {
        commit: CommitInfo,
        /// The first four changed files and folders, for the file card.
        files: Vec<ChangeRow>,
    },
    Reword(RewordEntry),
    Uncommit(UncommitEntry),
    Restore(RestoreEntry),
}

/// A commit of `HEAD`'s chain.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CommitInfo {
    /// `b3:` and 64 lowercase hexadecimal digits; the short id is the first 7 digits.
    pub id: String,
    /// `null` for the first commit.
    pub parent: Option<String>,
    pub kind: CommitKind,
    /// The library's first commit ("Start history"): it cannot be undone.
    pub first: bool,
    /// The newest commit: the only one `uncommit` takes.
    pub head: bool,
    /// Pushed to the remote; `false` for every commit in M2.
    pub synced: bool,
    /// Its own time, as its device's clock said, in milliseconds since the Unix epoch.
    pub time_ms: String,
    /// The later of its own time and its parent's effective time: the timeline's order and day
    /// headers.
    pub effective_ms: String,
    /// `null` for a prune commit.
    pub summary: Option<String>,
    pub body: Option<String>,
    pub device: Device,
    /// Changed files, `.folio/` left out. With `folders`, the rows of `list_commit_changes`;
    /// for the first commit, the files the library held ("4,210 files were in your library").
    pub files: u32,
    /// Changed folders.
    pub folders: u32,
    /// Its tag and settings changes: the rows of `list_commit_metadata`.
    pub metadata: u32,
    /// A prune commit: the versions it thinned out; 0 otherwise.
    pub pruned: u32,
}

/// The device that made a commit. Imports show as from iCloud; the UI words them by kind.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
pub struct Device {
    /// 32 lowercase hexadecimal digits.
    pub id: String,
    pub name: String,
}

/// A message edit (versioning.md §8.3).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RewordEntry {
    /// The operation's id: 16 lowercase hexadecimal digits.
    pub id: String,
    pub time_ms: String,
    /// The later of its own time and the previous operation's effective time.
    pub effective_ms: String,
    /// The reworded commit's id now: its new id, or a later one when it was reworded again.
    pub commit: String,
    /// Its id before this reword.
    pub previous: String,
}

/// An undone commit (versioning.md §8.4).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct UncommitEntry {
    pub id: String,
    pub time_ms: String,
    pub effective_ms: String,
    /// The commit taken back.
    pub commit: String,
    /// Its summary.
    pub summary: String,
}

/// A restored version (versioning.md §11).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RestoreEntry {
    pub id: String,
    pub time_ms: String,
    pub effective_ms: String,
    /// The version's commit, as its id is now.
    pub commit: String,
    /// The version's path in that commit.
    pub path: String,
    /// That commit's time: "the version from Oct 10".
    pub version_ms: String,
    /// The library path written.
    pub target: String,
    /// The file there went to the Recycle Bin first.
    pub recycled: bool,
}

/// Names a commit of `HEAD`'s chain; any other id, a reworded one included, is `NotFound`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct GetCommit {
    pub commit: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct ListCommitChanges {
    pub commit: String,
    pub page: PageRequest,
}

/// One changed file or folder of a commit; `.folio/` paths are `list_commit_metadata`'s.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ChangeRow {
    /// Names this change in `get_version_diff`.
    pub key: String,
    pub change: ChangeKind,
    pub kind: EntryKind,
    /// The path in this commit; the old one for a deletion.
    pub path: String,
    /// A move: the path in the parent.
    pub from_path: Option<String>,
    pub class: FileClass,
    /// The parent's version; `null` when added, and for folders.
    pub before: Option<VersionSide>,
    /// This commit's version; `null` when deleted, and for folders.
    pub after: Option<VersionSide>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct ListCommitMetadata {
    pub commit: String,
    pub page: PageRequest,
}

/// The file whose history to list.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum FileRef {
    /// A file in the Library or the Changes list.
    Entry { entry: EntryRef },
    /// A row of a commit in History.
    Version { commit: String, path: String },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct ListFileHistory {
    pub file: FileRef,
    pub page: PageRequest,
    /// `null`: every type.
    pub types: Option<Vec<HistoryType>>,
}

/// One entry of a file's history, newest first: the commits and restores that touched it,
/// following it through moves.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum FileVersion {
    Commit {
        commit: Box<CommitInfo>,
        /// The file's own row, with the path it had then.
        change: ChangeRow,
        /// The commit's other changed files: "and 2 other files in this commit".
        others: u32,
        /// The newest version whose content the file has on the disk now: "Current version".
        current: bool,
    },
    Restore(RestoreEntry),
}

/// A version: the file at `path` in `commit`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct VersionRef {
    pub commit: String,
    pub path: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RewordCommit {
    pub commit: String,
    /// Trimmed, then 1 to `LIMITS.summaryChars` characters without control characters.
    pub summary: String,
    /// Up to `LIMITS.bodyChars` characters; `null` or empty: none.
    pub body: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct Uncommit {
    /// Must be `HEAD`: otherwise `NotHead`.
    pub commit: String,
}

/// What `restore_version` would do now (spec §10).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum RestoreOutcome {
    /// The version replaces the file at its current path.
    Replace,
    /// The file was deleted: the version goes back to its last committed path.
    Recreate,
    /// A different file took that name: the version goes beside it under the keep-both name.
    Beside,
    /// The file already has this content: nothing to do.
    Unchanged,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
pub struct RestorePlan {
    pub outcome: RestoreOutcome,
    /// Where the version goes; for `unchanged`, the file's path.
    pub target: String,
    /// The file there goes to the Recycle Bin first: no version of `HEAD`'s chain keeps its
    /// content (uncommitted changes).
    pub recycle: bool,
    /// The file the version belongs to now (`locate_version`).
    pub current: Option<EntryRow>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
pub struct Restored {
    /// The library path written.
    pub target: String,
    /// The file there went to the Recycle Bin first.
    pub recycled: bool,
}
