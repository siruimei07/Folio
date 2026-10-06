use std::collections::HashMap;

use proptest::prelude::*;

use super::*;
use crate::store::pack::{Added, FileSink, MemorySink, PackWriter};
use crate::store::schema::Encoded;
use crate::store::strategies::{self, commit_of, noise, one_block_frame, text, tree_of};
use crate::store::{JsonError, SchemaError, ZstdProblem, zstd};

const BLOB: ObjectKind = ObjectKind::Blob;
const TREE: ObjectKind = ObjectKind::Tree;
const COMMIT: ObjectKind = ObjectKind::Commit;

const HELLO: &[u8] = b"hello\n";

/// What a refusal names, and why.
type Refusal = (Subject, Problem);

/// The objects a pack was written with: each one's kind, its bytes and where it went.
type Written = Vec<(ObjectKind, Vec<u8>, Added)>;

/// A pack that breaks one rule, the refusal it gets, and the broken record when there is one.
type Case = (&'static str, Vec<u8>, Refusal, Option<(ObjectId, u64)>);

fn blob_id(bytes: &[u8]) -> ObjectId {
    ObjectId::of(BLOB, bytes)
}

/// The hash a pack's trailer states: its name, when its bytes are whole.
fn name_of(pack: &[u8]) -> PackName {
    PackName::from_bytes(pack[pack.len() - 32..].try_into().unwrap())
}

fn verify(pack: &[u8]) -> Result<PackIndex, StoreError> {
    PackReader::from_bytes(pack).verify(None)
}

fn read_index(pack: &[u8]) -> Result<PackIndex, StoreError> {
    PackReader::from_bytes(pack).read_index(None)
}

/// The object `id` at `offset`, read whole into buffers of the sizes `pieces` cycles through.
fn read_in_pieces(
    pack: &[u8],
    id: ObjectId,
    offset: u64,
    pieces: &[usize],
) -> Result<Vec<u8>, StoreError> {
    let mut object = PackReader::from_bytes(pack).read_object(id, offset)?;
    let mut raw = Vec::new();
    for &size in pieces.iter().cycle() {
        let mut buffer = vec![0; size];
        match object.read_checked(&mut buffer)? {
            0 => break,
            read => raw.extend_from_slice(&buffer[..read]),
        }
    }
    assert!(object.is_verified());
    Ok(raw)
}

fn read_whole(pack: &[u8], id: ObjectId, offset: u64) -> Result<Vec<u8>, StoreError> {
    read_in_pieces(pack, id, offset, &[CHUNK])
}

/// The pack in memory, as errors name it.
fn in_memory() -> Subject {
    Subject::Pack(PathBuf::new())
}

/// What a refused reading names, and why.
fn refused<T: fmt::Debug>(result: Result<T, StoreError>) -> Refusal {
    match result {
        Err(StoreError::Invalid { what, problem }) => (what, problem),
        other => panic!("not refused as invalid: {other:?}"),
    }
}

fn pack_refused(problem: impl Into<Problem>) -> Refusal {
    (in_memory(), problem.into())
}

fn object_refused(id: ObjectId, problem: impl Into<Problem>) -> Refusal {
    (Subject::Object(id), problem.into())
}

/// The version a reading found newer.
fn newer<T: fmt::Debug>(result: Result<T, StoreError>) -> (Subject, String) {
    match result {
        Err(StoreError::Newer { what, version }) => (what, version),
        other => panic!("not newer: {other:?}"),
    }
}

/// `bytes` with the byte at `at` changed by `mask`.
fn flipped(bytes: &[u8], at: usize, mask: u8) -> Vec<u8> {
    let mut bytes = bytes.to_vec();
    bytes[at] ^= mask;
    bytes
}

/// One record laid out by hand, as generate.mjs's `encodePack` takes them: any type, flags and
/// lengths.
#[derive(Debug, Clone)]
struct Raw {
    code: u8,
    flags: u8,
    id: ObjectId,
    raw_length: u64,
    /// The stored length the header states, when it is not the payload's.
    stored_length: Option<u64>,
    payload: Vec<u8>,
}

impl Raw {
    /// The object `raw` of `kind`, stored as it is.
    fn plain(kind: ObjectKind, raw: &[u8]) -> Self {
        Self {
            code: kind.code(),
            flags: 0,
            id: ObjectId::of(kind, raw),
            raw_length: raw.len() as u64,
            stored_length: None,
            payload: raw.to_vec(),
        }
    }

    /// The object `raw` of `kind`, stored as `frame`.
    fn framed(kind: ObjectKind, raw: &[u8], frame: Vec<u8>) -> Self {
        Self {
            flags: FLAG_ZSTD,
            payload: frame,
            ..Self::plain(kind, raw)
        }
    }
}

/// How a hand-made pack breaks the layout: generate.mjs's `encodePack` options.
#[derive(Default)]
struct Layout {
    magic: Option<[u8; 8]>,
    version: Option<u32>,
    before_index: Vec<u8>,
    index: Option<fn(Vec<IndexEntry>) -> Vec<IndexEntry>>,
    count: Option<u64>,
    end_magic: Option<[u8; 8]>,
}

/// The pack of `records` laid out as `layout` says, with the hash of what it holds.
fn lay_out(records: &[Raw], layout: Layout) -> Vec<u8> {
    let mut pack = layout.magic.unwrap_or(MAGIC).to_vec();
    pack.extend_from_slice(&layout.version.unwrap_or(VERSION).to_le_bytes());
    let mut entries = Vec::new();
    for record in records {
        entries.push(IndexEntry {
            id: record.id,
            offset: pack.len() as u64,
        });
        pack.extend_from_slice(&[record.code, record.flags]);
        pack.extend_from_slice(record.id.as_bytes());
        pack.extend_from_slice(&record.raw_length.to_le_bytes());
        let stored = record.stored_length.unwrap_or(record.payload.len() as u64);
        pack.extend_from_slice(&stored.to_le_bytes());
        pack.extend_from_slice(&record.payload);
    }
    pack.extend_from_slice(&layout.before_index);
    entries.sort_unstable();
    if let Some(index) = layout.index {
        entries = index(entries);
    }
    for entry in &entries {
        pack.extend_from_slice(entry.id.as_bytes());
        pack.extend_from_slice(&entry.offset.to_le_bytes());
    }
    let count = layout.count.unwrap_or(entries.len() as u64);
    pack.extend_from_slice(&count.to_le_bytes());
    pack.extend_from_slice(&layout.end_magic.unwrap_or(END_MAGIC));
    let hash = blake3::hash(&pack);
    pack.extend_from_slice(hash.as_bytes());
    pack
}

/// packs.json's small pack to break on purpose: `hello\n` and a tree holding it.
fn small() -> [Raw; 2] {
    [
        Raw::plain(BLOB, HELLO),
        Raw::plain(TREE, tree_of(HELLO, 1).bytes()),
    ]
}

/// The offset of the small pack's tree record, after the blob's 50 + 6 bytes.
const SMALL_TREE_AT: u64 = 68;

/// A zstd frame of `content` (under 128 KiB) as one raw block, with an 8-byte content size and a
/// window of 2 MiB: generate.mjs's hand-made frame.
fn raw_frame(content: &[u8]) -> Vec<u8> {
    let mut frame = vec![0x28, 0xb5, 0x2f, 0xfd, 0xc0, (21 - 10) << 3];
    frame.extend_from_slice(&(content.len() as u64).to_le_bytes());
    let header = (content.len() << 3) | 1;
    frame.extend_from_slice(&header.to_le_bytes()[..3]);
    frame.extend_from_slice(content);
    frame
}

/// A zstd frame of `content` (under 128 KiB) as one raw block that states no content size, with
/// the largest window §9.3 allows, 8 MiB, for which libzstd takes room for the whole window.
fn windowed_frame(content: &[u8]) -> Vec<u8> {
    let mut frame = vec![0x28, 0xb5, 0x2f, 0xfd, 0x00, (23 - 10) << 3];
    let header = (content.len() << 3) | 1;
    frame.extend_from_slice(&header.to_le_bytes()[..3]);
    frame.extend_from_slice(content);
    frame
}

/// A full check decodes every compressed record of a pack through one zstd context, reset for each
/// frame: a context of its own for each record would take room for its window each time, 8 MiB for
/// a frame that states no content size (about 10 µs a record of a few bytes). Records stored raw
/// between them leave it as it is, and every record is checked as before.
#[test]
fn a_full_check_decodes_its_frames_with_one_zstd_context() {
    let content = |n: usize| format!("framed {n:02}").into_bytes();
    let mut pack = PackWriter::new(MemorySink::new()).unwrap();
    for n in 0..20 {
        pack.add_blob(&text(1_000 + n), true).unwrap();
        pack.add_blob(&noise(100 + n), true).unwrap();
        let framed = content(n);
        let size = Size::new(framed.len() as u64).unwrap();
        let frame = windowed_frame(&framed);
        let added = pack.add_stored(BLOB, blob_id(&framed), size, &frame, true);
        assert!(
            matches!(
                added,
                Ok(Added::Written {
                    compressed: true,
                    ..
                })
            ),
            "{added:?}"
        );
    }
    let (index, sink) = pack.finish().unwrap();
    let bytes = sink.into_bytes();
    let mut compressed = 0;
    let before = zstd::contexts_made();
    let checked = PackReader::from_bytes(&bytes)
        .verify_with(None, |record| compressed += usize::from(record.compressed))
        .unwrap();
    assert_eq!(zstd::contexts_made() - before, 1);
    assert_eq!(checked, index);
    assert_eq!(compressed, 40);
    // The last frame changed to other bytes, after the others decoded well, and the pack's hash
    // made again: refused as before.
    let last = content(19);
    let at = bytes
        .windows(last.len())
        .rposition(|window| window == last)
        .unwrap();
    let mut damaged = flipped(&bytes, at + last.len() - 1, 1);
    let hashed = damaged.len() - 32;
    let hash = blake3::hash(&damaged[..hashed]);
    damaged[hashed..].copy_from_slice(hash.as_bytes());
    let mut changed = last.clone();
    *changed.last_mut().unwrap() ^= 1;
    assert_eq!(
        refused(verify(&damaged)),
        object_refused(
            blob_id(&last),
            PackProblem::ObjectId {
                found: blob_id(&changed)
            }
        )
    );
}

/// A pack of objects of every kind and way of storing them, its index, and each object with where
/// the writer put it: a text blob over 64 KiB compressed, noise over 64 KiB raw, the empty blob, a
/// tree compressed and a commit raw.
fn mixed_pack() -> (Vec<u8>, PackIndex, Written) {
    let lecture = text(200_000);
    let random = noise(70_000);
    let tree = tree_of(&lecture, 300);
    let commit = commit_of(tree.id());
    let mut pack = PackWriter::new(MemorySink::new()).unwrap();
    let mut objects = Vec::new();
    for (bytes, compress) in [(lecture, true), (random, true), (Vec::new(), false)] {
        let added = pack.add_blob(&bytes, compress).unwrap();
        objects.push((BLOB, bytes, added));
    }
    for (object, compress) in [(&tree, true), (&commit, false)] {
        let added = pack.add_object(object, compress).unwrap();
        objects.push((object.kind(), object.bytes().to_vec(), added));
    }
    let (index, sink) = pack.finish().unwrap();
    (sink.into_bytes(), index, objects)
}

#[test]
fn a_written_pack_reads_back() {
    let (pack, index, objects) = mixed_pack();
    let name = index.name();
    assert_eq!(name, name_of(&pack));
    let mut reader = PackReader::from_bytes(&pack);
    assert_eq!(reader.size(), pack.len() as u64);
    assert_eq!(reader.path(), Path::new(""));
    assert_eq!(reader.read_index(Some(name)).unwrap(), index);
    assert_eq!(reader.read_index(None).unwrap(), index);
    let mut records = Vec::new();
    let checked = reader
        .verify_with(Some(name), |record| records.push(*record))
        .unwrap();
    assert_eq!(checked, index);
    assert_eq!(reader.verify(None).unwrap(), index);
    assert_eq!(records.len(), objects.len());
    let mut end = HEADER_LEN;
    for (record, (kind, raw, added)) in records.iter().zip(&objects) {
        let Added::Written { offset, compressed } = *added else {
            panic!("{added:?}");
        };
        assert_eq!(
            (record.offset, record.kind, record.id, record.raw_length),
            (offset, *kind, ObjectId::of(*kind, raw), raw.len() as u64)
        );
        assert_eq!(record.compressed, compressed, "{kind} at {offset}");
        if compressed {
            assert!(record.stored_length < record.raw_length);
        } else {
            assert_eq!(record.stored_length, record.raw_length);
        }
        assert_eq!(record.offset, end, "records follow each other");
        end = record.end();
    }
    assert_eq!(
        end,
        pack.len() as u64 - TRAILER_LEN - INDEX_ENTRY_LEN * objects.len() as u64
    );
    let compressed: Vec<bool> = records.iter().map(|record| record.compressed).collect();
    assert_eq!(compressed, [true, false, false, true, false]);
    for ((kind, raw, added), record) in objects.iter().zip(&records) {
        let (id, offset) = (ObjectId::of(*kind, raw), added.offset());
        let object = PackReader::from_bytes(&pack)
            .read_object(id, offset)
            .unwrap();
        assert_eq!(
            (object.kind(), object.id(), object.raw_length()),
            (*kind, id, raw.len() as u64)
        );
        assert_eq!(object.record(), record);
        // Only the empty blob, which no read hands out a byte of, is checked when opened.
        assert_eq!(object.is_verified(), raw.is_empty());
        assert!(
            read_whole(&pack, id, offset).unwrap() == *raw,
            "{kind} {id}"
        );
        match *kind {
            TREE => assert_eq!(
                reader.read_tree(id, offset).unwrap(),
                Tree::parse(raw).unwrap()
            ),
            COMMIT => assert_eq!(
                reader.read_commit(id, offset).unwrap(),
                Commit::parse(raw).unwrap()
            ),
            _ => {}
        }
    }
}

#[test]
fn a_pack_file_reads_back() {
    let folder = tempfile::tempdir().unwrap();
    let path = folder.path().join("pack-1.part");
    let lecture = text(100_000);
    let mut writer = PackWriter::new(FileSink::create(&path).unwrap()).unwrap();
    let added = writer.add_blob(&lecture, true).unwrap();
    let (index, _) = writer.finish().unwrap();
    let mut reader = PackReader::open(&path).unwrap();
    assert_eq!(reader.path(), path);
    assert_eq!(reader.size(), index.size());
    assert_eq!(reader.read_index(Some(index.name())).unwrap(), index);
    assert_eq!(reader.verify(Some(index.name())).unwrap(), index);
    let mut object = reader
        .read_object(blob_id(&lecture), added.offset())
        .unwrap();
    let mut read = Vec::new();
    object.read_to_end(&mut read).unwrap();
    assert!(read == lecture);
    assert!(object.is_verified());
    let missing = folder.path().join(format!("{}.pack", "0".repeat(64)));
    let StoreError::Io { path: at, source } = PackReader::open(&missing).unwrap_err() else {
        panic!("not an I/O error");
    };
    assert_eq!((at, source.kind()), (missing, io::ErrorKind::NotFound));
}

/// An object streams out in pieces of any size, whatever the frame's blocks.
#[test]
fn objects_stream_in_pieces() {
    let lecture = text(20_000);
    let random = noise(3_000);
    let mut pack = PackWriter::new(MemorySink::new()).unwrap();
    let compressed = pack.add_blob(&lecture, true).unwrap();
    let raw = pack.add_blob(&random, false).unwrap();
    let pack = pack.finish().unwrap().1.into_bytes();
    for pieces in [&[1_usize][..], &[3, 7][..], &[4096][..], &[1 << 20][..]] {
        assert!(
            read_in_pieces(&pack, blob_id(&lecture), compressed.offset(), pieces).unwrap()
                == lecture,
            "{pieces:?}"
        );
        assert!(
            read_in_pieces(&pack, blob_id(&random), raw.offset(), pieces).unwrap() == random,
            "{pieces:?}"
        );
    }
}

/// Each step of §11 refuses the pack that breaks it alone, naming the pack for steps 1–7 and the
/// object for steps 8–11; reading the broken record alone refuses it the same way.
#[test]
fn each_step_refuses_what_it_checks() {
    let [blob, tree] = small();
    let hello = blob.id;
    let whole = lay_out(&small(), Layout::default());
    let records_end = whole.len() as u64 - TRAILER_LEN - 2 * INDEX_ENTRY_LEN;
    let with_blob = |blob: Raw| lay_out(&[blob, small()[1].clone()], Layout::default());
    let laid_out = |layout: Layout| lay_out(&small(), layout);
    let mut frame = raw_frame(HELLO);
    let (mut reserved, mut wide) = (frame.clone(), frame.clone());
    reserved[4] |= 0x08;
    wide[5] = (24 - 10) << 3;
    let unframed = {
        // No content size, so nothing states the length but the blocks.
        let mut unframed = vec![0x28, 0xb5, 0x2f, 0xfd, 0x00, (21 - 10) << 3];
        unframed.extend_from_slice(&frame[14..]);
        unframed
    };
    let huge_tree = Raw {
        raw_length: MAX_OBJECT_SIZE + 1,
        ..Raw::framed(TREE, &tree.payload, raw_frame(&tree.payload))
    };
    // An index of the smaller id only leaves out the record of the larger.
    let left_out = if blob.id > tree.id {
        HEADER_LEN
    } else {
        SMALL_TREE_AT
    };
    let cases: Vec<Case> = vec![
        (
            "149 bytes",
            whole[..149].to_vec(),
            pack_refused(PackProblem::TooShort { len: 149 }),
            None,
        ),
        (
            "another magic",
            laid_out(Layout {
                magic: Some(*b"FOLIOPK2"),
                ..Layout::default()
            }),
            pack_refused(PackProblem::Magic),
            Some((hello, HEADER_LEN)),
        ),
        (
            "version 0",
            laid_out(Layout {
                version: Some(0),
                ..Layout::default()
            }),
            pack_refused(PackProblem::VersionZero),
            Some((hello, HEADER_LEN)),
        ),
        (
            "another end magic",
            laid_out(Layout {
                end_magic: Some(*b"FOLIOEN!"),
                ..Layout::default()
            }),
            pack_refused(PackProblem::EndMagic),
            Some((hello, HEADER_LEN)),
        ),
        (
            "a payload byte",
            flipped(&whole, 63, 1),
            pack_refused(PackProblem::Hash),
            None,
        ),
        (
            "the stated hash",
            flipped(&whole, whole.len() - 1, 0x80),
            pack_refused(PackProblem::Hash),
            None,
        ),
        (
            "no index entries",
            laid_out(Layout {
                count: Some(0),
                ..Layout::default()
            }),
            pack_refused(PackProblem::Empty),
            Some((hello, HEADER_LEN)),
        ),
        (
            "1,000 index entries",
            laid_out(Layout {
                count: Some(1000),
                ..Layout::default()
            }),
            pack_refused(PackProblem::IndexSize { count: 1000 }),
            Some((hello, HEADER_LEN)),
        ),
        (
            "2^53 index entries",
            laid_out(Layout {
                count: Some(1 << 53),
                ..Layout::default()
            }),
            pack_refused(PackProblem::IndexSize { count: 1 << 53 }),
            None,
        ),
        (
            "2^64 - 1 index entries",
            laid_out(Layout {
                count: Some(u64::MAX),
                ..Layout::default()
            }),
            pack_refused(PackProblem::IndexSize { count: u64::MAX }),
            None,
        ),
        (
            "an unsorted index",
            laid_out(Layout {
                index: Some(|entries| entries.into_iter().rev().collect()),
                ..Layout::default()
            }),
            pack_refused(PackProblem::IndexOrder),
            None,
        ),
        (
            "an object twice",
            lay_out(
                &[blob.clone(), blob.clone(), tree.clone()],
                Layout::default(),
            ),
            pack_refused(PackProblem::IndexOrder),
            None,
        ),
        (
            "a byte before the index",
            laid_out(Layout {
                before_index: vec![0],
                ..Layout::default()
            }),
            pack_refused(PackProblem::RecordBounds {
                offset: records_end,
            }),
            None,
        ),
        (
            "a payload into the index",
            lay_out(
                &[
                    blob.clone(),
                    Raw {
                        stored_length: Some(tree.payload.len() as u64 + 1),
                        ..tree.clone()
                    },
                ],
                Layout::default(),
            ),
            pack_refused(PackProblem::RecordBounds {
                offset: SMALL_TREE_AT,
            }),
            Some((tree.id, SMALL_TREE_AT)),
        ),
        (
            "a raw length of 2^53",
            with_blob(Raw {
                raw_length: 1 << 53,
                ..blob.clone()
            }),
            pack_refused(PackProblem::RecordBounds { offset: HEADER_LEN }),
            Some((hello, HEADER_LEN)),
        ),
        (
            "record type 0",
            with_blob(Raw {
                code: 0,
                ..blob.clone()
            }),
            pack_refused(PackProblem::RecordType {
                offset: HEADER_LEN,
                code: 0,
            }),
            Some((hello, HEADER_LEN)),
        ),
        (
            "record type 4",
            with_blob(Raw {
                code: 4,
                ..blob.clone()
            }),
            pack_refused(PackProblem::RecordType {
                offset: HEADER_LEN,
                code: 4,
            }),
            Some((hello, HEADER_LEN)),
        ),
        (
            "flags 2",
            with_blob(Raw {
                flags: 2,
                ..blob.clone()
            }),
            pack_refused(PackProblem::RecordFlags {
                offset: HEADER_LEN,
                flags: 2,
            }),
            Some((hello, HEADER_LEN)),
        ),
        (
            "flags 0x81",
            with_blob(Raw {
                flags: 0x81,
                ..blob.clone()
            }),
            pack_refused(PackProblem::RecordFlags {
                offset: HEADER_LEN,
                flags: 0x81,
            }),
            Some((hello, HEADER_LEN)),
        ),
        (
            "an index entry left out",
            laid_out(Layout {
                index: Some(|entries| entries[..1].to_vec()),
                ..Layout::default()
            }),
            pack_refused(PackProblem::NotIndexed { offset: left_out }),
            None,
        ),
        (
            "an index entry at another offset",
            laid_out(Layout {
                index: Some(|entries| {
                    entries
                        .into_iter()
                        .map(|entry| IndexEntry {
                            offset: entry.offset + u64::from(entry.offset == HEADER_LEN),
                            ..entry
                        })
                        .collect()
                }),
                ..Layout::default()
            }),
            pack_refused(PackProblem::NotIndexed { offset: HEADER_LEN }),
            None,
        ),
        (
            "an index entry without a record",
            laid_out(Layout {
                index: Some(|mut entries| {
                    entries.push(IndexEntry {
                        id: ObjectId::from_bytes([0xff; 32]),
                        offset: HEADER_LEN,
                    });
                    entries
                }),
                ..Layout::default()
            }),
            pack_refused(PackProblem::IndexWithoutRecord),
            None,
        ),
        (
            "a raw length that is not the payload's",
            with_blob(Raw {
                raw_length: 7,
                ..blob.clone()
            }),
            object_refused(hello, PackProblem::RawLength),
            Some((hello, HEADER_LEN)),
        ),
        (
            "another blob's bytes",
            with_blob(Raw {
                payload: b"hellO\n".to_vec(),
                ..blob.clone()
            }),
            object_refused(
                hello,
                PackProblem::ObjectId {
                    found: blob_id(b"hellO\n"),
                },
            ),
            Some((hello, HEADER_LEN)),
        ),
        (
            "a tree over 64 MiB",
            lay_out(&[blob.clone(), huge_tree.clone()], Layout::default()),
            object_refused(
                tree.id,
                Problem::TooLarge {
                    limit: MAX_OBJECT_SIZE,
                },
            ),
            Some((tree.id, SMALL_TREE_AT)),
        ),
        (
            "bytes after the frame",
            with_blob(Raw::framed(BLOB, HELLO, [&frame[..], &[0]].concat())),
            object_refused(hello, ZstdProblem::TrailingBytes),
            Some((hello, HEADER_LEN)),
        ),
        (
            "the frame's reserved bit",
            with_blob(Raw::framed(BLOB, HELLO, reserved)),
            object_refused(hello, ZstdProblem::ReservedBit),
            Some((hello, HEADER_LEN)),
        ),
        (
            "a window of 16 MiB",
            with_blob(Raw::framed(BLOB, HELLO, wide)),
            object_refused(hello, ZstdProblem::Window { size: 16 << 20 }),
            Some((hello, HEADER_LEN)),
        ),
        (
            "a frame of another content size",
            with_blob(Raw {
                raw_length: 5,
                ..Raw::framed(BLOB, HELLO, frame.clone())
            }),
            object_refused(
                hello,
                ZstdProblem::ContentSize {
                    stated: 6,
                    raw_length: 5,
                },
            ),
            Some((hello, HEADER_LEN)),
        ),
        (
            "a frame that decodes to more",
            with_blob(Raw {
                raw_length: 5,
                ..Raw::framed(BLOB, HELLO, unframed)
            }),
            object_refused(hello, ZstdProblem::TooLong { raw_length: 5 }),
            Some((hello, HEADER_LEN)),
        ),
        (
            "a frame cut short",
            with_blob(Raw::framed(BLOB, HELLO, {
                frame.pop();
                frame
            })),
            object_refused(hello, ZstdProblem::Truncated),
            Some((hello, HEADER_LEN)),
        ),
    ];
    for (label, pack, expected, record) in cases {
        assert_eq!(refused(verify(&pack)), expected, "{label}");
        if let Some((id, offset)) = record {
            assert_eq!(
                refused(read_whole(&pack, id, offset)),
                expected,
                "{label}, reading the record"
            );
        }
    }
}

/// Step 11: a tree or commit is canonical JSON under its schema, when checked whole and when read
/// alone.
#[test]
fn trees_and_commits_are_parsed() {
    let blob = Raw::plain(BLOB, HELLO);
    let deep = Raw::plain(TREE, &[[b'['; 20], [b']'; 20]].concat());
    let spaced = Raw::plain(TREE, br#"{"entries": []}"#);
    let commit = commit_of(tree_of(HELLO, 1).id());
    let commit_as_tree = Raw::plain(TREE, commit.bytes());
    for (label, record, wrong) in [
        ("20 levels deep", &deep, "depth"),
        ("white space", &spaced, "canonical"),
        ("a commit's fields", &commit_as_tree, "schema"),
    ] {
        let pack = lay_out(&[blob.clone(), record.clone()], Layout::default());
        let expected_what = Subject::Object(record.id);
        for (what, problem) in [
            refused(verify(&pack)),
            refused(read_whole(&pack, record.id, SMALL_TREE_AT)),
            refused(PackReader::from_bytes(&pack).read_tree(record.id, SMALL_TREE_AT)),
        ] {
            assert_eq!(what, expected_what, "{label}");
            let matched = match wrong {
                "depth" => matches!(problem, Problem::Json(JsonError::Depth { .. })),
                "canonical" => matches!(problem, Problem::Json(JsonError::NotCanonical { .. })),
                _ => matches!(
                    problem,
                    Problem::Schema(
                        SchemaError::UnknownField { .. } | SchemaError::MissingField { .. }
                    )
                ),
            };
            assert!(matched, "{label}: {problem:?}");
        }
    }
    // Canonical and under its schema, a commit reads as one.
    let pack = lay_out(&[Raw::plain(COMMIT, commit.bytes())], Layout::default());
    let read = PackReader::from_bytes(&pack)
        .read_commit(commit.id(), HEADER_LEN)
        .unwrap();
    assert_eq!(read.encode().unwrap(), commit);
}

#[test]
fn newer_packs_are_newer_whatever_else_they_hold() {
    let version_2 = |layout: Layout| {
        lay_out(
            &small(),
            Layout {
                version: Some(2),
                ..layout
            },
        )
    };
    let hello = small()[0].id;
    let cases = [
        ("version 2", version_2(Layout::default()), "2"),
        (
            "the largest version",
            lay_out(
                &small(),
                Layout {
                    version: Some(u32::MAX),
                    ..Layout::default()
                },
            ),
            "4294967295",
        ),
        (
            "another end magic",
            version_2(Layout {
                end_magic: Some(*b"FOLIOEN!"),
                ..Layout::default()
            }),
            "2",
        ),
        (
            "no index entries",
            version_2(Layout {
                count: Some(0),
                ..Layout::default()
            }),
            "2",
        ),
        (
            "an unsorted index",
            version_2(Layout {
                index: Some(|entries| entries.into_iter().rev().collect()),
                ..Layout::default()
            }),
            "2",
        ),
        (
            "a record of type 9",
            lay_out(
                &[Raw {
                    code: 9,
                    ..small()[0].clone()
                }],
                Layout {
                    version: Some(2),
                    ..Layout::default()
                },
            ),
            "2",
        ),
    ];
    for (label, pack, version) in cases {
        let changed = flipped(&pack, pack.len() - 1, 1);
        for bytes in [&pack, &changed] {
            let expected = (in_memory(), version.to_owned());
            assert_eq!(newer(verify(bytes)), expected, "{label}");
            assert_eq!(newer(read_index(bytes)), expected, "{label}");
            assert_eq!(
                newer(PackReader::from_bytes(bytes).read_object(hello, HEADER_LEN)),
                expected,
                "{label}"
            );
        }
    }
    // What comes before the version still decides.
    let pack = version_2(Layout::default());
    assert_eq!(
        refused(verify(&pack[..149])),
        pack_refused(PackProblem::TooShort { len: 149 })
    );
    let pack = version_2(Layout {
        magic: Some(*b"FOLIOPK2"),
        ..Layout::default()
    });
    assert_eq!(refused(verify(&pack)), pack_refused(PackProblem::Magic));
}

/// The first failing step in §11's order gives the reason, though one pass finds them all.
#[test]
fn the_first_failing_step_gives_the_reason() {
    let [blob, tree] = small();
    let typeless = Raw {
        code: 9,
        ..blob.clone()
    };
    let flagged = Raw {
        flags: 4,
        ..tree.clone()
    };
    let unsorted = Layout {
        index: Some(|entries| entries.into_iter().rev().collect()),
        ..Layout::default()
    };
    let other_name = PackName::from_bytes([7; 32]);
    let unsorted_pack = lay_out(&small(), unsorted);
    let cases: Vec<(&str, Vec<u8>, Option<PackName>, PackProblem)> = vec![
        (
            "end magic before the count",
            lay_out(
                &small(),
                Layout {
                    end_magic: Some(*b"FOLIOEN!"),
                    count: Some(0),
                    ..Layout::default()
                },
            ),
            None,
            PackProblem::EndMagic,
        ),
        (
            "hash before the index",
            flipped(&unsorted_pack, 63, 1),
            None,
            PackProblem::Hash,
        ),
        (
            "name before the index",
            unsorted_pack.clone(),
            Some(other_name),
            PackProblem::Name,
        ),
        (
            "index order before the records",
            lay_out(
                &[typeless.clone(), tree.clone()],
                Layout {
                    index: Some(|entries| entries.into_iter().rev().collect()),
                    ..Layout::default()
                },
            ),
            None,
            PackProblem::IndexOrder,
        ),
        (
            "index size before the records",
            lay_out(
                &[typeless.clone(), tree.clone()],
                Layout {
                    count: Some(1000),
                    ..Layout::default()
                },
            ),
            None,
            PackProblem::IndexSize { count: 1000 },
        ),
        (
            "the first broken record",
            lay_out(&[typeless.clone(), flagged.clone()], Layout::default()),
            None,
            PackProblem::RecordType {
                offset: HEADER_LEN,
                code: 9,
            },
        ),
        (
            "hash before a broken record",
            flipped(
                &lay_out(&[blob.clone(), flagged.clone()], Layout::default()),
                63,
                1,
            ),
            None,
            PackProblem::Hash,
        ),
        (
            "a broken record before an entry without one",
            lay_out(
                &[typeless.clone(), tree.clone()],
                Layout {
                    index: Some(|mut entries| {
                        entries.push(IndexEntry {
                            id: ObjectId::from_bytes([0xff; 32]),
                            offset: HEADER_LEN,
                        });
                        entries
                    }),
                    ..Layout::default()
                },
            ),
            None,
            PackProblem::RecordType {
                offset: HEADER_LEN,
                code: 9,
            },
        ),
        (
            "a record not indexed before a broken one",
            lay_out(
                &[blob.clone(), flagged.clone()],
                Layout {
                    index: Some(|entries| {
                        entries
                            .into_iter()
                            .filter(|entry| entry.offset != HEADER_LEN)
                            .collect()
                    }),
                    ..Layout::default()
                },
            ),
            None,
            PackProblem::NotIndexed { offset: HEADER_LEN },
        ),
    ];
    for (label, pack, name, problem) in cases {
        let result = PackReader::from_bytes(&pack).verify(name);
        assert_eq!(refused(result), pack_refused(problem), "{label}");
    }
}

#[test]
fn reading_the_index_skips_the_hash_and_the_records() {
    let [blob, tree] = small();
    let whole = lay_out(&small(), Layout::default());
    let index = verify(&whole).unwrap();
    // A payload byte changed: the hash does not check, but the index reads, also under the name
    // the trailer states.
    let changed = flipped(&whole, 63, 1);
    assert_eq!(read_index(&changed).unwrap(), index);
    let mut reader = PackReader::from_bytes(&changed);
    assert_eq!(reader.read_index(Some(index.name())).unwrap(), index);
    let other = PackName::from_bytes([7; 32]);
    assert_eq!(
        refused(reader.read_index(Some(other))),
        pack_refused(PackProblem::Name)
    );
    // A broken record behind a hash that checks: the index reads, the check refuses.
    let typeless = lay_out(&[Raw { code: 9, ..blob }, tree], Layout::default());
    assert!(read_index(&typeless).is_ok());
    assert!(verify(&typeless).is_err());
    // Steps 1–4 and 6 refuse as the full check does.
    let broken = [
        whole[..149].to_vec(),
        lay_out(
            &small(),
            Layout {
                magic: Some(*b"FOLIOPK2"),
                ..Layout::default()
            },
        ),
        lay_out(
            &small(),
            Layout {
                version: Some(0),
                ..Layout::default()
            },
        ),
        lay_out(
            &small(),
            Layout {
                end_magic: Some(*b"FOLIOEN!"),
                ..Layout::default()
            },
        ),
        lay_out(
            &small(),
            Layout {
                count: Some(0),
                ..Layout::default()
            },
        ),
        lay_out(
            &small(),
            Layout {
                count: Some(1000),
                ..Layout::default()
            },
        ),
        lay_out(
            &small(),
            Layout {
                index: Some(|entries| entries.into_iter().rev().collect()),
                ..Layout::default()
            },
        ),
    ];
    for pack in broken {
        assert_eq!(refused(read_index(&pack)), refused(verify(&pack)));
    }
}

/// `pack` with the offset of its index entry `entry` set to `offset`, and the hash of the bytes it
/// then holds, so that only the offset is wrong.
fn with_offset(pack: &[u8], entry: usize, offset: u64) -> Vec<u8> {
    let len = pack.len();
    let count = u64_at(pack, len - TRAILER_LEN as usize) as usize;
    let index_at = len - TRAILER_LEN as usize - INDEX_ENTRY_LEN as usize * count;
    let at = index_at + INDEX_ENTRY_LEN as usize * entry + ObjectId::LEN;
    let mut changed = pack.to_vec();
    changed[at..at + 8].copy_from_slice(&offset.to_le_bytes());
    let hash = blake3::hash(&changed[..len - 32]);
    changed[len - 32..].copy_from_slice(hash.as_bytes());
    changed
}

/// Reading only the index refuses an entry no record can start at (step 7's bounds), which the
/// full check refuses too, so the offsets of an index handed out are ones the catalog can store.
#[test]
fn reading_the_index_refuses_offsets_no_record_starts_at() {
    let whole = lay_out(&small(), Layout::default());
    let index = verify(&whole).unwrap();
    let index_at = whole.len() as u64 - TRAILER_LEN - INDEX_ENTRY_LEN * 2;
    for entry in 0..2 {
        for offset in [
            0,
            HEADER_LEN - 1,
            index_at - RECORD_HEADER_LEN as u64 + 1,
            index_at,
            whole.len() as u64,
            i64::MAX as u64 + 1,
            u64::MAX,
        ] {
            let pack = with_offset(&whole, entry, offset);
            assert_eq!(
                refused(read_index(&pack)),
                pack_refused(PackProblem::RecordBounds { offset }),
                "entry {entry} at {offset}"
            );
            assert!(verify(&pack).is_err(), "entry {entry} at {offset}");
        }
        // Offsets a record could start at: the index reads, the check refuses.
        for offset in [HEADER_LEN + 1, index_at - RECORD_HEADER_LEN as u64] {
            let pack = with_offset(&whole, entry, offset);
            let read = read_index(&pack).unwrap();
            assert_eq!(read.entries()[entry].offset, offset);
            assert_eq!(read.entries()[1 - entry], index.entries()[1 - entry]);
            assert!(verify(&pack).is_err(), "entry {entry} at {offset}");
        }
    }
    // Step 6 comes first: entries out of order are refused for their order.
    let reversed = lay_out(
        &small(),
        Layout {
            index: Some(|entries| entries.into_iter().rev().collect()),
            ..Layout::default()
        },
    );
    assert_eq!(
        refused(read_index(&with_offset(&reversed, 1, 0))),
        pack_refused(PackProblem::IndexOrder)
    );
}

#[test]
fn an_object_is_read_only_where_its_record_is() {
    let (pack, index, objects) = mixed_pack();
    let index_at = pack.len() as u64 - TRAILER_LEN - INDEX_ENTRY_LEN * index.object_count() as u64;
    let lecture = blob_id(&objects[0].1);
    let other = ObjectId::from_bytes([3; 32]);
    assert_eq!(
        refused(PackReader::from_bytes(&pack).read_object(other, HEADER_LEN)),
        pack_refused(PackProblem::WrongObject {
            offset: HEADER_LEN,
            wanted: other,
            found: lecture,
        })
    );
    for offset in [
        0,
        HEADER_LEN - 1,
        index_at - RECORD_HEADER_LEN as u64 + 1,
        index_at,
        pack.len() as u64,
        u64::MAX,
    ] {
        assert_eq!(
            refused(PackReader::from_bytes(&pack).read_object(lecture, offset)),
            pack_refused(PackProblem::RecordBounds { offset }),
            "offset {offset}"
        );
    }
    // Inside a record, the bytes are no record of the object.
    assert!(
        PackReader::from_bytes(&pack)
            .read_object(lecture, HEADER_LEN + 1)
            .is_err()
    );
    // A tree or commit is read only as what it is.
    let (blob, tree, commit) = (&objects[0], &objects[3], &objects[4]);
    let mut reader = PackReader::from_bytes(&pack);
    for (label, result, (kind, raw, _), wanted) in [
        (
            "a blob as a tree",
            reader
                .read_tree(blob_id(&blob.1), blob.2.offset())
                .map(drop),
            blob,
            TREE,
        ),
        (
            "a tree as a commit",
            reader
                .read_commit(ObjectId::of(TREE, &tree.1), tree.2.offset())
                .map(drop),
            tree,
            COMMIT,
        ),
        (
            "a commit as a tree",
            reader
                .read_tree(ObjectId::of(COMMIT, &commit.1), commit.2.offset())
                .map(drop),
            commit,
            TREE,
        ),
    ] {
        assert_eq!(
            refused(result),
            object_refused(
                ObjectId::of(*kind, raw),
                PackProblem::WrongKind {
                    found: *kind,
                    wanted
                }
            ),
            "{label}"
        );
    }
}

/// An object's reader hands out bytes before they are checked, and refuses at the end, in the read
/// that would hand out the last byte; every error is final, and `io::Read` carries it as invalid
/// data.
#[test]
fn a_damaged_object_is_refused_at_its_end() {
    let pack = lay_out(
        &[Raw {
            payload: b"hellO\n".to_vec(),
            ..Raw::plain(BLOB, HELLO)
        }],
        Layout::default(),
    );
    let hello = blob_id(HELLO);
    let mut object = PackReader::from_bytes(&pack)
        .read_object(hello, HEADER_LEN)
        .unwrap();
    assert_eq!(object.read_checked(&mut []).unwrap(), 0);
    assert!(!object.is_verified());
    let mut buffer = [0; 4];
    assert_eq!(object.read_checked(&mut buffer).unwrap(), 4);
    assert!(!object.is_verified());
    assert_eq!(
        refused(object.read_checked(&mut buffer)),
        object_refused(
            hello,
            PackProblem::ObjectId {
                found: blob_id(b"hellO\n")
            }
        )
    );
    match object.read_checked(&mut buffer) {
        Err(StoreError::Io { path, source }) => {
            assert_eq!(path, Path::new(""));
            assert_eq!(source.to_string(), "an earlier read of this object failed");
        }
        other => panic!("{other:?}"),
    }
    assert!(!object.is_verified());
    let mut object = PackReader::from_bytes(&pack)
        .read_object(hello, HEADER_LEN)
        .unwrap();
    let error = object.read_to_end(&mut Vec::new()).unwrap_err();
    assert_eq!(error.kind(), io::ErrorKind::InvalidData);
    let inner = error
        .into_inner()
        .unwrap()
        .downcast::<StoreError>()
        .unwrap();
    assert!(matches!(*inner, StoreError::Invalid { .. }), "{inner:?}");
    // A reader at its end stays there.
    let whole = lay_out(&small(), Layout::default());
    let mut object = PackReader::from_bytes(&whole)
        .read_object(hello, HEADER_LEN)
        .unwrap();
    let mut read = Vec::new();
    object.read_to_end(&mut read).unwrap();
    assert_eq!(read, HELLO);
    assert!(object.is_verified());
    assert_eq!(object.read_checked(&mut buffer).unwrap(), 0);
}

/// A tree or commit may be exactly 64 MiB: the reader's cap (§11 step 8) and the writer's let such
/// a record through to the other checks, and refuse one byte more. Here 64 MiB of `x` as a tree,
/// in a frame of RLE blocks: refused for not being JSON, never for its size.
#[test]
fn a_tree_of_exactly_64_mib_passes_the_size_caps() {
    // `len` bytes of `x` in RLE blocks of 128 KiB, the last one shorter.
    let rle_frame = |len: usize| {
        let mut frame = vec![0x28, 0xb5, 0x2f, 0xfd, 0xc0, (23 - 10) << 3];
        frame.extend_from_slice(&(len as u64).to_le_bytes());
        let mut left = len;
        while left > 0 {
            let size = left.min(128 * 1024);
            left -= size;
            let header = (size << 3) | (1 << 1) | usize::from(left == 0);
            frame.extend_from_slice(&header.to_le_bytes()[..3]);
            frame.push(b'x');
        }
        frame
    };
    let limit = MAX_OBJECT_SIZE as usize;
    for len in [limit, limit + 1] {
        let record = Raw::framed(TREE, &vec![b'x'; len], rle_frame(len));
        let id = record.id;
        let pack = lay_out(std::slice::from_ref(&record), Layout::default());
        let read = PackReader::from_bytes(&pack).read_tree(id, HEADER_LEN);
        let size = Size::new(len as u64).unwrap();
        let stored = PackWriter::new(MemorySink::new()).unwrap().add_stored(
            TREE,
            id,
            size,
            &record.payload,
            true,
        );
        if len == limit {
            assert!(
                matches!(refused(read), (Subject::Object(what), Problem::Json(_)) if what == id)
            );
            assert!(
                matches!(refused(stored), (Subject::Object(what), Problem::Json(_)) if what == id)
            );
        } else {
            let too_large = Problem::TooLarge {
                limit: MAX_OBJECT_SIZE,
            };
            assert_eq!(refused(read), object_refused(id, too_large));
            assert!(
                matches!(
                    stored,
                    Err(StoreError::TooLarge {
                        what: Subject::Object(what),
                        limit: crate::store::Limit::Bytes(MAX_OBJECT_SIZE),
                    }) if what == id
                ),
                "{stored:?}"
            );
        }
    }
}

/// A pack source that gives at most one byte a read.
struct Trickle<'a>(Cursor<&'a [u8]>);

impl Read for Trickle<'_> {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        let one = buffer.len().min(1);
        self.0.read(&mut buffer[..one])
    }
}

impl Seek for Trickle<'_> {
    fn seek(&mut self, to: SeekFrom) -> io::Result<u64> {
        self.0.seek(to)
    }
}

/// The read that hands out an object's last byte checks the object first, the rest of its frame
/// included: a caller that reads exactly its length (`read_exact`, `take`) gets an error for a
/// damaged object, and a whole object is verified once its last byte is out.
#[test]
fn the_read_that_hands_out_the_last_byte_checks_the_object() {
    let hello = blob_id(HELLO);
    // `hello\n` with a checksum after its block, made by Node's libzstd (packs.json).
    let checksummed: Vec<u8> = (0..38)
        .step_by(2)
        .map(|at| u8::from_str_radix(&"28b52ffd240631000068656c6c6f0a5388bd91"[at..at + 2], 16))
        .collect::<Result<_, _>>()
        .unwrap();
    let wrong_checksum = flipped(&checksummed, checksummed.len() - 1, 1);
    let damaged_raw = Raw {
        payload: b"hellO\n".to_vec(),
        ..Raw::plain(BLOB, HELLO)
    };
    let cases = [
        ("raw", Raw::plain(BLOB, HELLO), true),
        ("a raw byte changed", damaged_raw, false),
        ("framed", Raw::framed(BLOB, HELLO, raw_frame(HELLO)), true),
        (
            "a framed byte changed",
            Raw::framed(BLOB, HELLO, raw_frame(b"hellO\n")),
            false,
        ),
        (
            "with a checksum",
            Raw::framed(BLOB, HELLO, checksummed),
            true,
        ),
        (
            "with a wrong checksum",
            Raw::framed(BLOB, HELLO, wrong_checksum),
            false,
        ),
    ];
    /// Reads exactly the object's six bytes from readers `open` makes.
    fn read_six<R: Read + Seek>(open: impl Fn() -> ObjectReader<R>, label: &str, whole: bool) {
        let mut object = open();
        let mut bytes = [0; 6];
        let read = object.read_exact(&mut bytes);
        assert_eq!(read.is_ok(), whole, "{label}: {read:?}");
        assert_eq!(object.is_verified(), whole, "{label}");
        if whole {
            assert_eq!(bytes, HELLO, "{label}");
            assert_eq!(object.read_checked(&mut bytes).unwrap(), 0, "{label}");
        } else {
            assert_eq!(read.unwrap_err().kind(), io::ErrorKind::InvalidData);
        }
        let copied = io::copy(&mut open().take(6), &mut io::sink());
        assert_eq!(copied.is_ok(), whole, "{label}: {copied:?}");
    }
    for (label, record, whole) in cases {
        let pack = lay_out(&[record], Layout::default());
        let at_once = || {
            PackReader::from_bytes(&pack)
                .read_object(hello, HEADER_LEN)
                .unwrap()
        };
        read_six(at_once, label, whole);
        // One byte at a time, the frame's end comes after its last byte.
        let one_by_one = || {
            PackReader::new(Trickle(Cursor::new(pack.as_slice())), pack.len() as u64, "")
                .read_object(hello, HEADER_LEN)
                .unwrap()
        };
        read_six(one_by_one, label, whole);
    }
}

/// An empty object hands out no byte, so no read would check it: it is checked when it is opened.
/// A valid one is verified before anything is read; a record of no bytes under another object's
/// id, as damage that zeroed its lengths leaves it, is refused at once, also by a caller that reads
/// exactly the object's length.
#[test]
fn an_empty_object_is_checked_when_it_is_opened() {
    let (empty, hello) = (blob_id(b""), blob_id(HELLO));
    for (label, record) in [
        ("raw", Raw::plain(BLOB, b"")),
        ("framed", Raw::framed(BLOB, b"", raw_frame(b""))),
    ] {
        let pack = lay_out(std::slice::from_ref(&record), Layout::default());
        let mut object = PackReader::from_bytes(&pack)
            .read_object(empty, HEADER_LEN)
            .unwrap();
        assert!(object.is_verified(), "{label}");
        assert_eq!(object.raw_length(), 0);
        assert_eq!(object.read_checked(&mut [0; 8]).unwrap(), 0, "{label}");
        let lying = lay_out(
            &[Raw {
                id: hello,
                ..record
            }],
            Layout::default(),
        );
        let opened = PackReader::from_bytes(&lying).read_object(hello, HEADER_LEN);
        assert_eq!(
            refused(opened),
            object_refused(hello, PackProblem::ObjectId { found: empty }),
            "{label}"
        );
        assert_eq!(
            refused(verify(&lying)),
            object_refused(hello, PackProblem::ObjectId { found: empty }),
            "{label}"
        );
    }
}

/// A zstd frame whose block breaks RFC 8878's Block_Maximum_Size (the smaller of its window and
/// 128 KiB, §3.1.1.2) has one outcome on every path, whatever room a read gives: the writer does
/// not store it, the full check refuses its pack, and every read of its object fails, a read into
/// room for the whole object too, where libzstd's single-pass shortcut took such a frame of a few
/// bytes that the other paths refused. A frame within the limit passes every path.
#[test]
fn a_block_over_its_maximum_size_is_refused_on_every_path() {
    // The bytes of `a`, the window log (0: a single segment, whose window is its content), an RLE
    // block or a raw one, and whether the block is within its limit: the audit's frames, and
    // frames within the limit beside them.
    let cases = [
        (5_000, 10, true, false),
        (20_000, 14, true, false),
        (200_000, 0, true, false),
        (2_000, 10, false, false),
        (1_024, 10, true, true),
        (100_000, 0, true, true),
        (1_024, 10, false, true),
    ];
    for (count, window_log, rle, within) in cases {
        let label = format!("{count} bytes, window log {window_log}, RLE {rle}");
        let raw = vec![b'a'; count];
        let (id, size) = (blob_id(&raw), Size::new(count as u64).unwrap());
        let frame = one_block_frame(count, window_log, rle);
        let stored = PackWriter::new(MemorySink::new())
            .unwrap()
            .add_stored(BLOB, id, size, &frame, true);
        let pack = lay_out(&[Raw::framed(BLOB, &raw, frame)], Layout::default());
        let checked = verify(&pack);
        let reads: Vec<_> = [1, 7, 4096, CHUNK, count, count + 1]
            .into_iter()
            .map(|room| (room, read_in_pieces(&pack, id, HEADER_LEN, &[room])))
            .collect();
        let open = || {
            PackReader::from_bytes(&pack)
                .read_object(id, HEADER_LEN)
                .unwrap()
        };
        let mut to_end = Vec::new();
        let ended = open().read_to_end(&mut to_end).map(drop);
        let mut copied = Vec::new();
        let copy = io::copy(&mut open(), &mut copied).map(drop);
        if within {
            assert!(
                matches!(
                    stored,
                    Ok(Added::Written {
                        compressed: true,
                        ..
                    })
                ),
                "{label}: {stored:?}"
            );
            assert!(checked.is_ok(), "{label}: {checked:?}");
            for (room, read) in reads {
                assert!(read.unwrap() == raw, "{label}, reads of {room}");
            }
            assert!(ended.is_ok() && to_end == raw, "{label}: {ended:?}");
            assert!(copy.is_ok() && copied == raw, "{label}: {copy:?}");
        } else {
            let by_zstd = |(what, problem): Refusal| {
                what == Subject::Object(id)
                    && matches!(problem, Problem::Zstd(ZstdProblem::Data(_)))
            };
            assert!(by_zstd(refused(stored)), "{label}");
            assert!(by_zstd(refused(checked)), "{label}");
            for (room, read) in reads {
                assert!(by_zstd(refused(read)), "{label}, reads of {room}");
            }
            for result in [ended, copy] {
                assert_eq!(
                    result.unwrap_err().kind(),
                    io::ErrorKind::InvalidData,
                    "{label}"
                );
            }
        }
    }
}

/// A pack source that is interrupted before every other read, fails once `reads` reads have
/// succeeded, and reads as ended within `[hole_from, hole_to)`.
struct Flaky<'a> {
    inner: Cursor<&'a [u8]>,
    interrupt: bool,
    reads: usize,
    hole: (u64, u64),
}

impl<'a> Flaky<'a> {
    fn new(bytes: &'a [u8]) -> Self {
        Self {
            inner: Cursor::new(bytes),
            interrupt: false,
            reads: usize::MAX,
            hole: (0, 0),
        }
    }

    fn reader(self, path: &str) -> PackReader<Self> {
        let len = self.inner.get_ref().len() as u64;
        PackReader::new(self, len, path)
    }
}

impl Read for Flaky<'_> {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        self.interrupt = !self.interrupt;
        if self.interrupt {
            return Err(io::ErrorKind::Interrupted.into());
        }
        if self.reads == 0 {
            return Err(io::Error::other("the disk is gone"));
        }
        self.reads -= 1;
        let at = self.inner.position();
        let (from, to) = self.hole;
        if (from..to).contains(&at) {
            return Ok(0);
        }
        let room = if at < from {
            usize::try_from(from - at).unwrap()
        } else {
            buffer.len()
        };
        let take = room.min(buffer.len());
        self.inner.read(&mut buffer[..take])
    }
}

impl Seek for Flaky<'_> {
    fn seek(&mut self, to: SeekFrom) -> io::Result<u64> {
        self.inner.seek(to)
    }
}

/// The source's errors are I/O errors naming the pack's path, never invalid packs; interrupted
/// reads are tried again.
#[test]
fn a_failing_source_is_an_io_error() {
    let (pack, index, objects) = mixed_pack();
    let name = Some(index.name());
    let random = &objects[1];
    let (random_id, random_at) = (blob_id(&random.1), random.2.offset());
    // Interrupted before every other read, everything reads.
    assert_eq!(Flaky::new(&pack).reader("p").verify(name).unwrap(), index);
    assert_eq!(
        Flaky::new(&pack).reader("p").read_index(name).unwrap(),
        index
    );
    for (kind, raw, added) in &objects {
        let id = ObjectId::of(*kind, raw);
        let mut object = Flaky::new(&pack)
            .reader("p")
            .read_object(id, added.offset())
            .unwrap();
        let mut read = Vec::new();
        object.read_to_end(&mut read).unwrap();
        assert!(read == *raw, "{kind} {id}");
    }
    let io_error = |error: StoreError| match error {
        StoreError::Io { path, source } => {
            assert_eq!(path, Path::new("packs/p.pack"));
            source
        }
        other => panic!("not an I/O error: {other:?}"),
    };
    // Failing after any number of reads.
    let mut verified = false;
    for reads in 0..64 {
        let source = Flaky {
            reads,
            ..Flaky::new(&pack)
        };
        match source.reader("packs/p.pack").verify(name) {
            Ok(checked) => {
                assert_eq!(checked, index);
                verified = true;
            }
            Err(error) => assert_eq!(io_error(error).to_string(), "the disk is gone"),
        }
        let source = Flaky {
            reads,
            ..Flaky::new(&pack)
        };
        match source
            .reader("packs/p.pack")
            .read_object(random_id, random_at)
        {
            Ok(mut object) => match object.read_checked(&mut vec![0; 1 << 20]) {
                Ok(_) => {}
                Err(error) => assert_eq!(io_error(error).to_string(), "the disk is gone"),
            },
            Err(error) => assert_eq!(io_error(error).to_string(), "the disk is gone"),
        }
    }
    assert!(verified, "enough reads verify the pack");
    // A file shorter than its length says, in its trailer or inside a record.
    let mut cut = PackReader::new(
        Cursor::new(&pack[..pack.len() - 1]),
        pack.len() as u64,
        "packs/p.pack",
    );
    assert_eq!(
        io_error(cut.verify(name).unwrap_err()).kind(),
        io::ErrorKind::UnexpectedEof
    );
    let inside = (random_at + 100, random_at + 200);
    let source = Flaky {
        hole: inside,
        ..Flaky::new(&pack)
    };
    assert_eq!(
        io_error(source.reader("packs/p.pack").verify(name).unwrap_err()).kind(),
        io::ErrorKind::UnexpectedEof
    );
    let source = Flaky {
        hole: inside,
        ..Flaky::new(&pack)
    };
    let mut object = source
        .reader("packs/p.pack")
        .read_object(random_id, random_at)
        .unwrap();
    let error = object.read_to_end(&mut Vec::new()).unwrap_err();
    assert_eq!(error.kind(), io::ErrorKind::UnexpectedEof);
}

/// A pack source that serves `first` until it is sought to its start a second time, then
/// `then`: a file replaced between the reads of one check.
struct Replaced<'a> {
    first: Cursor<&'a [u8]>,
    then: Cursor<&'a [u8]>,
    rewinds: usize,
}

impl Read for Replaced<'_> {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        if self.rewinds < 2 {
            self.first.read(buffer)
        } else {
            self.then.read(buffer)
        }
    }
}

impl Seek for Replaced<'_> {
    fn seek(&mut self, to: SeekFrom) -> io::Result<u64> {
        if to == SeekFrom::Start(0) {
            self.rewinds += 1;
        }
        self.then.seek(to)?;
        self.first.seek(to)
    }
}

/// The header, trailer and index are read before the pass, the hash over what the pass reads: a
/// file replaced in between does not have the hash read first, so it never passes, though each
/// version alone is a valid pack.
#[test]
fn a_pack_replaced_while_it_is_checked_does_not_pass() {
    let hello = lay_out(&small(), Layout::default());
    let world = lay_out(
        &[
            Raw::plain(BLOB, b"world\n"),
            Raw::plain(TREE, tree_of(b"world\n", 1).bytes()),
        ],
        Layout::default(),
    );
    assert_eq!(hello.len(), world.len());
    assert!(verify(&world).is_ok());
    let check = |first: &[u8], then: &[u8]| {
        let source = Replaced {
            first: Cursor::new(first),
            then: Cursor::new(then),
            rewinds: 0,
        };
        PackReader::new(source, first.len() as u64, "packs/p.pack").verify(None)
    };
    let refusal = (
        Subject::Pack(PathBuf::from("packs/p.pack")),
        PackProblem::Hash.into(),
    );
    assert_eq!(refused(check(&hello, &world)), refusal);
    assert_eq!(refused(check(&world, &hello)), refusal);
    // A payload byte changed in between, with the index and trailer as they were.
    assert_eq!(refused(check(&hello, &flipped(&hello, 63, 1))), refusal);
    // A replaced index with the records and the stated hash as they were.
    let mut reindexed = hello.clone();
    let index_at = hello.len() - 48 - 80;
    reindexed[index_at..index_at + 80].copy_from_slice(&world[index_at..index_at + 80]);
    assert_eq!(refused(check(&hello, &reindexed)), refusal);
    assert_eq!(check(&hello, &hello).unwrap(), verify(&hello).unwrap());
}

/// An object of a random pack.
#[derive(Debug, Clone)]
enum Object {
    Blob(Vec<u8>),
    Tree(Tree),
    Commit(Box<Commit>),
}

impl Object {
    fn kind(&self) -> ObjectKind {
        match self {
            Self::Blob(_) => BLOB,
            Self::Tree(_) => TREE,
            Self::Commit(_) => COMMIT,
        }
    }

    fn encoded(&self) -> Option<Encoded> {
        match self {
            Self::Blob(_) => None,
            Self::Tree(tree) => Some(tree.encode().unwrap()),
            Self::Commit(commit) => Some(commit.encode().unwrap()),
        }
    }
}

/// An object, blobs of up to `max_blob` bytes, and whether to compress it.
fn object(max_blob: usize) -> impl Strategy<Value = (Object, bool)> {
    let blob = prop_oneof![
        3 => prop::collection::vec(any::<u8>(), 0..300),
        2 => (1..max_blob).prop_map(text),
        1 => (1..max_blob).prop_map(noise),
    ];
    let object = prop_oneof![
        3 => blob.prop_map(Object::Blob),
        1 => strategies::tree(12).prop_map(Object::Tree),
        1 => strategies::commit().prop_map(|commit| Object::Commit(Box::new(commit))),
    ];
    (object, any::<bool>())
}

/// A pack of `objects`, its index, and each object with its kind, its bytes and where it went.
fn write(objects: &[(Object, bool)]) -> (Vec<u8>, PackIndex, Written) {
    let mut pack = PackWriter::new(MemorySink::new()).unwrap();
    let mut written = Vec::new();
    for (object, compress) in objects {
        let (raw, added) = match (object, object.encoded()) {
            (Object::Blob(bytes), _) => (bytes.clone(), pack.add_blob(bytes, *compress)),
            (_, Some(encoded)) => (
                encoded.bytes().to_vec(),
                pack.add_object(&encoded, *compress),
            ),
            (_, None) => unreachable!("trees and commits encode"),
        };
        written.push((object.kind(), raw, added.unwrap()));
    }
    let (index, sink) = pack.finish().unwrap();
    (sink.into_bytes(), index, written)
}

/// A small random pack, and its records and objects by id.
fn small_pack() -> impl Strategy<Value = (Vec<u8>, Vec<Record>, HashMap<ObjectId, Vec<u8>>)> {
    prop::collection::vec(object(2_000), 1..5).prop_map(|objects| {
        let (pack, index, written) = write(&objects);
        let mut records = Vec::new();
        PackReader::from_bytes(&pack)
            .verify_with(Some(index.name()), |record| records.push(*record))
            .unwrap();
        let raws = written
            .into_iter()
            .map(|(kind, raw, _)| (ObjectId::of(kind, &raw), raw))
            .collect();
        (pack, records, raws)
    })
}

/// A refusal of a whole pack: invalid, or newer when the version changed.
fn is_refused(result: &Result<PackIndex, StoreError>) -> bool {
    matches!(
        result,
        Err(StoreError::Invalid { .. } | StoreError::Newer { .. })
    )
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(32))]

    /// Whatever the writer writes verifies, with its name and without, walks its records where the
    /// writer put them, and gives back every object: streamed in pieces, and parsed.
    #[test]
    fn random_packs_verify_and_read_back(
        objects in prop::collection::vec(object(80_000), 1..8),
        pieces in prop::collection::vec(1..5_000_usize, 1..4),
    ) {
        let (pack, index, written) = write(&objects);
        let name = index.name();
        let mut records = Vec::new();
        let checked = PackReader::from_bytes(&pack)
            .verify_with(Some(name), |record| records.push(*record))
            .unwrap();
        prop_assert_eq!(&checked, &index);
        prop_assert_eq!(verify(&pack).unwrap(), index.clone());
        prop_assert_eq!(read_index(&pack).unwrap(), index.clone());
        let expected: Vec<(u64, ObjectKind, ObjectId, u64, bool)> = written
            .iter()
            .filter_map(|(kind, raw, added)| match added {
                Added::Written { offset, compressed } => {
                    Some((*offset, *kind, ObjectId::of(*kind, raw), raw.len() as u64, *compressed))
                }
                Added::Duplicate { .. } => None,
            })
            .collect();
        let walked: Vec<(u64, ObjectKind, ObjectId, u64, bool)> = records
            .iter()
            .map(|r| (r.offset, r.kind, r.id, r.raw_length, r.compressed))
            .collect();
        prop_assert_eq!(walked, expected);
        let mut reader = PackReader::from_bytes(&pack);
        for (kind, raw, added) in &written {
            let id = ObjectId::of(*kind, raw);
            let read = read_in_pieces(&pack, id, added.offset(), &pieces).unwrap();
            prop_assert!(read == *raw, "{} {}", kind, id);
            match *kind {
                TREE => prop_assert_eq!(reader.read_tree(id, added.offset()).unwrap(), Tree::parse(raw).unwrap()),
                COMMIT => prop_assert_eq!(reader.read_commit(id, added.offset()).unwrap(), Commit::parse(raw).unwrap()),
                _ => {}
            }
        }
    }
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(64))]

    /// Any byte changed anywhere makes the full check refuse the pack (a changed version may make
    /// it newer), with its name and without.
    #[test]
    fn any_changed_byte_is_refused(
        (pack, _, _) in small_pack(),
        at in any::<prop::sample::Index>(),
        mask in 1..=255_u8,
    ) {
        let name = name_of(&pack);
        let changed = flipped(&pack, at.index(pack.len()), mask);
        for name in [None, Some(name)] {
            let result = PackReader::from_bytes(&changed).verify(name);
            prop_assert!(is_refused(&result), "{:?}", result);
        }
    }

    /// A pack cut short anywhere or with bytes appended is refused by the full check, and by
    /// reading its index under its name.
    #[test]
    fn cut_or_extended_packs_are_refused(
        (pack, _, _) in small_pack(),
        cut in any::<prop::sample::Index>(),
        extra in prop::collection::vec(any::<u8>(), 1..64),
    ) {
        let name = name_of(&pack);
        let cut = pack[..cut.index(pack.len())].to_vec();
        let extended = [&pack[..], &extra].concat();
        let one_more = [&pack[..], &extra[..1]].concat();
        for bytes in [&cut, &extended, &one_more] {
            for name in [None, Some(name)] {
                let result = PackReader::from_bytes(bytes).verify(name);
                prop_assert!(is_refused(&result), "{} bytes: {:?}", bytes.len(), result);
            }
        }
        for bytes in [&cut, &one_more] {
            let result = PackReader::from_bytes(bytes).read_index(Some(name));
            prop_assert!(is_refused(&result), "{} bytes: {:?}", bytes.len(), result);
        }
    }

    /// A byte changed in a record makes reading it alone fail; only a byte of a zstd frame may
    /// leave the object as it was (a bit zstd ignores), which the object's id then proves.
    #[test]
    fn a_changed_record_is_refused_or_read_unchanged(
        (pack, records, raws) in small_pack(),
        which in any::<prop::sample::Index>(),
        at in any::<prop::sample::Index>(),
        mask in 1..=255_u8,
    ) {
        let record = records[which.index(records.len())];
        let at = record.offset + at.index(usize::try_from(record.end() - record.offset).unwrap()) as u64;
        let changed = flipped(&pack, usize::try_from(at).unwrap(), mask);
        let read = read_whole(&changed, record.id, record.offset);
        let in_frame = record.compressed && at >= record.offset + RECORD_HEADER_LEN as u64;
        if in_frame {
            prop_assert!(read.as_ref().map_or(true, |raw| *raw == raws[&record.id]), "{:?}", record);
        } else {
            prop_assert!(read.is_err(), "{:?} with the byte at {} changed", record, at);
        }
    }
}
