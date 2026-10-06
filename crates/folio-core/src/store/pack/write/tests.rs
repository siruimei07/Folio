use proptest::prelude::*;

use super::*;
use crate::store::pack::MIN_PACK_LEN;
use crate::store::strategies::{self, commit_of, noise, text, tree_of};
use crate::store::zstd;
use crate::store::{Commit, JsonError, Problem, Tree, ZstdProblem};

const BLOB: ObjectKind = ObjectKind::Blob;

fn u64_at(bytes: &[u8], at: usize) -> u64 {
    u64::from_le_bytes(bytes[at..at + 8].try_into().unwrap())
}

fn id_at(bytes: &[u8], at: usize) -> ObjectId {
    ObjectId::from_bytes(bytes[at..at + 32].try_into().unwrap())
}

/// A record as [`read_back`] finds it.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Record {
    kind: ObjectKind,
    id: ObjectId,
    offset: u64,
    compressed: bool,
    /// The object: the payload, decoded if it is a zstd frame.
    raw: Vec<u8>,
}

/// Reads a pack as the layout of §9 says, independently of the writer: magic, version, records
/// back to back up to the index, the index in strictly ascending order with exactly one entry per
/// record at its offset, the entry count, the end magic, and the hash of everything before it.
/// Each record's bytes must have its id. Returns the pack's name and its records in order.
fn read_back(pack: &[u8]) -> (PackName, Vec<Record>) {
    let len = pack.len();
    assert!(len as u64 >= MIN_PACK_LEN, "{len} bytes");
    assert_eq!(&pack[..8], b"FOLIOPK1");
    assert_eq!(pack[8..12], 1_u32.to_le_bytes());
    let hash = blake3::hash(&pack[..len - 32]);
    assert_eq!(hash.as_bytes(), &pack[len - 32..], "the trailer's hash");
    assert_eq!(&pack[len - 40..len - 32], b"FOLIOEND");
    let count = usize::try_from(u64_at(pack, len - 48)).unwrap();
    assert!(count >= 1);
    let index_at = len - 48 - 40 * count;
    let index: Vec<(ObjectId, u64)> = (0..count)
        .map(|i| {
            (
                id_at(pack, index_at + 40 * i),
                u64_at(pack, index_at + 40 * i + 32),
            )
        })
        .collect();
    assert!(
        index.windows(2).all(|pair| pair[0].0 < pair[1].0),
        "index order"
    );
    let mut records = Vec::new();
    let mut at = 12;
    while at < index_at {
        let kind = ObjectKind::from_code(pack[at]).expect("a record type");
        let flags = pack[at + 1];
        assert!(flags <= 1, "flags {flags}");
        let id = id_at(pack, at + 2);
        let raw_length = u64_at(pack, at + 34);
        let stored = usize::try_from(u64_at(pack, at + 42)).unwrap();
        let payload = &pack[at + 50..at + 50 + stored];
        let raw = if flags == 1 {
            let mut raw = Vec::new();
            zstd::decode_slice(payload, raw_length, |bytes| raw.extend_from_slice(bytes))
                .expect("a frame of §9.3");
            raw
        } else {
            assert_eq!(stored as u64, raw_length);
            payload.to_vec()
        };
        assert_eq!(ObjectId::of(kind, &raw), id, "the record at {at}");
        records.push(Record {
            kind,
            id,
            offset: at as u64,
            compressed: flags == 1,
            raw,
        });
        at += 50 + stored;
    }
    assert_eq!(at, index_at, "records end where the index begins");
    let mut listed: Vec<(ObjectId, u64)> = records.iter().map(|r| (r.id, r.offset)).collect();
    listed.sort_unstable();
    assert_eq!(listed, index, "one index entry per record, at its offset");
    (PackName::from_bytes(*hash.as_bytes()), records)
}

fn writer() -> PackWriter<MemorySink> {
    PackWriter::new(MemorySink::new()).unwrap()
}

fn finished(writer: PackWriter<MemorySink>) -> (PackIndex, Vec<u8>) {
    let (index, sink) = writer.finish().unwrap();
    (index, sink.into_bytes())
}

fn blob_id(bytes: &[u8]) -> ObjectId {
    ObjectId::of(BLOB, bytes)
}

fn size(bytes: &[u8]) -> Size {
    Size::new(bytes.len() as u64).unwrap()
}

#[test]
fn the_smallest_pack_is_one_empty_blob() {
    let mut pack = writer();
    assert_eq!(
        pack.add_blob(b"", false).unwrap(),
        Added::Written {
            offset: 12,
            compressed: false
        }
    );
    assert_eq!(pack.size(), MIN_PACK_LEN);
    let (index, bytes) = finished(pack);
    let empty = blob_id(b"");
    let mut expected = b"FOLIOPK1".to_vec();
    expected.extend_from_slice(&1_u32.to_le_bytes());
    expected.extend_from_slice(&[1, 0]);
    expected.extend_from_slice(empty.as_bytes());
    expected.extend_from_slice(&[0; 16]);
    expected.extend_from_slice(empty.as_bytes());
    expected.extend_from_slice(&12_u64.to_le_bytes());
    expected.extend_from_slice(&1_u64.to_le_bytes());
    expected.extend_from_slice(b"FOLIOEND");
    let hash = blake3::hash(&expected);
    expected.extend_from_slice(hash.as_bytes());
    assert_eq!(bytes, expected);
    assert_eq!(index.name(), PackName::from_bytes(*hash.as_bytes()));
    assert_eq!(index.size(), MIN_PACK_LEN);
    assert_eq!(
        index.entries(),
        [IndexEntry {
            id: empty,
            offset: 12
        }]
    );
}

#[test]
fn records_keep_their_order_and_the_index_sorts_by_id() {
    let hello = b"hello\n".as_slice();
    let tree = tree_of(hello, 1);
    let commit = commit_of(tree.id());
    let mut pack = writer();
    let added = [
        pack.add_blob(hello, false).unwrap(),
        pack.add_object(&tree, false).unwrap(),
        pack.add_object(&commit, false).unwrap(),
        pack.add_blob(b"bye\n", false).unwrap(),
    ];
    assert!(pack.contains(tree.id()) && !pack.contains(blob_id(b"other")));
    assert_eq!(pack.object_count(), 4);
    let size = pack.size();
    let (index, bytes) = finished(pack);
    assert_eq!(bytes.len() as u64, size);
    assert_eq!(index.size(), size);
    let (name, records) = read_back(&bytes);
    assert_eq!(index.name(), name);
    let kinds: Vec<ObjectKind> = records.iter().map(|record| record.kind).collect();
    assert_eq!(kinds, [BLOB, ObjectKind::Tree, ObjectKind::Commit, BLOB]);
    for (record, added) in records.iter().zip(added) {
        assert_eq!(added.offset(), record.offset);
        assert_eq!(index.offset(record.id), Some(record.offset));
    }
    assert_eq!(records[1].raw, tree.bytes());
    assert_eq!(records[2].raw, commit.bytes());
}

#[test]
fn an_empty_pack_is_refused() {
    let error = writer().finish().unwrap_err();
    assert!(
        matches!(
            &error,
            StoreError::Invalid {
                what: Subject::NewPack,
                problem: Problem::Pack(PackProblem::Empty)
            }
        ),
        "{error:?}"
    );
}

#[test]
fn objects_are_written_once() {
    let hello = b"hello\n".as_slice();
    let mut once = writer();
    once.add_blob(hello, false).unwrap();
    once.add_blob(b"bye\n", false).unwrap();
    let mut again = writer();
    let first = again.add_blob(hello, false).unwrap();
    again.add_blob(b"bye\n", false).unwrap();
    let duplicate = Added::Duplicate { offset: 12 };
    assert_eq!(first.offset(), 12);
    assert_eq!(again.add_blob(hello, true).unwrap(), duplicate);
    assert_eq!(
        again
            .add_stored(BLOB, blob_id(hello), size(hello), hello, false)
            .unwrap(),
        duplicate
    );
    // A duplicate is not read: these bytes would not match.
    let streamed = again
        .add_blob_from(blob_id(hello), size(hello), &b"HELLO\n"[..], false)
        .unwrap();
    assert!(matches!(streamed, Streamed::Added(added) if added == duplicate));
    assert_eq!(finished(again).1, finished(once).1);
}

#[test]
fn an_empty_pack_cannot_hide_behind_duplicates() {
    // Only added objects count: an offer that did not match adds nothing.
    let mut pack = writer();
    let offered = pack
        .add_blob_from(blob_id(b"a"), Size::new(1).unwrap(), &b"b"[..], false)
        .unwrap();
    assert!(matches!(offered, Streamed::Mismatch { .. }));
    assert_eq!(pack.object_count(), 0);
    assert!(pack.finish().is_err());
}

#[test]
fn objects_are_compressed_when_asked_and_smaller() {
    let lecture = text(20_000);
    let random = noise(20_000);
    let tree = tree_of(b"hello\n", 300);
    let commit = commit_of(tree.id());
    let mut pack = writer();
    let compressed = |added: Added| match added {
        Added::Written { compressed, .. } => compressed,
        Added::Duplicate { .. } => panic!("a duplicate"),
    };
    assert!(compressed(pack.add_blob(&lecture, true).unwrap()));
    assert!(!compressed(pack.add_blob(&random, true).unwrap()));
    assert!(!compressed(pack.add_blob(&text(30_000), false).unwrap()));
    assert!(compressed(pack.add_object(&tree, true).unwrap()));
    // Four bytes cannot shrink: a frame takes more.
    assert!(!compressed(pack.add_blob(b"tiny", true).unwrap()));
    let shrinks = Compressor::new().compress(commit.bytes()).is_some();
    assert_eq!(compressed(pack.add_object(&commit, true).unwrap()), shrinks);
    let streamed = pack
        .add_blob_from(
            blob_id(&text(9_000)),
            Size::new(9_000).unwrap(),
            &text(9_000)[..],
            true,
        )
        .unwrap();
    assert!(matches!(
        streamed,
        Streamed::Added(Added::Written {
            compressed: true,
            ..
        })
    ));
    let (_, bytes) = finished(pack);
    let (_, records) = read_back(&bytes);
    let flags: Vec<bool> = records.iter().map(|record| record.compressed).collect();
    assert_eq!(flags, [true, false, false, true, false, shrinks, true]);
    assert_eq!(records[0].raw, lecture);
    assert_eq!(records[3].raw, tree.bytes());
    assert_eq!(records[5].raw, commit.bytes());
}

/// A source that yields `bytes`, then fails.
struct FailsAfter<'a> {
    bytes: &'a [u8],
}

impl Read for FailsAfter<'_> {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        if self.bytes.is_empty() {
            return Err(io::Error::other("the disk is gone"));
        }
        let read = self.bytes.len().min(buffer.len());
        buffer[..read].copy_from_slice(&self.bytes[..read]);
        self.bytes = &self.bytes[read..];
        Ok(read)
    }
}

/// A source that is interrupted before every read.
struct Interrupted<'a> {
    bytes: &'a [u8],
    interrupt: bool,
}

impl Read for Interrupted<'_> {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        self.interrupt = !self.interrupt;
        if self.interrupt {
            return Err(io::ErrorKind::Interrupted.into());
        }
        self.bytes.read(buffer)
    }
}

/// How an offered blob's source goes wrong.
#[derive(Debug, Clone, Copy)]
enum Fault {
    OtherBytes,
    /// The source ends a byte before the blob does.
    Short,
    /// The source yields the blob whole, and the size the caller states is a byte more: the file
    /// was larger when its size was read, and back to the content its hash names when it was read.
    /// A blob's id does not bind its length, so only the length tells.
    EndsEarly,
    Fails,
}

/// Offers the blob `expected` with a source that goes wrong as `fault` says.
fn offer<S: PackSink>(pack: &mut PackWriter<S>, expected: &[u8], fault: Fault, compress: bool) {
    let mut other = expected.to_vec();
    let last = other.len() - 1;
    other[last] ^= 1;
    let (id, len) = (blob_id(expected), size(expected));
    let outcome = match fault {
        Fault::OtherBytes => pack.add_blob_from(id, len, &other[..], compress),
        Fault::Short => pack.add_blob_from(id, len, &expected[..last], compress),
        Fault::EndsEarly => {
            let stated = Size::new(len.get() + 1).unwrap();
            pack.add_blob_from(id, stated, expected, compress)
        }
        Fault::Fails => pack.add_blob_from(
            id,
            len,
            FailsAfter {
                bytes: &expected[..last],
            },
            compress,
        ),
    };
    match (fault, outcome.unwrap()) {
        (Fault::OtherBytes, Streamed::Mismatch { found, length }) => {
            assert_eq!((found, length), (blob_id(&other), len.get()));
        }
        (Fault::Short, Streamed::Mismatch { found, length }) => {
            assert_eq!((found, length), (blob_id(&expected[..last]), last as u64));
        }
        // The bytes read are the blob: refused for their length alone.
        (Fault::EndsEarly, Streamed::Mismatch { found, length }) => {
            assert_eq!((found, length), (id, len.get()));
        }
        (Fault::Fails, Streamed::Unreadable(error)) => {
            assert_eq!(error.to_string(), "the disk is gone");
        }
        (fault, outcome) => panic!("{fault:?} gave {outcome:?}"),
    }
}

/// Writes a pack with a blob before and after the offer, through `sink`.
fn pack_around<S: PackSink>(sink: S, offered: Option<(&[u8], Fault, bool)>) -> (PackIndex, S) {
    let mut pack = PackWriter::new(sink).unwrap();
    pack.add_blob(&text(5_000), false).unwrap();
    if let Some((expected, fault, compress)) = offered {
        offer(&mut pack, expected, fault, compress);
    }
    pack.add_blob(&noise(3_000), true).unwrap();
    pack.finish().unwrap()
}

/// §9.5: a streamed blob whose bytes do not match is cut away, and the pack's hash goes back with
/// it, so the pack is exactly the one written without it; in memory and in a file, cut within the
/// file sink's buffer or past it as the pack's last cut, compressed in memory or streamed raw. A
/// source that ends before the stated size is refused also when the bytes it gave are the blob
/// (`Fault::EndsEarly`): a record written for it would promise a byte more than follows, and the
/// next record's first byte would become its last.
/// [`a_file_sink_cuts_where_its_file_ends_and_its_buffer_begins`] cuts after the buffer was
/// written out.
#[test]
fn a_streamed_blob_that_does_not_match_leaves_no_trace() {
    let (_, without) = pack_around(MemorySink::new(), None);
    let without = without.into_bytes();
    let folder = tempfile::tempdir().unwrap();
    let mut n = 0;
    for len in [100, 200 * 1024] {
        let expected = noise(len);
        for fault in [
            Fault::OtherBytes,
            Fault::Short,
            Fault::EndsEarly,
            Fault::Fails,
        ] {
            for compress in [false, true] {
                let case = format!("{len} bytes, {fault:?}, compress {compress}");
                let (index, sink) =
                    pack_around(MemorySink::new(), Some((&expected, fault, compress)));
                assert_eq!(sink.bytes(), without, "{case}");
                assert_eq!(index.size(), without.len() as u64, "{case}");
                n += 1;
                let path = folder.path().join(format!("pack-{n}.part"));
                let (_, sink) = pack_around(
                    FileSink::create(&path).unwrap(),
                    Some((&expected, fault, compress)),
                );
                assert_eq!(sink.into_path(), path);
                assert_eq!(std::fs::read(&path).unwrap(), without, "{case}, in a file");
            }
        }
    }
}

/// What a pack in [`a_file_sink_cuts_where_its_file_ends_and_its_buffer_begins`] holds, in order.
#[derive(Debug, Clone, Copy)]
enum Piece {
    /// A blob of so many bytes, written raw.
    Blob(usize),
    /// A blob of so many bytes, streamed raw from a source whose bytes are other ones.
    Mismatch(usize),
}

/// Writes `pieces` into a pack in `sink`, each blob whole or streamed, and the mismatching streams
/// only when `mismatches` is set; returns the sink of the finished pack.
fn write_pieces<S: PackSink>(sink: S, pieces: &[Piece], streamed: bool, mismatches: bool) -> S {
    let mut pack = PackWriter::new(sink).unwrap();
    for piece in pieces {
        match *piece {
            Piece::Blob(len) if streamed => {
                let blob = noise(len);
                let added = pack.add_blob_from(blob_id(&blob), size(&blob), &blob[..], false);
                assert!(matches!(added.unwrap(), Streamed::Added(_)), "{piece:?}");
            }
            Piece::Blob(len) => {
                pack.add_blob(&noise(len), false).unwrap();
            }
            Piece::Mismatch(len) if mismatches => {
                offer(&mut pack, &noise(len), Fault::OtherBytes, false);
            }
            Piece::Mismatch(_) => {}
        }
    }
    pack.finish().unwrap().1
}

/// A file sink keeps apart the bytes in its file and those in its buffer, so that each cut of a
/// stream that does not match (§9.5) cuts the right one: after the buffer was written out, the
/// stream's record starting in bytes that went out with it, or in the buffer after it; a cut past
/// the buffer followed by a blob in the buffer and a cut within it, or by another cut past it.
/// Its file is then exactly the pack written without those streams. (A wrong length cuts nothing,
/// or cuts the buffer and fills the file with zeros.)
#[test]
fn a_file_sink_cuts_where_its_file_ends_and_its_buffer_begins() {
    use Piece::{Blob, Mismatch};
    let folder = tempfile::tempdir().unwrap();
    let cases: [&[Piece]; 4] = [
        &[Blob(40_000), Mismatch(30_000)],
        &[Blob(60_000), Blob(10_000), Mismatch(100)],
        &[
            Blob(5_000),
            Mismatch(200 * 1024),
            Blob(1_000),
            Mismatch(100),
        ],
        &[
            Blob(5_000),
            Mismatch(200 * 1024),
            Blob(50_000),
            Mismatch(30_000),
        ],
    ];
    for (n, pieces) in cases.into_iter().enumerate() {
        let without = write_pieces(MemorySink::new(), pieces, false, false).into_bytes();
        for streamed in [false, true] {
            let path = folder.path().join(format!("pack-{n}-{streamed}.part"));
            let sink = write_pieces(FileSink::create(&path).unwrap(), pieces, streamed, true);
            let written = std::fs::read(sink.into_path()).unwrap();
            assert!(
                written == without,
                "{pieces:?}, blobs streamed {streamed}: {} bytes, {} expected",
                written.len(),
                without.len()
            );
        }
    }
}

#[test]
fn streamed_blobs_are_read_for_their_size_only() {
    let hello = b"hello\n".as_slice();
    let longer = b"hello\nand more".as_slice();
    for compress in [false, true] {
        let mut pack = writer();
        let streamed = pack
            .add_blob_from(blob_id(hello), size(hello), longer, compress)
            .unwrap();
        assert!(matches!(streamed, Streamed::Added(_)), "{streamed:?}");
        let source = Interrupted {
            bytes: b"bye\n",
            interrupt: false,
        };
        let retried = pack
            .add_blob_from(blob_id(b"bye\n"), Size::new(4).unwrap(), source, compress)
            .unwrap();
        assert!(matches!(retried, Streamed::Added(_)), "{retried:?}");
        let (_, records) = read_back(&finished(pack).1);
        assert_eq!(records[0].raw, hello);
    }
}

/// §9.5: blobs are compressed in memory only up to 16 MiB; above it they stream raw.
#[test]
fn streamed_blobs_above_16_mib_are_stored_raw() {
    for (len, compressed) in [
        (MAX_COMPRESSED_STREAM, true),
        (MAX_COMPRESSED_STREAM + 1, false),
    ] {
        let zeros = vec![0; usize::try_from(len).unwrap()];
        let mut pack = writer();
        let streamed = pack
            .add_blob_from(blob_id(&zeros), size(&zeros), &zeros[..], true)
            .unwrap();
        let Streamed::Added(added) = streamed else {
            panic!("{len} bytes: {streamed:?}");
        };
        assert_eq!(
            added,
            Added::Written {
                offset: 12,
                compressed
            },
            "{len} bytes"
        );
    }
}

#[test]
fn stored_payloads_must_be_their_objects() {
    let hello = b"hello\n".as_slice();
    let id = blob_id(hello);
    let mut pack = writer();
    let refused = |result: Result<Added, StoreError>| match result {
        Err(StoreError::Invalid {
            what: Subject::Object(object),
            problem,
        }) if object == id => problem,
        other => panic!("{other:?}"),
    };
    assert_eq!(
        refused(pack.add_stored(BLOB, id, Size::new(7).unwrap(), hello, false)),
        Problem::Pack(PackProblem::RawLength)
    );
    assert_eq!(
        refused(pack.add_stored(BLOB, id, size(hello), b"hellO\n", false)),
        Problem::Pack(PackProblem::ObjectId {
            found: blob_id(b"hellO\n")
        })
    );
    // A frame with a dictionary (generate.mjs's hand-made frame of `hello\n`).
    let mut frame = vec![0x28, 0xb5, 0x2f, 0xfd, 0xc2, 0x58, 7, 0];
    frame.extend_from_slice(&6_u64.to_le_bytes());
    frame.extend_from_slice(&[0x31, 0, 0]);
    frame.extend_from_slice(hello);
    assert_eq!(
        refused(pack.add_stored(BLOB, id, size(hello), &frame, true)),
        Problem::Zstd(ZstdProblem::Dictionary { id: 7 })
    );
    // Without the dictionary the same frame is fine.
    frame[4] = 0xc0;
    frame.drain(6..8);
    assert_eq!(
        pack.add_stored(BLOB, id, size(hello), &frame, true)
            .unwrap(),
        Added::Written {
            offset: 12,
            compressed: true
        }
    );
    // Trees and commits are parsed: canonical JSON under their schema.
    let spaced = br#"{"entries": []}"#;
    let spaced_id = ObjectId::of(ObjectKind::Tree, spaced);
    let error = pack
        .add_stored(ObjectKind::Tree, spaced_id, size(spaced), spaced, false)
        .unwrap_err();
    assert!(
        matches!(
            &error,
            StoreError::Invalid {
                what: Subject::Object(object),
                problem: Problem::Json(JsonError::NotCanonical { .. })
            } if *object == spaced_id
        ),
        "{error:?}"
    );
    let commit = commit_of(spaced_id);
    let as_tree = ObjectId::of(ObjectKind::Tree, commit.bytes());
    assert!(matches!(
        pack.add_stored(
            ObjectKind::Tree,
            as_tree,
            size(commit.bytes()),
            commit.bytes(),
            false
        ),
        Err(StoreError::Invalid {
            problem: Problem::Schema(_),
            ..
        })
    ));
    assert_eq!(
        pack.add_stored(
            ObjectKind::Commit,
            commit.id(),
            size(commit.bytes()),
            commit.bytes(),
            false
        )
        .unwrap()
        .offset(),
        12 + 50 + frame.len() as u64
    );
    // A tree or commit over 64 MiB is refused before its payload is looked at.
    let error = pack
        .add_stored(
            ObjectKind::Tree,
            spaced_id,
            Size::new(MAX_OBJECT_SIZE + 1).unwrap(),
            &frame,
            true,
        )
        .unwrap_err();
    assert!(
        matches!(
            error,
            StoreError::TooLarge {
                what: Subject::Object(_),
                limit: Limit::Bytes(MAX_OBJECT_SIZE)
            }
        ),
        "{error:?}"
    );
    // What was refused left no trace.
    let (_, records) = read_back(&finished(pack).1);
    let ids: Vec<ObjectId> = records.iter().map(|record| record.id).collect();
    assert_eq!(ids, [id, commit.id()]);
}

/// A sink that fails after `writes` writes, or when cut back, or when flushed.
#[derive(Debug)]
struct Failing {
    inner: MemorySink,
    writes: usize,
    truncate_fails: bool,
    sync_fails: bool,
}

impl PackSink for Failing {
    fn write_all(&mut self, bytes: &[u8]) -> io::Result<()> {
        if self.writes == 0 {
            return Err(io::Error::other("the disk is full"));
        }
        self.writes -= 1;
        self.inner.write_all(bytes)
    }

    fn truncate(&mut self, len: u64) -> io::Result<()> {
        if self.truncate_fails {
            return Err(io::Error::other("cannot cut"));
        }
        self.inner.truncate(len)
    }

    fn sync(&mut self) -> io::Result<()> {
        if self.sync_fails {
            return Err(io::Error::other("cannot flush"));
        }
        self.inner.sync()
    }

    fn path(&self) -> &Path {
        Path::new("staging/pack-0123456789abcdef.part")
    }
}

fn failing(writes: usize, truncate_fails: bool) -> Failing {
    Failing {
        inner: MemorySink::new(),
        writes,
        truncate_fails,
        sync_fails: false,
    }
}

/// After the sink fails, the pack's bytes are unknown: every later call fails too.
#[test]
fn a_failing_sink_stops_the_writer() {
    let io_error = |error: StoreError| match error {
        StoreError::Io { path, source } => {
            assert_eq!(path, Path::new("staging/pack-0123456789abcdef.part"));
            source.to_string()
        }
        other => panic!("{other:?}"),
    };
    assert_eq!(
        io_error(PackWriter::new(failing(0, false)).unwrap_err()),
        "the disk is full"
    );
    // The header takes two writes and a record two more.
    let mut pack = PackWriter::new(failing(3, false)).unwrap();
    assert_eq!(
        io_error(pack.add_blob(b"hello\n", false).unwrap_err()),
        "the disk is full"
    );
    let later = "an earlier write to this pack failed";
    assert_eq!(io_error(pack.add_blob(b"bye\n", false).unwrap_err()), later);
    let streamed = pack.add_blob_from(blob_id(b"x"), Size::new(1).unwrap(), &b"x"[..], false);
    assert_eq!(io_error(streamed.unwrap_err()), later);
    assert_eq!(io_error(pack.finish().unwrap_err()), later);
    // A blob that does not match must be cut away; if that fails, so does the writer.
    let mut pack = PackWriter::new(failing(usize::MAX, true)).unwrap();
    let offered = pack.add_blob_from(blob_id(b"a"), Size::new(1).unwrap(), &b"b"[..], false);
    assert_eq!(io_error(offered.unwrap_err()), "cannot cut");
    assert_eq!(io_error(pack.add_blob(b"c", false).unwrap_err()), later);
    // Index, count and end magic are written; the hash is not.
    let mut pack = PackWriter::new(failing(7, false)).unwrap();
    pack.add_blob(b"hello\n", false).unwrap();
    assert_eq!(io_error(pack.finish().unwrap_err()), "the disk is full");
    // Everything is written but the flush fails: the pack may not be on the disk, so it is not
    // finished.
    let flush_fails = Failing {
        sync_fails: true,
        ..failing(usize::MAX, false)
    };
    let mut pack = PackWriter::new(flush_fails).unwrap();
    pack.add_blob(b"hello\n", false).unwrap();
    assert_eq!(io_error(pack.finish().unwrap_err()), "cannot flush");
}

/// A file sink writes the bytes it buffers when it is flushed, which for a pack under 64 KiB is
/// the only write its file gets: when that write fails, so does finishing the pack.
#[cfg(windows)]
#[test]
fn a_file_sink_whose_flush_fails_finishes_no_pack() {
    /// What Windows says to a write into a range another handle has locked.
    const ERROR_LOCK_VIOLATION: i32 = 33;
    let folder = tempfile::tempdir().unwrap();
    let path = folder.path().join("pack-2.part");
    let mut pack = PackWriter::new(FileSink::create(&path).unwrap()).unwrap();
    pack.add_blob(&text(2_000), false).unwrap();
    // Another handle locks the whole file.
    let other = std::fs::File::open(&path).unwrap();
    other.lock().unwrap();
    match pack.finish() {
        Err(StoreError::Io { path: at, source }) => {
            assert_eq!(at, path);
            assert_eq!(
                source.raw_os_error(),
                Some(ERROR_LOCK_VIOLATION),
                "{source}"
            );
        }
        other => panic!("{other:?}"),
    }
    drop(other);
    assert_eq!(std::fs::metadata(&path).unwrap().len(), 0);
}

/// Each effect of a file sink on its file can fail, as on a full disk (the failures are injected):
/// writing its buffer out before a write past it or in the flush, the write past it, the cut of a
/// streamed blob that does not match, the flush to the disk. Each stops the writer with an I/O
/// error naming the file, and no pack is finished.
#[test]
fn a_file_sink_whose_writes_cut_or_flush_fail_finishes_no_pack() {
    let folder = tempfile::tempdir().unwrap();
    let large = noise(200 * 1024);
    let mut other = large.clone();
    other[100_000] ^= 1;
    let failed = |error: StoreError, path: &Path| match error {
        StoreError::Io { path: at, source } if at == path => source.to_string(),
        other => panic!("{other:?}"),
    };
    let later = "an earlier write to this pack failed";
    for (n, step) in ["pack.flush", "pack.write", "pack.truncate", "pack.sync"]
        .into_iter()
        .enumerate()
    {
        let path = folder.path().join(format!("pack-{n}.part"));
        let mut pack = PackWriter::new(FileSink::create(&path).unwrap()).unwrap();
        pack.add_blob(&text(2_000), true).unwrap();
        let error = crash::fail_at(step, || match step {
            "pack.truncate" => pack
                .add_blob_from(blob_id(&large), size(&large), &other[..], false)
                .map(drop),
            "pack.sync" => {
                pack.add_blob(&large, false)?;
                pack.finish().map(drop)
            }
            _ => pack.add_blob(&large, false).map(drop),
        })
        .unwrap_err();
        assert_eq!(
            failed(error, &path),
            format!("a fault injected at {step}"),
            "{step}"
        );
    }
    // The flush also writes the buffer out: a small pack's only write.
    let path = folder.path().join("pack-small.part");
    let mut pack = PackWriter::new(FileSink::create(&path).unwrap()).unwrap();
    pack.add_blob(&text(2_000), true).unwrap();
    let error = crash::fail_at("pack.flush", || pack.finish()).unwrap_err();
    assert_eq!(failed(error, &path), "a fault injected at pack.flush");
    // A writer whose write past the buffer failed refuses to go on.
    let path = folder.path().join("pack-after.part");
    let mut pack = PackWriter::new(FileSink::create(&path).unwrap()).unwrap();
    crash::fail_at("pack.write", || pack.add_blob(&large, false)).unwrap_err();
    assert_eq!(
        failed(pack.add_blob(b"c", false).unwrap_err(), &path),
        later
    );
    assert_eq!(failed(pack.finish().unwrap_err(), &path), later);
}

#[test]
fn a_file_sink_writes_a_new_file() {
    let folder = tempfile::tempdir().unwrap();
    let path = folder.path().join("pack-1.part");
    let objects = [text(1_000), noise(100 * 1024), text(300 * 1024), noise(10)];
    let mut in_memory = writer();
    let mut in_file = PackWriter::new(FileSink::create(&path).unwrap()).unwrap();
    for (i, bytes) in objects.iter().enumerate() {
        let compress = i % 2 == 0;
        assert_eq!(
            in_file.add_blob(bytes, compress).unwrap(),
            in_memory.add_blob(bytes, compress).unwrap()
        );
    }
    assert_eq!(in_file.sink().path(), path);
    let (file_index, sink) = in_file.finish().unwrap();
    let (memory_index, bytes) = finished(in_memory);
    assert_eq!(file_index, memory_index);
    assert_eq!(std::fs::read(sink.into_path()).unwrap(), bytes);
    // A file sink never writes over a file that exists.
    let StoreError::Io { path: at, source } = FileSink::create(&path).unwrap_err() else {
        panic!("not an I/O error");
    };
    assert_eq!((at, source.kind()), (path, io::ErrorKind::AlreadyExists));
}

/// How a random pack's step adds its object; each way may compress.
#[derive(Debug, Clone, Copy)]
enum Way {
    /// The object in memory: [`PackWriter::add_blob`] or [`PackWriter::add_object`].
    Memory(bool),
    /// Its payload as stored elsewhere: a zstd frame if compressing makes it smaller.
    Stored(bool),
    /// A blob streamed from a source.
    Streamed(bool),
}

/// One step of a random pack.
#[derive(Debug, Clone)]
enum Step {
    Blob(Vec<u8>, Way),
    Tree(Tree, Way),
    Commit(Box<Commit>, Way),
    /// A streamed blob whose source goes wrong.
    Offer(Vec<u8>, Fault, bool),
    /// The object of an earlier step again.
    Again(prop::sample::Index, Way),
}

fn bytes() -> impl Strategy<Value = Vec<u8>> {
    prop_oneof![
        4 => prop::collection::vec(any::<u8>(), 1..300),
        2 => (1..3000_usize).prop_map(text),
        1 => (60_000..140_000_usize).prop_map(noise),
    ]
}

fn way() -> impl Strategy<Value = Way> {
    prop_oneof![
        any::<bool>().prop_map(Way::Memory),
        any::<bool>().prop_map(Way::Stored),
        any::<bool>().prop_map(Way::Streamed),
    ]
}

fn step() -> impl Strategy<Value = Step> {
    let fault = prop_oneof![
        Just(Fault::OtherBytes),
        Just(Fault::Short),
        Just(Fault::EndsEarly),
        Just(Fault::Fails),
    ];
    prop_oneof![
        (bytes(), way()).prop_map(|(bytes, way)| Step::Blob(bytes, way)),
        (strategies::tree(40), way()).prop_map(|(tree, way)| Step::Tree(tree, way)),
        (strategies::commit(), way()).prop_map(|(commit, way)| Step::Commit(Box::new(commit), way)),
        (bytes(), fault, any::<bool>())
            .prop_map(|(bytes, fault, compress)| Step::Offer(bytes, fault, compress)),
        (any::<prop::sample::Index>(), way()).prop_map(|(index, way)| Step::Again(index, way)),
    ]
}

/// Adds the object `raw` of `kind` the way `way` says; trees and commits are not streamed.
fn add_one<S: PackSink>(pack: &mut PackWriter<S>, kind: ObjectKind, raw: &[u8], way: Way) -> Added {
    let id = ObjectId::of(kind, raw);
    let in_memory = |pack: &mut PackWriter<S>, compress| match kind {
        ObjectKind::Blob => pack.add_blob(raw, compress),
        ObjectKind::Tree => pack.add_object(&Tree::parse(raw).unwrap().encode().unwrap(), compress),
        ObjectKind::Commit => {
            pack.add_object(&Commit::parse(raw).unwrap().encode().unwrap(), compress)
        }
    };
    match way {
        Way::Streamed(compress) if kind == BLOB => {
            match pack.add_blob_from(id, size(raw), raw, compress).unwrap() {
                Streamed::Added(added) => added,
                other => panic!("{other:?}"),
            }
        }
        Way::Memory(compress) | Way::Streamed(compress) => in_memory(pack, compress).unwrap(),
        Way::Stored(compress) => {
            let frame = if compress {
                Compressor::new().compress(raw)
            } else {
                None
            };
            let payload = frame.as_deref().unwrap_or(raw);
            pack.add_stored(kind, id, size(raw), payload, frame.is_some())
                .unwrap()
        }
    }
}

/// Applies `steps` to a pack in `sink`, leaving out the offers that go wrong when `offers` is off.
/// Returns what each step that added an object gave, and the sink of the finished pack.
fn apply<S: PackSink>(steps: &[Step], offers: bool, sink: S) -> (Vec<(ObjectId, Added)>, S) {
    let mut pack = PackWriter::new(sink).unwrap();
    let mut added = Vec::new();
    let mut objects: Vec<(ObjectKind, Vec<u8>)> = Vec::new();
    for step in steps {
        let (kind, raw, way) = match step {
            Step::Blob(bytes, way) => (BLOB, bytes.clone(), *way),
            Step::Tree(tree, way) => (ObjectKind::Tree, tree.encode().unwrap().into_bytes(), *way),
            Step::Commit(commit, way) => (
                ObjectKind::Commit,
                commit.encode().unwrap().into_bytes(),
                *way,
            ),
            Step::Offer(bytes, fault, compress) => {
                // An offer of an object the pack holds is a duplicate, never read.
                if offers && !pack.contains(blob_id(bytes)) {
                    offer(&mut pack, bytes, *fault, *compress);
                }
                continue;
            }
            Step::Again(index, way) => {
                if objects.is_empty() {
                    continue;
                }
                let (kind, raw) = objects[index.index(objects.len())].clone();
                (kind, raw, *way)
            }
        };
        let result = add_one(&mut pack, kind, &raw, way);
        added.push((ObjectId::of(kind, &raw), result));
        objects.push((kind, raw));
    }
    if added.is_empty() {
        pack.add_blob(b"", false).unwrap();
    }
    (added, pack.finish().unwrap().1)
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(32))]

    /// Any mix of objects gives a pack the layout of §9 reads back, with each object once at the
    /// offset its first adding reported; offers that went wrong leave exactly the pack written
    /// without them, in memory and in a file.
    #[test]
    fn random_packs_read_back(steps in prop::collection::vec(step(), 1..12)) {
        let (added, sink) = apply(&steps, true, MemorySink::new());
        let bytes = sink.into_bytes();
        let (without_offers, expected) = apply(&steps, false, MemorySink::new());
        prop_assert_eq!(&bytes, expected.bytes());
        prop_assert_eq!(&added, &without_offers);
        let folder = tempfile::tempdir().unwrap();
        let path = folder.path().join("pack-0.part");
        let (_, file) = apply(&steps, true, FileSink::create(&path).unwrap());
        prop_assert_eq!(&std::fs::read(file.into_path()).unwrap(), &bytes);
        let (_, records) = read_back(&bytes);
        let mut first = BTreeMap::new();
        for (id, result) in &added {
            match result {
                Added::Written { offset, .. } => {
                    prop_assert!(first.insert(*id, *offset).is_none(), "written twice");
                }
                Added::Duplicate { offset } => prop_assert_eq!(first.get(id), Some(offset)),
            }
        }
        if !added.is_empty() {
            prop_assert_eq!(records.len(), first.len());
            for record in &records {
                prop_assert_eq!(first.get(&record.id), Some(&record.offset));
            }
        }
    }
}
