//! What the JSON objects of history format 1 share: the 64 MiB cap of trees and commits
//! (remote-format.md §7.2), their canonical encoding with its id, reading a document whose version
//! comes first (the records of §10, the local `HEAD`), and reading an object against its schema. A
//! reader checks every rule of the version it reads (§3): every required field is there, no other
//! field than the optional ones, each field of the type and value its rule asks for. Nothing is
//! skipped as "probably newer".
//!
//! Objects are read where they lie in their canonical bytes ([`json::Node`]): a reader keeps the
//! few members its schema allows and what it builds from them, so its memory grows with what it
//! has accepted, never with the shape of what it refuses.

use std::borrow::Cow;
use std::cmp::Ordering;
use std::fmt;

use super::id::{ObjectId, ObjectKind};
use super::json::{self, Int, Items, Node, Object, Value};
use super::values::{Count, ValueError};
use super::{Limit, Problem, StoreError, Subject};

/// The largest tree or commit: its canonical JSON is at most 64 MiB (remote-format.md §7.2).
pub const MAX_OBJECT_SIZE: u64 = 64 * 1024 * 1024;

/// The most characters of text from the input (a field's name, a kind, a path) an error keeps.
const SHOWN_CHARS: usize = 40;

/// A tree or commit in its canonical encoding, with the id of exactly these bytes
/// (remote-format.md §4).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Encoded {
    kind: ObjectKind,
    id: ObjectId,
    bytes: Vec<u8>,
}

impl Encoded {
    pub fn kind(&self) -> ObjectKind {
        self.kind
    }

    pub fn id(&self) -> ObjectId {
        self.id
    }

    pub fn bytes(&self) -> &[u8] {
        &self.bytes
    }

    pub fn into_bytes(self) -> Vec<u8> {
        self.bytes
    }
}

/// The canonical encoding of a new tree or commit (`kind`) and its id, refused as
/// [`StoreError::TooLarge`] beyond [`MAX_OBJECT_SIZE`] bytes.
pub(super) fn encode(kind: ObjectKind, value: &Value) -> Result<Encoded, StoreError> {
    let bytes = value.encode();
    if bytes.len() as u64 > MAX_OBJECT_SIZE {
        return Err(StoreError::TooLarge {
            what: Subject::NewObject(kind),
            limit: Limit::Bytes(MAX_OBJECT_SIZE),
        });
    }
    Ok(Encoded {
        kind,
        id: ObjectId::of(kind, &bytes),
        bytes,
    })
}

/// The value of a tree's or commit's bytes: canonical JSON of at most [`MAX_OBJECT_SIZE`] bytes,
/// read where it lies. The size is checked before anything is read.
pub(super) fn decode(bytes: &[u8]) -> Result<Node<'_>, Problem> {
    if bytes.len() as u64 > MAX_OBJECT_SIZE {
        return Err(Problem::TooLarge {
            limit: MAX_OBJECT_SIZE,
        });
    }
    Ok(json::canonical(bytes)?)
}

/// Reads `value` as `read` reads a value of the format from a pack: through its canonical
/// encoding.
///
/// # Panics
///
/// When `value` nests deeper than 16 levels, which no canonical encoding does ([`Value::encode`]).
pub(super) fn from_value<T>(
    value: &Value,
    read: impl FnOnce(Node<'_>) -> Result<T, SchemaError>,
) -> Result<T, SchemaError> {
    let bytes = value.encode();
    read(json::canonical(&bytes).expect("Value::encode writes canonical JSON"))
}

/// The `format_version` a document states (remote-format.md §3, "the version comes first"), from
/// the number [`json::check`] found there, read before any other rule as generate.mjs reads it: a
/// positive integer without a sign, fraction, exponent or leading zero. `None` when the document is
/// not an object with such a member: it is invalid. Any other version than the reader's is newer,
/// whatever else the document holds.
pub(super) fn stated_version(number: Option<&str>) -> Option<&str> {
    number.filter(|text| is_positive_decimal(text))
}

/// Whether `text` writes a positive integer in decimal digits alone, without a leading zero: a
/// stated version, a record's number in its file name.
pub(super) fn is_positive_decimal(text: &str) -> bool {
    text.starts_with(|ch: char| matches!(ch, '1'..='9'))
        && text.bytes().all(|byte| byte.is_ascii_digit())
}

/// The value of a document that states its own version (a record of remote-format.md §10, the
/// local `HEAD`), read in the order §11 reads a record: at most `limit` bytes, checked before
/// anything is read; JSON; the version, where another than `version` is [`StoreError::Newer`]
/// whatever else the document holds; the canonical form. The schema is the caller's. `what` names
/// the document in errors.
pub(super) fn versioned<'a>(
    bytes: &'a [u8],
    limit: u64,
    version: u32,
    what: impl Fn() -> Subject,
) -> Result<Node<'a>, StoreError> {
    let invalid = |problem: Problem| StoreError::Invalid {
        what: what(),
        problem,
    };
    if bytes.len() as u64 > limit {
        return Err(invalid(Problem::TooLarge { limit }));
    }
    let stated = json::check(bytes).map_err(|error| invalid(error.into()))?;
    match stated_version(stated) {
        None => return Err(invalid(Problem::FormatVersion)),
        Some(stated) if stated.parse() == Ok(version) => {}
        Some(stated) => {
            // Shortened like every text an error takes from its input: a record may state a
            // version of millions of digits within its cap.
            return Err(StoreError::Newer {
                what: what(),
                version: shown(stated),
            });
        }
    }
    json::canonical(bytes).map_err(|error| invalid(error.into()))
}

/// The part of an object that breaks its schema.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Part {
    /// A tree (remote-format.md §7.2).
    Tree,
    /// One entry of a tree.
    Entry,
    /// A commit (§7.3).
    Commit,
    /// The `device` of a commit: its id and display name.
    Device,
    /// One change record (§8).
    Change,
    /// The `old` or `new` of a change record.
    Side,
    /// The local history's `HEAD` (versioning.md §4.2).
    Head,
    /// `FORMAT.json` of the remote store (remote-format.md §10.2).
    Format,
    /// A head record of the remote store (§10.3).
    HeadRecord,
    /// One of the packs a head record lists.
    PackRef,
    /// An intent of the remote store (§10.4).
    Intent,
    /// One of the mirror writes an intent lists.
    Write,
}

impl fmt::Display for Part {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::Tree => "the tree",
            Self::Entry => "a tree entry",
            Self::Commit => "the commit",
            Self::Device => "the device",
            Self::Change => "a change record",
            Self::Side => "the old or new side of a change record",
            Self::Head => "HEAD",
            Self::Format => "FORMAT.json",
            Self::HeadRecord => "the head record",
            Self::PackRef => "a pack of the head record",
            Self::Intent => "the intent",
            Self::Write => "a mirror write",
        })
    }
}

/// Why a tree or commit breaks its schema (remote-format.md §7.2, §7.3) or a rule of §8 that
/// needs no trees, when it is read or built. Text from the input is shortened to a few dozen
/// characters.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum SchemaError {
    #[error("{0} is not a JSON object")]
    NotAnObject(Part),
    #[error("{part} has no `{field}`")]
    MissingField { part: Part, field: &'static str },
    /// A field the schema does not have, or does not have for the object's kind.
    #[error("{part} may not have the field {field:?}")]
    UnknownField { part: Part, field: String },
    /// A `kind` (or a change record's `op` and `kind`) that history format 1 does not know.
    #[error("{part} has the unknown kind {kind:?}")]
    UnknownKind { part: Part, kind: String },
    #[error("`{field}` of {part} is not {expected}")]
    WrongType {
        part: Part,
        field: &'static str,
        expected: &'static str,
    },
    /// A string field whose value breaks its rule of §6.
    #[error("`{field}` of {part}: {error}")]
    Value {
        part: Part,
        field: &'static str,
        error: ValueError,
    },
    /// A list with fewer than one or more than `max` items.
    #[error("`{field}` of {part} holds {count} items, not 1 to {max}")]
    Count {
        part: Part,
        field: &'static str,
        count: usize,
        max: usize,
    },
    #[error("`{field}` of {part} is not in strictly ascending order")]
    Order { part: Part, field: &'static str },
    /// Two items of a list with the same `key`: a name, a path and operation, a blob.
    #[error("`{field}` of {part} holds two items with the same {key}")]
    Duplicate {
        part: Part,
        field: &'static str,
        key: &'static str,
    },
    /// A `modify` whose `old` equals its `new` (§8 rule 4).
    #[error("a change record modifies {path:?} without changing it")]
    ModifyWithoutChange { path: String },
    /// A `move` whose `from` equals its `path` (§8 rule 4).
    #[error("a change record moves {path:?} to the path it has")]
    MoveInPlace { path: String },
    /// A head record whose `intent` comes after its own number (§10.3).
    #[error("the head record's intent {intent} comes after its own number {seq}")]
    IntentAfterSeq { intent: Count, seq: Count },
    /// A mirror write inside `.folio/local` or `.folio/store`, under a name NTFS takes for
    /// `.folio`, or one that deletes `.folio` or writes it as a file (§10.4).
    #[error(
        "a mirror write may not touch {path:?}: `.folio` is only ever written as a folder, and \
         nothing inside `.folio/local` or `.folio/store`"
    )]
    FolioWrite { path: String },
}

/// An object of the format read against its schema: [`Fields::check`] makes sure every required
/// field is there and no other than the optional ones, then each field is taken out with its type
/// and rule. It keeps the fields the schema allows, never more.
pub(super) struct Fields<'a> {
    part: Part,
    /// The members the schema allows, in the object's order.
    members: Vec<(&'static str, Node<'a>)>,
}

impl<'a> Fields<'a> {
    /// `value` as an object with every field of `required` and no others than those and
    /// `optional`.
    pub(super) fn new(
        part: Part,
        value: Node<'a>,
        required: &[&'static str],
        optional: &[&'static str],
    ) -> Result<Self, SchemaError> {
        Self::check(part, members(part, value)?, required, optional)
    }

    /// [`Fields::new`] for an object known to be one, after its tag ([`tag`]) chose its fields.
    pub(super) fn check(
        part: Part,
        object: Object<'a>,
        required: &[&'static str],
        optional: &[&'static str],
    ) -> Result<Self, SchemaError> {
        // At most one member for each field: keys are distinct in canonical JSON.
        let mut members = Vec::with_capacity(required.len() + optional.len());
        // The first field the schema does not have, in the order of the keys.
        let mut unknown = None;
        for (key, value) in object.members() {
            let field = required
                .iter()
                .chain(optional)
                .copied()
                .find(|&field| field == key.as_ref());
            match field {
                Some(field) => members.push((field, value)),
                None if unknown.is_none() => unknown = Some(shown(&key)),
                None => {}
            }
        }
        let fields = Self { part, members };
        if let Some(&field) = required.iter().find(|&&field| !fields.has(field)) {
            return Err(SchemaError::MissingField { part, field });
        }
        if let Some(field) = unknown {
            return Err(SchemaError::UnknownField { part, field });
        }
        Ok(fields)
    }

    pub(super) fn has(&self, field: &str) -> bool {
        self.members.iter().any(|&(found, _)| found == field)
    }

    /// A field's value, taken out of the object.
    pub(super) fn value(&mut self, field: &'static str) -> Result<Node<'a>, SchemaError> {
        let part = self.part;
        let index = self
            .members
            .iter()
            .position(|&(found, _)| found == field)
            .ok_or(SchemaError::MissingField { part, field })?;
        Ok(self.members.swap_remove(index).1)
    }

    fn wrong_type(&self, field: &'static str, expected: &'static str) -> SchemaError {
        SchemaError::WrongType {
            part: self.part,
            field,
            expected,
        }
    }

    pub(super) fn string(&mut self, field: &'static str) -> Result<String, SchemaError> {
        match self.value(field)?.as_str() {
            Some(text) => Ok(text.into_owned()),
            None => Err(self.wrong_type(field, "a string")),
        }
    }

    pub(super) fn int(&mut self, field: &'static str) -> Result<Int, SchemaError> {
        match self.value(field)?.as_int() {
            Some(value) => Ok(value),
            None => Err(self.wrong_type(field, "an integer")),
        }
    }

    /// An integer field that a value rule of remote-format.md §6 reads, such as a count.
    pub(super) fn int_with<T>(
        &mut self,
        field: &'static str,
        rule: impl FnOnce(Int) -> Result<T, ValueError>,
    ) -> Result<T, SchemaError> {
        let part = self.part;
        let value = self.int(field)?;
        rule(value).map_err(|error| SchemaError::Value { part, field, error })
    }

    pub(super) fn bool(&mut self, field: &'static str) -> Result<bool, SchemaError> {
        match self.value(field)?.as_bool() {
            Some(value) => Ok(value),
            None => Err(self.wrong_type(field, "true or false")),
        }
    }

    /// An array field, whose items are read one at a time.
    pub(super) fn array(&mut self, field: &'static str) -> Result<Items<'a>, SchemaError> {
        match self.value(field)?.as_array() {
            Some(items) => Ok(items),
            None => Err(self.wrong_type(field, "an array")),
        }
    }

    /// A string field that a value rule of remote-format.md §6 reads.
    pub(super) fn parse<T>(
        &mut self,
        field: &'static str,
        rule: impl FnOnce(String) -> Result<T, ValueError>,
    ) -> Result<T, SchemaError> {
        let part = self.part;
        let text = self.string(field)?;
        rule(text).map_err(|error| SchemaError::Value { part, field, error })
    }

    /// An object id (§4) in its text form.
    pub(super) fn id(&mut self, field: &'static str) -> Result<ObjectId, SchemaError> {
        let part = self.part;
        match self.value(field)?.as_str() {
            Some(text) => {
                ObjectId::parse(&text).map_err(|error| SchemaError::Value { part, field, error })
            }
            None => Err(self.wrong_type(field, "a string")),
        }
    }

    /// An optional field, read by `read` when the object has it.
    pub(super) fn optional<T>(
        &mut self,
        field: &'static str,
        read: impl FnOnce(&mut Self, &'static str) -> Result<T, SchemaError>,
    ) -> Result<Option<T>, SchemaError> {
        if self.has(field) {
            read(self, field).map(Some)
        } else {
            Ok(None)
        }
    }
}

/// `value` as an object, or why it is not one.
pub(super) fn members(part: Part, value: Node<'_>) -> Result<Object<'_>, SchemaError> {
    value.as_object().ok_or(SchemaError::NotAnObject(part))
}

/// The text of the member that decides which fields an object has (`kind`, a change record's
/// `op`), read before [`Fields::check`].
pub(super) fn tag<'a>(
    part: Part,
    members: Object<'a>,
    field: &'static str,
) -> Result<Cow<'a, str>, SchemaError> {
    let value = members
        .get(field)
        .ok_or(SchemaError::MissingField { part, field })?;
    value.as_str().ok_or(SchemaError::WrongType {
        part,
        field,
        expected: "a string",
    })
}

/// A kind the format does not know.
pub(super) fn unknown_kind(part: Part, kind: &str) -> SchemaError {
    SchemaError::UnknownKind {
        part,
        kind: shown(kind),
    }
}

/// Checks that `items` are in strictly ascending order of `key`; equal neighbours are reported as
/// duplicates of `what`.
pub(super) fn ascending<'a, T, K: Ord>(
    items: &'a [T],
    key: impl Fn(&'a T) -> K,
    part: Part,
    field: &'static str,
    what: &'static str,
) -> Result<(), SchemaError> {
    for pair in items.windows(2) {
        match key(&pair[0]).cmp(&key(&pair[1])) {
            Ordering::Less => {}
            Ordering::Equal => {
                return Err(SchemaError::Duplicate {
                    part,
                    field,
                    key: what,
                });
            }
            Ordering::Greater => return Err(SchemaError::Order { part, field }),
        }
    }
    Ok(())
}

/// The number of items of a list that holds 1 to `max`.
pub(super) fn count(
    items: usize,
    max: usize,
    part: Part,
    field: &'static str,
) -> Result<(), SchemaError> {
    if (1..=max).contains(&items) {
        Ok(())
    } else {
        Err(SchemaError::Count {
            part,
            field,
            count: items,
            max,
        })
    }
}

/// An object of the format from its members in any order: canonical JSON sorts them.
pub(super) fn object(members: impl IntoIterator<Item = (&'static str, Value)>) -> Value {
    Value::Object(
        members
            .into_iter()
            .map(|(key, value)| (key.to_owned(), value))
            .collect(),
    )
}

/// An object id in its text form.
pub(super) fn id_value(id: ObjectId) -> Value {
    Value::String(id.to_string())
}

/// A short copy of text from the input, for an error.
pub(super) fn shown(text: &str) -> String {
    let mut chars = text.chars();
    let mut out: String = chars.by_ref().take(SHOWN_CHARS).collect();
    if chars.next().is_some() {
        out.push('…');
    }
    out
}

#[cfg(test)]
mod tests {
    use std::path::{Path, PathBuf};

    use super::*;
    use crate::store::{JsonError, NameError};

    #[test]
    fn encodes_objects_up_to_64_mib() {
        // {"x":"…"} is 8 bytes besides the string's content.
        let object_of = |len: u64| object([("x", Value::String("a".repeat(len as usize - 8)))]);
        let largest = object_of(MAX_OBJECT_SIZE);
        let encoded = encode(ObjectKind::Tree, &largest).unwrap();
        assert_eq!(encoded.bytes().len() as u64, MAX_OBJECT_SIZE);
        assert_eq!(encoded.kind(), ObjectKind::Tree);
        assert_eq!(
            encoded.id(),
            ObjectId::of(ObjectKind::Tree, encoded.bytes())
        );
        let error = encode(ObjectKind::Commit, &object_of(MAX_OBJECT_SIZE + 1)).unwrap_err();
        assert!(
            matches!(
                error,
                StoreError::TooLarge {
                    what: Subject::NewObject(ObjectKind::Commit),
                    limit: Limit::Bytes(MAX_OBJECT_SIZE),
                }
            ),
            "{error:?}"
        );
    }

    #[test]
    fn decodes_canonical_json_up_to_64_mib() {
        assert_eq!(
            decode(br#"{"a":1}"#).map(Node::to_value),
            Ok(object([("a", Int::from(1).into())]))
        );
        assert_eq!(
            decode(b"{\"a\": 1}").map(drop),
            Err(Problem::Json(JsonError::NotCanonical { offset: 5 }))
        );
        // 64 MiB is read (here: it is not canonical); one byte more is refused unread.
        let mut bytes = vec![b' '; MAX_OBJECT_SIZE as usize];
        assert!(matches!(decode(&bytes), Err(Problem::Json(_))));
        bytes.push(b' ');
        assert_eq!(
            decode(&bytes).map(drop),
            Err(Problem::TooLarge {
                limit: MAX_OBJECT_SIZE
            })
        );
    }

    #[test]
    fn values_are_read_through_their_encoding() {
        let value = object([("b", Value::Bool(true)), ("a", Value::from("x"))]);
        let read = |node: Node<'_>| Ok(node.as_object().map(|object| object.members().count()));
        assert_eq!(from_value(&value, read), Ok(Some(2)));
        let wrong = |_: Node<'_>| Err::<(), _>(SchemaError::NotAnObject(Part::Tree));
        assert_eq!(
            from_value(&value, wrong),
            Err(SchemaError::NotAnObject(Part::Tree))
        );
    }

    /// The value of a canonical document.
    fn fields(json: &str) -> Node<'_> {
        json::canonical(json.as_bytes()).unwrap()
    }

    #[test]
    fn fields_are_required_or_optional_and_nothing_else() {
        let value = fields(r#"{"a":"x","b":1,"c":true}"#);
        let mut checked = Fields::new(Part::Tree, value, &["a", "b"], &["c", "d"]).unwrap();
        assert_eq!(checked.string("a"), Ok("x".to_owned()));
        assert_eq!(checked.int("b"), Ok(Int::from(1)));
        assert_eq!(checked.optional("c", Fields::bool), Ok(Some(true)));
        assert_eq!(checked.optional("d", Fields::bool), Ok(None));
        // A field is taken out once.
        assert_eq!(
            checked.string("a"),
            Err(SchemaError::MissingField {
                part: Part::Tree,
                field: "a"
            })
        );
        assert_eq!(
            Fields::new(Part::Commit, value, &["a", "b", "e"], &["c"]).err(),
            Some(SchemaError::MissingField {
                part: Part::Commit,
                field: "e"
            })
        );
        assert_eq!(
            Fields::new(Part::Side, value, &["a", "b"], &[]).err(),
            Some(SchemaError::UnknownField {
                part: Part::Side,
                field: "c".to_owned()
            })
        );
        // The first unknown field in the order of the keys is reported, after any missing one.
        let many = fields(r#"{"a":1,"m":2,"n":3,"z":4}"#);
        assert_eq!(
            Fields::new(Part::Side, many, &["a", "z"], &[]).err(),
            Some(SchemaError::UnknownField {
                part: Part::Side,
                field: "m".to_owned()
            })
        );
        assert_eq!(
            Fields::new(Part::Side, many, &["a", "b"], &[]).err(),
            Some(SchemaError::MissingField {
                part: Part::Side,
                field: "b"
            })
        );
        assert_eq!(
            Fields::new(Part::Entry, fields("true"), &[], &[]).err(),
            Some(SchemaError::NotAnObject(Part::Entry))
        );
    }

    #[test]
    fn fields_have_types() {
        let value = fields(r#"{"a":"x","b":1,"c":true,"d":[]}"#);
        let all = &["a", "b", "c", "d"];
        let wrong = |field: &'static str, expected: &'static str| SchemaError::WrongType {
            part: Part::Change,
            field,
            expected,
        };
        let mut checked = Fields::new(Part::Change, value, all, &[]).unwrap();
        assert_eq!(checked.int("a"), Err(wrong("a", "an integer")));
        assert_eq!(checked.bool("b"), Err(wrong("b", "true or false")));
        assert_eq!(checked.array("c").map(drop), Err(wrong("c", "an array")));
        assert_eq!(checked.string("d"), Err(wrong("d", "a string")));
        let mut checked = Fields::new(Part::Change, value, all, &[]).unwrap();
        assert_eq!(checked.array("d").map(Iterator::count), Ok(0));
        assert_eq!(
            checked.id("a"),
            Err(SchemaError::Value {
                part: Part::Change,
                field: "a",
                error: ValueError::ObjectId
            })
        );
        assert_eq!(checked.id("b"), Err(wrong("b", "a string")));
    }

    #[test]
    fn tags_are_strings_read_before_the_fields() {
        let object = members(Part::Change, fields(r#"{"kind":"file","op":3}"#)).unwrap();
        assert_eq!(tag(Part::Change, object, "kind").as_deref(), Ok("file"));
        assert_eq!(
            tag(Part::Change, object, "op"),
            Err(SchemaError::WrongType {
                part: Part::Change,
                field: "op",
                expected: "a string"
            })
        );
        for absent in ["path", "a", "zz"] {
            assert_eq!(
                tag(Part::Change, object, absent),
                Err(SchemaError::MissingField {
                    part: Part::Change,
                    field: absent
                })
            );
        }
        assert_eq!(
            members(Part::Change, fields("[]")).map(drop),
            Err(SchemaError::NotAnObject(Part::Change))
        );
    }

    #[test]
    fn lists_are_ascending_and_counted() {
        let check = |items: &[u32]| ascending(items, |item| *item, Part::Commit, "pruned", "blob");
        assert_eq!(check(&[]), Ok(()));
        assert_eq!(check(&[1, 2, 5]), Ok(()));
        assert_eq!(
            check(&[1, 1, 0]),
            Err(SchemaError::Duplicate {
                part: Part::Commit,
                field: "pruned",
                key: "blob"
            })
        );
        assert_eq!(
            check(&[2, 1, 1]),
            Err(SchemaError::Order {
                part: Part::Commit,
                field: "pruned"
            })
        );
        assert_eq!(count(1, 3, Part::Commit, "changes"), Ok(()));
        assert_eq!(count(3, 3, Part::Commit, "changes"), Ok(()));
        for items in [0, 4] {
            assert_eq!(
                count(items, 3, Part::Commit, "changes"),
                Err(SchemaError::Count {
                    part: Part::Commit,
                    field: "changes",
                    count: items,
                    max: 3
                })
            );
        }
    }

    #[test]
    fn errors_keep_a_short_copy_of_the_input() {
        assert_eq!(shown("mode"), "mode");
        let long = "台".repeat(41);
        assert_eq!(shown(&long), format!("{}…", "台".repeat(40)));
        assert_eq!(shown(&long[..120]), "台".repeat(40));
        assert_eq!(
            unknown_kind(Part::Entry, "link").to_string(),
            "a tree entry has the unknown kind \"link\""
        );
        assert_eq!(
            SchemaError::Value {
                part: Part::Entry,
                field: "name",
                error: ValueError::Name(NameError::DotName),
            }
            .to_string(),
            "`name` of a tree entry: `.` and `..` are not names"
        );
    }

    #[test]
    fn the_stated_version_is_a_positive_integer() {
        for (text, expected) in [
            (r#"{"format_version":1}"#, Some("1")),
            (r#"{"format_version":2,"x":null}"#, Some("2")),
            (
                "{\n  \"format_version\": 123456789012345678901\n}",
                Some("123456789012345678901"),
            ),
            (r#"{"format_version":0}"#, None),
            (r#"{"format_version":-1}"#, None),
            (r#"{"format_version":1.0}"#, None),
            (r#"{"format_version":1e0}"#, None),
            (r#"{"format_version":"1"}"#, None),
            (r#"{"format_version":null}"#, None),
            (r#"{"version":1}"#, None),
            ("[1]", None),
            ("1", None),
        ] {
            let number = json::check(text.as_bytes()).unwrap();
            assert_eq!(stated_version(number), expected, "{text}");
        }
    }

    /// The order of §11 for a record: the size cap, JSON, the version, the canonical form; the
    /// first step that fails decides.
    #[test]
    fn versioned_documents_are_read_version_first() {
        let what = || Subject::Head(PathBuf::from("HEAD"));
        let read =
            |text: &str, limit: u64| versioned(text.as_bytes(), limit, 1, what).map(Node::to_value);
        let problem = |result: Result<Value, StoreError>| match result {
            Err(StoreError::Invalid {
                what: Subject::Head(path),
                problem,
            }) if path == Path::new("HEAD") => problem,
            other => panic!("{other:?}"),
        };
        assert_eq!(
            read(r#"{"format_version":1,"x":true}"#, 29).unwrap(),
            fields(r#"{"format_version":1,"x":true}"#).to_value()
        );
        // The cap comes first: one byte over it is refused unread, even when it would be newer.
        assert_eq!(
            problem(read(r#"{"format_version":2,"x":true}"#, 28)),
            Problem::TooLarge { limit: 28 }
        );
        // Then JSON, then the version: newer whatever else the document holds, also not canonical.
        assert!(matches!(
            problem(read(r#"{"format_version":2,}"#, 64)),
            Problem::Json(JsonError::Syntax { .. })
        ));
        for newer in [
            "{\n \"format_version\": 2, \"x\": null\n}\n",
            r#"{"x":[],"format_version":99999999999999999999}"#,
        ] {
            match read(newer, 64) {
                Err(StoreError::Newer {
                    what: subject,
                    version,
                }) => {
                    assert_eq!(subject, what());
                    assert!(newer.contains(&version), "{version}");
                }
                other => panic!("{newer}: {other:?}"),
            }
        }
        // A version of any length within the cap is newer, and the error keeps a few dozen of its
        // characters, as every error that quotes its input does.
        let long = format!(r#"{{"format_version":{}}}"#, "7".repeat(100_000));
        match read(&long, 200_000) {
            Err(StoreError::Newer { version, .. }) => {
                assert_eq!(version, format!("{}…", "7".repeat(SHOWN_CHARS)));
            }
            other => panic!("{other:?}"),
        }
        for unstated in [
            r#"{"format_version":0}"#,
            r#"{"format_version":"1"}"#,
            "[1]",
        ] {
            assert_eq!(
                problem(read(unstated, 64)),
                Problem::FormatVersion,
                "{unstated}"
            );
        }
        // Version 1 must then be canonical.
        assert_eq!(
            problem(read(r#"{"format_version": 1}"#, 64)),
            Problem::Json(JsonError::NotCanonical { offset: 18 })
        );
        assert_eq!(
            problem(read(r#"{"format_version":1,"x":null}"#, 64)),
            Problem::Json(JsonError::Null)
        );
    }
}
