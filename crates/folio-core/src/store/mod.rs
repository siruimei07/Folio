//! History format 1 (docs/specs/remote-format.md) and the local object store
//! (docs/specs/versioning.md §4.2–§4.3).
//!
//! - Object ids (remote-format.md §4): [`ObjectId`], [`ObjectKind`], [`ObjectHasher`].
//! - Canonical JSON (§5): [`json`].
//! - The value rules of §6, frozen with the format: [`Name`], [`TreePath`], [`Timestamp`],
//!   [`DeviceId`], [`DeviceName`], [`Summary`], [`Body`], [`Size`], [`Count`], and the NTFS
//!   comparison of §7.4, [`same_ntfs_name`].
//! - Trees (§7.2): [`Tree`], [`TreeEntry`]; commits and change records (§7.3, §8): [`Commit`],
//!   [`CommitKind`], [`Message`], [`Changes`], [`Change`], [`Pruned`]; each encodes to its
//!   canonical JSON and id ([`Encoded`]) and parses with every rule it meets on its own
//!   ([`SchemaError`]).
//! - The rules that need trees (§7.3–§7.5, §8) and the check of a commit in its history (§11):
//!   [`TreeSource`], [`MemoryTrees`], [`flatten`], [`Differences`], [`diff_trees`],
//!   [`check_root`], [`HistoryChecker`], [`absent_blob`], [`may_delete`] ([`RuleViolation`]).
//! - Packs (§9): [`PackWriter`] writes one to a [`PackSink`] ([`MemorySink`], [`FileSink`]),
//!   compressing with zstd under the rules of §9.3 ([`ZstdProblem`]); [`PackReader`] reads a
//!   pack's index, checks it whole, and reads one object ([`ObjectReader`], [`Record`]) under
//!   §11; [`PackIndex`], [`PackName`], [`Location`] ([`PackProblem`]).
//! - The local store (versioning.md §4.1–§4.3): [`LocalStore`] writes packs in `staging/`
//!   ([`PackSet`], [`StagingWriter`], [`StagedPack`]), publishes them into `packs/`, reads and
//!   replaces `HEAD`, lists, indexes and checks its packs, and reads objects at a [`Location`] that
//!   a [`Locator`] ([`MemoryIndex`], the catalog) gives; [`StoreTrees`] is its [`TreeSource`].
//! - The records of the remote store (remote-format.md §10, provisional until v0.3):
//!   [`FormatRecord`], [`HeadRecord`] ([`PackRefs`]) and [`IntentRecord`] ([`MirrorWrites`]), each
//!   read with its size cap ([`RecordKind`]) and its version first, and written at the path its
//!   content names ([`RecordPath`]).
//!
//! Everything read from a pack or a record may be untrusted input (remote-format.md §1), the local
//! store's packs too: a library folder can come from another computer, a copy or a sync client.
//! Readers bound every length before they allocate for it, and never recurse over trees. Trees,
//! commits and records are read where they lie in their bytes, never built as a value of the whole
//! document, so what a reader holds grows with what it accepts, not with the shape of what it
//! refuses.

mod commit;
mod id;
pub mod json;
mod local;
mod pack;
mod records;
mod rules;
mod schema;
#[cfg(test)]
pub(crate) mod strategies;
mod tree;
mod values;
mod zstd;

use std::ffi::OsString;
use std::fmt;
use std::io;
use std::path::{Path, PathBuf};

use crate::fs::FileKind;

pub use commit::{
    Change, ChangeOp, Changes, Commit, CommitKind, Device, MAX_CHANGES, MAX_PRUNED, Message, Pruned,
};
pub use id::{ObjectHasher, ObjectId, ObjectKind};
pub use json::JsonError;
pub use local::{
    BlobClass, InSet, LocalStore, Locator, MemoryIndex, PACK_MAX, PackListing, PackSet,
    Publication, Published, StagedPack, StagingFile, StagingWriter, StoreTrees, WORD_PACK_MIN,
};
pub use pack::{
    Added, FileSink, IndexEntry, Location, MAX_COMPRESSED_STREAM, MIN_PACK_LEN, MemorySink,
    ObjectReader, PackIndex, PackName, PackProblem, PackReader, PackSink, PackWriter, Record,
    Streamed,
};
pub use records::{
    FormatRecord, HeadRecord, IntentRecord, MAX_PACK_REFS, MirrorWrite, MirrorWrites, PackRef,
    PackRefs, RecordKind, RecordPath, WriteOp,
};
pub use rules::{
    DEFAULT_PATH_BUDGET, Differences, FlatEntry, FlatTree, HistoryChecker, MemoryTrees,
    PATH_BYTES_PER_ENTRY, RuleViolation, TreeSource, absent_blob, check_root, diff_trees, flatten,
    may_delete,
};
pub use schema::{Encoded, MAX_OBJECT_SIZE, Part, SchemaError};
pub use tree::{EntryKind, Side, Tree, TreeEntry};
pub use values::{
    Body, Count, DeviceId, DeviceName, LibraryId, MAX_BODY_CHARS, MAX_DEVICE_NAME_CHARS,
    MAX_NAME_UNITS, MAX_PATH_UNITS, MAX_SUMMARY_CHARS, Name, NameError, Size, Summary, Timestamp,
    TreePath, ValueError, same_ntfs_name,
};
pub use zstd::ZstdProblem;

/// A failure of the store (versioning.md §15), with the outcomes of remote-format.md §11.
#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    /// Reading or writing a file of the store failed. From `catalog::CatalogLocator`, the catalog
    /// failed to answer: `path` is its database file and the source a `catalog::CatalogError`
    /// (`source.get_ref()` downcasts to it), which a caller maps as a catalog error (ipc-m1 §16.2:
    /// `Internal`), not by an I/O error's kind.
    #[error("could not access {}: {source}", path.display())]
    Io {
        path: PathBuf,
        #[source]
        source: io::Error,
    },
    /// Damaged, or written by a faulty writer: never used, reported.
    #[error("{what} is not valid: {problem}")]
    Invalid { what: Subject, problem: Problem },
    /// Written by a newer Folio: not interpreted (remote-format.md §3). `version` is the version
    /// as the data states it, shortened to a few dozen characters.
    #[error("{what} has format version {version}, newer than this Folio reads")]
    Newer { what: Subject, version: String },
    /// An object something needs is absent and no prune commit lists it.
    #[error("the object {0} is missing")]
    Missing(ObjectId),
    /// A stored blob that a prune commit thinned out (remote-format.md §7.5).
    #[error("the blob {0} was thinned out")]
    Pruned(ObjectId),
    /// Larger than the format or the store allows: a new tree or commit over 64 MiB, a new record
    /// over its size cap ([`RecordKind::limit`]), a stored payload a writer is asked to copy for a
    /// tree or commit over 64 MiB (with [`Limit::Bytes`]), or a tree whose walk would look at more
    /// entries, or keep more bytes of paths and trees, than the path budget allows
    /// ([`Limit::Paths`], [`Limit::PathBytes`]). Never damage: an object read over the format's
    /// limits is [`StoreError::Invalid`] ([`Problem::TooLarge`]). What a walk refuses can be a
    /// valid history too large to check, or hostile trees.
    #[error("{what} exceeds {limit}")]
    TooLarge { what: Subject, limit: Limit },
}

/// A limit that [`StoreError::TooLarge`] reports.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Limit {
    /// The most bytes allowed: a tree's or commit's 64 MiB ([`MAX_OBJECT_SIZE`]).
    Bytes(u64),
    /// The most tree entries a walk looks at: the path budget ([`DEFAULT_PATH_BUDGET`]).
    Paths(usize),
    /// The most bytes a walk keeps, of the paths it lists and the trees it holds (those of the
    /// folders it is in and those it meets again), or that the check of presence holds of folders:
    /// [`PATH_BYTES_PER_ENTRY`] for each entry of the path budget.
    PathBytes(usize),
}

impl fmt::Display for Limit {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Bytes(bytes) => write!(f, "{bytes} bytes"),
            Self::Paths(paths) => write!(f, "{paths} paths"),
            Self::PathBytes(bytes) => write!(f, "{bytes} bytes of paths and trees"),
        }
    }
}

/// What a [`StoreError`] is about.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Subject {
    /// An object, by its id.
    Object(ObjectId),
    /// A tree or commit being written, which has no id yet.
    NewObject(ObjectKind),
    /// A pack being written, which has no name yet.
    NewPack,
    /// A pack being read, by its path (empty for a pack in memory), or an entry of the local
    /// store's `packs/`.
    Pack(PathBuf),
    /// The local history's `HEAD` (versioning.md §4.2), by its path.
    Head(PathBuf),
    /// A folder of the local store, `packs/` or `staging/`, by its path.
    Folder(PathBuf),
    /// A record of the remote store (remote-format.md §10), by its path relative to the remote's
    /// root: where it was read, or where a record being written goes.
    Record { kind: RecordKind, path: String },
}

impl fmt::Display for Subject {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Object(id) => write!(f, "the object {id}"),
            Self::NewObject(kind) => write!(f, "a new {kind}"),
            Self::NewPack => f.write_str("a new pack"),
            Self::Pack(path) if path.as_os_str().is_empty() => f.write_str("a pack"),
            Self::Pack(path) => write!(f, "the pack {}", path.display()),
            Self::Head(path) => write!(f, "HEAD ({})", path.display()),
            Self::Folder(path) => write!(f, "the folder {}", path.display()),
            Self::Record { kind, path } => write!(f, "the {kind} {path}"),
        }
    }
}

/// Why something is invalid: the rule it breaks (remote-format.md §11). The reasons are for logs
/// and tests; what Folio does depends only on the [`StoreError`] variant.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum Problem {
    /// Not canonical JSON (§5).
    #[error(transparent)]
    Json(#[from] JsonError),
    /// A value breaks a rule of §6.
    #[error(transparent)]
    Value(#[from] ValueError),
    /// A tree or commit breaks its schema (§7.2, §7.3) or a rule of §8 that needs no trees.
    #[error(transparent)]
    Schema(#[from] SchemaError),
    /// Larger than the format allows, before it is read: a tree or commit over 64 MiB, a record
    /// over its size cap, `HEAD` over 4 KiB.
    #[error("larger than {limit} bytes, the most the format allows")]
    TooLarge { limit: u64 },
    /// A commit breaks a rule that needs its trees or its parent (§7.3–§7.5, §8).
    #[error(transparent)]
    Rule(#[from] RuleViolation),
    /// A pack, or a record in it, breaks a rule of §9 or a step of §11.
    #[error(transparent)]
    Pack(#[from] PackProblem),
    /// A compressed payload breaks §9.3.
    #[error(transparent)]
    Zstd(#[from] ZstdProblem),
    /// A local file or record that is not a JSON object with a positive integer `format_version`
    /// (§3, "the version comes first").
    #[error("no positive integer `format_version`")]
    FormatVersion,
    /// Something else than the local store keeps at a path of its folders: a symbolic link or
    /// junction, which it never follows, or a folder where it keeps a file, or the other way round.
    #[error("found {} where the store keeps {}", kind_text(.found), kind_text(.expected))]
    Found { found: FileKind, expected: FileKind },
    /// A record of the remote store that lies elsewhere than the path its content names: another
    /// device's folder, another number, another kind's folder (§10.1).
    #[error("its content puts it at {expected}")]
    Misplaced { expected: RecordPath },
    /// A file of the local store's whose name differs from the one the store keeps there in case
    /// only, which NTFS takes for it: not the store's, as its listing compares names exactly.
    #[error("found {found:?}, which NTFS takes for its name")]
    OtherCase { found: OsString },
}

/// What [`Problem::Found`] calls a kind of entry.
fn kind_text(kind: &FileKind) -> &'static str {
    match kind {
        FileKind::File => "a file",
        FileKind::Folder => "a folder",
        FileKind::Link => "a symbolic link or junction",
        FileKind::Other => "something that is neither a file nor a folder",
    }
}

/// [`StoreError::Io`] for the file or folder at `path`.
fn io_error(path: &Path, source: io::Error) -> StoreError {
    StoreError::Io {
        path: path.to_path_buf(),
        source,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn errors_name_their_subject_and_reason() {
        let id = ObjectId::from_bytes([0xab; 32]);
        let invalid = StoreError::Invalid {
            what: Subject::Object(id),
            problem: Problem::from(ValueError::Name(NameError::Empty)),
        };
        assert_eq!(
            invalid.to_string(),
            format!("the object {id} is not valid: a name is empty")
        );
        let not_canonical = Problem::from(JsonError::NotCanonical { offset: 3 });
        assert_eq!(
            not_canonical.to_string(),
            "not canonical (first differs at byte 3)"
        );
        let newer = StoreError::Newer {
            what: Subject::Object(id),
            version: "2".into(),
        };
        assert!(
            newer
                .to_string()
                .ends_with("has format version 2, newer than this Folio reads")
        );
        assert_eq!(
            StoreError::Missing(id).to_string(),
            format!("the object {id} is missing")
        );
        assert_eq!(
            StoreError::Pruned(id).to_string(),
            format!("the blob {id} was thinned out")
        );
        let too_large = StoreError::TooLarge {
            what: Subject::Object(id),
            limit: Limit::Paths(DEFAULT_PATH_BUDGET),
        };
        assert_eq!(
            too_large.to_string(),
            format!("the object {id} exceeds 1000000 paths")
        );
        let long_paths = StoreError::TooLarge {
            what: Subject::Object(id),
            limit: Limit::PathBytes(DEFAULT_PATH_BUDGET * PATH_BYTES_PER_ENTRY),
        };
        assert_eq!(
            long_paths.to_string(),
            format!("the object {id} exceeds 256000000 bytes of paths and trees")
        );
        let new_tree = StoreError::TooLarge {
            what: Subject::NewObject(ObjectKind::Tree),
            limit: Limit::Bytes(MAX_OBJECT_SIZE),
        };
        assert_eq!(new_tree.to_string(), "a new tree exceeds 67108864 bytes");
        let rule = StoreError::Invalid {
            what: Subject::Object(id),
            problem: Problem::from(RuleViolation::EmptyCommit),
        };
        assert_eq!(
            rule.to_string(),
            format!(
                "the object {id} is not valid: the commit's tree is its parent's: nothing changed"
            )
        );
        let schema = StoreError::Invalid {
            what: Subject::Object(id),
            problem: Problem::from(SchemaError::Order {
                part: Part::Tree,
                field: "entries",
            }),
        };
        assert_eq!(
            schema.to_string(),
            format!(
                "the object {id} is not valid: `entries` of the tree is not in strictly ascending \
                 order"
            )
        );
        assert_eq!(
            Problem::TooLarge {
                limit: MAX_OBJECT_SIZE
            }
            .to_string(),
            "larger than 67108864 bytes, the most the format allows"
        );
        let empty = StoreError::Invalid {
            what: Subject::NewPack,
            problem: Problem::from(PackProblem::Empty),
        };
        assert_eq!(
            empty.to_string(),
            "a new pack is not valid: the pack holds no objects"
        );
        let frame = StoreError::Invalid {
            what: Subject::Object(id),
            problem: Problem::from(ZstdProblem::TrailingBytes),
        };
        assert_eq!(
            frame.to_string(),
            format!("the object {id} is not valid: bytes follow the zstd frame")
        );
        let pack = PathBuf::from("packs").join(format!("{}.pack", "ab".repeat(32)));
        let newer = StoreError::Newer {
            what: Subject::Pack(pack.clone()),
            version: "2".into(),
        };
        assert_eq!(
            newer.to_string(),
            format!(
                "the pack {} has format version 2, newer than this Folio reads",
                pack.display()
            )
        );
        let in_memory = StoreError::Invalid {
            what: Subject::Pack(PathBuf::new()),
            problem: Problem::from(PackProblem::Hash),
        };
        assert_eq!(
            in_memory.to_string(),
            "a pack is not valid: the pack's bytes do not have the hash in its trailer"
        );
        let link = StoreError::Invalid {
            what: Subject::Folder(PathBuf::from("packs")),
            problem: Problem::Found {
                found: FileKind::Link,
                expected: FileKind::Folder,
            },
        };
        assert_eq!(
            link.to_string(),
            "the folder packs is not valid: found a symbolic link or junction where the store \
             keeps a folder"
        );
        let other_case = StoreError::Invalid {
            what: Subject::Pack(pack.clone()),
            problem: Problem::OtherCase {
                found: format!("{}.PACK", "AB".repeat(32)).into(),
            },
        };
        assert_eq!(
            other_case.to_string(),
            format!(
                "the pack {} is not valid: found \"{}.PACK\", which NTFS takes for its name",
                pack.display(),
                "AB".repeat(32)
            )
        );
        let head = StoreError::Invalid {
            what: Subject::Head(PathBuf::from("HEAD")),
            problem: Problem::FormatVersion,
        };
        assert_eq!(
            head.to_string(),
            "HEAD (HEAD) is not valid: no positive integer `format_version`"
        );
        let io = StoreError::Io {
            path: PathBuf::from("packs"),
            source: io::Error::from(io::ErrorKind::NotFound),
        };
        assert!(std::error::Error::source(&io).is_some());
        assert!(io.to_string().starts_with("could not access packs: "));
        let device = DeviceId::parse("3f2c9a7d1e5b40c8a6d2f9e1b7c3a5d0").unwrap();
        let misplaced = StoreError::Invalid {
            what: Subject::Record {
                kind: RecordKind::Head,
                path: format!(".folio/store/heads/{device}/2.json"),
            },
            problem: Problem::Misplaced {
                expected: RecordPath::Head {
                    device: DeviceId::parse("8c1e0d2b4a6f43e19d7c5b3a2f1e0d9c").unwrap(),
                    seq: Count::new(2).unwrap(),
                },
            },
        };
        assert_eq!(
            misplaced.to_string(),
            format!(
                "the head record .folio/store/heads/{device}/2.json is not valid: its content puts \
                 it at .folio/store/heads/8c1e0d2b4a6f43e19d7c5b3a2f1e0d9c/2.json"
            )
        );
        let newer = StoreError::Newer {
            what: Subject::Record {
                kind: RecordKind::Format,
                path: ".folio/store/FORMAT.json".into(),
            },
            version: "2".into(),
        };
        assert_eq!(
            newer.to_string(),
            "the format record .folio/store/FORMAT.json has format version 2, newer than this \
             Folio reads"
        );
        let after = StoreError::Invalid {
            what: Subject::Record {
                kind: RecordKind::Intent,
                path: format!(".folio/store/intents/{device}/1.json"),
            },
            problem: Problem::from(SchemaError::FolioWrite {
                path: ".folio/store/heads".into(),
            }),
        };
        assert_eq!(
            after.to_string(),
            format!(
                "the intent .folio/store/intents/{device}/1.json is not valid: a mirror write may \
                 not touch \".folio/store/heads\": `.folio` is only ever written as a folder, and \
                 nothing inside `.folio/local` or `.folio/store`"
            )
        );
    }
}
