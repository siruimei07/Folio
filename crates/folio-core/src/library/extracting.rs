//! Search bodies for the text and Word files hashing found (versioning.md §10.2–§10.3, ADR-0002
//! §5): the extraction pass reads each file with [`crate::extract`] and records what it gave in
//! the catalog, with the file's search body ([`record_extracts`]).
//!
//! A file is extracted once for its content hash, its class and [`extract::VERSION`]. A damaged
//! or oversized file is recorded as failed the same way, and tried again only when one of them
//! changes (the problems list calls it [`ReadFailure::Damaged`] or [`ReadFailure::TooLarge`]),
//! while a file that could not be read (in use, access denied, not in the time allowed) is tried
//! again by the next pass. Every write is guarded by the entry's id, hash and class, so
//! the pass may run while the library changes: a file changed or deleted meanwhile is passed over.

use std::io::{self, Read};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use super::hashing::Reading;
use super::{Library, LibraryError, Problem, ReadFailure};
use crate::catalog::{
    Catalog, Entry, EntryId, ExtractFailure, ExtractState, FailedExtract, count_pending_extracts,
    failed_extracts, pending_extracts, record_extracts,
};
use crate::extract::{self, Body, Control, WordError};
use crate::meta::FileClass;

/// Files read from the catalog at a time.
const BATCH: u32 = 1024;

/// How long outcomes wait before they are written to the catalog, so that a crash or `cancel`
/// loses little of the work.
const WRITE_EVERY: Duration = Duration::from_millis(250);

/// The most body text that waits to be written, so that a fast disk does not fill memory.
const WRITE_BYTES: usize = 16 << 20;

/// What one run of [`Library::extract_pending`] did.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ExtractReport {
    /// Files whose outcome was recorded: a body, no text, binary, skipped or failed.
    pub extracted: u64,
    /// Files whose content is not on this disk, such as cloud placeholders: reading them would
    /// download them (docs/specs/windows-adapter.md §3.4). They stay pending until it is.
    pub not_local: u64,
    /// Files whose text could not be extracted. One that could not be read stays pending; a
    /// damaged or oversized one is recorded, and every complete pass lists it until its content
    /// changes.
    pub problems: Vec<Problem>,
    pub cancelled: bool,
    /// Whether the pass tried every pending file. `problems` then lists every file whose text
    /// cannot be extracted, replacing what an earlier pass listed; otherwise only what this pass
    /// found.
    pub complete: bool,
}

impl Library {
    /// Extracts the text of every hashed text and Word file the catalog has no outcome for, for
    /// its content, class and [`extract::VERSION`]: its search body, or why it has none. Works
    /// in batches, so that progress survives a crash or `cancel`; files whose content is not on
    /// this disk are left for a later run. `progress` gets the files done and the total.
    pub fn extract_pending(
        &self,
        catalog: &Catalog,
        cancel: &AtomicBool,
        progress: &mut dyn FnMut(u64, u64),
    ) -> Result<ExtractReport, LibraryError> {
        self.extract_pending_with_commits(catalog, cancel, &mut || false, progress, &mut || {})
    }

    /// As `extract_pending`, notifying after every write that changed the catalog: the callback
    /// runs after releasing the writer lock, including writes preceding a later failure. At each
    /// write, while files remain, the pass stops, incomplete, if `should_yield` says so: say a
    /// scan is waiting for it.
    pub fn extract_pending_with_commits(
        &self,
        catalog: &Catalog,
        cancel: &AtomicBool,
        should_yield: &mut dyn FnMut() -> bool,
        progress: &mut dyn FnMut(u64, u64),
        on_commit: &mut dyn FnMut(),
    ) -> Result<ExtractReport, LibraryError> {
        let pass = Pass {
            catalog,
            cancel,
            time_limit: extract::TIME_LIMIT,
            write_every: WRITE_EVERY,
            write_bytes: WRITE_BYTES,
        };
        self.extract(&pass, should_yield, progress, on_commit)
    }

    fn extract(
        &self,
        pass: &Pass<'_>,
        should_yield: &mut dyn FnMut() -> bool,
        progress: &mut dyn FnMut(u64, u64),
        on_commit: &mut dyn FnMut(),
    ) -> Result<ExtractReport, LibraryError> {
        let catalog = pass.catalog;
        let total = catalog.read(|tx| count_pending_extracts(tx, extract::VERSION))?;
        let pending =
            |after| catalog.read(|tx| pending_extracts(tx, after, BATCH, extract::VERSION));
        let mut report = ExtractReport::default();
        // The failures this pass recorded.
        let mut failures = Vec::new();
        let mut yielded = false;
        let mut done = 0;
        let mut buffer = Vec::new();
        // A file that becomes pending during the pass, say an imported one, may wait for the
        // next pass, which its change asks for: when nothing was pending, or below the files
        // already read.
        let mut batch = if total == 0 {
            Vec::new()
        } else {
            pending(EntryId(0))?
        };
        while let Some(last) = batch.last() {
            let after = last.id;
            let mut writes = Writes::default();
            let mut since = Instant::now();
            for (index, file) in batch.iter().enumerate() {
                if pass.cancel.load(Ordering::Relaxed) {
                    report.cancelled = true;
                    break;
                }
                match self.extract_file(file, pass, &mut buffer) {
                    Reading::Read(state) => writes.push(file, state),
                    Reading::NotLocal => report.not_local += 1,
                    Reading::Changed => {}
                    Reading::Failed(error) => report
                        .problems
                        .push(Problem::unreadable(file.record.path.clone(), &error)),
                    Reading::Cancelled => {
                        report.cancelled = true;
                        break;
                    }
                }
                done += 1;
                progress(done, total);
                if since.elapsed() >= pass.write_every || writes.bytes >= pass.write_bytes {
                    report.extracted += writes.store(catalog, &mut failures, on_commit)?;
                    since = Instant::now();
                    // Only while files remain; after the batch's last one, the next read tells.
                    if index + 1 < batch.len() && should_yield() {
                        yielded = true;
                        break;
                    }
                }
            }
            report.extracted += writes.store(catalog, &mut failures, on_commit)?;
            if report.cancelled || yielded {
                break;
            }
            batch = pending(after)?;
            if !batch.is_empty() && should_yield() {
                yielded = true;
                break;
            }
        }
        report.complete = !report.cancelled && !yielded;
        if report.complete {
            let stored = catalog.read(|tx| failed_extracts(tx, extract::VERSION))?;
            report.problems.extend(stored.into_iter().map(problem_of));
        } else {
            report.problems.extend(failures);
        }
        Ok(report)
    }

    /// What extracting `file` gives, from the version of it the catalog has.
    fn extract_file(
        &self,
        file: &Entry,
        pass: &Pass<'_>,
        buffer: &mut Vec<u8>,
    ) -> Reading<ExtractState> {
        let record = &file.record;
        let name = record.path.name();
        // Known without opening the file: an empty file has no text, and a text file with a
        // generated name is skipped.
        if record.size == 0 {
            return Reading::Read(ExtractState::Empty);
        }
        match record.class {
            FileClass::Word => self.read_cataloged(record, |native| self.word_state(native, pass)),
            _ if extract::is_generated(name) => Reading::Read(ExtractState::Skipped),
            _ => self.read_cataloged(record, |native| self.text_state(native, name, buffer)),
        }
    }

    /// The body of the text file at `native`, from its first [`extract::READ_LIMIT`] bytes.
    fn text_state(
        &self,
        native: &Path,
        name: &str,
        prefix: &mut Vec<u8>,
    ) -> io::Result<Option<ExtractState>> {
        prefix.clear();
        // One byte more tells whether the prefix is the whole file.
        let limit = extract::READ_LIMIT as u64 + 1;
        self.fs.open(native)?.take(limit).read_to_end(prefix)?;
        let complete = prefix.len() <= extract::READ_LIMIT;
        prefix.truncate(extract::READ_LIMIT);
        Ok(Some(state_of(extract::text_body(name, prefix, complete))))
    }

    /// The body of the Word document at `native`, within the pass's time limit; `None` when
    /// cancelled. A failure to read the file, or to read it in time, is an error: it may work next
    /// time.
    fn word_state(&self, native: &Path, pass: &Pass<'_>) -> io::Result<Option<ExtractState>> {
        let control = Control {
            deadline: Instant::now() + pass.time_limit,
            cancel: pass.cancel,
        };
        let document = self.fs.open_seekable(native)?;
        let (failure, error) = match extract::word_body(document, &control) {
            Ok(body) => return Ok(Some(state_of(body))),
            Err(WordError::Cancelled) => return Ok(None),
            Err(WordError::Io(error)) => return Err(error),
            // The caps bound the work (`read_word` loads one directory at most, reads at most
            // `MAX_READ` bytes of the file and expands at most `MAX_EXPANDED`, in work that grows
            // with those bytes): the slowest crafted documents measured take under 2 s
            // (versioning.md §13.3), so running out of time says more about the machine (asleep,
            // a disk spinning up) than about the document.
            Err(error @ WordError::TimedOut) => {
                return Err(io::Error::new(io::ErrorKind::TimedOut, error));
            }
            Err(error @ WordError::Invalid(_)) => (ExtractFailure::Invalid, error),
            Err(error @ WordError::TooLarge(_)) => (ExtractFailure::TooLarge, error),
        };
        Ok(Some(ExtractState::Failed {
            failure,
            detail: error.to_string(),
        }))
    }
}

/// What one pass works with.
struct Pass<'a> {
    catalog: &'a Catalog,
    cancel: &'a AtomicBool,
    /// The most time one Word document may take ([`extract::TIME_LIMIT`]). A text file's read
    /// is bounded by [`extract::READ_LIMIT`] instead.
    time_limit: Duration,
    /// When waiting outcomes are written: after this long ([`WRITE_EVERY`]), or once they hold
    /// this much body text ([`WRITE_BYTES`]).
    write_every: Duration,
    write_bytes: usize,
}

/// Outcomes waiting to be written, and the body text they hold.
#[derive(Default)]
struct Writes<'a> {
    outcomes: Vec<(&'a Entry, ExtractState)>,
    bytes: usize,
}

impl<'a> Writes<'a> {
    fn push(&mut self, file: &'a Entry, state: ExtractState) {
        if let ExtractState::Text(text) = &state {
            self.bytes += text.len();
        }
        self.outcomes.push((file, state));
    }

    /// Writes the outcomes in one transaction and forgets them; returns how many were recorded,
    /// and adds the failures among them to `failures`. Those of entries that are gone or changed
    /// are not recorded.
    fn store(
        &mut self,
        catalog: &Catalog,
        failures: &mut Vec<Problem>,
        on_commit: &mut dyn FnMut(),
    ) -> Result<u64, LibraryError> {
        if self.outcomes.is_empty() {
            return Ok(0);
        }
        let recorded = {
            let outcomes: Vec<_> = self
                .outcomes
                .iter()
                .map(|(file, state)| (*file, state))
                .collect();
            catalog.write(|tx| record_extracts(tx, extract::VERSION, &outcomes))?
        };
        let mut stored = 0;
        for ((file, state), recorded) in self.outcomes.drain(..).zip(recorded) {
            if !recorded {
                continue;
            }
            stored += 1;
            if let ExtractState::Failed { failure, detail } = state {
                failures.push(problem_of(FailedExtract {
                    path: file.record.path.clone(),
                    failure,
                    detail,
                }));
            }
        }
        self.bytes = 0;
        if stored != 0 {
            on_commit();
        }
        Ok(stored)
    }
}

fn state_of(body: Body) -> ExtractState {
    match body {
        Body::Text(text) => ExtractState::Text(text),
        Body::Empty => ExtractState::Empty,
        Body::Binary => ExtractState::Binary,
        Body::Skipped => ExtractState::Skipped,
    }
}

/// A file whose text could not be extracted, as the problems list words it
/// (docs/specs/ipc-m1.md §14): a document the reader refuses is damaged, and one over a cap is
/// too large. Both stay listed until the file's content changes; a file not read in time is
/// never recorded, so it is never one of these.
fn problem_of(failed: FailedExtract) -> Problem {
    Problem::Unreadable {
        path: failed.path,
        failure: match failed.failure {
            ExtractFailure::Invalid => ReadFailure::Damaged,
            ExtractFailure::TooLarge => ReadFailure::TooLarge,
        },
        detail: failed.detail,
    }
}

#[cfg(test)]
mod tests;
