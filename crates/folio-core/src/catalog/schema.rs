//! The catalog's schema (docs/specs/library-core.md §5.2).
//!
//! Every schema change is a new migration with a preservation test through the normal catalog
//! open path (ADR-0002 §4).

use rusqlite_migration::{M, Migrations};

/// The `search` table needs the `folio_cjk` tokenizer registered before it is created or used.
const V1: &str = "
CREATE TABLE info (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
) STRICT, WITHOUT ROWID;

CREATE TABLE semesters (
    path TEXT PRIMARY KEY,
    sort_order INTEGER NOT NULL,
    archived INTEGER NOT NULL CHECK (archived IN (0, 1))
) STRICT, WITHOUT ROWID;

CREATE TABLE courses (
    path TEXT PRIMARY KEY,
    abbr TEXT NOT NULL,
    color TEXT NOT NULL,
    sort_order INTEGER NOT NULL,
    archived INTEGER NOT NULL CHECK (archived IN (0, 1))
) STRICT, WITHOUT ROWID;

CREATE TABLE entries (
    id INTEGER PRIMARY KEY,
    path TEXT NOT NULL UNIQUE,
    path_key TEXT NOT NULL,
    -- No cascade: deleting a folder deletes its subtree by path range (BELOW), and a delete that
    -- would leave children behind fails instead.
    parent_id INTEGER REFERENCES entries (id),
    name TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('file', 'folder')),
    class TEXT NOT NULL CHECK (class IN ('text', 'word', 'other')),
    size INTEGER NOT NULL CHECK (size >= 0),
    mtime_ns INTEGER,
    file_id TEXT,
    hash TEXT,
    -- When a scan first saw the entry; a rebuild takes the file's creation time instead.
    added_ns INTEGER NOT NULL
) STRICT;
CREATE INDEX entries_by_path_key ON entries (path_key);
CREATE INDEX entries_by_parent ON entries (parent_id, name);
CREATE INDEX entries_by_added ON entries (added_ns);
CREATE INDEX entries_by_file_id ON entries (file_id) WHERE file_id IS NOT NULL;
-- The files the hashing pass still has to read; queries repeat the condition (entries::UNHASHED).
CREATE INDEX entries_unhashed ON entries (id) WHERE hash IS NULL AND kind = 'file';

CREATE TABLE tags (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    color TEXT NOT NULL,
    sort_order INTEGER NOT NULL
) STRICT, WITHOUT ROWID;

-- No foreign key to tags: an assignment may name a tag that tags.json does not define (yet).
CREATE TABLE entry_tags (
    entry_id INTEGER NOT NULL REFERENCES entries (id) ON DELETE CASCADE,
    tag_id TEXT NOT NULL,
    PRIMARY KEY (entry_id, tag_id)
) STRICT, WITHOUT ROWID;
CREATE INDEX entry_tags_by_tag ON entry_tags (tag_id, entry_id);

-- rowid = entries.id; path is the parent folder; tags are tag names.
CREATE VIRTUAL TABLE search USING fts5 (
    name, path, tags, body,
    tokenize = 'folio_cjk', detail = full, prefix = '3'
);

-- Every way an entry goes also removes its search row; FTS5 has no foreign keys.
CREATE TRIGGER entries_delete_search AFTER DELETE ON entries BEGIN
    DELETE FROM search WHERE rowid = old.id;
END;
";

/// Optional course information (ipc-m1.md §20.1), preserving every v1 row.
const V2: &str = "
CREATE TABLE courses_v2 (
    path TEXT PRIMARY KEY,
    abbr TEXT,
    code TEXT,
    color TEXT,
    sort_order INTEGER NOT NULL,
    archived INTEGER NOT NULL CHECK (archived IN (0, 1))
) STRICT, WITHOUT ROWID;
INSERT INTO courses_v2 (path, abbr, color, sort_order, archived)
    SELECT path, abbr, color, sort_order, archived FROM courses;
DROP TABLE courses;
ALTER TABLE courses_v2 RENAME TO courses;
";

/// The local history's packs and where each object is (versioning.md §4.3, §13.1), from the packs'
/// indexes. The smallest pack has 150 bytes and one object, and records start after the pack's
/// 12-byte header (remote-format.md §9).
const V3: &str = "
-- name: the pack's 64 lower-case hexadecimal digits, its file name without `.pack`.
CREATE TABLE packs (
    name TEXT PRIMARY KEY,
    size INTEGER NOT NULL CHECK (size >= 150),
    objects INTEGER NOT NULL CHECK (objects >= 1)
) STRICT, WITHOUT ROWID;

-- id: `b3:` and 64 lower-case hexadecimal digits, like `entries.hash`. One location per object:
-- an object two packs hold is found in the pack indexed first.
CREATE TABLE objects (
    id TEXT PRIMARY KEY,
    pack TEXT NOT NULL REFERENCES packs (name) ON DELETE CASCADE,
    offset INTEGER NOT NULL CHECK (offset >= 12)
) STRICT, WITHOUT ROWID;
CREATE INDEX objects_by_pack ON objects (pack);
";

/// What extracting the text of each text and Word file gave (versioning.md §10.2–§10.3), so that a
/// file is extracted again only when its content, its class or the extractor changes. The text
/// itself is the `search` row's `body`.
const V4: &str = "
-- The entries the extractor reads, so finding what it has to do reads only them, in this index
-- alone; queries repeat the condition (extracts::EXTRACTABLE).
CREATE INDEX entries_extractable ON entries (id, hash, class, kind)
    WHERE kind = 'file' AND class IN ('text', 'word') AND hash IS NOT NULL;
-- hash, class: the entry's when it was extracted; version: the extractor's (extract::VERSION).
-- failure and detail (for logs, at most 500 characters) on failed rows only.
CREATE TABLE extracts (
    entry_id INTEGER PRIMARY KEY REFERENCES entries (id) ON DELETE CASCADE,
    hash TEXT NOT NULL,
    class TEXT NOT NULL CHECK (class IN ('text', 'word')),
    version INTEGER NOT NULL CHECK (version >= 0),
    status TEXT NOT NULL CHECK (status IN ('text', 'empty', 'binary', 'skipped', 'failed')),
    failure TEXT CHECK (failure IN ('invalid', 'too_large')),
    detail TEXT,
    CHECK ((status = 'failed') = (failure IS NOT NULL)),
    CHECK ((status = 'failed') = (detail IS NOT NULL))
) STRICT;
-- A file that stops being a text or Word file (another extension, other versioning rules, a folder
-- in its place) loses its row and its search body with that change. One waiting for its new hash
-- keeps both until it is extracted again.
CREATE TRIGGER entries_not_extractable AFTER UPDATE OF kind, class ON entries
WHEN old.kind = 'file' AND old.class IN ('text', 'word')
    AND NOT (new.kind = 'file' AND new.class IN ('text', 'word'))
BEGIN
    DELETE FROM extracts WHERE entry_id = new.id;
    UPDATE search SET body = NULL WHERE rowid = new.id;
END;
-- The files whose text could not be read; queries repeat the condition (extracts::FAILED).
CREATE INDEX extracts_failed ON extracts (entry_id) WHERE status = 'failed';
";

const STEPS: &[M<'static>] = &[M::up(V1), M::up(V2), M::up(V3), M::up(V4)];

pub(super) const MIGRATIONS: Migrations<'static> = Migrations::from_slice(STEPS);

#[cfg(test)]
mod tests {
    use std::path::Path;

    use rusqlite::{Connection, params, types::Value};

    use super::*;
    use crate::catalog::{Catalog, all_courses};
    use crate::hash::ContentHash;
    use crate::meta::{Abbr, Color, CourseSettings};
    use crate::paths::PATHS_VERSION;
    use crate::search::TOKENIZER_VERSION;
    use crate::test_support::{course_at, library_id};

    /// The schema version the migrations end at.
    const LATEST: u32 = 4;

    fn rows(conn: &Connection, table: &str) -> Vec<Vec<Value>> {
        let mut statement = conn
            .prepare(&format!("SELECT * FROM {table} ORDER BY 1, 2"))
            .unwrap();
        let columns = statement.column_count();
        statement
            .query_map([], |row| {
                (0..columns).map(|column| row.get(column)).collect()
            })
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap()
    }

    fn user_version(conn: &Connection) -> rusqlite::Result<u32> {
        conn.query_row("PRAGMA user_version", [], |row| row.get(0))
    }

    /// A catalog of schema version 1 at `file` with rows in every table, as the first builds left
    /// one.
    fn populated_v1(file: &Path) -> Connection {
        let conn = Connection::open(file).unwrap();
        super::super::configure(&conn).unwrap();
        conn.execute_batch(V1).unwrap();
        conn.pragma_update(None, "user_version", 1).unwrap();
        conn.execute(
            "INSERT INTO info (key, value) VALUES
             ('library_id', ?1), ('tokenizer_version', ?2), ('paths_version', ?3),
             ('first_scan_ns', '100'), ('entry_id_high_water', '19'), ('scan_journal', '42')",
            params![
                library_id().as_str(),
                TOKENIZER_VERSION.to_string(),
                PATHS_VERSION.to_string()
            ],
        )
        .unwrap();
        conn.execute_batch(
            "INSERT INTO semesters VALUES ('s', 3, 1);
             INSERT INTO courses VALUES ('s/c', 'LA', 'gray', 7, 1);
             INSERT INTO entries
                 (id, path, path_key, parent_id, name, kind, class, size, mtime_ns,
                  file_id, hash, added_ns)
             VALUES
                 (5, 's', 's', NULL, 's', 'folder', 'other', 0, NULL, '1-5', NULL, 100),
                 (7, 's/c', 's/c', 5, 'c', 'folder', 'other', 0, NULL, '1-7', NULL, 101),
                 (11, 's/c/a.md', 's/c/a.md', 7, 'a.md', 'file', 'text', 23, 12345,
                  '1-11', NULL, 102);
             INSERT INTO tags VALUES ('reference', 'Reference', 'gray', 5);
             INSERT INTO entry_tags VALUES (11, 'reference');
             INSERT INTO search (rowid, name, path, tags, body) VALUES
                 (5, 's', '', '', ''), (7, 'c', 's', '', ''),
                 (11, 'a.md', 's/c', 'Reference', 'migration fixture body');",
        )
        .unwrap();
        conn.execute(
            "UPDATE entries SET hash = ?1 WHERE id = 11",
            [ContentHash::of(b"old file content")],
        )
        .unwrap();
        conn
    }

    #[test]
    fn opening_and_reopening_a_populated_v1_catalog_preserves_its_data() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("catalog.sqlite");
        let conn = populated_v1(&file);
        let tables = [
            "info",
            "semesters",
            "entries",
            "tags",
            "entry_tags",
            "search",
        ];
        let before = tables.map(|table| rows(&conn, table));
        drop(conn);

        let expected = vec![(
            course_at("s/c"),
            CourseSettings {
                abbr: Some(Abbr::parse("LA").unwrap()),
                archived: true,
                code: None,
                color: Some(Color::parse("gray").unwrap()),
                order: 7,
            },
        )];
        for _ in 0..2 {
            let opened = Catalog::open(&file, &library_id()).unwrap();
            assert_eq!(opened.recovered, None);
            assert!(!dir.path().join("catalog.broken.sqlite").exists());
            assert_eq!(opened.catalog.read(|tx| all_courses(tx)).unwrap(), expected);
            opened
                .catalog
                .read(|tx| {
                    assert_eq!(user_version(tx)?, LATEST);
                    assert_eq!(tables.map(|table| rows(tx, table)), before);
                    assert_eq!(
                        tx.query_row(
                            "SELECT rowid FROM search WHERE search MATCH 'fixture'",
                            [],
                            |row| row.get::<_, i64>(0),
                        )?,
                        11
                    );
                    Ok(())
                })
                .unwrap();
        }
    }

    /// Migration 3 (versioning.md §13.1) keeps every row of a version-2 catalog, as v0.1 left them,
    /// and adds the history tables empty, for the history to fill.
    #[test]
    fn opening_a_populated_v2_catalog_keeps_its_rows_and_adds_empty_history_tables() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("catalog.sqlite");
        let mut conn = populated_v1(&file);
        MIGRATIONS.to_version(&mut conn, 2).unwrap();
        // What only version 2 holds: a course code, and a course without abbreviation or colour.
        conn.execute_batch(
            "UPDATE courses SET code = 'MAT 223' WHERE path = 's/c';
             INSERT INTO courses (path, abbr, code, color, sort_order, archived)
                 VALUES ('s/d', NULL, NULL, NULL, 8, 0);",
        )
        .unwrap();
        assert_eq!(user_version(&conn).unwrap(), 2);
        let tables = [
            "info",
            "semesters",
            "courses",
            "entries",
            "tags",
            "entry_tags",
            "search",
        ];
        let before = tables.map(|table| rows(&conn, table));
        drop(conn);

        for _ in 0..2 {
            let opened = Catalog::open(&file, &library_id()).unwrap();
            assert_eq!(opened.recovered, None);
            opened
                .catalog
                .read(|tx| {
                    assert_eq!(user_version(tx)?, LATEST);
                    assert_eq!(tables.map(|table| rows(tx, table)), before);
                    for table in ["packs", "objects"] {
                        assert!(rows(tx, table).is_empty(), "{table}");
                    }
                    Ok(())
                })
                .unwrap();
        }

        // Strict tables without rowids, and an object's pack a cascading reference with an index.
        let conn = Connection::open(&file).unwrap();
        super::super::configure(&conn).unwrap();
        for table in ["packs", "objects"] {
            let (strict, without_rowid): (bool, bool) = conn
                .query_row(
                    "SELECT strict, wr FROM pragma_table_list WHERE name = ?1",
                    [table],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .unwrap();
            assert!(strict && without_rowid, "{table}");
        }
        let reference: [String; 4] = conn
            .query_row(
                "SELECT \"table\", \"from\", \"to\", on_delete FROM pragma_foreign_key_list('objects')",
                [],
                |row| Ok([row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?]),
            )
            .unwrap();
        assert_eq!(reference, ["packs", "pack", "name", "CASCADE"]);
        let indexed: Vec<String> = conn
            .prepare(
                "SELECT info.name FROM pragma_index_list('objects') AS list,
                     pragma_index_info(list.name) AS info
                 WHERE list.origin = 'c'",
            )
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert_eq!(indexed, ["pack"]);
    }

    /// Migration 4 (versioning.md §10.2–§10.3) keeps every row of a version-3 catalog and adds
    /// `extracts` empty, so the next hash job extracts every text and Word file.
    #[test]
    fn opening_a_populated_v3_catalog_keeps_its_rows_and_adds_an_empty_extracts_table() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("catalog.sqlite");
        let mut conn = populated_v1(&file);
        MIGRATIONS.to_version(&mut conn, 3).unwrap();
        // What only version 3 holds: a pack and the location of an object in it.
        let pack = "ab".repeat(32);
        conn.execute("INSERT INTO packs VALUES (?1, 150, 1)", [&pack])
            .unwrap();
        conn.execute(
            "INSERT INTO objects VALUES (?1, ?2, 12)",
            [format!("b3:{}", "cd".repeat(32)), pack],
        )
        .unwrap();
        assert_eq!(user_version(&conn).unwrap(), 3);
        let tables = [
            "info",
            "semesters",
            "courses",
            "entries",
            "tags",
            "entry_tags",
            "search",
            "packs",
            "objects",
        ];
        let before = tables.map(|table| rows(&conn, table));
        drop(conn);

        for _ in 0..2 {
            let opened = Catalog::open(&file, &library_id()).unwrap();
            assert_eq!(opened.recovered, None);
            assert!(!dir.path().join("catalog.broken.sqlite").exists());
            opened
                .catalog
                .read(|tx| {
                    assert_eq!(user_version(tx)?, LATEST);
                    assert_eq!(tables.map(|table| rows(tx, table)), before);
                    assert!(rows(tx, "extracts").is_empty());
                    Ok(())
                })
                .unwrap();
        }

        // A strict table whose rows go with their entry, and an index of the failed rows only.
        let conn = Connection::open(&file).unwrap();
        super::super::configure(&conn).unwrap();
        let (strict, without_rowid): (bool, bool) = conn
            .query_row(
                "SELECT strict, wr FROM pragma_table_list WHERE name = 'extracts'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert!(strict && !without_rowid);
        let reference: [String; 4] = conn
            .query_row(
                "SELECT \"table\", \"from\", \"to\", on_delete FROM pragma_foreign_key_list('extracts')",
                [],
                |row| Ok([row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?]),
            )
            .unwrap();
        assert_eq!(reference, ["entries", "entry_id", "id", "CASCADE"]);
        let index: (String, bool) = conn
            .query_row(
                "SELECT name, partial FROM pragma_index_list('extracts') WHERE origin = 'c'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(index, ("extracts_failed".to_owned(), true));
    }

    /// `Migrations::validate()` on a connection that has the tokenizer: `validate()` itself opens
    /// one without it, where `CREATE VIRTUAL TABLE search` fails.
    #[test]
    fn migrations_apply_to_an_empty_database() {
        let mut conn = rusqlite::Connection::open_in_memory().unwrap();
        crate::search::register_tokenizer(&conn).unwrap();
        MIGRATIONS.to_latest(&mut conn).unwrap();
        assert_eq!(user_version(&conn).unwrap(), LATEST);
    }
}
