use std::collections::BTreeMap;

use proptest::prelude::*;

use super::*;
use crate::store::json::{self, JsonError};
use crate::store::{MAX_OBJECT_SIZE, NameError, ValueError, strategies};

fn name(text: &str) -> Name {
    Name::parse(text).unwrap()
}

fn id(byte: u8) -> ObjectId {
    ObjectId::from_bytes([byte; 32])
}

fn side(byte: u8, size: u64, stored: bool) -> Side {
    Side {
        hash: id(byte),
        size: Size::new(size).unwrap(),
        stored,
    }
}

/// The empty tree's id (remote-format-vectors/v1/hashes.json, `empty-tree`).
const EMPTY_TREE: &str = "b3:9b8b2fc76f6386c5507b9f545e0c960472b47ae5c4a4a906b952377ff33460d3";

#[test]
fn an_empty_folder_is_the_empty_tree() {
    let encoded = Tree::default().encode().unwrap();
    assert_eq!(encoded.bytes(), br#"{"entries":[]}"#);
    assert_eq!(encoded.id().to_string(), EMPTY_TREE);
    assert_eq!(encoded.kind(), ObjectKind::Tree);
    assert_eq!(Tree::new(Vec::new()), Ok(Tree::default()));
    assert!(Tree::default().is_empty());
    assert_eq!(Tree::parse(br#"{"entries":[]}"#), Ok(Tree::default()));
}

#[test]
fn encodes_entries_with_their_fields_in_canonical_order() {
    let tree = Tree::new(vec![
        TreeEntry::file(name("报告.docx"), side(0xa3, 1024, true)),
        TreeEntry::dir(name("Projects"), ObjectId::parse(EMPTY_TREE).unwrap()),
        TreeEntry::file(name("hw2.pdf"), side(0xcf, 2048, false)),
    ])
    .unwrap();
    let expected = format!(
        "{{\"entries\":[\
         {{\"hash\":\"{EMPTY_TREE}\",\"kind\":\"dir\",\"name\":\"Projects\"}},\
         {{\"hash\":\"{}\",\"kind\":\"file\",\"name\":\"hw2.pdf\",\"size\":2048,\"stored\":false}},\
         {{\"hash\":\"{}\",\"kind\":\"file\",\"name\":\"报告.docx\",\"size\":1024,\"stored\":true}}\
         ]}}",
        id(0xcf),
        id(0xa3)
    );
    let encoded = tree.encode().unwrap();
    assert_eq!(std::str::from_utf8(encoded.bytes()), Ok(expected.as_str()));
    assert_eq!(
        encoded.id(),
        ObjectId::of(ObjectKind::Tree, expected.as_bytes())
    );
    assert_eq!(Tree::parse(expected.as_bytes()), Ok(tree));
}

#[test]
fn sorts_entries_by_their_utf8_bytes() {
    // UTF-16 would put 😀 (D83D) before Ａ (FF21); UTF-8 puts Ａ (EF BC A1) before 😀 (F0 9F 98 80).
    // Upper case sorts before lower case, and a space before a dot.
    let names = ["😀.md", "a.md", "Ａ.txt", "B.md", "a b", "a.b"];
    let tree = Tree::new(
        names
            .iter()
            .map(|text| TreeEntry::dir(name(text), id(1)))
            .collect(),
    )
    .unwrap();
    let sorted: Vec<&str> = tree.entries().iter().map(|e| e.name().as_str()).collect();
    assert_eq!(sorted, ["B.md", "a b", "a.b", "a.md", "Ａ.txt", "😀.md"]);
}

#[test]
fn names_are_distinct_but_case_twins_are_two_names() {
    assert_eq!(
        Tree::new(vec![
            TreeEntry::file(name("a"), side(1, 1, true)),
            TreeEntry::dir(name("a"), id(2)),
        ]),
        Err(SchemaError::Duplicate {
            part: Part::Tree,
            field: "entries",
            key: "name"
        })
    );
    let twins = Tree::new(vec![
        TreeEntry::dir(name("a"), id(1)),
        TreeEntry::dir(name("A"), id(1)),
    ])
    .unwrap();
    assert_eq!(twins.len(), 2);
}

#[test]
fn finds_entries_by_their_exact_name() {
    let tree = Tree::new(vec![
        TreeEntry::file(name("a.md"), side(1, 1, true)),
        TreeEntry::dir(name("作业"), id(2)),
        TreeEntry::dir(name("B"), id(3)),
    ])
    .unwrap();
    assert_eq!(tree.get("a.md").map(TreeEntry::kind), Some(EntryKind::File));
    assert_eq!(tree.get("作业").map(TreeEntry::id), Some(id(2)));
    assert_eq!(tree.get("B").map(TreeEntry::id), Some(id(3)));
    assert_eq!(tree.get("A.md"), None);
    assert_eq!(tree.get("b"), None);
    assert_eq!(tree.get(""), None);
}

#[test]
fn entries_have_accessors() {
    let file = TreeEntry::file(name("a"), side(1, 5, false));
    assert_eq!(file.name().as_str(), "a");
    assert_eq!(file.kind(), EntryKind::File);
    assert_eq!(file.side(), Some(side(1, 5, false)));
    assert_eq!(file.id(), id(1));
    let dir = TreeEntry::dir(name("d"), id(2));
    assert_eq!(dir.kind(), EntryKind::Dir);
    assert_eq!(dir.side(), None);
    assert_eq!(dir.id(), id(2));
    assert_eq!(EntryKind::Dir.to_string(), "dir");
    assert_eq!(EntryKind::File.name(), "file");
    let tree = Tree::new(vec![dir.clone(), file.clone()]).unwrap();
    assert_eq!(tree.into_entries(), vec![file, dir]);
}

/// The members of a valid file entry and of a valid folder entry, to break one rule at a time.
fn file_entry() -> BTreeMap<String, Value> {
    members(TreeEntry::file(name("a"), side(1, 1, true)).to_value())
}

fn dir_entry() -> BTreeMap<String, Value> {
    members(TreeEntry::dir(name("a"), id(2)).to_value())
}

fn members(value: Value) -> BTreeMap<String, Value> {
    match value {
        Value::Object(members) => members,
        other => panic!("not an object: {other:?}"),
    }
}

fn tree_of(entries: Vec<Value>) -> Value {
    schema::object([("entries", Value::Array(entries))])
}

/// Why a tree of this one entry is refused.
fn problem(entry: BTreeMap<String, Value>) -> SchemaError {
    Tree::from_value(tree_of(vec![Value::Object(entry)])).unwrap_err()
}

fn with(
    mut entry: BTreeMap<String, Value>,
    field: &str,
    value: impl Into<Value>,
) -> BTreeMap<String, Value> {
    entry.insert(field.to_owned(), value.into());
    entry
}

fn without(mut entry: BTreeMap<String, Value>, field: &str) -> BTreeMap<String, Value> {
    entry.remove(field);
    entry
}

#[test]
fn a_tree_is_an_object_of_entries_only() {
    use SchemaError as E;
    assert_eq!(
        Tree::from_value(Value::Array(Vec::new())),
        Err(E::NotAnObject(Part::Tree))
    );
    assert_eq!(
        Tree::from_value(schema::object([])),
        Err(E::MissingField {
            part: Part::Tree,
            field: "entries"
        })
    );
    assert_eq!(
        Tree::from_value(schema::object([
            ("entries", Value::Array(Vec::new())),
            ("mode", Value::Bool(true)),
        ])),
        Err(E::UnknownField {
            part: Part::Tree,
            field: "mode".to_owned()
        })
    );
    assert_eq!(
        Tree::from_value(schema::object([("entries", Value::from("a"))])),
        Err(E::WrongType {
            part: Part::Tree,
            field: "entries",
            expected: "an array"
        })
    );
    assert_eq!(
        Tree::from_value(tree_of(vec![Value::Bool(true)])),
        Err(E::NotAnObject(Part::Entry))
    );
}

#[test]
fn entries_have_exactly_the_fields_of_their_kind() {
    use SchemaError as E;
    let part = Part::Entry;
    assert_eq!(
        problem(without(file_entry(), "kind")),
        E::MissingField {
            part,
            field: "kind"
        }
    );
    assert_eq!(
        problem(with(file_entry(), "kind", true)),
        E::WrongType {
            part,
            field: "kind",
            expected: "a string"
        }
    );
    for kind in ["link", "File", "folder", ""] {
        assert_eq!(
            problem(with(dir_entry(), "kind", kind)),
            E::UnknownKind {
                part,
                kind: kind.to_owned()
            }
        );
    }
    for field in ["hash", "name", "size", "stored"] {
        assert_eq!(
            problem(without(file_entry(), field)),
            E::MissingField { part, field },
            "{field}"
        );
    }
    for field in ["hash", "name"] {
        assert_eq!(
            problem(without(dir_entry(), field)),
            E::MissingField { part, field },
            "{field}"
        );
    }
    // A folder has no size or `stored` (§7.2), and nothing has other fields.
    assert_eq!(
        problem(with(dir_entry(), "size", Int::from(0))),
        E::UnknownField {
            part,
            field: "size".to_owned()
        }
    );
    assert_eq!(
        problem(with(dir_entry(), "stored", true)),
        E::UnknownField {
            part,
            field: "stored".to_owned()
        }
    );
    assert_eq!(
        problem(with(file_entry(), "mode", Int::from(420))),
        E::UnknownField {
            part,
            field: "mode".to_owned()
        }
    );
    // A file entry relabelled as a folder still has the file's fields.
    assert_eq!(
        problem(with(file_entry(), "kind", "dir")),
        E::UnknownField {
            part,
            field: "size".to_owned()
        }
    );
    assert_eq!(
        problem(with(dir_entry(), "kind", "file")),
        E::MissingField {
            part,
            field: "size"
        }
    );
}

#[test]
fn entry_fields_have_their_types_and_rules() {
    use SchemaError as E;
    let part = Part::Entry;
    let upper = format!("b3:{}", "A".repeat(64));
    for (field, value, expected) in [
        ("hash", Value::from(upper.as_str()), None),
        ("hash", Value::from(&EMPTY_TREE[3..]), None),
        ("hash", Value::Int(Int::from(1)), Some("a string")),
        ("size", Value::from("1"), Some("an integer")),
        ("size", Value::Bool(true), Some("an integer")),
        ("stored", Value::Int(Int::from(1)), Some("true or false")),
        ("stored", Value::from("true"), Some("true or false")),
        ("name", Value::Array(Vec::new()), Some("a string")),
    ] {
        let error = problem(with(file_entry(), field, value));
        match expected {
            Some(expected) => assert_eq!(
                error,
                E::WrongType {
                    part,
                    field,
                    expected
                }
            ),
            None => assert_eq!(
                error,
                SchemaError::Value {
                    part,
                    field,
                    error: ValueError::ObjectId
                }
            ),
        }
    }
    let long = "a".repeat(256);
    for (text, rule) in [
        ("", NameError::Empty),
        ("..", NameError::DotName),
        ("a/b", NameError::InvalidCharacter('/')),
        ("con.txt", NameError::ReservedName),
        ("a ", NameError::TrailingDotOrSpace),
        ("e\u{301}", NameError::NotNfc),
        (long.as_str(), NameError::TooLong),
    ] {
        let expected = SchemaError::Value {
            part,
            field: "name",
            error: ValueError::Name(rule),
        };
        assert_eq!(problem(with(file_entry(), "name", text)), expected);
        assert_eq!(problem(with(dir_entry(), "name", text)), expected);
    }
    // Sizes take every integer of the format, 2^53 - 1 included.
    let largest = with(file_entry(), "size", Int::MAX);
    let tree = Tree::from_value(tree_of(vec![Value::Object(largest)])).unwrap();
    assert_eq!(
        tree.entries()[0].side().map(|side| side.size),
        Some(Size::MAX)
    );
}

#[test]
fn entries_are_in_strictly_ascending_order_of_their_names() {
    let entry = |text: &str| Value::Object(with(file_entry(), "name", text));
    for (names, expected) in [
        (vec!["a", "b"], Ok(())),
        (vec!["B.md", "a.md"], Ok(())),
        (vec!["Ａ.txt", "😀.md"], Ok(())),
        (
            vec!["b", "a"],
            Err(SchemaError::Order {
                part: Part::Tree,
                field: "entries",
            }),
        ),
        (
            vec!["😀.md", "Ａ.txt"],
            Err(SchemaError::Order {
                part: Part::Tree,
                field: "entries",
            }),
        ),
        (
            vec!["a", "a"],
            Err(SchemaError::Duplicate {
                part: Part::Tree,
                field: "entries",
                key: "name",
            }),
        ),
    ] {
        let value = tree_of(names.iter().map(|text| entry(text)).collect());
        assert_eq!(Tree::from_value(value).map(drop), expected, "{names:?}");
    }
    // A file and a folder of one name are two entries with one name.
    let value = tree_of(vec![
        Value::Object(dir_entry()),
        Value::Object(file_entry()),
    ]);
    assert_eq!(
        Tree::from_value(value),
        Err(SchemaError::Duplicate {
            part: Part::Tree,
            field: "entries",
            key: "name"
        })
    );
}

#[test]
fn every_entry_is_checked_before_the_order() {
    // As generate.mjs does; reasons are informative, but they should not depend on luck.
    let value = tree_of(vec![
        Value::Object(with(file_entry(), "name", "b")),
        Value::Object(with(file_entry(), "name", "..")),
    ]);
    assert_eq!(
        Tree::from_value(value),
        Err(SchemaError::Value {
            part: Part::Entry,
            field: "name",
            error: ValueError::Name(NameError::DotName)
        })
    );
}

#[test]
fn parses_only_canonical_json_up_to_64_mib() {
    let tree = Tree::new(vec![TreeEntry::file(name("a"), side(1, 1, true))]).unwrap();
    let bytes = tree.encode().unwrap().into_bytes();
    assert_eq!(Tree::parse(&bytes), Ok(tree));
    let text = std::str::from_utf8(&bytes).unwrap();
    for (variant, expected) in [
        (text.replacen(":[", ": [", 1), "not canonical"),
        (text.replacen("true", "null", 1), "null"),
        (format!("\u{feff}{text}"), "a byte order mark"),
        (format!("{text}\n"), "a final line break"),
        (
            text.replacen(r#""size":1"#, r#""size":1.0"#, 1),
            "a fraction",
        ),
    ] {
        assert!(
            matches!(Tree::parse(variant.as_bytes()), Err(Problem::Json(_))),
            "{expected}: {variant}"
        );
    }
    assert_eq!(
        Tree::parse(&bytes[..bytes.len() - 1]),
        Err(Problem::Json(JsonError::Syntax {
            offset: bytes.len() - 1
        }))
    );
    let too_large = vec![b' '; MAX_OBJECT_SIZE as usize + 1];
    assert_eq!(
        Tree::parse(&too_large),
        Err(Problem::TooLarge {
            limit: MAX_OBJECT_SIZE
        })
    );
}

#[test]
fn schema_errors_reach_the_caller_as_problems() {
    let bytes = br#"{"entries":{}}"#;
    assert!(json::parse_canonical(bytes).is_ok());
    assert_eq!(
        Tree::parse(bytes),
        Err(Problem::Schema(SchemaError::WrongType {
            part: Part::Tree,
            field: "entries",
            expected: "an array"
        }))
    );
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(48))]

    #[test]
    fn trees_round_trip(tree in strategies::tree(12)) {
        let encoded = tree.encode().unwrap();
        prop_assert_eq!(encoded.id(), ObjectId::of(ObjectKind::Tree, encoded.bytes()));
        let parsed = Tree::parse(encoded.bytes()).unwrap();
        prop_assert_eq!(&parsed, &tree);
        prop_assert_eq!(parsed.encode().unwrap(), encoded);
        prop_assert_eq!(Tree::from_value(tree.to_value()), Ok(tree));
    }

    #[test]
    fn entries_sort_whatever_order_they_come_in(
        (tree, entries) in strategies::tree(12).prop_flat_map(|tree| {
            let entries = tree.clone().into_entries();
            (Just(tree), Just(entries).prop_shuffle())
        })
    ) {
        prop_assert_eq!(Tree::new(entries), Ok(tree));
    }

    /// Bytes near a valid tree parse only when they are the canonical encoding of a valid tree.
    #[test]
    fn only_canonical_trees_parse(
        bytes in strategies::tree(6)
            .prop_flat_map(|tree| strategies::mutated(tree.encode().unwrap().into_bytes()))
    ) {
        if let Ok(tree) = Tree::parse(&bytes) {
            let encoded = tree.encode().unwrap();
            prop_assert_eq!(encoded.bytes(), &bytes[..]);
        }
    }

    /// Reading a value never panics, and what it accepts it writes back unchanged.
    #[test]
    fn accepted_values_write_back_unchanged(value in strategies::schema_like()) {
        if let Ok(tree) = Tree::from_value(value.clone()) {
            prop_assert_eq!(tree.to_value(), value);
        }
    }
}
