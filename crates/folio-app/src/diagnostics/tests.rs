use std::fs::{File, FileTimes};
use std::os::windows::fs::OpenOptionsExt;
use std::time::SystemTime;

use tauri::async_runtime::block_on;
use tempfile::{TempDir, tempdir};
use time::macros::datetime;
use windows_sys::Win32::Storage::FileSystem::FILE_SHARE_READ;

use super::*;
use crate::ipc::log::UiErrorKind;

fn request() -> LogUiError {
    LogUiError {
        kind: UiErrorKind::Command,
        source: "windowControls.minimize".to_owned(),
        message: "window command failed".to_owned(),
        stack: None,
    }
}

fn logger(data: &TempDir) -> Arc<Logger> {
    Arc::new(Logger::new(Ok(data.path().to_owned())))
}

/// Writes through the logger as a report at `now` would.
fn append_at(log: &Logger, now: OffsetDateTime, record: &str) -> bool {
    log.append(&mut log.lock(), now, record).unwrap()
}

/// Every log file in date order, so a test that runs across UTC midnight reads both.
fn logs(data: &TempDir) -> String {
    let mut paths = fs::read_dir(data.path().join("logs"))
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .collect::<Vec<_>>();
    paths.sort();
    paths
        .iter()
        .map(|path| fs::read_to_string(path).unwrap())
        .collect()
}

#[test]
fn records_append_with_utc_timestamps_and_rotate_at_midnight() {
    let directory = tempdir().unwrap();
    let before = datetime!(2024-02-28 23:59:59 UTC);
    let after = datetime!(2024-02-29 0:00 UTC);
    append(directory.path(), before, "first").unwrap();
    append(directory.path(), before, "second").unwrap();
    append(directory.path(), after, "third").unwrap();
    assert_eq!(
        fs::read_to_string(directory.path().join("shell-errors.2024-02-28.log")).unwrap(),
        "2024-02-28T23:59:59Z first\n2024-02-28T23:59:59Z second\n"
    );
    assert_eq!(
        fs::read_to_string(directory.path().join("shell-errors.2024-02-29.log")).unwrap(),
        "2024-02-29T00:00:00Z third\n"
    );
}

#[test]
fn retention_keeps_seven_dates_across_year_end_once_a_date_and_after_an_idle_restart() {
    let data = tempdir().unwrap();
    let logs = data.path().join("logs");
    let log = logger(&data);
    let last = datetime!(2026-01-02 12:00 UTC);
    for days in (0..10).rev() {
        append_at(&log, last - time::Duration::days(days), "record");
    }
    assert_eq!(fs::read_dir(&logs).unwrap().count(), 7);
    assert!(logs.join("shell-errors.2025-12-27.log").is_file());
    assert!(!logs.join("shell-errors.2025-12-26.log").exists());

    // Retention runs with a date's first record only.
    let old = logs.join("shell-errors.2025-12-01.log");
    fs::write(&old, "old").unwrap();
    append_at(&log, last, "same date");
    assert!(old.exists());

    // A restarted shell prunes with its first record, after an idle gap too.
    append_at(
        &logger(&data),
        datetime!(2026-01-20 12:00 UTC),
        "after idle gap",
    );
    assert!(!old.exists());
    assert_eq!(fs::read_dir(&logs).unwrap().count(), 1);
}

#[test]
fn pruning_leaves_unrelated_files_directories_and_future_dates_untouched() {
    let directory = tempdir().unwrap();
    for name in [
        "user-data.txt",
        "shell-errors.2026-02-30.log",
        "shell-errors.2026-01-01.log.bak",
        "other.2026-01-01.log",
        "shell-errors.2026-10-01.log",
        "shell-errors.+2026-01-01.log",
        "shell-errors.02026-01-01.log",
    ] {
        fs::write(directory.path().join(name), "preserve").unwrap();
    }
    fs::create_dir(directory.path().join("shell-errors.2026-01-01.log")).unwrap();
    prune(directory.path(), datetime!(2026-09-30 0:00 UTC).date()).unwrap();
    assert_eq!(fs::read_dir(directory.path()).unwrap().count(), 8);
}

#[test]
fn an_expired_file_another_program_holds_is_kept_without_losing_records() {
    let data = tempdir().unwrap();
    let logs = data.path().join("logs");
    fs::create_dir(&logs).unwrap();
    let expired = logs.join("shell-errors.2026-09-01.log");
    let older = logs.join("shell-errors.2026-08-31.log");
    fs::write(&older, "old").unwrap();
    // Open the way a viewer that does not share deletion does.
    let held = File::options()
        .create(true)
        .write(true)
        .share_mode(FILE_SHARE_READ)
        .open(&expired)
        .unwrap();
    let log = logger(&data);
    assert!(append_at(&log, datetime!(2026-09-30 12:00 UTC), "kept"));
    let today = fs::read_to_string(logs.join("shell-errors.2026-09-30.log")).unwrap();
    assert_eq!(today.lines().count(), 2);
    assert!(today.contains("shell \"log retention failed: "));
    assert!(today.ends_with(" kept\n"));
    assert!(expired.exists());
    assert!(!older.exists());

    drop(held);
    append_at(&log, datetime!(2026-10-01 12:00 UTC), "next date");
    assert!(!expired.exists());
}

#[test]
fn the_interim_log_expires_by_modified_date_without_overwriting_it() {
    let directory = tempdir().unwrap();
    let path = directory.path().join("shell-errors.log");
    let mut file = File::create(&path).unwrap();
    file.write_all(b"interim diagnostic").unwrap();
    file.set_times(
        FileTimes::new().set_modified(SystemTime::from(datetime!(2026-09-24 23:59 UTC))),
    )
    .unwrap();
    prune(directory.path(), datetime!(2026-09-30 0:00 UTC).date()).unwrap();
    assert_eq!(fs::read_to_string(&path).unwrap(), "interim diagnostic");
    prune(directory.path(), datetime!(2026-10-01 0:00 UTC).date()).unwrap();
    assert!(!path.exists());
}

#[test]
fn a_far_future_interim_mtime_cannot_panic_or_poison_the_callback_writer() {
    let data = tempdir().unwrap();
    let logs = data.path().join("logs");
    fs::create_dir(&logs).unwrap();
    let legacy = logs.join("shell-errors.log");
    let file = File::create(&legacy).unwrap();
    // Windows FILETIME supports dates beyond time's year-9999 ceiling.
    let future = SystemTime::UNIX_EPOCH + Duration::from_secs(300_000_000_000);
    file.set_times(FileTimes::new().set_modified(future))
        .unwrap();
    let log = logger(&data);
    log.shell_error("callback diagnostic").unwrap();
    assert!(legacy.is_file());
    assert!(!log.state.is_poisoned());
}

#[test]
fn the_record_that_spends_the_daily_budget_says_so_and_later_ones_are_dropped() {
    let data = tempdir().unwrap();
    let logs = data.path().join("logs");
    fs::create_dir(&logs).unwrap();
    let full = logs.join("shell-errors.2026-09-30.log");
    fs::write(&full, vec![b'x'; DAILY_BYTES as usize - 10]).unwrap();
    let log = logger(&data);
    let now = datetime!(2026-09-30 12:00 UTC);
    assert!(append_at(&log, now, "spends the budget"));
    let size = fs::metadata(&full).unwrap().len();
    assert!(!append_at(&log, now, "dropped"));
    assert_eq!(fs::metadata(&full).unwrap().len(), size);
    let contents = fs::read_to_string(&full).unwrap();
    assert!(contents.ends_with(&format!(
        "x2026-09-30T12:00:00Z spends the budget\n2026-09-30T12:00:00Z {BUDGET_SPENT}\n"
    )));
    // The next date has its own budget.
    assert!(append_at(&log, now + time::Duration::days(1), "next date"));
}

#[test]
fn ui_reports_over_the_daily_budget_count_as_dropped() {
    let data = tempdir().unwrap();
    let logs = data.path().join("logs");
    fs::create_dir(&logs).unwrap();
    let full = logs.join(file_name(OffsetDateTime::now_utc().date()));
    fs::write(&full, vec![b'x'; DAILY_BYTES as usize]).unwrap();
    let log = logger(&data);
    log.write_ui(&request()).unwrap();
    block_on(log.ui_error(request())).unwrap();
    log.shell_error("shell records are dropped too").unwrap();
    assert_eq!(log.lock().dropped, 2);
    assert_eq!(fs::metadata(&full).unwrap().len(), DAILY_BYTES);
}

#[test]
fn unicode_scalar_limits_accept_the_boundary_and_reject_each_oversized_field() {
    let mut request = request();
    request.source = "x".repeat(SOURCE_BYTES);
    request.message = "😀".repeat(LIMITS.log_chars as usize);
    request.stack = Some("界".repeat(LIMITS.log_chars as usize));
    validate(&request).unwrap();
    request.message.push('x');
    assert!(matches!(
        validate(&request),
        Err(AppError::InvalidArgument(_))
    ));
    request.message.pop();
    request.stack.as_mut().unwrap().push('x');
    assert!(matches!(
        validate(&request),
        Err(AppError::InvalidArgument(_))
    ));
}

#[test]
fn invalid_sources_kinds_and_surrogates_are_rejected_before_any_write() {
    let data = tempdir().unwrap();
    let log = logger(&data);
    for source in [
        "",
        "../secret",
        "C:\\library",
        "界",
        "line\nforged",
        &"x".repeat(SOURCE_BYTES + 1),
    ] {
        let mut request = request();
        request.source = source.to_owned();
        assert!(matches!(
            block_on(log.ui_error(request)),
            Err(AppError::InvalidArgument(_))
        ));
    }
    for json in [
        r#"{"kind":"other","source":"preview","message":"error","stack":null}"#,
        r#"{"kind":"uncaught","source":"preview","message":"\ud800","stack":null}"#,
    ] {
        assert!(serde_json::from_str::<LogUiError>(json).is_err());
    }
    assert!(!data.path().join("logs").exists());
    assert!(log.lock().recent.is_empty());
}

#[test]
fn shell_and_ui_text_cannot_forge_records_or_control_the_terminal() {
    let data = tempdir().unwrap();
    let log = logger(&data);
    let forged = "error\n2026-01-01T00:00:00Z fake\r\0\t\u{1b}\u{85}\u{2028}\u{2029}\"\\";
    log.shell_error(forged).unwrap();
    let mut request = request();
    request.message = forged.to_owned();
    request.stack = Some(forged.to_owned());
    block_on(log.ui_error(request)).unwrap();
    let contents = logs(&data);
    assert_eq!(contents.lines().count(), 2);
    assert_eq!(contents.matches("fake").count(), 3);
    assert!(contents.chars().all(|ch| ch == '\n' || !ch.is_control()));
    assert!(!contents.contains(['\u{2028}', '\u{2029}']));
}

#[test]
fn the_limit_is_a_rolling_minute_and_drop_counts_saturate() {
    let start = Instant::now();
    let mut state = State::default();
    state.recent.push_back(start);
    state
        .recent
        .extend(std::iter::repeat_n(start + Duration::from_secs(59), 29));
    assert!(state.limited(start + Duration::from_secs(59)));
    assert!(!state.limited(start + MINUTE));
    assert_eq!(state.recent.len(), 29);
    state.recent.push_back(start + MINUTE);
    assert!(state.limited(start + Duration::from_secs(61)));
    assert!(!state.limited(start + Duration::from_secs(119)));
    state
        .recent
        .extend(std::iter::repeat_n(start + Duration::from_secs(119), 29));
    state.dropped = u64::MAX;
    assert!(state.limited(start + Duration::from_secs(119)));
    assert_eq!(state.dropped, u64::MAX);
}

#[test]
fn excess_reports_succeed_and_the_next_kept_ui_record_reports_the_drops_once() {
    let data = tempdir().unwrap();
    let log = logger(&data);
    for _ in 0..34 {
        log.write_ui(&request()).unwrap();
    }
    log.shell_error("shell reports bypass the UI rate limit")
        .unwrap();
    assert_eq!(log.lock().dropped, 4);
    log.lock().recent.clear();
    log.write_ui(&request()).unwrap();
    log.write_ui(&request()).unwrap();
    let contents = logs(&data);
    assert_eq!(contents.lines().count(), 33);
    assert_eq!(contents.matches("dropped=4").count(), 1);
    assert!(contents.lines().last().unwrap().ends_with("dropped=0"));
}

#[test]
fn failures_keep_the_contract_codes_and_recover_without_losing_the_drop_summary() {
    assert!(matches!(
        contract(io_error(io::ErrorKind::PermissionDenied.into())),
        AppError::AccessDenied(_)
    ));
    assert!(matches!(
        contract(io_error(io::ErrorKind::StorageFull.into())),
        AppError::DiskFull(_)
    ));
    // A sharing violation or a missing data directory has no code of its own here.
    assert!(matches!(
        contract(io_error(io::Error::from_raw_os_error(32))),
        AppError::FileSystem(_)
    ));
    assert!(matches!(
        contract(AppError::DataDirUnavailable("unset".to_owned())),
        AppError::FileSystem(_)
    ));
    let data = tempdir().unwrap();
    let log = logger(&data);
    let blocker = data.path().join("logs");
    fs::write(&blocker, "blocked").unwrap();
    log.lock().dropped = 7;
    assert!(matches!(
        block_on(log.ui_error(request())),
        Err(AppError::FileSystem(_))
    ));
    assert_eq!(log.lock().dropped, 7);
    assert_eq!(log.lock().recent.len(), 1);
    fs::remove_file(blocker).unwrap();
    log.write_ui(&request()).unwrap();
    assert_eq!(log.lock().dropped, 0);
}

#[test]
fn concurrent_writers_preserve_whole_records_and_share_the_ui_limit() {
    let data = tempdir().unwrap();
    let log = logger(&data);
    std::thread::scope(|scope| {
        for _ in 0..8 {
            scope.spawn(|| {
                for _ in 0..5 {
                    log.write_ui(&request()).unwrap();
                    log.shell_error("shell failure").unwrap();
                }
            });
        }
    });
    let contents = logs(&data);
    assert_eq!(contents.lines().count(), 70);
    assert_eq!(
        contents.matches("source=windowControls.minimize").count(),
        30
    );
    assert_eq!(contents.matches("shell failure").count(), 40);
    assert_eq!(log.lock().dropped, 10);
    for line in contents.lines() {
        OffsetDateTime::parse(line.split_once(' ').unwrap().0, &Rfc3339).unwrap();
    }
}

#[test]
fn the_log_capability_is_main_window_only_and_grants_one_individual_permission() {
    let capability: serde_json::Value =
        serde_json::from_str(include_str!("../../capabilities/log.json")).unwrap();
    assert_eq!(capability["windows"], serde_json::json!(["main"]));
    assert_eq!(
        capability["permissions"],
        serde_json::json!(["allow-log-ui-error"])
    );
    assert!(capability.get("remote").is_none());
}
