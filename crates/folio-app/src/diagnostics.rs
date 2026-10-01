//! Daily UTC diagnostics under the local data directory (ADR-0002 §2, ipc-m1 §16.4).
//! Output failures must not panic across a Win32 callback.

use std::collections::VecDeque;
use std::fs::{self, DirEntry, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant, SystemTime};

use tauri::{AppHandle, Manager};
use time::format_description::well_known::Rfc3339;
use time::{Date, OffsetDateTime};

use crate::error::AppError;
use crate::ipc::log::LogUiError;
use crate::ipc::types::LIMITS;
use crate::library::io_error;

const UI_REPORTS_PER_MINUTE: usize = 30;
const MINUTE: Duration = Duration::from_secs(60);
/// Dates kept: today and the six before it.
const KEPT_DATES: i64 = 7;
/// What one date's file may hold before later records are dropped, whoever writes them: failed
/// file requests and UI reports both come from the page. Seven kept dates stay near 56 MiB.
const DAILY_BYTES: u64 = 8 * 1024 * 1024;
/// The longest `source` a UI report may name (ipc-m1 §16.4).
const SOURCE_BYTES: usize = 64;
/// The undated log the shell wrote before daily files.
const INTERIM_LOG: &str = "shell-errors.log";
const BUDGET_SPENT: &str = "shell \"daily log budget spent: later records today are dropped\"";

pub struct Logger {
    directory: Result<PathBuf, AppError>,
    // One writer for shell and UI records.
    state: Mutex<State>,
    // Only one UI call spawns a blocking writer; other calls wait on the async runtime.
    ui_writer: tauri::async_runtime::Mutex<()>,
}

#[derive(Default)]
struct State {
    recent: VecDeque<Instant>,
    /// UI reports not written since the last one that was: over the limit or the day's budget.
    dropped: u64,
    /// The UTC date retention last ran for. It runs with each date's first record, so a
    /// restarted shell prunes too.
    pruned: Option<Date>,
}

impl State {
    fn limited(&mut self, now: Instant) -> bool {
        while self
            .recent
            .front()
            .is_some_and(|time| now.saturating_duration_since(*time) >= MINUTE)
        {
            self.recent.pop_front();
        }
        if self.recent.len() < UI_REPORTS_PER_MINUTE {
            return false;
        }
        self.dropped = self.dropped.saturating_add(1);
        true
    }
}

impl Logger {
    pub fn new(data_dir: Result<PathBuf, AppError>) -> Self {
        Self {
            directory: data_dir.map(|path| path.join("logs")),
            state: Mutex::default(),
            ui_writer: tauri::async_runtime::Mutex::new(()),
        }
    }

    fn lock(&self) -> MutexGuard<'_, State> {
        crate::library::lock(&self.state)
    }

    fn shell_error(&self, message: &str) -> Result<(), AppError> {
        let record = format!("shell {message:?}");
        self.append(&mut self.lock(), OffsetDateTime::now_utc(), &record)?;
        Ok(())
    }

    pub async fn ui_error(self: &Arc<Self>, request: LogUiError) -> Result<(), AppError> {
        validate(&request)?;
        let _writer = self.ui_writer.lock().await;
        let log = self.clone();
        tauri::async_runtime::spawn_blocking(move || log.write_ui(&request))
            .await
            .map_err(|error| AppError::FileSystem(format!("UI log worker failed: {error}")))?
            .map_err(contract)
    }

    fn write_ui(&self, request: &LogUiError) -> Result<(), AppError> {
        let mut state = self.lock();
        if state.limited(Instant::now()) {
            return Ok(());
        }
        let record = format!(
            "ui {:?} source={} message={:?} stack={:?} dropped={}",
            request.kind, request.source, request.message, request.stack, state.dropped,
        );
        let result = self.append(&mut state, OffsetDateTime::now_utc(), &record);
        // Charge failures too, to bound retries when storage is unavailable. Count after I/O
        // so a slow disk cannot release a burst of expired reservations in one minute.
        state.recent.push_back(Instant::now());
        state.dropped = if result? {
            0
        } else {
            state.dropped.saturating_add(1)
        };
        Ok(())
    }

    /// Writes one record to `now`'s file and prunes with each date's first record. Returns
    /// `false` when the date's budget is spent and the record was dropped.
    fn append(
        &self,
        state: &mut State,
        now: OffsetDateTime,
        record: &str,
    ) -> Result<bool, AppError> {
        let directory = self.directory.as_deref().map_err(Clone::clone)?;
        fs::create_dir_all(directory).map_err(io_error)?;
        let today = now.date();
        if state.pruned != Some(today) {
            state.pruned = Some(today);
            // Retention is best effort: an expired file that another program holds open must
            // not stop today's records. The log keeps the reason, and the next date retries.
            if let Err(error) = prune(directory, today) {
                let note = format!("log retention failed: {error}");
                append(directory, now, &format!("shell {note:?}")).map_err(io_error)?;
            }
        }
        append(directory, now, record).map_err(io_error)
    }
}

/// The contract's codes for `log_ui_error`: the UI handles every logging failure alike.
fn contract(error: AppError) -> AppError {
    match error {
        AppError::InvalidArgument(_)
        | AppError::AccessDenied(_)
        | AppError::DiskFull(_)
        | AppError::FileSystem(_) => error,
        error => AppError::FileSystem(error.to_string()),
    }
}

fn validate(request: &LogUiError) -> Result<(), AppError> {
    if request.source.is_empty()
        || request.source.len() > SOURCE_BYTES
        || !request
            .source
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b".-_".contains(&byte))
    {
        return Err(AppError::InvalidArgument("invalid log source".to_owned()));
    }
    let limit = LIMITS.log_chars as usize;
    for text in std::iter::once(request.message.as_str()).chain(request.stack.as_deref()) {
        if text.chars().nth(limit).is_some() {
            return Err(AppError::InvalidArgument("log text is too long".to_owned()));
        }
    }
    Ok(())
}

pub fn report(app: &AppHandle, message: &str) {
    let result = app
        .try_state::<Arc<Logger>>()
        .ok_or_else(|| AppError::FileSystem("diagnostic state is missing".to_owned()))
        .and_then(|log| log.shell_error(message));
    if let Err(error) = result {
        let record = format!("shell {message:?} (diagnostic log unavailable: {error:?})");
        // stderr is the last sink: if it fails too, nothing is left to report to.
        let _ = line(OffsetDateTime::now_utc(), &record)
            .and_then(|line| io::stderr().lock().write_all(line.as_bytes()));
    }
}

/// Appends one record to `now`'s file unless that file has spent the date's budget; the record
/// that spends it is followed by a note that later ones are dropped. Returns whether it was
/// written.
fn append(directory: &Path, now: OffsetDateTime, record: &str) -> io::Result<bool> {
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(directory.join(file_name(now.date())))?;
    let used = file.metadata()?.len();
    if used >= DAILY_BYTES {
        return Ok(false);
    }
    let mut text = line(now, record)?;
    if used + text.len() as u64 >= DAILY_BYTES {
        text.push_str(&line(now, BUDGET_SPENT)?);
    }
    // One write per record, so concurrent writers never interleave inside a line.
    file.write_all(text.as_bytes())?;
    Ok(true)
}

fn line(now: OffsetDateTime, record: &str) -> io::Result<String> {
    let timestamp = now.format(&Rfc3339).map_err(io::Error::other)?;
    Ok(format!("{timestamp} {record}\n"))
}

fn file_name(date: Date) -> String {
    format!("shell-errors.{date}.log")
}

/// The date in a name [`file_name`] wrote; any other spelling is not one of this logger's files.
fn file_date(name: &str) -> Option<Date> {
    let date = name.strip_prefix("shell-errors.")?.strip_suffix(".log")?;
    let parsed = Date::parse(
        date,
        time::macros::format_description!("[year]-[month]-[day]"),
    )
    .ok()?;
    // `[year]` also reads `+2026` and `02026`.
    (date == parsed.to_string()).then_some(parsed)
}

/// Removes the files dated before the kept dates, and the interim log once it is as old. It
/// carries on past a file it cannot remove and returns the first error.
fn prune(directory: &Path, today: Date) -> io::Result<()> {
    let oldest = today.saturating_sub(time::Duration::days(KEPT_DATES - 1));
    let cutoff = SystemTime::from(oldest.midnight().assume_utc());
    let mut result = Ok(());
    for entry in fs::read_dir(directory)? {
        let removed = entry.and_then(|entry| {
            if !expired(&entry, oldest, cutoff)? {
                return Ok(());
            }
            match fs::remove_file(entry.path()) {
                // Another shell sharing the data directory pruned it first.
                Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
                removed => removed,
            }
        });
        result = result.and(removed);
    }
    result
}

fn expired(entry: &DirEntry, oldest: Date, cutoff: SystemTime) -> io::Result<bool> {
    // Links are never files here: on Windows `file_type` does not follow reparse points.
    if !entry.file_type()?.is_file() {
        return Ok(false);
    }
    Ok(match entry.file_name().to_str() {
        // The interim log has no date. Age it without reading any of its contents.
        Some(INTERIM_LOG) => entry.metadata()?.modified()? < cutoff,
        Some(name) => file_date(name).is_some_and(|date| date < oldest),
        None => false,
    })
}

#[cfg(test)]
mod tests;
