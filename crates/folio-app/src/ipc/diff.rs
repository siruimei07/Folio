//! Diffs of a workspace item or a commit's change, in folded pages (docs/specs/ipc-m2.md §9,
//! versioning.md §10).

use serde::{Deserialize, Serialize};
use specta::Type;

use crate::error::AppError;

/// The diff of a workspace item or metadata change: `HEAD`'s version against the disk.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct GetWorkspaceDiff {
    /// A key of `list_workspace_items` or `list_metadata_changes`.
    pub key: String,
    pub window: DiffWindow,
}

/// The diff of a commit's change: the parent's version against the commit's.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct GetVersionDiff {
    pub commit: String,
    /// A key of `list_commit_changes`, `list_commit_metadata` or a `FileVersion`'s `change`.
    pub key: String,
    pub window: DiffWindow,
}

/// Which rows a diff call answers with.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum DiffWindow {
    /// Rows `offset` to `offset + limit` of the folded diff; `limit` at most `LIMITS.diffRows`,
    /// 0 for the header only.
    Rows { offset: u32, limit: u32 },
    /// To unfold: `count` (1 to `LIMITS.diffRows`) unchanged lines from line `line` of the after
    /// side, which must all be unchanged.
    Unchanged { line: u32, count: u32 },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
pub struct Diff {
    /// The catalog revision it was read at.
    pub revision: u32,
    /// `null`: nothing before (added, or a file's first version).
    pub before: Option<DiffSide>,
    /// `null`: deleted.
    pub after: Option<DiffSide>,
    pub content: DiffContent,
    /// The entry's tag change, when its tags changed too.
    pub tags: Option<TagChange>,
}

/// One side of a diff.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DiffSide {
    /// The commit of this version; `null`: the file on the disk.
    pub commit: Option<String>,
    /// That commit's time, in milliseconds since the Unix epoch.
    pub time_ms: Option<String>,
    pub path: String,
    /// Bytes, in decimal.
    pub size: String,
    /// The content hash; `null` on the disk side until it is hashed.
    pub hash: Option<String>,
    /// History kept this version; on the disk side, whether a commit would store it now.
    pub stored: bool,
    pub pruned: bool,
}

/// What the diff shows. Conditions that only stop the comparison are kinds, not errors.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum DiffContent {
    /// Lines of text.
    Text { text: TextDiff },
    /// Paragraphs of a Word document's text.
    Word { text: TextDiff },
    /// A metadata change's row (the ignore rules are `text`).
    Metadata { detail: MetadataDetail },
    /// The content did not change: a move without edits.
    Same,
    /// A folder item: nothing to compare.
    Folder,
    /// A side is not kept: an event-only file, or text over the size limit.
    NotStored,
    /// A side was thinned out.
    Pruned,
    /// The disk side is a cloud placeholder or an offline file, which Folio never downloads.
    NotLocal,
    /// The disk side could not be read: `InUse`, `AccessDenied` or `FileSystem`.
    Unreadable { error: AppError },
    /// A text file with binary content.
    Binary,
    /// Over the limits: 8 MiB of text or 200,000 lines a side. `lines`: lines changed, when known.
    TooLarge { lines: Option<u32> },
}

/// A line diff (paragraphs for Word), folded: each change with up to three rows of context, and
/// a `fold` row for every run of hidden unchanged lines.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TextDiff {
    pub added: u32,
    pub removed: u32,
    /// Runs of consecutive added and removed rows: "Change 2 of 5".
    pub changes: u32,
    /// Rows of the folded diff, for paging.
    pub rows: u32,
    /// Past the one-second deadline: whole lines only, without marks.
    pub approximate: bool,
    /// The line endings changed; with `changes: 0`, only they did.
    pub line_endings: Option<LineEndingChange>,
    /// The encoding changed; the text may be the same.
    pub encoding: Option<EncodingChange>,
    /// The rows the window asked for.
    pub window: Vec<DiffRow>,
}

/// Line and paragraph numbers count from 1; `change` counts from 0, in order.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum DiffRow {
    Context {
        old: u32,
        #[serde(rename = "new")]
        new_line: u32,
        text: String,
    },
    Removed {
        old: u32,
        text: String,
        /// The changed words, trimmed of the spaces around them.
        marks: Vec<TextRange>,
        change: u32,
    },
    Added {
        #[serde(rename = "new")]
        new_line: u32,
        text: String,
        marks: Vec<TextRange>,
        change: u32,
    },
    /// `lines` unchanged lines from these numbers, hidden. Unfold with an `unchanged` window.
    Fold {
        old: u32,
        #[serde(rename = "new")]
        new_line: u32,
        lines: u32,
    },
}

/// A range of a row's text in UTF-16 code units, `end` exclusive.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Type)]
pub struct TextRange {
    pub start: u32,
    pub end: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum LineEnding {
    Lf,
    Crlf,
    Cr,
    Mixed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Type)]
pub struct LineEndingChange {
    pub before: LineEnding,
    pub after: LineEnding,
}

/// How a text file was decoded (versioning.md §10.2).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum TextEncoding {
    Utf8,
    Utf8Bom,
    Utf16Le,
    Utf16Be,
    /// GB18030, which contains GBK.
    Gb18030,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Type)]
pub struct EncodingChange {
    pub before: TextEncoding,
    pub after: TextEncoding,
}

/// A tag or settings change, read as data (versioning.md §10.4).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum MetadataDetail {
    Tags(TagChange),
    /// A semester's, a course's or the library's settings: only the fields that changed.
    Settings {
        changes: Vec<SettingChange>,
    },
    TagDefinitions {
        changes: Vec<TagDefinitionChange>,
    },
}

/// An entry's own tags.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
pub struct TagChange {
    pub added: Vec<TagLabel>,
    pub removed: Vec<TagLabel>,
    /// The after side's tags.
    pub now: Vec<TagLabel>,
}

/// A tag as that side's `tags.json` defines it, so a deleted tag is still named.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
pub struct TagLabel {
    pub id: String,
    /// `null`: no definition on that side.
    pub name: Option<String>,
    pub color: Option<String>,
}

/// One setting that changed. Settings never configured read as their defaults: `archived`
/// `false`, the others `null`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(tag = "field", rename_all = "camelCase")]
pub enum SettingChange {
    Abbr {
        before: Option<String>,
        after: Option<String>,
    },
    Code {
        before: Option<String>,
        after: Option<String>,
    },
    Color {
        before: Option<String>,
        after: Option<String>,
    },
    Archived {
        before: bool,
        after: bool,
    },
    Order {
        before: Option<u32>,
        after: Option<u32>,
    },
    /// The library's name.
    Name {
        before: String,
        after: String,
    },
    /// Bytes, in decimal.
    TextMaxSize {
        before: String,
        after: String,
    },
    TextExtensions {
        added: Vec<String>,
        removed: Vec<String>,
    },
    WordExtensions {
        added: Vec<String>,
        removed: Vec<String>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
pub struct TagDefinitionChange {
    pub id: String,
    /// `null`: added.
    pub before: Option<TagDefinition>,
    /// `null`: deleted.
    pub after: Option<TagDefinition>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
pub struct TagDefinition {
    pub name: String,
    /// A palette key.
    pub color: String,
    pub order: u32,
}
