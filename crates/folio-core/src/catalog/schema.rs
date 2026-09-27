//! The catalog's schema (docs/specs/library-core.md §5.2).
//!
//! Until the first release, migration 1 may still change in place. After that, every change is
//! a new migration with a fixture test that opens a database of each released version
//! (ADR-0002 §4).

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
    first_seen_at INTEGER NOT NULL
) STRICT;
CREATE INDEX entries_by_path_key ON entries (path_key);
CREATE INDEX entries_by_parent ON entries (parent_id, name);
CREATE INDEX entries_by_first_seen ON entries (first_seen_at);
CREATE INDEX entries_by_file_id ON entries (file_id) WHERE file_id IS NOT NULL;

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

const STEPS: &[M<'static>] = &[M::up(V1)];

pub(super) const MIGRATIONS: Migrations<'static> = Migrations::from_slice(STEPS);

#[cfg(test)]
mod tests {
    use super::*;

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
        assert_eq!(version, 1);
    }
}
