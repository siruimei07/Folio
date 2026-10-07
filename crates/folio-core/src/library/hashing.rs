//! Content hashes for the files a scan found (docs/specs/library-scan.md §8), and how a pass
//! reads a file the catalog has ([`Library::read_cataloged`]).

use std::io;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use super::{Library, LibraryError, Problem};
use crate::catalog::unhashed::{clear_unhashed, record_unhashed};
use crate::catalog::{
    Catalog, Entry, EntryId, EntryRecord, count_unhashed_files, set_hash, unhashed_files,
};
use crate::fs::{FileKind, Presence};
use crate::hash::ContentHash;
use crate::workspace::Blocked;

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

/// What reading a file the catalog has gave ([`Library::read_cataloged`]).
pub(super) enum Reading<T> {
    /// What the read gave, from the version of the file the catalog has.
    Read(T),
    /// Its content is not on this disk, such as a cloud placeholder's: it was not opened.
    NotLocal,
    /// It is gone, or not what the catalog says any more; the next scan updates the catalog.
    Changed,
    /// It could not be inspected or read; reading it again may work.
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
    ///
    /// Each file it leaves unhashed because its content is not on this disk, or because it could
    /// not be read, is recorded with why (`catalog::unhashed`), and the record goes when its hash
    /// is stored: the workspace's readiness (versioning.md §6.2). A batch that only records again
    /// what the catalog says already changes nothing and notifies nobody.
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
            let mut blocked = Vec::new();
            let mut since = Instant::now();
            for file in &batch {
                let record = &file.record;
                if cancel.load(Ordering::Relaxed) {
                    report.cancelled = true;
                    break;
                }
                if record
                    .mtime_ns
                    .is_some_and(|modified| modified.abs_diff(now_ns) < FRESH_NS)
                {
                    report.deferred += 1;
                } else {
                    let read = |native: &Path| {
                        let reader = self.fs.open(native)?;
                        ContentHash::read(reader, cancel, &mut buffer)
                    };
                    match self.read_cataloged(record, read) {
                        Reading::Read(hash) => hashes.push((file, hash)),
                        Reading::NotLocal => {
                            report.not_local += 1;
                            blocked.push((file, Blocked::NotLocal));
                        }
                        Reading::Changed => {}
                        Reading::Failed(error) => {
                            report
                                .problems
                                .push(Problem::unreadable(record.path.clone(), &error));
                            blocked.push((file, Blocked::Unreadable));
                        }
                        Reading::Cancelled => {
                            report.cancelled = true;
                            break;
                        }
                    }
                }
                done += 1;
                progress(done, total);
                if since.elapsed() >= WRITE_EVERY {
                    report.hashed += store(catalog, &mut hashes, &mut blocked, on_commit)?;
                    since = Instant::now();
                }
            }
            report.hashed += store(catalog, &mut hashes, &mut blocked, on_commit)?;
        }
        Ok(report)
    }

    /// Reads the file `record` describes with `read`, between two checks that it is on disk as
    /// the catalog has it (a file of the same size, modification time and file id), so that what
    /// `read` gives comes from that one version: a hash or a text never mixes two. A file whose
    /// content is not on this disk is not opened. `read` gets the file's path, and gives `None`
    /// when it was cancelled.
    pub(super) fn read_cataloged<T>(
        &self,
        record: &EntryRecord,
        read: impl FnOnce(&Path) -> io::Result<Option<T>>,
    ) -> Reading<T> {
        let native = record.path.to_native(self.root());
        match self.presence(&native, record) {
            Ok(Presence::Local) => {}
            Ok(_) => return Reading::NotLocal,
            Err(reading) => return reading,
        }
        let value = match read(&native) {
            Ok(Some(value)) => value,
            Ok(None) => return Reading::Cancelled,
            Err(error) => return failed(error),
        };
        match self.presence(&native, record) {
            Ok(_) => Reading::Read(value),
            Err(reading) => reading,
        }
    }

    /// Whether the content of the file at `native` is on this disk, if it is as `record`
    /// describes it; else why it cannot be read.
    fn presence<T>(&self, native: &Path, record: &EntryRecord) -> Result<Presence, Reading<T>> {
        match self.fs.metadata(native) {
            Ok(metadata)
                if metadata.kind == FileKind::File
                    && metadata.size == record.size
                    && metadata.modified_ns == record.mtime_ns
                    && metadata.file_id == record.file_id =>
            {
                Ok(metadata.presence)
            }
            Ok(_) => Err(Reading::Changed),
            Err(error) => Err(failed(error)),
        }
    }
}

/// Writes `hashes`, and why the files of `blocked` stay unhashed, to the catalog and empties both;
/// returns how many hashes were stored. Notifies when the catalog changed.
fn store(
    catalog: &Catalog,
    hashes: &mut Vec<(&Entry, ContentHash)>,
    blocked: &mut Vec<(&Entry, Blocked)>,
    on_commit: &mut dyn FnMut(),
) -> Result<u64, LibraryError> {
    if hashes.is_empty() && blocked.is_empty() {
        return Ok(0);
    }
    let (stored, recorded) = catalog.write(|tx| {
        let mut stored = 0;
        for (file, hash) in hashes.iter() {
            if set_hash(tx, file, hash)? {
                stored += 1;
                clear_unhashed(tx, file.id)?;
            }
        }
        let mut recorded = false;
        for (file, why) in blocked.iter() {
            recorded |= record_unhashed(tx, file, *why)?;
        }
        Ok((stored, recorded))
    })?;
    hashes.clear();
    blocked.clear();
    if stored != 0 || recorded {
        on_commit();
    }
    Ok(stored)
}

/// A file that vanished waits for the next scan; anything else is reported.
fn failed<T>(error: io::Error) -> Reading<T> {
    if error.kind() == io::ErrorKind::NotFound {
        Reading::Changed
    } else {
        Reading::Failed(error)
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
