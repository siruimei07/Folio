use std::io;
use std::path::Path;

use proptest::prelude::*;

use super::*;
use crate::store::json::JsonError;
use crate::store::{DeviceName, MemorySink, NameError, PackWriter, strategies};

const LIBRARY: &str = "48ffdfb335860f2c15c8bccf2a90e720";
const DEVICE: &str = "8c1e0d2b4a6f43e19d7c5b3a2f1e0d9c";
const OTHER_DEVICE: &str = "3f2c9a7d1e5b40c8a6d2f9e1b7c3a5d0";
const TIME: &str = "2026-10-04T08:00:00Z";
const FORMAT_PATH: &str = ".folio/store/FORMAT.json";

fn library_id() -> LibraryId {
    LibraryId::parse(LIBRARY).unwrap()
}

fn device() -> Device {
    Device {
        id: DeviceId::parse(DEVICE).unwrap(),
        name: DeviceName::parse("G16").unwrap(),
    }
}

fn count(value: u64) -> Count {
    Count::new(value).unwrap()
}

fn id(byte: u8) -> ObjectId {
    ObjectId::from_bytes([byte; 32])
}

fn pack(byte: u8, size: u64) -> PackRef {
    PackRef {
        name: PackName::from_bytes([byte; 32]),
        size: Size::new(size).unwrap(),
    }
}

fn path(text: &str) -> TreePath {
    TreePath::parse(text).unwrap()
}

fn head_path(seq: u64) -> String {
    format!(".folio/store/heads/{DEVICE}/{seq}.json")
}

fn intent_path(seq: u64) -> String {
    format!(".folio/store/intents/{DEVICE}/{seq}.json")
}

/// Device G16's second push: head record 2 with intent 2 and one pack.
fn head_record() -> HeadRecord {
    HeadRecord {
        library_id: library_id(),
        device: device(),
        seq: count(2),
        lamport: count(2),
        head: id(0xb1),
        intent: count(2),
        packs: PackRefs::new(vec![pack(0x46, 6251)]).unwrap(),
        time: Timestamp::parse(TIME).unwrap(),
    }
}

/// Device G16's intent 2 with `writes`.
fn intent_record(writes: Vec<MirrorWrite>) -> IntentRecord {
    IntentRecord {
        library_id: library_id(),
        device: device(),
        seq: count(2),
        time: Timestamp::parse(TIME).unwrap(),
        base: Some(id(0x43)),
        head: id(0xb1),
        writes: MirrorWrites::new(writes).unwrap(),
    }
}

fn write_file(text: &str) -> MirrorWrite {
    MirrorWrite::WriteFile {
        path: path(text),
        hash: id(7),
    }
}

fn write_dir(text: &str) -> MirrorWrite {
    MirrorWrite::WriteDir { path: path(text) }
}

fn delete_file(text: &str) -> MirrorWrite {
    MirrorWrite::DeleteFile { path: path(text) }
}

fn delete_dir(text: &str) -> MirrorWrite {
    MirrorWrite::DeleteDir { path: path(text) }
}

/// A record of any kind read from `bytes` at `path`, as `()`: the outcome is what matters here.
fn parse(kind: RecordKind, bytes: &[u8], path: &str) -> Result<(), StoreError> {
    match kind {
        RecordKind::Format => FormatRecord::parse(bytes, path).map(drop),
        RecordKind::Head => HeadRecord::parse(bytes, path).map(drop),
        RecordKind::Intent => IntentRecord::parse(bytes, path).map(drop),
    }
}

/// [`parse`] through `read`.
fn read(kind: RecordKind, source: impl io::Read, path: &str) -> Result<(), StoreError> {
    match kind {
        RecordKind::Format => FormatRecord::read(source, path).map(drop),
        RecordKind::Head => HeadRecord::read(source, path).map(drop),
        RecordKind::Intent => IntentRecord::read(source, path).map(drop),
    }
}

/// A path where a record of `kind` may lie.
fn path_of(kind: RecordKind) -> String {
    match kind {
        RecordKind::Format => FORMAT_PATH.to_owned(),
        RecordKind::Head => head_path(2),
        RecordKind::Intent => intent_path(2),
    }
}

const KINDS: [RecordKind; 3] = [RecordKind::Format, RecordKind::Head, RecordKind::Intent];

/// Why a record read at `path` is invalid; anything else fails the test.
fn problem<T: fmt::Debug>(result: Result<T, StoreError>, kind: RecordKind, path: &str) -> Problem {
    match result {
        Err(StoreError::Invalid {
            what:
                Subject::Record {
                    kind: found,
                    path: at,
                },
            problem,
        }) if found == kind && at == path => problem,
        other => panic!("{kind} at {path}: {other:?}"),
    }
}

/// The schema error that makes `value`, as canonical bytes, an invalid head record at `path`.
fn head_error(value: &Value, path: &str) -> SchemaError {
    match problem(
        HeadRecord::parse(&value.encode(), path),
        RecordKind::Head,
        path,
    ) {
        Problem::Schema(error) => error,
        other => panic!("{other:?}"),
    }
}

/// The schema error that makes `value` an invalid intent at intent 2's path.
fn intent_error(value: &Value) -> SchemaError {
    let at = intent_path(2);
    match problem(
        IntentRecord::parse(&value.encode(), &at),
        RecordKind::Intent,
        &at,
    ) {
        Problem::Schema(error) => error,
        other => panic!("{other:?}"),
    }
}

/// `value`, an object, with `key` set to `member`.
fn with(value: &Value, key: &str, member: Value) -> Value {
    let mut members = value.as_object().expect("an object").clone();
    members.insert(key.to_owned(), member);
    Value::Object(members)
}

/// `value`, an object, without `key`.
fn without(value: &Value, key: &str) -> Value {
    let mut members = value.as_object().expect("an object").clone();
    members.remove(key);
    Value::Object(members)
}

fn int(value: u64) -> Value {
    Value::Int(Int::new(value).unwrap())
}

#[test]
fn records_have_caps_of_4_kib_1_mib_and_64_mib() {
    assert_eq!(RecordKind::Format.limit(), 4_096);
    assert_eq!(RecordKind::Head.limit(), 1_048_576);
    assert_eq!(RecordKind::Intent.limit(), 67_108_864);
    assert_eq!(MAX_PACK_REFS, 1_000);
    assert_eq!(MIN_PACK_LEN, 150);
}

#[test]
fn record_paths_name_the_kind_the_device_and_the_number() {
    let device = DeviceId::parse(DEVICE).unwrap();
    let paths = [
        (FORMAT_PATH.to_owned(), RecordPath::Format),
        (
            head_path(1),
            RecordPath::Head {
                device: device.clone(),
                seq: count(1),
            },
        ),
        (
            intent_path(42),
            RecordPath::Intent {
                device: device.clone(),
                seq: count(42),
            },
        ),
        (
            head_path(Count::MAX.get()),
            RecordPath::Head {
                device: device.clone(),
                seq: Count::MAX,
            },
        ),
    ];
    for (text, record_path) in &paths {
        assert_eq!(
            RecordPath::parse(text).as_ref(),
            Some(record_path),
            "{text}"
        );
        assert_eq!(record_path.to_string(), *text);
    }
    let kinds: Vec<RecordKind> = paths.iter().map(|(_, path)| path.kind()).collect();
    assert_eq!(
        kinds,
        [
            RecordKind::Format,
            RecordKind::Head,
            RecordKind::Intent,
            RecordKind::Head
        ]
    );
    let not_records = [
        ".folio/store/FORMAT 2.json".to_owned(),
        ".folio/store/format.json".to_owned(),
        ".folio/store/FORMAT.JSON".to_owned(),
        ".folio/store/FORMAT.json/".to_owned(),
        "folio/store/FORMAT.json".to_owned(),
        "/.folio/store/FORMAT.json".to_owned(),
        "./.folio/store/FORMAT.json".to_owned(),
        ".folio\\store\\FORMAT.json".to_owned(),
        ".FOLIO/store/FORMAT.json".to_owned(),
        ".folio/Store/FORMAT.json".to_owned(),
        String::new(),
        head_path(0),
        format!(".folio/store/heads/{DEVICE}/02.json"),
        format!(".folio/store/heads/{DEVICE}/2.JSON"),
        format!(".folio/store/heads/{DEVICE}/2"),
        format!(".folio/store/heads/{DEVICE}/2.json.json"),
        format!(".folio/store/heads/{DEVICE}/+2.json"),
        format!(".folio/store/heads/{DEVICE}/-2.json"),
        format!(".folio/store/heads/{DEVICE}/ 2.json"),
        format!(".folio/store/heads/{DEVICE}/42 2.json"),
        format!(".folio/store/heads/{DEVICE}/.DS_Store"),
        format!(".folio/store/heads/{DEVICE}/1/2.json"),
        format!(".folio/store/heads/{DEVICE}/2.json/"),
        head_path(Count::MAX.get() + 1),
        format!(".folio/store/heads/{DEVICE}/99999999999999999999999.json"),
        format!(".folio/store/heads/{}/1.json", DEVICE.to_uppercase()),
        format!(".folio/store/heads/{}/1.json", &DEVICE[1..]),
        format!(".folio/store/heads/{DEVICE}0/1.json"),
        format!(".folio/store/head/{DEVICE}/1.json"),
        format!(".folio/store/Heads/{DEVICE}/1.json"),
        format!(".folio/store/packs/{DEVICE}/1.json"),
        ".folio/store/heads//1.json".to_owned(),
        format!(".folio/store/heads/{DEVICE}.json"),
        format!(".folio/store/heads/{DEVICE}"),
    ];
    for text in not_records {
        assert_eq!(RecordPath::parse(&text), None, "{text:?}");
    }
}

#[test]
fn record_paths_lie_under_the_remote_name_by_name() {
    let path = RecordPath::Intent {
        device: DeviceId::parse(DEVICE).unwrap(),
        seq: count(3),
    };
    let expected = Path::new(r"C:\remote")
        .join(".folio")
        .join("store")
        .join("intents")
        .join(DEVICE)
        .join("3.json");
    assert_eq!(path.to_path(Path::new(r"C:\remote")), expected);
    let verbatim = path.to_path(Path::new(r"\\?\C:\remote"));
    assert_eq!(
        verbatim.as_os_str(),
        format!(r"\\?\C:\remote\.folio\store\intents\{DEVICE}\3.json").as_str()
    );
    assert_eq!(
        RecordPath::Format.to_path(Path::new(r"C:\remote")),
        Path::new(r"C:\remote\.folio\store\FORMAT.json")
    );
}

#[test]
fn format_records_hold_the_library_id() {
    let record = FormatRecord {
        library_id: library_id(),
    };
    let bytes = record.encode();
    assert_eq!(
        bytes,
        format!(r#"{{"format_version":1,"library_id":"{LIBRARY}"}}"#).as_bytes()
    );
    assert_eq!(record.path(), RecordPath::Format);
    assert_eq!(FormatRecord::parse(&bytes, FORMAT_PATH).unwrap(), record);
    assert_eq!(FormatRecord::read(&bytes[..], FORMAT_PATH).unwrap(), record);
    let value = record.to_value();
    let schema_error = |value: &Value| match problem(
        FormatRecord::parse(&value.encode(), FORMAT_PATH),
        RecordKind::Format,
        FORMAT_PATH,
    ) {
        Problem::Schema(error) => error,
        other => panic!("{other:?}"),
    };
    assert_eq!(
        schema_error(&without(&value, "library_id")),
        SchemaError::MissingField {
            part: Part::Format,
            field: "library_id"
        }
    );
    assert_eq!(
        schema_error(&with(&value, "created", Value::from(TIME))),
        SchemaError::UnknownField {
            part: Part::Format,
            field: "created".to_owned()
        }
    );
    assert_eq!(
        schema_error(&with(
            &value,
            "library_id",
            Value::from(DEVICE.to_uppercase())
        )),
        SchemaError::Value {
            part: Part::Format,
            field: "library_id",
            error: ValueError::LibraryId
        }
    );
    assert_eq!(
        schema_error(&with(&value, "library_id", int(1))),
        SchemaError::WrongType {
            part: Part::Format,
            field: "library_id",
            expected: "a string"
        }
    );
    // Anywhere else, FORMAT.json is not where its content puts it.
    for elsewhere in [".folio/store/FORMAT 2.json", "FORMAT.json", &head_path(1)] {
        assert_eq!(
            problem(
                FormatRecord::parse(&bytes, elsewhere),
                RecordKind::Format,
                elsewhere
            ),
            Problem::Misplaced {
                expected: RecordPath::Format
            }
        );
    }
}

#[test]
fn head_records_round_trip_at_their_paths() {
    let record = head_record();
    let bytes = record.encode().unwrap();
    let text = format!(
        r#"{{"device":{{"id":"{DEVICE}","name":"G16"}},"format_version":1,"head":"{}","intent":2,"lamport":2,"library_id":"{LIBRARY}","packs":[{{"name":"{}.pack","size":6251}}],"seq":2,"time":"{TIME}"}}"#,
        id(0xb1),
        "46".repeat(32)
    );
    assert_eq!(String::from_utf8(bytes.clone()).unwrap(), text);
    assert_eq!(record.path().to_string(), head_path(2));
    assert_eq!(HeadRecord::parse(&bytes, &head_path(2)).unwrap(), record);
    assert_eq!(HeadRecord::read(&bytes[..], &head_path(2)).unwrap(), record);
    // In another device's folder, under another number, in the intents' folder: misplaced.
    for elsewhere in [
        format!(".folio/store/heads/{OTHER_DEVICE}/2.json"),
        head_path(3),
        format!(".folio/store/heads/{DEVICE}/02.json"),
        intent_path(2),
        FORMAT_PATH.to_owned(),
    ] {
        assert_eq!(
            problem(
                HeadRecord::parse(&bytes, &elsewhere),
                RecordKind::Head,
                &elsewhere
            ),
            Problem::Misplaced {
                expected: record.path()
            },
            "{elsewhere}"
        );
    }
}

#[test]
fn head_records_list_1_to_1000_packs() {
    let count_error = |count: usize| SchemaError::Count {
        part: Part::HeadRecord,
        field: "packs",
        count,
        max: MAX_PACK_REFS,
    };
    // remote-format.md §10.3: one or more per push, at most 1,000. (generate.mjs takes an empty
    // list; no vector has one.)
    assert_eq!(PackRefs::new(Vec::new()), Err(count_error(0)));
    let value = head_record().to_value();
    assert_eq!(
        head_error(
            &with(&value, "packs", Value::Array(Vec::new())),
            &head_path(2)
        ),
        count_error(0)
    );
    let named = |i: usize| PackRef {
        name: PackName::from_bytes(*blake3::hash(&i.to_le_bytes()).as_bytes()),
        size: Size::new(150 + i as u64).unwrap(),
    };
    let most: Vec<PackRef> = (0..MAX_PACK_REFS).map(named).collect();
    let mut record = head_record();
    record.packs = PackRefs::new(most).unwrap();
    let bytes = record.encode().unwrap();
    assert!(bytes.len() < 200_000, "{} bytes", bytes.len());
    assert_eq!(HeadRecord::parse(&bytes, &head_path(2)).unwrap(), record);
    let too_many: Vec<PackRef> = (0..=MAX_PACK_REFS).map(named).collect();
    assert_eq!(
        PackRefs::new(too_many.clone()),
        Err(count_error(MAX_PACK_REFS + 1))
    );
    let mut sorted = too_many;
    sorted.sort_unstable_by_key(|pack| pack.name);
    let values = Value::Array(sorted.iter().copied().map(PackRef::to_value).collect());
    assert_eq!(
        head_error(&with(&value, "packs", values), &head_path(2)),
        count_error(MAX_PACK_REFS + 1)
    );
}

#[test]
fn packs_are_named_once_in_order_and_at_least_150_bytes() {
    let small = SchemaError::Value {
        part: Part::PackRef,
        field: "size",
        error: ValueError::PackSize,
    };
    assert_eq!(PackRefs::new(vec![pack(1, 149)]), Err(small.clone()));
    assert_eq!(
        PackRefs::new(vec![pack(1, 150)]).unwrap().packs(),
        [pack(1, 150)]
    );
    // Built in any order, kept by name; one name twice is refused.
    assert_eq!(
        PackRefs::new(vec![pack(9, 200), pack(2, 300), pack(5, 150)])
            .unwrap()
            .packs(),
        [pack(2, 300), pack(5, 150), pack(9, 200)]
    );
    let twice = SchemaError::Duplicate {
        part: Part::HeadRecord,
        field: "packs",
        key: "name",
    };
    assert_eq!(
        PackRefs::new(vec![pack(2, 300), pack(2, 300)]),
        Err(twice.clone())
    );
    // Read: the order, names, sizes and fields of each pack.
    let value = head_record().to_value();
    let packs_of =
        |packs: &[PackRef]| Value::Array(packs.iter().copied().map(PackRef::to_value).collect());
    let read = |packs: Value| head_error(&with(&value, "packs", packs), &head_path(2));
    assert_eq!(
        read(packs_of(&[pack(9, 200), pack(2, 300)])),
        SchemaError::Order {
            part: Part::HeadRecord,
            field: "packs"
        }
    );
    assert_eq!(read(packs_of(&[pack(2, 300), pack(2, 300)])), twice);
    assert_eq!(read(packs_of(&[pack(2, 149)])), small);
    let one = pack(0xab, 6251).to_value();
    let name_error = SchemaError::Value {
        part: Part::PackRef,
        field: "name",
        error: ValueError::PackName,
    };
    for name in [
        format!("{}.pack", "AB".repeat(32)),
        format!("{}.PACK", "ab".repeat(32)),
        "ab".repeat(32),
        format!("{}.pack", "ab".repeat(31)),
        format!("packs/{}.pack", "ab".repeat(32)),
    ] {
        let renamed = with(&one, "name", Value::from(name.as_str()));
        assert_eq!(read(Value::Array(vec![renamed])), name_error, "{name}");
    }
    assert_eq!(
        read(Value::Array(vec![with(&one, "size", Value::from("6251"))])),
        SchemaError::WrongType {
            part: Part::PackRef,
            field: "size",
            expected: "an integer"
        }
    );
    assert_eq!(
        read(Value::Array(vec![with(&one, "objects", int(3))])),
        SchemaError::UnknownField {
            part: Part::PackRef,
            field: "objects".to_owned()
        }
    );
    assert_eq!(
        read(Value::Array(vec![without(&one, "size")])),
        SchemaError::MissingField {
            part: Part::PackRef,
            field: "size"
        }
    );
    assert_eq!(
        read(Value::from("4645c7")),
        SchemaError::WrongType {
            part: Part::HeadRecord,
            field: "packs",
            expected: "an array"
        }
    );
    assert_eq!(
        read(Value::Array(vec![Value::from("4645c7")])),
        SchemaError::NotAnObject(Part::PackRef)
    );
}

#[test]
fn packs_are_named_as_their_index_says() {
    let mut writer = PackWriter::new(MemorySink::new()).unwrap();
    writer.add_blob(b"hello", false).unwrap();
    let (index, _) = writer.finish().unwrap();
    let pack = PackRef::try_from(&index).unwrap();
    assert_eq!((pack.name, pack.size.get()), (index.name(), index.size()));
    let text = format!(
        r#"{{"name":"{}","size":{}}}"#,
        index.name().file_name(),
        index.size()
    );
    assert_eq!(pack.to_value().encode(), text.into_bytes());
}

#[test]
fn counts_are_at_least_1() {
    let value = head_record().to_value();
    for field in ["seq", "lamport", "intent"] {
        assert_eq!(
            head_error(&with(&value, field, int(0)), &head_path(2)),
            SchemaError::Value {
                part: Part::HeadRecord,
                field,
                error: ValueError::Count
            },
            "{field}"
        );
    }
    assert_eq!(
        intent_error(&with(&intent_record(Vec::new()).to_value(), "seq", int(0))),
        SchemaError::Value {
            part: Part::Intent,
            field: "seq",
            error: ValueError::Count
        }
    );
    // The largest count is a number too.
    let mut record = head_record();
    record.seq = Count::MAX;
    record.lamport = Count::MAX;
    record.intent = Count::MAX;
    let bytes = record.encode().unwrap();
    let at = head_path(Count::MAX.get());
    assert_eq!(HeadRecord::parse(&bytes, &at).unwrap(), record);
}

#[test]
fn a_head_records_intent_is_at_most_its_number() {
    let mut record = head_record();
    record.intent = count(1);
    let bytes = record.encode().unwrap();
    assert_eq!(HeadRecord::parse(&bytes, &head_path(2)).unwrap(), record);
    record.intent = record.seq;
    let bytes = record.encode().unwrap();
    assert_eq!(HeadRecord::parse(&bytes, &head_path(2)).unwrap(), record);
    // One more is refused when read, and when written.
    let after = SchemaError::IntentAfterSeq {
        intent: count(3),
        seq: count(2),
    };
    assert_eq!(
        head_error(&with(&record.to_value(), "intent", int(3)), &head_path(2)),
        after
    );
    record.intent = count(3);
    assert_eq!(
        problem(record.encode(), RecordKind::Head, &head_path(2)),
        Problem::Schema(after)
    );
}

#[test]
fn head_records_have_their_fields_and_no_others() {
    let value = head_record().to_value();
    let at = head_path(2);
    for &field in HEAD_FIELDS
        .iter()
        .filter(|&&field| field != "format_version")
    {
        assert_eq!(
            head_error(&without(&value, field), &at),
            SchemaError::MissingField {
                part: Part::HeadRecord,
                field
            },
            "{field}"
        );
    }
    assert_eq!(
        head_error(&with(&value, "base", Value::from(id(1).to_string())), &at),
        SchemaError::UnknownField {
            part: Part::HeadRecord,
            field: "base".to_owned()
        }
    );
    assert_eq!(
        head_error(&with(&value, "head", Value::from("b3:abc")), &at),
        SchemaError::Value {
            part: Part::HeadRecord,
            field: "head",
            error: ValueError::ObjectId
        }
    );
    assert_eq!(
        head_error(
            &with(&value, "time", Value::from("2026-10-04 08:00:00")),
            &at
        ),
        SchemaError::Value {
            part: Part::HeadRecord,
            field: "time",
            error: ValueError::Time
        }
    );
    let device = value.as_object().unwrap()["device"].clone();
    assert_eq!(
        head_error(
            &with(&value, "device", with(&device, "name", Value::from(" G16"))),
            &at
        ),
        SchemaError::Value {
            part: Part::Device,
            field: "name",
            error: ValueError::DeviceName
        }
    );
    assert_eq!(
        head_error(&with(&value, "device", Value::from(DEVICE)), &at),
        SchemaError::NotAnObject(Part::Device)
    );
}

#[test]
fn intents_round_trip_with_and_without_a_base() {
    let mut record = intent_record(vec![
        write_file("2026 秋/线性代数/第3讲 特征值.md"),
        delete_dir("2026 秋/线性代数/作业"),
        write_dir(".folio"),
    ]);
    for base in [Some(id(0x43)), None] {
        record.base = base;
        let bytes = record.encode().unwrap();
        assert_eq!(record.path().to_string(), intent_path(2));
        assert_eq!(
            IntentRecord::parse(&bytes, &intent_path(2)).unwrap(),
            record
        );
        assert_eq!(
            IntentRecord::read(&bytes[..], &intent_path(2)).unwrap(),
            record
        );
        assert_eq!(
            String::from_utf8(bytes).unwrap().contains("\"base\""),
            base.is_some()
        );
    }
    // A push that changes nothing in the mirror announces no writes.
    let empty = intent_record(Vec::new());
    let bytes = empty.encode().unwrap();
    assert!(
        String::from_utf8(bytes.clone())
            .unwrap()
            .ends_with(r#""writes":[]}"#)
    );
    assert_eq!(IntentRecord::parse(&bytes, &intent_path(2)).unwrap(), empty);
    assert_eq!(
        problem(
            IntentRecord::parse(&bytes, &head_path(2)),
            RecordKind::Intent,
            &head_path(2)
        ),
        Problem::Misplaced {
            expected: empty.path()
        }
    );
}

#[test]
fn writes_are_in_path_order_then_delete_before_write() {
    // UTF-8 byte order, not by folder or by UTF-16: `a b` < `a/x` < `a0`, `B.md` < `a.md`,
    // `Ａ.txt` (U+FF21) < `😀.md` (U+1F600).
    let writes = MirrorWrites::new(vec![
        write_file("😀.md"),
        write_file("a0"),
        write_dir("a"),
        delete_file("a"),
        write_file("a/x"),
        write_file("Ａ.txt"),
        delete_dir("a b"),
        write_file("a.md"),
        delete_file("B.md"),
    ])
    .unwrap();
    let order: Vec<(&str, WriteOp)> = writes.writes().iter().map(MirrorWrite::order_key).collect();
    assert_eq!(
        order,
        [
            ("B.md", WriteOp::Delete),
            ("a", WriteOp::Delete),
            ("a", WriteOp::Write),
            ("a b", WriteOp::Delete),
            ("a.md", WriteOp::Write),
            ("a/x", WriteOp::Write),
            ("a0", WriteOp::Write),
            ("Ａ.txt", WriteOp::Write),
            ("😀.md", WriteOp::Write),
        ]
    );
    // One path and operation twice is refused, whatever the kinds.
    let twice = SchemaError::Duplicate {
        part: Part::Intent,
        field: "writes",
        key: "path and operation",
    };
    assert_eq!(
        MirrorWrites::new(vec![write_file("a"), write_dir("a")]),
        Err(twice.clone())
    );
    assert_eq!(
        MirrorWrites::new(vec![delete_file("a"), delete_dir("a")]),
        Err(twice.clone())
    );
    // Read: the order as written.
    let value = intent_record(Vec::new()).to_value();
    let read = |writes: &[MirrorWrite]| {
        let writes = Value::Array(writes.iter().map(MirrorWrite::to_value).collect());
        intent_error(&with(&value, "writes", writes))
    };
    let unordered = SchemaError::Order {
        part: Part::Intent,
        field: "writes",
    };
    assert_eq!(read(&[write_file("a"), delete_file("a")]), unordered);
    assert_eq!(read(&[write_file("b"), write_file("a")]), unordered);
    assert_eq!(read(&[write_file("a/x"), write_file("a b")]), unordered);
    assert_eq!(read(&[write_file("a"), write_dir("a")]), twice);
    let written = intent_record(writes.writes().to_vec());
    assert_eq!(written.writes, writes);
}

#[test]
fn writes_have_the_fields_of_their_operation_and_kind() {
    let value = intent_record(Vec::new()).to_value();
    let read = |write: Value| intent_error(&with(&value, "writes", Value::Array(vec![write])));
    let file = write_file("a.md").to_value();
    let folder = delete_dir("a").to_value();
    assert_eq!(
        read(without(&file, "hash")),
        SchemaError::MissingField {
            part: Part::Write,
            field: "hash"
        }
    );
    for (op, kind) in [("write", "dir"), ("delete", "file"), ("delete", "dir")] {
        let write = with(
            &with(&file, "op", Value::from(op)),
            "kind",
            Value::from(kind),
        );
        assert_eq!(
            read(write),
            SchemaError::UnknownField {
                part: Part::Write,
                field: "hash".to_owned()
            },
            "{op} {kind}"
        );
    }
    for (op, kind) in [
        ("move", "file"),
        ("add", "dir"),
        ("modify", "file"),
        ("write", "link"),
        ("Write", "file"),
    ] {
        let write = with(
            &with(&folder, "op", Value::from(op)),
            "kind",
            Value::from(kind),
        );
        assert_eq!(
            read(write),
            SchemaError::UnknownKind {
                part: Part::Write,
                kind: format!("{op} {kind}")
            }
        );
    }
    assert_eq!(
        read(with(&folder, "op", Value::Bool(true))),
        SchemaError::WrongType {
            part: Part::Write,
            field: "op",
            expected: "a string"
        }
    );
    assert_eq!(
        read(without(&folder, "kind")),
        SchemaError::MissingField {
            part: Part::Write,
            field: "kind"
        }
    );
    assert_eq!(
        read(with(&folder, "from", Value::from("b"))),
        SchemaError::UnknownField {
            part: Part::Write,
            field: "from".to_owned()
        }
    );
    assert_eq!(
        read(with(
            &file,
            "hash",
            Value::from(id(1).to_string().to_uppercase())
        )),
        SchemaError::Value {
            part: Part::Write,
            field: "hash",
            error: ValueError::ObjectId
        }
    );
    for (text, error) in [
        ("", ValueError::Name(NameError::Empty)),
        ("/a", ValueError::Name(NameError::Empty)),
        ("a//b", ValueError::Name(NameError::Empty)),
        ("a/", ValueError::Name(NameError::Empty)),
        ("a.", ValueError::Name(NameError::TrailingDotOrSpace)),
        ("a\\b", ValueError::Name(NameError::InvalidCharacter('\\'))),
        ("cafe\u{301}", ValueError::Name(NameError::NotNfc)),
        ("nul.txt", ValueError::Name(NameError::ReservedName)),
    ] {
        assert_eq!(
            read(with(&folder, "path", Value::from(text))),
            SchemaError::Value {
                part: Part::Write,
                field: "path",
                error
            },
            "{text:?}"
        );
    }
    let long = format!("{}/a", "a".repeat(200)).repeat(164);
    assert_eq!(
        read(with(&folder, "path", Value::from(long))),
        SchemaError::Value {
            part: Part::Write,
            field: "path",
            error: ValueError::PathTooLong
        }
    );
    assert_eq!(
        read(Value::from("a.md")),
        SchemaError::NotAnObject(Part::Write)
    );
    assert_eq!(
        intent_error(&with(&value, "writes", Value::from("a.md"))),
        SchemaError::WrongType {
            part: Part::Intent,
            field: "writes",
            expected: "an array"
        }
    );
    assert_eq!(
        intent_error(&with(&value, "base", Value::from("b3:"))),
        SchemaError::Value {
            part: Part::Intent,
            field: "base",
            error: ValueError::ObjectId
        }
    );
    assert_eq!(
        intent_error(&with(&value, "packs", Value::Array(Vec::new()))),
        SchemaError::UnknownField {
            part: Part::Intent,
            field: "packs".to_owned()
        }
    );
}

/// remote-format.md §10.4 as generate.mjs's `mirrorPathProblem` reads it: a root entry NTFS takes
/// for `.folio` must be exactly `.folio`, which is only ever written as a folder; nothing in its
/// `local` or `store` is written or deleted.
#[test]
fn writes_never_touch_folios_private_folders() {
    let allowed = [
        write_dir(".folio"),
        write_file(".folio/library.json"),
        delete_file(".folio/tags.json"),
        write_dir(".folio/meta"),
        write_file(".folio/meta/2026 秋/线性代数.json"),
        delete_dir(".folio/meta/2026 秋"),
        write_file(".folio/meta/local"),
        write_dir(".folio/meta/store"),
        write_file(".folio/localx"),
        write_file(".folio/stores"),
        write_file("a/.folio/local/HEAD"),
        write_file(".folio2/store/x"),
        write_file("folio/store/x"),
        delete_dir("FOLIO~1"),
    ];
    let refused = [
        write_file(".folio"),
        delete_dir(".folio"),
        delete_file(".folio"),
        write_dir(".folio/local"),
        write_file(".folio/local/HEAD"),
        delete_dir(".folio/store"),
        write_file(".folio/store/heads/x/9.json"),
        delete_file(".folio/store/FORMAT.json"),
        write_file(".folio/LOCAL/x"),
        write_file(".folio/Store"),
        write_file(".folio/ſtore/x"),
        write_dir(".folio/locaL/packs"),
        write_file(".folio/LoCaL"),
        write_file(".FOLIO/library.json"),
        write_dir(".Folio"),
        write_file(".fol\u{131}o/library.json"),
        delete_dir(".FOLIO"),
    ];
    let value = intent_record(Vec::new()).to_value();
    for write in allowed {
        let writes = MirrorWrites::new(vec![write.clone()]).unwrap();
        let record = intent_record(writes.into_writes());
        let bytes = record.encode().unwrap();
        assert_eq!(
            IntentRecord::parse(&bytes, &intent_path(2)).unwrap(),
            record,
            "{write:?}"
        );
    }
    for write in refused {
        let error = SchemaError::FolioWrite {
            path: write.path().to_string(),
        };
        assert_eq!(
            MirrorWrites::new(vec![write.clone()]),
            Err(error.clone()),
            "{write:?}"
        );
        let writes = Value::Array(vec![write.to_value()]);
        assert_eq!(
            intent_error(&with(&value, "writes", writes)),
            error,
            "{write:?}"
        );
    }
}

/// The size cap comes first: exactly the cap is parsed (here: too deep to be JSON), one byte more
/// is refused unread, and a source is read no further than the cap and one byte.
#[test]
fn records_over_their_cap_are_refused_unread() {
    struct Endless {
        given: u64,
    }
    impl io::Read for Endless {
        fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
            buf.fill(b'[');
            self.given += buf.len() as u64;
            Ok(buf.len())
        }
    }
    for kind in KINDS {
        let at = path_of(kind);
        let limit = kind.limit();
        let mut bytes = vec![b'['; limit as usize];
        assert!(
            matches!(
                problem(parse(kind, &bytes, &at), kind, &at),
                Problem::Json(JsonError::Depth { offset: 16 })
            ),
            "{kind}"
        );
        assert!(matches!(
            problem(read(kind, &bytes[..], &at), kind, &at),
            Problem::Json(JsonError::Depth { offset: 16 })
        ));
        bytes.push(b'[');
        assert_eq!(
            problem(parse(kind, &bytes, &at), kind, &at),
            Problem::TooLarge { limit }
        );
        let mut endless = Endless { given: 0 };
        assert_eq!(
            problem(read(kind, &mut endless, &at), kind, &at),
            Problem::TooLarge { limit }
        );
        assert_eq!(endless.given, limit + 1, "{kind}");
    }
}

#[test]
fn a_source_that_fails_is_an_io_error_naming_the_record() {
    struct Failing;
    impl io::Read for Failing {
        fn read(&mut self, _: &mut [u8]) -> io::Result<usize> {
            Err(io::Error::other("the remote went away"))
        }
    }
    for kind in KINDS {
        let at = path_of(kind);
        match read(kind, Failing, &at) {
            Err(StoreError::Io { path, source }) => {
                assert_eq!(path, Path::new(&at));
                assert_eq!(source.to_string(), "the remote went away");
            }
            other => panic!("{kind}: {other:?}"),
        }
    }
}

/// remote-format.md §3: a record that states a higher version is newer whatever else it holds,
/// wherever it lies (the path is checked last); one that states none is invalid.
#[test]
fn newer_records_are_newer_whatever_else_they_hold() {
    for kind in KINDS {
        let at = path_of(kind);
        for (text, version) in [
            ("{\n  \"format_version\": 2,\n  \"x\": null\n}\n", "2"),
            (r#"{"format_version":3}"#, "3"),
            (
                r#"{"z":[[[]]],"format_version":18446744073709551616,"a":-1.5e3,"seq":0}"#,
                "18446744073709551616",
            ),
        ] {
            for path in [at.as_str(), "elsewhere/42 2.json"] {
                match parse(kind, text.as_bytes(), path) {
                    Err(StoreError::Newer {
                        what:
                            Subject::Record {
                                kind: found,
                                path: found_at,
                            },
                        version: stated,
                    }) => {
                        assert_eq!(
                            (found, found_at.as_str(), stated.as_str()),
                            (kind, path, version)
                        );
                    }
                    other => panic!("{kind} {text:?} at {path}: {other:?}"),
                }
            }
        }
        for text in [
            r#"{"format_version":0}"#,
            r#"{"format_version":-1}"#,
            r#"{"format_version":1.0}"#,
            r#"{"format_version":1e0}"#,
            r#"{"format_version":"1"}"#,
            r#"{"format_version":null}"#,
            r#"{"version":1}"#,
            "{}",
            "[1]",
            "1",
        ] {
            assert_eq!(
                problem(parse(kind, text.as_bytes(), &at), kind, &at),
                Problem::FormatVersion,
                "{kind} {text:?}"
            );
        }
        // JSON comes before the version: a newer version in broken JSON is invalid.
        for text in [
            "\u{feff}{\"format_version\":2}",
            r#"{"format_version":2,"format_version":2}"#,
            r#"{"format_version":2"#,
            r#"{"format_version":2,"x":"\ud800"}"#,
            "{\"format_version\":2,\"x\":\"\u{1}\"}",
        ] {
            assert!(
                matches!(
                    problem(parse(kind, text.as_bytes(), &at), kind, &at),
                    Problem::Json(_)
                ),
                "{kind} {text:?}"
            );
        }
        // Version 1 must then be canonical.
        let not_canonical = match kind {
            RecordKind::Format => format!(r#"{{"library_id":"{LIBRARY}","format_version":1}}"#),
            _ => r#"{"format_version":1 }"#.to_owned(),
        };
        assert!(matches!(
            problem(parse(kind, not_canonical.as_bytes(), &at), kind, &at),
            Problem::Json(JsonError::NotCanonical { .. })
        ));
    }
}

/// The cap of 64 MiB, at the byte: what `encode_capped` writes and refuses.
#[test]
fn records_encode_up_to_their_cap() {
    let limit = RecordKind::Intent.limit();
    // {"x":"…"} is 8 bytes besides the string's content.
    let value_of = |len: u64| schema::object([("x", Value::String("a".repeat(len as usize - 8)))]);
    let at = || RecordPath::Intent {
        device: DeviceId::parse(DEVICE).unwrap(),
        seq: count(2),
    };
    let largest = encode_capped(RecordKind::Intent, &value_of(limit), at()).unwrap();
    assert_eq!(largest.len() as u64, limit);
    drop(largest);
    match encode_capped(RecordKind::Intent, &value_of(limit + 1), at()) {
        Err(StoreError::TooLarge {
            what: Subject::Record { kind, path },
            limit: Limit::Bytes(bytes),
        }) => {
            assert_eq!(
                (kind, path, bytes),
                (RecordKind::Intent, intent_path(2), limit)
            );
        }
        other => panic!("{other:?}"),
    }
    let format_cap = RecordKind::Format.limit();
    assert!(
        encode_capped(
            RecordKind::Format,
            &value_of(format_cap),
            RecordPath::Format
        )
        .is_ok()
    );
    assert!(
        encode_capped(
            RecordKind::Format,
            &value_of(format_cap + 1),
            RecordPath::Format
        )
        .is_err()
    );
}

/// An intent whose writes do not fit in 64 MiB cannot be written; one just below reads back.
#[test]
fn intents_hold_at_most_64_mib_of_writes() {
    // Paths of 32,516 UTF-16 units, 97,286 bytes: four digits, then 127 names of 255 `台`.
    let tail = format!("/{}", "台".repeat(255)).repeat(127);
    let mut writes: Vec<MirrorWrite> = (0..700)
        .map(|i| delete_dir(&format!("{i:04}{tail}")))
        .collect();
    let more = writes.split_off(680);
    let fits = intent_record(writes);
    let bytes = fits.encode().unwrap();
    assert!(
        (66_000_000..RecordKind::Intent.limit() as usize).contains(&bytes.len()),
        "{} bytes",
        bytes.len()
    );
    assert!(IntentRecord::parse(&bytes, &intent_path(2)).unwrap() == fits);
    drop(bytes);
    let mut writes = fits.writes.into_writes();
    writes.extend(more);
    let too_large = intent_record(writes);
    match too_large.encode() {
        Err(StoreError::TooLarge {
            what: Subject::Record { kind, path },
            limit: Limit::Bytes(limit),
        }) => {
            assert_eq!(
                (kind, path, limit),
                (
                    RecordKind::Intent,
                    intent_path(2),
                    RecordKind::Intent.limit()
                )
            );
        }
        other => panic!("{other:?}"),
    }
}

/// Values without `format_version`, which `schema::versioned` reads before the schema, get it, so
/// that a value the schema accepts is a whole record.
fn versioned_value(value: Value) -> Value {
    match value {
        Value::Object(mut members) => {
            members.insert("format_version".to_owned(), int(1));
            Value::Object(members)
        }
        other => other,
    }
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(48))]

    #[test]
    fn any_format_record_round_trips(record in strategies::format_record()) {
        let bytes = record.encode();
        prop_assert_eq!(&FormatRecord::parse(&bytes, &record.path().to_string()).unwrap(), &record);
        prop_assert_eq!(schema::from_value(&record.to_value(), FormatRecord::from_node), Ok(record));
    }

    #[test]
    fn any_head_record_round_trips_at_its_path(record in strategies::head_record()) {
        let bytes = record.encode().unwrap();
        let at = record.path().to_string();
        prop_assert_eq!(RecordPath::parse(&at), Some(record.path()));
        let parsed = HeadRecord::parse(&bytes, &at).unwrap();
        prop_assert_eq!(&parsed, &record);
        prop_assert_eq!(parsed.encode().unwrap(), bytes);
    }

    #[test]
    fn any_intent_round_trips_at_its_path(record in strategies::intent_record()) {
        let bytes = record.encode().unwrap();
        let at = record.path().to_string();
        prop_assert_eq!(RecordPath::parse(&at), Some(record.path()));
        let parsed = IntentRecord::parse(&bytes, &at).unwrap();
        prop_assert_eq!(&parsed, &record);
        prop_assert_eq!(parsed.encode().unwrap(), bytes);
    }

    #[test]
    fn writes_sort_whatever_order_they_come_in(
        (writes, shuffled) in strategies::mirror_writes(12).prop_flat_map(|writes| {
            let shuffled = writes.clone().into_writes();
            (Just(writes), Just(shuffled).prop_shuffle())
        })
    ) {
        prop_assert_eq!(MirrorWrites::new(shuffled), Ok(writes));
    }

    #[test]
    fn packs_sort_whatever_order_they_come_in(
        (packs, shuffled) in strategies::pack_refs(12).prop_flat_map(|packs| {
            let shuffled = packs.packs().to_vec();
            (Just(packs), Just(shuffled).prop_shuffle())
        })
    ) {
        prop_assert_eq!(PackRefs::new(shuffled), Ok(packs));
    }

    /// Bytes near a valid record parse only when they are the canonical encoding of a valid record
    /// at the same path.
    #[test]
    fn only_canonical_head_records_parse(
        (at, bytes) in strategies::head_record().prop_flat_map(|record| {
            (Just(record.path().to_string()), strategies::mutated(record.encode().unwrap()))
        })
    ) {
        if let Ok(record) = HeadRecord::parse(&bytes, &at) {
            prop_assert_eq!(record.encode().unwrap(), bytes);
            prop_assert_eq!(record.path().to_string(), at);
        }
    }

    #[test]
    fn only_canonical_intents_parse(
        (at, bytes) in strategies::intent_record().prop_flat_map(|record| {
            (Just(record.path().to_string()), strategies::mutated(record.encode().unwrap()))
        })
    ) {
        if let Ok(record) = IntentRecord::parse(&bytes, &at) {
            prop_assert_eq!(record.encode().unwrap(), bytes);
            prop_assert_eq!(record.path().to_string(), at);
        }
    }

    /// Reading a value never panics, and what it accepts it writes back unchanged.
    #[test]
    fn accepted_values_write_back_unchanged(value in strategies::record_like()) {
        let whole = versioned_value(value.clone());
        if let Ok(record) = schema::from_value(&whole, FormatRecord::from_node) {
            prop_assert_eq!(record.to_value(), whole.clone());
        }
        if let Ok(record) = schema::from_value(&whole, HeadRecord::from_node) {
            prop_assert_eq!(record.to_value(), whole.clone());
        }
        if let Ok(record) = schema::from_value(&whole, IntentRecord::from_node) {
            prop_assert_eq!(record.to_value(), whole);
        }
        if let Ok(pack) = schema::from_value(&value, PackRef::from_node) {
            prop_assert_eq!(pack.to_value(), value.clone());
        }
        if let Ok(write) = schema::from_value(&value, MirrorWrite::from_node) {
            prop_assert_eq!(write.to_value(), value.clone());
        }
        if let Value::Array(_) = &value {
            let packs = schema::from_value(&value, |node| {
                PackRefs::from_items(node.as_array().expect("an array"))
            });
            if let Ok(packs) = packs {
                prop_assert_eq!(packs.to_value(), value.clone());
            }
            let writes = schema::from_value(&value, |node| {
                MirrorWrites::from_items(node.as_array().expect("an array"))
            });
            if let Ok(writes) = writes {
                prop_assert_eq!(writes.to_value(), value.clone());
            }
        }
    }

    /// Any bytes are read without a panic, to one of the outcomes.
    #[test]
    fn any_bytes_are_ok_newer_or_invalid(
        bytes in prop::collection::vec(any::<u8>(), 0..64),
        kind in prop::sample::select(KINDS.to_vec()),
    ) {
        let at = path_of(kind);
        match parse(kind, &bytes, &at) {
            Ok(()) | Err(StoreError::Newer { .. } | StoreError::Invalid { .. }) => {}
            Err(other) => prop_assert!(false, "{other:?}"),
        }
    }
}
