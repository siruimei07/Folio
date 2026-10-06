//! Commits and change records (remote-format.md §7.3, §8), with every rule a commit meets on its
//! own: the fields of its kind, 1 to 100,000 change records or pruned blobs, §8 rule 4 (a
//! `modify` changes its file, a `move` changes its path), the order of rule 5, and pruned blobs in
//! strictly ascending order.
//!
//! The rules that need trees or the parent (no empty commit, §7.4, §7.5, coverage by §8 rules
//! 1–3) are checked in `rules`.

use std::fmt;

use super::json::{Int, Items, Node, Value};
use super::schema::{self, Encoded, Fields, Part, SchemaError};
use super::tree::{EntryKind, Side};
use super::{
    Body, DeviceId, DeviceName, ObjectId, ObjectKind, Problem, Size, StoreError, Summary,
    Timestamp, TreePath,
};

/// The most change records a commit holds (remote-format.md §8 rule 7). A writer with more leaves
/// `changes` out.
pub const MAX_CHANGES: usize = 100_000;

/// The most blobs a prune commit lists (remote-format.md §7.5).
pub const MAX_PRUNED: usize = 100_000;

/// The fields of a `commit` or `import`, and of a `prune` (remote-format.md §7.3).
const MESSAGE_REQUIRED: &[&str] = &["device", "kind", "summary", "time", "tree"];
const MESSAGE_OPTIONAL: &[&str] = &["body", "changes", "parent", "rebased_from"];
const PRUNE_REQUIRED: &[&str] = &["device", "kind", "parent", "pruned", "time", "tree"];
const PRUNE_OPTIONAL: &[&str] = &["rebased_from"];

/// The device that made a commit (remote-format.md §7.3): its id (§6.1) and display name (§6.6).
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct Device {
    pub id: DeviceId,
    pub name: DeviceName,
}

impl Device {
    pub(super) fn to_value(&self) -> Value {
        schema::object([
            ("id", Value::from(self.id.as_str())),
            ("name", Value::from(self.name.as_str())),
        ])
    }

    pub(super) fn from_node(value: Node<'_>) -> Result<Self, SchemaError> {
        let mut device = Fields::new(Part::Device, value, &["id", "name"], &[])?;
        Ok(Self {
            id: device.parse("id", DeviceId::try_from)?,
            name: device.parse("name", DeviceName::try_from)?,
        })
    }
}

/// A commit (remote-format.md §7.3). Its order in a history comes from `parent`, never from
/// `time`: clocks may be wrong.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Commit {
    /// The id of the root tree.
    pub tree: ObjectId,
    pub device: Device,
    pub time: Timestamp,
    /// The commit this one was rebased from (ADR-0003 §6).
    pub rebased_from: Option<ObjectId>,
    pub kind: CommitKind,
}

/// A commit's kind with the fields that depend on it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CommitKind {
    /// Made on a device. `parent` is left out only on a library's first commit.
    Commit {
        parent: Option<ObjectId>,
        message: Message,
    },
    /// Direct edits found in the remote (ADR-0003 §7), shown as from iCloud.
    Import {
        parent: Option<ObjectId>,
        message: Message,
    },
    /// Thinning (remote-format.md §7.5): the parent's tree with these blobs thinned out of the
    /// versions before it.
    Prune { parent: ObjectId, pruned: Pruned },
}

impl CommitKind {
    /// The kind as commits write it: `commit`, `import` or `prune`.
    pub const fn name(&self) -> &'static str {
        match self {
            Self::Commit { .. } => "commit",
            Self::Import { .. } => "import",
            Self::Prune { .. } => "prune",
        }
    }
}

impl Commit {
    /// The previous commit; `None` only for a library's first commit, which is never a prune.
    pub fn parent(&self) -> Option<ObjectId> {
        match self.kind {
            CommitKind::Commit { parent, .. } | CommitKind::Import { parent, .. } => parent,
            CommitKind::Prune { parent, .. } => Some(parent),
        }
    }

    /// Puts the commit on top of another, as a reword or a rebase writes the commits after the
    /// one it rewrote.
    pub fn set_parent(&mut self, id: ObjectId) {
        match &mut self.kind {
            CommitKind::Commit { parent, .. } | CommitKind::Import { parent, .. } => {
                *parent = Some(id);
            }
            CommitKind::Prune { parent, .. } => *parent = id,
        }
    }

    /// The message and changes of a `commit` or `import`; `None` for a prune commit.
    pub fn message(&self) -> Option<&Message> {
        match &self.kind {
            CommitKind::Commit { message, .. } | CommitKind::Import { message, .. } => {
                Some(message)
            }
            CommitKind::Prune { .. } => None,
        }
    }

    /// The blobs a prune commit thins out; `None` for other kinds.
    pub fn pruned(&self) -> Option<&Pruned> {
        match &self.kind {
            CommitKind::Prune { pruned, .. } => Some(pruned),
            _ => None,
        }
    }

    /// The commit as a value of the format.
    pub fn to_value(&self) -> Value {
        let mut members = vec![
            ("device", self.device.to_value()),
            ("kind", Value::from(self.kind.name())),
            ("time", Value::String(self.time.to_string())),
            ("tree", schema::id_value(self.tree)),
        ];
        if let Some(parent) = self.parent() {
            members.push(("parent", schema::id_value(parent)));
        }
        if let Some(id) = self.rebased_from {
            members.push(("rebased_from", schema::id_value(id)));
        }
        match &self.kind {
            CommitKind::Commit { message, .. } | CommitKind::Import { message, .. } => {
                members.push(("summary", Value::from(message.summary.as_str())));
                if let Some(body) = &message.body {
                    members.push(("body", Value::from(body.as_str())));
                }
                if let Some(changes) = &message.changes {
                    members.push(("changes", changes.to_value()));
                }
            }
            CommitKind::Prune { pruned, .. } => members.push(("pruned", pruned.to_value())),
        }
        schema::object(members)
    }

    /// The canonical JSON and the commit id (remote-format.md §4), or [`StoreError::TooLarge`]
    /// beyond 64 MiB: a writer then leaves `changes` out (§8 rule 7).
    pub fn encode(&self) -> Result<Encoded, StoreError> {
        schema::encode(ObjectKind::Commit, &self.to_value())
    }

    /// A commit from its value, under the schema of §7.3 and the rules of §8 that need no trees,
    /// as [`Commit::parse`] reads its canonical encoding.
    ///
    /// # Panics
    ///
    /// When `value` nests deeper than 16 levels, which no canonical encoding does.
    pub fn from_value(value: Value) -> Result<Self, SchemaError> {
        schema::from_value(&value, Self::from_node)
    }

    /// A commit under the schema of §7.3 and the rules of §8 that need no trees, checked in
    /// generate.mjs's order: the kind and its fields, the device, time, tree, parent and
    /// `rebased_from`, then the kind's own fields.
    fn from_node(value: Node<'_>) -> Result<Self, SchemaError> {
        #[derive(Clone, Copy)]
        enum Kind {
            Commit,
            Import,
            Prune,
        }
        let members = schema::members(Part::Commit, value)?;
        let text = schema::tag(Part::Commit, members, "kind")?;
        let kind = match text.as_ref() {
            "commit" => Kind::Commit,
            "import" => Kind::Import,
            "prune" => Kind::Prune,
            _ => return Err(schema::unknown_kind(Part::Commit, &text)),
        };
        let (required, optional) = match kind {
            Kind::Commit | Kind::Import => (MESSAGE_REQUIRED, MESSAGE_OPTIONAL),
            Kind::Prune => (PRUNE_REQUIRED, PRUNE_OPTIONAL),
        };
        let mut commit = Fields::check(Part::Commit, members, required, optional)?;
        let device = Device::from_node(commit.value("device")?)?;
        let time = commit.parse("time", |text| Timestamp::parse(&text))?;
        let tree = commit.id("tree")?;
        let parent = commit.optional("parent", Fields::id)?;
        let rebased_from = commit.optional("rebased_from", Fields::id)?;
        let kind = match kind {
            Kind::Commit => CommitKind::Commit {
                parent,
                message: Message::from_fields(&mut commit)?,
            },
            Kind::Import => CommitKind::Import {
                parent,
                message: Message::from_fields(&mut commit)?,
            },
            Kind::Prune => CommitKind::Prune {
                // Required for a prune commit, so `Fields::check` found it.
                parent: parent.ok_or(SchemaError::MissingField {
                    part: Part::Commit,
                    field: "parent",
                })?,
                pruned: Pruned::from_items(commit.array("pruned")?)?,
            },
        };
        Ok(Self {
            tree,
            device,
            time,
            rebased_from,
            kind,
        })
    }

    /// A commit from its bytes: at most 64 MiB of canonical JSON (§5) under the schema of §7.3
    /// and the rules of §8 that need no trees. Its id is the caller's to check (§11 step 10).
    pub fn parse(bytes: &[u8]) -> Result<Self, Problem> {
        Ok(Self::from_node(schema::decode(bytes)?)?)
    }
}

/// The message of a `commit` or `import` (remote-format.md §6.7) and its change records (§8).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Message {
    pub summary: Summary,
    /// The details; a message without them has no body rather than an empty one.
    pub body: Option<Body>,
    /// How the tree differs from the parent's. Left out, readers compare the two trees and find
    /// no moves (§8 rule 7).
    pub changes: Option<Changes>,
}

impl Message {
    /// The summary, body and changes of a commit or import whose fields were checked.
    fn from_fields(commit: &mut Fields<'_>) -> Result<Self, SchemaError> {
        Ok(Self {
            summary: commit.parse("summary", Summary::try_from)?,
            body: commit.optional("body", |commit, field| commit.parse(field, Body::try_from))?,
            changes: commit
                .optional("changes", Fields::array)?
                .map(Changes::from_items)
                .transpose()?,
        })
    }
}

/// The operation of a change record. Records at one path come in this order: `delete`, `add`,
/// `modify`, `move` (remote-format.md §8 rule 5).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum ChangeOp {
    Delete,
    Add,
    Modify,
    Move,
}

impl ChangeOp {
    /// The operation as change records write it.
    pub const fn name(self) -> &'static str {
        match self {
            Self::Delete => "delete",
            Self::Add => "add",
            Self::Modify => "modify",
            Self::Move => "move",
        }
    }
}

impl fmt::Display for ChangeOp {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.name())
    }
}

/// One change record (remote-format.md §8): one variant per operation and kind, each with the
/// fields the table of §8 gives it. A record's *from side* is the path whose old entry it
/// covers, its *to side* the path whose new entry it covers.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum Change {
    AddFile {
        path: TreePath,
        new: Side,
    },
    AddDir {
        path: TreePath,
    },
    DeleteFile {
        path: TreePath,
        old: Side,
    },
    DeleteDir {
        path: TreePath,
    },
    /// An in-place change: `old` differs from `new` (rule 4).
    ModifyFile {
        path: TreePath,
        old: Side,
        new: Side,
    },
    /// `from` differs from `path` (rule 4); `old` may equal `new`.
    MoveFile {
        from: TreePath,
        path: TreePath,
        old: Side,
        new: Side,
    },
    /// A folder move, which also covers what moved along unchanged (rule 3).
    MoveDir {
        from: TreePath,
        path: TreePath,
    },
}

impl Change {
    pub fn op(&self) -> ChangeOp {
        match self {
            Self::AddFile { .. } | Self::AddDir { .. } => ChangeOp::Add,
            Self::DeleteFile { .. } | Self::DeleteDir { .. } => ChangeOp::Delete,
            Self::ModifyFile { .. } => ChangeOp::Modify,
            Self::MoveFile { .. } | Self::MoveDir { .. } => ChangeOp::Move,
        }
    }

    pub fn kind(&self) -> EntryKind {
        match self {
            Self::AddFile { .. }
            | Self::DeleteFile { .. }
            | Self::ModifyFile { .. }
            | Self::MoveFile { .. } => EntryKind::File,
            Self::AddDir { .. } | Self::DeleteDir { .. } | Self::MoveDir { .. } => EntryKind::Dir,
        }
    }

    /// The record's `path`: where a move goes, else the path it changes.
    pub fn path(&self) -> &TreePath {
        match self {
            Self::AddFile { path, .. }
            | Self::AddDir { path }
            | Self::DeleteFile { path, .. }
            | Self::DeleteDir { path }
            | Self::ModifyFile { path, .. }
            | Self::MoveFile { path, .. }
            | Self::MoveDir { path, .. } => path,
        }
    }

    /// The from-side path: a move's `from`, the `path` of a delete or modify; `None` for an add.
    pub fn from_path(&self) -> Option<&TreePath> {
        match self {
            Self::MoveFile { from, .. } | Self::MoveDir { from, .. } => Some(from),
            Self::DeleteFile { path, .. }
            | Self::DeleteDir { path }
            | Self::ModifyFile { path, .. } => Some(path),
            Self::AddFile { .. } | Self::AddDir { .. } => None,
        }
    }

    /// The to-side path: the `path` of an add, modify or move; `None` for a delete.
    pub fn to_path(&self) -> Option<&TreePath> {
        match self.op() {
            ChangeOp::Delete => None,
            _ => Some(self.path()),
        }
    }

    /// The file before the change, as the parent's tree holds it at the from-side path.
    pub fn old_side(&self) -> Option<Side> {
        match *self {
            Self::DeleteFile { old, .. }
            | Self::ModifyFile { old, .. }
            | Self::MoveFile { old, .. } => Some(old),
            _ => None,
        }
    }

    /// The file after the change, as the commit's tree holds it at the to-side path.
    pub fn new_side(&self) -> Option<Side> {
        match *self {
            Self::AddFile { new, .. }
            | Self::ModifyFile { new, .. }
            | Self::MoveFile { new, .. } => Some(new),
            _ => None,
        }
    }

    /// Rule 4, the one rule a record breaks on its own.
    fn check(&self) -> Result<(), SchemaError> {
        match self {
            Self::ModifyFile { path, old, new } if old == new => {
                Err(SchemaError::ModifyWithoutChange {
                    path: schema::shown(path.as_str()),
                })
            }
            Self::MoveFile { from, path, .. } | Self::MoveDir { from, path } if from == path => {
                Err(SchemaError::MoveInPlace {
                    path: schema::shown(path.as_str()),
                })
            }
            _ => Ok(()),
        }
    }

    /// The order of rule 5: by `path` in UTF-8 byte order, then by operation.
    fn order_key(&self) -> (&str, ChangeOp) {
        (self.path().as_str(), self.op())
    }

    fn to_value(&self) -> Value {
        let mut members = vec![
            ("kind", Value::from(self.kind().name())),
            ("op", Value::from(self.op().name())),
            ("path", Value::from(self.path().as_str())),
        ];
        if let Self::MoveFile { from, .. } | Self::MoveDir { from, .. } = self {
            members.push(("from", Value::from(from.as_str())));
        }
        if let Some(old) = self.old_side() {
            members.push(("old", side_value(old)));
        }
        if let Some(new) = self.new_side() {
            members.push(("new", side_value(new)));
        }
        schema::object(members)
    }

    /// A record under the table of §8, checked in generate.mjs's order: the operation and kind
    /// and their fields, the path, `from` (rule 4 included), the sides, then rule 4 for a
    /// `modify`.
    fn from_node(value: Node<'_>) -> Result<Self, SchemaError> {
        let members = schema::members(Part::Change, value)?;
        let op = schema::tag(Part::Change, members, "op")?;
        let kind = schema::tag(Part::Change, members, "kind")?;
        let shape = Shape::of(&op, &kind)
            .ok_or_else(|| schema::unknown_kind(Part::Change, &format!("{op} {kind}")))?;
        let mut record = Fields::check(Part::Change, members, shape.fields(), &[])?;
        let path = record.parse("path", TreePath::try_from)?;
        let from = |record: &mut Fields<'_>, path: &TreePath| {
            let from = record.parse("from", TreePath::try_from)?;
            if from == *path {
                return Err(SchemaError::MoveInPlace {
                    path: schema::shown(path.as_str()),
                });
            }
            Ok(from)
        };
        let side = |record: &mut Fields<'_>, field| side_from_node(record.value(field)?);
        let change = match shape {
            Shape::AddFile => Self::AddFile {
                new: side(&mut record, "new")?,
                path,
            },
            Shape::AddDir => Self::AddDir { path },
            Shape::DeleteFile => Self::DeleteFile {
                old: side(&mut record, "old")?,
                path,
            },
            Shape::DeleteDir => Self::DeleteDir { path },
            Shape::ModifyFile => Self::ModifyFile {
                old: side(&mut record, "old")?,
                new: side(&mut record, "new")?,
                path,
            },
            Shape::MoveFile => Self::MoveFile {
                from: from(&mut record, &path)?,
                old: side(&mut record, "old")?,
                new: side(&mut record, "new")?,
                path,
            },
            Shape::MoveDir => Self::MoveDir {
                from: from(&mut record, &path)?,
                path,
            },
        };
        change.check()?;
        Ok(change)
    }
}

/// The operation and kind of a record, which decide its fields (remote-format.md §8).
#[derive(Debug, Clone, Copy)]
enum Shape {
    AddFile,
    AddDir,
    DeleteFile,
    DeleteDir,
    ModifyFile,
    MoveFile,
    MoveDir,
}

impl Shape {
    fn of(op: &str, kind: &str) -> Option<Self> {
        Some(match (op, kind) {
            ("add", "file") => Self::AddFile,
            ("add", "dir") => Self::AddDir,
            ("delete", "file") => Self::DeleteFile,
            ("delete", "dir") => Self::DeleteDir,
            ("modify", "file") => Self::ModifyFile,
            ("move", "file") => Self::MoveFile,
            ("move", "dir") => Self::MoveDir,
            _ => return None,
        })
    }

    fn fields(self) -> &'static [&'static str] {
        match self {
            Self::AddFile => &["kind", "new", "op", "path"],
            Self::AddDir | Self::DeleteDir => &["kind", "op", "path"],
            Self::DeleteFile => &["kind", "old", "op", "path"],
            Self::ModifyFile => &["kind", "new", "old", "op", "path"],
            Self::MoveFile => &["from", "kind", "new", "old", "op", "path"],
            Self::MoveDir => &["from", "kind", "op", "path"],
        }
    }
}

fn side_value(side: Side) -> Value {
    schema::object([
        ("hash", schema::id_value(side.hash)),
        ("size", Value::Int(Int::from(side.size))),
        ("stored", Value::Bool(side.stored)),
    ])
}

fn side_from_node(value: Node<'_>) -> Result<Side, SchemaError> {
    let mut side = Fields::new(Part::Side, value, &["hash", "size", "stored"], &[])?;
    Ok(Side {
        hash: side.id("hash")?,
        size: Size::from(side.int("size")?),
        stored: side.bool("stored")?,
    })
}

/// A commit's change records (remote-format.md §8): 1 to [`MAX_CHANGES`] records in the order of
/// rule 5, each `(path, op)` once, each meeting rule 4. Whether they cover the trees (rules 1–3)
/// is checked against the trees, in `rules`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Changes(Vec<Change>);

impl Changes {
    /// The records in any order, sorted by rule 5. Refuses an empty list, more than
    /// [`MAX_CHANGES`] records (a writer then leaves `changes` out), two records with one path
    /// and operation, and a record that breaks rule 4.
    pub fn new(mut records: Vec<Change>) -> Result<Self, SchemaError> {
        schema::count(records.len(), MAX_CHANGES, Part::Commit, "changes")?;
        records.iter().try_for_each(Change::check)?;
        records.sort_unstable_by(|a, b| a.order_key().cmp(&b.order_key()));
        Self::ordered(records)
    }

    /// The records in the order of rule 5.
    pub fn records(&self) -> &[Change] {
        &self.0
    }

    pub fn into_records(self) -> Vec<Change> {
        self.0
    }

    /// The records as a value of the format: an array.
    pub fn to_value(&self) -> Value {
        Value::Array(self.0.iter().map(Change::to_value).collect())
    }

    /// Records from their value, an array, under the rules of §8 that need no trees, as a commit
    /// reads its `changes`.
    ///
    /// # Panics
    ///
    /// When `value` nests deeper than 16 levels, which no canonical encoding does.
    pub fn from_value(value: Value) -> Result<Self, SchemaError> {
        schema::from_value(&value, |value| match value.as_array() {
            Some(items) => Self::from_items(items),
            None => Err(SchemaError::WrongType {
                part: Part::Commit,
                field: "changes",
                expected: "an array",
            }),
        })
    }

    /// The records of a commit's `changes`: counted, then read one at a time.
    fn from_items(items: Items<'_>) -> Result<Self, SchemaError> {
        schema::count(items.clone().count(), MAX_CHANGES, Part::Commit, "changes")?;
        let records = items
            .map(Change::from_node)
            .collect::<Result<Vec<_>, _>>()?;
        Self::ordered(records)
    }

    fn ordered(records: Vec<Change>) -> Result<Self, SchemaError> {
        schema::ascending(
            &records,
            Change::order_key,
            Part::Commit,
            "changes",
            "path and operation",
        )?;
        Ok(Self(records))
    }
}

/// The blobs a prune commit thins out (remote-format.md §7.5): 1 to [`MAX_PRUNED`] ids in strictly
/// ascending order. That none is a stored file of the commit's own tree is checked against the
/// tree, in `rules`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Pruned(Vec<ObjectId>);

impl Pruned {
    /// The blobs in any order and with repeats, as a set: sorted, each once. Refuses none or more
    /// than [`MAX_PRUNED`].
    pub fn new(ids: impl IntoIterator<Item = ObjectId>) -> Result<Self, SchemaError> {
        let mut ids: Vec<ObjectId> = ids.into_iter().collect();
        ids.sort_unstable();
        ids.dedup();
        schema::count(ids.len(), MAX_PRUNED, Part::Commit, "pruned")?;
        Ok(Self(ids))
    }

    /// The ids in ascending order.
    pub fn ids(&self) -> &[ObjectId] {
        &self.0
    }

    pub fn contains(&self, id: &ObjectId) -> bool {
        self.0.binary_search(id).is_ok()
    }

    fn to_value(&self) -> Value {
        Value::Array(self.0.iter().map(|&id| schema::id_value(id)).collect())
    }

    /// The ids of a prune commit's `pruned`: counted, then read one at a time.
    fn from_items(items: Items<'_>) -> Result<Self, SchemaError> {
        schema::count(items.clone().count(), MAX_PRUNED, Part::Commit, "pruned")?;
        let ids = items
            .map(|item| match item.as_str() {
                Some(text) => ObjectId::parse(&text).map_err(|error| SchemaError::Value {
                    part: Part::Commit,
                    field: "pruned",
                    error,
                }),
                None => Err(SchemaError::WrongType {
                    part: Part::Commit,
                    field: "pruned",
                    expected: "an array of object ids",
                }),
            })
            .collect::<Result<Vec<_>, _>>()?;
        // Text forms sort like the ids' bytes.
        schema::ascending(&ids, |id| *id, Part::Commit, "pruned", "blob")?;
        Ok(Self(ids))
    }
}

#[cfg(test)]
mod tests;
