use std::collections::BTreeSet;
use std::fs;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::sync::{Arc, mpsc};
use std::thread;

use rusqlite::ffi;
use rusqlite::types::Type;

use super::*;
use crate::hash::ContentHash;
use crate::meta::{
    Abbr, Color, CourseSettings, DisplayName, EntryKind, FileClass, GroupSettings, PresetTag,
    TagDefinition, TagDefinitions, TagId,
};
use crate::search::{SearchQuery, phrase};
use crate::test_support::{course_at, library_id, open_catalog, path, presets, semester};

fn folder(text: &str) -> EntryRecord {
    EntryRecord {
        path: path(text),
        kind: EntryKind::Folder,
        class: FileClass::Other,
        size: 0,
        mtime_ns: None,
        file_id: None,
        hash: None,
    }
}

fn file(text: &str, size: u64) -> EntryRecord {
    EntryRecord {
        kind: EntryKind::File,
        size,
        mtime_ns: Some(1_700_000_000_000_000_000),
        ..folder(text)
    }
}

/// Adds records in order, at time 100, and returns their ids.
fn add(catalog: &Catalog, records: &[EntryRecord]) -> Vec<EntryId> {
    catalog
        .write(|tx| {
            records
                .iter()
                .map(|record| upsert_entry(tx, record, 100))
                .collect()
        })
        .unwrap()
}

fn names(entries: Vec<Entry>) -> Vec<String> {
    entries
        .into_iter()
        .map(|entry| entry.record.path.name().to_owned())
        .collect()
}

fn root_names(catalog: &Catalog) -> Vec<String> {
    names(catalog.read(|tx| children(tx, None)).unwrap())
}

/// Names of the entries whose search row matches an FTS5 expression.
fn matches(catalog: &Catalog, query: &str) -> Vec<String> {
    catalog
        .read(|tx| {
            let names = tx
                .prepare("SELECT name FROM search WHERE search MATCH ?1 ORDER BY rowid")?
                .query_map([query], |row| row.get(0))?
                .collect::<Result<_, _>>()?;
            Ok(names)
        })
        .unwrap()
}

fn count(catalog: &Catalog, table: &str) -> i64 {
    catalog
        .read(|tx| {
            Ok(
                tx.query_row(&format!("SELECT count(*) FROM {table}"), [], |row| {
                    row.get(0)
                })?,
            )
        })
        .unwrap()
}

#[test]
fn creates_a_wal_catalog_and_keeps_its_data() {
    let dir = tempfile::tempdir().unwrap();
    let catalog = open_catalog(dir.path());
    add(&catalog, &[folder("2026 秋")]);

    let (mode, foreign_keys, trusted_schema): (String, bool, bool) = catalog
        .read(|tx| {
            Ok((
                tx.query_row("PRAGMA journal_mode", [], |row| row.get(0))?,
                tx.query_row("PRAGMA foreign_keys", [], |row| row.get(0))?,
                tx.query_row("PRAGMA trusted_schema", [], |row| row.get(0))?,
            ))
        })
        .unwrap();
    assert_eq!(
        (mode.as_str(), foreign_keys, trusted_schema),
        ("wal", true, false)
    );

    drop(catalog);
    let catalog = open_catalog(dir.path());
    assert_eq!(root_names(&catalog), ["2026 秋"]);
}

#[test]
fn reads_use_the_tokenizer_and_run_while_a_write_is_open() {
    let dir = tempfile::tempdir().unwrap();
    let catalog = Arc::new(open_catalog(dir.path()));
    add(&catalog, &[folder("线性代数")]);
    assert_eq!(matches(&catalog, &phrase("代数")), ["线性代数"]);

    let (started, wait_for_start) = mpsc::channel();
    let (finish, wait_for_finish) = mpsc::channel::<()>();
    let writer = thread::spawn({
        let catalog = Arc::clone(&catalog);
        move || {
            catalog.write(|tx| {
                upsert_entry(tx, &folder("数据结构"), 100)?;
                started.send(()).unwrap();
                wait_for_finish.recv().unwrap();
                Ok(())
            })
        }
    });
    wait_for_start.recv().unwrap();
    // The write holds its transaction open; a read still runs, and sees the last commit.
    assert_eq!(root_names(&catalog), ["线性代数"]);
    finish.send(()).unwrap();
    writer.join().unwrap().unwrap();
    assert_eq!(root_names(&catalog), ["数据结构", "线性代数"]);
}

#[test]
fn a_failed_or_panicking_write_changes_nothing() {
    let dir = tempfile::tempdir().unwrap();
    let catalog = open_catalog(dir.path());

    let failed = catalog.write(|tx| {
        upsert_entry(tx, &folder("a"), 100)?;
        Err::<(), _>(CatalogError::Invalid("stop".to_owned()))
    });
    assert!(failed.is_err());

    let panicked = catch_unwind(AssertUnwindSafe(|| {
        catalog.write(|tx| -> Result<(), CatalogError> {
            upsert_entry(tx, &folder("b"), 100)?;
            panic!("a bug in the middle of a write");
        })
    }));
    assert!(panicked.is_err());

    add(&catalog, &[folder("c")]);
    assert_eq!(root_names(&catalog), ["c"]);
}

#[test]
fn replaces_a_file_that_is_not_a_database() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("catalog.sqlite");
    fs::write(&file, "not a database").unwrap();

    let opened = Catalog::open(&file, &library_id()).unwrap();
    assert!(
        matches!(&opened.recovered, Some(Recovery::Unreadable(reason)) if reason.contains("not a database")),
        "{:?}",
        opened.recovered
    );
    assert_eq!(
        fs::read_to_string(dir.path().join("catalog.broken.sqlite")).unwrap(),
        "not a database"
    );
    add(&opened.catalog, &[folder("a")]);
    assert_eq!(root_names(&opened.catalog), ["a"]);
}

#[test]
fn replaces_a_newer_schema_and_another_librarys_catalog() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("catalog.sqlite");
    add(&open_catalog(dir.path()), &[folder("a")]);
    rusqlite::Connection::open(&file)
        .unwrap()
        .execute_batch("PRAGMA user_version = 99")
        .unwrap();

    let opened = Catalog::open(&file, &library_id()).unwrap();
    assert_eq!(opened.recovered, Some(Recovery::NewerSchema));
    assert!(root_names(&opened.catalog).is_empty());
    drop(opened);

    let other = LibraryId::parse(&"f".repeat(32)).unwrap();
    let opened = Catalog::open(&file, &other).unwrap();
    assert_eq!(
        opened.recovered,
        Some(Recovery::OtherLibrary(library_id().as_str().to_owned()))
    );
}

#[test]
fn replaces_a_catalog_whose_data_no_longer_validates() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("catalog.sqlite");
    add(&open_catalog(dir.path()), &[folder("a")]);
    // As if a newer rule rejected a stored path, while the path keys must be recomputed.
    let conn = rusqlite::Connection::open(&file).unwrap();
    conn.execute_batch(
        "UPDATE entries SET path = 'a/../b';
         UPDATE info SET value = '0' WHERE key = 'paths_version';",
    )
    .unwrap();
    drop(conn);

    let opened = Catalog::open(&file, &library_id()).unwrap();
    assert!(
        matches!(&opened.recovered, Some(Recovery::Unreadable(reason)) if reason.contains("not names")),
        "{:?}",
        opened.recovered
    );
    assert!(root_names(&opened.catalog).is_empty());
}

#[test]
fn moves_nothing_when_the_catalog_cannot_be_opened() {
    let dir = tempfile::tempdir().unwrap();
    fs::write(dir.path().join("blocker"), "a file, not a folder").unwrap();

    let error =
        Catalog::open(&dir.path().join("blocker/catalog.sqlite"), &library_id()).unwrap_err();
    assert!(matches!(error, CatalogError::Io { .. }), "{error}");
    assert!(dir.path().join("blocker").is_file());
}

#[test]
fn only_a_failing_environment_keeps_the_file() {
    let error = |code| rusqlite::Error::SqliteFailure(ffi::Error::new(code), None);
    for code in [
        ffi::SQLITE_NOTADB,
        ffi::SQLITE_CORRUPT,
        ffi::SQLITE_ERROR,
        ffi::SQLITE_SCHEMA,
        ffi::SQLITE_MISMATCH,
    ] {
        assert!(
            matches!(
                Failure::from(error(code)),
                Failure::Broken(Recovery::Unreadable(_))
            ),
            "{code}"
        );
    }
    for code in [
        ffi::SQLITE_BUSY,
        ffi::SQLITE_LOCKED,
        ffi::SQLITE_IOERR,
        ffi::SQLITE_FULL,
        ffi::SQLITE_CANTOPEN,
        ffi::SQLITE_PERM,
        ffi::SQLITE_READONLY,
        ffi::SQLITE_NOMEM,
        ffi::SQLITE_INTERRUPT,
        ffi::SQLITE_PROTOCOL,
    ] {
        assert!(
            matches!(Failure::from(error(code)), Failure::Error(_)),
            "{code}"
        );
    }
    let invalid = rusqlite::Error::InvalidColumnType(1, "path".to_owned(), Type::Null);
    assert!(matches!(Failure::from(invalid), Failure::Broken(_)));
    assert!(matches!(
        Failure::from(rusqlite_migration::Error::InvalidUserVersion),
        Failure::Broken(Recovery::Unreadable(_))
    ));
}

#[test]
fn replaces_a_catalog_with_an_invalid_schema_version() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("catalog.sqlite");
    add(&open_catalog(dir.path()), &[folder("a")]);
    rusqlite::Connection::open(&file)
        .unwrap()
        .execute_batch("PRAGMA user_version = -1")
        .unwrap();

    let opened = Catalog::open(&file, &library_id()).unwrap();
    assert!(
        matches!(opened.recovered, Some(Recovery::Unreadable(_))),
        "{:?}",
        opened.recovered
    );
    assert!(root_names(&opened.catalog).is_empty());
}

#[test]
fn refreshes_derived_data_written_by_older_code() {
    let dir = tempfile::tempdir().unwrap();
    let catalog = open_catalog(dir.path());
    add(&catalog, &[folder("Notes"), file("Notes/线性代数.md", 1)]);
    catalog
        .write(|tx| {
            tx.execute("UPDATE entries SET path_key = 'stale'", [])?;
            set_info(tx, TOKENIZER, "1")?;
            set_info(tx, PATHS, "0")?;
            Ok(())
        })
        .unwrap();
    drop(catalog);

    let catalog = open_catalog(dir.path());
    let (tokenizer, path_keys, key) = catalog
        .read(|tx| {
            Ok((
                info(tx, TOKENIZER)?,
                info(tx, PATHS)?,
                tx.query_row(
                    "SELECT path_key FROM entries WHERE path = 'Notes/线性代数.md'",
                    [],
                    |row| row.get::<_, String>(0),
                )?,
            ))
        })
        .unwrap();
    assert_eq!(tokenizer, Some(TOKENIZER_VERSION.to_string()));
    assert_eq!(path_keys, Some(PATHS_VERSION.to_string()));
    assert_eq!(key, path("Notes/线性代数.md").key().as_str());
    assert_eq!(matches(&catalog, &phrase("代数")), ["线性代数.md"]);
}

#[test]
fn inserts_entries_below_their_folders() {
    let dir = tempfile::tempdir().unwrap();
    let catalog = open_catalog(dir.path());
    let hash = ContentHash::parse(&format!("b3:{}", "ab".repeat(32))).unwrap();
    let homework = EntryRecord {
        file_id: Some("0011".to_owned()),
        hash: Some(hash),
        ..file("2026 秋/线性代数/HW1.pdf", 2048)
    };
    add(
        &catalog,
        &[
            folder("2026 秋"),
            folder("2026 秋/线性代数"),
            homework.clone(),
        ],
    );

    let stored = catalog
        .read(|tx| entry(tx, &homework.path))
        .unwrap()
        .unwrap();
    assert_eq!((&stored.record, stored.added_ns), (&homework, 100));
    let key: String = catalog
        .read(|tx| {
            Ok(tx.query_row(
                "SELECT path_key FROM entries WHERE id = ?1",
                [stored.id.0],
                |row| row.get(0),
            )?)
        })
        .unwrap();
    assert_eq!(key, "2026 秋/线性代数/HW1.PDF");

    for orphan in ["x/y.pdf", "2026 秋/线性代数/HW1.pdf/z"] {
        let error = catalog
            .write(|tx| upsert_entry(tx, &file(orphan, 1), 100))
            .unwrap_err();
        assert!(matches!(error, CatalogError::MissingParent(_)), "{error}");
    }
}

#[test]
fn updates_keep_the_id_and_the_time_it_was_added() {
    let dir = tempfile::tempdir().unwrap();
    let catalog = open_catalog(dir.path());
    let [id] = add(&catalog, &[file("a.md", 10)])[..] else {
        unreachable!()
    };
    let updated = catalog
        .write(|tx| upsert_entry(tx, &file("a.md", 20), 999))
        .unwrap();
    let stored = catalog
        .read(|tx| entry(tx, &path("a.md")))
        .unwrap()
        .unwrap();
    assert_eq!(
        (updated, stored.id, stored.record.size, stored.added_ns),
        (id, id, 20, 100)
    );
    assert_eq!(count(&catalog, "search"), 1);
}

#[test]
fn a_folder_that_becomes_a_file_loses_its_descendants() {
    let dir = tempfile::tempdir().unwrap();
    let catalog = open_catalog(dir.path());
    add(&catalog, &[folder("a"), folder("a/b"), file("a/b/c.md", 1)]);
    add(&catalog, &[file("a", 5)]);
    assert!(
        catalog
            .read(|tx| entry(tx, &path("a/b/c.md")))
            .unwrap()
            .is_none()
    );
    assert_eq!(
        (count(&catalog, "entries"), count(&catalog, "search")),
        (1, 1)
    );
}

#[test]
fn deleting_an_entry_removes_its_subtree_with_search_rows_and_tags() {
    let dir = tempfile::tempdir().unwrap();
    let catalog = open_catalog(dir.path());
    let ids = add(
        &catalog,
        &[
            folder("s"),
            folder("s/c"),
            file("s/c/x.md", 1),
            folder("s/c/d"),
            file("s/c/d/y.md", 1),
            // Siblings whose names sort right before and after `c/`.
            file("s/c-notes.md", 1),
            file("s/c0.md", 1),
        ],
    );
    catalog
        .write(|tx| set_entry_tags(tx, ids[2], &BTreeSet::from([PresetTag::Notes.id()])))
        .unwrap();

    // Nothing cascades, so SQLite's change count is exact.
    let removed = catalog.write(|tx| delete_entry(tx, &path("s/c"))).unwrap();
    assert_eq!(removed, 4);
    assert_eq!(
        names(catalog.read(|tx| children(tx, Some(&path("s")))).unwrap()),
        ["c-notes.md", "c0.md"]
    );
    assert_eq!(count(&catalog, "search"), 3);
    assert_eq!(count(&catalog, "entry_tags"), 0);
}

#[test]
fn every_delete_removes_search_rows_and_none_orphans_children() {
    let dir = tempfile::tempdir().unwrap();
    let catalog = open_catalog(dir.path());
    add(&catalog, &[folder("a"), file("a/b.md", 1), file("c.md", 1)]);

    // A delete that bypasses the repositories still takes the search row with it.
    catalog
        .write(|tx| Ok(tx.execute("DELETE FROM entries WHERE path = 'c.md'", [])?))
        .unwrap();
    assert_eq!(count(&catalog, "search"), 2);

    // Deleting a folder without its children fails instead of leaving them behind.
    let error = catalog
        .write(|tx| Ok(tx.execute("DELETE FROM entries WHERE path = 'a'", [])?))
        .unwrap_err();
    assert!(error.to_string().contains("FOREIGN KEY"), "{error}");
    assert_eq!(
        (count(&catalog, "entries"), count(&catalog, "search")),
        (2, 2)
    );
}

#[test]
fn lists_the_children_of_a_folder_by_name() {
    let dir = tempfile::tempdir().unwrap();
    let catalog = open_catalog(dir.path());
    add(
        &catalog,
        &[
            folder("b"),
            folder("a"),
            file("a/2.md", 1),
            file("a/1.md", 1),
        ],
    );
    assert_eq!(root_names(&catalog), ["a", "b"]);
    assert_eq!(
        names(catalog.read(|tx| children(tx, Some(&path("a")))).unwrap()),
        ["1.md", "2.md"]
    );
    let error = catalog
        .read(|tx| children(tx, Some(&path("missing"))))
        .unwrap_err();
    assert!(matches!(error, CatalogError::MissingParent(_)), "{error}");
}

#[test]
fn finds_entries_by_the_names_of_their_tags() {
    let dir = tempfile::tempdir().unwrap();
    let catalog = open_catalog(dir.path());
    catalog
        .write(|tx| replace_tag_definitions(tx, &presets("课件")))
        .unwrap();
    let ids = add(
        &catalog,
        &[file("lecture 1.pdf", 1), file("lecture 2.pdf", 1)],
    );
    let slides = BTreeSet::from([PresetTag::Slides.id(), PresetTag::Exam.id()]);
    catalog
        .write(|tx| set_entry_tags(tx, ids[0], &slides))
        .unwrap();

    let by_tag = |name: &str| matches(&catalog, &format!("tags : {}", phrase(name)));
    assert_eq!(by_tag("课件"), ["lecture 1.pdf"]);
    assert_eq!(catalog.read(|tx| entry_tags(tx, ids[0])).unwrap(), slides);
    assert_eq!(
        catalog.read(|tx| tag_definitions(tx)).unwrap(),
        presets("课件")
    );

    // Renaming a tag renames it in the search text.
    catalog
        .write(|tx| replace_tag_definitions(tx, &presets("讲义")))
        .unwrap();
    assert_eq!(by_tag("讲义"), ["lecture 1.pdf"]);
    assert!(by_tag("课件").is_empty());

    // An assignment to a tag that is no longer defined stays, without a name to find.
    let mut without_slides = presets("讲义");
    without_slides.tags.remove(&PresetTag::Slides.id());
    catalog
        .write(|tx| replace_tag_definitions(tx, &without_slides))
        .unwrap();
    assert!(by_tag("讲义").is_empty());
    assert_eq!(by_tag("考试"), ["lecture 1.pdf"]);
    assert_eq!(catalog.read(|tx| entry_tags(tx, ids[0])).unwrap(), slides);

    let unknown = BTreeSet::from([TagId::parse("t-unknown").unwrap()]);
    catalog
        .write(|tx| set_entry_tags(tx, ids[1], &unknown))
        .unwrap();
    assert_eq!(catalog.read(|tx| entry_tags(tx, ids[1])).unwrap(), unknown);
}

#[test]
fn mirrors_semester_and_course_settings() {
    let dir = tempfile::tempdir().unwrap();
    let catalog = open_catalog(dir.path());
    let group = |order| GroupSettings {
        archived: false,
        order,
    };
    let course = |abbr: &str, order| CourseSettings {
        abbr: Abbr::parse(abbr).unwrap(),
        archived: false,
        color: Color::parse("blue").unwrap(),
        order,
    };
    catalog
        .write(|tx| {
            put_semester(tx, &semester("2026 秋"), &group(2))?;
            put_semester(tx, &semester("2026 春"), &group(1))?;
            put_course(tx, &course_at("2026 秋/线性代数"), &course("线代", 1))?;
            put_course(tx, &course_at("2026 秋/数据结构"), &course("数结", 0))?;
            put_course(tx, &course_at("2026 春/微积分"), &course("微", 0))?;
            put_course(tx, &course_at("2026 秋/线性代数"), &course("LA", 5))
        })
        .unwrap();

    let semester_names = |catalog: &Catalog| -> Vec<String> {
        catalog
            .read(|tx| semesters(tx))
            .unwrap()
            .into_iter()
            .map(|(semester, _)| semester.name().to_owned())
            .collect()
    };
    assert_eq!(semester_names(&catalog), ["2026 春", "2026 秋"]);
    assert_eq!(
        catalog
            .read(|tx| courses(tx, &semester("2026 秋")))
            .unwrap(),
        [
            (course_at("2026 秋/数据结构"), course("数结", 0)),
            (course_at("2026 秋/线性代数"), course("LA", 5)),
        ]
    );

    // A semester's settings and its courses' settings come from different files.
    catalog
        .write(|tx| {
            remove_semester(tx, &semester("2026 秋"))?;
            remove_course(tx, &course_at("2026 秋/数据结构"))
        })
        .unwrap();
    assert_eq!(semester_names(&catalog), ["2026 春"]);
    let all: Vec<_> = catalog
        .read(|tx| all_courses(tx))
        .unwrap()
        .into_iter()
        .map(|(course, _)| course.path().to_string())
        .collect();
    assert_eq!(all, ["2026 春/微积分", "2026 秋/线性代数"]);
}

fn query(text: &str) -> SearchQuery {
    SearchQuery::parse(text).unwrap().unwrap()
}

/// Seconds since the Unix epoch, some time after the files in these tests were modified.
const NOW: i64 = 1_800_000_000;

/// Paths of the best matches, best first.
fn found(catalog: &Catalog, text: &str, limit: u32) -> Vec<String> {
    catalog
        .read(|tx| search(tx, &query(text), limit, NOW))
        .unwrap()
        .into_iter()
        .map(|hit| hit.entry.record.path.to_string())
        .collect()
}

#[test]
fn ranks_names_above_tags_above_folders_above_text() {
    let dir = tempfile::tempdir().unwrap();
    let catalog = open_catalog(dir.path());
    let algebra = TagId::parse("algebra").unwrap();
    let definitions = TagDefinitions {
        tags: [(
            algebra.clone(),
            TagDefinition {
                color: Color::parse("blue").unwrap(),
                name: DisplayName::parse("代数").unwrap(),
                order: 1,
            },
        )]
        .into(),
    };
    catalog
        .write(|tx| replace_tag_definitions(tx, &definitions))
        .unwrap();
    let ids = add(
        &catalog,
        &[
            folder("代数"),
            file("代数/习题.md", 1),
            file("代数笔记.md", 1),
            file("讲义.pdf", 1),
            file("随笔.md", 1),
            file("无关.md", 1),
        ],
    );
    catalog
        .write(|tx| {
            set_entry_tags(tx, ids[3], &BTreeSet::from([algebra.clone()]))?;
            set_body(tx, ids[4], Some("今天复习了线性代数的特征值"))
        })
        .unwrap();

    assert_eq!(
        found(&catalog, "代数", 10),
        ["代数", "代数笔记.md", "讲义.pdf", "代数/习题.md", "随笔.md"]
    );
    assert_eq!(found(&catalog, "代数", 2), ["代数", "代数笔记.md"]);
}

#[test]
fn recent_changes_rank_first_among_equal_matches() {
    let dir = tempfile::tempdir().unwrap();
    let catalog = open_catalog(dir.path());
    let modified = |text: &str, days_ago: i64| EntryRecord {
        mtime_ns: Some((NOW - days_ago * 86_400) * 1_000_000_000),
        ..file(text, 1)
    };
    add(
        &catalog,
        &[
            folder("a"),
            folder("b"),
            folder("c"),
            modified("a/lecture.md", 365),
            modified("b/lecture.md", 1),
            modified("c/lecture.md", 365),
        ],
    );
    assert_eq!(
        found(&catalog, "lecture", 10),
        ["b/lecture.md", "a/lecture.md", "c/lecture.md"]
    );
    assert_eq!(found(&catalog, "lect", 1), ["b/lecture.md"]);
}

#[test]
fn marks_matches_in_the_name_and_a_body_snippet() {
    let dir = tempfile::tempdir().unwrap();
    let catalog = open_catalog(dir.path());
    let ids = add(
        &catalog,
        &[
            file("线性代数 期中复习.md", 1),
            file("代数.pdf", 1),
            file("other.md", 1),
        ],
    );
    catalog
        .write(|tx| set_body(tx, ids[0], Some("第一章 线性代数的基本概念")))
        .unwrap();
    let span = |text: &str, matched| Span {
        text: text.to_owned(),
        matched,
    };

    let text = catalog
        .read(|tx| hit_text(tx, &query("代数"), ids[0]))
        .unwrap()
        .unwrap();
    assert_eq!(
        text.name,
        [
            span("线性", false),
            span("代数", true),
            span(" 期中复习.md", false)
        ]
    );
    assert_eq!(
        text.snippet.unwrap(),
        [
            span("第一章 线性", false),
            span("代数", true),
            span("的基本概念", false)
        ]
    );

    let without_body = catalog
        .read(|tx| hit_text(tx, &query("代数"), ids[1]))
        .unwrap()
        .unwrap();
    assert_eq!(
        (without_body.name, without_body.snippet),
        (vec![span("代数", true), span(".pdf", false)], None)
    );
    assert_eq!(
        catalog
            .read(|tx| hit_text(tx, &query("代数"), ids[2]))
            .unwrap(),
        None
    );
}

#[test]
fn stores_clean_body_text_up_to_the_limit() {
    let dir = tempfile::tempdir().unwrap();
    let catalog = open_catalog(dir.path());
    let [id] = add(&catalog, &[file("a.md", 1)])[..] else {
        unreachable!()
    };
    let body = |catalog: &Catalog| -> Option<String> {
        catalog
            .read(|tx| {
                Ok(
                    tx.query_row("SELECT body FROM search WHERE rowid = ?1", [id.0], |row| {
                        row.get(0)
                    })?,
                )
            })
            .unwrap()
    };

    // A three-byte character that would cross the limit is left out whole.
    let long = format!("{}代", "a".repeat(MAX_BODY_BYTES - 1));
    catalog.write(|tx| set_body(tx, id, Some(&long))).unwrap();
    assert_eq!(body(&catalog).unwrap().len(), MAX_BODY_BYTES - 1);

    catalog
        .write(|tx| set_body(tx, id, Some("x\0y\u{1}z\u{2}")))
        .unwrap();
    assert_eq!(body(&catalog).as_deref(), Some("xyz"));
    catalog.write(|tx| set_body(tx, id, None)).unwrap();
    assert_eq!(body(&catalog), None);

    for error in [
        catalog.write(|tx| set_body(tx, EntryId(999), Some("x"))),
        catalog.write(|tx| set_entry_tags(tx, EntryId(999), &BTreeSet::new())),
        catalog
            .write(|tx| set_entry_tags(tx, EntryId(999), &BTreeSet::from([PresetTag::Notes.id()]))),
    ] {
        assert!(
            matches!(error, Err(CatalogError::NoEntry(EntryId(999)))),
            "{error:?}"
        );
    }
}
