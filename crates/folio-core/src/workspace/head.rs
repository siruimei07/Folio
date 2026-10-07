//! `HEAD` in the catalog (versioning.md §4.2, §13.2): the head sync reads `HEAD`, indexes the
//! packs, flattens `HEAD`'s tree into `head_files` and reads `HEAD`'s metadata, and says what
//! state the history is in ([`HeadState`]).
//!
//! What `.folio/local/` holds is untrusted input (remote-format.md §1): links in `.folio/` are
//! refused first, the packs are indexed one at a time, each in a write of its own, the walk of
//! `HEAD`'s tree is bounded by the path budget and stops when cancelled, objects are found through
//! the catalog's index of the packs (migration 3), what `head_files` keeps is bounded far below the
//! walk ([`MAX_HEAD_PATH_BYTES`]) and written in short runs, and `HEAD`'s metadata files are read
//! only when they are stored files of known names, within caps, and checked against their ids.
//!
//! 1. The catalog's index of the packs is brought up to `packs/`, whatever `HEAD` is, none
//!    included (the catalog outlives `.folio/local/`): each pack it lacks is read and added in a
//!    write of its own, so a sync that finds it current writes nothing, and whatever a crash or a
//!    cancel left of it the next sync completes. When a pack it holds is gone, or the sync is
//!    forced, it is filled again from every pack, or cleared in a write of its own when no pack is
//!    added (`packs/` holds none, or none whose index reads; [`index_packs`]).
//! 2. `HEAD` cannot be read: a newer one makes the history read-only, an invalid one damaged; the
//!    catalog holds no `HEAD` then. No `HEAD`: no history yet, unless `packs/` holds a pack, which
//!    is damage (§4.2).
//! 3. The catalog's `history_head` is `HEAD` and its `history_version` current, and `head_files`
//!    holds a tree: nothing to derive again (later, commits keep `head_files` current by their
//!    changes), only `HEAD`'s metadata to read. A forced sync, after a catalog rebuild, derives
//!    everything again.
//! 4. Else `HEAD`'s commit is read and its tree flattened ([`flatten`], the path budget); its paths
//!    must fit what `head_files` keeps ([`MAX_HEAD_PATH_BYTES`]), the root must meet
//!    remote-format.md §7.4 ([`check_root`]) and encode to the commit's tree again
//!    ([`encode_trees`], which gives each folder's tree id); `HEAD`'s metadata is read; then short
//!    writes clear `head_files` and add its rows in runs, each run paired by path, and a last one
//!    records `history_head` and `history_version`.
//! 5. A record that did not read as its pack's index said: that pack's index is read again, and
//!    when it differs from the catalog's (a pack replaced by a good copy of its name since), the
//!    pack is indexed again and steps 3 and 4 run once more ([`index_again`]). A pack that stays
//!    damaged is read again at each sync, without a write.
//!
//! What the store finds is the history's state, never an error: missing or invalid objects and
//! packs, a root that breaks §7.4 or does not encode to its tree, invalid metadata and another
//! library's `HEAD` damage it; anything a newer Folio wrote makes it read-only; a tree over the
//! path budget or over [`MAX_HEAD_PATH_BYTES`] is too large to show. The workspace lists the items
//! whenever `head_files` holds `HEAD`'s tree and the metadata changes whenever `HEAD`'s metadata
//! reads (lane decision 6); another library's `HEAD` lists nothing, whatever else its metadata
//! holds. Errors are what may go away when tried again: the catalog, the store's files, a link in
//! `.folio/`, a cancel.
//!
//! Each write is one catalog transaction; the crash points `head.index` (before each pack's),
//! `head.files` (before each run of rows) and `head.marks` come before them. The cancel is asked
//! before every write, so none follows a cancel, and whatever a crash or a cancel leaves, the next
//! sync derives again: rows without the marks are not `HEAD`'s.

use std::collections::BTreeSet;
use std::io;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use rusqlite::Connection;

use super::meta::{HeadMeta, HeadMetaError};
use super::trees::{TreeError, encode_trees};
use super::{HeadFile, HeadRow};
use crate::catalog::head_files::{
    HISTORY_VERSION, HeadEntry, HeadFileRow, clear_head_files, has_head_tree, head_rows,
    history_marks, insert_head_files, pack_indexed_as, set_history_marks,
};
use crate::catalog::{
    Catalog, CatalogError, CatalogLocator, add_pack, clear_object_index, indexed_packs,
    object_location,
};
use crate::crash;
use crate::hash::ContentHash;
use crate::library::state::validate_metadata;
use crate::meta::{self, FolioFile, Layout, LibraryConfig, LibraryId, MetaError, folio_file};
use crate::paths::{PathError, RelPath};
use crate::store::{
    DEFAULT_PATH_BUDGET, FlatTree, LocalStore, Locator, ObjectId, PackName, RuleViolation,
    StoreError, Subject, Tree, TreeSource, check_root, flatten,
};

/// The most bytes one of `HEAD`'s metadata files may have, as on the disk (lane decision 15).
pub const MAX_META_FILE_BYTES: u64 = 32 << 20;

/// The most bytes of `HEAD`'s metadata files in all.
pub const MAX_META_BYTES: u64 = 64 << 20;

/// The most metadata files of `HEAD`'s read.
pub const MAX_META_FILES: usize = 10_000;

/// The most bytes of paths of `HEAD`'s tree that `head_files` keeps, and the workspace with it: an
/// eighth of the bytes the store's walk may list (`DEFAULT_PATH_BUDGET` × `PATH_BYTES_PER_ENTRY`),
/// which bound one transient walk, not a table keyed by its paths and the copies a comparison
/// holds. 335,000 files under paths of 100 bytes, against M2's 50,000 files; a crafted `HEAD`
/// reaches it with a chain of about 5,800 nested one-letter folders. A larger tree is too large to
/// show ([`HeadProblem::PathsTooLong`]).
pub const MAX_HEAD_PATH_BYTES: usize = 32 << 20;

/// The most rows, and bytes of their paths, one write of the head sync adds to `head_files`: the
/// writer goes to the scans between the writes, and a cancel stops the sync after any of them.
const WRITE_ROWS: usize = 8_192;
const WRITE_PATH_BYTES: usize = 4 << 20;

/// What a head sync may walk, keep and read, and how much it writes at a time. Tests shrink them,
/// so that no test's size follows a constant.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Bounds {
    /// The most entries the store's walk lists ([`flatten`]'s budget).
    pub(crate) entries: usize,
    /// The most bytes of paths `head_files` keeps.
    pub(crate) path_bytes: usize,
    /// The most rows one write adds, and about the most bytes of their paths.
    pub(crate) run_rows: usize,
    pub(crate) run_bytes: usize,
    /// The most metadata files of `HEAD`'s read, the most bytes one may have, and in all.
    pub(crate) meta_files: usize,
    pub(crate) meta_file_bytes: u64,
    pub(crate) meta_bytes: u64,
}

impl Bounds {
    pub(crate) const DEFAULT: Self = Self {
        entries: DEFAULT_PATH_BUDGET,
        path_bytes: MAX_HEAD_PATH_BYTES,
        run_rows: WRITE_ROWS,
        run_bytes: WRITE_PATH_BYTES,
        meta_files: MAX_META_FILES,
        meta_file_bytes: MAX_META_FILE_BYTES,
        meta_bytes: MAX_META_BYTES,
    };
}

/// What state the history is in (versioning.md §4.2; ipc-m2.md §6.1 `historyState`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HistoryStatus {
    /// No commit yet: no `HEAD` and no pack.
    None,
    Ready,
    /// A newer Folio wrote some of it: it is read-only.
    ReadOnly,
    /// `HEAD`, a pack, an object or a metadata file of `HEAD` is missing or damaged, or `HEAD` is
    /// another library's. The files are fine.
    Damaged,
    /// `HEAD`'s tree has more paths, or longer ones, than the path budget allows, or more bytes of
    /// paths than `head_files` keeps ([`MAX_HEAD_PATH_BYTES`]): a valid history too large to show,
    /// or hostile trees. Not damage (decision m2-too-large-folder).
    TooLarge,
}

/// Why the history is not ready: what the head sync found.
#[derive(Debug, thiserror::Error)]
pub enum HeadProblem {
    /// No `HEAD`, but `packs/` holds a pack (versioning.md §4.2).
    #[error("there is no HEAD, but the store holds packs")]
    PacksWithoutHead,
    /// What the store found: an invalid, missing, pruned, newer or too large `HEAD`, pack or
    /// object. Never [`StoreError::Io`], which is a [`SyncError`].
    #[error(transparent)]
    Store(StoreError),
    /// `HEAD`'s root breaks remote-format.md §7.4.
    #[error("HEAD's root tree is not valid: {0}")]
    Root(RuleViolation),
    /// A path of `HEAD`'s tree that the library's rules refuse.
    #[error("HEAD's tree holds `{path}`, which is not a library path: {error}")]
    Path { path: String, error: PathError },
    /// `HEAD`'s tree has more bytes of paths than Folio keeps ([`MAX_HEAD_PATH_BYTES`]): too large
    /// to show, as a tree over the store's path budget is.
    #[error("HEAD's tree holds {bytes} bytes of paths, more than the {limit} Folio keeps")]
    PathsTooLong { bytes: usize, limit: usize },
    /// `HEAD`'s flattened tree does not make trees again.
    #[error("HEAD's tree cannot be encoded again: {0}")]
    Tree(TreeError),
    /// `HEAD`'s flattened tree encodes to another tree than its commit's.
    #[error("HEAD's tree encodes to {found}, not to its commit's tree {expected}")]
    RootDiffers { expected: ObjectId, found: ObjectId },
    /// A stored file of `HEAD`'s whose blob has another size than the tree says.
    #[error("`{path}` has {blob} bytes in the store, not the {tree} its tree says")]
    SizeDiffers { path: RelPath, tree: u64, blob: u64 },
    /// `HEAD`'s metadata files are over a cap: one over [`MAX_META_FILE_BYTES`], more than
    /// [`MAX_META_FILES`], or more than [`MAX_META_BYTES`] in all; `path` is where it was reached.
    #[error("HEAD's metadata is larger than Folio reads, at `{path}`")]
    MetaTooLarge { path: RelPath },
    /// `HEAD`'s metadata does not read.
    #[error(transparent)]
    Meta(HeadMetaError),
    /// `HEAD`'s `library.json` names another library.
    #[error("HEAD is the history of another library ({found})")]
    OtherLibrary { found: LibraryId },
}

impl HeadProblem {
    /// The state the problem puts the history in.
    pub fn status(&self) -> HistoryStatus {
        match self {
            Self::Store(StoreError::Newer { .. }) | Self::Meta(HeadMetaError::Newer { .. }) => {
                HistoryStatus::ReadOnly
            }
            Self::Store(StoreError::TooLarge { .. }) | Self::PathsTooLong { .. } => {
                HistoryStatus::TooLarge
            }
            _ => HistoryStatus::Damaged,
        }
    }
}

/// Why a head sync stopped without a state: tried again at the next one.
#[derive(Debug, thiserror::Error)]
pub enum SyncError {
    #[error(transparent)]
    Catalog(#[from] CatalogError),
    /// A file of the store could not be read ([`StoreError::Io`]); or the catalog failed to answer
    /// the store, when its source downcasts to a [`CatalogError`] (`catalog::CatalogLocator`).
    #[error(transparent)]
    Io(StoreError),
    /// `.folio/` or `.folio/local/` holds a link, or could not be checked for one.
    #[error(transparent)]
    Meta(#[from] MetaError),
    #[error("the head sync was cancelled")]
    Cancelled,
}

/// What the head sync found: `HEAD`, whether `head_files` holds its tree, its metadata, and why
/// the history is not ready.
#[derive(Debug)]
pub struct HeadState {
    head: Option<ObjectId>,
    tree: bool,
    meta: Option<Arc<HeadMeta>>,
    problem: Option<HeadProblem>,
}

impl HeadState {
    /// A library without history: no `HEAD`, no pack.
    pub fn none() -> Self {
        Self {
            head: None,
            tree: false,
            meta: None,
            problem: None,
        }
    }

    /// The history's state.
    pub fn status(&self) -> HistoryStatus {
        match (&self.problem, self.head) {
            (Some(problem), _) => problem.status(),
            (None, Some(_)) => HistoryStatus::Ready,
            (None, None) => HistoryStatus::None,
        }
    }

    /// `HEAD`'s commit; `None` without `HEAD`, or when `HEAD` cannot be read.
    pub fn head(&self) -> Option<ObjectId> {
        self.head
    }

    /// Whether `head_files` holds `HEAD`'s tree, so that the workspace lists its items.
    pub fn lists_items(&self) -> bool {
        self.tree
    }

    /// `HEAD`'s metadata, when it reads: the workspace lists metadata changes then.
    pub fn meta(&self) -> Option<&Arc<HeadMeta>> {
        self.meta.as_ref()
    }

    /// Why the history is not ready, if it is not.
    pub fn problem(&self) -> Option<&HeadProblem> {
        self.problem.as_ref()
    }

    fn unreadable(head: Option<ObjectId>, problem: HeadProblem) -> Self {
        Self {
            head,
            tree: false,
            meta: None,
            problem: Some(problem),
        }
    }
}

/// What tells the head sync to stop: the session's cancel flag. Asked between steps and at every
/// tree of the walk; tests count the questions.
pub(crate) trait Cancel {
    fn cancelled(&self) -> bool;
}

impl Cancel for AtomicBool {
    fn cancelled(&self) -> bool {
        self.load(Ordering::Relaxed)
    }
}

/// Brings `HEAD` into the catalog of the library whose `.folio/` `layout` describes, with the id
/// `library` (see the module's docs). `force` derives everything again, as after a catalog
/// rebuild. `cancel` stops it between steps and at every tree; no write follows it.
pub fn sync(
    catalog: &Catalog,
    layout: &Layout,
    library: &LibraryId,
    force: bool,
    cancel: &AtomicBool,
) -> Result<HeadState, SyncError> {
    sync_within(catalog, layout, library, force, cancel, Bounds::DEFAULT)
}

/// [`sync`] within `bounds`.
pub(crate) fn sync_within(
    catalog: &Catalog,
    layout: &Layout,
    library: &LibraryId,
    force: bool,
    cancel: &dyn Cancel,
    bounds: Bounds,
) -> Result<HeadState, SyncError> {
    let store = LocalStore::new(layout);
    check(cancel)?;
    // Links in `.folio/` and `.folio/local/` are refused before anything there is read, as by
    // every reader of the metadata.
    validate_metadata(layout.root())?;
    let head = match store.read_head() {
        Ok(head) => Ok(head),
        Err(error) => Err(HeadProblem::Store(store_problem(error)?)),
    };
    // Whatever `HEAD` is, none included: the catalog outlives `.folio/local/`, which may be
    // removed or restored without it, and a writer stores only the objects the index does not
    // find (`catalog::has_object`).
    let indexed = index_packs(catalog, &store, force, cancel)?;
    let head = match head {
        Ok(Some(head)) => head,
        Ok(None) => {
            let state = match store.has_packs() {
                Ok(true) => HeadState::unreadable(None, HeadProblem::PacksWithoutHead),
                Ok(false) => HeadState::none(),
                Err(error) => {
                    HeadState::unreadable(None, HeadProblem::Store(store_problem(error)?))
                }
            };
            return cleared(catalog, cancel, state);
        }
        Err(problem) => return cleared(catalog, cancel, HeadState::unreadable(None, problem)),
    };
    if let Err(problem) = indexed {
        return cleared(catalog, cancel, HeadState::unreadable(Some(head), problem));
    }
    let state = derive(catalog, &store, head, library, force, cancel, bounds)?;
    // A record that is not what its pack's index said: the pack may have been replaced by a good
    // copy since it was indexed (`LocalStore::publish`), so its index is read again, and when it
    // differs from the catalog's, the pack is indexed again and `HEAD` derived again, once.
    match damaged_pack(catalog, &state)? {
        Some(pack) if index_again(catalog, &store, pack, cancel)? => {
            derive(catalog, &store, head, library, force, cancel, bounds)
        }
        _ => Ok(state),
    }
}

/// Step 3 or 4 of the module's docs: `HEAD`'s metadata when the catalog holds its tree, else
/// everything derived again.
fn derive(
    catalog: &Catalog,
    store: &LocalStore,
    head: ObjectId,
    library: &LibraryId,
    force: bool,
    cancel: &dyn Cancel,
    bounds: Bounds,
) -> Result<HeadState, SyncError> {
    let current = !force
        && catalog.read(|tx| {
            let marks = history_marks(tx)?;
            Ok(marks.head == Some(head)
                && marks.version == Some(HISTORY_VERSION)
                && has_head_tree(tx)?)
        })?;
    if current {
        check(cancel)?;
        let meta = catalog.read_stamped(|tx, _| -> Result<_, SyncError> {
            let rows = head_rows(tx)?;
            read_meta(store, tx, &rows, library, cancel, bounds)
        })?;
        let state = finish(head, meta);
        if !state.tree {
            return cleared(catalog, cancel, state);
        }
        return Ok(state);
    }
    rebuild(catalog, store, head, library, cancel, bounds)
}

/// The pack whose record the history's problem says did not read, when the catalog's index named
/// it: a record that is not what its index entry says, or the pack's other damage.
fn damaged_pack(catalog: &Catalog, state: &HeadState) -> Result<Option<PackName>, SyncError> {
    let Some(HeadProblem::Store(StoreError::Invalid { what, .. })) = state.problem() else {
        return Ok(None);
    };
    Ok(match what {
        Subject::Pack(path) => path
            .file_name()
            .and_then(|name| name.to_str())
            .and_then(|name| PackName::from_file_name(name).ok()),
        Subject::Object(id) => catalog
            .read(|tx| object_location(tx, *id))?
            .map(|location| location.pack),
        _ => None,
    })
}

/// Reads the index of `pack`, which the catalog indexes, again, and indexes the pack again when
/// the catalog's index of it differs (`head_files::pack_indexed_as`); returns whether it did. A
/// pack whose index does not read, or that is gone, is left to the next sync, which drops it.
fn index_again(
    catalog: &Catalog,
    store: &LocalStore,
    pack: PackName,
    cancel: &dyn Cancel,
) -> Result<bool, SyncError> {
    check(cancel)?;
    let index = match store.read_pack_index(pack) {
        Ok(index) => index,
        Err(StoreError::Io { source, .. }) if source.kind() == io::ErrorKind::NotFound => {
            return Ok(false);
        }
        Err(error) => {
            store_problem(error)?;
            return Ok(false);
        }
    };
    if catalog.read(|tx| pack_indexed_as(tx, &index))? {
        return Ok(false);
    }
    check(cancel)?;
    crash::point("head.index");
    catalog.write(|tx| add_pack(tx, &index))?;
    Ok(true)
}

/// `state`, whose tree the catalog does not hold, once `head_files` and the marks are cleared;
/// unless cancelled, as no write follows a cancel.
fn cleared(
    catalog: &Catalog,
    cancel: &dyn Cancel,
    state: HeadState,
) -> Result<HeadState, SyncError> {
    check(cancel)?;
    catalog.write(|tx| clear_head_files(tx))?;
    Ok(state)
}

/// Brings the catalog's index of the packs (versioning.md §4.3, §13.2) up to `packs/`: each pack
/// it lacks is read and added in a write of its own, so that one index at a time is in memory, the
/// scans get the writer between the packs, and a cancel stops it before any read of an index and
/// any write. When a pack it holds is gone, or `force`, the first write clears it and every pack
/// is added again, as an object two packs hold loses its location with either
/// (`catalog::remove_pack`); when no pack is added (none in `packs/`, or none whose index reads),
/// a write of its own clears it. A pack whose index does not read is left out, and the first such
/// problem returned once the others are in; an I/O error stops it at once (`SyncError::Io`). An
/// index the catalog holds already is not read again here: damage in a pack is found when an
/// object is read, and a pack replaced under its name is indexed again then ([`index_again`]).
fn index_packs(
    catalog: &Catalog,
    store: &LocalStore,
    force: bool,
    cancel: &dyn Cancel,
) -> Found<()> {
    let on_disk = match store.list_packs() {
        Ok(listing) => listing.packs,
        Err(error) => return Ok(Err(HeadProblem::Store(store_problem(error)?))),
    };
    let indexed: BTreeSet<PackName> = catalog
        .read(|tx| indexed_packs(tx))?
        .into_iter()
        .map(|pack| pack.name)
        .collect();
    // `list_packs` sorts the names.
    let mut clear = force
        || indexed
            .iter()
            .any(|name| on_disk.binary_search(name).is_err());
    let wanted: Vec<PackName> = on_disk
        .into_iter()
        .filter(|name| clear || !indexed.contains(name))
        .collect();
    let mut problem = None;
    for name in wanted {
        check(cancel)?;
        let index = match store.read_pack_index(name) {
            Ok(index) => index,
            Err(error) => {
                problem.get_or_insert(HeadProblem::Store(store_problem(error)?));
                continue;
            }
        };
        check(cancel)?;
        crash::point("head.index");
        let first = std::mem::take(&mut clear);
        catalog.write(|tx| {
            if first {
                clear_object_index(tx)?;
            }
            add_pack(tx, &index)
        })?;
    }
    if clear {
        check(cancel)?;
        crash::point("head.index");
        catalog.write(|tx| clear_object_index(tx))?;
    }
    Ok(problem.map_or(Ok(()), Err))
}

/// Derives `head_files` from `HEAD` (step 4 of the module's docs).
fn rebuild(
    catalog: &Catalog,
    store: &LocalStore,
    head: ObjectId,
    library: &LibraryId,
    cancel: &dyn Cancel,
    bounds: Bounds,
) -> Result<HeadState, SyncError> {
    check(cancel)?;
    let derived = catalog.read_stamped(|tx, _| -> Result<_, SyncError> {
        let flat = match flat_tree(store, tx, head, cancel, bounds.entries)? {
            Ok(flat) => flat,
            Err(problem) => return Ok(Err(problem)),
        };
        let (rows, head_rows) = match tree_rows(&flat.0, flat.1, bounds.path_bytes) {
            Ok(rows) => rows,
            Err(problem) => return Ok(Err(problem)),
        };
        drop(flat);
        let meta = read_meta(store, tx, &head_rows, library, cancel, bounds)?;
        Ok(Ok((rows, meta)))
    })?;
    let (rows, meta) = match derived {
        Ok(derived) => derived,
        Err(problem) => {
            return cleared(catalog, cancel, HeadState::unreadable(Some(head), problem));
        }
    };
    let state = finish(head, meta);
    if !state.tree {
        return cleared(catalog, cancel, state);
    }
    // In runs of short writes, the first clearing the rows and the marks; the marks come last, so
    // rows a crash or a cancel leaves without them are derived again.
    for (index, run) in runs(&rows, bounds.run_rows, bounds.run_bytes).enumerate() {
        check(cancel)?;
        crash::point("head.files");
        catalog.write(|tx| {
            if index == 0 {
                clear_head_files(tx)?;
            }
            insert_head_files(tx, run)
        })?;
    }
    check(cancel)?;
    crash::point("head.marks");
    catalog.write(|tx| set_history_marks(tx, head))?;
    Ok(state)
}

/// `rows` in runs of at most `max_rows` rows and `max_bytes` bytes of paths, or of one row with
/// more; one run, empty, when there are no rows.
fn runs(
    rows: &[HeadFileRow],
    max_rows: usize,
    max_bytes: usize,
) -> impl Iterator<Item = &[HeadFileRow]> {
    let max_rows = max_rows.max(1);
    let mut rest = rows;
    let mut started = false;
    std::iter::from_fn(move || {
        if started && rest.is_empty() {
            return None;
        }
        started = true;
        let mut bytes = 0_usize;
        let end = rest
            .iter()
            .take(max_rows)
            .position(|row| {
                bytes = bytes.saturating_add(row.path.as_str().len());
                bytes > max_bytes
            })
            .map_or(rest.len().min(max_rows), |at| at.max(1));
        let (run, after) = rest.split_at(end);
        rest = after;
        Some(run)
    })
}

/// The state of a `HEAD` whose tree `head_files` holds (or is about to), with its metadata as it
/// read ([`read_meta`]): another library's `HEAD` lists nothing.
fn finish(head: ObjectId, meta: Result<HeadMeta, HeadProblem>) -> HeadState {
    match meta {
        Err(problem @ HeadProblem::OtherLibrary { .. }) => {
            HeadState::unreadable(Some(head), problem)
        }
        Ok(meta) => HeadState {
            head: Some(head),
            tree: true,
            meta: Some(Arc::new(meta)),
            problem: None,
        },
        Err(problem) => HeadState {
            head: Some(head),
            tree: true,
            meta: None,
            problem: Some(problem),
        },
    }
}

/// What a step found: a value or the history's problem, or an error to try again.
type Found<T> = Result<Result<T, HeadProblem>, SyncError>;

/// `HEAD`'s commit's tree flattened, with the commit's tree id, read in the caller's read through
/// the catalog's index, within `budget` entries.
fn flat_tree(
    store: &LocalStore,
    conn: &Connection,
    head: ObjectId,
    cancel: &dyn Cancel,
    budget: usize,
) -> Found<(FlatTree, ObjectId)> {
    let locator = CatalogLocator(conn);
    let commit = locator
        .locate(head)
        .and_then(|location| {
            let location = location.ok_or(StoreError::Missing(head))?;
            store.read_commit(head, location)
        })
        .map_err(store_problem);
    let commit = match commit {
        Ok(commit) => commit,
        Err(error) => return Ok(Err(HeadProblem::Store(error?))),
    };
    let source = Cancellable {
        source: store.trees(CatalogLocator(conn)),
        cancel,
    };
    match flatten(&source, commit.tree, budget) {
        Ok(flat) => Ok(Ok((flat, commit.tree))),
        Err(_) if cancel.cancelled() => Err(SyncError::Cancelled),
        Err(error) => Ok(Err(HeadProblem::Store(store_problem(error)?))),
    }
}

/// The rows of `head_files` and the comparison's rows of the flattened tree `flat`, whose commit's
/// tree is `root`: at most `path_bytes` bytes of paths, the root checked against remote-format.md
/// §7.4, every path a library path, and every folder with its tree id, the root's encoding to
/// `root` again.
pub(crate) fn tree_rows(
    flat: &FlatTree,
    root: ObjectId,
    path_bytes: usize,
) -> Result<(Vec<HeadFileRow>, Vec<HeadRow>), HeadProblem> {
    // Before the copies below, which the cap bounds.
    let bytes = flat
        .keys()
        .fold(0_usize, |sum, path| sum.saturating_add(path.len()));
    if bytes > path_bytes {
        return Err(HeadProblem::PathsTooLong {
            bytes,
            limit: path_bytes,
        });
    }
    check_root(flat).map_err(HeadProblem::Root)?;
    // Every folder of `flat`: `encode_trees` encodes each folder it is given.
    let mut ids = std::collections::HashMap::new();
    let found = encode_trees(
        flat.iter()
            .map(|(path, entry)| (path.as_str(), entry.side())),
        |path, encoded| {
            ids.insert(path, encoded.id());
            Ok(())
        },
    )
    .map_err(HeadProblem::Tree)?;
    if found != root {
        return Err(HeadProblem::RootDiffers {
            expected: root,
            found,
        });
    }
    let mut rows = Vec::with_capacity(flat.len());
    let mut head_rows = Vec::with_capacity(flat.len());
    for (text, entry) in flat {
        let path = RelPath::parse(text).map_err(|error| HeadProblem::Path {
            path: text.clone(),
            error,
        })?;
        let (entry, file) = match entry.side() {
            Some(side) => (
                HeadEntry::File(side),
                Some(HeadFile {
                    hash: ContentHash::from(side.hash),
                    size: side.size.get(),
                    stored: side.stored,
                }),
            ),
            None => {
                let tree = ids[text.as_str()];
                (HeadEntry::Folder(tree), None)
            }
        };
        head_rows.push(HeadRow {
            path: path.clone(),
            file,
        });
        rows.push(HeadFileRow { path, entry });
    }
    Ok((rows, head_rows))
}

/// `HEAD`'s metadata: its stored files in `.folio/` of the names Folio reads, within the caps of
/// `bounds`, read through the catalog's index in the caller's read and checked against their ids,
/// then parsed and resolved against `rows`, every row of `HEAD`'s tree.
///
/// `library.json` comes first: when it reads and names another library than `library`, that is
/// the problem, whatever else the metadata holds, and the workspace lists nothing. When its read
/// fails for a moment ([`StoreError::Io`]), the sync fails at once, to be tried again: no other
/// answer, a cap or a file before it in tree order, may come before it without that check.
/// Another problem in reading it is reported in its turn, with the others; it is read once, so no
/// other read of it passes the check.
fn read_meta(
    store: &LocalStore,
    conn: &Connection,
    rows: &[HeadRow],
    library: &LibraryId,
    cancel: &dyn Cancel,
    bounds: Bounds,
) -> Found<HeadMeta> {
    let locator = CatalogLocator(conn);
    read_meta_with(rows, library, cancel, bounds, &mut |file| {
        read_blob(store, &locator, file)
    })
}

/// What [`read_blob`] reads.
type Blob = Result<Result<Vec<u8>, u64>, StoreError>;

/// [`read_meta`], reading each blob with `read`.
fn read_meta_with(
    rows: &[HeadRow],
    library: &LibraryId,
    cancel: &dyn Cancel,
    bounds: Bounds,
    read: &mut dyn FnMut(&HeadFile) -> Blob,
) -> Found<HeadMeta> {
    let wanted: Vec<(&RelPath, &HeadFile)> = rows
        .iter()
        .filter(|row| folio_file(&row.path).is_some())
        .filter_map(|row| Some((&row.path, row.file.as_ref()?)))
        .collect();
    let mut files = Vec::with_capacity(wanted.len());
    let settings = wanted
        .iter()
        .position(|(path, _)| folio_file(path) == Some(FolioFile::Library));
    // What the first read of `library.json` gave, used in its turn.
    let mut settings_read: Option<Blob> = None;
    if let Some(at) = settings
        && wanted[at].1.size <= bounds.meta_file_bytes
    {
        check(cancel)?;
        let blob = read(wanted[at].1);
        if let Ok(Ok(bytes)) = &blob
            && let Ok(found) = meta::from_bytes::<LibraryConfig>(bytes)
            && found.id != *library
        {
            return Ok(Err(HeadProblem::OtherLibrary { found: found.id }));
        }
        settings_read = Some(match blob {
            Err(error) => Err(store_problem(error)?),
            blob => blob,
        });
    }
    let mut total = 0_u64;
    for (count, (path, file)) in wanted.iter().enumerate() {
        total = total.saturating_add(file.size);
        if count >= bounds.meta_files
            || file.size > bounds.meta_file_bytes
            || total > bounds.meta_bytes
        {
            return Ok(Err(HeadProblem::MetaTooLarge {
                path: (*path).clone(),
            }));
        }
    }
    for (index, (path, file)) in wanted.into_iter().enumerate() {
        let blob = match settings_read.take_if(|_| settings == Some(index)) {
            Some(blob) => blob,
            None => {
                check(cancel)?;
                read(file)
            }
        };
        match blob {
            Ok(Ok(bytes)) => files.push((path.clone(), bytes)),
            Ok(Err(blob)) => {
                return Ok(Err(HeadProblem::SizeDiffers {
                    path: path.clone(),
                    tree: file.size,
                    blob,
                }));
            }
            Err(error) => return Ok(Err(HeadProblem::Store(store_problem(error)?))),
        }
    }
    Ok(HeadMeta::parse(&files, rows).map_err(HeadProblem::Meta))
}

/// The bytes of `file`, a stored file of `HEAD`'s whose size the caps allow, found through
/// `locator` and checked against its id; its blob's size instead when the tree says another.
fn read_blob(
    store: &LocalStore,
    locator: &CatalogLocator<'_>,
    file: &HeadFile,
) -> Result<Result<Vec<u8>, u64>, StoreError> {
    let id = ObjectId::from(&file.hash);
    let location = locator.locate(id)?.ok_or(StoreError::Missing(id))?;
    let mut reader = store.open_blob(id, location)?;
    if reader.raw_length() != file.size {
        return Ok(Err(reader.raw_length()));
    }
    let mut bytes = vec![0; usize::try_from(file.size).unwrap_or(usize::MAX)];
    let mut filled = 0;
    loop {
        let read = reader.read_checked(&mut bytes[filled..])?;
        if read == 0 {
            break;
        }
        filled += read;
    }
    bytes.truncate(filled);
    Ok(Ok(bytes))
}

/// What the store found, as a problem of the history; an I/O error, or the catalog failing to
/// answer, is a [`SyncError`] instead.
fn store_problem(error: StoreError) -> Result<StoreError, SyncError> {
    match error {
        StoreError::Io { .. } => Err(SyncError::Io(error)),
        error => Ok(error),
    }
}

fn check(cancel: &dyn Cancel) -> Result<(), SyncError> {
    if cancel.cancelled() {
        Err(SyncError::Cancelled)
    } else {
        Ok(())
    }
}

/// A [`TreeSource`] that fails at every tree once `cancel` is set, so that a walk stops.
struct Cancellable<'a, S> {
    source: S,
    cancel: &'a dyn Cancel,
}

impl<S: TreeSource> TreeSource for Cancellable<'_, S> {
    fn tree(&self, id: ObjectId) -> Result<Option<Arc<Tree>>, StoreError> {
        if self.cancel.cancelled() {
            return Err(StoreError::Io {
                path: PathBuf::new(),
                source: io::Error::new(io::ErrorKind::Interrupted, "the head sync was cancelled"),
            });
        }
        self.source.tree(id)
    }
}

#[cfg(test)]
mod tests;
