//! `Watcher`: one thread that reads a library's change records with `ReadDirectoryChangesExW`,
//! and hands the rescans they call for to a sink (docs/specs/windows-adapter.md §5.2).

#![allow(
    unsafe_code,
    reason = "Win32 FFI; each unsafe block states why it is sound"
)]

use std::io;
use std::mem::zeroed;
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
use std::path::Path;
use std::ptr::{null, null_mut};
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::Instant;

use windows_sys::Win32::Foundation::{ERROR_NOTIFY_ENUM_DIR, WAIT_OBJECT_0, WAIT_TIMEOUT};
use windows_sys::Win32::Storage::FileSystem::{
    FILE_NOTIFY_CHANGE_DIR_NAME, FILE_NOTIFY_CHANGE_FILE_NAME, FILE_NOTIFY_CHANGE_LAST_WRITE,
    FILE_NOTIFY_CHANGE_SIZE, ReadDirectoryChangesExW, ReadDirectoryNotifyExtendedInformation,
    ReadDirectoryNotifyInformation,
};
use windows_sys::Win32::System::IO::{CancelIoEx, GetOverlappedResult, OVERLAPPED};
use windows_sys::Win32::System::Threading::{
    CreateEventW, INFINITE, ResetEvent, SetEvent, WaitForMultipleObjects,
};

use super::handle::{self, Volume, unsupported};
use super::notify;
use crate::watch::{Coalescer, Record, Rescan, WatchOptions};

/// The most a read over the network asks for: SMB refuses larger ones.
const NETWORK_BUFFER_BYTES: usize = 64 * 1024;

/// What the wait returns for the stop event, the second handle.
const STOPPED: u32 = WAIT_OBJECT_0 + 1;

/// What a watcher hands its sink.
#[derive(Debug)]
pub enum WatchEvent {
    Rescan(Rescan),
    /// The watch ended, say because the library folder went away. A new watcher begins with a
    /// full rescan again.
    Failed(io::Error),
}

/// Watches a library folder and everything below it, until stopped or dropped.
#[derive(Debug)]
pub struct Watcher {
    stop: Arc<OwnedHandle>,
    thread: Option<JoinHandle<()>>,
}

impl Watcher {
    /// Starts watching `root`. `sink` runs on the watcher's thread and must not block: hand the
    /// event to a job queue.
    pub fn start(
        root: &Path,
        options: WatchOptions,
        mut sink: impl FnMut(WatchEvent) + Send + 'static,
    ) -> io::Result<Self> {
        let folder = handle::open_folder_overlapped(root)?;
        let bytes = if Volume::of(root, &folder)?.local {
            options.buffer_bytes
        } else {
            options.buffer_bytes.min(NETWORK_BUFFER_BYTES)
        };
        let done = event()?;
        let stop = Arc::new(event()?);
        let thread = std::thread::Builder::new()
            .name("folio-watcher".to_owned())
            .spawn({
                let stop = stop.clone();
                move || {
                    let reads = Reads::new(folder, done, bytes, options.file_ids);
                    if let Err(error) = run(reads, &stop, options, &mut sink) {
                        sink(WatchEvent::Failed(error));
                    }
                }
            })?;
        Ok(Self {
            stop,
            thread: Some(thread),
        })
    }

    /// Stops the watch and waits for its thread, as dropping the watcher does.
    pub fn stop(self) {
        drop(self);
    }
}

impl Drop for Watcher {
    fn drop(&mut self) {
        // SAFETY: `stop` is an open event handle.
        unsafe { SetEvent(self.stop.as_raw_handle()) };
        let Some(thread) = self.thread.take() else {
            return;
        };
        // Dropped by its own sink, the watcher cannot wait for its thread, which ends as soon as
        // the sink returns.
        if thread.thread().id() != std::thread::current().id() {
            // A panic on the thread has been reported by the panic hook; it holds nothing more.
            let _ = thread.join();
        }
    }
}

/// A manual-reset event, not signaled.
fn event() -> io::Result<OwnedHandle> {
    // SAFETY: no security attributes and no name.
    let event = unsafe { CreateEventW(null(), 1, 0, null()) };
    if event.is_null() {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: `event` is open, and nothing else owns it.
    Ok(unsafe { OwnedHandle::from_raw_handle(event) })
}

/// The overlapped reads of one folder's change records, at most one pending. While a read is
/// pending, Windows writes into `buffer` and `overlapped`: both are boxed so they never move, and
/// dropping waits for the read or its cancellation first.
struct Reads {
    folder: OwnedHandle,
    done: OwnedHandle,
    /// `u64`s, for the records' 8-byte fields.
    buffer: Box<[u64]>,
    overlapped: Box<OVERLAPPED>,
    extended: bool,
    pending: bool,
}

impl Reads {
    fn new(folder: OwnedHandle, done: OwnedHandle, bytes: usize, extended: bool) -> Self {
        // SAFETY: all zeros is a valid `OVERLAPPED`.
        let mut overlapped: Box<OVERLAPPED> = Box::new(unsafe { zeroed() });
        overlapped.hEvent = done.as_raw_handle();
        Self {
            folder,
            done,
            buffer: vec![0; bytes.div_ceil(8)].into_boxed_slice(),
            overlapped,
            extended,
            pending: false,
        }
    }

    /// Asks for the next records, plain ones where the extended ones are not available.
    fn arm(&mut self) -> io::Result<()> {
        loop {
            // SAFETY: `done` is an open event.
            unsafe { ResetEvent(self.done.as_raw_handle()) };
            let class = if self.extended {
                ReadDirectoryNotifyExtendedInformation
            } else {
                ReadDirectoryNotifyInformation
            };
            // SAFETY: `buffer` and `overlapped` stay where they are until the read completes
            // (`complete`) or its cancellation does (`drop`).
            let ok = unsafe {
                ReadDirectoryChangesExW(
                    self.folder.as_raw_handle(),
                    self.buffer.as_mut_ptr().cast(),
                    (self.buffer.len() * 8) as u32,
                    1,
                    FILE_NOTIFY_CHANGE_FILE_NAME
                        | FILE_NOTIFY_CHANGE_DIR_NAME
                        | FILE_NOTIFY_CHANGE_SIZE
                        | FILE_NOTIFY_CHANGE_LAST_WRITE,
                    null_mut(),
                    &mut *self.overlapped,
                    None,
                    class,
                )
            };
            if ok != 0 {
                self.pending = true;
                return Ok(());
            }
            let error = io::Error::last_os_error();
            if !(self.extended && unsupported(&error)) {
                return Err(error);
            }
            // exFAT and FAT have plain records only (docs/specs/windows-adapter.md §5.1).
            self.extended = false;
        }
    }

    /// The records of the pending read, once `done` is signaled; `None` when records were lost,
    /// as when the change buffer overflowed.
    fn complete(&mut self) -> io::Result<Option<Vec<Record>>> {
        let mut bytes = 0;
        // SAFETY: the read on `overlapped` has completed (its event is signaled), so this does
        // not wait; `bytes` is a valid out-pointer.
        let ok = unsafe {
            GetOverlappedResult(
                self.folder.as_raw_handle(),
                &*self.overlapped,
                &mut bytes,
                0,
            )
        };
        self.pending = false;
        if ok == 0 {
            let error = io::Error::last_os_error();
            return match error.raw_os_error().map(|code| code as u32) {
                Some(ERROR_NOTIFY_ENUM_DIR) => Ok(None),
                _ => Err(error),
            };
        }
        let length = (bytes as usize).min(self.buffer.len() * 8);
        if length == 0 {
            return Ok(None);
        }
        // SAFETY: the `u64`s are initialized, any byte is a valid `u8`, and `length` is within
        // the buffer.
        let buffer =
            unsafe { std::slice::from_raw_parts(self.buffer.as_ptr().cast::<u8>(), length) };
        // Records that cannot be read are as good as lost.
        Ok(notify::records(buffer, self.extended).ok())
    }
}

impl Drop for Reads {
    fn drop(&mut self) {
        if self.pending {
            let mut bytes = 0;
            // SAFETY: cancels this handle's pending read, then waits until Windows no longer
            // writes into `buffer` and `overlapped`, which are freed after this.
            unsafe {
                CancelIoEx(self.folder.as_raw_handle(), &*self.overlapped);
                GetOverlappedResult(
                    self.folder.as_raw_handle(),
                    &*self.overlapped,
                    &mut bytes,
                    1,
                );
            }
        }
    }
}

/// Reads records and hands the rescans they call for to `sink` until the stop event is set; an
/// error ends the watch.
fn run(
    mut reads: Reads,
    stop: &OwnedHandle,
    options: WatchOptions,
    sink: &mut impl FnMut(WatchEvent),
) -> io::Result<()> {
    let mut coalescer = Coalescer::new(options, Instant::now());
    reads.arm()?;
    loop {
        let now = Instant::now();
        if let Some(rescan) = coalescer.take(now) {
            sink(WatchEvent::Rescan(rescan));
            continue;
        }
        let wait = coalescer.due().saturating_duration_since(now);
        // One more millisecond, so that the wait never ends just before the due time.
        let timeout = u32::try_from(wait.as_millis())
            .map_or(INFINITE - 1, |ms| ms.saturating_add(1).min(INFINITE - 1));
        let handles = [reads.done.as_raw_handle(), stop.as_raw_handle()];
        // SAFETY: both handles are open events that outlive the wait.
        match unsafe { WaitForMultipleObjects(2, handles.as_ptr(), 0, timeout) } {
            WAIT_OBJECT_0 => {}
            WAIT_TIMEOUT => continue,
            STOPPED => return Ok(()),
            _ => return Err(io::Error::last_os_error()),
        }
        let records = reads.complete()?;
        let now = Instant::now();
        // Ask for the next records before working through these.
        reads.arm()?;
        match records {
            Some(records) => {
                for record in records {
                    coalescer.record(record, now);
                }
            }
            // Only a full rescan can tell what changed.
            None => coalescer.overflow(now),
        }
    }
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::sync::Mutex;
    use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
    use std::time::Duration;

    use super::*;
    use crate::test_support::{WATCH_TIMEOUT, next_rescan, path, quick_rescans, watch};

    /// Takes the first full rescan, then whatever comes until the folder has been quiet for half
    /// a second: NTFS updates the times of folders just written a little later.
    fn started(events: &Receiver<WatchEvent>) {
        assert_eq!(next_rescan(events), Rescan::Full);
        while events.recv_timeout(Duration::from_millis(500)).is_ok() {}
    }

    #[test]
    fn begins_with_a_full_rescan_then_scopes_what_changes() {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir_all(dir.path().join("秋/线代")).unwrap();
        let (_watcher, events) = watch(dir.path(), true);
        started(&events);

        fs::write(dir.path().join("秋/线代/笔记.md"), "# 特征值").unwrap();
        let written = path("秋/线代/笔记.md");
        let Rescan::Scopes(scopes) = next_rescan(&events) else {
            panic!("a scoped rescan");
        };
        assert!(
            scopes.iter().any(|scope| written.starts_with(scope)),
            "{scopes:?}"
        );
    }

    /// `秋/线代/作业/x.md` and an empty `秋/概率/作业`, being watched, then the file moved.
    fn moved_between_courses(file_ids: bool) -> (tempfile::TempDir, Watcher, Receiver<WatchEvent>) {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir_all(dir.path().join("秋/线代/作业")).unwrap();
        fs::create_dir_all(dir.path().join("秋/概率/作业")).unwrap();
        fs::write(dir.path().join("秋/线代/作业/x.md"), "x").unwrap();
        let (watcher, events) = watch(dir.path(), file_ids);
        started(&events);
        fs::rename(
            dir.path().join("秋/线代/作业/x.md"),
            dir.path().join("秋/概率/作业/x.md"),
        )
        .unwrap();
        (dir, watcher, events)
    }

    #[test]
    fn pairs_a_move_between_folders_by_file_id() {
        let (_dir, _watcher, events) = moved_between_courses(true);
        // One scope that holds both paths, so that the scan pairs the move.
        assert_eq!(next_rescan(&events), Rescan::Scopes(vec![path("秋")]));
    }

    /// Plain records pair nothing (the coalescer's tests show it); on NTFS they also carry the
    /// modification of every folder above a change, which here scopes all of `秋`.
    #[test]
    fn plain_records_cover_both_sides_of_a_move() {
        let (_dir, _watcher, events) = moved_between_courses(false);
        let Rescan::Scopes(scopes) = next_rescan(&events) else {
            panic!("a scoped rescan");
        };
        for moved in ["秋/线代/作业/x.md", "秋/概率/作业/x.md"] {
            assert!(
                scopes.iter().any(|scope| path(moved).starts_with(scope)),
                "{moved} in {scopes:?}"
            );
        }
    }

    #[test]
    fn lost_records_call_for_a_full_rescan() {
        let dir = tempfile::tempdir().unwrap();
        let (sender, events) = mpsc::channel();
        let (release, gate) = mpsc::channel::<()>();
        let mut first = true;
        let tiny = WatchOptions {
            buffer_bytes: 4096,
            ..quick_rescans(true)
        };
        let _watcher = Watcher::start(dir.path(), tiny, move |event| {
            let _ = sender.send(event);
            // Keep the watcher from reading while the test makes more changes than fit.
            if std::mem::take(&mut first) {
                let _ = gate.recv();
            }
        })
        .unwrap();
        assert_eq!(next_rescan(&events), Rescan::Full);
        for index in 0..2000 {
            fs::write(dir.path().join(format!("第{index}讲.md")), "x").unwrap();
        }
        release.send(()).unwrap();
        loop {
            match next_rescan(&events) {
                Rescan::Full => break,
                Rescan::Scopes(_) | Rescan::Metadata => continue,
            }
        }
    }

    #[test]
    fn stops_at_once_and_reports_nothing_after() {
        let dir = tempfile::tempdir().unwrap();
        let (watcher, events) = watch(dir.path(), true);
        assert_eq!(next_rescan(&events), Rescan::Full);
        let started = Instant::now();
        watcher.stop();
        assert!(started.elapsed() < Duration::from_secs(2));
        fs::write(dir.path().join("after.md"), "x").unwrap();
        assert!(events.recv_timeout(Duration::from_millis(500)).is_err());
    }

    #[test]
    fn a_sink_may_drop_its_own_watcher() {
        let dir = tempfile::tempdir().unwrap();
        let slot: Arc<Mutex<Option<Watcher>>> = Arc::default();
        let (sender, events) = mpsc::channel();
        let watcher = Watcher::start(dir.path(), quick_rescans(true), {
            let slot = slot.clone();
            move |event| {
                let _ = sender.send(event);
                let watcher = slot.lock().unwrap().take();
                drop(watcher);
            }
        })
        .unwrap();
        *slot.lock().unwrap() = Some(watcher);
        fs::write(dir.path().join("a.md"), "x").unwrap();
        // The thread ends once the sink returns, and the sink's sender with it.
        let deadline = Instant::now() + WATCH_TIMEOUT;
        loop {
            match events.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
                Ok(_) => {}
                Err(RecvTimeoutError::Disconnected) => break,
                Err(RecvTimeoutError::Timeout) => panic!("the watcher's thread did not end"),
            }
        }
        assert!(slot.lock().unwrap().is_none());
    }

    #[test]
    fn a_watch_whose_folder_goes_away_fails_and_ends() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("library");
        fs::create_dir(&root).unwrap();
        fs::write(root.join("a.md"), "x").unwrap();
        let (_watcher, events) = watch(&root, true);
        assert_eq!(next_rescan(&events), Rescan::Full);
        // Watching shares deletion, so the folder can go.
        fs::remove_dir_all(&root).unwrap();
        let failed = events
            .recv_timeout(WATCH_TIMEOUT)
            .expect("an event in time");
        assert!(matches!(failed, WatchEvent::Failed(_)), "{failed:?}");
        // The thread has ended.
        assert!(events.recv_timeout(WATCH_TIMEOUT).is_err());
    }

    /// Plain records on a volume without the extended ones.
    #[test]
    #[ignore = "needs FOLIO_TEST_NON_NTFS_DIR, a folder on a volume that is not NTFS"]
    fn off_ntfs_falls_back_to_plain_records() {
        let dir = tempfile::tempdir_in(super::super::non_ntfs_dir()).unwrap();
        // Asked for extended records, which exFAT refuses.
        let (_watcher, events) = watch(dir.path(), true);
        assert_eq!(next_rescan(&events), Rescan::Full);
        fs::write(dir.path().join("笔记.md"), "x").unwrap();
        assert_eq!(next_rescan(&events), Rescan::Scopes(vec![path("笔记.md")]));
    }
}
