//! Replacing files atomically (ADR-0002 §3, docs/specs/library-core.md §4.3).

use std::fs::{self, File};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

/// How long [`retry_transient`] keeps retrying before it reports the error.
const RETRY_BUDGET: Duration = Duration::from_secs(2);

/// Replaces `target` with `bytes`, so readers see the old or the new content and never a mix.
///
/// The bytes go to a new file in `staging`, which must be on the same volume as `target`, are
/// flushed with `sync_all`, and replace `target` with one rename. Missing folders are created.
pub fn write_atomically(staging: &Path, target: &Path, bytes: &[u8]) -> io::Result<()> {
    fs::create_dir_all(staging)?;
    let (temp, mut file) = create_temp(staging)?;
    let result = (|| {
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent)?;
        }
        retry_transient(|| fs::rename(&temp, target))
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
