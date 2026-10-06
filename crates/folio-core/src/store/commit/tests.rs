use std::collections::BTreeMap;

use proptest::prelude::*;

use super::*;
use crate::store::json::{self, JsonError};
use crate::store::{Limit, MAX_OBJECT_SIZE, NameError, Subject, ValueError, strategies};

fn id(byte: u8) -> ObjectId {
    ObjectId::from_bytes([byte; 32])
}

fn path(text: &str) -> TreePath {
    TreePath::parse(text).unwrap()
}

fn side(byte: u8, size: u64, stored: bool) -> Side {
    Side {
        hash: id(byte),
        size: Size::new(size).unwrap(),
        stored,
    }
}

const DEVICE_ID: &str = "8c1e0d2b4a6f43e19d7c5b3a2f1e0d9c";
const TIME: &str = "2026-10-03T21:11:00Z";

fn device() -> Device {
    Device {
        id: DeviceId::parse(DEVICE_ID).unwrap(),
        name: DeviceName::parse("G16").unwrap(),
    }
}

fn message(summary: &str, changes: Option<Vec<Change>>) -> Message {
    Message {
        summary: Summary::parse(summary).unwrap(),
        body: None,
        changes: changes.map(|records| Changes::new(records).unwrap()),
    }
}

fn commit(kind: CommitKind) -> Commit {
    Commit {
        tree: id(1),
        device: device(),
        time: Timestamp::parse(TIME).unwrap(),
        rebased_from: None,
        kind,
    }
}

fn first_commit() -> Commit {
    commit(CommitKind::Commit {
        parent: None,
        message: message(
            "Start history",
            Some(vec![Change::AddDir {
                path: path(".folio"),
            }]),
        ),
    })
}

fn prune_commit() -> Commit {
    commit(CommitKind::Prune {
        parent: id(2),
        pruned: Pruned::new([id(4), id(3)]).unwrap(),
    })
}

fn text(commit: &Commit) -> String {
    String::from_utf8(commit.encode().unwrap().into_bytes()).unwrap()
}

#[test]
fn encodes_a_first_commit() {
    let commit = first_commit();
    let expected = format!(
        "{{\"changes\":[{{\"kind\":\"dir\",\"op\":\"add\",\"path\":\".folio\"}}],\
         \"device\":{{\"id\":\"{DEVICE_ID}\",\"name\":\"G16\"}},\"kind\":\"commit\",\
         \"summary\":\"Start history\",\"time\":\"{TIME}\",\"tree\":\"{}\"}}",
        id(1)
    );
    let encoded = commit.encode().unwrap();
    assert_eq!(std::str::from_utf8(encoded.bytes()), Ok(expected.as_str()));
    assert_eq!(encoded.kind(), ObjectKind::Commit);
    assert_eq!(
        encoded.id(),
        ObjectId::of(ObjectKind::Commit, expected.as_bytes())
    );
    assert_eq!(Commit::parse(expected.as_bytes()), Ok(commit));
}

#[test]
fn encodes_every_optional_field_in_canonical_order() {
    let mut import = commit(CommitKind::Import {
        parent: Some(id(2)),
        message: Message {
            summary: Summary::parse("Changes from iCloud").unwrap(),
            body: Some(Body::parse("Imported \"1\" file.\n\t- 2026 秋\\线性代数").unwrap()),
            changes: None,
        },
    });
    import.rebased_from = Some(id(3));
    let expected = format!(
        "{{\"body\":\"Imported \\\"1\\\" file.\\n\\t- 2026 秋\\\\线性代数\",\
         \"device\":{{\"id\":\"{DEVICE_ID}\",\"name\":\"G16\"}},\"kind\":\"import\",\
         \"parent\":\"{}\",\"rebased_from\":\"{}\",\"summary\":\"Changes from iCloud\",\
         \"time\":\"{TIME}\",\"tree\":\"{}\"}}",
        id(2),
        id(3),
        id(1)
    );
    assert_eq!(text(&import), expected);
    assert_eq!(Commit::parse(expected.as_bytes()), Ok(import));
}

#[test]
fn encodes_a_prune_commit() {
    let prune = prune_commit();
    let expected = format!(
        "{{\"device\":{{\"id\":\"{DEVICE_ID}\",\"name\":\"G16\"}},\"kind\":\"prune\",\
         \"parent\":\"{}\",\"pruned\":[\"{}\",\"{}\"],\"time\":\"{TIME}\",\"tree\":\"{}\"}}",
        id(2),
        id(3),
        id(4),
        id(1)
    );
    assert_eq!(text(&prune), expected);
    assert_eq!(Commit::parse(expected.as_bytes()), Ok(prune));
}

/// One record of each shape of §8's table, in the order of rule 5.
fn every_shape() -> Vec<Change> {
    vec![
        Change::DeleteFile {
            path: path("a"),
            old: side(1, 10, true),
        },
        Change::AddDir { path: path("a") },
        Change::DeleteDir { path: path("b") },
        Change::AddFile {
            path: path("b"),
            new: side(2, 20, false),
        },
        Change::ModifyFile {
            path: path("c"),
            old: side(3, 30, true),
            new: side(3, 30, false),
        },
        Change::MoveFile {
            from: path("x/d"),
            path: path("d"),
            old: side(4, 40, true),
            new: side(4, 40, true),
        },
        Change::MoveDir {
            from: path("x"),
            path: path("e"),
        },
    ]
}

#[test]
fn change_records_have_the_fields_of_their_operation_and_kind() {
    let side_text = |byte: u8, size: u64, stored: bool| {
        format!(
            r#"{{"hash":"{}","size":{size},"stored":{stored}}}"#,
            id(byte)
        )
    };
    let expected = [
        format!(
            r#"{{"kind":"file","old":{},"op":"delete","path":"a"}}"#,
            side_text(1, 10, true)
        ),
        r#"{"kind":"dir","op":"add","path":"a"}"#.to_owned(),
        r#"{"kind":"dir","op":"delete","path":"b"}"#.to_owned(),
        format!(
            r#"{{"kind":"file","new":{},"op":"add","path":"b"}}"#,
            side_text(2, 20, false)
        ),
        format!(
            r#"{{"kind":"file","new":{},"old":{},"op":"modify","path":"c"}}"#,
            side_text(3, 30, false),
            side_text(3, 30, true)
        ),
        format!(
            r#"{{"from":"x/d","kind":"file","new":{},"old":{},"op":"move","path":"d"}}"#,
            side_text(4, 40, true),
            side_text(4, 40, true)
        ),
        r#"{"from":"x","kind":"dir","op":"move","path":"e"}"#.to_owned(),
    ];
    let records = every_shape();
    for (record, expected) in records.iter().zip(&expected) {
        let value = record.to_value();
        assert_eq!(
            std::str::from_utf8(&value.encode()),
            Ok(expected.as_str()),
            "{record:?}"
        );
        assert_eq!(
            schema::from_value(&value, Change::from_node).as_ref(),
            Ok(record)
        );
    }
    let changes = Changes::new(records.clone()).unwrap();
    assert_eq!(changes.records(), &records[..]);
    assert_eq!(
        std::str::from_utf8(&changes.to_value().encode()),
        Ok(format!("[{}]", expected.join(",")).as_str())
    );
    assert_eq!(Changes::from_value(changes.to_value()), Ok(changes.clone()));
    assert_eq!(changes.into_records(), records);
}

#[test]
fn change_records_have_accessors() {
    use ChangeOp::*;
    use EntryKind::*;
    let records = every_shape();
    let summary: Vec<_> = records
        .iter()
        .map(|record| {
            (
                record.op(),
                record.kind(),
                record.path().as_str(),
                record.from_path().map(TreePath::as_str),
                record.to_path().map(TreePath::as_str),
                record.old_side().map(|side| side.size.get()),
                record.new_side().map(|side| side.size.get()),
            )
        })
        .collect();
    assert_eq!(
        summary,
        [
            (Delete, File, "a", Some("a"), None, Some(10), None),
            (Add, Dir, "a", None, Some("a"), None, None),
            (Delete, Dir, "b", Some("b"), None, None, None),
            (Add, File, "b", None, Some("b"), None, Some(20)),
            (Modify, File, "c", Some("c"), Some("c"), Some(30), Some(30)),
            (Move, File, "d", Some("x/d"), Some("d"), Some(40), Some(40)),
            (Move, Dir, "e", Some("x"), Some("e"), None, None),
        ]
    );
    assert_eq!(Move.to_string(), "move");
    assert!(Delete < Add && Add < Modify && Modify < Move);
}

#[test]
fn changes_sort_by_path_bytes_then_operation() {
    let records = vec![
        Change::MoveDir {
            from: path("z"),
            path: path("a/b"),
        },
        Change::AddDir { path: path("a b") },
        Change::AddFile {
            path: path("x"),
            new: side(1, 1, true),
        },
        Change::DeleteFile {
            path: path("x"),
            old: side(2, 1, true),
        },
        Change::AddDir { path: path("B") },
    ];
    let changes = Changes::new(records).unwrap();
    let order: Vec<_> = changes
        .records()
        .iter()
        .map(|record| (record.path().as_str(), record.op()))
        .collect();
    // A space (20) sorts before `/` (2F), upper case before lower case.
    assert_eq!(
        order,
        [
            ("B", ChangeOp::Add),
            ("a b", ChangeOp::Add),
            ("a/b", ChangeOp::Move),
            ("x", ChangeOp::Delete),
            ("x", ChangeOp::Add),
        ]
    );
}

#[test]
fn changes_hold_1_to_100000_records_each_path_and_operation_once() {
    let count = |count| SchemaError::Count {
        part: Part::Commit,
        field: "changes",
        count,
        max: MAX_CHANGES,
    };
    assert_eq!(Changes::new(Vec::new()), Err(count(0)));
    let dirs = |n: usize| -> Vec<Change> {
        (0..n)
            .map(|i| Change::AddDir {
                path: path(&format!("d{i:06}")),
            })
            .collect()
    };
    let most = Changes::new(dirs(MAX_CHANGES)).unwrap();
    assert_eq!(most.records().len(), MAX_CHANGES);
    assert_eq!(
        Changes::new(dirs(MAX_CHANGES + 1)),
        Err(count(MAX_CHANGES + 1))
    );
    // The count is checked before the records, which here are not records at all.
    assert_eq!(
        Changes::from_value(Value::Array(vec![Value::Bool(true); MAX_CHANGES + 1])),
        Err(count(MAX_CHANGES + 1))
    );
    assert_eq!(Changes::from_value(Value::Array(Vec::new())), Err(count(0)));
    assert_eq!(
        Changes::new(vec![
            Change::AddDir { path: path("a") },
            Change::AddFile {
                path: path("a"),
                new: side(1, 1, true),
            },
        ]),
        Err(SchemaError::Duplicate {
            part: Part::Commit,
            field: "changes",
            key: "path and operation",
        })
    );
    // A commit with the most records reads back.
    let largest = commit(CommitKind::Commit {
        parent: Some(id(2)),
        message: Message {
            summary: Summary::parse("Add folders").unwrap(),
            body: None,
            changes: Some(most),
        },
    });
    let encoded = largest.encode().unwrap();
    assert_eq!(Commit::parse(encoded.bytes()), Ok(largest));
}

#[test]
fn changes_meet_rule_4() {
    assert_eq!(
        Changes::new(vec![Change::ModifyFile {
            path: path("a"),
            old: side(1, 1, true),
            new: side(1, 1, true),
        }]),
        Err(SchemaError::ModifyWithoutChange {
            path: "a".to_owned()
        })
    );
    for record in [
        Change::MoveFile {
            from: path("a/b"),
            path: path("a/b"),
            old: side(1, 1, true),
            new: side(2, 1, true),
        },
        Change::MoveDir {
            from: path("a/b"),
            path: path("a/b"),
        },
    ] {
        assert_eq!(
            Changes::new(vec![record]),
            Err(SchemaError::MoveInPlace {
                path: "a/b".to_owned()
            })
        );
    }
    // A move may keep its file unchanged, and a modify may change `stored` alone.
    assert!(Changes::new(every_shape()).is_ok());
}

#[test]
fn pruned_blobs_are_a_set_of_1_to_100000() {
    let pruned = Pruned::new([id(9), id(3), id(9), id(5)]).unwrap();
    assert_eq!(pruned.ids(), [id(3), id(5), id(9)]);
    assert!(pruned.contains(&id(5)));
    assert!(!pruned.contains(&id(4)));
    let count = |count| SchemaError::Count {
        part: Part::Commit,
        field: "pruned",
        count,
        max: MAX_PRUNED,
    };
    assert_eq!(Pruned::new([]), Err(count(0)));
    let ids = |n: u32| {
        (0..n).map(|i| {
            let mut bytes = [0; 32];
            bytes[..4].copy_from_slice(&i.to_be_bytes());
            ObjectId::from_bytes(bytes)
        })
    };
    let most = Pruned::new(ids(MAX_PRUNED as u32)).unwrap();
    assert_eq!(most.ids().len(), MAX_PRUNED);
    assert_eq!(
        Pruned::new(ids(MAX_PRUNED as u32 + 1)),
        Err(count(MAX_PRUNED + 1))
    );
    let largest = commit(CommitKind::Prune {
        parent: id(2),
        pruned: most,
    });
    let encoded = largest.encode().unwrap();
    assert_eq!(Commit::parse(encoded.bytes()), Ok(largest));
}

#[test]
fn commits_have_accessors() {
    let mut first = first_commit();
    assert_eq!(first.parent(), None);
    assert_eq!(first.kind.name(), "commit");
    assert_eq!(first.pruned(), None);
    assert_eq!(
        first.message().map(|message| message.summary.as_str()),
        Some("Start history")
    );
    first.set_parent(id(7));
    assert_eq!(first.parent(), Some(id(7)));
    let mut prune = prune_commit();
    assert_eq!(prune.parent(), Some(id(2)));
    assert_eq!(prune.kind.name(), "prune");
    assert_eq!(prune.message(), None);
    assert_eq!(prune.pruned().map(Pruned::ids), Some(&[id(3), id(4)][..]));
    prune.set_parent(id(8));
    assert_eq!(prune.parent(), Some(id(8)));
    let mut import = commit(CommitKind::Import {
        parent: None,
        message: message("Changes from iCloud", None),
    });
    assert_eq!(import.kind.name(), "import");
    import.set_parent(id(9));
    assert_eq!(import.parent(), Some(id(9)));
}

/// The members of a commit's value, to break one rule at a time.
fn members(commit: &Commit) -> BTreeMap<String, Value> {
    match commit.to_value() {
        Value::Object(members) => members,
        other => panic!("not an object: {other:?}"),
    }
}

fn with(
    mut members: BTreeMap<String, Value>,
    field: &str,
    value: impl Into<Value>,
) -> BTreeMap<String, Value> {
    members.insert(field.to_owned(), value.into());
    members
}

fn without(mut members: BTreeMap<String, Value>, field: &str) -> BTreeMap<String, Value> {
    members.remove(field);
    members
}

fn problem(members: BTreeMap<String, Value>) -> SchemaError {
    Commit::from_value(Value::Object(members)).unwrap_err()
}

fn missing(part: Part, field: &'static str) -> SchemaError {
    SchemaError::MissingField { part, field }
}

fn unknown(part: Part, field: &str) -> SchemaError {
    SchemaError::UnknownField {
        part,
        field: field.to_owned(),
    }
}

fn breaks(part: Part, field: &'static str, error: ValueError) -> SchemaError {
    SchemaError::Value { part, field, error }
}

fn wrong(part: Part, field: &'static str, expected: &'static str) -> SchemaError {
    SchemaError::WrongType {
        part,
        field,
        expected,
    }
}

#[test]
fn a_commit_has_a_known_kind() {
    let commit = members(&first_commit());
    assert_eq!(
        Commit::from_value(Value::Array(Vec::new())),
        Err(SchemaError::NotAnObject(Part::Commit))
    );
    assert_eq!(
        problem(without(commit.clone(), "kind")),
        missing(Part::Commit, "kind")
    );
    assert_eq!(
        problem(with(
            commit.clone(),
            "kind",
            Value::Array(vec![Value::from("commit")])
        )),
        wrong(Part::Commit, "kind", "a string")
    );
    for kind in ["merge", "constructor", "Commit", "toString", ""] {
        assert_eq!(
            problem(with(commit.clone(), "kind", kind)),
            SchemaError::UnknownKind {
                part: Part::Commit,
                kind: kind.to_owned()
            }
        );
    }
}

#[test]
fn a_commit_or_import_has_the_fields_of_its_kind() {
    let part = Part::Commit;
    for kind in ["commit", "import"] {
        let commit = with(members(&first_commit()), "kind", kind);
        for field in ["device", "summary", "time", "tree"] {
            assert_eq!(
                problem(without(commit.clone(), field)),
                missing(part, field),
                "{kind} {field}"
            );
        }
        // `parent`, `body`, `changes` and `rebased_from` are optional.
        let bare = without(commit.clone(), "changes");
        assert!(Commit::from_value(Value::Object(bare)).is_ok(), "{kind}");
        for field in ["pruned", "author", "message"] {
            assert_eq!(
                problem(with(commit.clone(), field, "x")),
                unknown(part, field),
                "{kind} {field}"
            );
        }
    }
}

#[test]
fn a_prune_commit_has_a_parent_and_pruned_blobs_and_no_message() {
    let part = Part::Commit;
    let prune = members(&prune_commit());
    for field in ["device", "parent", "pruned", "time", "tree"] {
        assert_eq!(
            problem(without(prune.clone(), field)),
            missing(part, field),
            "{field}"
        );
    }
    for field in ["summary", "body", "changes"] {
        assert_eq!(
            problem(with(prune.clone(), field, "x")),
            unknown(part, field),
            "{field}"
        );
    }
    let rebased = with(prune, "rebased_from", id(5).to_string());
    assert_eq!(
        Commit::from_value(Value::Object(rebased)).map(|commit| commit.rebased_from),
        Ok(Some(id(5)))
    );
}

#[test]
fn a_commit_names_its_device() {
    let part = Part::Device;
    let commit = members(&first_commit());
    let device =
        |members: BTreeMap<String, Value>| with(commit.clone(), "device", Value::Object(members));
    let valid = match device_value() {
        Value::Object(members) => members,
        _ => unreachable!(),
    };
    assert_eq!(
        problem(with(commit.clone(), "device", "G16")),
        SchemaError::NotAnObject(part)
    );
    assert_eq!(
        problem(device(without(valid.clone(), "id"))),
        missing(part, "id")
    );
    assert_eq!(
        problem(device(without(valid.clone(), "name"))),
        missing(part, "name")
    );
    assert_eq!(
        problem(device(with(valid.clone(), "machine", "x"))),
        unknown(part, "machine")
    );
    let upper = DEVICE_ID.to_uppercase();
    for text in [upper.as_str(), &DEVICE_ID[1..], "", "b3:00"] {
        assert_eq!(
            problem(device(with(valid.clone(), "id", text))),
            breaks(part, "id", ValueError::DeviceId),
            "{text:?}"
        );
    }
    let long = "a".repeat(129);
    for name in ["", " G16", "G16 ", "G\n16", long.as_str()] {
        assert_eq!(
            problem(device(with(valid.clone(), "name", name))),
            breaks(part, "name", ValueError::DeviceName),
            "{name:?}"
        );
    }
    assert_eq!(
        problem(device(with(valid, "name", Value::Int(Int::from(16))))),
        wrong(part, "name", "a string")
    );
}

fn device_value() -> Value {
    device().to_value()
}

#[test]
fn commit_fields_have_their_rules() {
    let part = Part::Commit;
    let commit = members(&first_commit());
    for time in [
        "2026-10-03T21:11:00+00:00",
        "2026-10-03T21:11:00.5Z",
        "2026-10-03 21:11:00Z",
        "1969-12-31T23:59:59Z",
    ] {
        assert_eq!(
            problem(with(commit.clone(), "time", time)),
            breaks(part, "time", ValueError::Time),
            "{time}"
        );
    }
    assert_eq!(
        problem(with(commit.clone(), "time", Int::from(0))),
        wrong(part, "time", "a string")
    );
    let upper = id(0xab).to_string().to_uppercase();
    for field in ["tree", "parent", "rebased_from"] {
        assert_eq!(
            problem(with(commit.clone(), field, upper.as_str())),
            breaks(part, field, ValueError::ObjectId),
            "{field}"
        );
        assert_eq!(
            problem(with(commit.clone(), field, true)),
            wrong(part, field, "a string"),
            "{field}"
        );
    }
    let long = "a".repeat(257);
    for summary in ["", " x", "x ", "a\nb", "a\u{85}b", long.as_str()] {
        assert_eq!(
            problem(with(commit.clone(), "summary", summary)),
            breaks(part, "summary", ValueError::Summary),
            "{summary:?}"
        );
    }
    for body in ["", "details\n", "a\r\nb", "\nx", "x\t", "a\u{0}b"] {
        assert_eq!(
            problem(with(commit.clone(), "body", body)),
            breaks(part, "body", ValueError::Body),
            "{body:?}"
        );
    }
    assert_eq!(
        problem(with(commit, "changes", "x")),
        wrong(part, "changes", "an array")
    );
}

#[test]
fn pruned_blobs_are_ids_in_strictly_ascending_order() {
    let part = Part::Commit;
    let prune = members(&prune_commit());
    let list = |ids: Vec<Value>| with(prune.clone(), "pruned", Value::Array(ids));
    let text = |id: ObjectId| Value::String(id.to_string());
    let count = |count| SchemaError::Count {
        part,
        field: "pruned",
        count,
        max: MAX_PRUNED,
    };
    assert_eq!(problem(list(Vec::new())), count(0));
    assert_eq!(
        problem(list(vec![Value::Bool(true); MAX_PRUNED + 1])),
        count(MAX_PRUNED + 1)
    );
    assert_eq!(
        problem(list(vec![Value::Int(Int::from(5))])),
        wrong(part, "pruned", "an array of object ids")
    );
    assert_eq!(
        problem(list(vec![Value::from("b3:xyz")])),
        breaks(part, "pruned", ValueError::ObjectId)
    );
    assert_eq!(
        problem(list(vec![text(id(4)), text(id(3))])),
        SchemaError::Order {
            part,
            field: "pruned"
        }
    );
    assert_eq!(
        problem(list(vec![text(id(3)), text(id(3))])),
        SchemaError::Duplicate {
            part,
            field: "pruned",
            key: "blob"
        }
    );
    assert_eq!(
        problem(with(prune, "pruned", "x")),
        wrong(part, "pruned", "an array")
    );
}

/// Why a commit with these change records is refused.
fn changes_problem(records: Vec<Value>) -> SchemaError {
    problem(with(
        members(&first_commit()),
        "changes",
        Value::Array(records),
    ))
}

/// A record's members, to break one rule at a time.
fn record(change: &Change) -> BTreeMap<String, Value> {
    match change.to_value() {
        Value::Object(members) => members,
        other => panic!("not an object: {other:?}"),
    }
}

fn one(members: BTreeMap<String, Value>) -> SchemaError {
    changes_problem(vec![Value::Object(members)])
}

#[test]
fn change_records_have_a_known_operation_and_kind() {
    let part = Part::Change;
    let add = record(&Change::AddDir { path: path("a") });
    assert_eq!(
        changes_problem(vec![Value::from("a")]),
        SchemaError::NotAnObject(part)
    );
    assert_eq!(one(without(add.clone(), "op")), missing(part, "op"));
    assert_eq!(one(without(add.clone(), "kind")), missing(part, "kind"));
    assert_eq!(
        one(with(add.clone(), "op", Int::from(1))),
        wrong(part, "op", "a string")
    );
    for (op, kind) in [
        ("copy", "dir"),
        ("add", "link"),
        ("modify", "dir"),
        ("Add", "dir"),
        ("add", "folder"),
    ] {
        assert_eq!(
            one(with(with(add.clone(), "op", op), "kind", kind)),
            SchemaError::UnknownKind {
                part,
                kind: format!("{op} {kind}")
            }
        );
    }
}

#[test]
fn change_records_have_exactly_the_fields_of_their_shape() {
    let part = Part::Change;
    for change in every_shape() {
        let members = record(&change);
        for field in members.keys() {
            let field: &'static str = ["from", "kind", "new", "old", "op", "path"]
                .into_iter()
                .find(|known| *known == field.as_str())
                .unwrap();
            if field != "op" && field != "kind" {
                assert_eq!(
                    one(without(members.clone(), field)),
                    missing(part, field),
                    "{change:?} without {field}"
                );
            }
        }
        for field in ["from", "old", "new", "hash", "size"] {
            if !members.contains_key(field) {
                assert_eq!(
                    one(with(members.clone(), field, "x")),
                    unknown(part, field),
                    "{change:?} with {field}"
                );
            }
        }
    }
    // Keys are compared whole: `new,old` is neither `new` nor `old` (objects.json, joined-keys).
    let modify = record(&every_shape()[4]);
    let joined = with(
        without(without(modify, "new"), "old"),
        "new,old",
        Int::from(0),
    );
    assert_eq!(one(joined), missing(part, "new"));
}

#[test]
fn change_record_paths_follow_the_path_rules() {
    let part = Part::Change;
    let add = record(&Change::AddDir { path: path("a") });
    let long = format!("{}{}", "a/".repeat(16_383), "aa");
    for (text, error) in [
        ("", ValueError::Name(NameError::Empty)),
        ("/a", ValueError::Name(NameError::Empty)),
        ("a//b", ValueError::Name(NameError::Empty)),
        ("a/", ValueError::Name(NameError::Empty)),
        ("a/../b", ValueError::Name(NameError::DotName)),
        ("a\\b", ValueError::Name(NameError::InvalidCharacter('\\'))),
        (long.as_str(), ValueError::PathTooLong),
    ] {
        assert_eq!(
            one(with(add.clone(), "path", text)),
            breaks(part, "path", error),
            "{text:?}"
        );
    }
    let mv = record(&every_shape()[6]);
    assert_eq!(
        one(with(mv.clone(), "from", "x/")),
        breaks(part, "from", ValueError::Name(NameError::Empty))
    );
    assert_eq!(
        one(with(mv, "from", "e")),
        SchemaError::MoveInPlace {
            path: "e".to_owned()
        }
    );
}

#[test]
fn change_record_sides_are_hash_size_and_stored() {
    let part = Part::Side;
    let modify = record(&every_shape()[4]);
    let valid_side = match modify["old"].clone() {
        Value::Object(members) => members,
        _ => unreachable!(),
    };
    let old = |side: BTreeMap<String, Value>| with(modify.clone(), "old", Value::Object(side));
    assert_eq!(
        one(with(modify.clone(), "old", "x")),
        SchemaError::NotAnObject(part)
    );
    for field in ["hash", "size", "stored"] {
        assert_eq!(
            one(old(without(valid_side.clone(), field))),
            missing(part, field)
        );
    }
    assert_eq!(
        one(old(with(valid_side.clone(), "kind", "file"))),
        unknown(part, "kind")
    );
    assert_eq!(
        one(old(with(valid_side.clone(), "hash", "b3:"))),
        breaks(part, "hash", ValueError::ObjectId)
    );
    assert_eq!(
        one(old(with(valid_side.clone(), "size", "30"))),
        wrong(part, "size", "an integer")
    );
    assert_eq!(
        one(old(with(valid_side.clone(), "stored", Int::from(1)))),
        wrong(part, "stored", "true or false")
    );
    // Rule 4: a modify changes its file; a change of `stored` alone counts.
    let same = with(modify, "new", Value::Object(valid_side));
    assert_eq!(
        one(same),
        SchemaError::ModifyWithoutChange {
            path: "c".to_owned()
        }
    );
}

#[test]
fn change_records_are_in_the_order_of_rule_5() {
    let order = SchemaError::Order {
        part: Part::Commit,
        field: "changes",
    };
    let value = |change: Change| change.to_value();
    let delete = |at: &str| value(Change::DeleteDir { path: path(at) });
    let add = |at: &str| value(Change::AddDir { path: path(at) });
    let accepted = |records: Vec<Value>| Changes::from_value(Value::Array(records)).map(drop);
    assert_eq!(accepted(vec![delete("x"), add("x")]), Ok(()));
    assert_eq!(accepted(vec![add("x"), delete("x")]), Err(order.clone()));
    assert_eq!(accepted(vec![add("a b"), add("a/b")]), Ok(()));
    assert_eq!(accepted(vec![add("a/b"), add("a b")]), Err(order.clone()));
    assert_eq!(accepted(vec![add("B"), add("a")]), Ok(()));
    assert_eq!(
        accepted(vec![add("x"), add("x")]),
        Err(SchemaError::Duplicate {
            part: Part::Commit,
            field: "changes",
            key: "path and operation"
        })
    );
    // Every record is checked before the order, as generate.mjs does.
    let copy = Value::Object(with(
        record(&Change::AddDir { path: path("a") }),
        "op",
        "copy",
    ));
    assert_eq!(
        accepted(vec![add("x"), copy]),
        Err(SchemaError::UnknownKind {
            part: Part::Change,
            kind: "copy dir".to_owned()
        })
    );
    assert_eq!(
        Changes::from_value(Value::Bool(true)),
        Err(wrong(Part::Commit, "changes", "an array"))
    );
}

#[test]
fn parses_only_canonical_json() {
    let commit = first_commit();
    let bytes = commit.encode().unwrap().into_bytes();
    let text = std::str::from_utf8(&bytes).unwrap();
    assert_eq!(Commit::parse(&bytes), Ok(commit));
    // `summary` moved before `device`: keys out of order, found at `device`.
    let moved = text
        .replacen("\"summary\":\"Start history\",", "", 1)
        .replacen(
            "\"device\":",
            "\"summary\":\"Start history\",\"device\":",
            1,
        );
    let at_device = moved.find("\"device\"").unwrap();
    for (variant, offset) in [
        (text.replacen(",", ", ", 1), None),
        (format!("{text}\n"), None),
        (
            text.replacen("\"Start history\"", "\"Start\\u0020history\"", 1),
            None,
        ),
        (moved, Some(at_device)),
    ] {
        let offset = offset.unwrap_or_else(|| first_difference(variant.as_bytes(), &bytes));
        assert_eq!(
            Commit::parse(variant.as_bytes()).map(drop),
            Err(Problem::Json(JsonError::NotCanonical { offset })),
            "{variant}"
        );
    }
    let too_large = vec![b' '; MAX_OBJECT_SIZE as usize + 1];
    assert_eq!(
        Commit::parse(&too_large),
        Err(Problem::TooLarge {
            limit: MAX_OBJECT_SIZE
        })
    );
    assert!(json::parse_canonical(br#"{"kind":"prune"}"#).is_ok());
    assert_eq!(
        Commit::parse(br#"{"kind":"prune"}"#),
        Err(Problem::Schema(missing(Part::Commit, "device")))
    );
}

fn first_difference(a: &[u8], b: &[u8]) -> usize {
    a.iter()
        .zip(b)
        .position(|(a, b)| a != b)
        .unwrap_or(a.len().min(b.len()))
}

#[test]
fn a_commit_over_64_mib_is_too_large_to_write() {
    // Two paths of about 97 KiB per record (each name 250 CJK characters, 3 bytes each), so that
    // 350 records take some 68 MB.
    let base = format!("{}/", "台".repeat(250)).repeat(130);
    let records: Vec<Change> = (0..350)
        .map(|i| Change::MoveDir {
            from: path(&format!("{base}f{i:04}")),
            path: path(&format!("{base}t{i:04}")),
        })
        .collect();
    let commit = commit(CommitKind::Commit {
        parent: Some(id(2)),
        message: Message {
            summary: Summary::parse("Move folders").unwrap(),
            body: None,
            changes: Some(Changes::new(records).unwrap()),
        },
    });
    let error = commit.encode().unwrap_err();
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

proptest! {
    #![proptest_config(ProptestConfig::with_cases(48))]

    #[test]
    fn commits_round_trip(commit in strategies::commit()) {
        let encoded = commit.encode().unwrap();
        prop_assert_eq!(encoded.id(), ObjectId::of(ObjectKind::Commit, encoded.bytes()));
        let parsed = Commit::parse(encoded.bytes()).unwrap();
        prop_assert_eq!(&parsed, &commit);
        prop_assert_eq!(parsed.encode().unwrap(), encoded);
        prop_assert_eq!(Commit::from_value(commit.to_value()), Ok(commit));
    }

    #[test]
    fn changes_sort_whatever_order_they_come_in(
        (changes, records) in strategies::changes(12).prop_flat_map(|changes| {
            let records = changes.clone().into_records();
            (Just(changes), Just(records).prop_shuffle())
        })
    ) {
        prop_assert_eq!(Changes::new(records), Ok(changes));
    }

    /// Bytes near a valid commit parse only when they are the canonical encoding of a valid
    /// commit.
    #[test]
    fn only_canonical_commits_parse(
        bytes in strategies::commit()
            .prop_flat_map(|commit| strategies::mutated(commit.encode().unwrap().into_bytes()))
    ) {
        if let Ok(commit) = Commit::parse(&bytes) {
            let encoded = commit.encode().unwrap();
            prop_assert_eq!(encoded.bytes(), &bytes[..]);
        }
    }

    /// Reading a value never panics, and what it accepts it writes back unchanged.
    #[test]
    fn accepted_values_write_back_unchanged(value in strategies::schema_like()) {
        if let Ok(commit) = Commit::from_value(value.clone()) {
            prop_assert_eq!(commit.to_value(), value.clone());
        }
        if let Ok(changes) = Changes::from_value(value.clone()) {
            prop_assert_eq!(changes.to_value(), value);
        }
    }
}
