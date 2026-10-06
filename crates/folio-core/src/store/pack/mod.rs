//! Packs (remote-format.md §9): the files that hold objects, locally and in the remote store.
//!
//! ```text
//! offset 0       "FOLIOPK1", u32 format version 1
//! offset 12      records, back to back: u8 type, u8 flags, 32-byte id, u64 raw length,
//!                u64 stored length, then the payload (the object, or its zstd frame)
//! I = L-48-40N   N index entries: 32-byte id and u64 record offset, ascending by id
//! L - 48         u64 N, then "FOLIOEND"
//! L - 32         the BLAKE3 hash of everything before it: the pack's name
//! ```
//!
//! Integers are little-endian. [`PackWriter`] writes packs; [`PackReader`] reads their index,
//! checks them whole, and reads one object at a time.

mod read;
mod write;

use std::fmt;
use std::str::FromStr;

use super::id::{ObjectId, ObjectKind, hex_32};
use super::values::ValueError;

pub use read::{ObjectReader, PackReader, Record};
pub use write::{
    Added, FileSink, MAX_COMPRESSED_STREAM, MemorySink, PackSink, PackWriter, Streamed,
};

/// The bytes a pack is read or written in at a time, and what a [`FileSink`] holds before it
/// writes.
const CHUNK: usize = 64 * 1024;

/// The magic number that starts a pack.
const MAGIC: [u8; 8] = *b"FOLIOPK1";

/// The format version of packs and the objects in them (§3) that this Folio writes and reads.
const VERSION: u32 = 1;

/// The bytes before the first record: magic and version.
const HEADER_LEN: u64 = 12;

/// The bytes of a record before its payload: type, flags, id, raw length and stored length.
const RECORD_HEADER_LEN: usize = 50;

/// The bytes of one index entry: an id and an offset.
const INDEX_ENTRY_LEN: u64 = 40;

/// The bytes after the index: the entry count, the end magic and the hash.
const TRAILER_LEN: u64 = 48;

/// The magic number between the entry count and the hash.
const END_MAGIC: [u8; 8] = *b"FOLIOEND";

/// The record flag of a payload that is a zstd frame (§9.3); the other bits are 0.
const FLAG_ZSTD: u8 = 1;

/// The smallest pack: one record of an empty blob, its index entry and the trailer.
pub const MIN_PACK_LEN: u64 = HEADER_LEN + RECORD_HEADER_LEN as u64 + INDEX_ENTRY_LEN + TRAILER_LEN;

/// The length of a pack without records, what [`PackWriter::size`] says before the first object:
/// its header and trailer.
pub(super) const EMPTY_PACK_LEN: u64 = HEADER_LEN + TRAILER_LEN;

/// The most bytes an object of `raw_length` bytes adds to a pack: its record header, its payload
/// stored raw (a zstd frame is stored only when it is smaller) and its index entry.
pub(super) const fn record_cost(raw_length: u64) -> u64 {
    RECORD_HEADER_LEN as u64 + raw_length + INDEX_ENTRY_LEN
}

/// Whether a record can start at `offset` in a pack whose index starts at `index_at`: after the
/// pack's header, with room for a record header before the index (§11 step 7's bounds of a header).
fn starts_record(offset: u64, index_at: u64) -> bool {
    offset >= HEADER_LEN
        && offset
            .checked_add(RECORD_HEADER_LEN as u64)
            .is_some_and(|end| end <= index_at)
}

/// A pack's name (remote-format.md §9.4): the BLAKE3 hash in its trailer. Its text form is 64
/// lower-case hexadecimal digits and its file name that and `.pack`, so a pack verifies itself and
/// two packs of one name hold the same bytes.
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct PackName([u8; 32]);

impl PackName {
    /// The file name's extension, with its dot.
    pub const EXTENSION: &str = ".pack";

    pub const fn from_bytes(bytes: [u8; 32]) -> Self {
        Self(bytes)
    }

    pub const fn as_bytes(&self) -> &[u8; 32] {
        &self.0
    }

    /// Reads the text form: exactly 64 lower-case hexadecimal digits.
    pub fn parse(text: &str) -> Result<Self, ValueError> {
        hex_32(text).map(Self).ok_or(ValueError::PackName)
    }

    /// Reads a pack's file name: its text form and `.pack`, nothing else.
    pub fn from_file_name(name: &str) -> Result<Self, ValueError> {
        let digits = name
            .strip_suffix(Self::EXTENSION)
            .ok_or(ValueError::PackName)?;
        Self::parse(digits)
    }

    /// The pack's file name in `packs/`: the text form and `.pack`.
    pub fn file_name(&self) -> String {
        format!("{self}{}", Self::EXTENSION)
    }
}

impl fmt::Display for PackName {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&blake3::Hash::from_bytes(self.0).to_hex())
    }
}

impl fmt::Debug for PackName {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        fmt::Display::fmt(self, f)
    }
}

impl FromStr for PackName {
    type Err = ValueError;

    fn from_str(text: &str) -> Result<Self, ValueError> {
        Self::parse(text)
    }
}

/// One entry of a pack's index (§9.4): an object and the offset of its record.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct IndexEntry {
    pub id: ObjectId,
    pub offset: u64,
}

/// Where an object's record is: a pack and an offset in it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct Location {
    pub pack: PackName,
    pub offset: u64,
}

/// What a pack holds, from its index: its name, its length and an entry per object, in strictly
/// ascending order of id, each at an offset a record can start at (at least 12, with room for a
/// record header before the index). What the catalog indexes (versioning.md §4.3).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PackIndex {
    name: PackName,
    size: u64,
    entries: Vec<IndexEntry>,
}

impl PackIndex {
    /// The index of a pack of `size` bytes whose entries, one at least, ascend strictly by id, at
    /// offsets a record can start at.
    fn new(name: PackName, size: u64, entries: Vec<IndexEntry>) -> Self {
        debug_assert!(!entries.is_empty(), "a pack holds an object at least");
        debug_assert!(
            entries.windows(2).all(|pair| pair[0].id < pair[1].id),
            "index entries ascend strictly by id"
        );
        debug_assert!(
            size.checked_sub(TRAILER_LEN + INDEX_ENTRY_LEN * entries.len() as u64)
                .is_some_and(|index_at| {
                    entries
                        .iter()
                        .all(|entry| starts_record(entry.offset, index_at))
                }),
            "a record can start at every offset"
        );
        Self {
            name,
            size,
            entries,
        }
    }

    pub fn name(&self) -> PackName {
        self.name
    }

    /// The pack file's length in bytes.
    pub fn size(&self) -> u64 {
        self.size
    }

    /// The entries in strictly ascending order of id.
    pub fn entries(&self) -> &[IndexEntry] {
        &self.entries
    }

    /// The number of objects, one at least.
    pub fn object_count(&self) -> usize {
        self.entries.len()
    }

    /// The offset of `id`'s record, if the pack holds it.
    pub fn offset(&self, id: ObjectId) -> Option<u64> {
        self.entries
            .binary_search_by(|entry| entry.id.cmp(&id))
            .ok()
            .map(|index| self.entries[index].offset)
    }

    /// Where `id`'s record is, if the pack holds it.
    pub fn location(&self, id: ObjectId) -> Option<Location> {
        self.offset(id).map(|offset| Location {
            pack: self.name,
            offset,
        })
    }
}

/// Why a pack, or a record in it, is invalid (remote-format.md §11, steps 1–10; zstd frames have
/// [`ZstdProblem`](super::ZstdProblem), trees and commits their own problems). The reasons are for
/// logs and tests.
///
/// A [`StoreError::Invalid`](super::StoreError::Invalid) names the pack
/// ([`Subject::Pack`](super::Subject::Pack)) for steps 1–7 and the object
/// ([`Subject::Object`](super::Subject::Object)) for steps 8–11.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum PackProblem {
    /// Step 1.
    #[error("{len} bytes are fewer than the smallest pack's {MIN_PACK_LEN}")]
    TooShort { len: u64 },
    /// Step 2.
    #[error("the pack does not start with FOLIOPK1")]
    Magic,
    /// Step 3: version 0 (a higher version is newer, not invalid).
    #[error("the pack states format version 0")]
    VersionZero,
    /// Step 4.
    #[error("the pack has no FOLIOEND before its hash")]
    EndMagic,
    /// Step 5.
    #[error("the pack's bytes do not have the hash in its trailer")]
    Hash,
    /// Step 5: the file name is not the trailer's hash.
    #[error("the pack's file name is not its hash")]
    Name,
    /// Step 6: N is 0, or a writer was finished before anything was added.
    #[error("the pack holds no objects")]
    Empty,
    /// Step 6: the index does not fit between the first record header and the trailer.
    #[error("{count} index entries do not fit in the pack")]
    IndexSize { count: u64 },
    /// Step 6: two index entries out of order, or with one id.
    #[error("the pack's index is not in strictly ascending order of id")]
    IndexOrder,
    /// Step 7: a record header or payload runs into the index, or a length exceeds 2^53 − 1.
    #[error("the record at offset {offset} does not fit before the index")]
    RecordBounds { offset: u64 },
    /// Step 7.
    #[error("the record at offset {offset} has the unknown type {code}")]
    RecordType { offset: u64, code: u8 },
    /// Step 7.
    #[error("the record at offset {offset} has the unknown flags {flags:#04x}")]
    RecordFlags { offset: u64, flags: u8 },
    /// Step 7: a record the index does not list at its offset.
    #[error("the record at offset {offset} is not in the index at that offset")]
    NotIndexed { offset: u64 },
    /// Step 7: index entries left over once every record is read.
    #[error("the index lists objects the pack holds no record of")]
    IndexWithoutRecord,
    /// Step 7, reading one record: the record at the offset the index gave is another object's.
    #[error("the record at offset {offset} holds the object {found}, not {wanted}")]
    WrongObject {
        offset: u64,
        wanted: ObjectId,
        found: ObjectId,
    },
    /// Reading a tree or commit: the record holds another kind of object.
    #[error("the record holds a {found}, not a {wanted}")]
    WrongKind {
        found: ObjectKind,
        wanted: ObjectKind,
    },
    /// Step 9: an uncompressed payload's length is not the raw length (§9.2).
    #[error("the stored length of an uncompressed record is not its raw length")]
    RawLength,
    /// Step 10: the bytes are another object than the record's id says.
    #[error("the record's bytes are the object {found}")]
    ObjectId { found: ObjectId },
}

#[cfg(test)]
mod tests {
    use super::*;

    const NAME: &str = "da40842345a9e053f3625a68da1ed9f564fd625d357805fbfce6224c6d7c2b4b";

    #[test]
    fn the_smallest_pack_is_150_bytes() {
        assert_eq!(MIN_PACK_LEN, 150);
        assert_eq!(
            MAGIC.len() + VERSION.to_le_bytes().len(),
            HEADER_LEN as usize
        );
        assert_eq!(TRAILER_LEN, 8 + END_MAGIC.len() as u64 + 32);
        assert_eq!(EMPTY_PACK_LEN + record_cost(0), MIN_PACK_LEN);
        let mut writer = PackWriter::new(MemorySink::new()).unwrap();
        assert_eq!(writer.size(), EMPTY_PACK_LEN);
        let raw = vec![7; 1000];
        let before = writer.size();
        writer.add_blob(&raw, false).unwrap();
        assert_eq!(writer.size(), before + record_cost(raw.len() as u64));
    }

    #[test]
    fn names_are_hashes_in_hexadecimal() {
        let name = PackName::parse(NAME).unwrap();
        assert_eq!(name.to_string(), NAME);
        assert_eq!(format!("{name:?}"), NAME);
        assert_eq!(name.file_name(), format!("{NAME}.pack"));
        assert_eq!(PackName::from_file_name(&name.file_name()), Ok(name));
        assert_eq!(NAME.parse::<PackName>(), Ok(name));
        assert_eq!(PackName::from_bytes(*name.as_bytes()), name);
        for text in [
            String::new(),
            NAME[1..].to_owned(),
            format!("{NAME}0"),
            NAME.to_uppercase(),
            format!("b3:{NAME}"),
            format!("{NAME}.pack"),
        ] {
            assert_eq!(
                PackName::parse(&text),
                Err(ValueError::PackName),
                "{text:?}"
            );
        }
        for file in [
            NAME.to_owned(),
            format!("{NAME}.PACK"),
            format!("{NAME}.pack.part"),
            format!("{NAME} 2.pack"),
            ".pack".to_owned(),
        ] {
            assert_eq!(
                PackName::from_file_name(&file),
                Err(ValueError::PackName),
                "{file:?}"
            );
        }
    }

    #[test]
    fn an_index_finds_objects_by_id() {
        let id = |byte| ObjectId::from_bytes([byte; 32]);
        let name = PackName::parse(NAME).unwrap();
        let entries = vec![
            IndexEntry {
                id: id(1),
                offset: 112,
            },
            IndexEntry {
                id: id(7),
                offset: 12,
            },
        ];
        let index = PackIndex::new(name, 300, entries.clone());
        assert_eq!(index.name(), name);
        assert_eq!(index.size(), 300);
        assert_eq!(index.entries(), entries);
        assert_eq!(index.object_count(), 2);
        assert_eq!(index.offset(id(7)), Some(12));
        assert_eq!(index.offset(id(3)), None);
        assert_eq!(
            index.location(id(1)),
            Some(Location {
                pack: name,
                offset: 112
            })
        );
    }

    #[test]
    fn problems_read_as_reasons() {
        assert_eq!(
            PackProblem::TooShort { len: 149 }.to_string(),
            "149 bytes are fewer than the smallest pack's 150"
        );
        assert_eq!(
            PackProblem::RecordFlags {
                offset: 12,
                flags: 2
            }
            .to_string(),
            "the record at offset 12 has the unknown flags 0x02"
        );
        let found = ObjectId::from_bytes([0; 32]);
        assert_eq!(
            PackProblem::ObjectId { found }.to_string(),
            format!("the record's bytes are the object {found}")
        );
        assert_eq!(PackProblem::Empty.to_string(), "the pack holds no objects");
        let wanted = ObjectId::from_bytes([1; 32]);
        assert_eq!(
            PackProblem::WrongObject {
                offset: 12,
                wanted,
                found
            }
            .to_string(),
            format!("the record at offset 12 holds the object {found}, not {wanted}")
        );
        assert_eq!(
            PackProblem::WrongKind {
                found: ObjectKind::Blob,
                wanted: ObjectKind::Tree
            }
            .to_string(),
            "the record holds a blob, not a tree"
        );
    }
}
