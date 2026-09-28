//! `WindowsRecycleBin`: the shell's `IFileOperation`, with a guard that refuses every item the
//! Recycle Bin cannot take, so nothing is ever deleted for good (docs/specs/windows-adapter.md
//! §4.1).

#![allow(
    unsafe_code,
    reason = "COM FFI; each unsafe block states why it is sound"
)]

use std::cell::Cell;
use std::ffi::OsString;
use std::io;
use std::os::windows::ffi::{OsStrExt, OsStringExt};
use std::path::{Component, Path, PathBuf, Prefix};

use windows::Win32::Foundation::{
    E_ABORT, E_ACCESSDENIED, ERROR_FILE_NOT_FOUND, ERROR_LOCK_VIOLATION, ERROR_PATH_NOT_FOUND,
    ERROR_SHARING_VIOLATION,
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
use crate::files;
use crate::recycle::{RecycleBin, RecycleError, RecycleFailure, check};

/// The Recycle Bin of Windows.
#[derive(Debug, Clone, Copy, Default)]
pub struct WindowsRecycleBin;

impl RecycleBin for WindowsRecycleBin {
    fn recycle(&self, path: &Path) -> std::result::Result<(), RecycleError> {
        check(path)?;
        let path = plain_path(path).ok_or_else(|| {
            RecycleError::new(
                path,
                RecycleFailure::Invalid,
                "not a path the shell can take",
            )
        })?;
        in_apartment(|| recycle_item(&path)).unwrap_or_else(|error| Err(error_of(&path, &error)))
    }
}

/// `path` as the shell's parser takes it: without `\\?\`, which it rejects (`E_INVALIDARG`),
/// and rebuilt name by name, so that no name gains a meaning Win32 gives it outside a verbatim
/// path. `None` for anything but a drive or share path of ordinary names.
fn plain_path(path: &Path) -> Option<PathBuf> {
    let mut components = path.components();
    let Component::Prefix(prefix) = components.next()? else {
        return None;
    };
    let mut plain = match prefix.kind() {
        Prefix::Disk(letter) | Prefix::VerbatimDisk(letter) => {
            OsString::from(format!("{}:", char::from(letter)))
        }
        Prefix::UNC(server, share) | Prefix::VerbatimUNC(server, share) => {
            let mut plain = OsString::from(r"\\");
            plain.push(server);
            plain.push(r"\");
            plain.push(share);
            plain
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
        plain.push(r"\");
        plain.push(name);
        names += 1;
    }
    (names > 0).then(|| plain.into())
}

/// Runs `work` on a thread of its own in a single-threaded apartment, which `IFileOperation`
/// needs whatever the caller's thread is.
fn in_apartment<T: Send>(work: impl FnOnce() -> T + Send) -> Result<T> {
    std::thread::scope(|scope| {
        scope
            .spawn(|| {
                // SAFETY: the thread is new and has not used COM; `Apartment` undoes this.
                unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE) }
                    .ok()?;
                let _apartment = Apartment;
                Ok(work())
            })
            .join()
            .unwrap_or_else(|panic| std::panic::resume_unwind(panic))
    })
}

/// Undoes `CoInitializeEx` when the thread is done with COM.
struct Apartment;

impl Drop for Apartment {
    fn drop(&mut self) {
        // SAFETY: pairs with the successful `CoInitializeEx` that made this value.
        unsafe { CoUninitialize() };
    }
}

fn recycle_item(path: &Path) -> std::result::Result<(), RecycleError> {
    let item = parse(path)?;
    if !is_same_file(&item, path)? {
        return Err(RecycleError::new(
            path,
            RecycleFailure::Invalid,
            "the shell resolves this path to another file",
        ));
    }
    let guard = ComObject::new(Guard::default());
    let performed = perform(&item, &guard.to_interface());
    if guard.refused.get() {
        return Err(RecycleError::new(
            path,
            RecycleFailure::Unrecyclable,
            "the shell would have deleted it for good",
        ));
    }
    if let Some(code) = guard.failed.get() {
        return Err(error_of(path, &code.into()));
    }
    // The item's own result says where it is, whatever else the operation reports.
    if guard.recycled.get() {
        return Ok(());
    }
    Err(match performed {
        Err(error) => error_of(path, &error),
        Ok(()) => RecycleError::new(
            path,
            RecycleFailure::Other,
            "the shell reported nothing in the Recycle Bin",
        ),
    })
}

fn parse(path: &Path) -> std::result::Result<IShellItem, RecycleError> {
    // SAFETY: the string outlives the call.
    unsafe { SHCreateItemFromParsingName(&HSTRING::from(path), None) }
        .map_err(|error| error_of(path, &error))
}

/// Whether the shell's item is the file at `path`. The parser follows folder shortcuts and
/// namespace junctions (`name.{CLSID}`), so a path can stand for another file than the one on
/// disk; the volume and file index say which file it is.
fn is_same_file(item: &IShellItem, path: &Path) -> std::result::Result<bool, RecycleError> {
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
    let identity = |path: &Path| {
        let basic = handle::open_attributes(path)
            .and_then(|file| handle::basic_information(&file))
            .map_err(|error| io_error_of(path, &error))?;
        Ok((
            basic.dwVolumeSerialNumber,
            basic.nFileIndexHigh,
            basic.nFileIndexLow,
        ))
    };
    Ok(identity(&parsed)? == identity(path)?)
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

fn io_error_of(path: &Path, error: &io::Error) -> RecycleError {
    let failure = if error.kind() == io::ErrorKind::NotFound {
        RecycleFailure::NotFound
    } else if files::is_in_use(error) {
        RecycleFailure::InUse
    } else if error.kind() == io::ErrorKind::PermissionDenied {
        RecycleFailure::Denied
    } else {
        RecycleFailure::Other
    };
    RecycleError::new(path, failure, error.to_string())
}

#[cfg(test)]
mod tests {
    use std::fs::{self, File, OpenOptions};
    use std::os::windows::fs::OpenOptionsExt;

    use windows_sys::Win32::Storage::FileSystem::FILE_SHARE_READ;

    use super::*;

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
    fn rebuilds_paths_the_shell_takes_and_refuses_the_rest() {
        for (path, plain) in [
            (r"\\?\C:\资料\笔记.md", r"C:\资料\笔记.md"),
            (r"\\?\UNC\nas\home\资料", r"\\nas\home\资料"),
            (r"C:\资料\.\笔记.md", r"C:\资料\笔记.md"),
            (r"\\nas\home\资料", r"\\nas\home\资料"),
        ] {
            assert_eq!(
                plain_path(Path::new(path)).as_deref(),
                Some(Path::new(plain))
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
            assert_eq!(plain_path(Path::new(path)), None, "{path}");
        }
        // An empty name would let the rest of a verbatim path become a share.
        let doubled = plain_path(Path::new(r"\\?\C:\\srv\share\x"));
        assert!(
            doubled
                .as_deref()
                .is_none_or(|plain| plain.starts_with(r"C:\")),
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
        let same = in_apartment(|| {
            let item = parse(&a).unwrap();
            (is_same_file(&item, &a), is_same_file(&item, &b))
        })
        .unwrap();
        assert_eq!(same, (Ok(true), Ok(false)));
    }

    fn recycles_a_file_and_a_folder_in(base: &Path) {
        let dir = tempfile::tempdir_in(base).unwrap();
        let file = dir.path().join("folio-recycle-test.txt");
        fs::write(&file, "test file of Folio").unwrap();
        let folder = dir.path().join("folio-recycle-test-folder");
        fs::create_dir_all(folder.join("作业")).unwrap();
        fs::write(folder.join("作业/hw1.txt"), "test file of Folio").unwrap();

        WindowsRecycleBin.recycle(&file).unwrap();
        WindowsRecycleBin.recycle(&folder).unwrap();
        assert!(!file.exists());
        assert!(!folder.exists());
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
}
