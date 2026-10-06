//! The golden vectors of history format 1 (docs/specs/remote-format.md §12), read from
//! docs/specs/remote-format-vectors/v1/ through the store's public API.
//!
//! `hex` is authoritative wherever a vector has it. Every vector's outcome (valid, `newer`,
//! `missing` or invalid) must match; reasons appear only in failure messages, because the vectors'
//! reasons are informative (§12).

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::path::PathBuf;

use folio_core::hash::ContentHash;
use folio_core::store::json::{self, Int, Value};
use folio_core::store::{
    Added, Body, Change, ChangeOp, Changes, Commit, CommitKind, DEFAULT_PATH_BUDGET, Device,
    DeviceId, DeviceName, Differences, FlatEntry, FlatTree, FormatRecord, HeadRecord,
    HistoryChecker, IndexEntry, IntentRecord, LibraryId, MemorySink, MemoryTrees, Message,
    MirrorWrite, MirrorWrites, Name, ObjectHasher, ObjectId, ObjectKind, PackName, PackReader,
    PackRef, PackWriter, RecordPath, Side, Size, StoreError, Summary, Timestamp, Tree, TreeEntry,
    TreePath, absent_blob, check_root, flatten, may_delete,
};
use serde_json::Value as Vector;

const VECTORS: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../docs/specs/remote-format-vectors/v1/"
);

fn read(file: &str) -> Vector {
    let path = PathBuf::from(VECTORS).join(file);
    let text = std::fs::read_to_string(&path)
        .unwrap_or_else(|error| panic!("{}: {error}", path.display()));
    serde_json::from_str(&text).unwrap_or_else(|error| panic!("{}: {error}", path.display()))
}

/// The keys of a vector file's top-level object, to catch a section no test reads.
fn sections(vectors: &Vector) -> Vec<&str> {
    vectors
        .as_object()
        .expect("a vector file is an object")
        .keys()
        .map(String::as_str)
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect()
}

fn list<'a>(vectors: &'a Vector, section: &str) -> &'a [Vector] {
    let items = vectors[section]
        .as_array()
        .unwrap_or_else(|| panic!("{section} is not a list"));
    assert!(!items.is_empty(), "{section} is empty");
    items
}

fn text<'a>(item: &'a Vector, key: &str) -> &'a str {
    item[key]
        .as_str()
        .unwrap_or_else(|| panic!("{key} is not text in {item}"))
}

fn unhex(text: &str) -> Vec<u8> {
    assert!(text.len().is_multiple_of(2), "odd hex: {text}");
    (0..text.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&text[i..i + 2], 16).unwrap_or_else(|_| panic!("hex: {text}")))
        .collect()
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// The bytes i mod 251 for i = 0 .. length - 1, as in BLAKE3's own test vectors.
fn pattern(length: u64) -> Vec<u8> {
    (0..length).map(|i| (i % 251) as u8).collect()
}

/// A hashes.json input: `<prefix>_hex`, or `<prefix>_pattern` with its length.
fn input(item: &Vector, prefix: &str) -> Vec<u8> {
    if let Some(hex) = item.get(format!("{prefix}_hex")) {
        return unhex(hex.as_str().expect("hex is text"));
    }
    let length = item[format!("{prefix}_pattern")]["length"]
        .as_u64()
        .unwrap_or_else(|| panic!("{item} has neither {prefix}_hex nor {prefix}_pattern"));
    pattern(length)
}

/// A string vector: `value`, or `value_pattern`, which stands for `repeat` × `count` then `then`.
fn value_text(item: &Vector) -> String {
    let Some(pattern) = item.get("value_pattern") else {
        return text(item, "value").to_owned();
    };
    let count = pattern["count"].as_u64().expect("a count") as usize;
    let then = pattern.get("then").and_then(Vector::as_str).unwrap_or("");
    format!("{}{then}", text(pattern, "repeat").repeat(count))
}

/// A name vector's text: its bytes from `hex`, which is authoritative, or its pattern.
fn name_text(item: &Vector) -> String {
    match item.get("hex") {
        Some(hex) => String::from_utf8(unhex(hex.as_str().expect("hex is text")))
            .expect("every name vector is UTF-8"),
        None => value_text(item),
    }
}

/// A short form of a long value, for messages.
fn shown(text: &str) -> String {
    let mut chars = text.chars();
    let start: String = chars.by_ref().take(40).collect();
    match chars.count() {
        0 => format!("{start:?}"),
        more => format!("{start:?} and {more} more characters"),
    }
}

/// Every vector of `section` is accepted by `rule` exactly when it is `valid`.
fn check_values(
    vectors: &Vector,
    section: &str,
    text_of: fn(&Vector) -> String,
    rule: fn(&str) -> Result<(), String>,
) {
    for item in list(vectors, section) {
        let text = text_of(item);
        let valid = item["valid"].as_bool().expect("valid is a boolean");
        let outcome = rule(&text);
        let note = item.get("rule").or_else(|| item.get("note"));
        assert_eq!(
            outcome.is_ok(),
            valid,
            "{section} {}: we say {outcome:?}, the vector says valid = {valid} ({note:?})",
            shown(&text)
        );
    }
}

/// The id of `bytes` hashed in uneven pieces.
fn streamed(kind: ObjectKind, bytes: &[u8]) -> ObjectId {
    let mut hasher = ObjectHasher::new(kind);
    let mut rest = bytes;
    for &size in [1, 63, 64, 1000, 4096].iter().cycle() {
        if rest.is_empty() {
            break;
        }
        let (piece, tail) = rest.split_at(size.min(rest.len()));
        hasher.update(piece);
        rest = tail;
    }
    hasher.finalize()
}

/// A vector's JSON value as a value of the format.
fn format_value(vector: &Vector) -> Value {
    match vector {
        Vector::Null => panic!("the format has no null"),
        Vector::Bool(value) => Value::Bool(*value),
        Vector::Number(number) => {
            let number = number.as_u64().expect("an integer of the format");
            Value::Int(Int::new(number).expect("at most 2^53 - 1"))
        }
        Vector::String(text) => Value::String(text.clone()),
        Vector::Array(items) => Value::Array(items.iter().map(format_value).collect()),
        Vector::Object(members) => Value::Object(
            members
                .iter()
                .map(|(key, value)| (key.clone(), format_value(value)))
                .collect(),
        ),
    }
}

#[test]
fn the_vector_folder_holds_the_files_of_section_12() {
    let files: BTreeSet<String> = std::fs::read_dir(VECTORS)
        .expect("the vector folder")
        .map(|entry| entry.unwrap().file_name().into_string().unwrap())
        .collect();
    let expected = [
        "canonical-json.json",
        "commit-rules.json",
        "hashes.json",
        "objects.json",
        "packs.json",
        "records.json",
        "values.json",
    ];
    assert_eq!(files, BTreeSet::from(expected.map(String::from)));
}

#[test]
fn hashes() {
    let vectors = read("hashes.json");
    assert_eq!(
        sections(&vectors),
        ["blob_ids", "derive_key", "description", "domain_separation"]
    );
    for item in list(&vectors, "blob_ids") {
        let name = text(item, "name");
        let bytes = input(item, "input");
        let expected = text(item, "blob_id");
        let id = ObjectId::of(ObjectKind::Blob, &bytes);
        assert_eq!(id.to_string(), expected, "{name}");
        assert_eq!(ObjectId::parse(expected), Ok(id), "{name}");
        assert_eq!(streamed(ObjectKind::Blob, &bytes), id, "{name}, streamed");
        let hash = ContentHash::of(&bytes);
        assert_eq!(hash.as_str(), expected, "{name}, as the catalog hashes it");
        assert_eq!(ObjectId::from(&hash), id, "{name}");
    }
    for item in list(&vectors, "derive_key") {
        let name = text(item, "name");
        let context = text(item, "context");
        let kind = ObjectKind::ALL
            .into_iter()
            .find(|kind| kind.context() == Some(context))
            .unwrap_or_else(|| panic!("{name}: no kind derives with {context:?}"));
        let material = input(item, "material");
        let id = ObjectId::of(kind, &material);
        assert_eq!(hex(id.as_bytes()), text(item, "output"), "{name}");
        assert_eq!(streamed(kind, &material), id, "{name}, streamed");
    }
    let domain = &vectors["domain_separation"];
    let bytes = unhex(text(domain, "bytes_hex"));
    for (kind, key) in [
        (ObjectKind::Blob, "blob_id"),
        (ObjectKind::Tree, "tree_id"),
        (ObjectKind::Commit, "commit_id"),
    ] {
        assert_eq!(
            ObjectId::of(kind, &bytes).to_string(),
            text(domain, key),
            "{kind}"
        );
    }
}

#[test]
fn canonical_json() {
    let vectors = read("canonical-json.json");
    assert_eq!(sections(&vectors), ["description", "documents", "encode"]);
    for item in list(&vectors, "documents") {
        let name = text(item, "name");
        let bytes = unhex(text(item, "hex"));
        if let Some(text) = item.get("text") {
            assert_eq!(
                text.as_str().map(str::as_bytes),
                Some(&bytes[..]),
                "{name}: text and hex"
            );
        }
        let canonical = item["canonical"].as_bool().expect("canonical is a boolean");
        match json::parse_canonical(&bytes) {
            Ok(value) => {
                assert!(
                    canonical,
                    "{name}: we accept it, the vector says {}",
                    item["reason"]
                );
                assert_eq!(value.encode(), bytes, "{name}: encodes to other bytes");
            }
            Err(error) => assert!(!canonical, "{name}: we refuse it ({error})"),
        }
    }
    for item in list(&vectors, "encode") {
        let name = text(item, "name");
        let value = format_value(&item["value"]);
        let encoded = value.encode();
        assert_eq!(hex(&encoded), text(item, "canonical_hex"), "{name}");
        assert_eq!(
            json::parse_canonical(&encoded),
            Ok(value),
            "{name}: reads back"
        );
    }
}

#[test]
fn values() {
    let vectors = read("values.json");
    assert_eq!(
        sections(&vectors),
        [
            "bodies",
            "description",
            "display_names",
            "ids_128",
            "names",
            "object_ids",
            "paths",
            "summaries",
            "times",
        ]
    );
    fn rule<T, E: ToString>(parse: fn(&str) -> Result<T, E>, text: &str) -> Result<(), String> {
        parse(text).map(drop).map_err(|error| error.to_string())
    }
    check_values(&vectors, "names", name_text, |text| rule(Name::parse, text));
    check_values(&vectors, "paths", value_text, |text| {
        rule(TreePath::parse, text)
    });
    check_values(&vectors, "times", value_text, |text| {
        rule(Timestamp::parse, text)?;
        // A valid time writes itself back exactly.
        let time = Timestamp::parse(text).map_err(|error| error.to_string())?;
        assert_eq!(time.to_string(), text);
        Ok(())
    });
    check_values(&vectors, "display_names", value_text, |text| {
        rule(DeviceName::parse, text)
    });
    check_values(&vectors, "summaries", value_text, |text| {
        rule(Summary::parse, text)
    });
    check_values(&vectors, "bodies", value_text, |text| {
        rule(Body::parse, text)
    });
    check_values(&vectors, "object_ids", value_text, |text| {
        rule(ObjectId::parse, text)
    });
    // Library ids and device ids share the rule of §6.1.
    check_values(&vectors, "ids_128", value_text, |text| {
        rule(DeviceId::parse, text)
    });
    check_values(&vectors, "ids_128", value_text, |text| {
        rule(LibraryId::parse, text)
    });
}

/// A tree or commit vector's bytes: `hex`, which is authoritative, after checking that `text`
/// holds the same bytes.
fn object_bytes(item: &Vector, label: &str) -> Vec<u8> {
    let bytes = unhex(text(item, "hex"));
    if let Some(text) = item.get("text") {
        assert_eq!(
            text.as_str().map(str::as_bytes),
            Some(&bytes[..]),
            "{label}: text and hex"
        );
    }
    bytes
}

/// The trees and commits of the example library (objects.json).
struct Example {
    trees: BTreeMap<ObjectId, Tree>,
    /// In order, with their names and ids.
    commits: Vec<(String, ObjectId, Commit)>,
}

/// The objects of objects.json: each id recomputed from the bytes, each object parsed and encoded
/// back to exactly its bytes.
fn example(vectors: &Vector) -> Example {
    let mut trees = BTreeMap::new();
    for item in list(vectors, "trees") {
        let label = format!(
            "the tree at {:?} in {}",
            text(item, "path"),
            text(item, "first_commit")
        );
        let bytes = object_bytes(item, &label);
        let id = ObjectId::of(ObjectKind::Tree, &bytes);
        assert_eq!(id.to_string(), text(item, "id"), "{label}");
        let tree = Tree::parse(&bytes).unwrap_or_else(|problem| panic!("{label}: {problem}"));
        let encoded = tree.encode().unwrap();
        assert_eq!(
            encoded.bytes(),
            &bytes[..],
            "{label}: encodes to other bytes"
        );
        assert_eq!(encoded.id(), id, "{label}");
        trees.insert(id, tree);
    }
    let mut commits = Vec::new();
    for item in list(vectors, "commits") {
        let name = text(item, "name").to_owned();
        let bytes = object_bytes(item, &name);
        let id = ObjectId::of(ObjectKind::Commit, &bytes);
        assert_eq!(id.to_string(), text(item, "id"), "{name}");
        let commit = Commit::parse(&bytes).unwrap_or_else(|problem| panic!("{name}: {problem}"));
        let encoded = commit.encode().unwrap();
        assert_eq!(
            encoded.bytes(),
            &bytes[..],
            "{name}: encodes to other bytes"
        );
        assert_eq!(encoded.id(), id, "{name}");
        commits.push((name, id, commit));
    }
    Example { trees, commits }
}

/// The trees of objects.json as a tree source, without `absent`.
fn source(trees: &BTreeMap<ObjectId, Tree>, absent: &[ObjectId]) -> MemoryTrees {
    let mut source = MemoryTrees::new();
    for (&id, tree) in trees {
        if !absent.contains(&id) {
            assert_eq!(source.insert(tree.clone()).unwrap(), id);
        }
    }
    source
}

/// Every folder's path in the tree `root` with its tree id (the root's path is empty). A walk
/// with a stack, not recursion.
fn folders(root: ObjectId, trees: &BTreeMap<ObjectId, Tree>) -> BTreeMap<String, ObjectId> {
    let mut folders = BTreeMap::from([(String::new(), root)]);
    let mut stack = vec![(String::new(), root)];
    while let Some((prefix, id)) = stack.pop() {
        let tree = trees
            .get(&id)
            .unwrap_or_else(|| panic!("the tree {id} at {prefix:?} is not in objects.json"));
        for entry in tree.entries() {
            if let TreeEntry::Dir { name, tree } = entry {
                let path = match prefix.as_str() {
                    "" => name.to_string(),
                    prefix => format!("{prefix}/{name}"),
                };
                folders.insert(path.clone(), *tree);
                stack.push((path, *tree));
            }
        }
    }
    folders
}

/// A flattened tree as the vectors write it: each path with `{"kind":"dir"}` or
/// `{"hash","kind":"file","size","stored"}`.
fn flat_tree(vector: &Vector) -> FlatTree {
    let entries = vector.as_object().expect("a flattened tree is an object");
    entries
        .iter()
        .map(|(path, entry)| {
            let fields = entry.as_object().expect("an entry is an object");
            let entry = match text(entry, "kind") {
                "dir" => {
                    assert_eq!(fields.len(), 1, "{path}: a folder is only its kind");
                    FlatEntry::Dir
                }
                "file" => {
                    assert_eq!(fields.len(), 4, "{path}: hash, kind, size, stored");
                    FlatEntry::File(Side {
                        hash: ObjectId::parse(text(entry, "hash")).expect("an object id"),
                        size: Size::new(entry["size"].as_u64().expect("a size")).unwrap(),
                        stored: entry["stored"].as_bool().expect("stored is a boolean"),
                    })
                }
                other => panic!("{path}: no kind {other:?}"),
            };
            (path.clone(), entry)
        })
        .collect()
}

/// Adds the trees of a flattened tree to `trees`, and returns the root's id.
fn build(trees: &mut MemoryTrees, tree: &FlatTree) -> ObjectId {
    let join = |folder: &str, name: &str| match folder {
        "" => name.to_owned(),
        folder => format!("{folder}/{name}"),
    };
    let mut children: HashMap<&str, Vec<(&str, FlatEntry)>> = HashMap::new();
    for (path, entry) in tree {
        let (parent, name) = path.rsplit_once('/').unwrap_or(("", path.as_str()));
        children.entry(parent).or_default().push((name, *entry));
    }
    let mut folders: Vec<&str> = tree
        .iter()
        .filter(|(_, entry)| **entry == FlatEntry::Dir)
        .map(|(path, _)| path.as_str())
        .collect();
    // The deepest folders first, the root last.
    folders.sort_by_key(|path| std::cmp::Reverse(path.matches('/').count()));
    folders.push("");
    let mut ids: HashMap<String, ObjectId> = HashMap::new();
    for folder in folders {
        let entries = children
            .get(folder)
            .into_iter()
            .flatten()
            .map(|&(name, entry)| {
                let child = join(folder, name);
                let name = Name::parse(name).unwrap_or_else(|error| panic!("{child}: {error}"));
                match entry {
                    FlatEntry::File(side) => TreeEntry::file(name, side),
                    FlatEntry::Dir => TreeEntry::dir(name, ids[&child]),
                }
            })
            .collect();
        let id = trees.insert(Tree::new(entries).unwrap()).unwrap();
        ids.insert(folder.to_owned(), id);
    }
    ids[""]
}

/// How our reader ends on a vector: `valid`, `missing`, or `invalid`, with our reason.
fn outcome(result: Result<(), StoreError>) -> (&'static str, String) {
    match result {
        Ok(()) => ("valid", String::new()),
        Err(StoreError::Missing(id)) => ("missing", format!("{id} is missing")),
        Err(error @ StoreError::Invalid { .. }) => ("invalid", error.to_string()),
        Err(other) => panic!("neither valid, missing nor invalid: {other}"),
    }
}

#[test]
fn objects() {
    let vectors = read("objects.json");
    assert_eq!(
        sections(&vectors),
        [
            "blobs",
            "commits",
            "description",
            "flattened_trees",
            "invalid",
            "library_id",
            "trees",
        ]
    );
    // The library's id follows §6.1.
    assert!(LibraryId::parse(text(&vectors, "library_id")).is_ok());
    for item in list(&vectors, "blobs") {
        let label = format!(
            "the blob of {:?} in {}",
            text(item, "first_path"),
            text(item, "first_commit")
        );
        let bytes = unhex(text(item, "hex"));
        let id = ObjectId::of(ObjectKind::Blob, &bytes);
        assert_eq!(id.to_string(), text(item, "content_hash"), "{label}");
        assert_eq!(Some(bytes.len() as u64), item["size"].as_u64(), "{label}");
    }
    let Example { trees, commits } = example(&vectors);
    assert_eq!(
        trees.len(),
        list(&vectors, "trees").len(),
        "tree ids are distinct"
    );
    assert_eq!(commits.len(), 5);
}

/// The five commits of §12's table, as our reader understands them.
#[test]
fn objects_tell_the_story_of_section_12() {
    let vectors = read("objects.json");
    let Example { trees, commits } = example(&vectors);
    let names: Vec<&str> = commits.iter().map(|(name, ..)| name.as_str()).collect();
    assert_eq!(names, ["c1", "c2", "c3", "c4", "c5"]);
    let kinds: Vec<&str> = commits
        .iter()
        .map(|(.., commit)| commit.kind.name())
        .collect();
    assert_eq!(kinds, ["commit", "commit", "import", "prune", "commit"]);
    // Each commit sits on the one before it; c1 is a first commit.
    let mut parent = None;
    for (name, id, commit) in &commits {
        assert_eq!(commit.parent(), parent, "{name}'s parent");
        assert!(trees.contains_key(&commit.tree), "{name}'s tree");
        parent = Some(*id);
    }
    let [c1, c2, c3, c4, c5] = [0, 1, 2, 3, 4].map(|i| &commits[i].2);
    let records = |commit: &Commit| -> Vec<Change> {
        let message = commit.message().expect("a message");
        message.changes.clone().expect("changes").into_records()
    };
    // Device A made every commit but c3, an import by device B, which has a Chinese name.
    for commit in [c2, c4, c5] {
        assert_eq!(commit.device, c1.device);
    }
    assert_ne!(c3.device.id, c1.device.id);
    assert_eq!(c3.device.name.as_str(), "台式机");
    // c1 only adds.
    assert!(
        records(c1)
            .iter()
            .all(|record| record.op() == ChangeOp::Add)
    );
    // c2 renames a folder whose file L2.md was edited too (§7.3's example).
    let c2_records = records(c2);
    assert!(c2_records.iter().any(|record| matches!(
        record,
        Change::MoveDir { from, path } if from.name() == "Lectures" && path.name() == "讲义"
    )));
    assert!(c2_records.iter().any(|record| matches!(
        record,
        Change::MoveFile { path, old, new, .. } if path.name() == "L2.md" && old != new
    )));
    // c3 was rebased onto c2 and has a body that needs escapes.
    assert!(c3.rebased_from.is_some());
    let body = c3.message().and_then(|message| message.body.as_ref());
    let body = body.expect("c3 has a body").as_str();
    assert!(["\"", "\\", "\n", "\t"].iter().all(|ch| body.contains(ch)));
    // c4 thins out the first Word version and keeps the tree; c5 brings that version back.
    assert_eq!(c4.tree, c3.tree);
    let first_word = list(&vectors, "blobs")
        .iter()
        .find(|blob| {
            text(blob, "first_commit") == "c1" && text(blob, "first_path").ends_with(".docx")
        })
        .map(|blob| ObjectId::parse(text(blob, "content_hash")).unwrap());
    let pruned = c4.pruned().expect("c4 is a prune commit").ids();
    assert_eq!(Some(pruned), first_word.as_ref().map(std::slice::from_ref));
    assert!(records(c5).iter().any(|record| matches!(
        record,
        Change::ModifyFile { new, .. } if Some(new.hash) == first_word
    )));
}

#[test]
fn objects_flatten_to_their_paths() {
    let vectors = read("objects.json");
    let Example { trees, commits } = example(&vectors);
    let flattened = vectors["flattened_trees"]
        .as_object()
        .expect("flattened_trees is an object");
    let roots: BTreeSet<String> = commits
        .iter()
        .map(|(.., commit)| commit.tree.to_string())
        .collect();
    assert_eq!(flattened.keys().cloned().collect::<BTreeSet<_>>(), roots);
    let trees_source = source(&trees, &[]);
    for (root, expected) in flattened {
        let root = ObjectId::parse(root).unwrap();
        let flat = flatten(&trees_source, root, DEFAULT_PATH_BUDGET).unwrap();
        assert_eq!(flat, flat_tree(expected), "{root}");
    }
    let tree_of = |name: &str| {
        let (.., commit) = commits
            .iter()
            .find(|(label, ..)| label == name)
            .unwrap_or_else(|| panic!("no commit {name}"));
        commit.tree
    };
    // Each blob is the file at its first path in its first commit, with its size and `stored`.
    for item in list(&vectors, "blobs") {
        let path = text(item, "first_path");
        let root = tree_of(text(item, "first_commit"));
        let flat = flatten(&trees_source, root, DEFAULT_PATH_BUDGET).unwrap();
        let expected = Side {
            hash: ObjectId::parse(text(item, "content_hash")).unwrap(),
            size: Size::new(item["size"].as_u64().unwrap()).unwrap(),
            stored: item["stored"].as_bool().unwrap(),
        };
        assert_eq!(flat[path], FlatEntry::File(expected), "{path}");
    }
    // Each tree is the folder at its path in its first commit.
    for item in list(&vectors, "trees") {
        let path = text(item, "path");
        let folders = folders(tree_of(text(item, "first_commit")), &trees);
        assert_eq!(folders[path].to_string(), text(item, "id"), "{path:?}");
    }
}

#[test]
fn invalid_objects() {
    let vectors = read("objects.json");
    let invalid = list(&vectors, "invalid");
    assert_eq!(invalid.len(), 30);
    for item in invalid {
        let label = format!("{} {}", text(item, "kind"), text(item, "name"));
        let bytes = object_bytes(item, &label);
        // Each is canonical JSON: what it breaks is a rule of its kind (§7.2, §7.3, §8).
        assert!(
            json::parse_canonical(&bytes).is_ok(),
            "{label}: not canonical"
        );
        let (kind, outcome) = match text(item, "kind") {
            "tree" => (ObjectKind::Tree, Tree::parse(&bytes).map(drop)),
            "commit" => (ObjectKind::Commit, Commit::parse(&bytes).map(drop)),
            other => panic!("{label}: no object kind {other:?}"),
        };
        assert_eq!(
            ObjectId::of(kind, &bytes).to_string(),
            text(item, "id"),
            "{label}"
        );
        assert!(
            outcome.is_err(),
            "{label}: we accept it, the vector says {}",
            item["reason"]
        );
    }
}

#[test]
fn commit_rules_has_five_sections() {
    let vectors = read("commit-rules.json");
    assert_eq!(
        sections(&vectors),
        [
            "availability",
            "changes",
            "commits",
            "deletion",
            "description",
            "root"
        ]
    );
}

/// The commit of objects.json named `name`.
fn named<'a>(example: &'a Example, name: &str) -> &'a Commit {
    let (.., commit) = example
        .commits
        .iter()
        .find(|(label, ..)| label == name)
        .unwrap_or_else(|| panic!("objects.json has no commit {name}"));
    commit
}

/// Commits read with their parents and the trees of objects.json (remote-format.md §11, "a commit
/// in its history"), some trees absent.
#[test]
fn commit_rules_commits() {
    let example = example(&read("objects.json"));
    let vectors = read("commit-rules.json");
    let cases = list(&vectors, "commits");
    assert_eq!(cases.len(), 14);
    for item in cases {
        let name = text(item, "name");
        let parent = item["parent"]
            .as_str()
            .map(|parent| named(&example, parent));
        let absent: Vec<ObjectId> = item
            .get("absent_trees")
            .map(|absent| {
                let ids = absent.as_array().expect("absent_trees is a list");
                ids.iter()
                    .map(|id| ObjectId::parse(id.as_str().unwrap()).unwrap())
                    .collect()
            })
            .unwrap_or_default();
        // A commit that breaks its schema is invalid before anything needs its trees.
        let (got, why) = match Commit::from_value(format_value(&item["commit"])) {
            Err(error) => ("invalid", error.to_string()),
            Ok(commit) => {
                let trees = source(&example.trees, &absent);
                let id = commit.encode().unwrap().id();
                outcome(HistoryChecker::new(&trees).check_commit(id, &commit, parent))
            }
        };
        let expected = text(item, "expect");
        assert_eq!(
            got, expected,
            "{name}: we say {got} ({why}), the vector says {expected} {}",
            item["reason"]
        );
    }
}

/// Change records against small flattened trees (§8), as maps and as the trees they flatten.
#[test]
fn commit_rules_changes() {
    let vectors = read("commit-rules.json");
    let cases = list(&vectors, "changes");
    assert_eq!(cases.len(), 10);
    for item in cases {
        let name = text(item, "name");
        let (parent, tree) = (flat_tree(&item["parent_tree"]), flat_tree(&item["tree"]));
        let records = Changes::from_value(format_value(&item["changes"]))
            .unwrap_or_else(|error| panic!("{name}: the records do not parse: {error}"));
        let valid = item["valid"].as_bool().expect("valid is a boolean");
        let differences = Differences::between(&parent, &tree);
        let mut trees = MemoryTrees::new();
        let (parent_root, root) = (build(&mut trees, &parent), build(&mut trees, &tree));
        let walked = Differences::of_trees(&trees, Some(parent_root), root, DEFAULT_PATH_BUDGET);
        assert_eq!(
            walked.unwrap(),
            differences,
            "{name}: the walk finds other paths"
        );
        let checked = differences.check(&records);
        assert_eq!(
            checked.is_ok(),
            valid,
            "{name}: we say {checked:?}, the vector says valid = {valid} {}",
            item["reason"]
        );
    }
}

/// The root rules of §7.4 on flattened root trees, and on the trees they flatten, path lengths
/// at the limit and over it included.
#[test]
fn commit_rules_root() {
    let vectors = read("commit-rules.json");
    let cases = list(&vectors, "root");
    assert_eq!(cases.len(), 18);
    let by_name: HashMap<&str, &Vector> = cases
        .iter()
        .map(|item| (text(item, "name"), item))
        .collect();
    for item in cases {
        let name = text(item, "name");
        let tree = match item.get("tree") {
            Some(tree) => flat_tree(tree),
            None => {
                // Nested folders of one name, a file in the deepest, beside the base tree.
                let pattern = &item["tree_pattern"];
                let mut tree = flat_tree(&by_name[text(pattern, "base")]["tree"]);
                let folder =
                    value_text(&serde_json::json!({ "value_pattern": pattern["folder_name"] }));
                let depth = pattern["depth"].as_u64().expect("a depth") as usize;
                let mut path = String::new();
                for _ in 0..depth {
                    if !path.is_empty() {
                        path.push('/');
                    }
                    path.push_str(&folder);
                    tree.insert(path.clone(), FlatEntry::Dir);
                }
                path = format!("{path}/{}", text(pattern, "file_name"));
                let longest = path.encode_utf16().count() as u64;
                assert_eq!(
                    Some(longest),
                    pattern["longest_path_utf16"].as_u64(),
                    "{name}"
                );
                let file = tree[".folio/library.json"];
                tree.insert(path, file);
                tree
            }
        };
        let valid = item["valid"].as_bool().expect("valid is a boolean");
        let checked = check_root(&tree);
        assert_eq!(
            checked.is_ok(),
            valid,
            "{name}: we say {checked:?}, the vector says valid = {valid} {}",
            item["reason"]
        );
        // The checker on the trees: a first commit of this root, without change records.
        let mut trees = MemoryTrees::new();
        let root = build(&mut trees, &tree);
        let commit = Commit {
            tree: root,
            device: Device {
                id: DeviceId::parse("8c1e0d2b4a6f43e19d7c5b3a2f1e0d9c").unwrap(),
                name: DeviceName::parse("G16").unwrap(),
            },
            time: Timestamp::parse("2026-10-03T21:11:00Z").unwrap(),
            rebased_from: None,
            kind: CommitKind::Commit {
                parent: None,
                message: Message {
                    summary: Summary::parse("Start history").unwrap(),
                    body: None,
                    changes: None,
                },
            },
        };
        let id = commit.encode().unwrap().id();
        let (got, why) = outcome(HistoryChecker::new(&trees).check_commit(id, &commit, None));
        assert_eq!(
            got == "valid",
            valid,
            "{name}: the checker says {got} ({why})"
        );
    }
}

/// The history oldest first up to the commit named `head`.
fn chain_to<'a>(example: &'a Example, head: &str) -> Vec<&'a Commit> {
    let end = example
        .commits
        .iter()
        .position(|(name, ..)| name == head)
        .unwrap_or_else(|| panic!("objects.json has no commit {head}"));
    example.commits[..=end]
        .iter()
        .map(|(.., commit)| commit)
        .collect()
}

/// Which absent blobs are pruned and which missing, and which blobs a store may delete (§7.5).
#[test]
fn commit_rules_availability_and_deletion() {
    let example = example(&read("objects.json"));
    let trees = source(&example.trees, &[]);
    let vectors = read("commit-rules.json");
    for item in list(&vectors, "availability") {
        let name = text(item, "name");
        let chain = chain_to(&example, text(item, "head"));
        let entry = text(item, "entry_commit");
        let index = example
            .commits
            .iter()
            .position(|(label, ..)| label == entry)
            .expect("the entry's commit");
        let blob = ObjectId::parse(text(item, "blob")).unwrap();
        let got = match absent_blob(&chain, index, blob) {
            StoreError::Pruned(id) if id == blob => "pruned",
            StoreError::Missing(id) if id == blob => "missing",
            other => panic!("{name}: {other}"),
        };
        assert_eq!(got, text(item, "expect"), "{name}");
    }
    for item in list(&vectors, "deletion") {
        let name = text(item, "name");
        let chain = chain_to(&example, text(item, "head"));
        let blob = ObjectId::parse(text(item, "blob")).unwrap();
        let expected = item["deletable"].as_bool().expect("deletable is a boolean");
        assert_eq!(
            may_delete(&trees, &chain, blob).unwrap(),
            expected,
            "{name}"
        );
    }
}

#[test]
fn packs_has_two_sections() {
    let vectors = read("packs.json");
    assert_eq!(sections(&vectors), ["description", "packs", "variants"]);
    assert_eq!(list(&vectors, "packs").len(), 5);
    assert_eq!(list(&vectors, "variants").len(), 37);
}

/// The blobs, trees and commits of objects.json by id, each with its kind and bytes.
fn objects_by_id(vectors: &Vector) -> HashMap<ObjectId, (ObjectKind, Vec<u8>)> {
    let mut objects = HashMap::new();
    for (section, kind) in [
        ("blobs", ObjectKind::Blob),
        ("trees", ObjectKind::Tree),
        ("commits", ObjectKind::Commit),
    ] {
        for item in list(vectors, section) {
            let bytes = object_bytes(item, section);
            objects.insert(ObjectId::of(kind, &bytes), (kind, bytes));
        }
    }
    objects
}

/// A record of a pack (remote-format.md §9.2), read by its layout alone.
struct Record<'a> {
    code: u8,
    flags: u8,
    id: ObjectId,
    raw_length: u64,
    payload: &'a [u8],
    /// The offset after it.
    end: usize,
}

fn u64_at(bytes: &[u8], at: usize) -> u64 {
    u64::from_le_bytes(bytes[at..at + 8].try_into().unwrap())
}

fn record_at(pack: &[u8], offset: usize) -> Record<'_> {
    let stored = usize::try_from(u64_at(pack, offset + 42)).unwrap();
    Record {
        code: pack[offset],
        flags: pack[offset + 1],
        id: ObjectId::from_bytes(pack[offset + 2..offset + 34].try_into().unwrap()),
        raw_length: u64_at(pack, offset + 34),
        payload: &pack[offset + 50..offset + 50 + stored],
        end: offset + 50 + stored,
    }
}

/// The records of a pack whose layout holds, from offset 12 to its index.
fn records(pack: &[u8]) -> Vec<Record<'_>> {
    let count = usize::try_from(u64_at(pack, pack.len() - 48)).unwrap();
    let index_at = pack.len() - 48 - 40 * count;
    let mut records = Vec::new();
    let mut at = 12;
    while at < index_at {
        let record = record_at(pack, at);
        at = record.end;
        records.push(record);
    }
    assert_eq!(at, index_at, "the records end where the index begins");
    records
}

fn kind_named(name: &str) -> ObjectKind {
    ObjectKind::ALL
        .into_iter()
        .find(|kind| kind.name() == name)
        .unwrap_or_else(|| panic!("no object kind {name:?}"))
}

/// Our writer reproduces the five packs of the example library byte for byte, given the objects
/// in the vector's order: the raw records from objects.json, the compressed ones (two in pack-2,
/// one in pack-3) from the frames they store, as compressed bytes are not canonical (§9.3).
/// Copying every record as it is stored gives the same bytes again.
#[test]
fn packs_are_written_byte_for_byte() {
    let objects = objects_by_id(&read("objects.json"));
    let vectors = read("packs.json");
    let mut compressed_records = Vec::new();
    for pack in list(&vectors, "packs") {
        let label = text(pack, "label");
        let bytes = unhex(text(pack, "hex"));
        assert_eq!(Some(bytes.len() as u64), pack["size"].as_u64(), "{label}");
        let listed = list(pack, "objects");
        let mut writer = PackWriter::new(MemorySink::new()).unwrap();
        let mut copier = PackWriter::new(MemorySink::new()).unwrap();
        let mut compressed_here = 0;
        for object in listed {
            let kind = kind_named(text(object, "type"));
            let id = ObjectId::parse(text(object, "id")).unwrap();
            let offset = object["offset"].as_u64().expect("an offset");
            let compressed = object["compressed"]
                .as_bool()
                .expect("compressed is a boolean");
            let (object_kind, raw) = objects
                .get(&id)
                .unwrap_or_else(|| panic!("{label}: objects.json has no {kind} {id}"));
            assert_eq!(*object_kind, kind, "{label}: {id}");
            let record = record_at(&bytes, usize::try_from(offset).unwrap());
            assert_eq!(
                (record.code, record.flags, record.id, record.raw_length),
                (kind.code(), u8::from(compressed), id, raw.len() as u64),
                "{label}: the record at {offset}"
            );
            let size = Size::new(raw.len() as u64).unwrap();
            let added = if compressed {
                compressed_here += 1;
                writer.add_stored(kind, id, size, record.payload, true)
            } else {
                match kind {
                    ObjectKind::Blob => writer.add_blob(raw, false),
                    ObjectKind::Tree => {
                        writer.add_object(&Tree::parse(raw).unwrap().encode().unwrap(), false)
                    }
                    ObjectKind::Commit => {
                        writer.add_object(&Commit::parse(raw).unwrap().encode().unwrap(), false)
                    }
                }
            };
            assert_eq!(
                added.unwrap(),
                Added::Written { offset, compressed },
                "{label}: {kind} {id}"
            );
            let copied = copier.add_stored(kind, id, size, record.payload, compressed);
            assert_eq!(copied.unwrap().offset(), offset, "{label}: {kind} {id}");
        }
        compressed_records.push(compressed_here);
        let (index, sink) = writer.finish().unwrap();
        assert!(sink.bytes() == bytes, "{label}: we write other bytes");
        assert_eq!(index.name().file_name(), text(pack, "name"), "{label}");
        assert_eq!(index.size(), bytes.len() as u64, "{label}");
        let mut entries: Vec<IndexEntry> = listed
            .iter()
            .map(|object| IndexEntry {
                id: ObjectId::parse(text(object, "id")).unwrap(),
                offset: object["offset"].as_u64().unwrap(),
            })
            .collect();
        entries.sort_unstable();
        assert_eq!(index.entries(), entries, "{label}");
        let (copied_index, copied) = copier.finish().unwrap();
        assert!(
            copied.bytes() == bytes,
            "{label}: copied records give other bytes"
        );
        assert_eq!(copied_index, index, "{label}");
    }
    assert_eq!(compressed_records, [0, 2, 1, 0, 0]);
}

/// packs.json's variants whose records break a rule of a record (§9.2, §9.3) or of the object in
/// it (§5, §7.2): the writer refuses them as a reader does.
const REFUSED_RECORDS: [&str; 15] = [
    "raw-length-mismatch",
    "object-id-mismatch",
    "zstd-content-size-mismatch",
    "zstd-decoded-size-mismatch",
    "zstd-trailing-bytes",
    "zstd-dictionary",
    "zstd-window-too-large",
    "zstd-reserved-bit",
    "zstd-truncated-header",
    "zstd-corrupt-block",
    "tree-declared-too-large",
    "tree-nested-too-deeply",
    "noncanonical-tree",
    "tree-unknown-field",
    "tree-name-not-nfc",
];

/// The variants' records copied through the writer as they are stored: valid frames of every
/// block and header kind (Node's libzstd and hand-made) give the variant's bytes again, broken
/// records are refused, and a record twice is written once. The records are found by the layout
/// alone, as the writer needs their payloads as stored; `pack_variants_through_the_reader` reads
/// the variants.
#[test]
fn pack_variants_through_the_writer() {
    let vectors = read("packs.json");
    let variants: HashMap<&str, &Vector> = list(&vectors, "variants")
        .iter()
        .map(|variant| (text(variant, "name"), variant))
        .collect();
    let copy = |name: &str| -> Result<Vec<u8>, StoreError> {
        let bytes = unhex(text(variants[name], "hex"));
        let mut writer = PackWriter::new(MemorySink::new())?;
        for record in records(&bytes) {
            let kind = ObjectKind::from_code(record.code).expect("a record type of version 1");
            assert!(record.flags <= 1, "{name}: flags {}", record.flags);
            let size = Size::new(record.raw_length).expect("a size of the format");
            writer.add_stored(kind, record.id, size, record.payload, record.flags == 1)?;
        }
        Ok(writer.finish()?.1.into_bytes())
    };
    let mut valid = 0;
    for (name, variant) in &variants {
        if text(variant, "expect") == "ok" {
            valid += 1;
            let bytes = unhex(text(variant, "hex"));
            assert!(copy(name).unwrap() == bytes, "{name}: other bytes");
        }
    }
    assert_eq!(valid, 7);
    for name in REFUSED_RECORDS {
        let variant = variants
            .get(name)
            .unwrap_or_else(|| panic!("packs.json has no variant {name}"));
        assert_eq!(text(variant, "expect"), "invalid", "{name}");
        match copy(name) {
            Err(StoreError::Invalid { .. } | StoreError::TooLarge { .. }) => {}
            Err(other) => panic!("{name}: {other}"),
            Ok(_) => panic!("{name}: we write it, the vector says {}", variant["reason"]),
        }
    }
    // duplicate-object holds the blob twice; the small pack name-mismatch holds it once.
    let once = unhex(text(variants["name-mismatch"], "hex"));
    assert!(copy("duplicate-object").unwrap() == once);
}

/// How our reader ends on a pack or a record: `ok`, `newer` or `invalid` (the words of packs.json
/// and records.json), with our reason.
fn read_outcome<T>(result: &Result<T, StoreError>) -> (&'static str, String) {
    match result {
        Ok(_) => ("ok", String::new()),
        Err(error @ StoreError::Newer { .. }) => ("newer", error.to_string()),
        Err(error @ StoreError::Invalid { .. }) => ("invalid", error.to_string()),
        Err(other) => panic!("neither ok, newer nor invalid: {other}"),
    }
}

/// The object `entry` names read whole through [`PackReader::read_object`], in pieces of uneven
/// sizes.
fn read_object(pack: &[u8], entry: IndexEntry) -> Result<(ObjectKind, Vec<u8>), StoreError> {
    let mut object = PackReader::from_bytes(pack).read_object(entry.id, entry.offset)?;
    let mut raw = Vec::new();
    for &size in [1, 7, 64, 4096].iter().cycle() {
        let mut piece = vec![0; size];
        let read = object.read_checked(&mut piece)?;
        if read == 0 {
            break;
        }
        raw.extend_from_slice(&piece[..read]);
    }
    assert!(object.is_verified());
    Ok((object.kind(), raw))
}

/// The five packs verify with their file names and without, walk their records as the vector lists
/// them, give the same index when only the index is read, and hold exactly objects.json's objects:
/// streamed, read through `std::io::Read`, and parsed as trees and commits.
#[test]
fn packs_verify_and_read_back() {
    let objects = objects_by_id(&read("objects.json"));
    let vectors = read("packs.json");
    for pack in list(&vectors, "packs") {
        let label = text(pack, "label");
        let bytes = unhex(text(pack, "hex"));
        let name = PackName::from_file_name(text(pack, "name")).unwrap();
        let mut records = Vec::new();
        let index = PackReader::from_bytes(&bytes)
            .verify_with(Some(name), |record| records.push(*record))
            .unwrap_or_else(|error| panic!("{label}: {error}"));
        assert_eq!(index.name(), name, "{label}");
        assert_eq!(index.size(), bytes.len() as u64, "{label}");
        let mut reader = PackReader::from_bytes(&bytes);
        assert_eq!(reader.verify(None).unwrap(), index, "{label}");
        assert_eq!(reader.read_index(Some(name)).unwrap(), index, "{label}");
        assert_eq!(reader.read_index(None).unwrap(), index, "{label}");
        let listed: Vec<(ObjectKind, ObjectId, u64, bool)> = list(pack, "objects")
            .iter()
            .map(|object| {
                (
                    kind_named(text(object, "type")),
                    ObjectId::parse(text(object, "id")).unwrap(),
                    object["offset"].as_u64().unwrap(),
                    object["compressed"].as_bool().unwrap(),
                )
            })
            .collect();
        let walked: Vec<(ObjectKind, ObjectId, u64, bool)> = records
            .iter()
            .map(|record| (record.kind, record.id, record.offset, record.compressed))
            .collect();
        assert_eq!(walked, listed, "{label}");
        assert_eq!(index.object_count(), listed.len(), "{label}");
        for &entry in index.entries() {
            let (kind, raw) = &objects[&entry.id];
            let id = entry.id;
            let read =
                read_object(&bytes, entry).unwrap_or_else(|error| panic!("{label}: {error}"));
            assert!(read == (*kind, raw.clone()), "{label}: {kind} {id}");
            let mut streamed = Vec::new();
            std::io::Read::read_to_end(
                &mut PackReader::from_bytes(&bytes)
                    .read_object(id, entry.offset)
                    .unwrap(),
                &mut streamed,
            )
            .unwrap();
            assert!(streamed == *raw, "{label}: {kind} {id} through Read");
            match kind {
                ObjectKind::Tree => assert_eq!(
                    reader.read_tree(id, entry.offset).unwrap(),
                    Tree::parse(raw).unwrap(),
                    "{label}: {id}"
                ),
                ObjectKind::Commit => assert_eq!(
                    reader.read_commit(id, entry.offset).unwrap(),
                    Commit::parse(raw).unwrap(),
                    "{label}: {id}"
                ),
                ObjectKind::Blob => {}
            }
        }
    }
}

/// The reasons generate.mjs gives for a step that reading only the index runs (§11 steps 1–4, the
/// file name against the stated hash, and step 6). The vectors' reasons are informative, but they
/// say which step fails first, which decides what a partial reader must find.
const INDEX_REASONS: [&str; 7] = [
    "too-short",
    "magic",
    "version",
    "end-magic",
    "name",
    "index-size",
    "index-order",
];

/// Whether a generate.mjs reason is a broken record of its own (§11 steps 7–11), which reading
/// that record through the index finds.
fn broken_record(reason: &str) -> bool {
    [
        "record-type",
        "record-flags",
        "raw-length",
        "object-",
        "zstd-",
    ]
    .iter()
    .any(|prefix| reason.starts_with(prefix))
}

/// The 37 variants end as the vector says, with their file names and without (only name-mismatch,
/// the small valid pack under another name, differs); reading only the index refuses exactly
/// those that fail one of its steps first; and every object the index lists reads back unless its
/// own record is broken.
#[test]
fn pack_variants_through_the_reader() {
    let vectors = read("packs.json");
    let mut seen = BTreeMap::new();
    for variant in list(&vectors, "variants") {
        let label = text(variant, "name");
        let bytes = unhex(text(variant, "hex"));
        let name = PackName::from_file_name(text(variant, "file_name")).unwrap();
        let expect = text(variant, "expect");
        let reason = variant.get("reason").and_then(Vector::as_str).unwrap_or("");
        let (with_name, ours) = read_outcome(&PackReader::from_bytes(&bytes).verify(Some(name)));
        assert_eq!(
            with_name, expect,
            "{label}: we say {ours:?}, the vector {reason:?}"
        );
        let (without, ours) = read_outcome(&PackReader::from_bytes(&bytes).verify(None));
        let expect_without = if label == "name-mismatch" {
            "ok"
        } else {
            expect
        };
        assert_eq!(
            without, expect_without,
            "{label} without its name: we say {ours:?}"
        );
        let index = PackReader::from_bytes(&bytes).read_index(Some(name));
        let expect_index = if INDEX_REASONS.contains(&reason) {
            expect
        } else {
            "ok"
        };
        let (indexed, ours) = read_outcome(&index);
        assert_eq!(
            indexed, expect_index,
            "{label}, its index: we say {ours:?}, the vector {reason:?}"
        );
        if let Ok(index) = index {
            let refused = index
                .entries()
                .iter()
                .filter(|&&entry| read_object(&bytes, entry).is_err())
                .count();
            assert_eq!(
                refused > 0,
                broken_record(reason),
                "{label}: {refused} objects refused, the vector {reason:?}"
            );
        }
        *seen.entry(expect).or_insert(0) += 1;
    }
    assert_eq!(
        seen,
        BTreeMap::from([("invalid", 29), ("newer", 1), ("ok", 7)])
    );
}

/// A record of records.json read by its kind, from its bytes or (`from_source`) through
/// `std::io::Read`: the bytes it encodes back to, and the path its content names.
fn read_record(
    kind: &str,
    bytes: &[u8],
    path: &str,
    from_source: bool,
) -> Result<(Vec<u8>, RecordPath), StoreError> {
    let head = |record: HeadRecord| {
        (
            record.encode().expect("a head record encodes"),
            record.path(),
        )
    };
    let intent =
        |record: IntentRecord| (record.encode().expect("an intent encodes"), record.path());
    match (kind, from_source) {
        ("format", false) => FormatRecord::parse(bytes, path).map(|r| (r.encode(), r.path())),
        ("format", true) => FormatRecord::read(bytes, path).map(|r| (r.encode(), r.path())),
        ("head", false) => HeadRecord::parse(bytes, path).map(head),
        ("head", true) => HeadRecord::read(bytes, path).map(head),
        ("intent", false) => IntentRecord::parse(bytes, path).map(intent),
        ("intent", true) => IntentRecord::read(bytes, path).map(intent),
        (other, _) => panic!("no record kind {other:?}"),
    }
}

/// Every record of records.json ends as the vector says, read from its bytes and from a source,
/// at the path the vector gives; every valid one encodes back to exactly its bytes and names that
/// path.
#[test]
fn remote_records() {
    let vectors = read("records.json");
    assert_eq!(sections(&vectors), ["description", "records"]);
    let mut seen = BTreeMap::new();
    for item in list(&vectors, "records") {
        let kind = text(item, "kind");
        let label = format!("{kind} {}", text(item, "name"));
        let path = text(item, "path");
        let expect = text(item, "expect");
        let reason = item.get("reason").and_then(Vector::as_str).unwrap_or("");
        let bytes = object_bytes(item, &label);
        for from_source in [false, true] {
            let result = read_record(kind, &bytes, path, from_source);
            let (outcome, ours) = read_outcome(&result);
            assert_eq!(
                outcome, expect,
                "{label}: we say {ours:?}, the vector {reason:?}"
            );
            if let Ok((encoded, named)) = result {
                assert!(encoded == bytes, "{label}: encodes to other bytes");
                assert_eq!(named.to_string(), path, "{label}");
                assert_eq!(RecordPath::parse(path), Some(named), "{label}");
            }
        }
        *seen.entry((kind, expect)).or_insert(0) += 1;
    }
    assert_eq!(
        seen,
        BTreeMap::from([
            (("format", "invalid"), 5),
            (("format", "newer"), 2),
            (("format", "ok"), 1),
            (("head", "invalid"), 8),
            (("head", "newer"), 1),
            (("head", "ok"), 5),
            (("intent", "invalid"), 8),
            (("intent", "ok"), 4),
        ])
    );
}

/// The mirror changes from the flattened tree `before` to `after`, as generate.mjs's
/// `mirrorWrites` makes them: each path of `after` whose entry is new or not the same is written,
/// each path of `before` that is gone or of another kind is deleted.
fn mirror_writes(before: &FlatTree, after: &FlatTree) -> MirrorWrites {
    let path = |text: &str| TreePath::parse(text).unwrap();
    let mut writes = Vec::new();
    for (text, entry) in after {
        if before.get(text) == Some(entry) {
            continue;
        }
        writes.push(match entry {
            FlatEntry::File(side) => MirrorWrite::WriteFile {
                path: path(text),
                hash: side.hash,
            },
            FlatEntry::Dir => MirrorWrite::WriteDir { path: path(text) },
        });
    }
    for (text, entry) in before {
        match (entry, after.get(text)) {
            (FlatEntry::Dir, Some(FlatEntry::Dir))
            | (FlatEntry::File(_), Some(FlatEntry::File(_))) => {}
            (FlatEntry::File(_), _) => writes.push(MirrorWrite::DeleteFile { path: path(text) }),
            (FlatEntry::Dir, _) => writes.push(MirrorWrite::DeleteDir { path: path(text) }),
        }
    }
    MirrorWrites::new(writes).unwrap()
}

/// The valid heads and intents of records.json tell the story of packs.json and objects.json:
/// device A pushes c1 and c2, device B its rebased import c3, device A the prune commit c4 and c5.
/// Each head names its commit and that commit's pack with its size, counts its device's pushes
/// from 1, and orders all pushes by Lamport value; each intent builds on the commit before, and its
/// writes are how the mirror changes between the two trees, in the order of §10.4.
#[test]
fn records_tell_the_story_of_the_pushes() {
    let objects = read("objects.json");
    let example = example(&objects);
    let library = LibraryId::parse(text(&objects, "library_id")).unwrap();
    let commit = |name: &str| {
        let (_, id, commit) = example
            .commits
            .iter()
            .find(|(label, ..)| label == name)
            .unwrap_or_else(|| panic!("objects.json has no commit {name}"));
        (*id, commit)
    };
    let packs: BTreeMap<String, PackRef> = list(&read("packs.json"), "packs")
        .iter()
        .map(|pack| {
            let name = PackName::from_file_name(text(pack, "name")).unwrap();
            let size = Size::new(pack["size"].as_u64().expect("a size")).unwrap();
            (text(pack, "label").to_owned(), PackRef { name, size })
        })
        .collect();
    let vectors = read("records.json");
    let valid = |kind: &'static str| {
        list(&vectors, "records")
            .iter()
            .filter(move |item| text(item, "kind") == kind && text(item, "expect") == "ok")
    };
    let heads: Vec<HeadRecord> = valid("head")
        .map(|item| HeadRecord::parse(&unhex(text(item, "hex")), text(item, "path")).unwrap())
        .collect();
    assert_eq!(heads.len(), 5);
    for (i, head) in heads.iter().enumerate() {
        let name = format!("c{}", i + 1);
        let (id, made) = commit(&name);
        assert_eq!(head.head, id, "{name}");
        assert_eq!(head.library_id, library, "{name}");
        assert_eq!(
            head.device, made.device,
            "{name} is pushed by the device that made it"
        );
        assert_eq!(head.lamport.get(), i as u64 + 1, "{name}");
        assert_eq!(
            head.intent, head.seq,
            "{name}: the push's intent has its number"
        );
        let pack = packs[&format!("pack-{}", i + 1)];
        assert_eq!(head.packs.packs(), [pack], "{name}");
    }
    let numbers: Vec<(&str, u64)> = heads
        .iter()
        .map(|head| (head.device.name.as_str(), head.seq.get()))
        .collect();
    assert_eq!(
        numbers,
        [
            ("G16", 1),
            ("G16", 2),
            ("台式机", 1),
            ("G16", 3),
            ("G16", 4)
        ]
    );
    let intents: Vec<IntentRecord> = valid("intent")
        .filter(|item| text(item, "name").starts_with("intents "))
        .map(|item| IntentRecord::parse(&unhex(text(item, "hex")), text(item, "path")).unwrap())
        .collect();
    let trees = source(&example.trees, &[]);
    let flat = |name: &str| flatten(&trees, commit(name).1.tree, DEFAULT_PATH_BUDGET).unwrap();
    let pushes = [(None, "c1"), (Some("c1"), "c2"), (Some("c2"), "c3")];
    assert_eq!(intents.len(), pushes.len());
    for (intent, (base, head)) in intents.iter().zip(pushes) {
        assert_eq!(intent.head, commit(head).0, "{head}");
        assert_eq!(intent.base, base.map(|base| commit(base).0), "{head}");
        assert_eq!(intent.device, commit(head).1.device, "{head}");
        assert_eq!(intent.library_id, library, "{head}");
        let before = base.map(flat).unwrap_or_default();
        assert_eq!(intent.writes, mirror_writes(&before, &flat(head)), "{head}");
    }
}
