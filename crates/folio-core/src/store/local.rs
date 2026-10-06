//! The local object store (versioning.md §4.1–§4.3): the packs in `.folio/local/packs/`, `HEAD`,
//! and the packs being written in `.folio/local/staging/`.
//!
//! The objects of a write go through three states, and a crash in any of them leaves a whole store
//! behind (§7.5):
//!
//! 1. Written in `staging/pack-<16 hexadecimal digits>.part`: by a [`PackSet`], which makes the
//!    packs remote-format.md §9.5 asks for, or by one [`StagingWriter`].
//! 2. Finished and flushed: a [`StagedPack`], which nothing names yet.
//! 3. Published into `packs/<name>.pack` with one rename written through to the disk
//!    ([`LocalStore::publish`]); a pack of that name there already is kept when it passes the full
//!    check and replaced when it is damaged. Or abandoned.
//!
//! [`LocalStore::write_head`] then replaces `HEAD` durably: the commit point. After a crash
//! `packs/` holds only whole packs, `HEAD` names the old commit or the new one, and the pack files
//! left in `staging/` are removed by [`LocalStore::clean_staging`]. Every write step is a crash
//! point (`crate::crash`).
//!
//! Objects are read at a [`Location`] a [`Locator`] gives: the catalog, or a [`MemoryIndex`].
//! [`StoreTrees`] is the [`TreeSource`] the history checks read trees from.
//!
//! The store never follows a symbolic link or junction in its folders: where it lists, writes,
//! replaces or deletes, a link is refused ([`Problem::Found`]), as M1 refuses links in metadata
//! paths. A file whose name is not a pack's is not the store's: listed as foreign, never read,
//! replaced or removed. So is a file whose name differs from a pack's in case only, though NTFS
//! takes it for the pack's ([`Problem::OtherCase`]). Nothing is cleaned up in `Drop`: what an
//! operation leaves when it stops waits for `clean_staging`, as it would after a crash.

use std::collections::{HashMap, HashSet};
use std::ffi::OsString;
use std::fs::{self, File};
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use super::json::{Int, Value};
use super::pack::{EMPTY_PACK_LEN, record_cost};
use super::schema::{self, Encoded, Fields, Part};
use super::{
    Added, Commit, FileSink, Location, ObjectId, ObjectKind, ObjectReader, PackIndex, PackName,
    PackProblem, PackReader, PackSink, PackWriter, Problem, Size, StoreError, Streamed, Subject,
    Tree, TreeSource, io_error,
};
use crate::crash;
use crate::files;
use crate::fs::{FileKind, FileSystem, StdFileSystem};
use crate::meta::Layout;

/// A Word blob of at least this many bytes gets a pack of its own (remote-format.md §9.5), so that
/// thinning can delete a whole pack instead of rewriting one (ADR-0006): 1 MiB.
pub const WORD_PACK_MIN: u64 = 1024 * 1024;

/// Packs stay under this many bytes (remote-format.md §9.5), unless one object alone is larger:
/// 1 GiB.
pub const PACK_MAX: u64 = 1024 * 1024 * 1024;

/// The version of `HEAD` this Folio writes and reads (versioning.md §4.5).
const HEAD_VERSION: u32 = 1;

/// The most bytes of `HEAD` read, as for `FORMAT.json` (remote-format.md §10.2): its one form has
/// 97, and a reader bounds what it reads before it parses.
const HEAD_LIMIT: u64 = 4 * 1024;

/// A pack being written in `staging/` is `pack-`, 16 random hexadecimal digits and `.part`; only
/// such files are the store's there.
const STAGING_PREFIX: &str = "pack-";
const STAGING_SUFFIX: &str = ".part";
const STAGING_DIGITS: usize = 16;

/// How often a staging name is drawn again when the file exists already.
const STAGING_TRIES: usize = 8;

/// The local object store of one library (versioning.md §4): its packs, `HEAD`, and the pack files
/// in its staging folder. Nothing is read or created until a method needs it.
#[derive(Debug, Clone)]
pub struct LocalStore {
    packs: PathBuf,
    staging: PathBuf,
    head: PathBuf,
}

impl LocalStore {
    /// The store of the library whose `.folio/` folder `layout` describes. Its root is absolute.
    pub fn new(layout: &Layout) -> Self {
        Self {
            packs: layout.packs_dir(),
            staging: layout.staging_dir(),
            head: layout.head_file(),
        }
    }

    /// The path of the pack `name` in `packs/`.
    pub fn pack_path(&self, name: PackName) -> PathBuf {
        self.packs.join(name.file_name())
    }

    /// The commit `HEAD` names (versioning.md §4.2), or `None` when there is no `HEAD`.
    ///
    /// Read as remote-format.md §11 reads a record: at most 4 KiB, then JSON, then the version
    /// (another than 1 is [`StoreError::Newer`], whatever else `HEAD` holds), then the canonical
    /// form and the schema (`format_version` and `head`, nothing else). A link or folder at `HEAD`
    /// is refused. What an invalid `HEAD` means for the library is the history's decision.
    pub fn read_head(&self) -> Result<Option<ObjectId>, StoreError> {
        let head = || Subject::Head(self.head.clone());
        if !file_exists(&self.head, head)? {
            return Ok(None);
        }
        let file = match File::open(&self.head) {
            Ok(file) => file,
            Err(source) if source.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(source) => return Err(io_error(&self.head, source)),
        };
        let bytes = files::read_capped(file, HEAD_LIMIT)
            .map_err(|source| io_error(&self.head, source))?
            .ok_or_else(|| StoreError::Invalid {
                what: head(),
                problem: Problem::TooLarge { limit: HEAD_LIMIT },
            })?;
        parse_head(&bytes, head).map(Some)
    }

    /// Replaces `HEAD` with `head` (versioning.md §4.2): written in `staging/`, flushed, and
    /// renamed over the old `HEAD` with the rename written through to the disk. The commit point of
    /// every history operation (§7.5). A link at `staging/`, or a link or folder at `HEAD`, is
    /// refused.
    pub fn write_head(&self, head: ObjectId) -> Result<(), StoreError> {
        ready_folder(&self.staging)?;
        file_exists(&self.head, || Subject::Head(self.head.clone()))?;
        let bytes = schema::object([
            ("format_version", Value::Int(Int::from(HEAD_VERSION))),
            ("head", schema::id_value(head)),
        ])
        .encode();
        files::write_atomically_durably(&self.staging, &self.head, &bytes)
            .map_err(|source| io_error(&self.head, source))
    }

    /// What `packs/` holds: the packs, and the names of the entries that are not packs. A missing
    /// `packs/` holds nothing; a link in it, or at it, is refused.
    pub fn list_packs(&self) -> Result<PackListing, StoreError> {
        let mut listing = PackListing::default();
        if !folder_exists(&self.packs)? {
            return Ok(listing);
        }
        let entries = StdFileSystem
            .read_dir(&self.packs)
            .map_err(|source| io_error(&self.packs, source))?;
        for entry in entries {
            let pack = entry
                .name
                .to_str()
                .and_then(|name| PackName::from_file_name(name).ok());
            match (entry.metadata.kind, pack) {
                (FileKind::Link, _) => {
                    let what = Subject::Pack(self.packs.join(&entry.name));
                    return Err(found_instead(what, FileKind::Link, FileKind::File));
                }
                (FileKind::File, Some(pack)) => listing.packs.push(pack),
                _ => listing.foreign.push(entry.name),
            }
        }
        listing.packs.sort_unstable();
        listing.foreign.sort_unstable();
        Ok(listing)
    }

    /// Whether `packs/` holds a pack. Without `HEAD`, a pack means damage rather than a library
    /// without history (versioning.md §4.2).
    pub fn has_packs(&self) -> Result<bool, StoreError> {
        Ok(!self.list_packs()?.packs.is_empty())
    }

    /// The index of the pack `name` (remote-format.md §11 steps 1–4 and 6, the hash its trailer
    /// states compared with its name), without reading its records: what the catalog indexes
    /// (versioning.md §4.3).
    pub fn read_pack_index(&self, name: PackName) -> Result<PackIndex, StoreError> {
        PackReader::open(self.pack_path(name))?.read_index(Some(name))
    }

    /// Checks the pack `name` whole: every step of remote-format.md §11, reading every byte.
    pub fn verify_pack(&self, name: PackName) -> Result<PackIndex, StoreError> {
        PackReader::open(self.pack_path(name))?.verify(Some(name))
    }

    /// The tree `id` at `location`, checked by every step of remote-format.md §11 that reads one
    /// record. A pack that is not there makes the tree [`StoreError::Missing`].
    pub fn read_tree(&self, id: ObjectId, location: Location) -> Result<Tree, StoreError> {
        self.open_pack(id, location)?.read_tree(id, location.offset)
    }

    /// The commit `id` at `location`, as [`LocalStore::read_tree`] reads trees.
    pub fn read_commit(&self, id: ObjectId, location: Location) -> Result<Commit, StoreError> {
        self.open_pack(id, location)?
            .read_commit(id, location.offset)
    }

    /// Opens the blob `id` at `location` for streaming: the reader checks its length and id when
    /// it reaches the end ([`ObjectReader`]). A record of another kind is refused.
    pub fn open_blob(
        &self,
        id: ObjectId,
        location: Location,
    ) -> Result<ObjectReader<File>, StoreError> {
        let object = self
            .open_pack(id, location)?
            .read_object(id, location.offset)?;
        if object.kind() != ObjectKind::Blob {
            return Err(StoreError::Invalid {
                what: Subject::Object(id),
                problem: PackProblem::WrongKind {
                    found: object.kind(),
                    wanted: ObjectKind::Blob,
                }
                .into(),
            });
        }
        Ok(object)
    }

    /// The trees of the store, found through `locator`: what [`HistoryChecker`](super::HistoryChecker)
    /// reads.
    pub fn trees<L: Locator>(&self, locator: L) -> StoreTrees<'_, L> {
        StoreTrees {
            store: self,
            locator,
        }
    }

    /// Starts one pack in `staging/` (versioning.md §4.3), in a new file named
    /// `pack-<16 random hexadecimal digits>.part`. A [`PackSet`] makes the packs §9.5 asks for.
    pub fn pack_writer(&self) -> Result<StagingWriter, StoreError> {
        ready_folder(&self.staging)?;
        let mut tries = 0;
        let file = loop {
            match FileSink::create(self.staging_name()?) {
                Err(StoreError::Io { source, .. })
                    if source.kind() == io::ErrorKind::AlreadyExists && tries < STAGING_TRIES =>
                {
                    tries += 1;
                }
                created => break created?,
            }
        };
        PackWriter::new(StagingFile { file })
    }

    /// A set of packs for one write, following remote-format.md §9.5.
    pub fn pack_set(&self) -> PackSet<'_> {
        PackSet::new(self, LIMITS)
    }

    /// Moves `staged` into `packs/` under its name with one rename written through to the disk,
    /// before anything names it (versioning.md §4.3). A pack of that name there already is kept
    /// when it passes the full check, as two packs of one name hold the same bytes, and the staged
    /// copy is removed; a damaged one, or one only a newer Folio would read, is replaced. A link or
    /// folder of that name is refused, and so is a file whose name is the pack's in another case,
    /// which is not the store's ([`Problem::OtherCase`]).
    ///
    /// After an error the staged file may still be in `staging/`, for
    /// [`LocalStore::clean_staging`].
    pub fn publish(&self, staged: StagedPack) -> Result<Published, StoreError> {
        ready_folder(&self.packs)?;
        let name = staged.name();
        let target = self.pack_path(name);
        let how = if file_exists(&target, || Subject::Pack(target.clone()))? {
            if let Some(found) = other_case(&target)? {
                return Err(StoreError::Invalid {
                    what: Subject::Pack(target),
                    problem: Problem::OtherCase { found },
                });
            }
            // Opened, checked and closed before anything replaces it.
            let existing = PackReader::open(&target).and_then(|mut pack| pack.verify(Some(name)));
            match existing {
                Ok(existing) => {
                    debug_assert_eq!(existing, staged.index, "one name, the same bytes");
                    remove_file(&staged.path, "pack.discard")?;
                    Publication::Kept
                }
                Err(StoreError::Invalid { .. } | StoreError::Newer { .. }) => {
                    crash::point("pack.replace");
                    rename_durably(&staged.path, &target, true)?;
                    Publication::Replaced
                }
                Err(error) => return Err(error),
            }
        } else {
            crash::point("pack.publish");
            rename_durably(&staged.path, &target, false)?;
            Publication::New
        };
        Ok(Published {
            index: staged.index,
            how,
        })
    }

    /// Deletes the pack `name` from `packs/`, and returns whether it was there. The pack is moved
    /// into `staging/` with a rename written through to the disk, so it cannot come back, then
    /// deleted there. Only for the packs of a first commit that crashed before its commit point
    /// (versioning.md §4.3, §7.5): M2 deletes no other pack. A link or folder of that name is
    /// refused; a file whose name is the pack's in another case is not the store's, and stays.
    pub fn remove_pack(&self, name: PackName) -> Result<bool, StoreError> {
        let target = self.pack_path(name);
        if !folder_exists(&self.packs)?
            || !file_exists(&target, || Subject::Pack(target.clone()))?
            || other_case(&target)?.is_some()
        {
            return Ok(false);
        }
        ready_folder(&self.staging)?;
        let aside = self.staging_name()?;
        crash::point("pack.remove");
        // The error names the pack, which another program may be holding open.
        files::rename_durably(&target, &aside, false)
            .map_err(|source| io_error(&target, source))?;
        remove_file(&aside, "pack.delete")?;
        Ok(true)
    }

    /// Removes the pack files that a crash or a failed write left in `staging/`
    /// (`pack-<16 hexadecimal digits>.part`), and nothing else: the folder also holds the temporary
    /// files of metadata writes, imports and restores. Returns how many it removed. Only while no
    /// pack is being written: at recovery (versioning.md §7.5).
    ///
    /// A file that cannot be removed, such as one another program holds open, does not keep the
    /// others: the first such failure is returned once every file was tried.
    pub fn clean_staging(&self) -> Result<usize, StoreError> {
        if !folder_exists(&self.staging)? {
            return Ok(0);
        }
        let mut entries = StdFileSystem
            .read_dir(&self.staging)
            .map_err(|source| io_error(&self.staging, source))?;
        entries.retain(|entry| {
            entry.metadata.kind == FileKind::File
                && entry.name.to_str().is_some_and(is_staging_name)
        });
        entries.sort_unstable_by(|a, b| a.name.cmp(&b.name));
        let paths = entries.iter().map(|entry| self.staging.join(&entry.name));
        remove_every(paths, "staging.clean")?;
        Ok(entries.len())
    }

    /// A new staging path for a pack, not created: `pack-<16 random hexadecimal digits>.part`.
    fn staging_name(&self) -> Result<PathBuf, StoreError> {
        let mut random = [0; STAGING_DIGITS / 2];
        getrandom::fill(&mut random)
            .map_err(|error| io_error(&self.staging, io::Error::other(error.to_string())))?;
        let digits: String = random.iter().map(|byte| format!("{byte:02x}")).collect();
        Ok(self
            .staging
            .join(format!("{STAGING_PREFIX}{digits}{STAGING_SUFFIX}")))
    }

    /// The pack at `location`, opened to read the object `id`; a pack that is not there makes the
    /// object missing.
    fn open_pack(&self, id: ObjectId, location: Location) -> Result<PackReader<File>, StoreError> {
        match PackReader::open(self.pack_path(location.pack)) {
            Err(StoreError::Io { source, .. }) if source.kind() == io::ErrorKind::NotFound => {
                Err(StoreError::Missing(id))
            }
            opened => opened,
        }
    }
}

/// What `packs/` holds ([`LocalStore::list_packs`]).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PackListing {
    /// The packs: files named `<64 hexadecimal digits>.pack`, ascending by name.
    pub packs: Vec<PackName>,
    /// The names of the other entries, ascending: files and folders that are not the store's,
    /// reported and left alone, as remote-format.md §10.1 treats such files in the remote.
    pub foreign: Vec<OsString>,
}

/// A pack in `packs/` after [`LocalStore::publish`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Published {
    pub index: PackIndex,
    pub how: Publication,
}

/// How [`LocalStore::publish`] put a pack into `packs/`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Publication {
    /// Renamed into `packs/` under its name.
    New,
    /// A pack of that name was there and passed the full check: kept, and the staged copy removed.
    Kept,
    /// A pack of that name was there and damaged, or newer: replaced by the staged copy.
    Replaced,
}

/// Where a pack in `staging/` is written: a [`FileSink`] whose writes, cuts and flush are crash
/// points (`pack.write`, `pack.truncate`, `pack.sync`). Bytes it holds but has not written are lost
/// when it is dropped, as in a crash.
#[derive(Debug)]
pub struct StagingFile {
    file: FileSink,
}

impl PackSink for StagingFile {
    fn write_all(&mut self, bytes: &[u8]) -> io::Result<()> {
        crash::point("pack.write");
        self.file.write_all(bytes)
    }

    fn truncate(&mut self, len: u64) -> io::Result<()> {
        crash::point("pack.truncate");
        self.file.truncate(len)
    }

    fn sync(&mut self) -> io::Result<()> {
        crash::point("pack.sync");
        self.file.sync()
    }

    fn path(&self) -> &Path {
        self.file.path()
    }
}

/// One pack being written in `staging/` ([`LocalStore::pack_writer`]).
pub type StagingWriter = PackWriter<StagingFile>;

impl PackWriter<StagingFile> {
    /// Finishes the pack (its index and trailer) and flushes it to the disk: a staged pack, which
    /// nothing names until it is published. After an error its file stays in `staging/`, for
    /// [`LocalStore::clean_staging`].
    pub fn stage(self) -> Result<StagedPack, StoreError> {
        let (index, file) = self.finish()?;
        Ok(StagedPack {
            index,
            path: file.file.into_path(),
        })
    }

    /// Stops writing the pack and removes its file.
    pub fn abandon(self) -> Result<(), StoreError> {
        let path = self.sink().path().to_path_buf();
        // The file is closed first; what it held unwritten is lost.
        drop(self);
        remove_file(&path, "pack.abandon")
    }
}

/// A finished pack in `staging/`, flushed to the disk, that nothing names yet (versioning.md §7.5
/// step 1). [`LocalStore::publish`] moves it into `packs/`, and [`StagedPack::abandon`] removes
/// it; dropped, it stays in `staging/` for [`LocalStore::clean_staging`].
#[derive(Debug)]
pub struct StagedPack {
    index: PackIndex,
    path: PathBuf,
}

impl StagedPack {
    /// What the pack holds: its name, size and objects.
    pub fn index(&self) -> &PackIndex {
        &self.index
    }

    pub fn name(&self) -> PackName {
        self.index.name()
    }

    /// Where the pack is in `staging/`.
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Removes the pack from `staging/`.
    pub fn abandon(self) -> Result<(), StoreError> {
        remove_file(&self.path, "pack.abandon")
    }
}

/// How a blob is packed (remote-format.md §9.5). The caller knows which file it is a version of;
/// the store does not look at files.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum BlobClass {
    /// A text file's version: compressed with zstd when that makes it smaller.
    Text,
    /// A Word version: stored raw (`.docx` is compressed already), and in a pack of its own from
    /// [`WORD_PACK_MIN`] bytes on.
    Word,
}

/// Where an object offered to a [`PackSet`] went.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InSet {
    /// Written into a pack of the set.
    Written,
    /// Offered before: an object goes into one pack of the set only (remote-format.md §9.5).
    Duplicate,
}

impl From<Added> for InSet {
    fn from(added: Added) -> Self {
        match added {
            Added::Written { .. } => Self::Written,
            Added::Duplicate { .. } => Self::Duplicate,
        }
    }
}

/// The pack sizes of remote-format.md §9.5.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Limits {
    /// A Word blob of at least this many bytes gets a pack of its own.
    word_alone: u64,
    /// Packs stay under this many bytes, unless one object alone makes a larger one.
    max: u64,
}

/// The sizes Folio packs with: [`WORD_PACK_MIN`] and [`PACK_MAX`].
const LIMITS: Limits = Limits {
    word_alone: WORD_PACK_MIN,
    max: PACK_MAX,
};

/// Where remote-format.md §9.5 puts an object.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Route {
    /// Into the shared pack, which is started when there is none.
    Shared,
    /// Into a new shared pack, after the one too full for it is finished.
    NewShared,
    /// Into a pack of its own.
    Alone,
}

impl Limits {
    /// Where an object of `raw` bytes goes (a Word blob when `word`), while the shared pack holds
    /// objects in `shared` bytes, `None` when it holds none. A compressed object may take less room
    /// than this reckons with, never more.
    fn route(self, shared: Option<u64>, raw: u64, word: bool) -> Route {
        if word && raw >= self.word_alone {
            return Route::Alone;
        }
        let fits = |size: u64| size + record_cost(raw) < self.max;
        match shared {
            Some(size) if fits(size) => Route::Shared,
            _ if !fits(EMPTY_PACK_LEN) => Route::Alone,
            Some(_) => Route::NewShared,
            None => Route::Shared,
        }
    }
}

/// The packs of one write in `staging/` (remote-format.md §9.5): objects go into a shared pack,
/// which a new one follows before it would reach [`PACK_MAX`]; a Word blob of [`WORD_PACK_MIN`]
/// bytes or more, and an object too large for any shared pack, get packs of their own; an object
/// offered twice is written once.
///
/// After an error from adding an object the set is in an unknown state: its packs may lack objects
/// it took (a full shared pack that failed to be finished is gone). Every later offer fails, and so
/// does [`PackSet::finish`]: abandon it. `finish` hands out every pack of the set or, when it fails,
/// removes them all.
pub struct PackSet<'a> {
    store: &'a LocalStore,
    limits: Limits,
    /// The shared pack being written.
    shared: Option<StagingWriter>,
    /// The packs finished so far.
    staged: Vec<StagedPack>,
    /// Every file the set made in `staging/`, which abandoning removes.
    files: Vec<PathBuf>,
    /// The objects in the set's packs.
    offered: HashSet<ObjectId>,
    /// An offer failed: the set's packs may lack objects in `offered`.
    failed: bool,
}

impl<'a> PackSet<'a> {
    fn new(store: &'a LocalStore, limits: Limits) -> Self {
        Self {
            store,
            limits,
            shared: None,
            staged: Vec::new(),
            files: Vec::new(),
            offered: HashSet::new(),
            failed: false,
        }
    }

    /// Whether a pack of the set holds `id`.
    pub fn contains(&self, id: ObjectId) -> bool {
        self.offered.contains(&id)
    }

    /// Adds a tree or commit, compressed with zstd when `compress` is set and that makes it smaller.
    pub fn add_object(&mut self, object: &Encoded, compress: bool) -> Result<InSet, StoreError> {
        let raw = object.bytes().len() as u64;
        let added = self.offer(object.id(), raw, false, |writer| {
            writer.add_object(object, compress).map(Streamed::Added)
        })?;
        Ok(in_memory(added))
    }

    /// Adds a blob held in memory, packed as its `class` says.
    pub fn add_blob(&mut self, bytes: &[u8], class: BlobClass) -> Result<InSet, StoreError> {
        let id = ObjectId::of(ObjectKind::Blob, bytes);
        let word = class == BlobClass::Word;
        let added = self.offer(id, bytes.len() as u64, word, |writer| {
            writer.add_blob(bytes, !word).map(Streamed::Added)
        })?;
        Ok(in_memory(added))
    }

    /// Adds the blob `id` of `size` bytes read from `source`, packed as its `class` says
    /// ([`PackWriter::add_blob_from`]): when its bytes are not `id`, or reading fails, the set is as
    /// if it had not been offered.
    pub fn add_blob_from(
        &mut self,
        id: ObjectId,
        size: Size,
        source: impl Read,
        class: BlobClass,
    ) -> Result<Streamed<InSet>, StoreError> {
        let word = class == BlobClass::Word;
        self.offer(id, size.get(), word, |writer| {
            writer.add_blob_from(id, size, source, !word)
        })
    }

    /// Finishes the set: the shared pack is finished and flushed when it holds an object, and
    /// removed when it holds none (a stream that did not match was cut out of it). Returns the
    /// set's packs in the order they were finished; none when nothing was added.
    ///
    /// When that fails, or an offer failed before, nothing is handed out: every pack file the set
    /// made is removed, as [`PackSet::abandon`] removes them, and the error returned is the failure
    /// that stopped the set. A file that cannot be removed then is left for
    /// [`LocalStore::clean_staging`], as after a crash.
    pub fn finish(mut self) -> Result<Vec<StagedPack>, StoreError> {
        let finished = match self.shared.take() {
            shared if self.failed => {
                // Closed before the files are removed; what it held unwritten is lost.
                drop(shared);
                Err(self.unusable())
            }
            Some(shared) if shared.object_count() > 0 => {
                shared.stage().map(|staged| self.staged.push(staged))
            }
            Some(empty) => empty.abandon(),
            None => Ok(()),
        };
        match finished {
            Ok(()) => Ok(self.staged),
            Err(error) => {
                // What stopped the set is the error to report; clean_staging is the safety net
                // for a file this cannot remove.
                let _ = self.remove_files();
                Err(error)
            }
        }
    }

    /// Stops the set and removes every pack file it made in `staging/`. A file that cannot be
    /// removed does not keep the others: the first such failure is returned once every file was
    /// tried.
    pub fn abandon(mut self) -> Result<(), StoreError> {
        // Closed first; what the shared pack held unwritten is lost.
        drop(self.shared.take());
        self.remove_files()
    }

    /// Removes every pack file the set made, a file that is gone already included; returns the
    /// first failure after trying every file.
    fn remove_files(&self) -> Result<(), StoreError> {
        remove_every(&self.files, "pack.abandon")
    }

    /// Offers the object `id` of `raw` bytes (a Word blob when `word`) to the pack §9.5 puts it in,
    /// where `add` writes it. After a failed offer, every offer fails.
    fn offer(
        &mut self,
        id: ObjectId,
        raw: u64,
        word: bool,
        add: impl FnOnce(&mut StagingWriter) -> Result<Streamed, StoreError>,
    ) -> Result<Streamed<InSet>, StoreError> {
        if self.failed {
            return Err(self.unusable());
        }
        let offered = self.place(id, raw, word, add);
        // A pack that failed may have taken objects the set holds: a full shared pack that fails
        // to be finished when a new one starts is gone, its objects still in `offered`.
        if offered.is_err() {
            self.failed = true;
        }
        offered
    }

    /// [`PackSet::offer`]'s work: the object into the pack §9.5 puts it in.
    fn place(
        &mut self,
        id: ObjectId,
        raw: u64,
        word: bool,
        add: impl FnOnce(&mut StagingWriter) -> Result<Streamed, StoreError>,
    ) -> Result<Streamed<InSet>, StoreError> {
        if self.offered.contains(&id) {
            return Ok(Streamed::Added(InSet::Duplicate));
        }
        let shared = self
            .shared
            .as_ref()
            .filter(|writer| writer.object_count() > 0)
            .map(StagingWriter::size);
        let streamed = match self.limits.route(shared, raw, word) {
            Route::Alone => {
                let mut writer = self.writer()?;
                let streamed = add(&mut writer)?;
                if let Streamed::Added(_) = streamed {
                    self.staged.push(writer.stage()?);
                } else {
                    writer.abandon()?;
                }
                streamed
            }
            Route::NewShared => {
                if let Some(full) = self.shared.take() {
                    self.staged.push(full.stage()?);
                }
                let writer = self.writer()?;
                add(self.shared.insert(writer))?
            }
            Route::Shared => {
                if self.shared.is_none() {
                    self.shared = Some(self.writer()?);
                }
                add(self.shared.as_mut().expect("the shared pack was started"))?
            }
        };
        if let Streamed::Added(_) = streamed {
            self.offered.insert(id);
        }
        Ok(streamed.map(InSet::from))
    }

    /// A new pack in `staging/`, remembered for [`PackSet::abandon`].
    fn writer(&mut self) -> Result<StagingWriter, StoreError> {
        let writer = self.store.pack_writer()?;
        self.files.push(writer.sink().path().to_path_buf());
        Ok(writer)
    }

    /// What an offer, or finishing, returns after an offer failed.
    fn unusable(&self) -> StoreError {
        let source = io::Error::other("an earlier offer to this pack set failed");
        io_error(&self.store.staging, source)
    }
}

impl std::fmt::Debug for PackSet<'_> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PackSet")
            .field("limits", &self.limits)
            .field("shared", &self.shared)
            .field("staged", &self.staged)
            .field("objects", &self.offered.len())
            .field("failed", &self.failed)
            .finish_non_exhaustive()
    }
}

/// Where an object held in memory went: such an add is never a mismatch or unreadable.
fn in_memory(streamed: Streamed<InSet>) -> InSet {
    match streamed {
        Streamed::Added(added) => added,
        Streamed::Mismatch { .. } | Streamed::Unreadable(_) => {
            unreachable!("an object held in memory is never streamed")
        }
    }
}

/// Where the store finds objects (versioning.md §4.3): the catalog's `objects` table, or a
/// [`MemoryIndex`].
pub trait Locator {
    /// Where `id`'s record is, or `None` when no indexed pack holds it.
    fn locate(&self, id: ObjectId) -> Result<Option<Location>, StoreError>;
}

impl<L: Locator + ?Sized> Locator for &L {
    fn locate(&self, id: ObjectId) -> Result<Option<Location>, StoreError> {
        (**self).locate(id)
    }
}

/// Where objects are, from pack indexes held in memory: the catalog's `objects` table for tests and
/// for checks that run without a catalog. As in the catalog, an object has one location, the first
/// one added.
#[derive(Debug, Clone, Default)]
pub struct MemoryIndex {
    objects: HashMap<ObjectId, Location>,
}

impl MemoryIndex {
    pub fn new() -> Self {
        Self::default()
    }

    /// An index of every pack in `store`'s `packs/`, from their indexes (remote-format.md §11
    /// steps 1–4 and 6). Foreign entries are left out.
    pub fn of_store(store: &LocalStore) -> Result<Self, StoreError> {
        let mut index = Self::new();
        for name in store.list_packs()?.packs {
            index.add_pack(&store.read_pack_index(name)?);
        }
        Ok(index)
    }

    /// Adds every object of a pack; an object located already keeps its location.
    pub fn add_pack(&mut self, pack: &PackIndex) {
        for entry in pack.entries() {
            self.objects.entry(entry.id).or_insert(Location {
                pack: pack.name(),
                offset: entry.offset,
            });
        }
    }

    /// Where `id`'s record is, if an indexed pack holds it.
    pub fn get(&self, id: ObjectId) -> Option<Location> {
        self.objects.get(&id).copied()
    }

    pub fn len(&self) -> usize {
        self.objects.len()
    }

    pub fn is_empty(&self) -> bool {
        self.objects.is_empty()
    }
}

impl Locator for MemoryIndex {
    fn locate(&self, id: ObjectId) -> Result<Option<Location>, StoreError> {
        Ok(self.get(id))
    }
}

/// The trees of a [`LocalStore`] found through a [`Locator`] ([`LocalStore::trees`]): the
/// [`TreeSource`] the history checks read. A tree the locator does not know, or whose pack is not
/// there, is missing. Each tree asked for is located, read and checked again: the walks of the
/// checks keep the trees they meet twice, and visit the others once.
#[derive(Debug)]
pub struct StoreTrees<'a, L> {
    store: &'a LocalStore,
    locator: L,
}

impl<L> StoreTrees<'_, L> {
    pub fn locator(&self) -> &L {
        &self.locator
    }
}

impl<L: Locator> TreeSource for StoreTrees<'_, L> {
    fn tree(&self, id: ObjectId) -> Result<Option<Arc<Tree>>, StoreError> {
        let Some(location) = self.locator.locate(id)? else {
            return Ok(None);
        };
        match self.store.read_tree(id, location) {
            Ok(tree) => Ok(Some(Arc::new(tree))),
            Err(StoreError::Missing(missing)) if missing == id => Ok(None),
            Err(error) => Err(error),
        }
    }
}

/// Reads `HEAD`'s bytes in the order remote-format.md §11 reads a record: JSON, the version, the
/// canonical form, the schema.
fn parse_head(bytes: &[u8], head: impl Fn() -> Subject) -> Result<ObjectId, StoreError> {
    let value = schema::versioned(bytes, HEAD_LIMIT, HEAD_VERSION, &head)?;
    Fields::new(Part::Head, value, &["format_version", "head"], &[])
        .and_then(|mut fields| fields.id("head"))
        .map_err(|error| StoreError::Invalid {
            what: head(),
            problem: error.into(),
        })
}

/// Whether `name` is a pack file's name in `staging/`: `pack-`, 16 lower-case hexadecimal digits
/// and `.part`.
fn is_staging_name(name: &str) -> bool {
    name.strip_prefix(STAGING_PREFIX)
        .and_then(|rest| rest.strip_suffix(STAGING_SUFFIX))
        .is_some_and(|digits| digits.len() == STAGING_DIGITS && crate::is_lower_hex(digits))
}

/// What is at `path`, without following a link there; `None` when nothing is. Every read and write
/// of the store starts here; in tests it can fail on purpose (`crate::crash`'s fault
/// `store.metadata`), as no held file makes it fail.
fn entry_kind(path: &Path) -> Result<Option<FileKind>, StoreError> {
    let metadata = crash::fault("store.metadata").and_then(|()| StdFileSystem.metadata(path));
    match metadata {
        Ok(metadata) => Ok(Some(metadata.kind)),
        Err(source) if source.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(source) => Err(io_error(path, source)),
    }
}

/// Whether the store's folder `path` is there; anything else there is refused.
fn folder_exists(path: &Path) -> Result<bool, StoreError> {
    match entry_kind(path)? {
        None => Ok(false),
        Some(FileKind::Folder) => Ok(true),
        Some(found) => Err(found_instead(
            Subject::Folder(path.to_path_buf()),
            found,
            FileKind::Folder,
        )),
    }
}

/// Whether the store's file `path`, named `what` in errors, is there; anything else there is
/// refused.
fn file_exists(path: &Path, what: impl FnOnce() -> Subject) -> Result<bool, StoreError> {
    match entry_kind(path)? {
        None => Ok(false),
        Some(FileKind::File) => Ok(true),
        Some(found) => Err(found_instead(what(), found, FileKind::File)),
    }
}

/// The name the file at `path` has on the disk, when it is not the name `path` gives: NTFS takes
/// a name that differs in case only for the same file, while the listing compares names exactly.
fn other_case(path: &Path) -> Result<Option<OsString>, StoreError> {
    let on_disk = fs::canonicalize(path).map_err(|source| io_error(path, source))?;
    Ok(on_disk
        .file_name()
        .filter(|&name| Some(name) != path.file_name())
        .map(OsString::from))
}

/// Creates the store's folder `path` when it is not there; anything else there is refused.
fn ready_folder(path: &Path) -> Result<(), StoreError> {
    if folder_exists(path)? {
        return Ok(());
    }
    fs::create_dir_all(path).map_err(|source| io_error(path, source))
}

/// Renames the file `from` to `to` durably ([`files::rename_durably`]); an error names `to`.
fn rename_durably(from: &Path, to: &Path, replace: bool) -> Result<(), StoreError> {
    files::rename_durably(from, to, replace).map_err(|source| io_error(to, source))
}

/// Removes each file of `paths` ([`remove_file`]): one that cannot be removed does not keep the
/// others, and the first failure is returned once every file was tried.
fn remove_every(
    paths: impl IntoIterator<Item = impl AsRef<Path>>,
    step: &'static str,
) -> Result<(), StoreError> {
    let mut first = Ok(());
    for path in paths {
        let removed = remove_file(path.as_ref(), step);
        if first.is_ok() {
            first = removed;
        }
    }
    first
}

/// Removes the file `path`, after the crash point `step`; a file that is gone already is fine.
fn remove_file(path: &Path, step: &'static str) -> Result<(), StoreError> {
    crash::point(step);
    let removed =
        crash::fault(step).and_then(|()| files::retry_transient(|| fs::remove_file(path)));
    match removed {
        Ok(()) => Ok(()),
        Err(source) if source.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(source) => Err(io_error(path, source)),
    }
}

fn found_instead(what: Subject, found: FileKind, expected: FileKind) -> StoreError {
    StoreError::Invalid {
        what,
        problem: Problem::Found { found, expected },
    }
}

#[cfg(test)]
mod tests;
