//! The workspace: the disk compared with the last commit, and committing it
//! (docs/specs/ipc-m2.md §5–§7, versioning.md §6–§7).

use serde::{Deserialize, Serialize};
use specta::Type;

use super::history::ChangeKind;
use super::types::{EntryKind, EntryRef, FileClass, PageRequest};

/// Which items a commit, a summary or an AI message covers. Metadata changes are never listed:
/// every commit records them. Every selection includes the required items, listed or not.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Selection {
    /// Every includable item (ready or hashing) but these keys, and every required item:
    /// select-all and Ctrl+A, without loading every page. Includes an item that is not local or
    /// unreadable only when it is required, and then the commit fails with its error.
    AllExcept { keys: Vec<String> },
    /// These items, and every required item. One that is not local or unreadable fails the commit
    /// with its error.
    Only { keys: Vec<String> },
}

/// Where the library's history stands (spec §6.1).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum HistoryState {
    /// No commit yet: the library waits for its first full scan and hashing, then for
    /// `start_history`. The workspace lists nothing.
    None,
    /// The `firstCommit` job runs. The workspace lists nothing.
    Starting,
    Ready,
    /// A newer Folio wrote the history: commit, reword, uncommit and restore fail with
    /// `HistoryReadOnly`.
    ReadOnly,
    /// `HEAD` cannot be read or names a missing commit: those fail with `HistoryDamaged`. The
    /// files are fine.
    Damaged,
    /// The history would be, or is, larger than Folio keeps; not damage. After a first commit
    /// that failed with `HistoryTooLarge`, until the catalog's entries change, and also its
    /// tags or settings when the metadata in `.folio/` was too large (then `none` again); with
    /// a `HEAD` too large to show, until `HEAD` changes. Everything answers as before the first
    /// commit: the workspace lists nothing, `commit` is `NothingToCommit`, and the history
    /// lists no commit.
    TooLarge,
}

/// The Changes view's totals. Refetch it on `WorkspaceChanged`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceSummary {
    /// The catalog revision it was read at.
    pub revision: u32,
    pub history_state: HistoryState,
    /// In state `tooLarge`: the folder that holds too many files, a library path. `null` when
    /// the library as a whole is over the limits, when the head sync cannot name the folder,
    /// and in every other state. It changes only with the state.
    pub too_large_folder: Option<String>,
    /// `HEAD`'s commit id; `null` before the first commit. Send it back as a commit's `base`.
    pub head: Option<String>,
    /// 32 lowercase hexadecimal digits over the keys of every item, whether it is includable,
    /// and every metadata change (32 zeros when there is none). Send it back with selections.
    pub fingerprint: String,
    /// Rows of `list_workspace_items`; a bound item counts once.
    pub items: u32,
    /// Rows of `list_metadata_changes`. The badge and the header count `items + metadata`.
    pub metadata: u32,
    /// Items that are ready or hashing.
    pub includable: u32,
    pub hashing: u32,
    pub not_local: u32,
    pub unreadable: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct ListWorkspaceItems {
    pub page: PageRequest,
}

/// One change the user can include or leave out (versioning.md §6.3). Sorted by path.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceItem {
    /// Names the item while it exists: send it back as given, at most `LIMITS.keyChars`.
    pub key: String,
    /// The main change; a bound item's other changes are in `parts`.
    pub change: ChangeKind,
    pub kind: EntryKind,
    /// The new path; the old one for a deletion.
    pub path: String,
    /// A move: where it was.
    pub from_path: Option<String>,
    /// The catalog entry, for opening, revealing and its history; `null` for a deletion.
    pub entry: Option<EntryRef>,
    /// `other` for folders.
    pub class: FileClass,
    /// The content changed: always for `modified`, and for a moved file that was also edited.
    pub content_changed: bool,
    /// As `HEAD` has it; `null` when added, and for folders.
    pub before: Option<ItemSide>,
    /// As the disk has it; `null` when deleted, and for folders.
    pub after: Option<ItemSide>,
    pub readiness: Readiness,
    /// Folder items: the files they cover; 0 for an empty folder and for files.
    pub files: u32,
    /// A bound item's other changes, committed with it; empty otherwise. "2 changes" is
    /// `1 + parts.length`.
    pub parts: Vec<ItemPart>,
    /// Bound to a metadata change, which every commit records: every selection includes it.
    pub required: bool,
    /// The entry's tags changed too; its diff shows them under the content.
    pub tags_changed: bool,
}

/// One side of a workspace item.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
pub struct ItemSide {
    /// Bytes, in decimal; on the disk side `"0"` while the file is not local.
    pub size: String,
    /// `HEAD` stored this version; on the disk side, whether a commit would store it now.
    pub stored: bool,
}

/// Whether an item can be committed now (versioning.md §6.2).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum Readiness {
    Ready,
    /// Not hashed yet: the commit hashes it.
    Hashing,
    /// A cloud placeholder or an offline file: not includable until it is on this disk.
    NotLocal,
    /// The hashing job could not read it: not includable until it can.
    Unreadable,
}

/// Another change of a bound item.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ItemPart {
    #[serde(rename_all = "camelCase")]
    Entry {
        change: ChangeKind,
        entry_kind: EntryKind,
        path: String,
        from_path: Option<String>,
    },
    /// The versioning rules changed so that this file is stored now, while its own change was
    /// held back: it goes into the same commit.
    VersioningRules,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct ListMetadataChanges {
    pub page: PageRequest,
}

/// A tag or settings change that is not part of an item (versioning.md §6.4): always in the
/// commit, so it has no check box.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
pub struct MetadataChange {
    /// Names the change while it exists, like an item's key.
    pub key: String,
    /// `added` when nothing was committed before, `deleted` when nothing is left, else
    /// `modified`; never `moved`.
    pub change: ChangeKind,
    pub subject: MetadataSubject,
}

/// What a metadata change is about. In a commit's rows (`list_commit_metadata`) `entry` and
/// `folder` are always `null`: history names paths as they were.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum MetadataSubject {
    /// A file's or folder's own tags.
    #[serde(rename_all = "camelCase")]
    Tags {
        path: String,
        entry_kind: EntryKind,
        entry: Option<EntryRef>,
    },
    /// A semester's settings.
    Semester {
        path: String,
        folder: Option<EntryRef>,
    },
    /// A course's settings.
    Course {
        path: String,
        folder: Option<EntryRef>,
    },
    /// `tags.json`.
    TagDefinitions,
    /// `library.json`: the library's name and versioning rules.
    Library,
    /// `.folio/ignore`.
    IgnoreRules,
}

/// Summarizes a selection for the commit box, the template and grouped mode.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct SummarizeSelection {
    pub selection: Selection,
    /// `WorkspaceSummary.fingerprint`; a different one is `WorkspaceChanged`.
    pub fingerprint: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SelectionSummary {
    /// Included items. The commit button counts `items + metadata`.
    pub items: u32,
    /// Metadata changes, always included.
    pub metadata: u32,
    /// Every place with a change, in path order, the library root first.
    pub groups: Vec<SummaryGroup>,
    /// `tags.json` changed ("Update tags").
    pub tag_definitions: bool,
    /// `library.json` changed ("Update library settings").
    pub library: bool,
    /// `.folio/ignore` changed.
    pub ignore_rules: bool,
}

/// The changes of one course, semester or the library root.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
pub struct SummaryGroup {
    pub place: Place,
    /// Included file items, by change.
    pub files: ChangeCounts,
    /// Included folder items, by change.
    pub folders: ChangeCounts,
    /// Entries in it whose tag change the commit records: every tags row, and an item's when the
    /// selection includes it, or leaves it out but keeps its entry with the new tags (a modified
    /// entry at its path, a moved one at its old path). A held-back addition's tags wait.
    pub tags: u32,
    /// Its own settings changed: a semester's or a course's.
    pub settings: bool,
    /// Every item whose main path is in it, includable or not (blocked and required ones too);
    /// the places' `items` add up to `WorkspaceSummary.items`.
    pub items: u32,
    /// Its includable items and its required items, included or not: what a selection can
    /// include.
    pub available: u32,
    /// Its included items.
    pub selected: u32,
    /// Its required items (bound to a metadata change), whatever their readiness; `available`
    /// and `selected` count them too. The course header's box: `selected - required` of
    /// `available - required`.
    pub required: u32,
}

/// Where an item belongs: its course, else its semester, else the library root. A deleted
/// course or semester keeps its committed name, with `folder: null`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Place {
    /// Files and folders at the library root.
    Library,
    Semester {
        path: String,
        folder: Option<EntryRef>,
        name: String,
    },
    Course {
        path: String,
        folder: Option<EntryRef>,
        name: String,
        code: Option<String>,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Type)]
pub struct ChangeCounts {
    pub added: u32,
    pub modified: u32,
    pub deleted: u32,
    pub moved: u32,
}

/// Commits a selection as a job of kind `commit` (spec §7.1); the answer is the job id.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct CommitChanges {
    pub selection: Selection,
    /// `WorkspaceSummary.fingerprint` when the UI read the workspace.
    pub fingerprint: String,
    /// `WorkspaceSummary.head` when the UI read the workspace. Either one changed:
    /// `WorkspaceChanged`, before anything is written.
    pub base: Option<String>,
    /// What the user typed, the AI's, or the template: never empty. Trimmed, then 1 to
    /// `LIMITS.summaryChars` characters without control characters (spec §7.2).
    pub summary: String,
    /// Up to `LIMITS.bodyChars` characters; line breaks become LF. `null` or empty: none.
    pub body: Option<String>,
}

/// Starts the history with the first commit, as a job of kind `firstCommit` (spec §7.1).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct StartHistory {
    /// "Start history", from the UI's strings.
    pub summary: String,
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{HistoryState, WorkspaceSummary};

    fn summary(history_state: HistoryState, too_large_folder: Option<&str>) -> WorkspaceSummary {
        WorkspaceSummary {
            revision: 7,
            history_state,
            too_large_folder: too_large_folder.map(str::to_owned),
            head: None,
            fingerprint: "0".repeat(32),
            items: 0,
            metadata: 0,
            includable: 0,
            hashing: 0,
            not_local: 0,
            unreadable: 0,
        }
    }

    /// The too-large state and its folder as the UI reads them (ipc-m2.md §6.1).
    #[test]
    fn a_too_large_history_names_its_state_and_its_folder() {
        assert_eq!(
            serde_json::to_value(HistoryState::TooLarge).unwrap(),
            json!("tooLarge")
        );
        assert_eq!(
            serde_json::from_value::<HistoryState>(json!("tooLarge")).unwrap(),
            HistoryState::TooLarge
        );

        let folder =
            serde_json::to_value(summary(HistoryState::TooLarge, Some("Personal/Photos"))).unwrap();
        assert_eq!(folder["historyState"], json!("tooLarge"));
        assert_eq!(folder["tooLargeFolder"], json!("Personal/Photos"));

        assert_eq!(
            serde_json::to_value(summary(HistoryState::None, None)).unwrap(),
            json!({
                "revision": 7,
                "historyState": "none",
                "tooLargeFolder": null,
                "head": null,
                "fingerprint": "0".repeat(32),
                "items": 0,
                "metadata": 0,
                "includable": 0,
                "hashing": 0,
                "notLocal": 0,
                "unreadable": 0,
            })
        );
    }
}
