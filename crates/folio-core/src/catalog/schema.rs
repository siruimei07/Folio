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

const STEPS: &[M<'static>] = &[M::up(V1), M::up(V2)];

pub(super) const MIGRATIONS: Migrations<'static> = Migrations::from_slice(STEPS);

#[cfg(test)]
mod tests {
    use rusqlite::{Connection, params, types::Value};

    use super::*;
    use crate::catalog::{Catalog, all_courses};
    use crate::hash::ContentHash;
    use crate::meta::{Abbr, Color, CourseSettings};
    use crate::paths::PATHS_VERSION;
    use crate::search::TOKENIZER_VERSION;
    use crate::test_support::{course_at, library_id};

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

    #[test]
    fn opening_and_reopening_a_populated_v1_catalog_preserves_its_data() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("catalog.sqlite");
        let conn = Connection::open(&file).unwrap();
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
                    let version: u32 = tx.query_row("PRAGMA user_version", [], |row| row.get(0))?;
                    assert_eq!(version, 2);
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

    /// `Migrations::validate()` on a connection that has the tokenizer: `validate()` itself opens
    /// one without it, where `CREATE VIRTUAL TABLE search` fails.
    #[test]
    fn migrations_apply_to_an_empty_database() {
        let mut conn = rusqlite::Connection::open_in_memory().unwrap();
        crate::search::register_tokenizer(&conn).unwrap();
        MIGRATIONS.to_latest(&mut conn).unwrap();
        let version: u32 = conn
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .unwrap();
        assert_eq!(version, 2);
    }
}
