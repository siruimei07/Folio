//! `WindowsRecycleBin`: the shell's `IFileOperation`, with a guard that refuses every item the
//! Recycle Bin cannot take, so nothing is ever deleted for good, and a look at the item first, so
//! that a cloud provider's trash takes only files whose content is in the cloud alone
//! (docs/specs/windows-adapter.md §4.1).

#![allow(
    unsafe_code,
    reason = "COM FFI; each unsafe block states why it is sound"
)]

use std::cell::Cell;
use std::ffi::OsString;
use std::os::windows::ffi::{OsStrExt, OsStringExt};
use std::path::{Component, Path, PathBuf, Prefix};
use std::thread::Builder;

use windows::Win32::Foundation::{
    E_ABORT, E_ACCESSDENIED, ERROR_CLOUD_FILE_NOT_SUPPORTED, ERROR_FILE_NOT_FOUND,
    ERROR_LOCK_VIOLATION, ERROR_PATH_NOT_FOUND, ERROR_SHARING_VIOLATION,
};
use windows::Win32::System::Com::{
    CLSCTX_ALL, COINIT_APARTMENTTHREADED, COINIT_DISABLE_OLE1DDE, CoCreateInstance, CoInitializeEx,
    CoTaskMemFree, CoUninitialize,
};
use windows::Win32::UI::Shell::{
    COPYENGINE_E_ACCESS_DENIED_DEST, COPYENGINE_E_ACCESS_DENIED_SRC,
    COPYENGINE_E_ACCESSDENIED_READONLY, COPYENGINE_E_PATH_NOT_FOUND_SRC,
    COPYENGINE_E_RECYCLE_BIN_NOT_FOUND, COPYENGINE_E_RECYCLE_FORCE_NUKE,
    COPYENGINE_E_RECYCLE_PATH_TOO_LONG, COPYENGINE_E_RECYCLE_SIZE_TOO_BIG,
    COPYENGINE_E_RECYCLE_UNKNOWN_ERROR, COPYENGINE_E_SHARING_VIOLATION_DEST,
    COPYENGINE_E_SHARING_VIOLATION_SRC, FOF_ALLOWUNDO, FOF_NO_UI, FOFX_EARLYFAILURE,
    FOFX_RECYCLEONDELETE, FileOperation, IFileOperation, IFileOperationProgressSink,
    IFileOperationProgressSink_Impl, IShellItem, SHCreateItemFromParsingName, SIGDN_FILESYSPATH,
    TSF_DELETE_RECYCLE_IF_POSSIBLE,
};
use windows::core::{ComObject, Error, HRESULT, HSTRING, PCWSTR, Ref, Result, implement};

use super::handle;
use super::{StaError, in_sta};
use crate::fs::{FileSystem, StdFileSystem};
use crate::recycle::{
    RecycleBin, RecycleError, RecycleFailure, Recycled, check, destination, is_there,
};

/// The Recycle Bin of Windows.
#[derive(Debug, Clone, Copy, Default)]
pub struct WindowsRecycleBin;

impl RecycleBin for WindowsRecycleBin {
    fn recycle(&self, path: &Path) -> std::result::Result<Recycled, RecycleError> {
        // std's attributes tell placeholders, from handles and listings alike, without opening
        // or downloading any file (§3.1).
        recycle_with(&StdFileSystem, path, perform)
    }
}

/// `WindowsRecycleBin::recycle`, with the look before the shell through `fs` and the shell's
/// operation run by `perform`, which tests replace.
fn recycle_with(
    fs: &dyn FileSystem,
    path: &Path,
    perform: impl FnOnce(&IShellItem, &IFileOperationProgressSink) -> Result<()> + Send,
) -> std::result::Result<Recycled, RecycleError> {
    check(path)?;
    let Paths { plain, exact } = paths(path).ok_or_else(|| {
        RecycleError::new(
            path,
            RecycleFailure::Invalid,
            "not a path the shell can take",
        )
    })?;
    let recycled = destination(fs, &exact).and_then(|destination| {
        in_sta(Builder::new(), initialize_sta, || {
            recycle_item(&plain, &exact, destination, perform)
        })
        .unwrap_or_else(|error| worker_error(&plain, error))
    });
    // Errors name the path the shell takes, whichever path a look used.
    recycled.map_err(|error| RecycleError {
        path: plain,
        ..error
    })
}

/// The path asked for, rebuilt name by name after its drive or share, so that no name gains a
/// meaning Win32 gives it outside a verbatim path (`\\?\C:\\srv\share` would become a share).
#[derive(Debug)]
struct Paths {
    /// As the shell's parser takes it: without `\\?\`, which it rejects (`E_INVALIDARG`).
    plain: PathBuf,
    /// In verbatim form, which names exactly what is on disk: for the look before the shell and
    /// the file the shell's item must be. In a plain path Win32 drops trailing dots from names, and
    /// trailing spaces from the last one, so a folder `作业.` would be read as its sibling `作业`,
    /// or not at all (measured 2026-10-05).
    exact: PathBuf,
}

/// `None` for anything but a drive or share path of ordinary names.
fn paths(path: &Path) -> Option<Paths> {
    let mut components = path.components();
    let Component::Prefix(prefix) = components.next()? else {
        return None;
    };
    let (mut plain, mut exact) = match prefix.kind() {
        Prefix::Disk(letter) | Prefix::VerbatimDisk(letter) => {
            let drive = format!("{}:", char::from(letter));
            (
                OsString::from(&drive),
                OsString::from(format!(r"\\?\{drive}")),
            )
        }
        Prefix::UNC(server, share) | Prefix::VerbatimUNC(server, share) => {
            let mut plain = OsString::from(r"\\");
            let mut exact = OsString::from(r"\\?\UNC\");
            for path in [&mut plain, &mut exact] {
                path.push(server);
                path.push(r"\");
                path.push(share);
            }
            (plain, exact)
        }
        _ => return None,
    };
    if components.next()? != Component::RootDir {
        return None;
    }
    let mut names = 0;
    for component in components {
        let Component::Normal(name) = component else {
            return None;
        };
        let special = name.is_empty() || name == "." || name == "..";
        if special
            || name
                .encode_wide()
                .any(|unit| unit == u16::from(b'/') || unit == 0)
        {
            return None;
        }
        for path in [&mut plain, &mut exact] {
            path.push(r"\");
            path.push(name);
        }
        names += 1;
    }
    (names > 0).then(|| Paths {
        plain: plain.into(),
        exact: exact.into(),
    })
}

fn initialize_sta() -> Result<Apartment> {
    // SAFETY: in_sta calls this on a fresh thread; Apartment undoes every successful call there.
    unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE) }.ok()?;
    Ok(Apartment)
}

fn worker_error(path: &Path, error: StaError) -> std::result::Result<Recycled, RecycleError> {
    match error {
        StaError::Initialize(error) => Err(error_of(path, &error)),
        // Preserve scope.spawn's spawn-failure panic and the original worker panic payload.
        StaError::Spawn(error) => panic!("failed to spawn thread: {error:?}"),
        StaError::Panicked(payload) => std::panic::resume_unwind(payload),
    }
}

/// Undoes `CoInitializeEx` when the thread is done with COM.
struct Apartment;

impl Drop for Apartment {
    fn drop(&mut self) {
        // SAFETY: pairs with the successful `CoInitializeEx` that made this value.
        unsafe { CoUninitialize() };
    }
}

/// Hands the item at `plain` to the shell's operation, `perform`, which should put it where
/// `destination` says. The item must be the file at `exact`, the same path in verbatim form.
fn recycle_item(
    plain: &Path,
    exact: &Path,
    destination: Recycled,
    perform: impl FnOnce(&IShellItem, &IFileOperationProgressSink) -> Result<()>,
) -> std::result::Result<Recycled, RecycleError> {
    let item = parse(plain).map_err(|error| match error.failure {
        // Win32 drops a trailing dot from each name of a plain path, and a trailing space from the
        // last, so the parser does not find `a.md.` or anything in `作业.` (measured 2026-10-05).
        // The item is gone only if its exact path agrees.
        RecycleFailure::NotFound if is_there(&StdFileSystem, exact) => RecycleError {
            failure: RecycleFailure::Other,
            detail: format!(
                "{}; it is still there, by a name the shell cannot take",
                error.detail
            ),
            ..error
        },
        _ => error,
    })?;
    let file = identity(exact)?;
    if !is_same_file(&item, file, plain)? {
        return Err(RecycleError::new(
            plain,
            RecycleFailure::Invalid,
            "the shell resolves this path to another file",
        ));
    }
    let guard = ComObject::new(Guard::default());
    let performed = perform(&item, &guard.to_interface());
    let report = Report {
        refused: guard.refused.get(),
        posted: guard.posted.get(),
        failed: guard.failed.get(),
        recycled: guard.recycled.get(),
        performed,
    };
    outcome(plain, destination, report, || gone(exact, file))
}

/// What the shell reported for the one item of an operation.
#[derive(Debug)]
struct Report {
    /// The guard refused the item.
    refused: bool,
    /// The shell reported the item's result.
    posted: bool,
    /// The item's failure.
    failed: Option<HRESULT>,
    /// The item went to the Recycle Bin.
    recycled: bool,
    /// The whole operation's result.
    performed: Result<()>,
}

/// Where the item went, from what the shell reported and, for a file only in the cloud that is
/// not in the Recycle Bin, from whether it left its path (`gone`, asked only then).
fn outcome(
    path: &Path,
    destination: Recycled,
    report: Report,
    gone: impl FnOnce() -> std::result::Result<bool, RecycleError>,
) -> std::result::Result<Recycled, RecycleError> {
    const CLOUD_FILE_NOT_SUPPORTED: HRESULT = HRESULT::from_win32(ERROR_CLOUD_FILE_NOT_SUPPORTED.0);
    // The shell deletes a file only in the cloud instead of recycling it, and its provider keeps it
    // in its trash. Measured: the item done and nothing in the Recycle Bin. The field test also saw
    // ERROR_CLOUD_FILE_NOT_SUPPORTED once, maybe for such a file.
    let to_cloud = destination == Recycled::CloudTrash;
    if report.refused {
        return Err(RecycleError::new(
            path,
            RecycleFailure::Unrecyclable,
            "the shell would have deleted it for good",
        ));
    }
    if let Some(code) = report
        .failed
        .filter(|&code| !(to_cloud && code == CLOUD_FILE_NOT_SUPPORTED))
    {
        return Err(error_of(path, &code.into()));
    }
    // The item's own result says where it is, whatever else the operation reports. A file only
    // in the cloud gets here when something downloaded it in the meantime.
    if report.recycled {
        return Ok(Recycled::RecycleBin);
    }
    let error = match (report.failed, report.performed) {
        (Some(code), _) => error_of(path, &code.into()),
        (None, Err(error)) => error_of(path, &error),
        (None, Ok(())) => RecycleError::new(
            path,
            RecycleFailure::Other,
            "the shell reported nothing in the Recycle Bin",
        ),
    };
    if !(to_cloud && report.posted) {
        return Err(error);
    }
    match gone() {
        Ok(true) => Ok(Recycled::CloudTrash),
        Ok(false) => Err(error),
        // The shell's report stays the error; a failed look at the path only adds to it.
        Err(check) => Err(RecycleError {
            detail: format!("{}; then {}", error.detail, check.detail),
            ..error
        }),
    }
}

fn parse(path: &Path) -> std::result::Result<IShellItem, RecycleError> {
    // SAFETY: the string outlives the call.
    unsafe { SHCreateItemFromParsingName(&HSTRING::from(path), None) }
        .map_err(|error| error_of(path, &error))
}

/// Whether the shell's item is `file`, the file at `path`. The parser follows folder shortcuts
/// and namespace junctions (`name.{CLSID}`), so a path can stand for another file than the one on
/// disk; the volume and file index say which file it is.
fn is_same_file(
    item: &IShellItem,
    file: Identity,
    path: &Path,
) -> std::result::Result<bool, RecycleError> {
    // SAFETY: a COM call on an item this thread made.
    let name = unsafe { item.GetDisplayName(SIGDN_FILESYSPATH) }.map_err(|_| {
        RecycleError::new(
            path,
            RecycleFailure::Invalid,
            "the shell does not see a file here",
        )
    })?;
    // SAFETY: the shell allocated `name` as a NUL-terminated string for us to free, which
    // happens right after the copy.
    let parsed = unsafe {
        let parsed = PathBuf::from(OsString::from_wide(name.as_wide()));
        CoTaskMemFree(Some(name.0.cast_const().cast()));
        parsed
    };
    Ok(identity(&parsed)? == file)
}

/// A file's volume serial number and file index.
type Identity = (u32, u32, u32);

fn identity(path: &Path) -> std::result::Result<Identity, RecycleError> {
    let basic = handle::open_attributes(path)
        .and_then(|file| handle::basic_information(&file))
        .map_err(|error| RecycleError::of_io(path, &error))?;
    Ok((
        basic.dwVolumeSerialNumber,
        basic.nFileIndexHigh,
        basic.nFileIndexLow,
    ))
}

/// Whether `file` left `path`: nothing is there any more, or another file is.
fn gone(path: &Path, file: Identity) -> std::result::Result<bool, RecycleError> {
    match identity(path) {
        Ok(now) => Ok(now != file),
        Err(error) if error.failure == RecycleFailure::NotFound => Ok(true),
        Err(error) => Err(error),
    }
}

/// Moves `item` to the Recycle Bin, watched by `sink`.
fn perform(item: &IShellItem, sink: &IFileOperationProgressSink) -> Result<()> {
    // SAFETY: COM calls on objects this thread made, with arguments that outlive the calls.
    unsafe {
        let operation: IFileOperation = CoCreateInstance(&FileOperation, None, CLSCTX_ALL)?;
        operation.SetOperationFlags(
            FOF_ALLOWUNDO | FOFX_RECYCLEONDELETE | FOF_NO_UI | FOFX_EARLYFAILURE,
        )?;
        operation.Advise(sink)?;
        operation.DeleteItem(item, None)?;
        operation.PerformOperations()
    }
}

/// Watches the deletion: refuses an item unless it goes to the Recycle Bin, and keeps the
/// results. The shell calls it on the operation's thread, one callback at a time.
#[implement(IFileOperationProgressSink)]
#[derive(Default)]
struct Guard {
    /// An item that the shell would have deleted for good was refused.
    refused: Cell<bool>,
    /// The shell reported an item's result.
    posted: Cell<bool>,
    /// The first failure the shell reported for an item.
    failed: Cell<Option<HRESULT>>,
    /// An item went to the Recycle Bin.
    recycled: Cell<bool>,
}

impl IFileOperationProgressSink_Impl for Guard_Impl {
    fn PreDeleteItem(&self, flags: u32, _item: Ref<'_, IShellItem>) -> Result<()> {
        if flags & TSF_DELETE_RECYCLE_IF_POSSIBLE.0 as u32 == 0 {
            // Without this flag the shell deletes the item for good.
            self.refused.set(true);
            return Err(E_ABORT.into());
        }
        Ok(())
    }

    fn PostDeleteItem(
        &self,
        _flags: u32,
        _item: Ref<'_, IShellItem>,
        result: HRESULT,
        recycled: Ref<'_, IShellItem>,
    ) -> Result<()> {
        self.posted.set(true);
        if result.is_err() {
            if self.failed.get().is_none() {
                self.failed.set(Some(result));
            }
        } else if recycled.as_ref().is_some() {
            self.recycled.set(true);
        }
        Ok(())
    }

    fn StartOperations(&self) -> Result<()> {
        Ok(())
    }

    fn FinishOperations(&self, _result: HRESULT) -> Result<()> {
        Ok(())
    }

    fn PreRenameItem(&self, _: u32, _: Ref<'_, IShellItem>, _: &PCWSTR) -> Result<()> {
        Ok(())
    }

    fn PostRenameItem(
        &self,
        _: u32,
        _: Ref<'_, IShellItem>,
        _: &PCWSTR,
        _: HRESULT,
        _: Ref<'_, IShellItem>,
    ) -> Result<()> {
        Ok(())
    }

    fn PreMoveItem(
        &self,
        _: u32,
        _: Ref<'_, IShellItem>,
        _: Ref<'_, IShellItem>,
        _: &PCWSTR,
    ) -> Result<()> {
        Ok(())
    }

    fn PostMoveItem(
        &self,
        _: u32,
        _: Ref<'_, IShellItem>,
        _: Ref<'_, IShellItem>,
        _: &PCWSTR,
        _: HRESULT,
        _: Ref<'_, IShellItem>,
    ) -> Result<()> {
        Ok(())
    }

    fn PreCopyItem(
        &self,
        _: u32,
        _: Ref<'_, IShellItem>,
        _: Ref<'_, IShellItem>,
        _: &PCWSTR,
    ) -> Result<()> {
        Ok(())
    }

    fn PostCopyItem(
        &self,
        _: u32,
        _: Ref<'_, IShellItem>,
        _: Ref<'_, IShellItem>,
        _: &PCWSTR,
        _: HRESULT,
        _: Ref<'_, IShellItem>,
    ) -> Result<()> {
        Ok(())
    }

    fn PreNewItem(&self, _: u32, _: Ref<'_, IShellItem>, _: &PCWSTR) -> Result<()> {
        Ok(())
    }

    fn PostNewItem(
        &self,
        _: u32,
        _: Ref<'_, IShellItem>,
        _: &PCWSTR,
        _: &PCWSTR,
        _: u32,
        _: HRESULT,
        _: Ref<'_, IShellItem>,
    ) -> Result<()> {
        Ok(())
    }

    fn UpdateProgress(&self, _: u32, _: u32) -> Result<()> {
        Ok(())
    }

    fn ResetTimer(&self) -> Result<()> {
        Ok(())
    }

    fn PauseTimer(&self) -> Result<()> {
        Ok(())
    }

    fn ResumeTimer(&self) -> Result<()> {
        Ok(())
    }
}

/// The error for a deletion the shell reported as failed. Moving a folder that holds a file
/// another program has open fails at the destination (measured: `0x80270028`).
fn error_of(path: &Path, error: &Error) -> RecycleError {
    const SHARING: HRESULT = HRESULT::from_win32(ERROR_SHARING_VIOLATION.0);
    const LOCK: HRESULT = HRESULT::from_win32(ERROR_LOCK_VIOLATION.0);
    const FILE_NOT_FOUND: HRESULT = HRESULT::from_win32(ERROR_FILE_NOT_FOUND.0);
    const PATH_NOT_FOUND: HRESULT = HRESULT::from_win32(ERROR_PATH_NOT_FOUND.0);
    let failure = match error.code() {
        COPYENGINE_E_SHARING_VIOLATION_SRC
        | COPYENGINE_E_SHARING_VIOLATION_DEST
        | SHARING
        | LOCK => RecycleFailure::InUse,
        E_ACCESSDENIED
        | COPYENGINE_E_ACCESS_DENIED_SRC
        | COPYENGINE_E_ACCESS_DENIED_DEST
        | COPYENGINE_E_ACCESSDENIED_READONLY => RecycleFailure::Denied,
        FILE_NOT_FOUND | PATH_NOT_FOUND | COPYENGINE_E_PATH_NOT_FOUND_SRC => {
            RecycleFailure::NotFound
        }
        COPYENGINE_E_RECYCLE_UNKNOWN_ERROR
        | COPYENGINE_E_RECYCLE_FORCE_NUKE
        | COPYENGINE_E_RECYCLE_SIZE_TOO_BIG
        | COPYENGINE_E_RECYCLE_PATH_TOO_LONG
        | COPYENGINE_E_RECYCLE_BIN_NOT_FOUND => RecycleFailure::Unrecyclable,
        _ => RecycleFailure::Other,
    };
    RecycleError::new(path, failure, error.to_string())
}

#[cfg(test)]
mod tests {
    use std::ffi::OsStr;
    use std::fs::{self, File, OpenOptions};
    use std::io::{self, Read};
    use std::os::windows::fs::OpenOptionsExt;
    use std::process::Command;
    use std::time::{Duration, Instant};

    use windows::Win32::Foundation::{E_FAIL, S_OK};
    use windows::Win32::System::Com::{
        APTTYPE, APTTYPE_MAINSTA, APTTYPE_STA, APTTYPEQUALIFIER, COINIT_MULTITHREADED,
        CoGetApartmentType,
    };
    use windows_sys::Win32::Storage::FileSystem::FILE_SHARE_READ;

    use super::*;
    use crate::fs::{DirEntry, Metadata, Presence};
    use crate::win::WindowsFileSystem;

    fn failure(path: &Path) -> RecycleFailure {
        WindowsRecycleBin.recycle(path).unwrap_err().failure
    }

    /// Open the way Word keeps a document open: shared for reading, not for deletion.
    fn held(path: &Path) -> File {
        OpenOptions::new()
            .read(true)
            .share_mode(FILE_SHARE_READ)
            .open(path)
            .unwrap()
    }

    #[test]
    fn recycle_from_an_mta_caller_uses_a_fresh_sta_and_leaves_a_held_file() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("held.txt");
        fs::write(&file, "keep me").unwrap();
        let _held = held(&file);
        std::thread::scope(|scope| {
            scope
                .spawn(|| {
                    // SAFETY: this fresh test thread has no COM apartment; the guard pairs this call.
                    unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) }
                        .ok()
                        .unwrap();
                    let _mta = Apartment;
                    let apartment = in_sta(Builder::new(), initialize_sta, || {
                        assert_eq!(std::thread::current().name(), None);
                        let (mut apartment, mut qualifier) =
                            (APTTYPE::default(), APTTYPEQUALIFIER::default());
                        // SAFETY: both outputs remain valid for the synchronous call.
                        unsafe { CoGetApartmentType(&mut apartment, &mut qualifier) }.unwrap();
                        apartment
                    })
                    .unwrap();
                    assert!(apartment == APTTYPE_STA || apartment == APTTYPE_MAINSTA);
                    assert_eq!(failure(&file), RecycleFailure::InUse);
                })
                .join()
                .unwrap();
        });
        assert_eq!(fs::read_to_string(file).unwrap(), "keep me");
    }

    #[test]
    fn recycle_worker_failures_keep_native_errors_and_panic_payloads() {
        let path = Path::new(r"C:\unused-sta-test.txt");
        let native = Error::from(E_FAIL);
        assert_eq!(
            worker_error(path, StaError::Initialize(native.clone())),
            Err(error_of(path, &native))
        );
        let error = in_sta(Builder::new(), initialize_sta, || {
            std::panic::panic_any(37_u32)
        })
        .unwrap_err();
        let panic =
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| worker_error(path, error)))
                .unwrap_err();
        assert_eq!(panic.downcast_ref::<u32>(), Some(&37));
        assert_eq!(in_sta(Builder::new(), initialize_sta, || 42).unwrap(), 42);
    }

    #[test]
    fn rebuilds_paths_the_shell_takes_and_refuses_the_rest() {
        for (path, plain, exact) in [
            (
                r"\\?\C:\资料\笔记.md",
                r"C:\资料\笔记.md",
                r"\\?\C:\资料\笔记.md",
            ),
            (r"\\?\C:\资料\作业.", r"C:\资料\作业.", r"\\?\C:\资料\作业."),
            (
                r"\\?\UNC\nas\home\资料",
                r"\\nas\home\资料",
                r"\\?\UNC\nas\home\资料",
            ),
            (
                r"C:\资料\.\笔记.md",
                r"C:\资料\笔记.md",
                r"\\?\C:\资料\笔记.md",
            ),
            (
                r"\\nas\home\资料",
                r"\\nas\home\资料",
                r"\\?\UNC\nas\home\资料",
            ),
        ] {
            let paths = paths(Path::new(path)).unwrap();
            assert_eq!(
                (paths.plain.as_path(), paths.exact.as_path()),
                (Path::new(plain), Path::new(exact)),
                "{path}"
            );
        }
        for path in [
            r"C:\",
            r"资料\笔记.md",
            r"\资料",
            r"\\?\C:\资料\..",
            r"\\?\C:\a/b",
            r"\\?\GLOBALROOT\Device\HarddiskVolume1\资料",
            r"\\.\C:\资料",
        ] {
            assert!(paths(Path::new(path)).is_none(), "{path}");
        }
        // An empty name would let the rest of a verbatim path become a share.
        let doubled = paths(Path::new(r"\\?\C:\\srv\share\x"));
        assert!(
            doubled.as_ref().is_none_or(|paths| {
                paths.plain.starts_with(r"C:\") && paths.exact.starts_with(r"\\?\C:\")
            }),
            "{doubled:?}"
        );
    }

    #[test]
    fn missing_and_invalid_paths_are_refused() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(
            failure(&dir.path().join("missing.md")),
            RecycleFailure::NotFound
        );
        fs::write(dir.path().join("笔记.md"), "x").unwrap();
        for path in [
            PathBuf::from(r"资料\笔记.md"),
            PathBuf::from(r"C:\"),
            dir.path().join(r"sub\..\笔记.md"),
        ] {
            assert_eq!(failure(&path), RecycleFailure::Invalid, "{path:?}");
        }
        assert!(dir.path().join("笔记.md").exists());
    }

    #[test]
    fn a_file_another_program_holds_and_its_folder_stay() {
        let dir = tempfile::tempdir().unwrap();
        let folder = dir.path().join("线代");
        fs::create_dir_all(folder.join("作业")).unwrap();
        let file = folder.join("作业/open.docx");
        fs::write(&file, "x").unwrap();
        let _held = held(&file);
        for path in [&file, &folder] {
            assert_eq!(failure(path), RecycleFailure::InUse, "{path:?}");
        }
        assert!(file.exists());
    }

    /// A path too long for the Recycle Bin even in 8.3 form: the shell would delete it for good.
    /// Nothing reaches the Recycle Bin here.
    #[test]
    fn what_the_recycle_bin_cannot_take_stays() {
        let dir = tempfile::tempdir().unwrap();
        let mut folder = dir.path().to_owned();
        for _ in 0..26 {
            folder.push("dddddddd");
        }
        fs::create_dir_all(&folder).unwrap();
        let file = folder.join("folio-recycle-test.txt");
        fs::write(&file, "keep me").unwrap();

        assert_eq!(failure(&file), RecycleFailure::Unrecyclable);
        assert_eq!(fs::read_to_string(&file).unwrap(), "keep me");
    }

    #[test]
    fn tells_the_parsed_item_from_another_file() {
        let dir = tempfile::tempdir().unwrap();
        let (a, b) = (dir.path().join("a.md"), dir.path().join("b.md"));
        fs::write(&a, "a").unwrap();
        fs::write(&b, "b").unwrap();
        let same = in_sta(Builder::new(), initialize_sta, || {
            let item = parse(&a).unwrap();
            let same =
                |path: &Path| identity(path).and_then(|file| is_same_file(&item, file, path));
            (same(&a), same(&b))
        })
        .unwrap();
        assert_eq!(same, (Ok(true), Ok(false)));
    }

    #[test]
    fn a_file_is_gone_once_nothing_or_another_file_is_at_its_path() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("lecture.mp4");
        fs::write(&path, "first").unwrap();
        let file = identity(&path).unwrap();
        assert_eq!(gone(&path, file), Ok(false));
        fs::remove_file(&path).unwrap();
        assert_eq!(gone(&path, file), Ok(true));
        fs::write(&path, "first").unwrap();
        assert_eq!(gone(&path, file), Ok(true));
    }

    /// The guard keeps what the shell reports for the item, which `outcome` reads. A file held
    /// open fails and stays, so nothing reaches the Recycle Bin.
    #[test]
    fn the_guard_keeps_the_shell_report_of_the_item() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("open.docx");
        fs::write(&file, "keep me").unwrap();
        let _held = held(&file);
        let (refused, posted, failed, recycled) = in_sta(Builder::new(), initialize_sta, || {
            let item = parse(&file).unwrap();
            let guard = ComObject::new(Guard::default());
            let _ = perform(&item, &guard.to_interface());
            (
                guard.refused.get(),
                guard.posted.get(),
                guard.failed.get(),
                guard.recycled.get(),
            )
        })
        .unwrap();
        assert!(posted && !refused && !recycled);
        let failure = failed.map(|code| error_of(&file, &code.into()).failure);
        assert_eq!(failure, Some(RecycleFailure::InUse));
        assert_eq!(fs::read_to_string(&file).unwrap(), "keep me");
    }

    /// `StdFileSystem`, with whatever is named `name` only in the cloud.
    struct InTheCloud(&'static str);

    impl InTheCloud {
        fn mark(&self, name: Option<&OsStr>, metadata: &mut Metadata) {
            if name == Some(OsStr::new(self.0)) {
                metadata.presence = Presence::Placeholder;
            }
        }
    }

    impl FileSystem for InTheCloud {
        fn read_dir(&self, folder: &Path) -> io::Result<Vec<DirEntry>> {
            let mut entries = StdFileSystem.read_dir(folder)?;
            for entry in &mut entries {
                self.mark(Some(&entry.name), &mut entry.metadata);
            }
            Ok(entries)
        }

        fn metadata(&self, path: &Path) -> io::Result<Metadata> {
            let mut metadata = StdFileSystem.metadata(path)?;
            self.mark(path.file_name(), &mut metadata);
            Ok(metadata)
        }

        fn open(&self, path: &Path) -> io::Result<Box<dyn Read + '_>> {
            StdFileSystem.open(path)
        }
    }

    /// The shell's operation as a test plays it: `then` runs, and the item is reported done,
    /// with a new item in the Recycle Bin or without one. Nothing moves unless `then` moves it.
    fn shell(
        recycled: bool,
        then: impl FnOnce() + Send,
    ) -> impl FnOnce(&IShellItem, &IFileOperationProgressSink) -> Result<()> + Send {
        played(S_OK, recycled, then)
    }

    /// `shell`, reporting `result` for the item, which the whole operation returns too, as
    /// `PerformOperations` does for a failed item.
    fn played(
        result: HRESULT,
        recycled: bool,
        then: impl FnOnce() + Send,
    ) -> impl FnOnce(&IShellItem, &IFileOperationProgressSink) -> Result<()> + Send {
        move |item: &IShellItem, sink: &IFileOperationProgressSink| {
            then();
            // SAFETY: COM calls on the guard and the item this thread made.
            unsafe {
                sink.PreDeleteItem(TSF_DELETE_RECYCLE_IF_POSSIBLE.0 as u32, item)?;
                sink.PostDeleteItem(0, item, result, recycled.then_some(item))?;
            }
            result.ok()
        }
    }

    /// The shell's operation, which the test expects never to run.
    fn never(_: &IShellItem, _: &IFileOperationProgressSink) -> Result<()> {
        panic!("the shell was asked")
    }

    /// From the look before the shell, through the guard, to `outcome` and `gone`, with the
    /// shell's operation played as measured for a file only in the cloud (§4.2): the item done,
    /// nothing in the Recycle Bin, the file gone. Nothing reaches the Recycle Bin.
    #[test]
    fn a_file_only_in_the_cloud_that_the_shell_removed_is_in_its_trash() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("lecture.mp4");
        let cloud = InTheCloud("lecture.mp4");
        let failure_of =
            |result: std::result::Result<Recycled, RecycleError>| result.unwrap_err().failure;
        let remove = || fs::remove_file(&file).unwrap();

        fs::write(&file, "x").unwrap();
        let recycled = recycle_with(&cloud, &file, shell(false, remove));
        assert_eq!(recycled, Ok(Recycled::CloudTrash));
        assert!(!file.exists());
        // Still there, or a local file that the Recycle Bin did not get: a failure.
        fs::write(&file, "x").unwrap();
        let still = recycle_with(&cloud, &file, shell(false, || {}));
        assert_eq!(failure_of(still), RecycleFailure::Other);
        let local = recycle_with(&StdFileSystem, &file, shell(false, remove));
        assert_eq!(failure_of(local), RecycleFailure::Other);
        // In the Recycle Bin after all: something downloaded it in the meantime.
        fs::write(&file, "x").unwrap();
        let recycled = recycle_with(&cloud, &file, shell(true, || {}));
        assert_eq!(recycled, Ok(Recycled::RecycleBin));
        // A failure the shell reports for the item stands, even though the file left its path;
        // only ERROR_CLOUD_FILE_NOT_SUPPORTED, seen once in the field test, means its trash.
        let denied = recycle_with(&cloud, &file, played(E_ACCESSDENIED, false, remove));
        assert_eq!(failure_of(denied), RecycleFailure::Denied);
        fs::write(&file, "x").unwrap();
        let not_supported = HRESULT::from_win32(ERROR_CLOUD_FILE_NOT_SUPPORTED.0);
        let recycled = recycle_with(&cloud, &file, played(not_supported, false, remove));
        assert_eq!(recycled, Ok(Recycled::CloudTrash));
    }

    /// The look lists exact names: a plain path would read `作业.` as its sibling `作业`, and
    /// `讲义.` not at all. Nothing reaches the Recycle Bin.
    #[test]
    fn a_folder_is_looked_at_by_the_exact_names_below_it() {
        let dir = tempfile::tempdir().unwrap();
        let folder = dir.path().join("线代");
        let exact = PathBuf::from(format!(r"\\?\{}", folder.display()));
        for (sub, file) in [
            ("作业", "hw1.txt"),
            ("作业.", "cloud.txt"),
            ("讲义.", "ch1.txt"),
        ] {
            fs::create_dir_all(exact.join(sub)).unwrap();
            fs::write(exact.join(sub).join(file), "x").unwrap();
        }

        let error = recycle_with(&InTheCloud("cloud.txt"), &folder, never).unwrap_err();
        assert_eq!(
            (&error.path, error.failure),
            (&folder, RecycleFailure::CloudOnly)
        );
        assert!(error.detail.contains(r"作业.\cloud.txt"), "{error}");
        let recycled = recycle_with(&StdFileSystem, &folder, shell(true, || {}));
        assert_eq!(recycled, Ok(Recycled::RecycleBin));
        fs::remove_dir_all(&exact).unwrap();
    }

    /// The look lists a junction as itself and never follows it, here into a folder holding a
    /// file only in the cloud, which would keep the folder. Nothing reaches the Recycle Bin.
    #[test]
    fn a_folder_is_looked_at_without_following_its_junctions() {
        let dir = tempfile::tempdir().unwrap();
        let (folder, outside) = (dir.path().join("course"), dir.path().join("outside"));
        fs::create_dir(&folder).unwrap();
        fs::create_dir(&outside).unwrap();
        fs::write(outside.join("cloud.txt"), "x").unwrap();
        let link = folder.join("link");
        // Unlike a symbolic link, a junction needs no privileges.
        let made = Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(&link)
            .arg(&outside)
            .output()
            .unwrap();
        assert!(made.status.success(), "{made:?}");

        let recycled = recycle_with(&InTheCloud("cloud.txt"), &folder, shell(true, || {}));
        assert_eq!(recycled, Ok(Recycled::RecycleBin));
        fs::remove_dir(&link).unwrap();
    }

    /// A file that left after the look: the shell's parser reports it.
    #[test]
    fn a_file_gone_before_the_shell_is_not_found() {
        let dir = tempfile::tempdir().unwrap();
        let missing = dir.path().join("missing.md");
        let error = in_sta(Builder::new(), initialize_sta, || {
            recycle_item(&missing, &missing, Recycled::RecycleBin, never)
        })
        .unwrap()
        .unwrap_err();
        assert_eq!(error.failure, RecycleFailure::NotFound, "{error}");
    }

    /// Names that the shell's parser does not find, since a plain path drops a trailing dot from
    /// each name and a trailing space from the last: they stay, and are not reported gone.
    /// Nothing reaches the Recycle Bin.
    #[test]
    fn what_the_shell_cannot_find_by_its_name_stays_and_is_not_gone() {
        let dir = tempfile::tempdir().unwrap();
        let exact = PathBuf::from(format!(r"\\?\{}", dir.path().display()));
        fs::create_dir(exact.join("作业.")).unwrap();
        for file in ["alone.md.", "alone.md ", r"作业.\hw1.txt"] {
            fs::write(exact.join(file), "keep me").unwrap();
        }

        for name in ["alone.md.", "alone.md ", "作业.", r"作业.\hw1.txt"] {
            let error = WindowsRecycleBin
                .recycle(&dir.path().join(name))
                .unwrap_err();
            assert_eq!(error.failure, RecycleFailure::Other, "{error}");
            assert!(exact.join(name).exists(), "{name}");
        }
        fs::remove_dir_all(&exact).unwrap();
    }

    /// A path that Win32 reads as another file outside a verbatim path: the shell would take that
    /// file, which is held open here, so nothing moves even if it is asked.
    #[test]
    fn a_path_the_shell_reads_as_another_file_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let twin = dir.path().join("twin.md");
        fs::write(&twin, "twin").unwrap();
        let _held = held(&twin);
        let dotted = PathBuf::from(format!(r"\\?\{}.", twin.display()));
        fs::write(&dotted, "dotted").unwrap();

        assert_eq!(failure(&dotted), RecycleFailure::Invalid);
        assert_eq!(fs::read_to_string(&dotted).unwrap(), "dotted");
        fs::remove_file(&dotted).unwrap();
    }

    fn report(failed: Option<HRESULT>, recycled: bool) -> Report {
        Report {
            refused: false,
            posted: true,
            failed,
            recycled,
            performed: Ok(()),
        }
    }

    #[test]
    fn the_shell_report_and_the_path_say_where_the_item_went() {
        use Recycled::{CloudTrash, RecycleBin};
        let path = Path::new(r"C:\Users\sirui\iCloudDrive\线代\lecture.mp4");
        let failure =
            |result: std::result::Result<Recycled, RecycleError>| result.unwrap_err().failure;
        let never =
            || -> std::result::Result<bool, RecycleError> { panic!("asked about the path") };
        let gone = || Ok(true);
        let there = || Ok(false);
        let not_supported = Some(HRESULT::from_win32(ERROR_CLOUD_FILE_NOT_SUPPORTED.0));

        // In the Recycle Bin whatever was expected: a file only in the cloud that something
        // downloaded in the meantime gets there too.
        for destination in [RecycleBin, CloudTrash] {
            let recycled = outcome(path, destination, report(None, true), never);
            assert_eq!(recycled, Ok(RecycleBin), "{destination:?}");
        }
        // A file only in the cloud that the shell deleted: its provider's trash has it.
        for failed in [None, not_supported] {
            let recycled = outcome(path, CloudTrash, report(failed, false), gone);
            assert_eq!(recycled, Ok(CloudTrash), "{failed:?}");
        }
        // Still there, or expected in the Recycle Bin: a failure, as before.
        let error = outcome(path, CloudTrash, report(None, false), there).unwrap_err();
        assert_eq!(
            (error.failure, error.detail.as_str()),
            (
                RecycleFailure::Other,
                "the shell reported nothing in the Recycle Bin"
            )
        );
        let still = outcome(path, CloudTrash, report(not_supported, false), there);
        assert_eq!(failure(still), RecycleFailure::Other);
        // Nothing reported for the item: the operation's own failure, wherever the file is.
        let unreported = Report {
            posted: false,
            performed: Err(E_FAIL.into()),
            ..report(None, false)
        };
        let unreported = outcome(path, CloudTrash, unreported, never);
        assert_eq!(failure(unreported), RecycleFailure::Other);
        for failed in [None, not_supported] {
            let local = outcome(path, RecycleBin, report(failed, false), never);
            assert_eq!(failure(local), RecycleFailure::Other, "{failed:?}");
        }
        // The guard's refusal and the item's other failures stand, wherever the item is.
        let in_use = report(Some(COPYENGINE_E_SHARING_VIOLATION_SRC), false);
        assert_eq!(
            failure(outcome(path, CloudTrash, in_use, never)),
            RecycleFailure::InUse
        );
        let refused = Report {
            refused: true,
            ..report(None, false)
        };
        let refused = outcome(path, CloudTrash, refused, never);
        assert_eq!(failure(refused), RecycleFailure::Unrecyclable);
        // The operation's own failure when the item reported nothing.
        let denied = Report {
            performed: Err(E_ACCESSDENIED.into()),
            ..report(None, false)
        };
        assert_eq!(
            failure(outcome(path, CloudTrash, denied, there)),
            RecycleFailure::Denied
        );
        // A path that cannot be checked: the shell's report, with the check's failure added.
        let unknown = || Err(RecycleError::new(path, RecycleFailure::Denied, "test"));
        let error = outcome(path, CloudTrash, report(None, false), unknown).unwrap_err();
        assert_eq!(
            (error.failure, error.detail.as_str()),
            (
                RecycleFailure::Other,
                "the shell reported nothing in the Recycle Bin; then test"
            )
        );
    }

    fn recycles_a_file_and_a_folder_in(base: &Path) {
        let dir = tempfile::tempdir_in(base).unwrap();
        let file = dir.path().join("folio-recycle-test.txt");
        fs::write(&file, "test file of Folio").unwrap();
        let folder = dir.path().join("folio-recycle-test-folder");
        fs::create_dir_all(folder.join("作业")).unwrap();
        fs::write(folder.join("作业/hw1.txt"), "test file of Folio").unwrap();

        for path in [&file, &folder] {
            assert_eq!(WindowsRecycleBin.recycle(path), Ok(Recycled::RecycleBin));
            assert!(!path.exists());
        }
    }

    /// Adds a small file and a folder to the user's Recycle Bin, which tests never empty.
    #[test]
    #[ignore = "adds to the user's Recycle Bin; run it by hand"]
    fn files_and_folders_go_to_the_recycle_bin() {
        recycles_a_file_and_a_folder_in(&std::env::temp_dir());
    }

    /// Adds a small file and a folder to the Recycle Bin of the drive of
    /// `FOLIO_TEST_NON_NTFS_DIR`.
    #[test]
    #[ignore = "needs FOLIO_TEST_NON_NTFS_DIR, and adds to that drive's Recycle Bin"]
    fn off_ntfs_files_and_folders_go_to_the_recycle_bin() {
        recycles_a_file_and_a_folder_in(&super::super::non_ntfs_dir());
    }

    /// Recycles in `FOLIO_TEST_ICLOUD_DIR`, a folder in iCloud Drive: a file only in the cloud
    /// goes to iCloud's Recently Deleted without being downloaded, a folder holding one stays,
    /// and a downloaded file goes to the Recycle Bin. Space is freed up with `attrib`, as File
    /// Explorer does, and the test waits for iCloud to upload and dehydrate the files.
    #[test]
    #[ignore = "needs FOLIO_TEST_ICLOUD_DIR (a folder in iCloud Drive); adds to the Recycle Bin and to iCloud's Recently Deleted"]
    fn in_icloud_drive_files_only_in_the_cloud_go_to_recently_deleted() {
        let base = std::env::var_os("FOLIO_TEST_ICLOUD_DIR").expect("FOLIO_TEST_ICLOUD_DIR");
        let dir = tempfile::Builder::new()
            .prefix("folio-recycle-test-")
            .tempdir_in(base)
            .unwrap();
        let folder = dir.path().join("线代");
        fs::create_dir(&folder).unwrap();
        let (cloud, inside, local) = (
            dir.path().join("lecture.txt"),
            folder.join("notes.txt"),
            dir.path().join("local.txt"),
        );
        for file in [&cloud, &inside, &local] {
            fs::write(file, "test file of Folio").unwrap();
        }
        for file in [&cloud, &inside] {
            let freed = Command::new("attrib").args(["+U", "-P"]).arg(file).status();
            assert!(freed.unwrap().success(), "{file:?}");
        }
        let files = WindowsFileSystem::open(dir.path()).unwrap();
        let presence = |path: &Path| files.metadata(path).unwrap().presence;
        let started = Instant::now();
        while [&cloud, &inside]
            .iter()
            .any(|file| presence(file) != Presence::Placeholder)
        {
            assert!(
                started.elapsed() < Duration::from_secs(300),
                "iCloud kept the content"
            );
            std::thread::sleep(Duration::from_secs(2));
        }

        assert_eq!(failure(&folder), RecycleFailure::CloudOnly);
        assert_eq!(presence(&inside), Presence::Placeholder);
        assert_eq!(WindowsRecycleBin.recycle(&cloud), Ok(Recycled::CloudTrash));
        assert!(!cloud.exists());
        assert_eq!(WindowsRecycleBin.recycle(&local), Ok(Recycled::RecycleBin));
        assert!(!local.exists());
    }
}
