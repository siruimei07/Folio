//! The store in bounded memory (versioning.md §16; remote-format.md §11: every size is bounded
//! before memory is allocated for it), measured on the heap:
//!
//! - a 64 MiB blob streams through a pack: written through a `FileSink` and read back through
//!   `PackReader` with less than 8 MiB of heap on each side;
//! - a pack whose trailer states as many index entries as its length allows, its index bytes
//!   damaged, is refused without memory for that many entries;
//! - walks over trees that repeat folders under the longest names keep paths only within the path
//!   budget's bytes, though each path is about 32,000 units long; under short names, where a path
//!   costs about its map entry, they keep their maps, `diff_trees`'s records and the sets of a
//!   check of change records within the same bytes;
//! - walks down a chain of large trees in a local store hold the trees of the folders they are in
//!   within the same bytes, and so does the check of presence the folders of a chain of trees of
//!   many folders;
//! - trees and records are read where they lie in their bytes: a dense 64 MiB tree in a pack of a
//!   few KB, and a dense intent at its 64 MiB cap, cost their bytes and little else, as would a
//!   value built of them a hundred times over; a valid tree costs about what is read from it;
//! - a compressed record whose frame is far longer than its object, padded with empty blocks, is
//!   stored, read and checked through buffers of 64 KiB, never one of the frame's length;
//! - a folder move's check asks for no memory for each path below the folder, however long the
//!   folder's new path.
//!
//! Its own test binary, because its allocator counts every allocation of the process; its tests
//! take turns ([`turn`]).

#![allow(unsafe_code)]

use std::alloc::{GlobalAlloc, Layout, System};
use std::io::{self, Read, Seek, SeekFrom};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Mutex, MutexGuard};

use folio_core::meta::Layout as LibraryLayout;
use folio_core::store::{
    Added, Change, Changes, Commit, CommitKind, Device, DeviceId, DeviceName, Differences,
    FileSink, FlatEntry, HistoryChecker, IntentRecord, Limit, LocalStore, MAX_OBJECT_SIZE,
    MemoryIndex, MemoryTrees, Message, Name, ObjectHasher, ObjectId, ObjectKind,
    PATH_BYTES_PER_ENTRY, PackProblem, PackReader, PackWriter, Part, Problem, RecordKind,
    RuleViolation, SchemaError, Side, Size, StoreError, Streamed, Subject, Summary, Timestamp,
    Tree, TreeEntry, TreePath, TreeSource, diff_trees, flatten,
};

/// Forwards every call to the system allocator, counting the heap in use, its peak, and every
/// byte asked for.
struct Counting;

static IN_USE: AtomicUsize = AtomicUsize::new(0);
static PEAK: AtomicUsize = AtomicUsize::new(0);
static TOTAL: AtomicUsize = AtomicUsize::new(0);

fn grew(bytes: usize) {
    TOTAL.fetch_add(bytes, Ordering::Relaxed);
    let now = IN_USE.fetch_add(bytes, Ordering::Relaxed) + bytes;
    PEAK.fetch_max(now, Ordering::Relaxed);
}

// SAFETY: every method passes its arguments unchanged to `System`, which upholds the
// `GlobalAlloc` contract; the counters only record sizes and never touch the memory.
unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        // SAFETY: the caller upholds `alloc`'s contract, which is `System::alloc`'s too.
        let pointer = unsafe { System.alloc(layout) };
        if !pointer.is_null() {
            grew(layout.size());
        }
        pointer
    }

    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        // SAFETY: as for `alloc`.
        let pointer = unsafe { System.alloc_zeroed(layout) };
        if !pointer.is_null() {
            grew(layout.size());
        }
        pointer
    }

    unsafe fn dealloc(&self, pointer: *mut u8, layout: Layout) {
        // SAFETY: `pointer` was allocated with `layout` by this allocator, that is by `System`.
        unsafe { System.dealloc(pointer, layout) };
        IN_USE.fetch_sub(layout.size(), Ordering::Relaxed);
    }

    unsafe fn realloc(&self, pointer: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        // SAFETY: `pointer` was allocated with `layout` by `System`; the caller upholds the rest
        // of `realloc`'s contract.
        let moved = unsafe { System.realloc(pointer, layout, new_size) };
        if moved == pointer {
            IN_USE.fetch_sub(layout.size(), Ordering::Relaxed);
            grew(new_size);
        } else if !moved.is_null() {
            // A block that moved was there beside the old one while its bytes were copied.
            grew(new_size);
            IN_USE.fetch_sub(layout.size(), Ordering::Relaxed);
        }
        moved
    }
}

#[global_allocator]
static ALLOCATOR: Counting = Counting;

/// The blob's length: far above every buffer of the store.
const SIZE: u64 = 64 * 1024 * 1024;

/// The most heap one side may use beyond what was in use when it started.
const LIMIT: usize = 8 * 1024 * 1024;

/// The bytes a read hands over at most.
const CHUNK: usize = 64 * 1024;

/// What `run` returns, and the most heap it used beyond what was in use when it started.
fn peak_of<T>(run: impl FnOnce() -> T) -> (T, usize) {
    let start = IN_USE.load(Ordering::Relaxed);
    PEAK.store(start, Ordering::Relaxed);
    let result = run();
    (result, PEAK.load(Ordering::Relaxed).saturating_sub(start))
}

/// What `run` returns, and the bytes it asked the allocator for in all, freed again or not.
fn allocated_by<T>(run: impl FnOnce() -> T) -> (T, usize) {
    let start = TOTAL.load(Ordering::Relaxed);
    let result = run();
    (result, TOTAL.load(Ordering::Relaxed) - start)
}

/// The turn of one test: the counters are the process's, so no other test may run beside it.
fn turn() -> MutexGuard<'static, ()> {
    static TURN: Mutex<()> = Mutex::new(());
    // A test that failed in its turn leaves the lock poisoned, not the counters wrong.
    TURN.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// The bytes i mod 251, as in BLAKE3's own vectors, from `from` on: a table to copy from.
fn pattern(from: u64, len: usize) -> &'static [u8] {
    static TABLE: std::sync::OnceLock<Vec<u8>> = std::sync::OnceLock::new();
    let table = TABLE.get_or_init(|| (0..CHUNK + 251).map(|i| (i % 251) as u8).collect());
    let start = (from % 251) as usize;
    &table[start..start + len]
}

/// The blob, made as it is read and never held whole.
struct Blob {
    at: u64,
}

impl Read for Blob {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        let left = SIZE - self.at;
        let take = usize::try_from(left).map_or(CHUNK, |left| left.min(CHUNK));
        let take = take.min(buffer.len());
        buffer[..take].copy_from_slice(pattern(self.at, take));
        self.at += take as u64;
        Ok(take)
    }
}

#[test]
fn a_64_mib_blob_streams_through_a_pack_in_bounded_memory() {
    let _turn = turn();
    let folder = tempfile::tempdir().unwrap();
    let path = folder.path().join("pack-0123456789abcdef.part");
    // The id first, as the catalog holds it; the table is made here, outside what is measured.
    let mut hasher = ObjectHasher::new(ObjectKind::Blob);
    io::copy(&mut Blob { at: 0 }, &mut hasher).unwrap();
    let id = hasher.finalize();
    let size = Size::new(SIZE).unwrap();

    let (index, writing) = peak_of(|| {
        let mut pack = PackWriter::new(FileSink::create(&path).unwrap()).unwrap();
        // Compression is asked for, but a blob over 16 MiB streams raw.
        let streamed = pack.add_blob_from(id, size, Blob { at: 0 }, true).unwrap();
        assert!(
            matches!(
                streamed,
                Streamed::Added(Added::Written {
                    offset: 12,
                    compressed: false
                })
            ),
            "{streamed:?}"
        );
        pack.finish().unwrap().0
    });
    assert_eq!(index.size(), 12 + 50 + SIZE + 40 + 48);
    assert!(writing < LIMIT, "writing took {writing} bytes of heap");

    let ((), reading) = peak_of(|| {
        let mut pack = PackReader::open(&path).unwrap();
        assert_eq!(pack.read_index(Some(index.name())).unwrap(), index);
        let mut object = pack.read_object(id, 12).unwrap();
        assert_eq!(object.raw_length(), SIZE);
        let mut buffer = vec![0; CHUNK];
        let mut at = 0;
        loop {
            let read = object.read_checked(&mut buffer).unwrap();
            if read == 0 {
                break;
            }
            assert!(buffer[..read] == *pattern(at, read), "the bytes at {at}");
            at += read as u64;
        }
        assert_eq!(at, SIZE);
        assert!(object.is_verified());
    });
    assert!(reading < LIMIT, "reading took {reading} bytes of heap");

    let (checked, checking) = peak_of(|| {
        PackReader::open(&path)
            .unwrap()
            .verify(Some(index.name()))
            .unwrap()
    });
    assert_eq!(checked, index);
    assert!(
        checking < LIMIT,
        "the full check took {checking} bytes of heap"
    );
    eprintln!("peak heap: writing {writing}, reading {reading}, checking {checking} bytes");
}

/// A pack of `len` bytes that is made as it is read: a header of version 1, a trailer that states
/// as many index entries as the length allows, and zeros between them, as a damaged count leaves a
/// pack whose records were zero-filled.
struct DamagedCount {
    len: u64,
    at: u64,
}

impl DamagedCount {
    /// The pack's first and last bytes: its header, and its trailer without a hash.
    fn ends(&self) -> [(u64, Vec<u8>); 2] {
        let header = [&b"FOLIOPK1"[..], &1_u32.to_le_bytes()].concat();
        let count = (self.len - 12 - 50 - 48) / 40;
        let trailer = [&count.to_le_bytes()[..], b"FOLIOEND", &[0; 32]].concat();
        [(0, header), (self.len - 48, trailer)]
    }
}

impl Read for DamagedCount {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        let left = self.len.saturating_sub(self.at);
        let take = usize::try_from(left).map_or(CHUNK, |left| left.min(CHUNK));
        let take = take.min(buffer.len());
        let chunk = &mut buffer[..take];
        chunk.fill(0);
        let end = self.at + chunk.len() as u64;
        for (start, bytes) in self.ends() {
            let (from, to) = (self.at.max(start), end.min(start + bytes.len() as u64));
            if from < to {
                let within = |at: u64, base: u64| usize::try_from(at - base).unwrap();
                chunk[within(from, self.at)..within(to, self.at)]
                    .copy_from_slice(&bytes[within(from, start)..within(to, start)]);
            }
        }
        self.at = end;
        Ok(chunk.len())
    }
}

impl Seek for DamagedCount {
    fn seek(&mut self, to: SeekFrom) -> io::Result<u64> {
        self.at = match to {
            SeekFrom::Start(at) => at,
            SeekFrom::End(by) => self.len.checked_add_signed(by).unwrap(),
            SeekFrom::Current(by) => self.at.checked_add_signed(by).unwrap(),
        };
        Ok(self.at)
    }
}

/// The count of index entries in a pack's trailer is checked only against the pack's length
/// before the entries are read: a damaged count asks for memory only as entries pass.
#[test]
fn a_damaged_index_count_is_not_an_allocation_size() {
    let _turn = turn();
    // 838,858 entries would be 32 MiB of index.
    let len = 32 * 1024 * 1024;
    let pack = || PackReader::new(DamagedCount { len, at: 0 }, len, "packs/damaged.pack");
    let refused = |result: Result<_, StoreError>, problem: PackProblem| match result {
        Err(StoreError::Invalid {
            what: Subject::Pack(_),
            problem: Problem::Pack(found),
        }) => assert_eq!(found, problem),
        other => panic!("{other:?}"),
    };
    let (read, indexing) = peak_of(|| pack().read_index(None));
    refused(read, PackProblem::IndexOrder);
    assert!(indexing < LIMIT, "reading the index took {indexing} bytes");
    // The full check hashes the pack first: the hash decides.
    let (checked, checking) = peak_of(|| pack().verify(None));
    refused(checked, PackProblem::Hash);
    assert!(checking < LIMIT, "the full check took {checking} bytes");
    eprintln!("peak heap: reading the index {indexing}, checking {checking} bytes");
}

/// A name of 255 UTF-16 code units, the longest a name may be, ending in `last`.
fn longest_name(last: char) -> Name {
    Name::parse(&format!("{}{last}", "n".repeat(254))).unwrap()
}

fn file_entry(name: &str) -> TreeEntry {
    let side = Side {
        hash: ObjectId::from_bytes([1; 32]),
        size: Size::new(1).unwrap(),
        stored: true,
    };
    TreeEntry::file(Name::parse(name).unwrap(), side)
}

/// A first commit of `tree` with the change records `records`.
fn first_commit(tree: ObjectId, records: Vec<Change>) -> Commit {
    commit_on(tree, None, Some(records))
}

/// A commit of `tree` on `parent`, with the change records `records` when they are given.
fn commit_on(tree: ObjectId, parent: Option<ObjectId>, records: Option<Vec<Change>>) -> Commit {
    Commit {
        tree,
        device: Device {
            id: DeviceId::parse("8c1e0d2b4a6f43e19d7c5b3a2f1e0d9c").unwrap(),
            name: DeviceName::parse("G16").unwrap(),
        },
        time: Timestamp::parse("2026-10-06T00:00:00Z").unwrap(),
        rebased_from: None,
        kind: CommitKind::Commit {
            parent,
            message: Message {
                summary: Summary::parse("Import").unwrap(),
                body: None,
                changes: records.map(|records| Changes::new(records).unwrap()),
            },
        },
    }
}

/// Folders that repeat each other's trees under the longest names: walks keep paths only within
/// the path budget's bytes, whatever the length of each path.
#[test]
fn walks_over_repeated_long_names_keep_paths_within_the_budget() {
    let _turn = turn();
    // Beside `.folio`, a folder holding 110 chained and 16 doubling levels, every folder name 255
    // units long: about 196,000 paths of up to 32,513 units (§7.4 allows them), 6 GB in all, in
    // 131 trees of a few hundred bytes.
    let mut trees = MemoryTrees::new();
    let mut top = trees
        .insert(Tree::new(vec![file_entry("f")]).unwrap())
        .unwrap();
    for _ in 0..16 {
        let doubled = vec![
            TreeEntry::dir(longest_name('a'), top),
            TreeEntry::dir(longest_name('b'), top),
        ];
        top = trees.insert(Tree::new(doubled).unwrap()).unwrap();
    }
    for _ in 0..110 {
        let chained = vec![TreeEntry::dir(longest_name('c'), top)];
        top = trees.insert(Tree::new(chained).unwrap()).unwrap();
    }
    let folio = trees
        .insert(Tree::new(vec![file_entry("library.json")]).unwrap())
        .unwrap();
    let root = trees
        .insert(
            Tree::new(vec![
                TreeEntry::dir(Name::parse(".folio").unwrap(), folio),
                TreeEntry::dir(longest_name('r'), top),
            ])
            .unwrap(),
        )
        .unwrap();
    let added = Change::AddDir {
        path: TreePath::parse(longest_name('r').as_str()).unwrap(),
    };
    let commit = first_commit(root, vec![added]);
    let id = commit.encode().unwrap().id();
    for budget in [4_000, 16_000] {
        let bytes = budget * PATH_BYTES_PER_ENTRY;
        let over = |result: Result<(), StoreError>| match result {
            Err(StoreError::TooLarge {
                what: Subject::Object(what),
                limit: Limit::PathBytes(limit),
            }) if what == root && limit == bytes => {}
            other => panic!("at a budget of {budget}: {other:?}"),
        };
        let (flattened, flattening) = peak_of(|| flatten(&trees, root, budget).map(drop));
        over(flattened);
        let (checked, checking) =
            peak_of(|| HistoryChecker::with_budget(&trees, budget).check_commit(id, &commit, None));
        over(checked);
        // The paths kept, with the rest the walk counts, and little besides.
        for (walk, peak) in [("flattening", flattening), ("checking", checking)] {
            assert!(
                peak < bytes + 64 * 1024,
                "{walk} at a budget of {budget} took {peak} bytes of heap"
            );
        }
        eprintln!(
            "peak heap at a budget of {budget}: flattening {flattening}, checking {checking}"
        );
    }
}

/// A root holding `.folio/library.json` and the folder `top` over `levels` levels of two folders
/// of ten-byte names that hold one tree, over `files` files of `content`: 2^`levels` × `files`
/// paths of about eleven bytes a level, from `levels` + 3 trees of a few kilobytes.
fn short_paths(trees: &mut MemoryTrees, levels: usize, files: usize, content: u8) -> ObjectId {
    let side = Side {
        hash: ObjectId::from_bytes([content; 32]),
        size: Size::new(1).unwrap(),
        stored: true,
    };
    let leaf = (0..files)
        .map(|n| TreeEntry::file(Name::parse(&format!("f{n:03}")).unwrap(), side))
        .collect();
    let mut top = trees.insert(Tree::new(leaf).unwrap()).unwrap();
    for _ in 0..levels {
        let both = ["aaaaaaaaa0", "aaaaaaaaa1"]
            .map(|name| TreeEntry::dir(Name::parse(name).unwrap(), top))
            .to_vec();
        top = trees.insert(Tree::new(both).unwrap()).unwrap();
    }
    let folio = trees
        .insert(Tree::new(vec![file_entry("library.json")]).unwrap())
        .unwrap();
    let root = vec![
        TreeEntry::dir(Name::parse(".folio").unwrap(), folio),
        TreeEntry::dir(Name::parse("top").unwrap(), top),
    ];
    trees.insert(Tree::new(root).unwrap()).unwrap()
}

/// Walks over short paths in folders that repeat each other's trees, where a path costs far more
/// in the map that keeps it than its own bytes: the map entries count in the budget's bytes, and
/// so do the change records `diff_trees` makes and the sets the check of change records fills, so
/// each walk's peak stays within those bytes, whether it ends there or fits. Counting the paths'
/// bytes alone let the walks run to the count of entries, the maps taking twice the bytes and
/// `diff_trees` four times (about 1.07 GB at the default budget, from a pack of 7 KB).
#[test]
fn walks_over_short_paths_keep_their_maps_and_records_within_the_budget() {
    const BUDGET: usize = 50_000;
    let _turn = turn();
    let bytes = BUDGET * PATH_BYTES_PER_ENTRY;
    let mut trees = MemoryTrees::new();
    // About 997,000 paths a side, all changed: twenty times the budget's count.
    let (old, new) = (
        short_paths(&mut trees, 10, 974, 1),
        short_paths(&mut trees, 10, 974, 2),
    );
    let over = |result: Result<(), StoreError>| match result {
        Err(StoreError::TooLarge {
            what: Subject::Object(what),
            limit: Limit::PathBytes(limit),
        }) if what == new && limit == bytes => {}
        other => panic!("{other:?}"),
    };
    let on = |parent: ObjectId, tree: ObjectId, records: Vec<Change>| {
        let parent = commit_on(parent, None, None);
        let child = commit_on(tree, Some(parent.encode().unwrap().id()), Some(records));
        (child.encode().unwrap().id(), child, parent)
    };
    let (id, child, parent) = on(
        old,
        new,
        vec![Change::AddDir {
            path: TreePath::parse("top").unwrap(),
        }],
    );
    let (flattened, flattening) = peak_of(|| flatten(&trees, new, BUDGET).map(drop));
    over(flattened);
    let (walked, walking) =
        peak_of(|| Differences::of_trees(&trees, Some(old), new, BUDGET).map(drop));
    over(walked);
    let (diffed, diffing) = peak_of(|| diff_trees(&trees, Some(old), new, BUDGET).map(drop));
    over(diffed);
    let (checked, checking) = peak_of(|| {
        HistoryChecker::with_budget(&trees, BUDGET).check_commit(id, &child, Some(&parent))
    });
    over(checked);
    // 16,000 paths a side, all changed, and the records that describe them, fit.
    let (old, new) = (
        short_paths(&mut trees, 5, 500, 1),
        short_paths(&mut trees, 5, 500, 2),
    );
    let (walked, fitting) = peak_of(|| {
        Differences::of_trees(&trees, Some(old), new, BUDGET).map(|walked| walked.from.len())
    });
    assert_eq!(walked.unwrap(), 16_000);
    let (records, recording) = peak_of(|| diff_trees(&trees, Some(old), new, BUDGET));
    let records = records.unwrap();
    assert_eq!(records.len(), 16_000);
    // Beside the walk's maps, the records take their own room and no more: a list made at its
    // size, each record a `Change` and its path's bytes.
    let made: usize = records
        .iter()
        .map(|record| size_of::<Change>() + record.path().as_str().len())
        .sum();
    assert!(
        recording < fitting + made + 64 * 1024,
        "diffing took {recording} bytes of heap, walking {fitting}, the records {made}"
    );
    let (id, child, parent) = on(old, new, records);
    let (checked, covering) = peak_of(|| {
        HistoryChecker::with_budget(&trees, BUDGET).check_commit(id, &child, Some(&parent))
    });
    checked.unwrap();
    for (walk, peak) in [
        ("flattening", flattening),
        ("walking both trees", walking),
        ("diffing them", diffing),
        ("checking a commit", checking),
        ("walking smaller trees", fitting),
        ("diffing them", recording),
        ("checking their records", covering),
    ] {
        assert!(
            peak < bytes + 64 * 1024,
            "{walk} at a budget of {BUDGET} took {peak} bytes of heap"
        );
    }
    eprintln!(
        "peak heap at a budget of {BUDGET} ({bytes} bytes): flattening {flattening}, walking \
         {walking}, diffing {diffing}, checking {checking}; smaller trees: walking {fitting}, \
         diffing {recording}, checking {covering}"
    );
}

/// §7.4's check of a root keeps of the root's entries only those NTFS takes for `.folio`, beside
/// what lies under `.folio`: the others can break no rule it checks, so a root of 100,000 files is
/// checked without a map of its entries, which would take about 15 MB.
#[test]
fn the_check_of_a_wide_root_keeps_no_map_of_its_entries() {
    let _turn = turn();
    let mut trees = MemoryTrees::new();
    let folio = trees
        .insert(Tree::new(vec![file_entry("library.json")]).unwrap())
        .unwrap();
    let mut entries: Vec<TreeEntry> = (0..100_000)
        .map(|n| file_entry(&format!("file {n:06}.md")))
        .collect();
    entries.push(TreeEntry::dir(Name::parse(".folio").unwrap(), folio));
    let root = trees.insert(Tree::new(entries).unwrap()).unwrap();
    let commit = commit_on(root, None, None);
    let id = commit.encode().unwrap().id();
    let (checked, checking) =
        peak_of(|| HistoryChecker::new(&trees).check_commit(id, &commit, None));
    checked.unwrap();
    assert!(
        checking < LIMIT / 8,
        "checking a root of 100,000 files took {checking} bytes of heap"
    );
    eprintln!("peak heap: checking a root of 100,000 files {checking}");
}

/// A chain of `depth` distinct trees, each holding the next as its first entry `0` and then `files`
/// files of `content`, the deepest the file `0`, written into a pack of `store` and published.
/// Returns the top tree.
fn chain_in(store: &LocalStore, depth: usize, files: usize, content: u8) -> ObjectId {
    let side = Side {
        hash: ObjectId::from_bytes([content; 32]),
        size: Size::new(1).unwrap(),
        stored: true,
    };
    let mut writer = store.pack_writer().unwrap();
    let mut below = None;
    for _ in 0..depth {
        let mut entries: Vec<TreeEntry> = Vec::new();
        let first = Name::parse("0").unwrap();
        match below {
            None => entries.push(TreeEntry::file(first, side)),
            Some(tree) => {
                entries.push(TreeEntry::dir(first, tree));
                entries.extend(
                    (0..files)
                        .map(|n| TreeEntry::file(Name::parse(&format!("f{n:04}")).unwrap(), side)),
                );
            }
        }
        let encoded = Tree::new(entries).unwrap().encode().unwrap();
        writer.add_object(&encoded, true).unwrap();
        below = Some(encoded.id());
    }
    store.publish(writer.stage().unwrap()).unwrap();
    below.unwrap()
}

/// A chain of large trees in a local store, each entered through its first entry, as a library
/// folder from elsewhere can hold one (64 MiB a tree from a few hundred kilobytes of pack): going
/// down it, a walk looks at one entry a tree, holds the trees of the folders it is in within the
/// budget's bytes beside the one tree it is reading, and stops there. Held to the end of the chain,
/// the trees would take several times as much. Each tree has 1,025 entries, so the list a tree is
/// read into takes room for 2,048, about twice what its entries take: the walk counts that room.
#[test]
fn walks_down_a_chain_of_large_trees_hold_them_within_the_budget() {
    const DEPTH: usize = 48;
    const BUDGET: usize = 4_000;
    let _turn = turn();
    let folder = tempfile::tempdir().unwrap();
    let store = LocalStore::new(&LibraryLayout::new(folder.path()));
    let old = chain_in(&store, DEPTH, 1_024, 1);
    let new = chain_in(&store, DEPTH, 1_024, 2);
    let index = MemoryIndex::of_store(&store).unwrap();
    let trees = store.trees(&index);
    // What reading one tree of the chain asks for at its peak, and what the tree then holds.
    let before = IN_USE.load(Ordering::Relaxed);
    let (one, reading) = peak_of(|| trees.tree(new).unwrap().unwrap());
    let holding = IN_USE.load(Ordering::Relaxed).saturating_sub(before);
    drop(one);
    let bytes = BUDGET * PATH_BYTES_PER_ENTRY;
    // The trees are counted at the room their lists take, which grow while a tree is read.
    let bound = bytes + reading;
    assert!(DEPTH * holding > 2 * bound, "a tree holds {holding} bytes");
    let over = |result: Result<(), StoreError>| match result {
        Err(StoreError::TooLarge {
            what: Subject::Object(what),
            limit: Limit::PathBytes(limit),
        }) if what == new && limit == bytes => {}
        other => panic!("{other:?}"),
    };
    let (flattened, flattening) = peak_of(|| flatten(&trees, new, BUDGET).map(drop));
    over(flattened);
    let (walked, walking) =
        peak_of(|| Differences::of_trees(&trees, Some(old), new, BUDGET).map(drop));
    over(walked);
    let (diffed, diffing) = peak_of(|| diff_trees(&trees, Some(old), new, BUDGET).map(drop));
    over(diffed);
    for (walk, peak) in [
        ("flattening", flattening),
        ("walking both chains", walking),
        ("diffing them", diffing),
    ] {
        assert!(peak < bound, "{walk} took {peak} bytes of heap");
    }
    eprintln!(
        "peak heap: one tree read {reading} (held {holding}); flattening {flattening}, walking \
         both chains {walking}, diffing them {diffing}"
    );
}

/// A chain of distinct trees that each list a great many folders, the next tree of the chain last:
/// the check of presence enters it first, and holds the folders of the trees above it, and those
/// it has still to enter, within the budget's bytes, then stops.
#[test]
fn the_check_of_presence_holds_a_chain_of_wide_trees_within_the_budget() {
    const DEPTH: usize = 50;
    const BUDGET: usize = 4_000;
    let _turn = turn();
    let mut trees = MemoryTrees::new();
    let small = trees
        .insert(Tree::new(vec![file_entry("f")]).unwrap())
        .unwrap();
    let mut top = small;
    for level in 0..DEPTH {
        let mut entries: Vec<TreeEntry> = (0..1_000)
            .map(|n| TreeEntry::dir(Name::parse(&format!("d{n:05}")).unwrap(), small))
            .collect();
        entries.push(TreeEntry::dir(
            Name::parse(&format!("z{level:05}")).unwrap(),
            top,
        ));
        top = trees.insert(Tree::new(entries).unwrap()).unwrap();
    }
    let bytes = BUDGET * PATH_BYTES_PER_ENTRY;
    let (checked, checking) =
        peak_of(|| HistoryChecker::with_budget(&trees, BUDGET).longest_path(top));
    match checked {
        Err(StoreError::TooLarge {
            what: Subject::Object(what),
            limit: Limit::PathBytes(limit),
        }) if what == top && limit == bytes => {}
        other => panic!("{other:?}"),
    }
    // The folders' lists are made at their size; the stack and the set of open trees are counted
    // with the slack they take as they grow.
    assert!(
        checking < bytes + 64 * 1024,
        "presence took {checking} bytes of heap"
    );
    // The default budget goes down the whole chain: about 110 KB a tree.
    let (longest, going_down) = peak_of(|| HistoryChecker::new(&trees).longest_path(top).unwrap());
    assert_eq!(longest, DEPTH * 7 + 1);
    assert!(
        going_down > 2 * checking,
        "the whole chain took {going_down} bytes"
    );
    eprintln!(
        "peak heap: presence at a budget of {BUDGET} {checking}, the whole chain {going_down}"
    );
}

/// `{<prefix>"<list>":[{"":0},{"":0},…]}` of at most `len` bytes: canonical JSON in which every
/// object of the list takes seven bytes and holds nothing the format knows. Built as a value, each
/// object would cost hundreds of bytes.
fn dense(prefix: &str, list: &str, len: usize) -> Vec<u8> {
    let mut bytes = format!("{{{prefix}\"{list}\":[").into_bytes();
    let item = br#"{"":0}"#;
    while bytes.len() + 1 + item.len() + 2 <= len {
        if !bytes.ends_with(b"[") {
            bytes.push(b',');
        }
        bytes.extend_from_slice(item);
    }
    bytes.extend_from_slice(b"]}");
    bytes
}

/// A pack holding `raw` as one tree record, compressed as Folio compresses (zstd level 3, a window
/// of 8 MiB, the content size stated), with the right id, index and hash: made by hand, as no
/// writer stores a tree that breaks its schema.
fn pack_of_tree(raw: &[u8]) -> (Vec<u8>, ObjectId) {
    let id = ObjectId::of(ObjectKind::Tree, raw);
    let mut compressor = zstd::bulk::Compressor::new(3).unwrap();
    compressor.include_contentsize(true).unwrap();
    compressor.include_checksum(false).unwrap();
    compressor.window_log(23).unwrap();
    let frame = compressor.compress(raw).unwrap();
    let mut pack = [&b"FOLIOPK1"[..], &1_u32.to_le_bytes()].concat();
    let offset = pack.len() as u64;
    pack.extend_from_slice(&[ObjectKind::Tree.code(), 1]);
    pack.extend_from_slice(id.as_bytes());
    pack.extend_from_slice(&(raw.len() as u64).to_le_bytes());
    pack.extend_from_slice(&(frame.len() as u64).to_le_bytes());
    pack.extend_from_slice(&frame);
    pack.extend_from_slice(id.as_bytes());
    pack.extend_from_slice(&offset.to_le_bytes());
    pack.extend_from_slice(&1_u64.to_le_bytes());
    pack.extend_from_slice(b"FOLIOEND");
    let hash = blake3::hash(&pack);
    pack.extend_from_slice(hash.as_bytes());
    (pack, id)
}

/// A dense tree of 64 MiB in a pack of a few KB: reading the tree, or checking the pack, keeps the
/// tree's bytes, and nothing grows with its objects, as the first of them already breaks the
/// schema. So does checking the pack with a damaged hash, which reads every record before it
/// compares the hash.
#[test]
fn a_dense_tree_in_a_small_pack_costs_its_bytes_and_no_more() {
    let _turn = turn();
    let raw = dense("", "entries", MAX_OBJECT_SIZE as usize);
    let (pack, id) = pack_of_tree(&raw);
    drop(raw);
    assert!(pack.len() < 16 * 1024, "the pack is {} bytes", pack.len());
    let refused = |result: Result<(), StoreError>| match result {
        Err(StoreError::Invalid {
            what: Subject::Object(what),
            problem:
                Problem::Schema(SchemaError::MissingField {
                    part: Part::Entry,
                    field: "kind",
                }),
        }) if what == id => {}
        other => panic!("{other:?}"),
    };
    let (read, reading) = peak_of(|| PackReader::from_bytes(&pack).read_tree(id, 12).map(drop));
    refused(read);
    let (checked, checking) = peak_of(|| PackReader::from_bytes(&pack).verify(None).map(drop));
    refused(checked);
    let mut damaged = pack.clone();
    *damaged.last_mut().unwrap() ^= 1;
    let (hashed, hashing) = peak_of(|| PackReader::from_bytes(&damaged).verify(None).map(drop));
    match hashed {
        Err(StoreError::Invalid {
            problem: Problem::Pack(PackProblem::Hash),
            ..
        }) => {}
        other => panic!("{other:?}"),
    }
    // The tree's 64 MiB and a few buffers (zstd allocates its window itself, unseen here); a value
    // of the whole tree took about 6.7 GB.
    let limit = MAX_OBJECT_SIZE as usize + LIMIT;
    for (what, peak) in [
        ("reading the tree", reading),
        ("checking the pack", checking),
        ("checking it with a damaged hash", hashing),
    ] {
        assert!(peak < limit, "{what} took {peak} bytes of heap");
    }
    eprintln!("peak heap: reading {reading}, checking {checking}, damaged hash {hashing} bytes");
}

/// A zstd frame of `content` (under 128 KiB) far longer than its content: a header that states the
/// content's size, a window of 8 MiB, 8,000,000 empty raw blocks of three bytes each, then the
/// content in one raw block, the last. A valid frame of 24 MB.
fn padded_frame(content: &[u8]) -> Vec<u8> {
    let mut frame = vec![0x28, 0xb5, 0x2f, 0xfd, 0xc0, (23 - 10) << 3];
    frame.extend_from_slice(&(content.len() as u64).to_le_bytes());
    // An empty raw block that is not the last: a block header of zeros.
    frame.resize(frame.len() + 3 * 8_000_000, 0);
    let header = (content.len() << 3) | 1;
    frame.extend_from_slice(&header.to_le_bytes()[..3]);
    frame.extend_from_slice(content);
    frame
}

/// A compressed record's frame may be far longer than its object, so its stored length is never
/// the size of a buffer: a tree of about a hundred bytes and a blob of five, each in a frame of
/// 24 MB, are stored by `add_stored`, read whole, read through `Read` and checked with the pack in
/// a few buffers of 64 KiB, as a small record is.
#[test]
fn a_record_whose_frame_is_far_longer_than_its_object_is_read_in_bounded_memory() {
    let _turn = turn();
    let folder = tempfile::tempdir().unwrap();
    let path = folder.path().join("pack-0123456789abcdef.part");
    let tree = Tree::new(vec![file_entry("f")]).unwrap().encode().unwrap();
    let blob = b"hello";
    let objects = [
        (ObjectKind::Tree, tree.id(), tree.bytes().to_vec()),
        (
            ObjectKind::Blob,
            ObjectId::of(ObjectKind::Blob, blob),
            blob.to_vec(),
        ),
    ];
    let frames: Vec<Vec<u8>> = objects
        .iter()
        .map(|(_, _, raw)| padded_frame(raw))
        .collect();
    assert!(frames.iter().all(|frame| frame.len() > 2 * LIMIT));
    let (index, storing) = peak_of(|| {
        let mut pack = PackWriter::new(FileSink::create(&path).unwrap()).unwrap();
        for ((kind, id, raw), frame) in objects.iter().zip(&frames) {
            let size = Size::new(raw.len() as u64).unwrap();
            let added = pack.add_stored(*kind, *id, size, frame, true).unwrap();
            assert!(
                matches!(
                    added,
                    Added::Written {
                        compressed: true,
                        ..
                    }
                ),
                "{added:?}"
            );
        }
        pack.finish().unwrap().0
    });
    drop(frames);
    let at = |id| index.offset(id).unwrap();
    let (tree_id, blob_id) = (objects[0].1, objects[1].1);
    let (read, reading) = peak_of(|| {
        PackReader::open(&path)
            .unwrap()
            .read_tree(tree_id, at(tree_id))
            .unwrap()
    });
    assert_eq!(read.encode().unwrap(), tree);
    let (streamed, streaming) = peak_of(|| {
        let mut object = PackReader::open(&path)
            .unwrap()
            .read_object(blob_id, at(blob_id))
            .unwrap();
        let mut bytes = Vec::new();
        object.read_to_end(&mut bytes).unwrap();
        assert!(object.is_verified());
        bytes
    });
    assert_eq!(streamed, blob);
    let (checked, checking) = peak_of(|| {
        PackReader::open(&path)
            .unwrap()
            .verify(Some(index.name()))
            .unwrap()
    });
    assert_eq!(checked, index);
    for (what, peak) in [
        ("storing the records", storing),
        ("reading the tree", reading),
        ("reading the blob", streaming),
        ("checking the pack", checking),
    ] {
        assert!(peak < LIMIT, "{what} took {peak} bytes of heap");
    }
    eprintln!(
        "peak heap with frames of 24 MB: storing {storing}, reading the tree {reading}, the blob \
         {streaming}, checking {checking} bytes"
    );
}

/// The members an intent needs before its writes, so that its writes are read.
const INTENT_FIELDS: &str = concat!(
    r#""device":{"id":"8c1e0d2b4a6f43e19d7c5b3a2f1e0d9c","name":"G16"},"format_version":1,"#,
    r#""head":"b3:1111111111111111111111111111111111111111111111111111111111111111","#,
    r#""library_id":"48ffdfb335860f2c15c8bccf2a90e720","seq":1,"time":"2026-10-04T08:00:00Z","#,
);

/// A dense intent at its cap of 64 MiB is refused at its first write, beside its bytes in almost
/// no memory: its version is read, its canonical form checked and its fields taken out where they
/// lie. An intent of a newer version whose keys come out of order keeps the place of each key, to
/// find a key it repeats: eight bytes for every key of at least six.
#[test]
fn a_dense_intent_costs_its_bytes_and_no_more() {
    let _turn = turn();
    let path = ".folio/store/intents/8c1e0d2b4a6f43e19d7c5b3a2f1e0d9c/1.json";
    let cap = RecordKind::Intent.limit() as usize;
    let bytes = dense(INTENT_FIELDS, "writes", cap);
    assert!(bytes.len() > cap - 8, "{} bytes", bytes.len());
    let (parsed, parsing) = peak_of(|| IntentRecord::parse(&bytes, path).map(drop));
    match parsed {
        Err(StoreError::Invalid {
            what: Subject::Record { .. },
            problem:
                Problem::Schema(SchemaError::MissingField {
                    part: Part::Write,
                    field: "op",
                }),
        }) => {}
        other => panic!("{other:?}"),
    }
    assert!(
        parsing < LIMIT,
        "reading the intent took {parsing} bytes of heap"
    );
    drop(bytes);

    // Newer, with millions of keys out of order in one object.
    let mut newer = br#"{"format_version":2,"x":{"b":0,"a":0"#.to_vec();
    let mut key = 0_u64;
    while newer.len() + 32 < cap {
        newer.extend_from_slice(format!(r#","a{key}":0"#).as_bytes());
        key += 1;
    }
    newer.extend_from_slice(b"}}");
    let (read, reading) = peak_of(|| IntentRecord::parse(&newer, path).map(drop));
    match read {
        Err(StoreError::Newer { version, .. }) => assert_eq!(version, "2"),
        other => panic!("{other:?}"),
    }
    // Eight bytes for each key, in a list that grows by doubling: here the record's size rounded
    // up to a power of two (the list reaches exactly that), and half as much again while the list
    // moves to that size beside its last one; and a few buffers, or what another thread of the
    // process allocates meanwhile.
    assert!(
        reading < newer.len().next_power_of_two() / 2 * 3 + LIMIT,
        "reading {key} keys out of order took {reading} bytes of heap"
    );
    eprintln!("peak heap: a dense intent {parsing}, a newer one with keys out of order {reading}");
}

/// A valid tree costs about what is read from it: its entries, never a value of the whole
/// document. The list of entries grows by doubling as entries pass (a count read from the bytes is
/// no allocation size), so it holds its last two sizes for a moment.
#[test]
fn a_valid_tree_costs_about_its_entries() {
    let _turn = turn();
    let entries = (0..100_000).map(|n| file_entry(&format!("file {n:06}.md")));
    let bytes = Tree::new(entries.collect())
        .unwrap()
        .encode()
        .unwrap()
        .into_bytes();
    let (tree, parsing) = peak_of(|| Tree::parse(&bytes).unwrap());
    assert_eq!(tree.len(), 100_000);
    assert!(
        parsing < bytes.len() / 4 * 5,
        "reading a tree of {} bytes took {parsing} bytes of heap",
        bytes.len()
    );
    eprintln!("peak heap: a tree of {} bytes {parsing}", bytes.len());
}

/// A folder move carries what lies below its folder by walking both sides together: nothing is
/// built or looked up for each path below the folder, so the work does not grow with the length of
/// the folder's new path. Built for each path, a new path of 97 KB below 20,000 paths would ask for
/// about 2 GB, as a hostile commit can make a reader do.
#[test]
fn a_folder_move_asks_for_nothing_per_path_however_long_its_new_path() {
    let _turn = turn();
    // 127 folders of 255 units, three bytes each: 32,511 units, a path §7.4 allows.
    let long = vec!["课".repeat(255); 127].join("/");
    assert!(long.encode_utf16().count() <= 32_767);
    let entry = |n: u32| {
        FlatEntry::File(Side {
            hash: ObjectId::from_bytes([(n % 251) as u8; 32]),
            size: Size::new(u64::from(n)).unwrap(),
            stored: true,
        })
    };
    let mut asked = Vec::new();
    for to in ["y", long.as_str()] {
        // The folder `x` and 20,000 files below it moved to `to`, which holds the first 64 of
        // them: they are carried, and the others are not covered.
        let mut differences = Differences::default();
        differences.from.insert("x".into(), FlatEntry::Dir);
        differences.to.insert(to.into(), FlatEntry::Dir);
        for n in 0..20_000 {
            differences.from.insert(format!("x/f{n:05}"), entry(n));
            if n < 64 {
                differences.to.insert(format!("{to}/f{n:05}"), entry(n));
            }
        }
        let records = Changes::new(vec![Change::MoveDir {
            from: TreePath::parse("x").unwrap(),
            path: TreePath::parse(to).unwrap(),
        }])
        .unwrap();
        let (checked, bytes) = allocated_by(|| differences.check(&records));
        assert_eq!(
            checked,
            Err(RuleViolation::NotCovered {
                path: "x/f00064".into()
            })
        );
        asked.push(bytes);
    }
    // The long path's bounds of what lies below it, and nothing per path.
    assert!(
        asked[1] < asked[0] + 4 * long.len(),
        "a folder move to a path of {} bytes asked for {} bytes, to `y` {}",
        long.len(),
        asked[1],
        asked[0]
    );
    eprintln!("bytes asked for by a folder move's check, to `y` and to the long path: {asked:?}");
}
