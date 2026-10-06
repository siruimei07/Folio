//! Reading packs (remote-format.md §11): the index alone, a full check of every byte, and one
//! object at a time.
//!
//! - [`PackReader::read_index`] runs steps 1–4 and 6, compares the hash the trailer states with the
//!   file name, and refuses an entry whose offset no record can start at: what indexing a local
//!   pack needs (versioning.md §4.3).
//! - [`PackReader::verify`] runs every step. Header and trailer come first, so a newer pack is
//!   newer whatever else it holds (§3); then the index; then one sequential pass hashes the file
//!   and walks every record. A problem with the index or a record waits for the hash, so the first
//!   failing step in §11's order gives the reason. Memory: the index, one tree's or commit's bytes
//!   (at most 64 MiB) with what its schema takes out of them, and a zstd window: one zstd context
//!   for the whole pass, reset for each compressed record.
//! - [`PackReader::read_object`] runs steps 1–4, the index's bounds and steps 7–11 for one record:
//!   an [`ObjectReader`] streams the object and checks its length, its id and, for a tree or
//!   commit, its schema when it reaches the end. [`PackReader::read_tree`] and
//!   [`PackReader::read_commit`] return the parsed object.
//!
//! A pack is read from any `Read + Seek` source of a known length: a file or bytes in memory.

use std::fmt;
use std::fs::File;
use std::io::{self, BufReader, Cursor, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

use super::{
    CHUNK, END_MAGIC, FLAG_ZSTD, HEADER_LEN, INDEX_ENTRY_LEN, IndexEntry, MAGIC, MIN_PACK_LEN,
    PackIndex, PackName, PackProblem, RECORD_HEADER_LEN, TRAILER_LEN, VERSION, starts_record,
};
use crate::store::commit::Commit;
use crate::store::id::{ObjectHasher, ObjectId, ObjectKind};
use crate::store::schema::MAX_OBJECT_SIZE;
use crate::store::tree::Tree;
use crate::store::values::Size;
use crate::store::zstd::FrameDecoder;
use crate::store::{Problem, StoreError, Subject, io_error};

/// The index entries read at a time.
const ENTRIES_PER_READ: usize = 1024;

/// A record's header (remote-format.md §9.2) and where it is in its pack.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Record {
    /// The offset of the record's header.
    pub offset: u64,
    pub kind: ObjectKind,
    pub id: ObjectId,
    /// The object's length.
    pub raw_length: u64,
    /// The payload's length: the raw length, or the zstd frame's when `compressed`.
    pub stored_length: u64,
    pub compressed: bool,
}

impl Record {
    /// The offset after the record.
    pub fn end(&self) -> u64 {
        self.offset + RECORD_HEADER_LEN as u64 + self.stored_length
    }

    /// The record's header as packs store it: type, flags, id, raw length and stored length.
    pub(super) fn header(&self) -> [u8; RECORD_HEADER_LEN] {
        let mut header = [0; RECORD_HEADER_LEN];
        header[0] = self.kind.code();
        header[1] = if self.compressed { FLAG_ZSTD } else { 0 };
        header[2..34].copy_from_slice(self.id.as_bytes());
        header[34..42].copy_from_slice(&self.raw_length.to_le_bytes());
        header[42..50].copy_from_slice(&self.stored_length.to_le_bytes());
        header
    }

    /// Reads the record header `bytes` at `offset` and checks what step 7 asks of a header alone:
    /// a type and flags of version 1, a raw length of the format (as generate.mjs reads lengths)
    /// and a payload that ends before the index at `index_at`. The caller has checked that the
    /// header itself ends there.
    fn parse(
        offset: u64,
        bytes: &[u8; RECORD_HEADER_LEN],
        index_at: u64,
    ) -> Result<Self, PackProblem> {
        let code = bytes[0];
        let kind = ObjectKind::from_code(code).ok_or(PackProblem::RecordType { offset, code })?;
        let flags = bytes[1];
        if flags & !FLAG_ZSTD != 0 {
            return Err(PackProblem::RecordFlags { offset, flags });
        }
        let raw_length = u64_at(bytes, 34);
        let stored_length = u64_at(bytes, 42);
        let room = index_at - (offset + RECORD_HEADER_LEN as u64);
        if raw_length > Size::MAX.get() || stored_length > room {
            return Err(PackProblem::RecordBounds { offset });
        }
        Ok(Self {
            offset,
            kind,
            id: id_at(bytes, 2),
            raw_length,
            stored_length,
            compressed: flags == FLAG_ZSTD,
        })
    }
}

/// What a pack's header and trailer say once steps 1–4 have passed.
#[derive(Debug, Clone, Copy)]
struct Ends {
    /// N, as the trailer states it.
    count: u64,
    /// The hash the trailer states.
    stated: [u8; 32],
}

/// Reads a pack (remote-format.md §11) from a source of known length: its index, a full check,
/// or one object.
///
/// Every method checks again what it needs from the start, so one reader serves several calls.
/// I/O errors name the pack's path; so do the problems of steps 1–7, while those of steps 8–11
/// name the object.
pub struct PackReader<R> {
    source: R,
    len: u64,
    /// Where the pack is, for error messages; empty for a pack in memory.
    path: PathBuf,
}

impl PackReader<File> {
    /// Opens the pack file at `path`.
    pub fn open(path: impl Into<PathBuf>) -> Result<Self, StoreError> {
        let path = path.into();
        let opened = File::open(&path).and_then(|file| Ok((file.metadata()?.len(), file)));
        match opened {
            Ok((len, file)) => Ok(Self::new(file, len, path)),
            Err(source) => Err(StoreError::Io { path, source }),
        }
    }
}

impl<'a> PackReader<Cursor<&'a [u8]>> {
    /// A pack held in memory.
    pub fn from_bytes(bytes: &'a [u8]) -> Self {
        Self::new(Cursor::new(bytes), bytes.len() as u64, PathBuf::new())
    }
}

impl<R> PackReader<R> {
    /// A pack of `len` bytes read from `source`, named `path` in errors.
    pub fn new(source: R, len: u64, path: impl Into<PathBuf>) -> Self {
        Self {
            source,
            len,
            path: path.into(),
        }
    }

    /// The pack's length in bytes.
    pub fn size(&self) -> u64 {
        self.len
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    fn invalid(&self, problem: impl Into<Problem>) -> StoreError {
        StoreError::Invalid {
            what: Subject::Pack(self.path.clone()),
            problem: problem.into(),
        }
    }
}

impl<R: Read + Seek> PackReader<R> {
    /// The pack's index (§11 steps 1–4 and 6), without reading its records: what the catalog
    /// indexes. When `name` is given, the hash the trailer states must be it; the hash itself is
    /// not computed.
    ///
    /// An entry whose offset no record can start at (before the first record, or without room for
    /// a record header before the index) is refused with step 7's [`PackProblem::RecordBounds`]:
    /// no record can have that entry, so the full check refuses the pack too. Every offset of an
    /// index handed out is thus one a record can start at, which the catalog stores.
    pub fn read_index(&mut self, name: Option<PackName>) -> Result<PackIndex, StoreError> {
        let ends = self.read_ends()?;
        if name.is_some_and(|name| *name.as_bytes() != ends.stated) {
            return Err(self.invalid(PackProblem::Name));
        }
        let index_at = self.index_at(ends.count)?;
        let entries = self.read_entries(ends.count, index_at)?;
        // After the order of every entry, as step 6 comes before step 7.
        if let Some(entry) = entries
            .iter()
            .find(|entry| !starts_record(entry.offset, index_at))
        {
            return Err(self.invalid(PackProblem::RecordBounds {
                offset: entry.offset,
            }));
        }
        Ok(PackIndex::new(
            PackName::from_bytes(ends.stated),
            self.len,
            entries,
        ))
    }

    /// Checks the whole pack (every step of §11; `name`, its file name, when it is known) and
    /// returns its index. A remote pack passes this before any of its objects is used.
    ///
    /// The hash is computed over the bytes the pass reads and compared with the one read before
    /// it, so a file that changes while it is checked never passes.
    pub fn verify(&mut self, name: Option<PackName>) -> Result<PackIndex, StoreError> {
        self.verify_with(name, |_| {})
    }

    /// [`PackReader::verify`], handing `visit` each record in pack order once it has passed steps
    /// 7–11. A record visited is not usable until the whole check has passed: the hash comes at
    /// the end, and a later record may fail.
    pub fn verify_with(
        &mut self,
        name: Option<PackName>,
        mut visit: impl FnMut(&Record),
    ) -> Result<PackIndex, StoreError> {
        let ends = self.read_ends()?;
        // Steps 5–7 are decided after one pass over the whole file: a problem with the index or a
        // record waits for the hash, which comes first in §11's order.
        let mut problem = None;
        let mut index = None;
        let read = self
            .index_at(ends.count)
            .and_then(|at| Ok((at, self.read_entries(ends.count, at)?)));
        match read {
            Ok(read) => index = Some(read),
            Err(error @ StoreError::Invalid { .. }) => problem = Some(error),
            Err(error) => return Err(error),
        }
        // The hash covers everything before it.
        let hashed_len = self.len - ends.stated.len() as u64;
        let mut pass = Pass::start(&mut self.source, &self.path)?;
        let mut matched = 0;
        // The records are walked only against an index that passed.
        let walk = if problem.is_none() {
            index.as_ref()
        } else {
            None
        };
        if let Some((index_at, entries)) = walk {
            pass.skip_to(HEADER_LEN)?;
            let mut scratch = vec![0; CHUNK];
            let mut offset = HEADER_LEN;
            while offset < *index_at {
                match pass.record(offset, *index_at, entries, &mut scratch) {
                    Ok(record) => {
                        matched += 1;
                        visit(&record);
                        offset = record.end();
                    }
                    Err(error @ StoreError::Invalid { .. }) => {
                        problem = Some(error);
                        break;
                    }
                    Err(error) => return Err(error),
                }
            }
        }
        // The rest is hashed as it is: the header, index and trailer were read before the pass,
        // and the hash shows they are these bytes.
        pass.skip_to(hashed_len)?;
        let hash = pass.hash();
        if hash != ends.stated {
            return Err(self.invalid(PackProblem::Hash));
        }
        if name.is_some_and(|name| *name.as_bytes() != hash) {
            return Err(self.invalid(PackProblem::Name));
        }
        if let Some(problem) = problem {
            return Err(problem);
        }
        let (_, entries) = index.expect("without a problem the index was read");
        if matched != entries.len() {
            return Err(self.invalid(PackProblem::IndexWithoutRecord));
        }
        Ok(PackIndex::new(
            PackName::from_bytes(hash),
            self.len,
            entries,
        ))
    }

    /// Opens the object `id` whose record is at `offset` (steps 1–4, the index's bounds and steps
    /// 7–11) for streaming: the reader checks the object as it reaches its end.
    pub fn read_object(mut self, id: ObjectId, offset: u64) -> Result<ObjectReader<R>, StoreError> {
        let record = self.open_record(id, offset)?;
        ObjectReader::new(self.source, self.path, record)
    }

    /// Reads the tree `id` whose record is at `offset`, checked by every step of §11 that reads
    /// one record.
    pub fn read_tree(&mut self, id: ObjectId, offset: u64) -> Result<Tree, StoreError> {
        match self.read_whole(id, offset, ObjectKind::Tree)? {
            Parsed::Tree(tree) => Ok(tree),
            Parsed::Commit(_) => unreachable!("read_whole checks the record's kind"),
        }
    }

    /// Reads the commit `id` whose record is at `offset`, as [`PackReader::read_tree`] reads trees.
    pub fn read_commit(&mut self, id: ObjectId, offset: u64) -> Result<Commit, StoreError> {
        match self.read_whole(id, offset, ObjectKind::Commit)? {
            Parsed::Commit(commit) => Ok(*commit),
            Parsed::Tree(_) => unreachable!("read_whole checks the record's kind"),
        }
    }

    fn read_whole(
        &mut self,
        id: ObjectId,
        offset: u64,
        wanted: ObjectKind,
    ) -> Result<Parsed, StoreError> {
        let record = self.open_record(id, offset)?;
        if record.kind != wanted {
            return Err(invalid_object(
                id,
                PackProblem::WrongKind {
                    found: record.kind,
                    wanted,
                }
                .into(),
            ));
        }
        let mut object = ObjectReader::new(&mut self.source, self.path.clone(), record)?;
        object.drain(&mut vec![0; buffer_len(record.raw_length)])?;
        Ok(object
            .parsed
            .take()
            .expect("a tree or commit read to its end is parsed"))
    }

    /// Steps 1–4: the length, the magic, the version (above 1: newer, and nothing else is read)
    /// and the end magic.
    fn read_ends(&mut self) -> Result<Ends, StoreError> {
        if self.len < MIN_PACK_LEN {
            return Err(self.invalid(PackProblem::TooShort { len: self.len }));
        }
        let mut header = [0; HEADER_LEN as usize];
        self.read_at(0, &mut header)?;
        if header[..MAGIC.len()] != MAGIC {
            return Err(self.invalid(PackProblem::Magic));
        }
        let version = u32::from_le_bytes(header[8..12].try_into().expect("4 bytes"));
        if version == 0 {
            return Err(self.invalid(PackProblem::VersionZero));
        }
        if version > VERSION {
            return Err(StoreError::Newer {
                what: Subject::Pack(self.path.clone()),
                version: version.to_string(),
            });
        }
        let mut trailer = [0; TRAILER_LEN as usize];
        self.read_at(self.len - TRAILER_LEN, &mut trailer)?;
        if trailer[8..16] != END_MAGIC {
            return Err(self.invalid(PackProblem::EndMagic));
        }
        Ok(Ends {
            count: u64_at(&trailer, 0),
            stated: trailer[16..].try_into().expect("32 bytes"),
        })
    }

    /// Step 6's bounds: N is at least 1 and the index fits between the first record's header and
    /// the trailer, so N is far below 2^53. Returns the index's offset.
    fn index_at(&self, count: u64) -> Result<u64, StoreError> {
        if count == 0 {
            return Err(self.invalid(PackProblem::Empty));
        }
        // At least 40 bytes: step 1 passed.
        let room = self.len - TRAILER_LEN - HEADER_LEN - RECORD_HEADER_LEN as u64;
        match count.checked_mul(INDEX_ENTRY_LEN) {
            Some(index_len) if index_len <= room => Ok(self.len - TRAILER_LEN - index_len),
            _ => Err(self.invalid(PackProblem::IndexSize { count })),
        }
    }

    /// Step 6's order: the `count` entries at `index_at`, in strictly ascending order of id.
    fn read_entries(&mut self, count: u64, index_at: u64) -> Result<Vec<IndexEntry>, StoreError> {
        // The entries fit in the file (`index_at`), so their number is bounded by its length.
        let count =
            usize::try_from(count).map_err(|_| self.invalid(PackProblem::IndexSize { count }))?;
        // The count is not checked yet: memory grows with the entries that pass, so a damaged
        // count in a large pack asks for no more than one read's worth.
        let mut entries: Vec<IndexEntry> = Vec::with_capacity(count.min(ENTRIES_PER_READ));
        let mut chunk = vec![0; INDEX_ENTRY_LEN as usize * count.min(ENTRIES_PER_READ)];
        self.seek(index_at)?;
        while entries.len() < count {
            let take = (count - entries.len()).min(ENTRIES_PER_READ);
            let bytes = &mut chunk[..INDEX_ENTRY_LEN as usize * take];
            if let Err(source) = self.source.read_exact(bytes) {
                return Err(io_error(&self.path, source));
            }
            for raw in bytes.chunks_exact(INDEX_ENTRY_LEN as usize) {
                let entry = IndexEntry {
                    id: id_at(raw, 0),
                    offset: u64_at(raw, ObjectId::LEN),
                };
                if entries.last().is_some_and(|last| last.id >= entry.id) {
                    return Err(self.invalid(PackProblem::IndexOrder));
                }
                entries.push(entry);
            }
        }
        Ok(entries)
    }

    /// Steps 1–4, the index's bounds and step 7 for the record of `id` at `offset`, leaving the
    /// source at its payload. The caller's offset stands in for the index entry (it came from the
    /// index), so the record must hold `id`.
    fn open_record(&mut self, id: ObjectId, offset: u64) -> Result<Record, StoreError> {
        let ends = self.read_ends()?;
        let index_at = self.index_at(ends.count)?;
        if !starts_record(offset, index_at) {
            return Err(self.invalid(PackProblem::RecordBounds { offset }));
        }
        let mut header = [0; RECORD_HEADER_LEN];
        self.read_at(offset, &mut header)?;
        let record =
            Record::parse(offset, &header, index_at).map_err(|problem| self.invalid(problem))?;
        if record.id != id {
            return Err(self.invalid(PackProblem::WrongObject {
                offset,
                wanted: id,
                found: record.id,
            }));
        }
        Ok(record)
    }

    fn read_at(&mut self, at: u64, bytes: &mut [u8]) -> Result<(), StoreError> {
        self.seek(at)?;
        self.source
            .read_exact(bytes)
            .map_err(|source| io_error(&self.path, source))
    }

    fn seek(&mut self, at: u64) -> Result<(), StoreError> {
        self.source
            .seek(SeekFrom::Start(at))
            .map(drop)
            .map_err(|source| io_error(&self.path, source))
    }
}

impl<R> fmt::Debug for PackReader<R> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("PackReader")
            .field("path", &self.path)
            .field("len", &self.len)
            .finish_non_exhaustive()
    }
}

/// Reads through to `inner`, hashing and counting every byte it hands out.
struct Hashing<R> {
    inner: R,
    hash: blake3::Hasher,
    pos: u64,
}

impl<R: Read> Read for Hashing<R> {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        let read = self.inner.read(buffer)?;
        self.hash.update(&buffer[..read]);
        self.pos += read as u64;
        Ok(read)
    }
}

/// [`PackReader::verify`]'s one sequential pass over the pack: it hashes every byte before the
/// stored hash and walks the records on the way, decoding every compressed one with one zstd
/// context.
struct Pass<'a, R> {
    stream: Hashing<BufReader<&'a mut R>>,
    path: &'a Path,
    /// The last compressed record's decoder, whose context the next one uses again: a context per
    /// record would take its window's room again for each, 8 MiB for a frame that states no
    /// content size.
    decoder: Option<FrameDecoder>,
}

impl<'a, R: Read + Seek> Pass<'a, R> {
    fn start(source: &'a mut R, path: &'a Path) -> Result<Self, StoreError> {
        if let Err(error) = source.seek(SeekFrom::Start(0)) {
            return Err(io_error(path, error));
        }
        Ok(Self {
            stream: Hashing {
                inner: BufReader::with_capacity(CHUNK, source),
                hash: blake3::Hasher::new(),
                pos: 0,
            },
            path,
            decoder: None,
        })
    }

    /// Reads the record at `offset`, which the index must list at that offset, and checks it
    /// (steps 7–11).
    fn record(
        &mut self,
        offset: u64,
        index_at: u64,
        entries: &[IndexEntry],
        scratch: &mut [u8],
    ) -> Result<Record, StoreError> {
        debug_assert_eq!(self.stream.pos, offset, "the pass is at the record");
        let invalid = |problem: PackProblem| StoreError::Invalid {
            what: Subject::Pack(self.path.to_path_buf()),
            problem: problem.into(),
        };
        if offset + RECORD_HEADER_LEN as u64 > index_at {
            return Err(invalid(PackProblem::RecordBounds { offset }));
        }
        let mut header = [0; RECORD_HEADER_LEN];
        if let Err(source) = self.stream.read_exact(&mut header) {
            return Err(io_error(self.path, source));
        }
        let record = Record::parse(offset, &header, index_at).map_err(invalid)?;
        if entries
            .binary_search(&IndexEntry {
                id: record.id,
                offset,
            })
            .is_err()
        {
            return Err(invalid(PackProblem::NotIndexed { offset }));
        }
        let spare = if record.compressed {
            self.decoder.take()
        } else {
            None
        };
        let mut object =
            ObjectReader::with_decoder(&mut self.stream, self.path.to_path_buf(), record, spare)?;
        object.drain(scratch)?;
        if let Some(decoder) = object.into_decoder() {
            self.decoder = Some(decoder);
        }
        Ok(record)
    }

    /// Reads on, hashing but not checking, up to the offset `end`.
    fn skip_to(&mut self, end: u64) -> Result<(), StoreError> {
        let left = end - self.stream.pos;
        match io::copy(&mut (&mut self.stream).take(left), &mut io::sink()) {
            Ok(copied) if copied == left => Ok(()),
            Ok(_) => Err(io_error(self.path, io::ErrorKind::UnexpectedEof.into())),
            Err(source) => Err(io_error(self.path, source)),
        }
    }

    /// The hash of everything read.
    fn hash(&self) -> [u8; 32] {
        *self.stream.hash.finalize().as_bytes()
    }
}

/// A tree or commit parsed at the end of its record.
enum Parsed {
    Tree(Tree),
    Commit(Box<Commit>),
}

/// Where an [`ObjectReader`] is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum State {
    Reading,
    Verified,
    Failed,
}

/// A compressed payload's decoder and the payload bytes read but not taken by it yet.
struct Frame {
    decoder: FrameDecoder,
    input: Vec<u8>,
    start: usize,
    end: usize,
}

/// Streams one object out of its record (remote-format.md §11, steps 8–11): the payload as it is,
/// or decoded from its zstd frame in memory bounded by the frame's window. At the end it checks
/// the object's length and id, and parses a tree or commit, kept whole (at most 64 MiB), against
/// its schema.
///
/// The read that hands out the object's last byte checks the object first, with the rest of its
/// payload (the frame's end), and fails when the object is damaged: a caller that reads exactly
/// [`ObjectReader::raw_length`] bytes (`read_exact`, `take`) never gets a damaged object without
/// an error. An empty object, which no read hands out a byte of, is checked when it is opened. A
/// read that returns 0 before the last byte, at a payload that ends too soon, fails too. Until
/// then the bytes handed out are unchecked ([`ObjectReader::is_verified`]). Every error is final:
/// later reads fail too. As an [`io::Read`], a damaged object is an error of kind
/// [`io::ErrorKind::InvalidData`] holding the [`StoreError`].
pub struct ObjectReader<R> {
    source: R,
    path: PathBuf,
    record: Record,
    /// Payload bytes not read from the source yet.
    unread: u64,
    /// Object bytes handed out.
    produced: u64,
    hasher: ObjectHasher,
    frame: Option<Frame>,
    /// A tree's or commit's bytes, parsed at the end.
    kept: Option<Vec<u8>>,
    parsed: Option<Parsed>,
    state: State,
}

impl<R> ObjectReader<R> {
    /// The record the object is read from.
    pub fn record(&self) -> &Record {
        &self.record
    }

    pub fn kind(&self) -> ObjectKind {
        self.record.kind
    }

    pub fn id(&self) -> ObjectId {
        self.record.id
    }

    /// The object's length in bytes, before any of it is read.
    pub fn raw_length(&self) -> u64 {
        self.record.raw_length
    }

    /// Whether the whole object has been read and checked.
    pub fn is_verified(&self) -> bool {
        self.state == State::Verified
    }
}

impl<R: Read> ObjectReader<R> {
    /// A reader of `record`'s object from `source`, which is at the record's payload. Checks first
    /// what needs no payload: a tree's or commit's raw length (step 8) and an uncompressed
    /// payload's length (step 9). An empty object is checked whole (steps 9–11) before it is
    /// handed out, as no read hands out its last byte.
    pub(super) fn new(source: R, path: PathBuf, record: Record) -> Result<Self, StoreError> {
        Self::with_decoder(source, path, record, None)
    }

    /// [`ObjectReader::new`], decoding a compressed payload with `spare`, an earlier record's
    /// decoder ([`ObjectReader::into_decoder`]), when there is one: its zstd context is reset and
    /// used again ([`FrameDecoder::restart`]).
    fn with_decoder(
        source: R,
        path: PathBuf,
        record: Record,
        spare: Option<FrameDecoder>,
    ) -> Result<Self, StoreError> {
        let whole = record.kind != ObjectKind::Blob;
        if whole && record.raw_length > MAX_OBJECT_SIZE {
            return Err(invalid_object(
                record.id,
                Problem::TooLarge {
                    limit: MAX_OBJECT_SIZE,
                },
            ));
        }
        if !record.compressed && record.stored_length != record.raw_length {
            return Err(invalid_object(record.id, PackProblem::RawLength.into()));
        }
        let frame = record.compressed.then(|| Frame {
            decoder: match spare {
                Some(decoder) => decoder.restart(record.raw_length, record.stored_length),
                None => FrameDecoder::new(record.raw_length, record.stored_length),
            },
            input: vec![0; buffer_len(record.stored_length)],
            start: 0,
            end: 0,
        });
        // Room for the whole tree or commit at once, at most 64 MiB (checked above): a list grown
        // by doubling would hold its last two sizes while it moves, half as much again. A frame
        // that promises more than it holds costs that room until it is refused.
        let kept =
            whole.then(|| Vec::with_capacity(usize::try_from(record.raw_length).unwrap_or(0)));
        let mut reader = Self {
            source,
            path,
            record,
            unread: record.stored_length,
            produced: 0,
            hasher: ObjectHasher::new(record.kind),
            frame,
            kept,
            parsed: None,
            state: State::Reading,
        };
        if record.raw_length == 0 {
            reader.conclude()?;
            reader.state = State::Verified;
        }
        Ok(reader)
    }

    /// Reads the object's next bytes into `buffer`, as [`Read::read`] does, with the store's
    /// errors. The read that hands out the last byte checks the whole object first; returns 0
    /// once the object is read and checked, or when `buffer` is empty.
    pub fn read_checked(&mut self, buffer: &mut [u8]) -> Result<usize, StoreError> {
        match self.state {
            State::Verified => return Ok(0),
            State::Failed => {
                let source = io::Error::other("an earlier read of this object failed");
                return Err(io_error(&self.path, source));
            }
            State::Reading if buffer.is_empty() => return Ok(0),
            State::Reading => {}
        }
        let result = match self.next(buffer) {
            Ok(0) => self.finish().map(|()| 0),
            Ok(read) => {
                self.hasher.update(&buffer[..read]);
                if let Some(kept) = &mut self.kept {
                    kept.extend_from_slice(&buffer[..read]);
                }
                self.produced += read as u64;
                if self.produced == self.record.raw_length {
                    self.conclude().map(|()| read)
                } else {
                    Ok(read)
                }
            }
            Err(error) => Err(error),
        };
        self.state = match &result {
            Err(_) => State::Failed,
            Ok(0) => State::Verified,
            Ok(_) if self.produced == self.record.raw_length => State::Verified,
            Ok(_) => State::Reading,
        };
        result
    }

    /// Reads the rest of the object, through `scratch`, which must not be empty.
    pub(super) fn drain(&mut self, scratch: &mut [u8]) -> Result<(), StoreError> {
        debug_assert!(!scratch.is_empty(), "a scratch buffer has room");
        while self.read_checked(scratch)? > 0 {}
        Ok(())
    }

    /// The decoder of a compressed payload, for the next record's ([`ObjectReader::with_decoder`]).
    fn into_decoder(self) -> Option<FrameDecoder> {
        self.frame.map(|frame| frame.decoder)
    }

    /// The next bytes of the object, or 0 when the payload gives no more.
    fn next(&mut self, buffer: &mut [u8]) -> Result<usize, StoreError> {
        let id = self.record.id;
        let Some(frame) = &mut self.frame else {
            let want = usize::try_from(self.unread).map_or(buffer.len(), |u| u.min(buffer.len()));
            if want == 0 {
                return Ok(0);
            }
            let read = read_payload(&mut self.source, &mut buffer[..want])
                .map_err(|source| io_error(&self.path, source))?;
            self.unread -= read as u64;
            return Ok(read);
        };
        loop {
            if frame.start == frame.end && self.unread > 0 {
                let room = frame.input.len();
                let want = usize::try_from(self.unread).map_or(room, |u| u.min(room));
                frame.end = read_payload(&mut self.source, &mut frame.input[..want])
                    .map_err(|source| io_error(&self.path, source))?;
                frame.start = 0;
                self.unread -= frame.end as u64;
            }
            let progress = frame
                .decoder
                .decode(&frame.input[frame.start..frame.end], buffer)
                .map_err(|problem| invalid_object(id, problem.into()))?;
            frame.start += progress.consumed;
            // A call that takes nothing has had every byte there is: the end, or a broken frame
            // that `finish` reports.
            if progress.produced > 0 || progress.consumed == 0 {
                return Ok(progress.produced);
            }
        }
    }

    /// The end of the object, once its last byte is out: the rest of the payload (a frame's end,
    /// its checksum), then [`ObjectReader::finish`]'s checks.
    fn conclude(&mut self) -> Result<(), StoreError> {
        // The frame decoder refuses any byte beyond the raw length, so nothing comes out here.
        let rest = self.next(&mut [0])?;
        debug_assert_eq!(rest, 0, "no byte after the raw length");
        self.finish()
    }

    /// The end of the payload: the frame is complete and decoded to exactly the raw length (an
    /// uncompressed payload has it), the bytes are the object `id` (step 10), and a tree or commit
    /// is canonical and meets its schema (step 11).
    fn finish(&mut self) -> Result<(), StoreError> {
        let id = self.record.id;
        if let Some(frame) = &self.frame {
            frame
                .decoder
                .finish()
                .map_err(|problem| invalid_object(id, problem.into()))?;
        }
        let found = self.hasher.finalize();
        if found != id {
            return Err(invalid_object(id, PackProblem::ObjectId { found }.into()));
        }
        let invalid = |problem| invalid_object(id, problem);
        match (self.record.kind, self.kept.take()) {
            (ObjectKind::Tree, Some(bytes)) => {
                self.parsed = Some(Parsed::Tree(Tree::parse(&bytes).map_err(invalid)?));
            }
            (ObjectKind::Commit, Some(bytes)) => {
                let commit = Commit::parse(&bytes).map_err(invalid)?;
                self.parsed = Some(Parsed::Commit(Box::new(commit)));
            }
            _ => {}
        }
        Ok(())
    }
}

impl<R: Read> Read for ObjectReader<R> {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        self.read_checked(buffer).map_err(|error| {
            let kind = match &error {
                StoreError::Io { source, .. } => source.kind(),
                _ => io::ErrorKind::InvalidData,
            };
            io::Error::new(kind, error)
        })
    }
}

impl<R> fmt::Debug for ObjectReader<R> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ObjectReader")
            .field("path", &self.path)
            .field("record", &self.record)
            .field("unread", &self.unread)
            .field("state", &self.state)
            .finish_non_exhaustive()
    }
}

/// Checks that `payload`, held in memory, is `record`'s object (§11 steps 8–11) as a reader checks
/// it, for [`PackWriter::add_stored`](super::PackWriter::add_stored).
pub(super) fn check_payload(record: Record, payload: &[u8]) -> Result<(), StoreError> {
    debug_assert_eq!(record.stored_length, payload.len() as u64);
    let mut object = ObjectReader::new(payload, PathBuf::new(), record)?;
    object.drain(&mut vec![0; buffer_len(record.raw_length)])
}

/// A buffer for `len` bytes, at most [`CHUNK`] and at least 1.
fn buffer_len(len: u64) -> usize {
    usize::try_from(len).map_or(CHUNK, |len| len.clamp(1, CHUNK))
}

/// Reads some of a record's payload into `buffer`, which is not empty: the source ending first is
/// an error, as the record's bounds were checked against the file's length.
fn read_payload(source: &mut impl Read, buffer: &mut [u8]) -> io::Result<usize> {
    loop {
        match source.read(buffer) {
            Ok(0) => {
                return Err(io::Error::new(
                    io::ErrorKind::UnexpectedEof,
                    "the pack ends inside a record",
                ));
            }
            Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
            result => return result,
        }
    }
}

fn invalid_object(id: ObjectId, problem: Problem) -> StoreError {
    StoreError::Invalid {
        what: Subject::Object(id),
        problem,
    }
}

fn u64_at(bytes: &[u8], at: usize) -> u64 {
    u64::from_le_bytes(bytes[at..at + 8].try_into().expect("8 bytes"))
}

fn id_at(bytes: &[u8], at: usize) -> ObjectId {
    ObjectId::from_bytes(bytes[at..at + ObjectId::LEN].try_into().expect("32 bytes"))
}

#[cfg(test)]
mod tests;
