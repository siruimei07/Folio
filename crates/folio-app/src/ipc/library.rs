//! The library: its state on this machine, choosing its folder, creating and opening it
//! (docs/specs/ipc-m1.md §6).

use serde::{Deserialize, Serialize};
use specta::Type;

/// Whether this machine has a library and whether it is open. The shell opens the configured
/// library when it starts, and `library_status` waits for that.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum LibraryStatus {
    /// No library on this machine yet: the first-run flow.
    None,
    Open {
        library: LibraryInfo,
    },
    /// The configured library cannot be opened.
    Unavailable {
        /// The library folder, for display.
        root: String,
        reason: Unavailable,
    },
}

/// Why the library cannot be opened, or stopped working. The shell decides it where the failure
/// happens, never from an error code alone (spec §6).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum Unavailable {
    /// The folder cannot be reached: it is gone or not a folder, or its drive or share is not
    /// connected. Also any other failure to open, list or watch it, or to read `.folio/`, except
    /// those below.
    Missing,
    /// The folder is there, but `.folio/library.json` is missing or damaged, or `.folio/`
    /// holds a link.
    NotALibrary,
    /// A newer Folio wrote `library.json`; update Folio to open it.
    NewerFormat,
    /// Windows denied access to the folder or to `.folio/`.
    AccessDenied,
    /// The folder is there, but Folio's own state failed: the catalog could not be opened or
    /// written (another copy of Folio holds it, the disk is full), `.folio/` could not be
    /// written because its disk is full or another program holds a file, or the background
    /// work failed.
    CatalogFailed,
    /// A move or rename in Folio stopped halfway, and Folio can neither finish nor undo it:
    /// the item, the files below it, the metadata files it changed or the catalog changed
    /// since. `discard_unfinished_move` lets go of it, once the user confirms.
    UnfinishedMove,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct LibraryInfo {
    pub id: String,
    pub name: String,
    /// The library folder, for display.
    pub root: String,
    /// A newer Folio wrote some metadata: tags and settings cannot change until Folio is
    /// updated (ADR-0002 §3).
    pub read_only: bool,
    /// The catalog was replaced when it opened, and the running scan rebuilds it.
    pub recovered: bool,
}

/// A folder the user chose in the shell's folder dialog. `token` stands for it in
/// `create_library` and `open_library`; `path` is for display only.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct FolderChoice {
    pub token: String,
    pub path: String,
    pub content: FolderContent,
    /// The folder is inside a cloud-sync folder: warn (ADR-0002 §6).
    pub sync_root: Option<SyncProvider>,
}

/// What the chosen folder holds, from one listing.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum FolderContent {
    Empty,
    /// Already a Folio library: open it.
    Library {
        name: String,
    },
    /// Inside another library, which `create_library` refuses.
    InsideLibrary {
        root: String,
    },
    /// A `.folio/` folder without `library.json`: a library whose creation did not finish.
    /// `create_library` finishes it and keeps what `.folio/` holds. The counts leave `.folio/`
    /// out.
    Incomplete {
        folders: u32,
        files: u32,
    },
    /// Content to take over: its first-level folders (the would-be semesters) and files.
    Folders {
        folders: u32,
        files: u32,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum SyncProvider {
    ICloud,
    OneDrive,
    Dropbox,
    Other,
}

/// Makes the chosen folder this machine's library: a new one in an empty folder, taking over
/// the content of a folder without moving anything (brief §5.1), or finishing an incomplete one.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CreateLibrary {
    /// A `FolderChoice` token.
    pub folder: String,
    pub name: String,
    pub preset_tags: PresetTagNames,
}

/// Names of the preset tags in the UI's language; the core owns their ids and colours.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct PresetTagNames {
    pub notes: String,
    pub slides: String,
    pub homework: String,
    pub exam: String,
    pub reference: String,
}

/// Makes a folder that holds `.folio/library.json` this machine's library.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct OpenLibrary {
    /// A `FolderChoice` token.
    pub folder: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
pub struct LibraryOpened {
    pub library: LibraryInfo,
    /// The id of the scan job the library started.
    pub scan: String,
}
