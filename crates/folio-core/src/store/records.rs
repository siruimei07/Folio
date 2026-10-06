//! The records of the remote store (remote-format.md §10, Part B, which sync.md may still change
//! until v0.3 freezes it): `FORMAT.json`, the head records and the intents, each a canonical JSON
//! object in a file of its own under `.folio/store/`.
//!
//! A record is read as §11 says, and the first step that fails decides the outcome: its size cap,
//! before it is read ([`RecordKind::limit`]); JSON; the version, where another than 1 is
//! [`StoreError::Newer`] whatever else the record holds; the canonical form; the schema; and last,
//! that it lies at the path its content names ([`RecordPath`]: its kind, device and number).
//! Records come from the remote, so everything in them is untrusted input.
//!
//! A record is written once and never changed (§10.1). Each type encodes to its canonical bytes,
//! and its `path` says where they go. The types hold only what the format allows wherever a type
//! can say it ([`PackRefs`], [`MirrorWrites`], [`Count`]); the one rule between two fields, a head
//! record's `intent` at most its `seq`, is checked when the record is read or encoded. When and how
//! a device writes records is sync.md's.

use std::fmt;
use std::io::Read;
use std::path::{Path, PathBuf};

use super::json::{Int, Items, Node, Value};
use super::schema::{self, Fields, Part, SchemaError};
use super::{
    Count, Device, DeviceId, EntryKind, LibraryId, Limit, MIN_PACK_LEN, ObjectId, PackIndex,
    PackName, Problem, Size, StoreError, Subject, Timestamp, TreePath, ValueError, io_error,
    same_ntfs_name,
};
use crate::files;

/// The store's folder in the remote, relative to the remote's root (remote-format.md §10.1).
const STORE: &str = ".folio/store";

/// The root folder of a library's metadata, which a mirror write names only as §10.4 allows.
const FOLIO: &str = ".folio";

/// The most packs a head record lists (remote-format.md §10.3).
pub const MAX_PACK_REFS: usize = 1_000;

/// The fields of a head record (remote-format.md §10.3).
const HEAD_FIELDS: &[&str] = &[
    "device",
    "format_version",
    "head",
    "intent",
    "lamport",
    "library_id",
    "packs",
    "seq",
    "time",
];

/// The fields of an intent (remote-format.md §10.4).
const INTENT_REQUIRED: &[&str] = &[
    "device",
    "format_version",
    "head",
    "library_id",
    "seq",
    "time",
    "writes",
];
const INTENT_OPTIONAL: &[&str] = &["base"];

/// A kind of record of the remote store (remote-format.md §10.2–§10.4).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum RecordKind {
    /// `.folio/store/FORMAT.json` (§10.2).
    Format,
    /// `.folio/store/heads/<device id>/<seq>.json` (§10.3).
    Head,
    /// `.folio/store/intents/<device id>/<seq>.json` (§10.4).
    Intent,
}

impl RecordKind {
    /// The most bytes a record of this kind may have: 4 KiB, 1 MiB and 64 MiB. A larger one is
    /// refused before it is read.
    pub const fn limit(self) -> u64 {
        match self {
            Self::Format => 4 * 1024,
            Self::Head => 1024 * 1024,
            Self::Intent => 64 * 1024 * 1024,
        }
    }

    /// The version of this kind's records that this Folio writes and reads. Each kind has a
    /// version of its own (remote-format.md §3), so one can change without the others.
    const fn version(self) -> u32 {
        match self {
            Self::Format | Self::Head | Self::Intent => 1,
        }
    }

    const fn name(self) -> &'static str {
        match self {
            Self::Format => "format record",
            Self::Head => "head record",
            Self::Intent => "intent",
        }
    }
}

impl fmt::Display for RecordKind {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.name())
    }
}

/// Where a record lies in the remote (remote-format.md §10.1), relative to the remote's root and
/// written with `/`: `.folio/store/FORMAT.json`, `.folio/store/heads/<device id>/<seq>.json` or
/// `.folio/store/intents/<device id>/<seq>.json`, the number in decimal without leading zeros. A
/// device's intents and heads share one counter (§10.1).
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum RecordPath {
    Format,
    Head { device: DeviceId, seq: Count },
    Intent { device: DeviceId, seq: Count },
}

impl RecordPath {
    /// The record path `text` writes, or `None` when it matches none of the patterns of §10.1:
    /// such a file is not Folio's (an iCloud conflict copy such as `42 2.json`, `.DS_Store`), and
    /// readers ignore it and report it. A number beyond 2^53 - 1 is no record's.
    pub fn parse(text: &str) -> Option<Self> {
        let rest = text.strip_prefix(STORE)?.strip_prefix('/')?;
        if rest == "FORMAT.json" {
            return Some(Self::Format);
        }
        let (folder, rest) = rest.split_once('/')?;
        let (device, file) = rest.split_once('/')?;
        let device = DeviceId::parse(device).ok()?;
        let seq = parse_seq(file.strip_suffix(".json")?)?;
        match folder {
            "heads" => Some(Self::Head { device, seq }),
            "intents" => Some(Self::Intent { device, seq }),
            _ => None,
        }
    }

    pub fn kind(&self) -> RecordKind {
        match self {
            Self::Format => RecordKind::Format,
            Self::Head { .. } => RecordKind::Head,
            Self::Intent { .. } => RecordKind::Intent,
        }
    }

    /// The record's file under `remote`, the remote's root folder. Joined name by name, as a
    /// verbatim (`\\?\`) path takes no `/`.
    pub fn to_path(&self, remote: &Path) -> PathBuf {
        let mut path = remote.to_path_buf();
        path.extend(self.to_string().split('/'));
        path
    }
}

impl fmt::Display for RecordPath {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Format => write!(f, "{STORE}/FORMAT.json"),
            Self::Head { device, seq } => write!(f, "{STORE}/heads/{device}/{seq}.json"),
            Self::Intent { device, seq } => write!(f, "{STORE}/intents/{device}/{seq}.json"),
        }
    }
}

/// A record's number as its file name writes it: decimal digits without a leading zero, and a
/// count (remote-format.md §6.3).
fn parse_seq(digits: &str) -> Option<Count> {
    if !schema::is_positive_decimal(digits) {
        return None;
    }
    digits.parse().ok().and_then(|seq| Count::new(seq).ok())
}

/// `.folio/store/FORMAT.json` (remote-format.md §10.2): written once, when the remote is created in
/// an empty folder. Its library id must be the local library's; checking that is sync's.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FormatRecord {
    pub library_id: LibraryId,
}

impl FormatRecord {
    /// The record `bytes` hold, read where it lies (`path`, relative to the remote's root, with
    /// `/`) in the order of remote-format.md §11.
    pub fn parse(bytes: &[u8], path: &str) -> Result<Self, StoreError> {
        parse_record(RecordKind::Format, bytes, path, Self::from_node, Self::path)
    }

    /// The record `source` holds, of which at most 4 KiB and one byte are read
    /// ([`FormatRecord::parse`]).
    pub fn read(source: impl Read, path: &str) -> Result<Self, StoreError> {
        Self::parse(&read_capped(RecordKind::Format, source, path)?, path)
    }

    /// Where the record lies: `.folio/store/FORMAT.json`.
    pub fn path(&self) -> RecordPath {
        RecordPath::Format
    }

    /// The canonical bytes to write, far below the cap of 4 KiB.
    pub fn encode(&self) -> Vec<u8> {
        self.to_value().encode()
    }

    fn to_value(&self) -> Value {
        schema::object([
            ("format_version", version_value(RecordKind::Format)),
            ("library_id", Value::from(self.library_id.as_str())),
        ])
    }

    /// The record from its value, whose `format_version` was read first ([`schema::versioned`]).
    fn from_node(value: Node<'_>) -> Result<Self, SchemaError> {
        let mut format = Fields::new(Part::Format, value, &["format_version", "library_id"], &[])?;
        Ok(Self {
            library_id: format.parse("library_id", LibraryId::try_from)?,
        })
    }
}

/// A head record (remote-format.md §10.3), `heads/<device id>/<seq>.json`: one per push, published
/// last. A head is complete when every object reachable from `head` is in some pack, or pruned;
/// `packs` says what to wait for.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HeadRecord {
    pub library_id: LibraryId,
    /// The pushing device; its id is the name of the record's folder.
    pub device: Device,
    /// The record's number, its file's name.
    pub seq: Count,
    /// 1 plus the largest Lamport value the device has seen (ADR-0003 §6).
    pub lamport: Count,
    /// The commit the push publishes.
    pub head: ObjectId,
    /// The `seq` of the intent that announced the push's mirror writes: at most `seq`.
    pub intent: Count,
    /// The packs the push published.
    pub packs: PackRefs,
    /// When the record was written.
    pub time: Timestamp,
}

impl HeadRecord {
    /// The record `bytes` hold, read where it lies (`path`, relative to the remote's root, with
    /// `/`) in the order of remote-format.md §11.
    pub fn parse(bytes: &[u8], path: &str) -> Result<Self, StoreError> {
        parse_record(RecordKind::Head, bytes, path, Self::from_node, Self::path)
    }

    /// The record `source` holds, of which at most 1 MiB and one byte are read
    /// ([`HeadRecord::parse`]).
    pub fn read(source: impl Read, path: &str) -> Result<Self, StoreError> {
        Self::parse(&read_capped(RecordKind::Head, source, path)?, path)
    }

    /// Where the record lies: `.folio/store/heads/<device id>/<seq>.json`.
    pub fn path(&self) -> RecordPath {
        RecordPath::Head {
            device: self.device.id.clone(),
            seq: self.seq,
        }
    }

    /// The canonical bytes to write, or [`StoreError::Invalid`] when `intent` comes after `seq`.
    /// Within the format's other limits a head record stays far below its cap of 1 MiB.
    pub fn encode(&self) -> Result<Vec<u8>, StoreError> {
        intent_at_most_seq(self.intent, self.seq).map_err(|error| StoreError::Invalid {
            what: Subject::Record {
                kind: RecordKind::Head,
                path: self.path().to_string(),
            },
            problem: error.into(),
        })?;
        encode_capped(RecordKind::Head, &self.to_value(), self.path())
    }

    fn to_value(&self) -> Value {
        schema::object([
            ("device", self.device.to_value()),
            ("format_version", version_value(RecordKind::Head)),
            ("head", schema::id_value(self.head)),
            ("intent", Value::Int(Int::from(self.intent))),
            ("lamport", Value::Int(Int::from(self.lamport))),
            ("library_id", Value::from(self.library_id.as_str())),
            ("packs", self.packs.to_value()),
            ("seq", Value::Int(Int::from(self.seq))),
            ("time", Value::String(self.time.to_string())),
        ])
    }

    /// The record from its value, whose `format_version` was read first, checked in generate.mjs's
    /// order: the fields; the device, head and library id; the numbers and the time; `intent` at
    /// most `seq`; the packs.
    fn from_node(value: Node<'_>) -> Result<Self, SchemaError> {
        let mut record = Fields::new(Part::HeadRecord, value, HEAD_FIELDS, &[])?;
        let device = Device::from_node(record.value("device")?)?;
        let head = record.id("head")?;
        let library_id = record.parse("library_id", LibraryId::try_from)?;
        let seq = record.int_with("seq", Count::try_from)?;
        let lamport = record.int_with("lamport", Count::try_from)?;
        let intent = record.int_with("intent", Count::try_from)?;
        let time = record.parse("time", |text| Timestamp::parse(&text))?;
        intent_at_most_seq(intent, seq)?;
        let packs = PackRefs::from_items(record.array("packs")?)?;
        Ok(Self {
            library_id,
            device,
            seq,
            lamport,
            head,
            intent,
            packs,
            time,
        })
    }
}

/// A head record's `intent` is at most its `seq` (remote-format.md §10.3).
fn intent_at_most_seq(intent: Count, seq: Count) -> Result<(), SchemaError> {
    if intent <= seq {
        Ok(())
    } else {
        Err(SchemaError::IntentAfterSeq { intent, seq })
    }
}

/// A pack a push published (remote-format.md §10.3): its name and its size, at least 150 bytes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct PackRef {
    pub name: PackName,
    pub size: Size,
}

/// The pack a writer finished or a reader indexed.
impl TryFrom<&PackIndex> for PackRef {
    type Error = ValueError;

    fn try_from(index: &PackIndex) -> Result<Self, ValueError> {
        Ok(Self {
            name: index.name(),
            size: Size::new(index.size())?,
        })
    }
}

impl PackRef {
    /// The one rule a pack of a head record meets on its own: no pack is smaller than 150 bytes.
    fn check(&self) -> Result<(), SchemaError> {
        if self.size.get() >= MIN_PACK_LEN {
            Ok(())
        } else {
            Err(SchemaError::Value {
                part: Part::PackRef,
                field: "size",
                error: ValueError::PackSize,
            })
        }
    }

    fn to_value(self) -> Value {
        schema::object([
            ("name", Value::String(self.name.file_name())),
            ("size", Value::Int(Int::from(self.size))),
        ])
    }

    fn from_node(value: Node<'_>) -> Result<Self, SchemaError> {
        let mut fields = Fields::new(Part::PackRef, value, &["name", "size"], &[])?;
        let pack = Self {
            name: fields.parse("name", |text| PackName::from_file_name(&text))?,
            size: Size::from(fields.int("size")?),
        };
        pack.check()?;
        Ok(pack)
    }
}

/// The packs of a head record (remote-format.md §10.3): 1 to [`MAX_PACK_REFS`], ascending by name,
/// each named once and none smaller than 150 bytes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PackRefs(Vec<PackRef>);

impl PackRefs {
    /// The packs in any order, sorted by name. Refuses none (a push publishes one or more), more
    /// than [`MAX_PACK_REFS`], one smaller than any pack, and two of one name.
    pub fn new(mut packs: Vec<PackRef>) -> Result<Self, SchemaError> {
        schema::count(packs.len(), MAX_PACK_REFS, Part::HeadRecord, "packs")?;
        packs.iter().try_for_each(PackRef::check)?;
        packs.sort_unstable_by_key(|pack| pack.name);
        Self::ordered(packs)
    }

    /// The packs, ascending by name.
    pub fn packs(&self) -> &[PackRef] {
        &self.0
    }

    fn to_value(&self) -> Value {
        Value::Array(self.0.iter().copied().map(PackRef::to_value).collect())
    }

    /// The packs from their values, an array: the count, each pack, then the order, as
    /// generate.mjs checks them (which also takes an empty list; §10.3 says "one or more").
    fn from_items(items: Items<'_>) -> Result<Self, SchemaError> {
        schema::count(
            items.clone().count(),
            MAX_PACK_REFS,
            Part::HeadRecord,
            "packs",
        )?;
        let packs = items
            .map(PackRef::from_node)
            .collect::<Result<Vec<_>, _>>()?;
        Self::ordered(packs)
    }

    fn ordered(packs: Vec<PackRef>) -> Result<Self, SchemaError> {
        // The file names sort like the names' bytes: 64 lower-case hexadecimal digits, `.pack`.
        schema::ascending(&packs, |pack| pack.name, Part::HeadRecord, "packs", "name")?;
        Ok(Self(packs))
    }
}

/// An intent (remote-format.md §10.4), `intents/<device id>/<seq>.json`: published before the
/// mirror writes it lists, so that a device that finds the mirror half changed knows what was
/// meant.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IntentRecord {
    pub library_id: LibraryId,
    /// The pushing device; its id is the name of the record's folder.
    pub device: Device,
    /// The record's number, its file's name.
    pub seq: Count,
    /// When the record was written.
    pub time: Timestamp,
    /// The canonical commit the push builds on; `None` when the remote held no history.
    pub base: Option<ObjectId>,
    /// The commit the push will publish.
    pub head: ObjectId,
    /// The mirror changes.
    pub writes: MirrorWrites,
}

impl IntentRecord {
    /// The record `bytes` hold, read where it lies (`path`, relative to the remote's root, with
    /// `/`) in the order of remote-format.md §11.
    pub fn parse(bytes: &[u8], path: &str) -> Result<Self, StoreError> {
        parse_record(RecordKind::Intent, bytes, path, Self::from_node, Self::path)
    }

    /// The record `source` holds, of which at most 64 MiB and one byte are read
    /// ([`IntentRecord::parse`]).
    pub fn read(source: impl Read, path: &str) -> Result<Self, StoreError> {
        Self::parse(&read_capped(RecordKind::Intent, source, path)?, path)
    }

    /// Where the record lies: `.folio/store/intents/<device id>/<seq>.json`.
    pub fn path(&self) -> RecordPath {
        RecordPath::Intent {
            device: self.device.id.clone(),
            seq: self.seq,
        }
    }

    /// The canonical bytes to write, or [`StoreError::TooLarge`] beyond the cap of 64 MiB: the
    /// writes of one push must fit in one intent.
    pub fn encode(&self) -> Result<Vec<u8>, StoreError> {
        encode_capped(RecordKind::Intent, &self.to_value(), self.path())
    }

    fn to_value(&self) -> Value {
        let mut members = vec![
            ("device", self.device.to_value()),
            ("format_version", version_value(RecordKind::Intent)),
            ("head", schema::id_value(self.head)),
            ("library_id", Value::from(self.library_id.as_str())),
            ("seq", Value::Int(Int::from(self.seq))),
            ("time", Value::String(self.time.to_string())),
            ("writes", self.writes.to_value()),
        ];
        if let Some(base) = self.base {
            members.push(("base", schema::id_value(base)));
        }
        schema::object(members)
    }

    /// The record from its value, whose `format_version` was read first, checked in generate.mjs's
    /// order: the fields; `base`; the device, head and library id; the number and the time; each
    /// write; their order.
    fn from_node(value: Node<'_>) -> Result<Self, SchemaError> {
        let mut record = Fields::new(Part::Intent, value, INTENT_REQUIRED, INTENT_OPTIONAL)?;
        let base = record.optional("base", Fields::id)?;
        let device = Device::from_node(record.value("device")?)?;
        let head = record.id("head")?;
        let library_id = record.parse("library_id", LibraryId::try_from)?;
        let seq = record.int_with("seq", Count::try_from)?;
        let time = record.parse("time", |text| Timestamp::parse(&text))?;
        let writes = MirrorWrites::from_items(record.array("writes")?)?;
        Ok(Self {
            library_id,
            device,
            seq,
            time,
            base,
            head,
            writes,
        })
    }
}

/// Whether a mirror write writes or deletes. At one path, `delete` comes before `write`
/// (remote-format.md §10.4).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum WriteOp {
    Delete,
    Write,
}

impl WriteOp {
    /// The operation as intents write it.
    pub const fn name(self) -> &'static str {
        match self {
            Self::Delete => "delete",
            Self::Write => "write",
        }
    }

    fn parse(text: &str) -> Option<Self> {
        match text {
            "delete" => Some(Self::Delete),
            "write" => Some(Self::Write),
            _ => None,
        }
    }
}

impl fmt::Display for WriteOp {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.name())
    }
}

/// One change to the mirror that an intent announces (remote-format.md §10.4). Its path is one a
/// tree may hold: never inside `.folio/local` or `.folio/store`, and `.folio` itself is only ever
/// written as a folder, never deleted.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum MirrorWrite {
    /// The file at `path` will hold the blob `hash`.
    WriteFile { path: TreePath, hash: ObjectId },
    /// The folder at `path` will exist.
    WriteDir { path: TreePath },
    /// The file at `path` will be gone.
    DeleteFile { path: TreePath },
    /// The folder at `path` will be gone.
    DeleteDir { path: TreePath },
}

impl MirrorWrite {
    pub fn path(&self) -> &TreePath {
        match self {
            Self::WriteFile { path, .. }
            | Self::WriteDir { path }
            | Self::DeleteFile { path }
            | Self::DeleteDir { path } => path,
        }
    }

    pub fn op(&self) -> WriteOp {
        match self {
            Self::WriteFile { .. } | Self::WriteDir { .. } => WriteOp::Write,
            Self::DeleteFile { .. } | Self::DeleteDir { .. } => WriteOp::Delete,
        }
    }

    pub fn kind(&self) -> EntryKind {
        match self {
            Self::WriteFile { .. } | Self::DeleteFile { .. } => EntryKind::File,
            Self::WriteDir { .. } | Self::DeleteDir { .. } => EntryKind::Dir,
        }
    }

    /// The rule a write meets on its own (§10.4, generate.mjs's `mirrorPathProblem`): a root
    /// entry that NTFS takes for `.folio` (§7.4: ASCII case ignored, `ı` as `i`, `ſ` as `s`) must
    /// be named exactly `.folio`, is only ever written as a folder, and nothing inside its
    /// `local` or `store` is written or deleted, under any spelling NTFS takes for them.
    fn check(&self) -> Result<(), SchemaError> {
        let mut names = self.path().names();
        let first = names.next().unwrap_or_default();
        if !same_ntfs_name(first, FOLIO) {
            return Ok(());
        }
        let allowed = first == FOLIO
            && match names.next() {
                None => matches!(self, Self::WriteDir { .. }),
                Some(second) => {
                    !same_ntfs_name(second, "local") && !same_ntfs_name(second, "store")
                }
            };
        if allowed {
            Ok(())
        } else {
            Err(SchemaError::FolioWrite {
                path: schema::shown(self.path().as_str()),
            })
        }
    }

    /// The order of §10.4: by path in UTF-8 byte order, then `delete` before `write`.
    fn order_key(&self) -> (&str, WriteOp) {
        (self.path().as_str(), self.op())
    }

    fn to_value(&self) -> Value {
        let mut members = vec![
            ("kind", Value::from(self.kind().name())),
            ("op", Value::from(self.op().name())),
            ("path", Value::from(self.path().as_str())),
        ];
        if let Self::WriteFile { hash, .. } = self {
            members.push(("hash", schema::id_value(*hash)));
        }
        schema::object(members)
    }

    /// A write under §10.4, checked in generate.mjs's order: the operation and kind and their
    /// fields, the hash, the path, then the rule of [`MirrorWrite::check`].
    fn from_node(value: Node<'_>) -> Result<Self, SchemaError> {
        let members = schema::members(Part::Write, value)?;
        let op = schema::tag(Part::Write, members, "op")?;
        let kind = schema::tag(Part::Write, members, "kind")?;
        let (op, kind) = match (WriteOp::parse(&op), EntryKind::parse(&kind)) {
            (Some(op), Some(kind)) => (op, kind),
            _ => return Err(schema::unknown_kind(Part::Write, &format!("{op} {kind}"))),
        };
        let fields: &[&'static str] = match (op, kind) {
            (WriteOp::Write, EntryKind::File) => &["hash", "kind", "op", "path"],
            _ => &["kind", "op", "path"],
        };
        let mut write = Fields::check(Part::Write, members, fields, &[])?;
        let path = |write: &mut Fields<'_>| write.parse("path", TreePath::try_from);
        let write = match (op, kind) {
            (WriteOp::Write, EntryKind::File) => Self::WriteFile {
                hash: write.id("hash")?,
                path: path(&mut write)?,
            },
            (WriteOp::Write, EntryKind::Dir) => Self::WriteDir {
                path: path(&mut write)?,
            },
            (WriteOp::Delete, EntryKind::File) => Self::DeleteFile {
                path: path(&mut write)?,
            },
            (WriteOp::Delete, EntryKind::Dir) => Self::DeleteDir {
                path: path(&mut write)?,
            },
        };
        write.check()?;
        Ok(write)
    }
}

/// The mirror changes of an intent (remote-format.md §10.4): ascending by path, then `delete`
/// before `write`, each path and operation once, each meeting the rule of its own. A push that
/// changes nothing in the mirror has none.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct MirrorWrites(Vec<MirrorWrite>);

impl MirrorWrites {
    /// The writes in any order, sorted. Refuses a write into Folio's private folders, one that
    /// deletes `.folio` or writes it as a file, and two writes with one path and operation.
    pub fn new(mut writes: Vec<MirrorWrite>) -> Result<Self, SchemaError> {
        writes.iter().try_for_each(MirrorWrite::check)?;
        writes.sort_unstable_by(|a, b| a.order_key().cmp(&b.order_key()));
        Self::ordered(writes)
    }

    /// The writes in the order of §10.4.
    pub fn writes(&self) -> &[MirrorWrite] {
        &self.0
    }

    pub fn into_writes(self) -> Vec<MirrorWrite> {
        self.0
    }

    fn to_value(&self) -> Value {
        Value::Array(self.0.iter().map(MirrorWrite::to_value).collect())
    }

    fn from_items(items: Items<'_>) -> Result<Self, SchemaError> {
        let writes = items
            .map(MirrorWrite::from_node)
            .collect::<Result<Vec<_>, _>>()?;
        Self::ordered(writes)
    }

    fn ordered(writes: Vec<MirrorWrite>) -> Result<Self, SchemaError> {
        schema::ascending(
            &writes,
            MirrorWrite::order_key,
            Part::Intent,
            "writes",
            "path and operation",
        )?;
        Ok(Self(writes))
    }
}

/// The record of `kind` that `bytes` hold, read where it lies (`path`) in the order of
/// remote-format.md §11: the size cap, JSON, the version and the canonical form
/// ([`schema::versioned`]), the schema (`from_node`), then that `path` is the one the record's
/// content names (`path_of`).
fn parse_record<'a, T>(
    kind: RecordKind,
    bytes: &'a [u8],
    path: &str,
    from_node: impl FnOnce(Node<'a>) -> Result<T, SchemaError>,
    path_of: impl FnOnce(&T) -> RecordPath,
) -> Result<T, StoreError> {
    let what = || Subject::Record {
        kind,
        path: path.to_owned(),
    };
    let invalid = |problem: Problem| StoreError::Invalid {
        what: what(),
        problem,
    };
    let value = schema::versioned(bytes, kind.limit(), kind.version(), what)?;
    let record = from_node(value).map_err(|error| invalid(error.into()))?;
    let expected = path_of(&record);
    if expected.to_string() == path {
        Ok(record)
    } else {
        Err(invalid(Problem::Misplaced { expected }))
    }
}

/// The bytes of a record of `kind` from `source`, of which at most the cap and one byte are read:
/// a longer record is refused before anything is parsed.
fn read_capped(kind: RecordKind, source: impl Read, path: &str) -> Result<Vec<u8>, StoreError> {
    let limit = kind.limit();
    files::read_capped(source, limit)
        .map_err(|source| io_error(Path::new(path), source))?
        .ok_or_else(|| StoreError::Invalid {
            what: Subject::Record {
                kind,
                path: path.to_owned(),
            },
            problem: Problem::TooLarge { limit },
        })
}

/// A new record's canonical bytes, refused as [`StoreError::TooLarge`] beyond its kind's cap.
fn encode_capped(kind: RecordKind, value: &Value, path: RecordPath) -> Result<Vec<u8>, StoreError> {
    let bytes = value.encode();
    if bytes.len() as u64 > kind.limit() {
        return Err(StoreError::TooLarge {
            what: Subject::Record {
                kind,
                path: path.to_string(),
            },
            limit: Limit::Bytes(kind.limit()),
        });
    }
    Ok(bytes)
}

/// The `format_version` member of a record of `kind`.
fn version_value(kind: RecordKind) -> Value {
    Value::Int(Int::from(kind.version()))
}

#[cfg(test)]
mod tests;
