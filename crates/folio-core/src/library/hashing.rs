//! Content hashes for the files a scan found (docs/specs/library-scan.md §8).

use std::io;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use super::{Library, LibraryError, Problem};
use crate::catalog::{Catalog, Entry, EntryId, count_unhashed_files, set_hash, unhashed_files};
use crate::fs::{FileKind, Metadata, Presence};
use crate::hash::ContentHash;

/// Files read from the catalog at a time.
const BATCH: u32 = 1024;

/// How long hashes wait before they are written to the catalog, so that a crash or `cancel`
/// loses little of the work, whatever the size of the files.
const WRITE_EVERY: Duration = Duration::from_millis(250);

/// Files modified this recently may still be being written: they wait for the next run.
const FRESH_NS: u64 = 2_000_000_000;

/// What one run of [`Library::hash_pending`] did.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct HashReport {
    pub hashed: u64,
    /// Files modified too recently to hash: run again in a few seconds.
    pub deferred: u64,
    /// Files whose content is not on this disk, such as cloud placeholders: reading them would
    /// download them (docs/specs/windows-adapter.md §3.4). They stay pending until they are.
    pub not_local: u64,
    /// Files that could not be read; they stay pending.
    pub problems: Vec<Problem>,
    pub cancelled: bool,
}

enum Outcome {
    Hashed(ContentHash),
    Deferred,
    NotLocal,
    /// The file is not what the catalog says any more; the next scan updates it.
    Changed,
    Failed(io::Error),
    Cancelled,
}

impl Library {
    /// Hashes every file the catalog has no hash for, in batches, so that progress survives a
    /// crash or `cancel`. Files whose content is not on this disk are left for a later run.
    /// `now_ns` is the current time in nanoseconds since the Unix epoch; `progress` gets the
    /// files done and the total.
    pub fn hash_pending(
        &self,
        catalog: &Catalog,
        now_ns: i64,
        cancel: &AtomicBool,
        progress: &mut dyn FnMut(u64, u64),
    ) -> Result<HashReport, LibraryError> {
        self.hash_pending_with_commits(catalog, now_ns, cancel, progress, &mut || {})
    }

    /// As `hash_pending`, notifying after every batch that changed the catalog. The callback
    /// runs after releasing the writer lock, including batches preceding a later failure.
    pub fn hash_pending_with_commits(
        &self,
        catalog: &Catalog,
        now_ns: i64,
        cancel: &AtomicBool,
        progress: &mut dyn FnMut(u64, u64),
        on_commit: &mut dyn FnMut(),
    ) -> Result<HashReport, LibraryError> {
        let total = catalog.read(|tx| count_unhashed_files(tx))?;
        let mut report = HashReport::default();
        let mut after = EntryId(0);
        let mut done = 0;
        let mut buffer = Vec::new();
        while !report.cancelled {
            let batch = catalog.read(|tx| unhashed_files(tx, after, BATCH))?;
            let Some(last) = batch.last() else {
                break;
            };
            after = last.id;
            let mut hashes = Vec::new();
            let mut since = Instant::now();
            for file in &batch {
                match self.hash_file(file, now_ns, cancel, &mut buffer) {
                    Outcome::Hashed(hash) => hashes.push((file, hash)),
                    Outcome::Deferred => report.deferred += 1,
                    Outcome::NotLocal => report.not_local += 1,
                    Outcome::Changed => {}
                    Outcome::Failed(error) => report
                        .problems
                        .push(Problem::unreadable(file.record.path.clone(), &error)),
                    Outcome::Cancelled => {
                        report.cancelled = true;
                        break;
                    }
                }
                done += 1;
                progress(done, total);
                if since.elapsed() >= WRITE_EVERY {
                    report.hashed += store(catalog, &mut hashes, on_commit)?;
                    since = Instant::now();
                }
            }
            report.hashed += store(catalog, &mut hashes, on_commit)?;
        }
        Ok(report)
    }

    fn hash_file(
        &self,
        file: &Entry,
        now_ns: i64,
        cancel: &AtomicBool,
        buffer: &mut Vec<u8>,
    ) -> Outcome {
        if cancel.load(Ordering::Relaxed) {
            return Outcome::Cancelled;
        }
        let record = &file.record;
        if record
            .mtime_ns
            .is_some_and(|modified| modified.abs_diff(now_ns) < FRESH_NS)
        {
            return Outcome::Deferred;
        }
        let native = record.path.to_native(self.root());
        let unchanged = |metadata: &Metadata| {
            metadata.kind == FileKind::File
                && metadata.size == record.size
                && metadata.modified_ns == record.mtime_ns
                && metadata.file_id == record.file_id
        };
        // The same before and after reading, or the hash may mix two versions.
        match self.fs.metadata(&native) {
            Ok(metadata) if !unchanged(&metadata) => return Outcome::Changed,
            Ok(metadata) if metadata.presence != Presence::Local => return Outcome::NotLocal,
            Ok(_) => {}
            Err(error) => return failed(error),
        }
        let hash = match self
            .fs
            .open(&native)
            .and_then(|reader| ContentHash::read(reader, cancel, buffer))
        {
            Ok(Some(hash)) => hash,
            Ok(None) => return Outcome::Cancelled,
            Err(error) => return failed(error),
        };
        match self.fs.metadata(&native) {
            Ok(metadata) if unchanged(&metadata) => Outcome::Hashed(hash),
            Ok(_) => Outcome::Changed,
            Err(error) => failed(error),
        }
    }
}

/// Writes `hashes` to the catalog and empties it; returns how many were stored.
fn store(
    catalog: &Catalog,
    hashes: &mut Vec<(&Entry, ContentHash)>,
    on_commit: &mut dyn FnMut(),
) -> Result<u64, LibraryError> {
    if hashes.is_empty() {
        return Ok(0);
    }
    let stored = catalog.write(|tx| {
        let mut stored = 0;
        for (file, hash) in hashes.iter() {
            stored += u64::from(set_hash(tx, file, hash)?);
        }
        Ok(stored)
    })?;
    hashes.clear();
    if stored != 0 {
        on_commit();
    }
    Ok(stored)
}

/// A file that vanished waits for the next scan; anything else is reported.
fn failed(error: io::Error) -> Outcome {
    if error.kind() == io::ErrorKind::NotFound {
        Outcome::Changed
    } else {
        Outcome::Failed(error)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::meta::{DisplayName, LibraryConfig};
    use crate::test_support::{MemFs, open_catalog};

    #[test]
    fn reports_committed_hashes_before_a_later_batch_fails() {
        let dir = tempfile::tempdir().unwrap();
        let fs = MemFs::new(dir.path());
        let library = Library::new(dir.path(), fs.clone());
        library
            .layout()
            .write_library(&LibraryConfig::new(DisplayName::parse("Hashes").unwrap()).unwrap())
            .unwrap();
        let catalog = open_catalog(dir.path());
        for index in 0..=BATCH {
            fs.file(&format!("{index}.md"), b"hash me");
        }
        library.scan(&catalog, None, fs.now_ns()).unwrap();
        let mut commits = 0;
        let result = library.hash_pending_with_commits(
            &catalog,
            fs.now_ns() + 10_000_000_000,
            &AtomicBool::new(false),
            &mut |_, _| {},
            &mut || {
                commits += 1;
                // This write would deadlock if notifications still held the catalog writer.
                catalog
                    .write(|tx| {
                        tx.execute_batch(
                            "CREATE TRIGGER stop_hash BEFORE UPDATE OF hash ON entries
                        BEGIN SELECT RAISE(ABORT, 'injected later batch failure'); END;",
                        )?;
                        Ok(())
                    })
                    .unwrap();
            },
        );
        assert!(matches!(result, Err(LibraryError::Catalog(_))));
        assert_eq!(commits, 1);
        let pending = catalog.read(|tx| count_unhashed_files(tx)).unwrap();
        assert!((1..=u64::from(BATCH)).contains(&pending));
    }
}
