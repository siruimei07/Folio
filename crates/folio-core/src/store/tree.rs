//! Trees (remote-format.md §7.2): one folder each, as canonical JSON, its entries in strictly
//! ascending UTF-8 byte order of their names.
//!
//! The rules that need more than one tree (the root's `.folio/` of §7.4, the path length of a
//! whole tree) are checked against a commit, in `rules`.

use std::fmt;

use super::json::{Int, Node, Value};
use super::schema::{self, Encoded, Fields, Part, SchemaError};
use super::{Name, ObjectId, ObjectKind, Problem, Size, StoreError};

/// The fields of a file entry, and of a folder entry.
const FILE_FIELDS: &[&str] = &["hash", "kind", "name", "size", "stored"];
const DIR_FIELDS: &[&str] = &["hash", "kind", "name"];

/// Whether a tree entry or a change record is about a file or a folder: `kind` is `file` or `dir`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum EntryKind {
    File,
    Dir,
}

impl EntryKind {
    /// The kind as trees and change records write it.
    pub const fn name(self) -> &'static str {
        match self {
            Self::File => "file",
            Self::Dir => "dir",
        }
    }

    pub(super) fn parse(text: &str) -> Option<Self> {
        match text {
            "file" => Some(Self::File),
            "dir" => Some(Self::Dir),
            _ => None,
        }
    }
}

impl fmt::Display for EntryKind {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.name())
    }
}

/// A file as trees and change records describe it (remote-format.md §7.2, §8): its content hash,
/// its size and whether its version is stored. Two file entries are the *same* (§8) exactly when
/// their sides are equal.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct Side {
    pub hash: ObjectId,
    pub size: Size,
    pub stored: bool,
}

/// One entry of a tree (remote-format.md §7.2). A folder entry's JSON calls its tree id `hash`,
/// as a file entry calls its content hash.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum TreeEntry {
    /// A file: `stored` is true exactly when the commit's versioning rules keep versions of it,
    /// and then the store holds its blob (§7.2, §7.5).
    File {
        name: Name,
        hash: ObjectId,
        size: Size,
        stored: bool,
    },
    /// A folder, by the id of its tree.
    Dir { name: Name, tree: ObjectId },
}

impl TreeEntry {
    pub fn file(name: Name, side: Side) -> Self {
        let Side { hash, size, stored } = side;
        Self::File {
            name,
            hash,
            size,
            stored,
        }
    }

    pub fn dir(name: Name, tree: ObjectId) -> Self {
        Self::Dir { name, tree }
    }

    pub fn name(&self) -> &Name {
        match self {
            Self::File { name, .. } | Self::Dir { name, .. } => name,
        }
    }

    pub fn kind(&self) -> EntryKind {
        match self {
            Self::File { .. } => EntryKind::File,
            Self::Dir { .. } => EntryKind::Dir,
        }
    }

    /// A file's hash, size and `stored`; `None` for a folder.
    pub fn side(&self) -> Option<Side> {
        match *self {
            Self::File {
                hash, size, stored, ..
            } => Some(Side { hash, size, stored }),
            Self::Dir { .. } => None,
        }
    }

    /// The id of the object the entry names: a file's blob, a folder's tree.
    pub fn id(&self) -> ObjectId {
        match *self {
            Self::File { hash, .. } => hash,
            Self::Dir { tree, .. } => tree,
        }
    }

    fn to_value(&self) -> Value {
        match self {
            Self::File {
                name,
                hash,
                size,
                stored,
            } => schema::object([
                ("hash", schema::id_value(*hash)),
                ("kind", Value::from(EntryKind::File.name())),
                ("name", Value::from(name.as_str())),
                ("size", Value::Int(Int::from(*size))),
                ("stored", Value::Bool(*stored)),
            ]),
            Self::Dir { name, tree } => schema::object([
                ("hash", schema::id_value(*tree)),
                ("kind", Value::from(EntryKind::Dir.name())),
                ("name", Value::from(name.as_str())),
            ]),
        }
    }

    /// An entry under the schema of §7.2, checked in generate.mjs's order: the kind and the
    /// fields it has, the hash, a file's size and `stored`, then the name.
    fn from_node(value: Node<'_>) -> Result<Self, SchemaError> {
        let members = schema::members(Part::Entry, value)?;
        let text = schema::tag(Part::Entry, members, "kind")?;
        let kind =
            EntryKind::parse(&text).ok_or_else(|| schema::unknown_kind(Part::Entry, &text))?;
        let fields = match kind {
            EntryKind::File => FILE_FIELDS,
            EntryKind::Dir => DIR_FIELDS,
        };
        let mut entry = Fields::check(Part::Entry, members, fields, &[])?;
        let hash = entry.id("hash")?;
        Ok(match kind {
            EntryKind::File => {
                let size = Size::from(entry.int("size")?);
                let stored = entry.bool("stored")?;
                let name = entry.parse("name", Name::try_from)?;
                Self::File {
                    name,
                    hash,
                    size,
                    stored,
                }
            }
            EntryKind::Dir => Self::Dir {
                name: entry.parse("name", Name::try_from)?,
                tree: hash,
            },
        })
    }
}

/// A tree (remote-format.md §7.2): a folder's entries in strictly ascending UTF-8 byte order of
/// their names, so names are distinct. An empty folder is the empty tree, `{"entries":[]}`.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Tree {
    entries: Vec<TreeEntry>,
}

impl Tree {
    /// The tree of these entries in any order. Two entries with the same name are refused.
    pub fn new(mut entries: Vec<TreeEntry>) -> Result<Self, SchemaError> {
        entries.sort_unstable_by(|a, b| a.name().cmp(b.name()));
        schema::ascending(&entries, TreeEntry::name, Part::Tree, "entries", "name")?;
        Ok(Self { entries })
    }

    /// The entries in ascending UTF-8 byte order of their names.
    pub fn entries(&self) -> &[TreeEntry] {
        &self.entries
    }

    pub fn into_entries(self) -> Vec<TreeEntry> {
        self.entries
    }

    /// The bytes the list of entries takes: its room, which may be more than its entries take
    /// when the list grew as they were read.
    pub(super) fn entries_room(&self) -> usize {
        self.entries
            .capacity()
            .saturating_mul(size_of::<TreeEntry>())
    }

    /// The entry with exactly this name: names compare as byte strings, so case matters.
    pub fn get(&self, name: &str) -> Option<&TreeEntry> {
        self.entries
            .binary_search_by(|entry| entry.name().as_str().cmp(name))
            .ok()
            .map(|index| &self.entries[index])
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// The tree as a value of the format.
    pub fn to_value(&self) -> Value {
        let entries = self.entries.iter().map(TreeEntry::to_value).collect();
        schema::object([("entries", Value::Array(entries))])
    }

    /// The canonical JSON and the tree id (remote-format.md §4), or [`StoreError::TooLarge`]
    /// beyond 64 MiB.
    pub fn encode(&self) -> Result<Encoded, StoreError> {
        schema::encode(ObjectKind::Tree, &self.to_value())
    }

    /// A tree from its value, under the schema of §7.2, as [`Tree::parse`] reads its canonical
    /// encoding.
    ///
    /// # Panics
    ///
    /// When `value` nests deeper than 16 levels, which no canonical encoding does.
    pub fn from_value(value: Value) -> Result<Self, SchemaError> {
        schema::from_value(&value, Self::from_node)
    }

    /// A tree under the schema of §7.2, read entry by entry.
    fn from_node(value: Node<'_>) -> Result<Self, SchemaError> {
        let mut tree = Fields::new(Part::Tree, value, &["entries"], &[])?;
        let entries = tree
            .array("entries")?
            .map(TreeEntry::from_node)
            .collect::<Result<Vec<_>, _>>()?;
        schema::ascending(&entries, TreeEntry::name, Part::Tree, "entries", "name")?;
        Ok(Self { entries })
    }

    /// A tree from its bytes: at most 64 MiB of canonical JSON (§5) under the schema of §7.2.
    /// Its id is the caller's to check (§11 step 10). Read where it lies in `bytes`, so memory
    /// grows with the entries taken out, never with the shape of a tree that is refused.
    pub fn parse(bytes: &[u8]) -> Result<Self, Problem> {
        Ok(Self::from_node(schema::decode(bytes)?)?)
    }
}

#[cfg(test)]
mod tests;
