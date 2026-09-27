//! The catalog: a local SQLite database derived from the library and its `.folio/` files. It can
//! be deleted and rebuilt at any time (ADR-0002 §4, docs/specs/library-core.md §5).
//!
//! [`Catalog::write`] and [`Catalog::read`] run a closure in a transaction; the repository
//! functions of this module take the `&Connection` the transaction derefs to. Functions that
//! change data must run inside `write`: `read` connections are read-only.

mod entries;
mod fulltext;
mod groups;
mod schema;
mod sql;
mod tags;

use std::ffi::OsString;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard, PoisonError};

use rusqlite::{
    Connection, ErrorCode, OpenFlags, OptionalExtension, Transaction, TransactionBehavior,
};

pub use entries::{Entry, EntryId, EntryRecord, children, delete_entry, entry, upsert_entry};
pub use fulltext::{Hit, HitText, MAX_BODY_BYTES, Span, hit_text, search, set_body};
pub use groups::{courses, put_course, put_semester, remove_course, remove_semester, semesters};
pub use tags::{entry_tags, replace_tag_definitions, set_entry_tags, tag_definitions};

use crate::meta::LibraryId;
use crate::paths::{PATHS_VERSION, RelPath};
use crate::search::{TOKENIZER_VERSION, register_tokenizer};

/// Idle read-only connections kept for the next reads.
const MAX_IDLE_READERS: usize = 4;

/// Selects the paths below the folder in `?1`. They sort between `?1/` and `?10`, because `0`
/// follows `/`, so the condition is a range scan on the `path` index.
const BELOW: &str = "path > (?1 || '/') AND path < (?1 || '0')";

#[derive(Debug, thiserror::Error)]
pub enum CatalogError {
    #[error("catalog query failed: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("catalog schema update failed: {0}")]
    Migration(#[from] rusqlite_migration::Error),
    #[error("could not access {}: {source}", path.display())]
    Io {
        path: PathBuf,
        #[source]
        source: io::Error,
    },
    /// The catalog cannot be set up.
    #[error("the catalog is not usable: {0}")]
    Invalid(String),
    #[error("there is no folder `{0}` in the catalog")]
    MissingParent(RelPath),
    #[error("there is no entry {0} in the catalog")]
    NoEntry(EntryId),
}

/// Why [`Catalog::open`] replaced the database. The caller must then rebuild the catalog from the
/// library and its `.folio/` files.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Recovery {
    /// The database cannot be used: it is not a database, it is corrupt, or its content fails
    /// to open, for example data that no longer validates.
    Unreadable(String),
    /// A newer Folio created the schema.
    NewerSchema,
    /// The database belongs to the library with this id.
    OtherLibrary(String),
}

/// An open catalog, and whether opening it had to start over.
#[derive(Debug)]
pub struct Opened {
    pub catalog: Catalog,
    pub recovered: Option<Recovery>,
}

/// One library's catalog. Share it between threads; one write runs at a time, and reads run
/// alongside it (WAL).
#[derive(Debug)]
pub struct Catalog {
    path: PathBuf,
    writer: Mutex<Connection>,
    readers: Mutex<Vec<Connection>>,
}

impl Catalog {
    /// Opens or creates the catalog of `library` at `path`, migrates it and brings derived data
    /// up to date (§5.3–§5.4). A database that fails to open is moved to
    /// `<name>.broken.<extension>` and replaced by an empty one, unless the environment failed
    /// (I/O, permissions, a full disk, a lock held elsewhere): then it is an error and nothing
    /// moves.
    pub fn open(path: &Path, library: &LibraryId) -> Result<Opened, CatalogError> {
        let (writer, recovered) = match open_writer(path, library) {
            Ok(writer) => (writer, None),
            Err(Failure::Error(error)) => return Err(error),
            Err(Failure::Broken(reason)) => {
                move_aside(path)?;
                let writer = open_writer(path, library).map_err(|failure| match failure {
                    Failure::Broken(reason) => {
                        CatalogError::Invalid(format!("a new catalog fails to open: {reason:?}"))
                    }
                    Failure::Error(error) => error,
                })?;
                (writer, Some(reason))
            }
        };
        Ok(Opened {
            catalog: Self {
                path: path.to_owned(),
                writer: Mutex::new(writer),
                readers: Mutex::default(),
            },
            recovered,
        })
    }

    /// Runs `change` in a `BEGIN IMMEDIATE` transaction and commits it if `change` succeeds.
    /// An error or a panic rolls everything back.
    pub fn write<T>(
        &self,
        change: impl FnOnce(&Transaction<'_>) -> Result<T, CatalogError>,
    ) -> Result<T, CatalogError> {
        let mut writer = lock(&self.writer);
        let transaction = writer.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let value = change(&transaction)?;
        transaction.commit()?;
        Ok(value)
    }

    /// Runs `query` on a read-only connection, in one transaction, so it sees one snapshot.
    pub fn read<T>(
        &self,
        query: impl FnOnce(&Transaction<'_>) -> Result<T, CatalogError>,
    ) -> Result<T, CatalogError> {
        let idle = lock(&self.readers).pop();
        let mut reader = match idle {
            Some(reader) => reader,
            None => open_reader(&self.path)?,
        };
        let result = (|| {
            let transaction = reader.transaction()?;
            let value = query(&transaction)?;
            transaction.commit()?;
            Ok(value)
        })();
        let mut readers = lock(&self.readers);
        if readers.len() < MAX_IDLE_READERS {
            readers.push(reader);
        }
        result
    }

    /// Lets SQLite refresh its query-planner statistics; call it now and then, for example
    /// after a large scan.
    pub fn optimize(&self) -> Result<(), CatalogError> {
        lock(&self.writer).execute_batch("PRAGMA optimize")?;
        Ok(())
    }
}

/// A panic inside a transaction rolls it back, so the connection behind a poisoned mutex is
/// still consistent.
fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// Why a database could not be opened: `Broken` means it must be replaced.
#[derive(Debug)]
enum Failure {
    Broken(Recovery),
    Error(CatalogError),
}

impl From<rusqlite::Error> for Failure {
    /// The catalog is derived, so whatever fails while opening it is the file's fault and
    /// replacing it loses nothing, unless the environment failed: a new file would not help.
    fn from(error: rusqlite::Error) -> Self {
        let environment = matches!(
            error.sqlite_error_code(),
            Some(
                ErrorCode::SystemIoFailure
                    | ErrorCode::DiskFull
                    | ErrorCode::DatabaseBusy
                    | ErrorCode::DatabaseLocked
                    | ErrorCode::PermissionDenied
                    | ErrorCode::CannotOpen
                    | ErrorCode::ReadOnly
                    | ErrorCode::OutOfMemory
                    | ErrorCode::OperationInterrupted
                    | ErrorCode::FileLockingProtocolFailed
            )
        );
        if environment {
            Self::Error(error.into())
        } else {
            Self::Broken(Recovery::Unreadable(error.to_string()))
        }
    }
}

impl From<rusqlite_migration::Error> for Failure {
    fn from(error: rusqlite_migration::Error) -> Self {
        use rusqlite_migration::{Error, MigrationDefinitionError};
        match error {
            Error::MigrationDefinition(MigrationDefinitionError::DatabaseTooFarAhead) => {
                Self::Broken(Recovery::NewerSchema)
            }
            Error::RusqliteError { err, .. } => err.into(),
            error => Self::Broken(Recovery::Unreadable(error.to_string())),
        }
    }
}

const LIBRARY_ID: &str = "library_id";
const TOKENIZER: &str = "tokenizer_version";
const PATHS: &str = "paths_version";

fn open_writer(path: &Path, library: &LibraryId) -> Result<Connection, Failure> {
    if let Some(folder) = path.parent() {
        fs::create_dir_all(folder)
            .map_err(io_error(folder))
            .map_err(Failure::Error)?;
    }
    let mut conn = Connection::open(path)?;
    configure(&conn)?;
    let mode: String = conn.query_row("PRAGMA journal_mode = WAL", [], |row| row.get(0))?;
    if !mode.eq_ignore_ascii_case("wal") {
        return Err(Failure::Error(CatalogError::Invalid(format!(
            "the file system does not support WAL (journal mode {mode})"
        ))));
    }
    conn.execute_batch("PRAGMA journal_size_limit = 67108864")?;
    schema::MIGRATIONS.to_latest(&mut conn)?;

    let transaction = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    match info(&transaction, LIBRARY_ID)? {
        None => set_info(&transaction, LIBRARY_ID, library.as_str())?,
        Some(found) if found == library.as_str() => {}
        Some(found) => return Err(Failure::Broken(Recovery::OtherLibrary(found))),
    }
    refresh_derived(&transaction)?;
    transaction.commit()?;

    conn.execute_batch("PRAGMA optimize = 0x10002")?;
    Ok(conn)
}

fn open_reader(path: &Path) -> Result<Connection, CatalogError> {
    let conn = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    configure(&conn)?;
    Ok(conn)
}

/// Settings every connection needs, the tokenizer first: no statement may touch `search`
/// without it.
fn configure(conn: &Connection) -> rusqlite::Result<()> {
    register_tokenizer(conn)?;
    // Room for every statement the repositories cache.
    conn.set_prepared_statement_cache_capacity(32);
    conn.execute_batch(
        "PRAGMA synchronous = NORMAL;
         PRAGMA foreign_keys = ON;
         PRAGMA trusted_schema = OFF;
         PRAGMA busy_timeout = 5000;
         PRAGMA temp_store = MEMORY;",
    )
}

/// Brings data derived with older code up to date, before anything reads or writes it (§5.4).
fn refresh_derived(conn: &Connection) -> rusqlite::Result<()> {
    // FTS5 `rebuild` tokenizes the stored text again with the current tokenizer.
    refresh(conn, TOKENIZER, TOKENIZER_VERSION, || {
        conn.execute_batch("INSERT INTO search (search) VALUES ('rebuild')")
    })?;
    // Reading every path again also checks it against the current rules.
    refresh(conn, PATHS, PATHS_VERSION, || {
        entries::recompute_path_keys(conn)
    })
}

/// Records `version` under `key`, running `rebuild` first if another version made the stored
/// data. A new catalog has nothing to rebuild.
fn refresh(
    conn: &Connection,
    key: &str,
    version: u32,
    rebuild: impl FnOnce() -> rusqlite::Result<()>,
) -> rusqlite::Result<()> {
    let version = version.to_string();
    let stored = info(conn, key)?;
    if stored.as_deref() != Some(version.as_str()) {
        if stored.is_some() {
            rebuild()?;
        }
        set_info(conn, key, &version)?;
    }
    Ok(())
}

fn info(conn: &Connection, key: &str) -> rusqlite::Result<Option<String>> {
    conn.query_row("SELECT value FROM info WHERE key = ?1", [key], |row| {
        row.get(0)
    })
    .optional()
}

fn set_info(conn: &Connection, key: &str, value: &str) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO info (key, value) VALUES (?1, ?2)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value",
        [key, value],
    )?;
    Ok(())
}

/// Moves the database and its WAL files to `<name>.broken.<extension>`, replacing an older
/// broken copy, so the files can be inspected later.
fn move_aside(path: &Path) -> Result<(), CatalogError> {
    let mut broken = path.file_stem().unwrap_or_default().to_owned();
    broken.push(".broken");
    if let Some(extension) = path.extension() {
        broken.push(".");
        broken.push(extension);
    }
    let broken = path.with_file_name(broken);
    let files = ["", "-wal", "-shm"]
        .map(|suffix| (with_suffix(path, suffix), with_suffix(&broken, suffix)));
    // Every old copy goes first, so a failure never pairs a database with an old WAL.
    for (_, old) in &files {
        unless_missing(old, fs::remove_file(old))?;
    }
    for (from, to) in &files {
        unless_missing(from, fs::rename(from, to))?;
    }
    Ok(())
}

fn with_suffix(path: &Path, suffix: &str) -> PathBuf {
    let mut name = OsString::from(path);
    name.push(suffix);
    name.into()
}

/// The error of a file operation on `path`; a missing file counts as done.
fn unless_missing(path: &Path, result: io::Result<()>) -> Result<(), CatalogError> {
    match result {
        Err(source) if source.kind() != io::ErrorKind::NotFound => Err(io_error(path)(source)),
        _ => Ok(()),
    }
}

fn io_error(path: &Path) -> impl FnOnce(io::Error) -> CatalogError {
    let path = path.to_owned();
    move |source| CatalogError::Io { path, source }
}

#[cfg(test)]
mod tests;
