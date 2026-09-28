//! Problems that scans found: things the user should know about, while the scan went on
//! (docs/specs/ipc-m1.md §14, library-scan.md §9).

use serde::{Deserialize, Serialize};
use specta::Type;

use super::types::PageRequest;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct ListProblems {
    pub page: PageRequest,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
pub struct ProblemItem {
    /// Stays the same while the problem does.
    pub id: String,
    pub problem: Problem,
    /// For logs and bug reports.
    pub detail: String,
}

/// `folder` is the path of the folder that holds `name`; `null` is the library root.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Problem {
    /// A name that is not valid Unicode, left out with everything below it.
    NotUnicode {
        folder: Option<String>,
        name: String,
    },
    /// A name Windows does not allow, left out with everything below it.
    InvalidName {
        folder: Option<String>,
        name: String,
        rule: NameRule,
    },
    /// A name in another Unicode form than NFC, left out until it is renamed. `twin`: the NFC
    /// form of the name is there too.
    NotNfc {
        folder: Option<String>,
        name: String,
        twin: bool,
    },
    /// Names in one folder that differ only in case; all of them are in the library.
    CaseTwins { paths: Vec<String> },
    /// A symbolic link or junction, never followed.
    Link {
        folder: Option<String>,
        name: String,
    },
    /// Neither a file nor a folder.
    Special {
        folder: Option<String>,
        name: String,
    },
    /// A folder that could not be listed, whose entries stay as they were, or a file that could
    /// not be read.
    Unreadable { path: String, failure: ReadFailure },
    /// A line of `.folio/ignore` (`file` is `null`) or of a `.gitignore` that is not a valid
    /// pattern; the other lines apply. Line 0 is the whole file.
    InvalidIgnoreRule { file: Option<String>, line: u32 },
    /// A metadata file, by its path below the library, that could not be read.
    Metadata {
        file: String,
        failure: MetadataFailure,
    },
    /// Settings or tags in `.folio/meta/` for a semester or course folder that does not exist.
    OrphanedMetadata { folder: String },
    /// Tags or settings that could not follow a moved entry.
    NotRelocated {
        from: String,
        to: String,
        cause: StrandedCause,
    },
}

/// Which rule for names a name breaks (library core §3).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum NameRule {
    Empty,
    NotNfc,
    /// `.` or `..`.
    DotName,
    /// `< > : " / \ | ? *` or a control character.
    InvalidCharacter,
    TrailingDotOrSpace,
    /// A device name such as `CON` or `NUL`, with any extension.
    ReservedName,
    /// Longer than 255 UTF-16 code units.
    TooLong,
    /// The whole path is longer than 32,767 UTF-16 code units.
    PathTooLong,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum ReadFailure {
    Denied,
    /// Another program holds it.
    InUse,
    /// Larger than Folio reads.
    TooLarge,
    Other,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum MetadataFailure {
    /// A newer Folio wrote it: the metadata is read-only until Folio is updated.
    Newer,
    /// Not a valid metadata file.
    Invalid,
    Unreadable {
        failure: ReadFailure,
    },
}

/// Why tags or settings could not follow a move.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum StrandedCause {
    /// A newer Folio wrote the metadata.
    ReadOnly,
    /// The entry became a semester or course folder, which cannot have tags.
    FolderTags,
    /// The file that holds them, or would hold them, cannot be read.
    Unreadable,
    /// Their new path would be longer than Windows allows.
    TooLong,
}
