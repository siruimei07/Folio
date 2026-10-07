//! The changes between `HEAD`'s tree and the disk (versioning.md §6.1–§6.3): what a comparison
//! of the two gives, before changes are bound into items.
//!
//! A [`Comparison`] holds the rows of `HEAD`'s flattened tree that may have changed, each with the
//! catalog entry it is paired with, and the entries no row pairs with. [`compare`] walks the rows
//! by path, parents first, and gives each its fate in the *frame* of its parent folder: where its
//! parent folder is on the disk now.
//!
//! - A row paired with an entry at its own path is in place: modified when its content changed.
//! - A row paired with an entry at its frame's place (its parent folder moved, and it moved with
//!   it) is *carried* by the nearest folder move: no change of its own, unless its content
//!   changed, which is a modification at its new path.
//! - A row paired with an entry anywhere else moved: a file move, or a folder move whose children
//!   are then in its frame (nested frames).
//! - A row without an entry is deleted. A folder deletion *covers* the rows deleted with it: those
//!   without an entry whose parent row it, or a folder it covers, is. Whatever left it is a change
//!   of its own.
//! - An entry no row pairs with is added; a new folder is a change only when nothing is below it
//!   (an empty folder), since one with content comes in with what it holds.
//!
//! A pairing whose kinds differ counts as a deleted row and an added entry. Paths in `.folio/` are
//! never changes. Content is known changed when the sizes differ or the entry's hash is known and
//! differs: a file at its place with an unknown hash and an equal size is unchanged until hashed
//! (lane decision 10).
//!
//! The walk also records what binding and a selection's tree need ([`Compared`]): the fate of
//! each row that is not in place, the disk's folders that are not where `HEAD` has them, the rows
//! in place below a folder that left (*pinned*: they stay at their path whatever the selection),
//! the moves out of deleted folders, and, when the versioning rules changed, the changes that
//! hold back a file whose committed content the disk no longer has and the new rules store
//! (versioning.md §5.2: bound rule 4).

use std::collections::{HashMap, HashSet};

use super::keys;
use crate::catalog::EntryId;
use crate::hash::ContentHash;
use crate::meta::{EntryKind, FileClass, VersioningRules, is_folio_owned};
use crate::paths::RelPath;
use crate::store::ChangeOp;

/// A path of `HEAD`'s tree, as the catalog's `head_files` holds it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HeadRow {
    pub path: RelPath,
    /// A file's content hash, size and `stored`; `None` for a folder.
    pub file: Option<HeadFile>,
}

impl HeadRow {
    pub fn kind(&self) -> EntryKind {
        match self.file {
            Some(_) => EntryKind::File,
            None => EntryKind::Folder,
        }
    }
}

/// A file as `HEAD` has it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HeadFile {
    pub hash: ContentHash,
    pub size: u64,
    pub stored: bool,
}

/// A catalog entry as the comparison needs it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DiskRow {
    pub entry: EntryId,
    pub path: RelPath,
    pub kind: EntryKind,
    /// `other` for folders.
    pub class: FileClass,
    /// Bytes; 0 for folders.
    pub size: u64,
    pub hash: Option<ContentHash>,
    /// Why a file without a hash is still unhashed (versioning.md §6.2); `None` while the hashing
    /// job has yet to reach it. Ignored once the file has a hash.
    pub blocked: Option<Blocked>,
    /// A folder with nothing below it on the disk. Needed for every folder entry passed, paired
    /// ones too: a pairing of two kinds makes its entry an addition.
    pub empty: bool,
}

/// Why the hashing job left a file unhashed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Blocked {
    /// Its content is not on this disk: a cloud placeholder, an offline file.
    NotLocal,
    /// It could not be read: in use, access denied.
    Unreadable,
}

/// What the workspace compares (versioning.md §6.1): the rows of `HEAD`'s tree that may differ
/// from the disk, and the entries no row pairs with. Every row without an entry must be here; a
/// paired row that is not here is unchanged at its path.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Comparison {
    /// Rows paired with an entry that may differ from them (another path, kind, size or hash),
    /// each with that entry. Rows in place may come too: they are no change.
    pub paired: Vec<(HeadRow, DiskRow)>,
    /// Rows without an entry.
    pub deleted: Vec<HeadRow>,
    /// Entries no row pairs with.
    pub added: Vec<DiskRow>,
}

impl Comparison {
    /// Whether a row without an entry and an entry no row pairs with have one path and one kind:
    /// what `catalog::head_files::pair_by_path` would pair (§6.1), so the loader pairs and reads
    /// again. It tells from the comparison's read, without the query of the unpaired rows that
    /// takes 200 ms when 50,000 rows lost their entries.
    pub fn pairable(&self) -> bool {
        if self.deleted.is_empty() || self.added.is_empty() {
            return false;
        }
        let added: HashSet<(&RelPath, EntryKind)> = self
            .added
            .iter()
            .map(|entry| (&entry.path, entry.kind))
            .collect();
        self.deleted
            .iter()
            .any(|row| added.contains(&(&row.path, row.kind())))
    }
}

/// What a change is (versioning.md §6.3), which its key names.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Code {
    FileAdded,
    FileDeleted,
    FileModified,
    FileMoved,
    /// An empty folder.
    FolderAdded,
    FolderDeleted,
    FolderMoved,
}

impl Code {
    /// The change as the history and the UI call it.
    pub fn op(self) -> ChangeOp {
        match self {
            Self::FileAdded | Self::FolderAdded => ChangeOp::Add,
            Self::FileDeleted | Self::FolderDeleted => ChangeOp::Delete,
            Self::FileModified => ChangeOp::Modify,
            Self::FileMoved | Self::FolderMoved => ChangeOp::Move,
        }
    }

    pub fn kind(self) -> EntryKind {
        match self {
            Self::FileAdded | Self::FileDeleted | Self::FileModified | Self::FileMoved => {
                EntryKind::File
            }
            Self::FolderAdded | Self::FolderDeleted | Self::FolderMoved => EntryKind::Folder,
        }
    }

    /// The code as keys write it.
    pub(super) fn letters(self) -> &'static str {
        match self {
            Self::FileAdded => "fa",
            Self::FileDeleted => "fd",
            Self::FileModified => "fm",
            Self::FileMoved => "fv",
            Self::FolderAdded => "da",
            Self::FolderDeleted => "dd",
            Self::FolderMoved => "dv",
        }
    }
}

/// Whether a change can be committed now (versioning.md §6.2), from the best to the worst: a bound
/// item has the worst of its changes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Readiness {
    Ready,
    /// Not hashed yet: the commit hashes it.
    Hashing,
    /// The hashing job could not read it.
    Unreadable,
    /// Its content is not on this disk.
    NotLocal,
}

impl Readiness {
    /// Ready or hashing: an `allExcept` selection includes it (ipc-m2.md §5.1).
    pub fn is_includable(self) -> bool {
        matches!(self, Self::Ready | Self::Hashing)
    }
}

/// One side of a file's change.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ItemSide {
    /// Bytes; on the disk side 0 while the file is not local (ipc-m2.md §6.2).
    pub size: u64,
    /// `HEAD` stored this version; on the disk side, whether a commit would store it now.
    pub stored: bool,
}

/// One change of the workspace (versioning.md §6.3).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Change {
    code: Code,
    key: String,
    path: RelPath,
    from_path: Option<RelPath>,
    head: Option<HeadRow>,
    disk: Option<DiskRow>,
    class: FileClass,
    content_changed: bool,
    readiness: Readiness,
    before: Option<ItemSide>,
    after: Option<ItemSide>,
    covered: Vec<RelPath>,
    files: u32,
}

/// What a change goes from and to.
enum Sides {
    /// A deletion: the row only.
    Head(HeadRow),
    /// An addition: the entry only.
    Disk(DiskRow),
    /// A modification or a move: the row and its entry.
    Both(HeadRow, DiskRow),
}

impl Change {
    /// The change of `code` between `sides`, under the disk's versioning rules.
    fn new(code: Code, sides: Sides, rules: &VersioningRules) -> Self {
        let (path, from_path, head, disk) = match sides {
            Sides::Head(head) => (head.path.clone(), None, Some(head), None),
            Sides::Disk(disk) => (disk.path.clone(), None, None, Some(disk)),
            Sides::Both(head, disk) => {
                let from_path = (code.op() == ChangeOp::Move).then(|| head.path.clone());
                (disk.path.clone(), from_path, Some(head), Some(disk))
            }
        };
        let folder = code.kind() == EntryKind::Folder;
        let class = match &disk {
            _ if folder => FileClass::Other,
            Some(disk) => disk.class,
            None => rules.class_of(&path),
        };
        let content_changed = match (code, &head, &disk) {
            (Code::FileModified, _, _) => true,
            (Code::FileMoved, Some(head), Some(disk)) => content_changed(head, disk),
            _ => false,
        };
        let readiness = disk.as_ref().map_or(Readiness::Ready, readiness_of);
        let before = head
            .as_ref()
            .and_then(|head| head.file.as_ref())
            .map(|file| ItemSide {
                size: file.size,
                stored: file.stored,
            });
        let after = disk.as_ref().filter(|_| !folder).map(|disk| ItemSide {
            size: if readiness == Readiness::NotLocal {
                0
            } else {
                disk.size
            },
            stored: rules.is_stored(disk.class, disk.size),
        });
        Self {
            code,
            key: keys::change_key(code, &path, from_path.as_ref()),
            path,
            from_path,
            head,
            disk,
            class,
            content_changed,
            readiness,
            before,
            after,
            covered: Vec::new(),
            files: 0,
        }
    }

    pub fn code(&self) -> Code {
        self.code
    }

    /// Names the change while it exists (ipc-m2.md §4): at most [`keys::MAX_KEY_CHARS`]
    /// characters.
    pub fn key(&self) -> &str {
        &self.key
    }

    /// Added, deleted, modified or moved.
    pub fn op(&self) -> ChangeOp {
        self.code.op()
    }

    pub fn kind(&self) -> EntryKind {
        self.code.kind()
    }

    /// The path on the disk; `HEAD`'s path for a deletion.
    pub fn path(&self) -> &RelPath {
        &self.path
    }

    /// Where a move came from, as `HEAD` has it.
    pub fn from_path(&self) -> Option<&RelPath> {
        self.from_path.as_ref()
    }

    /// The catalog entry; `None` for a deletion.
    pub fn entry(&self) -> Option<EntryId> {
        self.disk.as_ref().map(|disk| disk.entry)
    }

    /// The row of `HEAD`'s tree it changes; `None` for an addition. A modification inside a moved
    /// folder has `HEAD`'s path here and the disk's as its path.
    pub fn head(&self) -> Option<&HeadRow> {
        self.head.as_ref()
    }

    /// The entry as the disk has it; `None` for a deletion.
    pub fn disk(&self) -> Option<&DiskRow> {
        self.disk.as_ref()
    }

    /// `other` for folders.
    pub fn class(&self) -> FileClass {
        self.class
    }

    /// Always for a modification; for a moved file that was also edited.
    pub fn content_changed(&self) -> bool {
        self.content_changed
    }

    /// Ready for deletions and folders; else from the entry's hash and why it has none.
    pub fn readiness(&self) -> Readiness {
        self.readiness
    }

    /// The file as `HEAD` has it; `None` when added, and for folders.
    pub fn before(&self) -> Option<ItemSide> {
        self.before
    }

    /// The file as the disk has it; `None` when deleted, and for folders.
    pub fn after(&self) -> Option<ItemSide> {
        self.after
    }

    /// `HEAD`'s paths of the rows a folder change covers, beside its own: for a deletion the rows
    /// deleted with it; for a move every row that moved with it, those whose content changed (a
    /// modification of their own) included. Empty for other changes.
    pub fn covered(&self) -> &[RelPath] {
        &self.covered
    }

    /// The files a folder change covers that have no change of their own; 0 for an empty folder
    /// and for files.
    pub fn files(&self) -> u32 {
        self.files
    }

    fn cover(&mut self, row: &HeadRow, counts: bool) {
        self.covered.push(row.path.clone());
        if counts && row.kind() == EntryKind::File {
            self.files = self.files.saturating_add(1);
        }
    }
}

/// What a comparison gives: its changes, and what binding them and building a selection's tree
/// need. Indices are into `changes`.
#[derive(Debug, Default)]
pub(super) struct Compared {
    pub(super) changes: Vec<Change>,
    /// The fate of every row that is not in place, by its path in `HEAD`. A row not here stays at
    /// its path with `HEAD`'s content.
    pub(super) fates: HashMap<RelPath, Fate<usize>>,
    /// The disk's folders that are not where `HEAD` has them, by their paths on the disk. A folder
    /// not here is paired with the row at its path.
    pub(super) folders: HashMap<RelPath, DiskFolder>,
    /// The frames of the folder rows that are not in place, by their paths in `HEAD`.
    pub(super) frames: HashMap<RelPath, Frame>,
    /// Rows in place whose parent folder is not ([`Pinned`]).
    pub(super) pinned: Vec<Pinned>,
    /// Each move out of a deleted folder, with that folder's deletion (the second index).
    pub(super) escapes: Vec<(usize, usize)>,
    /// The changes that, held back, keep a file of `HEAD`'s whose content is no longer on the disk
    /// (a modification, an edited move, a deletion or the folder deletion that covers it) and
    /// that the disk's versioning rules store while `HEAD`'s did not: the commit that records the
    /// new rules needs its blob, which only that change can avoid (versioning.md §5.2).
    pub(super) rules_bound: Vec<usize>,
}

/// What happens to a row of `HEAD`'s tree that is not in place, or is in place below a folder
/// that is not. `C` names a change. A row *in its frame* follows its parent folder wherever the
/// selection puts that folder; a row with no fate is in its frame.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Fate<C> {
    /// Deleted by the change, its own or the folder deletion that covers it: gone when that change
    /// is committed, else in its frame.
    Deleted(C),
    /// Moved by its own change: at its entry's place when that change is committed, else in its
    /// frame.
    Moved(C),
    /// Moved with its folder: always in its frame. `edit` changed its content, if any.
    Carried { edit: Option<C> },
    /// In its frame, its content changed by the change.
    Edited(C),
    /// In place below a folder that is not ([`Pinned`]): at its entry's place (its own path, as
    /// the commit translates it) when `leaver` is committed, else in its frame. `edit` changed
    /// its content, if any.
    Pinned { leaver: C, edit: Option<C> },
}

impl<C: Copy> Fate<C> {
    pub(super) fn map<D>(self, f: impl Fn(C) -> D) -> Fate<D> {
        match self {
            Self::Deleted(change) => Fate::Deleted(f(change)),
            Self::Moved(change) => Fate::Moved(f(change)),
            Self::Carried { edit } => Fate::Carried { edit: edit.map(f) },
            Self::Edited(change) => Fate::Edited(f(change)),
            Self::Pinned { leaver, edit } => Fate::Pinned {
                leaver: f(leaver),
                edit: edit.map(f),
            },
        }
    }
}

/// A folder of the disk that is not where `HEAD` has it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum DiskFolder {
    /// The entry of `HEAD`'s folder at this path (`HEAD`'s path).
    Paired(RelPath),
    /// No row pairs with it, or one of the other kind.
    New,
}

/// A row paired with an entry at its own path whose parent folder is not in place: it moved out
/// of that folder before the folder moved or went, or the folder's place was made again around
/// it. It is a move of its own that no item shows: it leaves its parent's frame for its place on
/// the disk exactly when `leaver`, the change that decides where its parent goes, is committed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct Pinned {
    pub(super) path: RelPath,
    pub(super) leaver: usize,
    pub(super) folder: bool,
}

/// The changes of a comparison, under the disk's versioning rules, in no particular order, with
/// what binding and selections need. `rules_changed`: the disk's rules are not `HEAD`'s.
pub(super) fn compare(
    comparison: Comparison,
    rules: &VersioningRules,
    rules_changed: bool,
) -> Compared {
    let Comparison {
        paired,
        deleted,
        mut added,
    } = comparison;
    let mut rows = Vec::with_capacity(paired.len() + deleted.len());
    for (row, entry) in paired {
        if row.kind() == entry.kind {
            rows.push((row, Some(entry)));
        } else {
            rows.push((row, None));
            added.push(entry);
        }
    }
    rows.extend(deleted.into_iter().map(|row| (row, None)));
    rows.retain(|(row, _)| !is_folio_owned(&row.path));
    // A parent's path is a prefix of its children's, so it sorts first.
    rows.sort_unstable_by(|(a, _), (b, _)| a.path.cmp(&b.path));
    let mut walk = Walk {
        rules,
        rules_changed,
        compared: Compared::default(),
    };
    for (row, entry) in rows {
        match entry {
            Some(entry) => walk.paired(row, entry),
            None => walk.deleted(row),
        }
    }
    for entry in added {
        if is_folio_owned(&entry.path) {
            continue;
        }
        let code = match entry.kind {
            EntryKind::File => Code::FileAdded,
            EntryKind::Folder => {
                walk.compared
                    .folders
                    .insert(entry.path.clone(), DiskFolder::New);
                if !entry.empty {
                    continue;
                }
                Code::FolderAdded
            }
        };
        walk.push(code, Sides::Disk(entry));
    }
    walk.compared
}

/// Where a folder row's children are, for the rows after it in the walk. A folder without a frame
/// is in place, or not in the comparison, which means in place too.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum Frame {
    /// The folder is at `disk`, which is not its own path: the folder move `carrier` (an index in
    /// the walk's changes) took it there, its own or the one it moved with.
    Moved { disk: RelPath, carrier: usize },
    /// The folder is deleted, with the folder deletion `root` (an index in the walk's changes):
    /// its own, or the one that covers it.
    Deleted { root: usize },
}

impl Frame {
    /// The change that decides where the folder goes: its move, or its deletion.
    pub(super) fn change(&self) -> usize {
        match *self {
            Self::Moved { carrier, .. } => carrier,
            Self::Deleted { root } => root,
        }
    }
}

struct Walk<'a> {
    rules: &'a VersioningRules,
    rules_changed: bool,
    compared: Compared,
}

impl Walk<'_> {
    fn parent_frame(&self, row: &HeadRow) -> Option<&Frame> {
        let (parent, _) = row.path.as_str().rsplit_once('/')?;
        self.compared.frames.get(parent)
    }

    /// Whether the disk's versioning rules, when they are not `HEAD`'s, store `HEAD`'s version of
    /// the file `row`, which `HEAD` did not store. A held-back change keeps the file's name, so
    /// its class is the one of its path in `HEAD`, and its size is `HEAD`'s.
    fn rules_store(&self, row: &HeadRow) -> bool {
        self.rules_changed
            && row.file.as_ref().is_some_and(|file| {
                !file.stored
                    && self
                        .rules
                        .is_stored(self.rules.class_of(&row.path), file.size)
            })
    }

    fn push(&mut self, code: Code, sides: Sides) -> usize {
        let changes = &mut self.compared.changes;
        changes.push(Change::new(code, sides, self.rules));
        changes.len() - 1
    }

    fn fate(&mut self, row: &HeadRow, fate: Fate<usize>) {
        self.compared.fates.insert(row.path.clone(), fate);
    }

    /// A row without an entry, or whose entry is of the other kind.
    fn deleted(&mut self, row: HeadRow) {
        let folder = (row.kind() == EntryKind::Folder).then(|| row.path.clone());
        let stored_now = self.rules_store(&row);
        let root = match self.parent_frame(&row) {
            Some(&Frame::Deleted { root }) => {
                self.compared.changes[root].cover(&row, true);
                root
            }
            _ => {
                let code = match row.kind() {
                    EntryKind::File => Code::FileDeleted,
                    EntryKind::Folder => Code::FolderDeleted,
                };
                self.push(code, Sides::Head(row.clone()))
            }
        };
        self.fate(&row, Fate::Deleted(root));
        if stored_now {
            self.compared.rules_bound.push(root);
        }
        if let Some(path) = folder {
            self.compared.frames.insert(path, Frame::Deleted { root });
        }
    }

    /// A row paired with an entry of its kind.
    fn paired(&mut self, row: HeadRow, entry: DiskRow) {
        let edited = content_changed(&row, &entry);
        // The change that carries the edit, held back, keeps `HEAD`'s content (rule 4).
        let stored_now = edited && self.rules_store(&row);
        if entry.path == row.path {
            let leaver = self.parent_frame(&row).map(Frame::change);
            let edit = edited.then_some(self.compared.changes.len());
            match (leaver, edit) {
                (Some(leaver), edit) => {
                    self.compared.pinned.push(Pinned {
                        path: row.path.clone(),
                        leaver,
                        folder: row.kind() == EntryKind::Folder,
                    });
                    self.fate(&row, Fate::Pinned { leaver, edit });
                }
                (None, Some(edit)) => self.fate(&row, Fate::Edited(edit)),
                (None, None) => {}
            }
            if edited {
                let edit = self.push(Code::FileModified, Sides::Both(row, entry));
                if stored_now {
                    self.compared.rules_bound.push(edit);
                }
            }
            return;
        }
        let parent = self.parent_frame(&row);
        let carried = match parent {
            Some(Frame::Moved { disk, carrier })
                if entry.path.parent().as_ref() == Some(disk)
                    && entry.path.name() == row.path.name() =>
            {
                Some(*carrier)
            }
            _ => None,
        };
        let escaped = match parent {
            Some(&Frame::Deleted { root }) => Some(root),
            _ => None,
        };
        let folder = (row.kind() == EntryKind::Folder).then(|| row.path.clone());
        let disk = entry.path.clone();
        if folder.is_some() {
            self.compared
                .folders
                .insert(disk.clone(), DiskFolder::Paired(row.path.clone()));
        }
        let carrier = match carried {
            Some(carrier) => {
                self.compared.changes[carrier].cover(&row, !edited);
                let edit =
                    edited.then(|| self.push(Code::FileModified, Sides::Both(row.clone(), entry)));
                if let Some(edit) = edit.filter(|_| stored_now) {
                    self.compared.rules_bound.push(edit);
                }
                self.fate(&row, Fate::Carried { edit });
                carrier
            }
            None => {
                let code = match row.kind() {
                    EntryKind::File => Code::FileMoved,
                    EntryKind::Folder => Code::FolderMoved,
                };
                let moved = self.push(code, Sides::Both(row.clone(), entry));
                self.fate(&row, Fate::Moved(moved));
                if stored_now {
                    self.compared.rules_bound.push(moved);
                }
                if let Some(root) = escaped {
                    self.compared.escapes.push((moved, root));
                }
                moved
            }
        };
        if let Some(path) = folder {
            self.compared
                .frames
                .insert(path, Frame::Moved { disk, carrier });
        }
    }
}

/// Whether a file's content is known to differ from `HEAD`'s: another size, or a known other hash.
fn content_changed(row: &HeadRow, entry: &DiskRow) -> bool {
    row.file.as_ref().is_some_and(|file| {
        entry.size != file.size || entry.hash.as_ref().is_some_and(|hash| *hash != file.hash)
    })
}

/// A disk side's readiness (versioning.md §6.2).
fn readiness_of(entry: &DiskRow) -> Readiness {
    if entry.kind == EntryKind::Folder || entry.hash.is_some() {
        return Readiness::Ready;
    }
    match entry.blocked {
        Some(Blocked::NotLocal) => Readiness::NotLocal,
        Some(Blocked::Unreadable) => Readiness::Unreadable,
        None => Readiness::Hashing,
    }
}
