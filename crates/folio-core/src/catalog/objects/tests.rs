use std::collections::{BTreeMap, BTreeSet};
use std::io::Read;
use std::panic::{AssertUnwindSafe, catch_unwind};

use proptest::prelude::*;
use rusqlite::ErrorCode;

use super::*;
use crate::catalog::{Catalog, EntryRecord, upsert_entry};
use crate::hash::ContentHash;
use crate::meta::{EntryKind, FileClass, Layout};
use crate::store::strategies::{first_commit, noise};
use crate::store::{
    BlobClass, Encoded, HistoryChecker, LocalStore, MemoryIndex, MemorySink, ObjectKind,
    PackWriter, WORD_PACK_MIN,
};
use crate::test_support::{open_catalog, path};

fn blob(bytes: &[u8]) -> ObjectId {
    ObjectId::of(ObjectKind::Blob, bytes)
}

/// A pack in memory holding `blobs` in that order, as its index gives it.
fn pack_of(blobs: &[&[u8]]) -> PackIndex {
    let mut writer = PackWriter::new(MemorySink::new()).unwrap();
    for bytes in blobs {
        writer.add_blob(bytes, false).unwrap();
    }
    writer.finish().unwrap().0
}

/// A new catalog's connection in memory, set up and migrated as a catalog file is.
fn catalog_in_memory() -> Connection {
    let mut conn = Connection::open_in_memory().unwrap();
    super::super::configure(&conn).unwrap();
    super::super::schema::MIGRATIONS
        .to_latest(&mut conn)
        .unwrap();
    conn
}

fn count(conn: &Connection, table: &str) -> i64 {
    conn.query_row(&format!("SELECT count(*) FROM {table}"), [], |row| {
        row.get(0)
    })
    .unwrap()
}

fn names(conn: &Connection) -> Vec<PackName> {
    indexed_packs(conn)
        .unwrap()
        .into_iter()
        .map(|pack| pack.name)
        .collect()
}

#[test]
fn a_pack_is_indexed_with_each_object_at_its_offset() {
    let conn = catalog_in_memory();
    let pack = pack_of(&[b"a", b"bb", b"ccc"]);
    add_pack(&conn, &pack).unwrap();
    assert_eq!(
        indexed_packs(&conn).unwrap(),
        [IndexedPack {
            name: pack.name(),
            size: pack.size(),
            objects: 3,
        }]
    );
    for entry in pack.entries() {
        assert_eq!(
            object_location(&conn, entry.id).unwrap(),
            pack.location(entry.id)
        );
        assert!(has_object(&conn, entry.id).unwrap());
    }
    let other = blob(b"d");
    assert_eq!(object_location(&conn, other).unwrap(), None);
    assert!(!has_object(&conn, other).unwrap());

    // Packs list by name, and the rows hold the text forms.
    let second = pack_of(&[b"d"]);
    add_pack(&conn, &second).unwrap();
    let mut expected = vec![pack.name(), second.name()];
    expected.sort();
    assert_eq!(names(&conn), expected);
    let (id, name, offset): (String, String, i64) = conn
        .query_row(
            "SELECT id, pack, offset FROM objects WHERE pack = ?1",
            [second.name()],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .unwrap();
    assert_eq!(id, format!("b3:{}", blake3::hash(b"d").to_hex()));
    assert_eq!(name, second.name().to_string());
    assert_eq!(offset, 12);
}

/// Object ids are text like `entries.hash` (versioning.md §13.1), so a file's blob is found by its
/// entry's hash without a conversion.
#[test]
fn blob_ids_join_with_the_hashes_of_entries() {
    let conn = catalog_in_memory();
    let notes = b"# Eigenvalues\n";
    let pack = pack_of(&[b"other", notes]);
    add_pack(&conn, &pack).unwrap();
    let record = EntryRecord {
        path: path("notes.md"),
        kind: EntryKind::File,
        class: FileClass::Text,
        size: notes.len() as u64,
        mtime_ns: None,
        file_id: None,
        hash: Some(ContentHash::of(notes)),
    };
    upsert_entry(&conn, &record, 100).unwrap();
    let location: (PackName, u64) = conn
        .query_row(
            "SELECT objects.pack, objects.offset
             FROM entries JOIN objects ON objects.id = entries.hash
             WHERE entries.path = 'notes.md'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    let expected = pack.location(blob(notes)).unwrap();
    assert_eq!(location, (expected.pack, expected.offset));
}

#[test]
fn an_object_in_two_packs_is_found_in_the_pack_indexed_first() {
    let first = pack_of(&[b"shared", b"first"]);
    let second = pack_of(&[b"second", b"shared"]);
    let shared = blob(b"shared");
    assert_ne!(first.location(shared), second.location(shared));
    let ids = [shared, blob(b"first"), blob(b"second")];
    for order in [[&first, &second], [&second, &first]] {
        let conn = catalog_in_memory();
        let mut memory = MemoryIndex::new();
        for pack in order {
            add_pack(&conn, pack).unwrap();
            memory.add_pack(pack);
        }
        assert_eq!(
            object_location(&conn, shared).unwrap(),
            order[0].location(shared)
        );
        // Indexing either pack again keeps every location.
        for pack in [order[1], order[0]] {
            add_pack(&conn, pack).unwrap();
        }
        for id in ids {
            assert_eq!(object_location(&conn, id).unwrap(), memory.get(id));
        }
        // Each pack still counts every object it holds.
        let counts: Vec<usize> = indexed_packs(&conn)
            .unwrap()
            .iter()
            .map(|pack| pack.objects)
            .collect();
        assert_eq!(counts, [2, 2]);
        assert_eq!(count(&conn, "objects"), 3);
    }
}

#[test]
fn indexing_a_pack_again_replaces_what_the_catalog_held_for_it() {
    let conn = catalog_in_memory();
    let pack = pack_of(&[b"a", b"bb"]);
    add_pack(&conn, &pack).unwrap();
    let rows = |conn: &Connection| -> Vec<(String, String, i64)> {
        conn.prepare("SELECT id, pack, offset FROM objects ORDER BY id")
            .unwrap()
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap()
    };
    let indexed = (indexed_packs(&conn).unwrap(), rows(&conn));
    // Rows that no longer match the pack: a stale size and count, a wrong offset, a lost location.
    conn.execute_batch(
        "UPDATE packs SET size = size + 1, objects = 9;
         UPDATE objects SET offset = offset + 1;",
    )
    .unwrap();
    conn.execute("DELETE FROM objects WHERE id = ?1", [blob(b"a")])
        .unwrap();
    add_pack(&conn, &pack).unwrap();
    assert_eq!((indexed_packs(&conn).unwrap(), rows(&conn)), indexed);
}

#[test]
fn removing_a_pack_removes_the_locations_found_in_it() {
    let conn = catalog_in_memory();
    let first = pack_of(&[b"shared", b"first"]);
    let second = pack_of(&[b"second", b"shared"]);
    let shared = blob(b"shared");
    add_pack(&conn, &first).unwrap();
    add_pack(&conn, &second).unwrap();

    assert!(remove_pack(&conn, first.name()).unwrap());
    assert!(!remove_pack(&conn, first.name()).unwrap());
    assert!(!remove_pack(&conn, pack_of(&[b"never indexed"]).name()).unwrap());
    assert_eq!(names(&conn), [second.name()]);
    assert_eq!(object_location(&conn, blob(b"first")).unwrap(), None);
    assert_eq!(
        object_location(&conn, blob(b"second")).unwrap(),
        second.location(blob(b"second"))
    );
    // The shared object was found in the pack that went: one location per object, so it has
    // none, although the other pack holds it, until that pack is indexed again.
    assert_eq!(object_location(&conn, shared).unwrap(), None);
    assert!(!has_object(&conn, shared).unwrap());
    add_pack(&conn, &second).unwrap();
    assert_eq!(
        object_location(&conn, shared).unwrap(),
        second.location(shared)
    );
    assert_eq!(count(&conn, "objects"), 2);
}

#[test]
fn clearing_the_index_removes_every_pack_and_location() {
    let conn = catalog_in_memory();
    let packs = [pack_of(&[b"a", b"b"]), pack_of(&[b"b", b"c"])];
    for pack in &packs {
        add_pack(&conn, pack).unwrap();
    }
    clear_object_index(&conn).unwrap();
    assert!(indexed_packs(&conn).unwrap().is_empty());
    assert_eq!(count(&conn, "objects"), 0);
    assert!(!has_object(&conn, blob(b"a")).unwrap());
    // Filled again, as a rebuild does.
    for pack in packs.iter().rev() {
        add_pack(&conn, pack).unwrap();
    }
    assert_eq!(
        object_location(&conn, blob(b"b")).unwrap(),
        packs[1].location(blob(b"b"))
    );
}

#[test]
fn the_index_changes_with_its_transaction_only() {
    let dir = tempfile::tempdir().unwrap();
    let catalog = open_catalog(dir.path());
    let pack = pack_of(&[b"a"]);
    let failed = catalog.write(|tx| {
        add_pack(tx, &pack)?;
        Err::<(), _>(CatalogError::Invalid(
            "the write after it failed".to_owned(),
        ))
    });
    assert!(failed.is_err());
    let crashed = catch_unwind(AssertUnwindSafe(|| {
        catalog.write(|tx| -> Result<(), CatalogError> {
            add_pack(tx, &pack)?;
            panic!("a crash after indexing a pack");
        })
    }));
    assert!(crashed.is_err());
    assert!(catalog.read(|tx| indexed_packs(tx)).unwrap().is_empty());

    catalog.write(|tx| add_pack(tx, &pack)).unwrap();
    drop(catalog);
    let catalog = open_catalog(dir.path());
    assert_eq!(
        catalog.read(|tx| object_location(tx, blob(b"a"))).unwrap(),
        pack.location(blob(b"a"))
    );
}

/// The tables refuse what no pack could hold, whoever writes it: packs smaller than 150 bytes or
/// without objects, records before the pack's header, objects of packs not indexed, an object
/// located twice, and text where numbers belong.
#[test]
fn the_tables_refuse_rows_no_pack_could_hold() {
    let conn = catalog_in_memory();
    let name = "ab".repeat(32);
    let id = blob(b"a").to_string();
    let refused = |result: rusqlite::Result<usize>| {
        let error = result.unwrap_err();
        assert_eq!(
            error.sqlite_error_code(),
            Some(ErrorCode::ConstraintViolation),
            "{error}"
        );
    };
    refused(conn.execute("INSERT INTO packs VALUES (?1, 149, 1)", [&name]));
    refused(conn.execute("INSERT INTO packs VALUES (?1, 150, 0)", [&name]));
    refused(conn.execute("INSERT INTO packs VALUES (?1, 'large', 1)", [&name]));
    conn.execute("INSERT INTO packs VALUES (?1, 150, 1)", [&name])
        .unwrap();
    refused(conn.execute("INSERT INTO objects VALUES (?1, ?2, 11)", [&id, &name]));
    refused(conn.execute(
        "INSERT INTO objects VALUES (?1, ?2, 12)",
        [&id, &"cd".repeat(32)],
    ));
    refused(conn.execute(
        "INSERT INTO objects VALUES (?1, ?2, 'twelve')",
        [&id, &name],
    ));
    conn.execute("INSERT INTO objects VALUES (?1, ?2, 12)", [&id, &name])
        .unwrap();
    refused(conn.execute("INSERT INTO objects VALUES (?1, ?2, 13)", [&id, &name]));
}

/// Rows read back are checked again: one that no longer validates is an error, never repaired,
/// and through the store's locator a failure of the catalog's own file.
#[test]
fn rows_that_no_longer_validate_are_errors() {
    let dir = tempfile::tempdir().unwrap();
    let catalog = open_catalog(dir.path());
    let id = blob(b"a");
    catalog
        .write(|tx| {
            tx.execute("INSERT INTO packs VALUES ('not a pack name', 150, 1)", [])?;
            tx.execute(
                "INSERT INTO objects VALUES (?1, 'not a pack name', 12)",
                [id],
            )?;
            Ok(())
        })
        .unwrap();
    let conversion = |result: Result<_, CatalogError>| {
        matches!(
            result,
            Err(CatalogError::Sqlite(
                rusqlite::Error::FromSqlConversionFailure(..)
            ))
        )
    };
    catalog
        .read(|tx| {
            assert!(conversion(object_location(tx, id).map(drop)));
            assert!(conversion(indexed_packs(tx).map(drop)));
            match CatalogLocator(tx).locate(id) {
                Err(StoreError::Io { path, source }) => {
                    let file = dir.path().join("catalog.sqlite");
                    assert_eq!(
                        std::fs::canonicalize(&path).unwrap(),
                        std::fs::canonicalize(file).unwrap()
                    );
                    let inner = source
                        .get_ref()
                        .and_then(|inner| inner.downcast_ref::<CatalogError>());
                    assert!(matches!(inner, Some(CatalogError::Sqlite(_))), "{source:?}");
                }
                other => panic!("not a failure of the catalog: {other:?}"),
            }
            Ok(())
        })
        .unwrap();
}

/// History written through the store reads back through the catalog (versioning.md §4.3, §7.5):
/// packs staged, published and indexed in one transaction, `HEAD` replaced; the commit, its trees
/// and its blobs read where the catalog finds them, and the commit checked in its history; the
/// index rebuilt from the packs (§13.2); a pack that goes makes its tree missing.
#[test]
fn history_written_to_the_store_reads_back_through_the_catalog() {
    let dir = tempfile::tempdir().unwrap();
    let store = LocalStore::new(&Layout::new(dir.path()));
    let catalog = open_catalog(dir.path());
    let (mut blobs, trees, commit) = first_commit();
    let mut set = store.pack_set();
    for bytes in &blobs {
        set.add_blob(bytes, BlobClass::Text).unwrap();
    }
    // A Word version of 1 MiB, which gets a pack of its own (remote-format.md §9.5).
    let word = noise(WORD_PACK_MIN as usize);
    set.add_blob(&word, BlobClass::Word).unwrap();
    blobs.push(word);
    for object in [&trees[0], &trees[2], &commit] {
        set.add_object(object, true).unwrap();
    }
    let mut staged = set.finish().unwrap();
    // The course's tree in a pack of its own, to take it away at the end.
    let mut course = store.pack_writer().unwrap();
    course.add_object(&trees[1], true).unwrap();
    staged.push(course.stage().unwrap());
    let published: Vec<PackIndex> = staged
        .into_iter()
        .map(|pack| store.publish(pack).unwrap().index)
        .collect();
    assert_eq!(published.len(), 3);
    catalog
        .write(|tx| published.iter().try_for_each(|pack| add_pack(tx, pack)))
        .unwrap();
    store.write_head(commit.id()).unwrap();

    let head = store.read_head().unwrap().unwrap();
    assert_eq!(head, commit.id());
    let ids: Vec<ObjectId> = blobs
        .iter()
        .map(|bytes| blob(bytes))
        .chain(trees.iter().map(Encoded::id))
        .chain([head])
        .collect();
    let memory = MemoryIndex::of_store(&store).unwrap();
    let locations = |catalog: &Catalog| {
        catalog
            .read(|tx| {
                ids.iter()
                    .map(|&id| object_location(tx, id))
                    .collect::<Result<Vec<_>, _>>()
            })
            .unwrap()
    };
    let indexed = locations(&catalog);
    assert_eq!(
        indexed,
        ids.iter().map(|&id| memory.get(id)).collect::<Vec<_>>()
    );
    assert!(indexed.iter().all(Option::is_some));

    let parsed = catalog
        .read(|tx| {
            let mut expected: Vec<PackName> = published.iter().map(PackIndex::name).collect();
            expected.sort();
            assert_eq!(names(tx), expected);
            assert!(ids.iter().all(|&id| has_object(tx, id).unwrap()));
            let locator = CatalogLocator(tx);
            let at = |id| locator.locate(id).unwrap().expect("the object is indexed");
            let read = store.read_commit(head, at(head)).unwrap();
            assert_eq!(read.encode().unwrap(), commit);
            assert_eq!(read.tree, trees[2].id());
            for tree in &trees {
                let id = tree.id();
                assert_eq!(
                    store.read_tree(id, at(id)).unwrap().encode().unwrap(),
                    *tree
                );
            }
            for bytes in &blobs {
                let id = blob(bytes);
                let mut reader = store.open_blob(id, at(id)).unwrap();
                let mut content = Vec::new();
                reader.read_to_end(&mut content).unwrap();
                assert!(reader.is_verified());
                assert_eq!(&content, bytes);
            }
            let mut checker = HistoryChecker::new(store.trees(locator));
            checker.check_commit(head, &read, None).unwrap();
            Ok(read)
        })
        .unwrap();

    // A rebuild indexes every pack in `packs/` again, from its index alone.
    catalog
        .write(|tx| {
            clear_object_index(tx)?;
            for name in store.list_packs().unwrap().packs {
                add_pack(tx, &store.read_pack_index(name).unwrap())?;
            }
            Ok(())
        })
        .unwrap();
    assert_eq!(locations(&catalog), indexed);

    // The course's pack goes: while the catalog still lists it, and after.
    let course = published
        .iter()
        .find(|pack| pack.offset(trees[1].id()).is_some())
        .expect("the course's tree is in a pack");
    assert_eq!(course.object_count(), 1);
    let course = course.name();
    assert!(store.remove_pack(course).unwrap());
    let missing = |catalog: &Catalog| {
        catalog
            .read(|tx| {
                let mut checker = HistoryChecker::new(store.trees(CatalogLocator(tx)));
                Ok(checker.check_commit(head, &parsed, None))
            })
            .unwrap()
    };
    assert!(matches!(missing(&catalog), Err(StoreError::Missing(id)) if id == trees[1].id()));
    assert!(catalog.write(|tx| remove_pack(tx, course)).unwrap());
    assert_eq!(
        catalog
            .read(|tx| object_location(tx, trees[1].id()))
            .unwrap(),
        None
    );
    assert!(matches!(missing(&catalog), Err(StoreError::Missing(id)) if id == trees[1].id()));
    let commit_again = catalog
        .read(|tx| {
            let at = CatalogLocator(tx).locate(head).unwrap().unwrap();
            Ok(store.read_commit(head, at).unwrap())
        })
        .unwrap();
    assert_eq!(commit_again, parsed);
}

/// What the index does, as a model: an object keeps the first location it gets until the pack of
/// that location goes; a pack indexed again is indexed from scratch.
#[derive(Debug, Default)]
struct Model {
    packs: BTreeMap<PackName, (u64, usize)>,
    objects: BTreeMap<ObjectId, Location>,
}

impl Model {
    fn add(&mut self, pack: &PackIndex) {
        self.remove(pack.name());
        self.packs
            .insert(pack.name(), (pack.size(), pack.object_count()));
        for entry in pack.entries() {
            self.objects.entry(entry.id).or_insert(Location {
                pack: pack.name(),
                offset: entry.offset,
            });
        }
    }

    fn remove(&mut self, name: PackName) -> bool {
        self.objects.retain(|_, location| location.pack != name);
        self.packs.remove(&name).is_some()
    }
}

#[derive(Debug, Clone, Copy)]
enum Step {
    Add(usize),
    Remove(usize),
    Clear,
}

/// How many packs a case draws, from a pool of six blobs, so that they share objects.
const PACKS: usize = 5;

/// Packs of one to six of the pool's blobs, in any order: packs share objects at other offsets,
/// and two packs may be one.
fn packs() -> impl Strategy<Value = Vec<PackIndex>> {
    let pack = Just((0..6u8).collect::<Vec<_>>())
        .prop_shuffle()
        .prop_flat_map(|order| (1..=order.len()).prop_map(move |len| order[..len].to_vec()));
    prop::collection::vec(pack, PACKS).prop_map(|packs| {
        packs
            .iter()
            .map(|picks| {
                let blobs: Vec<Vec<u8>> = picks
                    .iter()
                    .map(|&pick| vec![pick; usize::from(pick) + 1])
                    .collect();
                let blobs: Vec<&[u8]> = blobs.iter().map(Vec::as_slice).collect();
                pack_of(&blobs)
            })
            .collect()
    })
}

fn steps() -> impl Strategy<Value = Vec<Step>> {
    let step = prop_oneof![
        4 => (0..PACKS).prop_map(Step::Add),
        2 => (0..PACKS).prop_map(Step::Remove),
        1 => Just(Step::Clear),
    ];
    prop::collection::vec(step, 1..16)
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(48))]

    /// Whatever packs are indexed, indexed again, removed or cleared, the catalog lists the packs
    /// and finds each object where the model does.
    #[test]
    fn the_index_keeps_the_first_location_until_its_pack_goes(
        packs in packs(),
        steps in steps(),
    ) {
        let conn = catalog_in_memory();
        let mut model = Model::default();
        let ids: BTreeSet<ObjectId> = packs
            .iter()
            .flat_map(|pack| pack.entries().iter().map(|entry| entry.id))
            .collect();
        for step in steps {
            match step {
                Step::Add(pack) => {
                    add_pack(&conn, &packs[pack]).unwrap();
                    model.add(&packs[pack]);
                }
                Step::Remove(pack) => {
                    let name = packs[pack].name();
                    prop_assert_eq!(remove_pack(&conn, name).unwrap(), model.remove(name));
                }
                Step::Clear => {
                    clear_object_index(&conn).unwrap();
                    model = Model::default();
                }
            }
            let listed: Vec<(PackName, (u64, usize))> = indexed_packs(&conn)
                .unwrap()
                .into_iter()
                .map(|pack| (pack.name, (pack.size, pack.objects)))
                .collect();
            prop_assert_eq!(listed, model.packs.clone().into_iter().collect::<Vec<_>>());
            for &id in &ids {
                let location = model.objects.get(&id).copied();
                prop_assert_eq!(object_location(&conn, id).unwrap(), location);
                prop_assert_eq!(has_object(&conn, id).unwrap(), location.is_some());
            }
        }
    }
}
