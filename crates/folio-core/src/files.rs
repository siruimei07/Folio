//! Replacing files atomically (ADR-0002 §3, docs/specs/library-core.md §4.3).

use std::fs::{self, File};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use crate::crash;

/// How long [`retry_transient`] keeps retrying before it reports the error.
const RETRY_BUDGET: Duration = Duration::from_secs(2);

/// Replaces `target` with `bytes`, so readers see the old or the new content and never a mix.
///
/// The bytes go to a new file in `staging`, which must be on the same volume as `target`, are
/// flushed with `sync_all`, and replace `target` with one rename. Missing folders are created.
pub fn write_atomically(staging: &Path, target: &Path, bytes: &[u8]) -> io::Result<()> {
    write_via_staging(staging, target, bytes, |temp, target| {
        retry_transient(|| fs::rename(temp, target))
    })
}

/// [`write_atomically`] for a file that is a commit point, such as the local history's `HEAD`
/// (versioning.md §4.2): the rename is on the disk when this returns ([`rename_durably`]), so a
/// power loss afterwards cannot bring the old content back. Both paths are absolute.
pub fn write_atomically_durably(staging: &Path, target: &Path, bytes: &[u8]) -> io::Result<()> {
    write_via_staging(staging, target, bytes, |temp, target| {
        rename_durably(temp, target, true)
    })
}

/// Renames the file `from` to `to` on one volume and returns once the rename is on the disk: one
/// `MoveFileExW` with `MOVEFILE_WRITE_THROUGH` on Windows, a rename and a flush of the folder
/// elsewhere. With `replace` a file at `to` is replaced; otherwise one there makes the rename fail
/// with [`io::ErrorKind::AlreadyExists`]. Sharing violations are retried ([`retry_transient`]).
/// Both paths are absolute.
pub fn rename_durably(from: &Path, to: &Path, replace: bool) -> io::Result<()> {
    retry_transient(|| rename_durably_once(from, to, replace))
}

#[cfg(windows)]
fn rename_durably_once(from: &Path, to: &Path, replace: bool) -> io::Result<()> {
    crate::win::rename_durably(from, to, replace)
}

#[cfg(not(windows))]
fn rename_durably_once(from: &Path, to: &Path, replace: bool) -> io::Result<()> {
    if replace {
        fs::rename(from, to)?;
    } else {
        // A link fails where a name exists, so nothing is replaced.
        fs::hard_link(from, to)?;
        fs::remove_file(from)?;
    }
    if let Some(folder) = to.parent() {
        File::open(folder)?.sync_all()?;
    }
    crash::note(if replace {
        "rename.durable.replace"
    } else {
        "rename.durable"
    });
    Ok(())
}

/// Flushes `file`'s data and metadata to the disk (`sync_all`); noted in tests (`crash::note`),
/// which check that the writes they depend on are durable.
pub(crate) fn sync_all(file: &File) -> io::Result<()> {
    file.sync_all()?;
    crash::note("sync");
    Ok(())
}

/// What both atomic writes share: the bytes in a new file in `staging`, flushed, then `rename`d
/// over `target`.
///
/// In tests the write and the flush can fail on purpose, as a full disk would make them fail
/// (`crate::crash`'s faults `atomic.write` and `atomic.sync`), and the write is noted
/// (`crash::note`), so that a test sees the flush come after it.
fn write_via_staging(
    staging: &Path,
    target: &Path,
    bytes: &[u8],
    rename: impl FnOnce(&Path, &Path) -> io::Result<()>,
) -> io::Result<()> {
    fs::create_dir_all(staging)?;
    let (temp, mut file) = create_temp(staging)?;
    let result = (|| {
        crash::point("atomic.write");
        crash::fault("atomic.write").and_then(|()| file.write_all(bytes))?;
        crash::note("write");
        crash::fault("atomic.sync").and_then(|()| sync_all(&file))?;
        drop(file);
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent)?;
        }
        crash::point("atomic.rename");
        rename(&temp, target)
    })();
    // The write already failed; a temporary file left behind is harmless and reported with it,
    // because staging holds nothing else.
    result.map_err(|error| match fs::remove_file(&temp) {
        Ok(()) => error,
        Err(cleanup) => io::Error::new(
            error.kind(),
            format!("{error} (could not remove {}: {cleanup})", temp.display()),
        ),
    })
}

/// Everything `reader` yields, or `None` if that is more than `limit` bytes.
pub fn read_capped(reader: impl Read, limit: u64) -> io::Result<Option<Vec<u8>>> {
    let mut bytes = Vec::new();
    reader.take(limit + 1).read_to_end(&mut bytes)?;
    Ok((bytes.len() as u64 <= limit).then_some(bytes))
}

/// A new, uniquely named file in `staging`.
fn create_temp(staging: &Path) -> io::Result<(PathBuf, File)> {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    loop {
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let path = staging.join(format!("{}-{n}.part", std::process::id()));
        match File::create_new(&path) {
            Ok(file) => return Ok((path, file)),
            // Left behind by an earlier process with the same id.
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error),
        }
    }
}

/// Runs `op` again while it fails because another program has the file open (antivirus,
/// indexers, Explorer previews), with growing pauses, for about two seconds.
pub fn retry_transient<T>(op: impl FnMut() -> io::Result<T>) -> io::Result<T> {
    retry(op, is_transient, std::thread::sleep)
}

fn retry<T>(
    mut op: impl FnMut() -> io::Result<T>,
    is_transient: impl Fn(&io::Error) -> bool,
    mut sleep: impl FnMut(Duration),
) -> io::Result<T> {
    let mut pause = Duration::from_millis(10);
    let mut waited = Duration::ZERO;
    loop {
        match op() {
            Err(error) if is_transient(&error) && waited < RETRY_BUDGET => {
                sleep(pause);
                waited += pause;
                pause = (pause * 2).min(Duration::from_millis(500));
            }
            result => return result,
        }
    }
}

/// The text of a file: without a byte order mark, invalid UTF-8 replaced.
pub fn lossy_text(bytes: &[u8]) -> String {
    let bytes = bytes.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(bytes);
    String::from_utf8_lossy(bytes).into_owned()
}

/// Sharing and lock violations, and the access-denied error Windows also returns while another
/// program holds a file open for deletion.
fn is_transient(error: &io::Error) -> bool {
    const ERROR_ACCESS_DENIED: i32 = 5;
    is_in_use(error) || (cfg!(windows) && error.raw_os_error() == Some(ERROR_ACCESS_DENIED))
}

/// Whether another program holds the file open: a sharing or lock violation.
pub fn is_in_use(error: &io::Error) -> bool {
    const ERROR_SHARING_VIOLATION: i32 = 32;
    const ERROR_LOCK_VIOLATION: i32 = 33;
    cfg!(windows)
        && matches!(
            error.raw_os_error(),
            Some(ERROR_SHARING_VIOLATION | ERROR_LOCK_VIOLATION)
        )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn replaces_the_target_and_leaves_no_temporary_file() {
        let dir = tempfile::tempdir().unwrap();
        let staging = dir.path().join("local/staging");
        let target = dir.path().join("meta/2026 秋/线性代数.json");

        write_atomically(&staging, &target, b"first").unwrap();
        write_atomically(&staging, &target, b"second").unwrap();

        assert_eq!(fs::read(&target).unwrap(), b"second");
        assert_eq!(fs::read_dir(&staging).unwrap().count(), 0);
    }

    #[test]
    fn reports_a_failed_write_and_removes_the_temporary_file() {
        let dir = tempfile::tempdir().unwrap();
        let staging = dir.path().join("staging");
        // The target's folder cannot be created where a file is.
        fs::write(dir.path().join("file"), b"").unwrap();
        let target = dir.path().join("file/child.json");

        assert!(write_atomically(&staging, &target, b"data").is_err());
        assert_eq!(fs::read_dir(&staging).unwrap().count(), 0);
    }

    #[test]
    fn a_durable_write_replaces_the_target_and_leaves_no_temporary_file() {
        let dir = tempfile::tempdir().unwrap();
        let staging = dir.path().join("local/staging");
        let target = dir.path().join("local/HEAD");

        write_atomically_durably(&staging, &target, b"first").unwrap();
        write_atomically_durably(&staging, &target, b"second").unwrap();

        assert_eq!(fs::read(&target).unwrap(), b"second");
        assert_eq!(fs::read_dir(&staging).unwrap().count(), 0);
    }

    /// Both atomic writes flush the new content to the disk after writing it and before the
    /// rename; only the durable one also writes the rename through (what tests can see of it:
    /// `crash::note`).
    #[test]
    fn a_durable_write_flushes_its_content_and_its_rename() {
        let dir = tempfile::tempdir().unwrap();
        let staging = dir.path().join("local/staging");
        let target = dir.path().join("local/HEAD");
        type Write = fn(&Path, &Path, &[u8]) -> io::Result<()>;
        let durable: &[&str] = &["write", "sync", "rename.durable.replace"];
        for (write, effects) in [
            (write_atomically_durably as Write, durable),
            (write_atomically as Write, &["write", "sync"][..]),
        ] {
            let (written, noted) = crash::noting(|| write(&staging, &target, b"content"));
            written.unwrap();
            assert_eq!(noted, effects);
        }
        let (renamed, noted) = crash::noting(|| rename_durably(&target, &staging.join("x"), false));
        renamed.unwrap();
        assert_eq!(noted, ["rename.durable"]);
    }

    /// The staged file's write or flush can fail, as on a full disk (injected here): the atomic
    /// write fails with that error, the target keeps its old content, and no temporary file is
    /// left; a short file is never renamed over the target, nor one that may not be on the disk.
    #[test]
    fn a_failed_write_or_flush_of_the_staged_file_leaves_the_old_content() {
        type Write = fn(&Path, &Path, &[u8]) -> io::Result<()>;
        for write in [write_atomically as Write, write_atomically_durably] {
            for step in ["atomic.write", "atomic.sync"] {
                let dir = tempfile::tempdir().unwrap();
                let staging = dir.path().join("staging");
                let target = dir.path().join("meta/2026 秋/线性代数.json");
                write(&staging, &target, b"old").unwrap();
                let (failed, noted) =
                    crash::noting(|| crash::fail_at(step, || write(&staging, &target, b"new")));
                let error = failed.unwrap_err();
                assert_eq!(error.to_string(), format!("a fault injected at {step}"));
                // Nothing was flushed or renamed.
                let written: &[&str] = if step == "atomic.write" {
                    &[]
                } else {
                    &["write"]
                };
                assert_eq!(noted, written, "{step}");
                assert_eq!(fs::read(&target).unwrap(), b"old", "{step}");
                assert_eq!(fs::read_dir(&staging).unwrap().count(), 0, "{step}");
            }
        }
    }

    /// A flush that fails is reported, and not noted as done: a handle opened for reading cannot
    /// flush on Windows.
    #[cfg(windows)]
    #[test]
    fn a_failed_flush_is_reported_and_not_noted() {
        const ERROR_ACCESS_DENIED: i32 = 5;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("file");
        fs::write(&path, b"content").unwrap();
        let reading = File::open(&path).unwrap();
        let (flushed, noted) = crash::noting(|| sync_all(&reading));
        let error = flushed.unwrap_err();
        assert_eq!(error.raw_os_error(), Some(ERROR_ACCESS_DENIED), "{error}");
        assert!(noted.is_empty(), "{noted:?}");
        let writing = fs::OpenOptions::new().write(true).open(&path).unwrap();
        let (flushed, noted) = crash::noting(|| sync_all(&writing));
        flushed.unwrap();
        assert_eq!(noted, ["sync"]);
    }

    #[test]
    fn a_crash_in_an_atomic_write_leaves_the_old_content() {
        type Write = fn(&Path, &Path, &[u8]) -> io::Result<()>;
        for write in [write_atomically as Write, write_atomically_durably] {
            let steps = crash::each_point(|arm| {
                let dir = tempfile::tempdir().unwrap();
                let staging = dir.path().join("staging");
                let target = dir.path().join("meta/2026 秋/线性代数.json");
                write(&staging, &target, b"old").unwrap();
                match arm.run(|| write(&staging, &target, b"new")) {
                    Ok(written) => {
                        written.unwrap();
                        assert_eq!(fs::read(&target).unwrap(), b"new");
                        assert_eq!(fs::read_dir(&staging).unwrap().count(), 0);
                    }
                    Err(step) => {
                        assert_eq!(fs::read(&target).unwrap(), b"old", "{step}");
                        // The crash leaves its temporary file, and writing again works.
                        assert_eq!(fs::read_dir(&staging).unwrap().count(), 1, "{step}");
                        write(&staging, &target, b"new").unwrap();
                        assert_eq!(fs::read(&target).unwrap(), b"new");
                    }
                }
            });
            assert_eq!(steps, ["atomic.write", "atomic.rename"]);
        }
    }

    #[test]
    fn durable_renames_replace_only_when_asked() {
        let dir = tempfile::tempdir().unwrap();
        let (from, to) = (dir.path().join("from.part"), dir.path().join("to"));
        fs::write(&from, b"new").unwrap();
        fs::write(&to, b"old").unwrap();

        let refused = rename_durably(&from, &to, false).unwrap_err();
        assert_eq!(refused.kind(), io::ErrorKind::AlreadyExists, "{refused}");
        assert_eq!(fs::read(&from).unwrap(), b"new");
        assert_eq!(fs::read(&to).unwrap(), b"old");

        rename_durably(&from, &to, true).unwrap();
        assert_eq!(fs::read(&to).unwrap(), b"new");
        assert!(!from.exists());
        let moved = dir.path().join("moved");
        rename_durably(&to, &moved, false).unwrap();
        assert_eq!(fs::read(&moved).unwrap(), b"new");
        let missing = rename_durably(&to, &moved, true).unwrap_err();
        assert_eq!(missing.kind(), io::ErrorKind::NotFound);
    }

    #[test]
    fn reads_up_to_a_limit() {
        assert_eq!(read_capped(&b"abc"[..], 3).unwrap(), Some(b"abc".to_vec()));
        assert_eq!(read_capped(&b"abcd"[..], 3).unwrap(), None);
    }

    #[test]
    fn retries_transient_errors_with_growing_pauses() {
        let mut failures = 3;
        let mut pauses = Vec::new();
        let result = retry(
            &mut || {
                if failures == 0 {
                    return Ok("done");
                }
                failures -= 1;
                Err(io::Error::other("busy"))
            },
            |_| true,
            |pause| pauses.push(pause.as_millis()),
        );
        assert_eq!(result.unwrap(), "done");
        assert_eq!(pauses, [10, 20, 40]);
    }

    #[test]
    fn gives_up_after_the_budget_and_returns_the_last_error() {
        let mut calls = 0;
        let mut waited = Duration::ZERO;
        let result: io::Result<()> = retry(
            &mut || {
                calls += 1;
                Err(io::Error::other("still busy"))
            },
            |_| true,
            |pause| waited += pause,
        );
        assert_eq!(result.unwrap_err().to_string(), "still busy");
        assert!(waited >= RETRY_BUDGET && waited < RETRY_BUDGET + Duration::from_millis(500));
        assert_eq!(calls, 10);
    }

    #[test]
    fn does_not_retry_other_errors() {
        let mut calls = 0;
        let result: io::Result<()> = retry(
            &mut || {
                calls += 1;
                Err(io::Error::from(io::ErrorKind::NotFound))
            },
            |error| error.kind() != io::ErrorKind::NotFound,
            |_| panic!("must not pause"),
        );
        assert_eq!(result.unwrap_err().kind(), io::ErrorKind::NotFound);
        assert_eq!(calls, 1);
    }
}
