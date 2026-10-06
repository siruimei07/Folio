//! Writing packs (remote-format.md §9.1–§9.2, §9.4–§9.5): records in the order they are added,
//! then the index and the trailer, with the pack's hash computed in the same pass.
//!
//! The writer never finishes a pack a reader would refuse: it computes the id of every object it
//! is given whole, checks a streamed blob against the id it is expected to have, and checks a
//! stored payload as the reader does before writing it. It has no clean-up in `Drop`: a writer
//! that is not finished leaves what it wrote, as a crash would, for its owner to discard.

use std::collections::BTreeMap;
use std::fmt;
use std::fs::File;
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

use super::read::{self, Record};
use super::{
    CHUNK, END_MAGIC, HEADER_LEN, INDEX_ENTRY_LEN, IndexEntry, MAGIC, PackIndex, PackName,
    PackProblem, TRAILER_LEN, VERSION,
};
use crate::store::id::{ObjectHasher, ObjectId, ObjectKind};
use crate::store::schema::{Encoded, MAX_OBJECT_SIZE};
use crate::store::values::Size;
use crate::store::zstd::Compressor;
use crate::store::{Limit, StoreError, Subject};
use crate::{crash, files};

/// The largest streamed blob the writer compresses (§9.5): it reads the blob into memory to
/// compress it, and streams larger ones raw. Compression choices are not part of the format.
pub const MAX_COMPRESSED_STREAM: u64 = 16 * 1024 * 1024;

/// Where a [`PackWriter`] writes a pack: bytes are appended, and the end can be cut back to an
/// earlier length when a streamed blob turns out not to be the expected one (§9.5).
pub trait PackSink {
    /// Appends `bytes`.
    fn write_all(&mut self, bytes: &[u8]) -> io::Result<()>;

    /// Cuts the pack back to its first `len` bytes, at most what was written; later bytes are
    /// appended after them.
    fn truncate(&mut self, len: u64) -> io::Result<()>;

    /// Makes every byte written durable. Called once, after the trailer.
    fn sync(&mut self) -> io::Result<()>;

    /// Where the pack is written, for error messages; empty for a pack in memory.
    fn path(&self) -> &Path;
}

/// A pack in memory: for tests and small packs. It never fails.
#[derive(Clone, Default)]
pub struct MemorySink {
    bytes: Vec<u8>,
}

impl fmt::Debug for MemorySink {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("MemorySink")
            .field("len", &self.bytes.len())
            .finish()
    }
}

impl MemorySink {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn bytes(&self) -> &[u8] {
        &self.bytes
    }

    pub fn into_bytes(self) -> Vec<u8> {
        self.bytes
    }
}

impl PackSink for MemorySink {
    fn write_all(&mut self, bytes: &[u8]) -> io::Result<()> {
        self.bytes.extend_from_slice(bytes);
        Ok(())
    }

    fn truncate(&mut self, len: u64) -> io::Result<()> {
        self.bytes
            .truncate(usize::try_from(len).unwrap_or(usize::MAX));
        Ok(())
    }

    fn sync(&mut self) -> io::Result<()> {
        Ok(())
    }

    fn path(&self) -> &Path {
        Path::new("")
    }
}

/// A pack in a new file: the file and its length, and up to 64 KiB not written yet. A streamed
/// blob that does not match is cut away within that buffer or, once written, with `set_len`.
/// Bytes still in the buffer when the sink is dropped are lost, as in a crash: only
/// [`PackSink::sync`] writes them.
///
/// In tests, each of its effects on the file can fail on purpose, as a full disk would make it
/// fail (`crate::crash`'s faults): writing the buffer out (`pack.flush`), a write past the buffer
/// (`pack.write`), a cut (`pack.truncate`), the flush to the disk (`pack.sync`). Its writes and
/// cuts are noted (`crash::note`: `write`, `cut`), so that a test sees the flush come after them.
pub struct FileSink {
    file: File,
    path: PathBuf,
    /// The bytes in the file; the buffer's follow them.
    file_len: u64,
    buffer: Vec<u8>,
}

impl fmt::Debug for FileSink {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("FileSink")
            .field("path", &self.path)
            .field("file_len", &self.file_len)
            .field("buffered", &self.buffer.len())
            .finish()
    }
}

impl FileSink {
    /// Creates the file `path`, which must not exist yet.
    pub fn create(path: impl Into<PathBuf>) -> Result<Self, StoreError> {
        let path = path.into();
        match File::create_new(&path) {
            Ok(file) => Ok(Self {
                file,
                path,
                file_len: 0,
                buffer: Vec::with_capacity(CHUNK),
            }),
            Err(source) => Err(StoreError::Io { path, source }),
        }
    }

    /// The file's path; the file is closed.
    pub fn into_path(self) -> PathBuf {
        self.path
    }

    fn flush_buffer(&mut self) -> io::Result<()> {
        crash::fault("pack.flush").and_then(|()| self.file.write_all(&self.buffer))?;
        if !self.buffer.is_empty() {
            crash::note("write");
        }
        self.file_len += self.buffer.len() as u64;
        self.buffer.clear();
        Ok(())
    }
}

impl PackSink for FileSink {
    fn write_all(&mut self, bytes: &[u8]) -> io::Result<()> {
        if self.buffer.len() + bytes.len() <= CHUNK {
            self.buffer.extend_from_slice(bytes);
            return Ok(());
        }
        self.flush_buffer()?;
        if bytes.len() < CHUNK {
            self.buffer.extend_from_slice(bytes);
        } else {
            crash::fault("pack.write").and_then(|()| self.file.write_all(bytes))?;
            crash::note("write");
            self.file_len += bytes.len() as u64;
        }
        Ok(())
    }

    fn truncate(&mut self, len: u64) -> io::Result<()> {
        debug_assert!(
            len <= self.file_len + self.buffer.len() as u64,
            "a sink is only cut back"
        );
        if let Some(kept) = len.checked_sub(self.file_len) {
            self.buffer
                .truncate(usize::try_from(kept).unwrap_or(usize::MAX));
            return Ok(());
        }
        self.buffer.clear();
        crash::fault("pack.truncate")
            .and_then(|()| self.file.set_len(len))
            .and_then(|()| self.file.seek(SeekFrom::Start(len)))?;
        crash::note("cut");
        self.file_len = len;
        Ok(())
    }

    fn sync(&mut self) -> io::Result<()> {
        self.flush_buffer()?;
        crash::fault("pack.sync").and_then(|()| files::sync_all(&self.file))
    }

    fn path(&self) -> &Path {
        &self.path
    }
}

/// Where an object added to a pack is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Added {
    /// Written as a new record at `offset`; its payload is a zstd frame when `compressed`.
    Written { offset: u64, compressed: bool },
    /// Already in this pack, at `offset`, and not written again: an id occurs once in a pack
    /// (§9.2).
    Duplicate { offset: u64 },
}

impl Added {
    /// The offset of the object's record.
    pub fn offset(self) -> u64 {
        match self {
            Self::Written { offset, .. } | Self::Duplicate { offset } => offset,
        }
    }
}

/// What became of a blob streamed into a pack. In every case but `Added` the pack is as if the
/// blob had never been offered (§9.5), and the writer goes on. `A` says where an added blob went:
/// [`Added`] in one pack, [`InSet`](crate::store::InSet) in a [`PackSet`](crate::store::PackSet).
#[derive(Debug)]
pub enum Streamed<A = Added> {
    Added(A),
    /// The bytes read are not the expected blob: the file changed after it was hashed. `found` is
    /// the hash of the `length` bytes read, which stop at the expected size.
    Mismatch {
        found: ObjectId,
        length: u64,
    },
    /// Reading the source failed.
    Unreadable(io::Error),
}

impl<A> Streamed<A> {
    /// The same outcome, with `f` applied to where an added blob went.
    pub fn map<B>(self, f: impl FnOnce(A) -> B) -> Streamed<B> {
        match self {
            Self::Added(added) => Streamed::Added(f(added)),
            Self::Mismatch { found, length } => Streamed::Mismatch { found, length },
            Self::Unreadable(error) => Streamed::Unreadable(error),
        }
    }
}

/// Writes one pack to a [`PackSink`] (remote-format.md §9): the header when created, each record
/// as its object is added, and the index and trailer when finished.
///
/// After an error from the sink the pack's bytes are unknown: every later call fails, and the
/// owner discards what was written. Other errors (a stored payload that is not its object) leave
/// the pack as it was.
pub struct PackWriter<S: PackSink> {
    sink: S,
    /// The BLAKE3 hash of every byte written so far: the trailer's hash once the pack is
    /// complete (§9.4).
    hash: blake3::Hasher,
    written: u64,
    /// Each object's record offset, in id order: the index.
    index: BTreeMap<ObjectId, u64>,
    /// Made when the first object is compressed.
    compressor: Option<Compressor>,
    /// The sink failed.
    failed: bool,
}

impl<S: PackSink> PackWriter<S> {
    /// Starts a pack in `sink`, which must be empty, by writing its header.
    pub fn new(sink: S) -> Result<Self, StoreError> {
        let mut writer = Self {
            sink,
            hash: blake3::Hasher::new(),
            written: 0,
            index: BTreeMap::new(),
            compressor: None,
            failed: false,
        };
        writer.write(&MAGIC)?;
        writer.write(&VERSION.to_le_bytes())?;
        debug_assert_eq!(writer.written, HEADER_LEN);
        Ok(writer)
    }

    pub fn sink(&self) -> &S {
        &self.sink
    }

    /// Whether the pack holds `id` already.
    pub fn contains(&self, id: ObjectId) -> bool {
        self.index.contains_key(&id)
    }

    pub fn object_count(&self) -> usize {
        self.index.len()
    }

    /// The pack's length if it were finished now: header, records, their index and the trailer.
    pub fn size(&self) -> u64 {
        self.written + INDEX_ENTRY_LEN * self.index.len() as u64 + TRAILER_LEN
    }

    /// Adds a tree or commit, compressed with zstd when `compress` is set and that makes it
    /// smaller (§9.5).
    pub fn add_object(&mut self, object: &Encoded, compress: bool) -> Result<Added, StoreError> {
        self.add(object.kind(), object.id(), object.bytes(), compress)
    }

    /// Adds a blob held in memory, its id computed from `bytes`; compressed as
    /// [`PackWriter::add_object`] says.
    pub fn add_blob(&mut self, bytes: &[u8], compress: bool) -> Result<Added, StoreError> {
        self.add(
            ObjectKind::Blob,
            ObjectId::of(ObjectKind::Blob, bytes),
            bytes,
            compress,
        )
    }

    /// Adds the blob `id` of `size` bytes read from `source`, which is read for exactly `size`
    /// bytes (§9.5): the size from the file, the id from the hash the catalog holds.
    ///
    /// With `compress` set, a blob of at most [`MAX_COMPRESSED_STREAM`] bytes is read into memory,
    /// checked, and compressed if that makes it smaller. Otherwise its record is written as the
    /// bytes stream by; if they do not match `id`, or reading fails, the pack is cut back to the
    /// record's start and its hash restored to that point.
    pub fn add_blob_from(
        &mut self,
        id: ObjectId,
        size: Size,
        mut source: impl Read,
        compress: bool,
    ) -> Result<Streamed, StoreError> {
        self.usable()?;
        if let Some(&offset) = self.index.get(&id) {
            return Ok(Streamed::Added(Added::Duplicate { offset }));
        }
        let size = size.get();
        if !compress || size > MAX_COMPRESSED_STREAM {
            return self.stream_raw(id, size, source);
        }
        let mut bytes = Vec::with_capacity(usize::try_from(size).unwrap_or(0));
        if let Err(error) = source.by_ref().take(size).read_to_end(&mut bytes) {
            return Ok(Streamed::Unreadable(error));
        }
        let found = ObjectId::of(ObjectKind::Blob, &bytes);
        if found != id || bytes.len() as u64 != size {
            return Ok(Streamed::Mismatch {
                found,
                length: bytes.len() as u64,
            });
        }
        self.add(ObjectKind::Blob, id, &bytes, true)
            .map(Streamed::Added)
    }

    /// Adds an object as it is stored elsewhere: its raw bytes, or its zstd frame when
    /// `compressed` (the pack vectors' frames, M3's copies of records). The payload is checked as
    /// a reader checks a record (§11 steps 8–11) before it is written; a payload that is not the
    /// object `id` is refused as invalid, a tree or commit over 64 MiB as too large, and the pack
    /// stays as it was.
    pub fn add_stored(
        &mut self,
        kind: ObjectKind,
        id: ObjectId,
        raw_length: Size,
        payload: &[u8],
        compressed: bool,
    ) -> Result<Added, StoreError> {
        self.usable()?;
        if let Some(&offset) = self.index.get(&id) {
            return Ok(Added::Duplicate { offset });
        }
        let raw_length = raw_length.get();
        // A reader would call this record invalid (step 8); a writer is asked for too much.
        if kind != ObjectKind::Blob && raw_length > MAX_OBJECT_SIZE {
            return Err(StoreError::TooLarge {
                what: Subject::Object(id),
                limit: Limit::Bytes(MAX_OBJECT_SIZE),
            });
        }
        let record = self.next_record(kind, id, raw_length, payload.len() as u64, compressed);
        read::check_payload(record, payload)?;
        self.write_record(record, payload)
    }

    /// Writes the index and the trailer, and makes the pack durable. A pack holds an object at
    /// least, so an empty one is refused.
    pub fn finish(mut self) -> Result<(PackIndex, S), StoreError> {
        self.usable()?;
        if self.index.is_empty() {
            return Err(StoreError::Invalid {
                what: Subject::NewPack,
                problem: PackProblem::Empty.into(),
            });
        }
        let entries: Vec<IndexEntry> = self
            .index
            .iter()
            .map(|(&id, &offset)| IndexEntry { id, offset })
            .collect();
        let mut index = Vec::with_capacity(entries.len() * INDEX_ENTRY_LEN as usize);
        for entry in &entries {
            index.extend_from_slice(entry.id.as_bytes());
            index.extend_from_slice(&entry.offset.to_le_bytes());
        }
        self.write(&index)?;
        self.write(&(entries.len() as u64).to_le_bytes())?;
        self.write(&END_MAGIC)?;
        // The hash covers everything before it, and is not part of what it covers.
        let hash = *self.hash.finalize().as_bytes();
        let result = self.sink.write_all(&hash).and_then(|()| self.sink.sync());
        if let Err(source) = result {
            return Err(self.io_error(source));
        }
        let size = self.written + hash.len() as u64;
        let index = PackIndex::new(PackName::from_bytes(hash), size, entries);
        Ok((index, self.sink))
    }

    fn add(
        &mut self,
        kind: ObjectKind,
        id: ObjectId,
        raw: &[u8],
        compress: bool,
    ) -> Result<Added, StoreError> {
        self.usable()?;
        if let Some(&offset) = self.index.get(&id) {
            return Ok(Added::Duplicate { offset });
        }
        let frame = if compress {
            self.compressor
                .get_or_insert_with(Compressor::new)
                .compress(raw)
        } else {
            None
        };
        let (payload, compressed) = match &frame {
            Some(frame) => (&frame[..], true),
            None => (raw, false),
        };
        let record = self.next_record(kind, id, raw.len() as u64, payload.len() as u64, compressed);
        self.write_record(record, payload)
    }

    /// The record an object gets when it is written next.
    fn next_record(
        &self,
        kind: ObjectKind,
        id: ObjectId,
        raw_length: u64,
        stored_length: u64,
        compressed: bool,
    ) -> Record {
        Record {
            offset: self.written,
            kind,
            id,
            raw_length,
            stored_length,
            compressed,
        }
    }

    /// Writes `record`, which [`PackWriter::next_record`] gave, with its payload.
    fn write_record(&mut self, record: Record, payload: &[u8]) -> Result<Added, StoreError> {
        debug_assert_eq!(record.offset, self.written, "the record is the next one");
        debug_assert_eq!(record.stored_length, payload.len() as u64);
        self.write(&record.header())?;
        self.write(payload)?;
        self.index.insert(record.id, record.offset);
        Ok(Added::Written {
            offset: record.offset,
            compressed: record.compressed,
        })
    }

    /// Writes a blob's record raw as its bytes stream from `source`, hashing them on the way.
    fn stream_raw(
        &mut self,
        id: ObjectId,
        size: u64,
        mut source: impl Read,
    ) -> Result<Streamed, StoreError> {
        let offset = self.written;
        let checkpoint = self.hash.clone();
        let record = self.next_record(ObjectKind::Blob, id, size, size, false);
        self.write(&record.header())?;
        let mut blob = ObjectHasher::new(ObjectKind::Blob);
        let mut buffer = vec![0; usize::try_from(size).map_or(CHUNK, |size| size.min(CHUNK))];
        let mut left = size;
        while left > 0 {
            let want = usize::try_from(left).map_or(buffer.len(), |left| left.min(buffer.len()));
            let read = match source.read(&mut buffer[..want]) {
                Ok(0) => break,
                Ok(read) => read,
                Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
                Err(error) => {
                    self.roll_back(offset, checkpoint)?;
                    return Ok(Streamed::Unreadable(error));
                }
            };
            blob.update(&buffer[..read]);
            self.write(&buffer[..read])?;
            left -= read as u64;
        }
        let found = blob.finalize();
        if left > 0 || found != id {
            self.roll_back(offset, checkpoint)?;
            return Ok(Streamed::Mismatch {
                found,
                length: size - left,
            });
        }
        self.index.insert(id, offset);
        Ok(Streamed::Added(Added::Written {
            offset,
            compressed: false,
        }))
    }

    /// Cuts the pack back to `len` bytes and its hash to what it was there.
    fn roll_back(&mut self, len: u64, checkpoint: blake3::Hasher) -> Result<(), StoreError> {
        if let Err(source) = self.sink.truncate(len) {
            self.failed = true;
            return Err(self.io_error(source));
        }
        self.hash = checkpoint;
        self.written = len;
        Ok(())
    }

    fn write(&mut self, bytes: &[u8]) -> Result<(), StoreError> {
        if let Err(source) = self.sink.write_all(bytes) {
            self.failed = true;
            return Err(self.io_error(source));
        }
        self.hash.update(bytes);
        self.written += bytes.len() as u64;
        Ok(())
    }

    fn usable(&self) -> Result<(), StoreError> {
        if self.failed {
            let source = io::Error::other("an earlier write to this pack failed");
            return Err(self.io_error(source));
        }
        Ok(())
    }

    fn io_error(&self, source: io::Error) -> StoreError {
        StoreError::Io {
            path: self.sink.path().to_path_buf(),
            source,
        }
    }
}

impl<S: PackSink> fmt::Debug for PackWriter<S> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("PackWriter")
            .field("path", &self.sink.path())
            .field("written", &self.written)
            .field("objects", &self.index.len())
            .field("failed", &self.failed)
            .finish_non_exhaustive()
    }
}

#[cfg(test)]
mod tests;
