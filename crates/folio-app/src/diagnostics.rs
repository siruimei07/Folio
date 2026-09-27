//! Persistent shell diagnostics, in `logs\shell-errors.log` under the data directory (ADR-0002,
//! storage locations). Output failures must not panic across a Win32 callback.

use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::Path;

use tauri::{AppHandle, Manager};

use crate::paths::DataDir;

pub fn report(app: &AppHandle, message: &str) {
    let result = app
        .try_state::<DataDir>()
        .ok_or_else(|| io::Error::other("data directory state is missing"))
        .and_then(|data| {
            let data = data.path().map_err(io::Error::other)?;
            append(&data.join("logs"), message)
        });
    if let Err(error) = result {
        // stderr is the last sink: if it fails too, nothing is left to report to.
        let _ = write_record(
            io::stderr().lock(),
            &format!("{message} (diagnostic log unavailable: {error})"),
        );
    }
}

fn append(directory: &Path, message: &str) -> io::Result<()> {
    fs::create_dir_all(directory)?;
    // Append-only until the logging module (ADR-0002: daily rotation, 7 days kept) replaces it.
    let file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(directory.join("shell-errors.log"))?;
    write_record(file, message)
}

fn write_record(mut writer: impl Write, message: &str) -> io::Result<()> {
    writeln!(writer, "{message}")
}

#[cfg(test)]
mod tests {
    use std::time::{SystemTime, UNIX_EPOCH};

    use super::*;

    #[test]
    fn preserves_records_and_returns_write_failures() {
        let directory = std::env::temp_dir().join(format!(
            "folio-diagnostics-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
        ));
        append(&directory, "first").unwrap();
        append(&directory, "second").unwrap();
        let contents = fs::read_to_string(directory.join("shell-errors.log")).unwrap();
        fs::remove_dir_all(&directory).unwrap();
        assert_eq!(contents, "first\nsecond\n");

        let full: &mut [u8] = &mut [];
        assert_eq!(
            write_record(full, "failure").unwrap_err().kind(),
            io::ErrorKind::WriteZero
        );
    }
}
