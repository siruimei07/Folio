use std::panic::{AssertUnwindSafe, catch_unwind};

use proptest::prelude::*;
use rusqlite::{ErrorCode, OptionalExtension};

use super::*;
use crate::catalog::{
    Catalog, EntryChanges, EntryRecord, apply_changes, delete_entry, entry, entry_by_id,
    reset_for_rebuild, search, upsert_entry,
};
use crate::hash::ContentHash;
use crate::search::SearchQuery;
use crate::test_support::{open_catalog, path};

/// The extractor version the tests record with.
const VERSION: u32 = 3;

/// Search time, in seconds since the Unix epoch.
const NOW: i64 = 1_700_000_000;

fn record_of(text: &str, class: FileClass, content: &[u8]) -> EntryRecord {
    EntryRecord {
        path: path(text),
        kind: EntryKind::File,
        class,
        size: content.len() as u64,
        mtime_ns: Some(1_700_000_000_000_000_000),
        file_id: None,
        hash: Some(ContentHash::of(content)),
    }
}

fn text(name: &str) -> EntryRecord {
    record_of(name, FileClass::Text, name.as_bytes())
}

fn word(name: &str) -> EntryRecord {
    record_of(name, FileClass::Word, name.as_bytes())
}

/// Adds or updates the entries at their paths, in order, and returns them as stored.
fn put(catalog: &Catalog, records: &[EntryRecord]) -> Vec<Entry> {
    catalog
        .write(|tx| {
            records
                .iter()
                .map(|record| {
                    let id = upsert_entry(tx, record, 100)?;
                    Ok(entry_by_id(tx, id)?.expect("the entry was just stored"))
                })
                .collect()
        })
        .unwrap()
}

fn record(catalog: &Catalog, file: &Entry, state: ExtractState) -> bool {
    catalog
        .write(|tx| record_extract(tx, file, VERSION, &state))
        .unwrap()
}

fn failed(failure: ExtractFailure, detail: &str) -> ExtractState {
    ExtractState::Failed {
        failure,
        detail: detail.to_owned(),
    }
}

fn pending(catalog: &Catalog, version: u32) -> Vec<String> {
    let files = catalog
        .read(|tx| pending_extracts(tx, EntryId(0), 100, version))
        .unwrap();
    let count = catalog
        .read(|tx| count_pending_extracts(tx, version))
        .unwrap();
    assert_eq!(count, files.len() as u64);
    files
        .into_iter()
        .map(|file| file.record.path.to_string())
        .collect()
}

fn body(catalog: &Catalog, id: EntryId) -> Option<String> {
    catalog
        .read(|tx| {
            Ok(
                tx.query_row("SELECT body FROM search WHERE rowid = ?1", [id.0], |row| {
                    row.get(0)
                })?,
            )
        })
        .unwrap()
}

/// An `extracts` row as text: hash, class, version, status, failure, detail.
type Row = (String, String, i64, String, Option<String>, Option<String>);

fn row(catalog: &Catalog, id: EntryId) -> Option<Row> {
    catalog
        .read(|tx| {
            Ok(tx
                .query_row(
                    "SELECT hash, class, version, status, failure, detail
                     FROM extracts WHERE entry_id = ?1",
                    [id.0],
                    |row| {
                        Ok((
                            row.get(0)?,
                            row.get(1)?,
                            row.get(2)?,
                            row.get(3)?,
                            row.get(4)?,
                            row.get(5)?,
                        ))
                    },
                )
                .optional()?)
        })
        .unwrap()
}

fn rows(catalog: &Catalog) -> i64 {
    catalog
        .read(|tx| Ok(tx.query_row("SELECT count(*) FROM extracts", [], |row| row.get(0))?))
        .unwrap()
}

/// The paths search finds for `text`, sorted.
fn found(catalog: &Catalog, text: &str) -> Vec<String> {
    let query = SearchQuery::parse(text).unwrap().unwrap();
    let mut paths: Vec<String> = catalog
        .read(|tx| search(tx, &query, 10, NOW))
        .unwrap()
        .into_iter()
        .map(|hit| hit.entry.record.path.to_string())
        .collect();
    paths.sort();
    paths
}

#[test]
fn every_outcome_is_stored_with_the_entry_it_was_extracted_from() {
    let dir = tempfile::tempdir().unwrap();
    let catalog = open_catalog(dir.path());
    let files = put(
        &catalog,
        &[
            text("a.md"),
            text("b.txt"),
            text("c.bin.txt"),
            text("pnpm-lock.yaml"),
            word("d.docx"),
            word("e.docx"),
        ],
    );
    let states = [
        ExtractState::Text("线性代数".to_owned()),
        ExtractState::Empty,
        ExtractState::Binary,
        ExtractState::Skipped,
        failed(ExtractFailure::Invalid, "not a ZIP archive"),
        failed(ExtractFailure::TooLarge, "over 64 MiB expanded"),
    ];
    for (file, state) in files.iter().zip(states) {
        assert!(record(&catalog, file, state));
    }
    let stored: Vec<Option<Row>> = files.iter().map(|file| row(&catalog, file.id)).collect();
    let expected =
        |file: &Entry, class: &str, status: &str, failure: Option<&str>, detail: Option<&str>| {
            Some((
                file.record.hash.as_ref().unwrap().to_string(),
                class.to_owned(),
                i64::from(VERSION),
                status.to_owned(),
                failure.map(str::to_owned),
                detail.map(str::to_owned),
            ))
        };
    assert_eq!(
        stored,
        [
            expected(&files[0], "text", "text", None, None),
            expected(&files[1], "text", "empty", None, None),
            expected(&files[2], "text", "binary", None, None),
            expected(&files[3], "text", "skipped", None, None),
            expected(
                &files[4],
                "word",
                "failed",
                Some("invalid"),
                Some("not a ZIP archive")
            ),
            expected(
                &files[5],
                "word",
                "failed",
                Some("too_large"),
                Some("over 64 MiB expanded")
            ),
        ]
    );
    // Only the text is a body.
    let bodies: Vec<Option<String>> = files.iter().map(|file| body(&catalog, file.id)).collect();
    assert_eq!(bodies[0].as_deref(), Some("线性代数"));
    assert!(bodies[1..].iter().all(Option::is_none), "{bodies:?}");
    assert!(pending(&catalog, VERSION).is_empty());
}

#[test]
fn pending_files_are_hashed_text_and_word_files_without_a_current_row() {
    let dir = tempfile::tempdir().unwrap();
    let catalog = open_catalog(dir.path());
    let unhashed = EntryRecord {
        hash: None,
        ..text("unhashed.md")
    };
    // A folder whose name has a text extension: folders are never extracted, whatever their class.
    let folder = EntryRecord {
        kind: EntryKind::Folder,
        size: 0,
        ..text("folder.md")
    };
    let files = put(
        &catalog,
        &[
            text("a.md"),
            word("b.docx"),
            record_of("c.pdf", FileClass::Other, b"pdf"),
            unhashed,
            folder,
            text("d.md"),
        ],
    );
    assert_eq!(pending(&catalog, VERSION), ["a.md", "b.docx", "d.md"]);
    // By id, from above `after`, at most `limit`.
    let page = |after: EntryId, limit| -> Vec<String> {
        catalog
            .read(|tx| pending_extracts(tx, after, limit, VERSION))
            .unwrap()
            .into_iter()
            .map(|file| file.record.path.to_string())
            .collect()
    };
    assert_eq!(page(EntryId(0), 2), ["a.md", "b.docx"]);
    assert_eq!(page(files[1].id, 2), ["d.md"]);
    assert_eq!(page(files[5].id, 2), Vec::<String>::new());
    // The pending entries are the catalog's.
    let given = catalog
        .read(|tx| pending_extracts(tx, EntryId(0), 1, VERSION))
        .unwrap();
    assert_eq!(given, [files[0].clone()]);

    // A row for the current hash, class and version is done, whatever its outcome.
    assert!(record(
        &catalog,
        &files[0],
        ExtractState::Text("a".to_owned())
    ));
    assert!(record(
        &catalog,
        &files[1],
        failed(ExtractFailure::Invalid, "no main part")
    ));
    assert_eq!(pending(&catalog, VERSION), ["d.md"]);
    // Another version of the extractor redoes every file.
    assert_eq!(pending(&catalog, VERSION + 1), ["a.md", "b.docx", "d.md"]);

    // Another hash: the file changed and was hashed again.
    put(&catalog, &[record_of("a.md", FileClass::Text, b"edited")]);
    assert_eq!(pending(&catalog, VERSION), ["a.md", "d.md"]);
    // Another class, under other versioning rules.
    put(&catalog, &[record_of("b.docx", FileClass::Text, b"b.docx")]);
    assert_eq!(pending(&catalog, VERSION), ["a.md", "b.docx", "d.md"]);
    // A file waiting for its new hash is not pending, and comes back with it.
    put(
        &catalog,
        &[EntryRecord {
            hash: None,
            ..text("d.md")
        }],
    );
    assert_eq!(pending(&catalog, VERSION), ["a.md", "b.docx"]);
}

/// A file deleted or changed between reading it and recording what it gave is passed over, and
/// what the catalog held for it stays.
#[test]
fn a_record_for_a_changed_or_deleted_entry_changes_nothing() {
    let dir = tempfile::tempdir().unwrap();
    let catalog = open_catalog(dir.path());
    let files = put(&catalog, &[text("a.md"), word("b.docx"), text("c.md")]);
    for file in &files {
        assert!(record(
            &catalog,
            file,
            ExtractState::Text("old body".to_owned())
        ));
    }
    let before: Vec<Option<Row>> = files.iter().map(|file| row(&catalog, file.id)).collect();

    // Changed content, another class, deleted.
    put(
        &catalog,
        &[
            record_of("a.md", FileClass::Text, b"new content"),
            record_of("b.docx", FileClass::Text, b"b.docx"),
        ],
    );
    catalog.write(|tx| delete_entry(tx, &path("c.md"))).unwrap();
    for file in &files {
        let state = failed(ExtractFailure::Invalid, "read before the change");
        assert!(!record(&catalog, file, state));
        assert!(!record(&catalog, file, ExtractState::Empty));
    }
    for (file, before) in files[..2].iter().zip(&before) {
        assert_eq!(&row(&catalog, file.id), before);
        assert_eq!(body(&catalog, file.id).as_deref(), Some("old body"));
    }
    assert_eq!(row(&catalog, files[2].id), None);

    // The entries as they are now record.
    let current = catalog
        .read(|tx| entry(tx, &path("a.md")))
        .unwrap()
        .unwrap();
    assert!(record(&catalog, &current, ExtractState::Empty));
    assert_eq!(body(&catalog, current.id), None);
}

#[test]
fn a_batch_records_what_still_holds_and_passes_over_the_rest() {
    let dir = tempfile::tempdir().unwrap();
    let catalog = open_catalog(dir.path());
    let files = put(&catalog, &[text("a.md"), word("b.docx"), text("c.md")]);
    assert!(record(
        &catalog,
        &files[1],
        ExtractState::Text("old body".to_owned())
    ));
    // b.docx changed after it was read.
    put(&catalog, &[record_of("b.docx", FileClass::Word, b"new")]);
    let states = [
        ExtractState::Text("线性代数 notes".to_owned()),
        ExtractState::Text("read before the change".to_owned()),
        failed(ExtractFailure::TooLarge, "over the expanded cap"),
    ];
    let outcomes: Vec<_> = files.iter().zip(&states).collect();
    let recorded = catalog
        .write(|tx| record_extracts(tx, VERSION, &outcomes))
        .unwrap();
    assert_eq!(recorded, [true, false, true]);
    assert_eq!(
        body(&catalog, files[0].id).as_deref(),
        Some("线性代数 notes")
    );
    assert_eq!(body(&catalog, files[1].id).as_deref(), Some("old body"));
    assert_eq!(body(&catalog, files[2].id), None);
    assert_eq!(row(&catalog, files[2].id).unwrap().3, "failed");
    assert_eq!(found(&catalog, "线性"), ["a.md"]);
    assert!(found(&catalog, "change").is_empty());
}

/// FTS5 writes what it holds as a new index segment whenever SQLite opens a statement savepoint,
/// as each row's insert does: a batch writes its rows first, so its bodies make one segment.
#[test]
fn a_batch_writes_its_bodies_as_one_index_segment() {
    let dir = tempfile::tempdir().unwrap();
    let catalog = open_catalog(dir.path());
    let names: Vec<String> = (0..20).map(|index| format!("{index}.md")).collect();
    let records: Vec<EntryRecord> = names.iter().map(|name| text(name)).collect();
    let files = put(&catalog, &records);
    without_merging(&catalog);
    let before = segments(&catalog);
    let states: Vec<ExtractState> = names
        .iter()
        .map(|name| ExtractState::Text(format!("eigenvalue notes of {name}")))
        .collect();
    let outcomes: Vec<_> = files.iter().zip(&states).collect();
    let recorded = catalog
        .write(|tx| record_extracts(tx, VERSION, &outcomes))
        .unwrap();
    assert!(recorded.iter().all(|done| *done));
    assert_eq!(segments(&catalog), before + 1);
    assert_eq!(found(&catalog, "eigenvalue").len(), 10);
}

/// The segments of the full-text index.
fn segments(catalog: &Catalog) -> i64 {
    catalog
        .read(|tx| {
            Ok(
                tx.query_row("SELECT count(DISTINCT segid) FROM search_idx", [], |row| {
                    row.get(0)
                })?,
            )
        })
        .unwrap()
}

/// Stops the full-text index merging its segments, so that every segment written stays countable.
fn without_merging(catalog: &Catalog) {
    catalog
        .write(|tx| {
            tx.execute_batch(
                "INSERT INTO search (search, rank) VALUES ('automerge', 0);
                 INSERT INTO search (search, rank) VALUES ('crisismerge', 1000);",
            )?;
            Ok(())
        })
        .unwrap();
}

#[test]
fn only_hashed_text_and_word_files_can_be_recorded() {
    let dir = tempfile::tempdir().unwrap();
    let catalog = open_catalog(dir.path());
    let unhashed = EntryRecord {
        hash: None,
        ..text("unhashed.md")
    };
    let folder = EntryRecord {
        kind: EntryKind::Folder,
        ..text("folder.md")
    };
    let files = put(
        &catalog,
        &[
            record_of("c.pdf", FileClass::Other, b"pdf"),
            unhashed,
            folder,
        ],
    );
    for file in &files {
        let refused = catalog.write(|tx| record_extract(tx, file, VERSION, &ExtractState::Empty));
        assert!(
            matches!(&refused, Err(CatalogError::Invalid(message)) if message.contains("not a hashed text or Word file")),
            "{refused:?}"
        );
    }
    assert_eq!(rows(&catalog), 0);
}

#[test]
fn a_failure_keeps_the_first_500_characters_of_its_detail() {
    let dir = tempfile::tempdir().unwrap();
    let catalog = open_catalog(dir.path());
    let files = put(&catalog, &[word("a.docx"), word("b.docx")]);
    let long = "错".repeat(499) + "误x" + &"y".repeat(100);
    assert!(record(
        &catalog,
        &files[0],
        failed(ExtractFailure::Invalid, &long)
    ));
    let exact = "z".repeat(500);
    assert!(record(
        &catalog,
        &files[1],
        failed(ExtractFailure::Invalid, &exact)
    ));
    let details: Vec<String> = catalog
        .read(|tx| failed_extracts(tx, VERSION))
        .unwrap()
        .into_iter()
        .map(|failed| failed.detail)
        .collect();
    assert_eq!(details, ["错".repeat(499) + "误", exact]);
}

#[test]
fn rows_go_with_their_entries_and_with_a_rebuild() {
    let dir = tempfile::tempdir().unwrap();
    let catalog = open_catalog(dir.path());
    let folder = EntryRecord {
        path: path("s"),
        kind: EntryKind::Folder,
        class: FileClass::Other,
        size: 0,
        mtime_ns: None,
        file_id: None,
        hash: None,
    };
    let files = put(
        &catalog,
        &[
            folder,
            text("s/a.md"),
            text("s/b.md"),
            text("c.md"),
            text("d.md"),
        ],
    );
    for file in &files[1..] {
        assert!(record(
            &catalog,
            file,
            ExtractState::Text("body".to_owned())
        ));
    }
    assert_eq!(rows(&catalog), 4);

    // The count of a delete is still exact: cascades do not count.
    let removed = catalog.write(|tx| delete_entry(tx, &path("s"))).unwrap();
    assert_eq!(removed, 3);
    assert_eq!(rows(&catalog), 2);
    // A scan's removals.
    catalog
        .write(|tx| {
            let changes = EntryChanges {
                removed: vec![(files[3].id, path("c.md"))],
                ..EntryChanges::default()
            };
            apply_changes(tx, &changes)
        })
        .unwrap();
    assert_eq!(row(&catalog, files[3].id), None);
    assert_eq!(rows(&catalog), 1);

    catalog.write(|tx| reset_for_rebuild(tx)).unwrap();
    assert_eq!(rows(&catalog), 0);
    // A rebuilt entry has a new id, and nothing extracted yet.
    let rebuilt = put(&catalog, &[text("d.md")]);
    assert!(rebuilt[0].id > files[4].id);
    assert_eq!(pending(&catalog, VERSION), ["d.md"]);
    assert_eq!(body(&catalog, rebuilt[0].id), None);
}

#[test]
fn a_file_that_stops_being_text_loses_its_row_and_body_with_that_change() {
    let dir = tempfile::tempdir().unwrap();
    let catalog = open_catalog(dir.path());
    let files = put(
        &catalog,
        &[
            text("a.md"),
            word("b.docx"),
            text("c.md"),
            text("d.md"),
            word("e.docx"),
        ],
    );
    for file in &files {
        assert!(record(
            &catalog,
            file,
            ExtractState::Text("kept".to_owned())
        ));
    }

    let changed = catalog.write(|tx| {
        for record in [
            // Renamed to another extension in place, or the versioning rules changed.
            record_of("a.md", FileClass::Other, b"a.md"),
            // A file that became a folder of the same name.
            EntryRecord {
                kind: EntryKind::Folder,
                class: FileClass::Other,
                size: 0,
                hash: None,
                ..word("b.docx")
            },
            // Changed and waiting for its new hash: its old body stays until it is extracted.
            EntryRecord {
                hash: None,
                ..text("c.md")
            },
            // Now read as text: extracted again as such, its old body kept meanwhile.
            record_of("e.docx", FileClass::Text, b"e.docx"),
        ] {
            upsert_entry(tx, &record, 100)?;
        }
        // In the same write, before it commits.
        let id = files[0].id.0;
        let rows: i64 = tx.query_row(
            "SELECT count(*) FROM extracts WHERE entry_id = ?1",
            [id],
            |row| row.get(0),
        )?;
        let body: Option<String> =
            tx.query_row("SELECT body FROM search WHERE rowid = ?1", [id], |row| {
                row.get(0)
            })?;
        Ok((rows, body))
    });
    assert_eq!(changed.unwrap(), (0, None));
    for file in &files[..2] {
        assert_eq!(row(&catalog, file.id), None);
        assert_eq!(body(&catalog, file.id), None);
    }
    for file in &files[2..] {
        assert!(row(&catalog, file.id).is_some());
        assert_eq!(body(&catalog, file.id).as_deref(), Some("kept"));
    }
    assert_eq!(pending(&catalog, VERSION), ["e.docx"]);
}

#[test]
fn failures_are_listed_while_they_hold_for_the_entry() {
    let dir = tempfile::tempdir().unwrap();
    let catalog = open_catalog(dir.path());
    let files = put(
        &catalog,
        &[
            word("z.docx"),
            word("a.docx"),
            word("m.docx"),
            text("b.md"),
            word("c.docx"),
        ],
    );
    assert!(record(
        &catalog,
        &files[0],
        failed(ExtractFailure::Invalid, "bad XML")
    ));
    assert!(record(
        &catalog,
        &files[1],
        failed(ExtractFailure::TooLarge, "too many entries")
    ));
    assert!(record(
        &catalog,
        &files[2],
        failed(ExtractFailure::Invalid, "no main part")
    ));
    assert!(record(
        &catalog,
        &files[3],
        ExtractState::Text("ok".to_owned())
    ));
    assert!(record(&catalog, &files[4], ExtractState::Empty));
    let listed = |version| -> Vec<FailedExtract> {
        catalog.read(|tx| failed_extracts(tx, version)).unwrap()
    };
    let failure = |text: &str, failure, detail: &str| FailedExtract {
        path: path(text),
        failure,
        detail: detail.to_owned(),
    };
    // By path.
    assert_eq!(
        listed(VERSION),
        [
            failure("a.docx", ExtractFailure::TooLarge, "too many entries"),
            failure("m.docx", ExtractFailure::Invalid, "no main part"),
            failure("z.docx", ExtractFailure::Invalid, "bad XML"),
        ]
    );
    // Rows of another version are to be extracted again, not failures.
    assert!(listed(VERSION + 1).is_empty());

    // Changed (an older hash, or none yet) or of another class: no longer a failure.
    put(
        &catalog,
        &[
            record_of("z.docx", FileClass::Word, b"fixed"),
            EntryRecord {
                hash: None,
                ..word("a.docx")
            },
            record_of("m.docx", FileClass::Text, b"m.docx"),
        ],
    );
    assert!(listed(VERSION).is_empty());
    assert_eq!(rows(&catalog), 5);
}

/// The failed rows are found through their partial index, not by reading every row.
#[test]
fn failures_are_listed_through_their_index() {
    let dir = tempfile::tempdir().unwrap();
    let catalog = open_catalog(dir.path());
    let plan: Vec<String> = catalog
        .read(|tx| {
            let mut statement = tx.prepare(&format!("EXPLAIN QUERY PLAN {}", failed_query()))?;
            let details = statement
                .query_map(named_params! {":version": VERSION}, |row| row.get(3))?
                .collect::<Result<_, _>>()?;
            Ok(details)
        })
        .unwrap();
    assert!(
        plan.iter()
            .any(|step| step.starts_with("SCAN extracts USING")
                && step.ends_with("INDEX extracts_failed")),
        "{plan:?}"
    );
}

/// With nothing to extract, a pass mostly counts: the count reads the extractable entries from
/// their index and the rows from their table, each in id order, with no sorting and no lookups.
#[test]
fn pending_files_are_counted_from_two_scans_in_id_order() {
    let dir = tempfile::tempdir().unwrap();
    let catalog = open_catalog(dir.path());
    let (entries, rows) = count_queries();
    let plan = |sql: &str| -> Vec<String> {
        catalog
            .read(|tx| {
                let mut statement = tx.prepare(&format!("EXPLAIN QUERY PLAN {sql}"))?;
                let details = statement
                    .query_map([], |row| row.get(3))?
                    .collect::<Result<_, _>>()?;
                Ok(details)
            })
            .unwrap()
    };
    assert_eq!(
        plan(&entries),
        ["SCAN entries USING COVERING INDEX entries_extractable"]
    );
    assert_eq!(plan(&rows), ["SCAN extracts"]);
}

#[test]
fn the_count_pairs_rows_with_their_entries_by_id() {
    let dir = tempfile::tempdir().unwrap();
    let catalog = open_catalog(dir.path());
    let files = put(
        &catalog,
        &[text("a.md"), text("b.md"), word("c.docx"), text("d.md")],
    );
    for file in &files[1..] {
        assert!(record(&catalog, file, ExtractState::Empty));
    }
    assert_eq!(pending(&catalog, VERSION), ["a.md"]);
    // b.md waits for its new hash: its row is passed over and it is not counted.
    put(
        &catalog,
        &[EntryRecord {
            hash: None,
            ..text("b.md")
        }],
    );
    assert_eq!(pending(&catalog, VERSION), ["a.md"]);
    // c.docx changed; d.md's row is of an older version.
    put(&catalog, &[record_of("c.docx", FileClass::Word, b"new")]);
    assert_eq!(pending(&catalog, VERSION), ["a.md", "c.docx"]);
    assert_eq!(pending(&catalog, VERSION + 1), ["a.md", "c.docx", "d.md"]);
}

/// A hash job's text to read, counted before it hashes (ipc-m1 §13): the pending files and the
/// text and Word files still to hash, each once; never other files or folders, nor a file whose
/// text was read for its current hash, class and version.
#[test]
fn the_text_to_read_is_what_is_pending_and_the_text_still_to_hash() {
    let dir = tempfile::tempdir().unwrap();
    let catalog = open_catalog(dir.path());
    let unhashed = |record: EntryRecord| EntryRecord {
        hash: None,
        ..record
    };
    let files = put(
        &catalog,
        &[
            text("a.md"),
            word("b.docx"),
            record_of("c.pdf", FileClass::Other, b"pdf"),
            unhashed(record_of("d.pdf", FileClass::Other, b"pdf")),
            unhashed(text("e.md")),
            unhashed(word("f.docx")),
            // Neither a folder with a text extension, hashed or not.
            EntryRecord {
                kind: EntryKind::Folder,
                size: 0,
                ..unhashed(text("folder.md"))
            },
            EntryRecord {
                kind: EntryKind::Folder,
                size: 0,
                ..word("folder.docx")
            },
        ],
    );
    let work = |version| catalog.read(|tx| count_extract_work(tx, version)).unwrap();
    // a.md and b.docx pending, e.md and f.docx still to hash.
    assert_eq!(work(VERSION), 4);
    assert!(record(&catalog, &files[0], ExtractState::Empty));
    assert!(record(
        &catalog,
        &files[1],
        failed(ExtractFailure::Invalid, "no main part")
    ));
    assert_eq!(work(VERSION), 2);
    // Another version of the extractor reads a.md and b.docx again.
    assert_eq!(work(VERSION + 1), 4);
    // Hashed, e.md is pending instead: still counted once.
    put(&catalog, &[text("e.md")]);
    assert_eq!(work(VERSION), 2);
    // a.md changed and waits for its new hash: counted again.
    put(
        &catalog,
        &[unhashed(record_of("a.md", FileClass::Text, b"edited"))],
    );
    assert_eq!(work(VERSION), 3);
    // b.docx waits for its hash too, and is counted until it hashes to the content whose text
    // was read.
    put(&catalog, &[unhashed(word("b.docx"))]);
    assert_eq!(work(VERSION), 4);
    put(&catalog, &[word("b.docx")]);
    assert_eq!(work(VERSION), 3);
    // f.docx becomes another kind of file under other versioning rules.
    put(
        &catalog,
        &[unhashed(record_of("f.docx", FileClass::Other, b"f.docx"))],
    );
    assert_eq!(work(VERSION), 2);
}

/// Hashing's count of the text and Word files left reads only the unhashed files, through their
/// partial index.
#[test]
fn the_text_still_to_hash_is_counted_through_the_unhashed_index() {
    let dir = tempfile::tempdir().unwrap();
    let catalog = open_catalog(dir.path());
    let plan: Vec<String> = catalog
        .read(|tx| {
            let mut statement =
                tx.prepare(&format!("EXPLAIN QUERY PLAN {}", unhashed_text_query()))?;
            let details = statement
                .query_map([], |row| row.get(3))?
                .collect::<Result<_, _>>()?;
            Ok(details)
        })
        .unwrap();
    assert_eq!(plan, ["SCAN entries USING INDEX entries_unhashed"]);
}

#[test]
fn search_finds_recorded_text_until_another_outcome_clears_it() {
    let dir = tempfile::tempdir().unwrap();
    let catalog = open_catalog(dir.path());
    let files = put(&catalog, &[text("notes.md"), word("report.docx")]);
    assert!(found(&catalog, "特征值").is_empty());
    assert!(record(
        &catalog,
        &files[0],
        ExtractState::Text("今天复习了线性代数的特征值".to_owned())
    ));
    assert!(record(
        &catalog,
        &files[1],
        ExtractState::Text("Eigenvalues and eigenvectors\n\n特征值".to_owned())
    ));
    assert_eq!(found(&catalog, "特征值"), ["notes.md", "report.docx"]);
    assert_eq!(found(&catalog, "eigenvectors"), ["report.docx"]);

    // The file changed and its new content failed, or has no text: nothing of the old text stays.
    let edited = put(
        &catalog,
        &[record_of("report.docx", FileClass::Word, b"v2")],
    );
    assert!(record(
        &catalog,
        &edited[0],
        failed(ExtractFailure::Invalid, "not a ZIP archive")
    ));
    assert_eq!(found(&catalog, "特征值"), ["notes.md"]);
    assert!(found(&catalog, "eigenvectors").is_empty());
    for state in [
        ExtractState::Empty,
        ExtractState::Binary,
        ExtractState::Skipped,
    ] {
        assert!(record(
            &catalog,
            &files[0],
            ExtractState::Text("特征值".to_owned())
        ));
        assert_eq!(found(&catalog, "特征值"), ["notes.md"]);
        assert!(record(&catalog, &files[0], state));
        assert!(found(&catalog, "特征值").is_empty());
    }
}

/// Word paragraphs are joined by a blank line (`extract::word_body`), and the tokenizer pairs
/// Chinese characters across one line break but not across a blank line: no match spans two
/// paragraphs.
#[test]
fn chinese_paragraphs_do_not_match_across_their_blank_line() {
    let dir = tempfile::tempdir().unwrap();
    let catalog = open_catalog(dir.path());
    let files = put(&catalog, &[word("a.docx"), text("b.md")]);
    assert!(record(
        &catalog,
        &files[0],
        ExtractState::Text("线性代数\n\n矩阵分解".to_owned())
    ));
    assert!(record(
        &catalog,
        &files[1],
        ExtractState::Text("线性代数\n矩阵分解".to_owned())
    ));
    assert_eq!(found(&catalog, "代数"), ["a.docx", "b.md"]);
    assert_eq!(found(&catalog, "矩阵分解"), ["a.docx", "b.md"]);
    // Only the hard-wrapped line joins.
    assert_eq!(found(&catalog, "数矩"), ["b.md"]);
    assert_eq!(found(&catalog, "代数矩阵"), ["b.md"]);
}

/// The row and the body change together, with the caller's transaction: a write that fails or
/// crashes after recording leaves neither.
#[test]
fn a_record_changes_with_its_transaction_only() {
    let dir = tempfile::tempdir().unwrap();
    let catalog = open_catalog(dir.path());
    let files = put(&catalog, &[text("a.md")]);
    let state = ExtractState::Text("线性代数".to_owned());
    let failed = catalog.write(|tx| {
        assert!(record_extract(tx, &files[0], VERSION, &state)?);
        Err::<(), _>(CatalogError::Invalid(
            "the write after it failed".to_owned(),
        ))
    });
    assert!(failed.is_err());
    let crashed = catch_unwind(AssertUnwindSafe(|| {
        catalog.write(|tx| -> Result<(), CatalogError> {
            record_extract(tx, &files[0], VERSION, &state)?;
            panic!("a crash after recording");
        })
    }));
    assert!(crashed.is_err());
    assert_eq!(row(&catalog, files[0].id), None);
    assert_eq!(body(&catalog, files[0].id), None);
    assert_eq!(pending(&catalog, VERSION), ["a.md"]);

    assert!(record(&catalog, &files[0], state));
    drop(catalog);
    let catalog = open_catalog(dir.path());
    assert!(pending(&catalog, VERSION).is_empty());
    assert_eq!(found(&catalog, "代数"), ["a.md"]);
}

/// The table refuses rows that no extraction gives, whoever writes them.
#[test]
fn the_table_refuses_rows_no_extraction_gives() {
    let dir = tempfile::tempdir().unwrap();
    let catalog = open_catalog(dir.path());
    let files = put(&catalog, &[text("a.md")]);
    let id = files[0].id.0;
    let hash = files[0].record.hash.as_ref().unwrap().to_string();
    catalog
        .write(|tx| {
            let refused = |columns: &str| {
                let error = tx
                    .execute(
                        &format!(
                            "INSERT INTO extracts
                                 (entry_id, hash, class, version, status, failure, detail)
                             VALUES ({columns})"
                        ),
                        params![id, hash],
                    )
                    .unwrap_err();
                assert_eq!(
                    error.sqlite_error_code(),
                    Some(ErrorCode::ConstraintViolation),
                    "{columns}: {error}"
                );
            };
            refused("?1, ?2, 'other', 1, 'text', NULL, NULL");
            refused("?1, ?2, 'text', -1, 'text', NULL, NULL");
            refused("?1, ?2, 'text', 'one', 'text', NULL, NULL");
            refused("?1, ?2, 'text', 1, 'unknown', NULL, NULL");
            refused("?1, ?2, 'text', 1, 'failed', NULL, 'why'");
            refused("?1, ?2, 'text', 1, 'failed', 'invalid', NULL");
            refused("?1, ?2, 'text', 1, 'failed', 'broken', 'why'");
            refused("?1, ?2, 'text', 1, 'text', 'invalid', NULL");
            refused("?1, ?2, 'text', 1, 'empty', NULL, 'why'");
            refused("?1 + 1000, ?2, 'text', 1, 'text', NULL, NULL");
            refused("?1, NULL || ?2, 'text', 1, 'text', NULL, NULL");
            tx.execute(
                "INSERT INTO extracts VALUES (?1, ?2, 'text', 1, 'failed', 'invalid', 'why')",
                params![id, hash],
            )?;
            refused("?1, ?2, 'text', 1, 'text', NULL, NULL");
            Ok(())
        })
        .unwrap();
}

/// A row read back is checked again: a failure no build writes is an error, never repaired.
#[test]
fn a_failure_that_no_longer_validates_is_an_error() {
    let dir = tempfile::tempdir().unwrap();
    let catalog = open_catalog(dir.path());
    let files = put(&catalog, &[word("a.docx")]);
    assert!(record(
        &catalog,
        &files[0],
        failed(ExtractFailure::Invalid, "bad XML")
    ));
    catalog
        .write(|tx| {
            // CHECK constraints off for this connection, as a hand edit would be.
            tx.execute_batch(
                "PRAGMA ignore_check_constraints = ON;
                 UPDATE extracts SET failure = 'unreadable';
                 PRAGMA ignore_check_constraints = OFF;",
            )?;
            Ok(())
        })
        .unwrap();
    let listed = catalog.read(|tx| failed_extracts(tx, VERSION));
    assert!(
        matches!(
            listed,
            Err(CatalogError::Sqlite(
                rusqlite::Error::FromSqlConversionFailure(..)
            ))
        ),
        "{listed:?}"
    );
}

/// What the table holds, as a model: per file its class, its content (no hash while it waits for
/// one) and its id, the row recorded for it and its body.
#[derive(Debug, Clone)]
struct ModelFile {
    id: EntryId,
    class: FileClass,
    content: Option<u8>,
    /// The entry as the last `Read` saw it, which a `Record` records for.
    seen: Option<Entry>,
    row: Option<(u8, FileClass, u32, u8)>,
    body: Option<String>,
}

#[derive(Debug, Clone)]
enum Op {
    /// Reads the file's entry, as the pass does before extracting it.
    Read(usize),
    /// Records the outcome for the entry the last read saw.
    Record(usize, u8, u32),
    /// The file changed: a new hash, or none yet.
    Change(usize, Option<u8>),
    /// The versioning rules gave the file another class.
    Reclass(usize, FileClass),
    /// The file went and came back: a new entry.
    Replace(usize),
}

const FILES: usize = 3;
const VERSIONS: [u32; 2] = [1, 2];

fn op() -> impl Strategy<Value = Op> {
    let class = prop_oneof![
        Just(FileClass::Text),
        Just(FileClass::Word),
        Just(FileClass::Other)
    ];
    prop_oneof![
        4 => (0..FILES).prop_map(Op::Read),
        4 => (0..FILES, 0..5u8, prop::sample::select(VERSIONS.to_vec()))
            .prop_map(|(file, state, version)| Op::Record(file, state, version)),
        2 => (0..FILES, prop::option::of(0..3u8)).prop_map(|(file, content)| Op::Change(file, content)),
        1 => (0..FILES, class).prop_map(|(file, class)| Op::Reclass(file, class)),
        1 => (0..FILES).prop_map(Op::Replace),
    ]
}

fn state_of(file: usize, state: u8, version: u32) -> ExtractState {
    match state {
        0 => ExtractState::Text(format!("body {file} {version}")),
        1 => ExtractState::Empty,
        2 => ExtractState::Binary,
        3 => ExtractState::Skipped,
        _ => failed(
            ExtractFailure::Invalid,
            &format!("failure {file} {version}"),
        ),
    }
}

fn model_record(name: &str, class: FileClass, content: Option<u8>) -> EntryRecord {
    EntryRecord {
        hash: content.map(|content| ContentHash::of(&[content])),
        ..record_of(name, class, b"")
    }
}

fn name(file: usize) -> String {
    format!("f{file}")
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(64))]

    /// Whatever is recorded, changed, reclassed or replaced, the catalog gives the pending
    /// files, the failures and the bodies the model does.
    #[test]
    fn the_table_follows_its_entries(ops in prop::collection::vec(op(), 1..40)) {
        let dir = tempfile::tempdir().unwrap();
        let catalog = open_catalog(dir.path());
        let mut model: Vec<ModelFile> = (0..FILES)
            .map(|file| {
                let entry = put(&catalog, &[model_record(&name(file), FileClass::Text, Some(0))]);
                ModelFile {
                    id: entry[0].id,
                    class: FileClass::Text,
                    content: Some(0),
                    seen: None,
                    row: None,
                    body: None,
                }
            })
            .collect();
        for op in ops {
            match op {
                Op::Read(file) => {
                    model[file].seen = catalog
                        .read(|tx| entry_by_id(tx, model[file].id))
                        .unwrap();
                }
                Op::Record(file, state, version) => {
                    let Some(seen) = model[file].seen.clone() else { continue };
                    let extractable = seen.record.class != FileClass::Other
                        && seen.record.hash.is_some();
                    let result = catalog.write(|tx| {
                        record_extract(tx, &seen, version, &state_of(file, state, version))
                    });
                    if !extractable {
                        prop_assert!(matches!(result, Err(CatalogError::Invalid(_))), "{result:?}");
                        continue;
                    }
                    let current = &model[file];
                    let holds = current.id == seen.id
                        && current.class == seen.record.class
                        && current.content.map(|content| ContentHash::of(&[content]))
                            == seen.record.hash;
                    prop_assert_eq!(result.unwrap(), holds);
                    if holds {
                        let current = &mut model[file];
                        let content = current.content.unwrap();
                        current.row = Some((content, current.class, version, state));
                        current.body = match state_of(file, state, version) {
                            ExtractState::Text(text) => Some(text),
                            _ => None,
                        };
                    }
                }
                Op::Change(file, content) => {
                    let class = model[file].class;
                    put(&catalog, &[model_record(&name(file), class, content)]);
                    model[file].content = content;
                }
                Op::Reclass(file, class) => {
                    let content = model[file].content;
                    put(&catalog, &[model_record(&name(file), class, content)]);
                    let current = &mut model[file];
                    // A file that stops being text or Word loses its row and body at once.
                    if current.class != FileClass::Other && class == FileClass::Other {
                        current.row = None;
                        current.body = None;
                    }
                    current.class = class;
                }
                Op::Replace(file) => {
                    let current = &model[file];
                    let record = model_record(&name(file), current.class, current.content);
                    catalog.write(|tx| delete_entry(tx, &record.path)).unwrap();
                    let entry = put(&catalog, &[record]);
                    let current = &mut model[file];
                    current.id = entry[0].id;
                    current.row = None;
                    current.body = None;
                }
            }

            for version in VERSIONS {
                let mut expected: Vec<(EntryId, String)> = model
                    .iter()
                    .enumerate()
                    .filter(|(_, current)| {
                        current.class != FileClass::Other
                            && current.content.is_some_and(|content| {
                                !matches!(current.row, Some((hash, class, at, _))
                                    if hash == content && class == current.class && at == version)
                            })
                    })
                    .map(|(file, current)| (current.id, name(file)))
                    .collect();
                expected.sort();
                let expected: Vec<String> = expected.into_iter().map(|(_, name)| name).collect();
                // A hash job's text to read: these, and the text and Word files still to hash.
                let to_hash = model
                    .iter()
                    .filter(|current| {
                        current.class != FileClass::Other && current.content.is_none()
                    })
                    .count();
                prop_assert_eq!(
                    catalog.read(|tx| count_extract_work(tx, version)).unwrap(),
                    (expected.len() + to_hash) as u64
                );
                prop_assert_eq!(pending(&catalog, version), expected);

                let failures: Vec<String> = catalog
                    .read(|tx| failed_extracts(tx, version))
                    .unwrap()
                    .into_iter()
                    .map(|failed| failed.path.to_string())
                    .collect();
                let expected: Vec<String> = model
                    .iter()
                    .enumerate()
                    .filter(|(_, current)| {
                        current.content.is_some_and(|content| {
                            matches!(current.row, Some((hash, class, at, 4))
                                if hash == content && class == current.class && at == version)
                        })
                    })
                    .map(|(file, _)| name(file))
                    .collect();
                prop_assert_eq!(failures, expected);
            }
            for current in &model {
                prop_assert_eq!(body(&catalog, current.id), current.body.clone());
            }
            let kept = model.iter().filter(|current| current.row.is_some()).count();
            prop_assert_eq!(rows(&catalog), kept as i64);
        }
    }
}
