//! Proptest strategies for the values and objects of history format 1, and test data, for the
//! store's tests and the catalog's.

use proptest::prelude::*;

use super::json::{Int, Value};
use super::*;

/// `len` bytes of text that compresses.
pub(crate) fn text(len: usize) -> Vec<u8> {
    "# 第3讲 特征值\n特征值 λ 满足 det(A − λI) = 0。\n"
        .bytes()
        .cycle()
        .take(len)
        .collect()
}

/// `len` bytes that do not compress.
pub(crate) fn noise(len: usize) -> Vec<u8> {
    let mut bytes = vec![0; len];
    blake3::Hasher::new()
        .update(b"noise")
        .finalize_xof()
        .fill(&mut bytes);
    bytes
}

/// A zstd frame of `count` bytes `a` as one block, an RLE block when `rle` and a raw block
/// otherwise, that states its content size in four bytes: with a window of 2^`window_log` bytes,
/// or in a single segment, whose window is its content, when `window_log` is 0. RFC 8878 holds the
/// block to the smaller of the window and 128 KiB (§3.1.1.2).
pub(crate) fn one_block_frame(count: usize, window_log: u8, rle: bool) -> Vec<u8> {
    let single = window_log == 0;
    let mut frame = vec![0x28, 0xb5, 0x2f, 0xfd];
    // The descriptor: a content size of four bytes, in a single segment or after a window
    // descriptor.
    frame.push(if single { 0xa0 } else { 0x80 });
    if !single {
        frame.push((window_log - 10) << 3);
    }
    let size = u32::try_from(count).expect("a content size of four bytes");
    frame.extend_from_slice(&size.to_le_bytes());
    // The block header: Block_Size, Block_Type (1 for RLE, 0 for raw) and Last_Block.
    let header = (count << 3) | (usize::from(rle) << 1) | 1;
    frame.extend_from_slice(&header.to_le_bytes()[..3]);
    if rle {
        frame.push(b'a');
    } else {
        frame.resize(frame.len() + count, b'a');
    }
    frame
}

/// A tree of `count` files, each holding `bytes`.
pub(super) fn tree_of(bytes: &[u8], count: usize) -> Encoded {
    let side = Side {
        hash: ObjectId::of(ObjectKind::Blob, bytes),
        size: Size::new(bytes.len() as u64).expect("a size of the format"),
        stored: true,
    };
    let entries = (0..count)
        .map(|i| TreeEntry::file(Name::parse(&format!("第{i}讲.md")).expect("a name"), side))
        .collect();
    Tree::new(entries)
        .expect("distinct names")
        .encode()
        .expect("a small tree")
}

/// A first commit of `tree`.
pub(crate) fn commit_of(tree: ObjectId) -> Encoded {
    Commit {
        tree,
        device: Device {
            id: DeviceId::parse("8c1e0d2b4a6f43e19d7c5b3a2f1e0d9c").expect("a device id"),
            name: DeviceName::parse("G16").expect("a device name"),
        },
        time: Timestamp::parse("2026-10-03T21:11:00Z").expect("a time"),
        rebased_from: None,
        kind: CommitKind::Commit {
            parent: None,
            message: Message {
                summary: Summary::parse("Start history").expect("a summary"),
                body: None,
                changes: None,
            },
        },
    }
    .encode()
    .expect("a small commit")
}

/// A first commit whose root holds `.folio/library.json` and a course folder, as §7.4 asks: its
/// blobs (`library.json`, then the course's notes), its trees (`.folio`, the course, the root) and
/// the commit.
pub(crate) fn first_commit() -> (Vec<Vec<u8>>, Vec<Encoded>, Encoded) {
    let library = br#"{"format_version":2}"#.to_vec();
    let notes = text(400);
    let side = |bytes: &[u8]| Side {
        hash: ObjectId::of(ObjectKind::Blob, bytes),
        size: Size::new(bytes.len() as u64).expect("a size of the format"),
        stored: true,
    };
    let tree = |entries| {
        Tree::new(entries)
            .expect("distinct names")
            .encode()
            .expect("a small tree")
    };
    let name = |text: &str| Name::parse(text).expect("a name");
    let folio = tree(vec![TreeEntry::file(name("library.json"), side(&library))]);
    let course = tree(vec![TreeEntry::file(name("第3讲.md"), side(&notes))]);
    let root = tree(vec![
        TreeEntry::dir(name(".folio"), folio.id()),
        TreeEntry::dir(name("线性代数"), course.id()),
    ]);
    let commit = commit_of(root.id());
    (vec![library, notes], vec![folio, course, root], commit)
}

pub(super) fn object_id() -> impl Strategy<Value = ObjectId> {
    any::<[u8; 32]>().prop_map(ObjectId::from_bytes)
}

/// Valid names from pieces that sort differently by UTF-8 and UTF-16 (`Ａ`, `😀`) or by case, with
/// spaces and dots inside, and characters canonical JSON writes as themselves (U+007F, U+2028).
pub(super) fn name() -> impl Strategy<Value = Name> {
    let pieces = vec![
        "a", "B", "z", "0", "9", " ", ".", "-", "_", "é", "Ａ", "😀", "台", "式", "&", "'", "#",
        "\u{7f}", "\u{2028}", "ſ", "ı",
    ];
    prop::collection::vec(prop::sample::select(pieces), 1..6)
        .prop_filter_map("a valid name", |pieces| Name::parse(&pieces.concat()).ok())
}

pub(super) fn path() -> impl Strategy<Value = TreePath> {
    prop::collection::vec(name(), 1..4).prop_map(|names| {
        let names: Vec<&str> = names.iter().map(Name::as_str).collect();
        TreePath::parse(&names.join("/")).expect("valid names make a valid short path")
    })
}

pub(super) fn size() -> impl Strategy<Value = Size> {
    prop_oneof![Just(0), Just(Size::MAX.get()), 0..=Size::MAX.get()]
        .prop_map(|bytes| Size::new(bytes).expect("a size of the format"))
}

pub(super) fn side() -> impl Strategy<Value = Side> {
    (object_id(), size(), any::<bool>()).prop_map(|(hash, size, stored)| Side {
        hash,
        size,
        stored,
    })
}

/// What a name of a random tree holds.
#[derive(Debug, Clone)]
enum Target {
    File(Side),
    Dir(ObjectId),
}

/// A tree of up to `max` entries.
pub(super) fn tree(max: usize) -> impl Strategy<Value = Tree> {
    let target = prop_oneof![
        side().prop_map(Target::File),
        object_id().prop_map(Target::Dir)
    ];
    prop::collection::btree_map(name(), target, 0..=max).prop_map(|entries| {
        let entries = entries
            .into_iter()
            .map(|(name, target)| match target {
                Target::File(side) => TreeEntry::file(name, side),
                Target::Dir(tree) => TreeEntry::dir(name, tree),
            })
            .collect();
        Tree::new(entries).expect("names of a map are distinct")
    })
}

/// Pieces of one line of text: letters, CJK, an emoji, white space, and the characters canonical
/// JSON escapes (`"`, `\`) or writes as themselves (`/`, U+2028).
const LINE: &[&str] = &[
    "a",
    "Z",
    " ",
    "台式机",
    "😀",
    "\"",
    "\\",
    "/",
    "\u{2028}",
    "\u{a0}",
    ":",
    "-",
    "Ａ",
];

fn text_of(
    pieces: &'static [&'static str],
    counts: std::ops::Range<usize>,
) -> BoxedStrategy<String> {
    prop::collection::vec(prop::sample::select(pieces), counts)
        .prop_map(|pieces| pieces.concat())
        .boxed()
}

pub(super) fn summary() -> impl Strategy<Value = Summary> {
    prop_oneof![
        8 => text_of(LINE, 1..12),
        1 => Just("s".repeat(MAX_SUMMARY_CHARS)),
    ]
    .prop_filter_map("a valid summary", |text| Summary::parse(&text).ok())
}

pub(super) fn body() -> impl Strategy<Value = Body> {
    const BODY: &[&str] = &[
        "a",
        "台式机",
        "😀",
        " ",
        "\t",
        "\n",
        "\"",
        "\\",
        "/",
        "-",
        "\u{2028}",
    ];
    text_of(BODY, 1..16).prop_filter_map("a valid body", |text| Body::parse(&text).ok())
}

/// `bytes` as lower-case hexadecimal digits.
fn hex_of(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

pub(super) fn device() -> impl Strategy<Value = Device> {
    let name = text_of(LINE, 1..6)
        .prop_filter_map("a valid device name", |text| DeviceName::parse(&text).ok());
    (any::<[u8; 16]>(), name).prop_map(|(bytes, name)| Device {
        id: DeviceId::parse(&hex_of(&bytes)).expect("32 lower-case hexadecimal digits"),
        name,
    })
}

pub(super) fn library_id() -> impl Strategy<Value = LibraryId> {
    any::<[u8; 16]>().prop_map(|bytes| {
        LibraryId::parse(&hex_of(&bytes)).expect("32 lower-case hexadecimal digits")
    })
}

pub(super) fn count() -> impl Strategy<Value = Count> {
    prop_oneof![Just(1), Just(Count::MAX.get()), 1..=Count::MAX.get()]
        .prop_map(|value| Count::new(value).expect("a count"))
}

pub(super) fn time() -> impl Strategy<Value = Timestamp> {
    (0..=Timestamp::MAX.unix_seconds())
        .prop_map(|seconds| Timestamp::from_unix_seconds(seconds).expect("in range"))
}

/// One change record of any shape that meets §8 rule 4; moves often keep their file unchanged.
pub(super) fn change() -> impl Strategy<Value = Change> {
    prop_oneof![
        (path(), side()).prop_map(|(path, new)| Change::AddFile { path, new }),
        path().prop_map(|path| Change::AddDir { path }),
        (path(), side()).prop_map(|(path, old)| Change::DeleteFile { path, old }),
        path().prop_map(|path| Change::DeleteDir { path }),
        (path(), side(), side())
            .prop_filter("a modify changes its file", |(_, old, new)| old != new)
            .prop_map(|(path, old, new)| Change::ModifyFile { path, old, new }),
        (path(), path(), side(), any::<bool>(), side())
            .prop_filter("a move changes its path", |(from, path, ..)| from != path)
            .prop_map(|(from, path, old, unchanged, new)| Change::MoveFile {
                from,
                path,
                old,
                new: if unchanged { old } else { new },
            }),
        (path(), path())
            .prop_filter("a move changes its path", |(from, path)| from != path)
            .prop_map(|(from, path)| Change::MoveDir { from, path }),
    ]
}

/// 1 to `max` change records.
pub(super) fn changes(max: usize) -> impl Strategy<Value = Changes> {
    prop::collection::vec(change(), 1..=max)
        .prop_filter_map("each path and operation once", |records| {
            Changes::new(records).ok()
        })
}

pub(super) fn pruned() -> impl Strategy<Value = Pruned> {
    prop::collection::vec(object_id(), 1..6).prop_map(|ids| Pruned::new(ids).expect("1 to 5 blobs"))
}

pub(super) fn message() -> impl Strategy<Value = Message> {
    (
        summary(),
        proptest::option::of(body()),
        proptest::option::of(changes(8)),
    )
        .prop_map(|(summary, body, changes)| Message {
            summary,
            body,
            changes,
        })
}

/// A commit of any kind, with or without its optional fields.
pub(super) fn commit() -> impl Strategy<Value = Commit> {
    let parent = || proptest::option::of(object_id());
    let kind = prop_oneof![
        (parent(), message()).prop_map(|(parent, message)| CommitKind::Commit { parent, message }),
        (parent(), message()).prop_map(|(parent, message)| CommitKind::Import { parent, message }),
        (object_id(), pruned()).prop_map(|(parent, pruned)| CommitKind::Prune { parent, pruned }),
    ];
    (object_id(), device(), time(), parent(), kind).prop_map(
        |(tree, device, time, rebased_from, kind)| Commit {
            tree,
            device,
            time,
            rebased_from,
            kind,
        },
    )
}

pub(super) fn format_record() -> impl Strategy<Value = FormatRecord> {
    library_id().prop_map(|library_id| FormatRecord { library_id })
}

/// A pack of a head record, from the smallest pack to the largest size.
pub(super) fn pack_ref() -> impl Strategy<Value = PackRef> {
    let size = prop_oneof![
        Just(MIN_PACK_LEN),
        Just(Size::MAX.get()),
        MIN_PACK_LEN..=Size::MAX.get()
    ];
    (any::<[u8; 32]>(), size).prop_map(|(name, size)| PackRef {
        name: PackName::from_bytes(name),
        size: Size::new(size).expect("a size of the format"),
    })
}

/// 1 to `max` packs of a head record.
pub(super) fn pack_refs(max: usize) -> impl Strategy<Value = PackRefs> {
    prop::collection::vec(pack_ref(), 1..=max)
        .prop_filter_map("each name once", |packs| PackRefs::new(packs).ok())
}

/// A head record whose `intent` is at most its `seq`, often equal to it.
pub(super) fn head_record() -> impl Strategy<Value = HeadRecord> {
    let numbers =
        count().prop_flat_map(|seq| (Just(seq), prop_oneof![Just(seq.get()), 1..=seq.get()]));
    (
        library_id(),
        device(),
        numbers,
        count(),
        object_id(),
        pack_refs(6),
        time(),
    )
        .prop_map(
            |(library_id, device, (seq, intent), lamport, head, packs, time)| HeadRecord {
                library_id,
                device,
                seq,
                lamport,
                head,
                intent: Count::new(intent).expect("1 to seq"),
                packs,
                time,
            },
        )
}

/// Paths a mirror write may name: random ones, and paths in `.folio/` as the metadata has them.
pub(super) fn mirror_path() -> impl Strategy<Value = TreePath> {
    let metadata = vec![
        ".folio",
        ".folio/library.json",
        ".folio/tags.json",
        ".folio/meta",
        ".folio/meta/2026 秋",
        ".folio/meta/2026 秋/线性代数.json",
        ".folio/meta/local",
    ];
    prop_oneof![
        3 => path(),
        1 => prop::sample::select(metadata).prop_map(|text| TreePath::parse(text).expect("a path")),
    ]
}

pub(super) fn mirror_write() -> impl Strategy<Value = MirrorWrite> {
    prop_oneof![
        (mirror_path(), object_id()).prop_map(|(path, hash)| MirrorWrite::WriteFile { path, hash }),
        mirror_path().prop_map(|path| MirrorWrite::WriteDir { path }),
        mirror_path().prop_map(|path| MirrorWrite::DeleteFile { path }),
        mirror_path().prop_map(|path| MirrorWrite::DeleteDir { path }),
    ]
}

/// Up to `max` mirror writes that meet §10.4.
pub(super) fn mirror_writes(max: usize) -> impl Strategy<Value = MirrorWrites> {
    prop::collection::vec(mirror_write(), 0..=max).prop_filter_map(
        "each path and operation once, `.folio` only written as a folder",
        |writes| MirrorWrites::new(writes).ok(),
    )
}

/// An intent, with or without its base.
pub(super) fn intent_record() -> impl Strategy<Value = IntentRecord> {
    (
        library_id(),
        device(),
        count(),
        time(),
        proptest::option::of(object_id()),
        object_id(),
        mirror_writes(8),
    )
        .prop_map(
            |(library_id, device, seq, time, base, head, writes)| IntentRecord {
                library_id,
                device,
                seq,
                time,
                base,
                head,
                writes,
            },
        )
}

/// `bytes` with one byte flipped, removed or inserted, or cut short.
pub(super) fn mutated(bytes: Vec<u8>) -> impl Strategy<Value = Vec<u8>> {
    (
        Just(bytes),
        any::<prop::sample::Index>(),
        any::<u8>(),
        0..4_u8,
    )
        .prop_map(|(mut bytes, at, byte, how)| {
            let at = at.index(bytes.len() + 1);
            match how {
                0 if at < bytes.len() => bytes[at] ^= byte.max(1),
                1 if at < bytes.len() => {
                    bytes.remove(at);
                }
                2 => bytes.insert(at, byte),
                _ => bytes.truncate(at),
            }
            bytes
        })
}

/// Values built from the schemas' own keys and words, so that random documents get far into the
/// schema checks and their error paths.
pub(super) fn schema_like() -> impl Strategy<Value = Value> {
    let ints = prop_oneof![Just(0_u32), Just(1), 0..100_u32].boxed();
    let keys = vec![
        "entries",
        "hash",
        "kind",
        "name",
        "size",
        "stored",
        "changes",
        "op",
        "path",
        "from",
        "old",
        "new",
        "device",
        "id",
        "summary",
        "body",
        "time",
        "tree",
        "parent",
        "rebased_from",
        "pruned",
        "mode",
    ];
    let words = vec![
        "file",
        "dir",
        "commit",
        "import",
        "prune",
        "add",
        "delete",
        "modify",
        "move",
        "a",
        "a/b",
        "B.md",
        "",
        "G16",
        "2026-10-03T21:11:00Z",
        "8c1e0d2b4a6f43e19d7c5b3a2f1e0d9c",
        "b3:9b8b2fc76f6386c5507b9f545e0c960472b47ae5c4a4a906b952377ff33460d3",
        "b3:17e235e6291b29a843c8ac8962bec2b1923e9d4ea624888548725e13141e8439",
    ];
    value_like(keys, words, ints)
}

/// [`schema_like`] for the records of the remote store (remote-format.md §10).
pub(super) fn record_like() -> impl Strategy<Value = Value> {
    let ints = prop_oneof![Just(0_u32), Just(1), Just(2), 0..10_u32, 145..155_u32].boxed();
    let keys = vec![
        "format_version",
        "library_id",
        "device",
        "id",
        "name",
        "head",
        "intent",
        "lamport",
        "packs",
        "size",
        "seq",
        "time",
        "base",
        "writes",
        "op",
        "kind",
        "path",
        "hash",
        "extra",
    ];
    let words = vec![
        "write",
        "delete",
        "file",
        "dir",
        "move",
        ".folio",
        ".FOLIO",
        ".folio/library.json",
        ".folio/store/heads",
        ".folio/local",
        "a",
        "a/b",
        "B.md",
        "",
        "G16",
        "2026-10-04T08:00:00Z",
        "8c1e0d2b4a6f43e19d7c5b3a2f1e0d9c",
        "48ffdfb335860f2c15c8bccf2a90e720",
        "b3:b1f38f9a0f72eac52954da490551b3a90f57d5f6fcbb4bc95c665809595d06ec",
        "4645c77806536aef7208d70800f801a7ecb0ef9db5b22f1d05a2f9dabc4db911.pack",
        "4645c77806536aef7208d70800f801a7ecb0ef9db5b22f1d05a2f9dabc4db911",
    ];
    value_like(keys, words, ints)
}

/// Objects and arrays up to four levels deep of `keys`, `words`, booleans and `ints`.
fn value_like(
    keys: Vec<&'static str>,
    words: Vec<&'static str>,
    ints: BoxedStrategy<u32>,
) -> impl Strategy<Value = Value> {
    let leaf = prop_oneof![
        any::<bool>().prop_map(Value::Bool),
        ints.prop_map(|n| Value::Int(Int::from(n))),
        prop::sample::select(words).prop_map(Value::from),
    ];
    leaf.prop_recursive(4, 48, 6, move |inner| {
        prop_oneof![
            prop::collection::vec(inner.clone(), 0..4).prop_map(Value::Array),
            prop::collection::btree_map(
                prop::sample::select(keys.clone()).prop_map(str::to_owned),
                inner,
                0..7,
            )
            .prop_map(Value::Object),
        ]
    })
}
