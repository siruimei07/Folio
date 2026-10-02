//! Shell-owned file/folder choices and registered Windows sync roots (ADR-0004).

#![allow(
    unsafe_code,
    reason = "Windows COM FFI; each unsafe block states why it is sound"
)]

use std::ffi::OsString;
use std::os::windows::ffi::{OsStrExt, OsStringExt};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

use windows::Storage::Provider::StorageProviderSyncRootManager;
use windows::Win32::Foundation::{ERROR_CANCELLED, HWND};
use windows::Win32::Globalization::{CSTR_EQUAL, CompareStringOrdinal};
use windows::Win32::System::Com::{
    CLSCTX_INPROC_SERVER, CoCreateInstance, CoIncrementMTAUsage, CoTaskMemFree,
};
use windows::Win32::System::WinRT::{RO_INIT_SINGLETHREADED, RoInitialize, RoUninitialize};
use windows::Win32::UI::Shell::{
    FOS_ALLOWMULTISELECT, FOS_DONTADDTORECENT, FOS_FILEMUSTEXIST, FOS_FORCEFILESYSTEM,
    FOS_NOCHANGEDIR, FOS_PATHMUSTEXIST, FOS_PICKFOLDERS, FileOpenDialog, IFileOpenDialog,
    IShellItem, SIGDN_FILESYSPATH,
};
use windows::core::{HRESULT, PWSTR};

use folio_core::library::operations::MAX_BATCH;

use crate::error::AppError;
use crate::ipc::library::SyncProvider;

/// Blocks until the native dialog closes. Call from a blocking worker, without state locks.
/// `owner` comes from the shell's window handle, never an IPC payload. No path reaches the page
/// until the library state has validated it and issued a choice token.
pub fn pick_folder(owner: Option<isize>) -> Result<Option<PathBuf>, AppError> {
    #[cfg(debug_assertions)]
    if let Some(path) = std::env::var_os("FOLIO_TEST_LIBRARY_FOLDER") {
        return absolute_path(path.into()).map(Some);
    }

    in_sta(move || {
        // SAFETY: this thread has an STA; the returned interface stays here until dropped.
        let dialog: IFileOpenDialog =
            unsafe { CoCreateInstance(&FileOpenDialog, None, CLSCTX_INPROC_SERVER) }
                .map_err(native_error)?;
        // SAFETY: the interface is live in its creating apartment.
        let options = unsafe { dialog.GetOptions() }.map_err(native_error)?;
        // SAFETY: the interface is live in its creating apartment; options are documented flags.
        unsafe {
            dialog.SetOptions(
                options
                    | FOS_PICKFOLDERS
                    | FOS_FORCEFILESYSTEM
                    | FOS_PATHMUSTEXIST
                    | FOS_NOCHANGEDIR
                    | FOS_DONTADDTORECENT,
            )
        }
        .map_err(native_error)?;

        // SAFETY: HWND is an opaque shell-owned handle, not dereferenced here; Show accepts null.
        let shown = unsafe { dialog.Show(owner.map(|handle| HWND(handle as *mut _))) };
        if let Err(error) = shown {
            return if error.code() == HRESULT::from_win32(ERROR_CANCELLED.0) {
                Ok(None)
            } else {
                Err(native_error(error))
            };
        }

        // SAFETY: Show succeeded, so GetResult returns a live shell item on this apartment.
        let item = unsafe { dialog.GetResult() }.map_err(native_error)?;
        item_path(&item).map(Some)
    })
}

/// Blocks until the native file dialog closes; folders enter through native drops instead.
/// Call from a blocking worker without state locks. The owner is a shell-owned window handle,
/// and selected paths stay in the shell until it validates them and issues a source token.
pub fn pick_import_files(owner: Option<isize>) -> Result<Option<Vec<PathBuf>>, AppError> {
    #[cfg(debug_assertions)]
    if let Some(paths) = std::env::var_os("FOLIO_TEST_IMPORT_FILES") {
        return import_paths_override(&paths);
    }

    in_sta(move || {
        // SAFETY: this thread has an STA; the returned interface stays here until dropped.
        let dialog: IFileOpenDialog =
            unsafe { CoCreateInstance(&FileOpenDialog, None, CLSCTX_INPROC_SERVER) }
                .map_err(native_error)?;
        // SAFETY: the interface is live in its creating apartment.
        let options = unsafe { dialog.GetOptions() }.map_err(native_error)?;
        // SAFETY: the interface is live in its creating apartment; options are documented flags.
        unsafe {
            dialog.SetOptions(
                options
                    | FOS_ALLOWMULTISELECT
                    | FOS_FILEMUSTEXIST
                    | FOS_FORCEFILESYSTEM
                    | FOS_PATHMUSTEXIST
                    | FOS_NOCHANGEDIR
                    | FOS_DONTADDTORECENT,
            )
        }
        .map_err(native_error)?;

        // SAFETY: HWND is an opaque shell-owned handle, not dereferenced here; Show accepts null.
        if let Err(error) = unsafe { dialog.Show(owner.map(|handle| HWND(handle as *mut _))) } {
            return if error.code() == HRESULT::from_win32(ERROR_CANCELLED.0) {
                Ok(None)
            } else {
                Err(native_error(error))
            };
        }

        // SAFETY: Show succeeded; the selected-item array stays in this apartment.
        let items = unsafe { dialog.GetResults() }.map_err(native_error)?;
        // SAFETY: the array is live in its creating apartment.
        let count = unsafe { items.GetCount() }.map_err(native_error)?;
        check_import_selection_count(count)?;
        let mut paths = Vec::with_capacity(count as usize);
        for index in 0..count {
            // SAFETY: index is below the array's count; each item drops in this apartment.
            let item = unsafe { items.GetItemAt(index) }.map_err(native_error)?;
            paths.push(item_path(&item)?);
        }
        Ok(Some(paths))
    })
}

fn check_import_selection_count(count: u32) -> Result<(), AppError> {
    if count == 0 {
        return Err(AppError::Internal(
            "file dialog returned no selection".into(),
        ));
    }
    if count as usize > MAX_BATCH {
        // The user's choice exceeded the limit, as in `choose_import`.
        return Err(AppError::InvalidArgument(
            "invalid import selection size".into(),
        ));
    }
    Ok(())
}

/// Uses the OS-native path-list format, so test sources may include folders and non-Unicode
/// names without adding a production deserializer or mutating the process environment in tests.
#[cfg(any(debug_assertions, test))]
fn import_paths_override(value: &std::ffi::OsStr) -> Result<Option<Vec<PathBuf>>, AppError> {
    if value.is_empty() {
        return Ok(None);
    }
    let paths: Vec<_> = std::env::split_paths(value)
        .take(MAX_BATCH + 1)
        .map(absolute_path)
        .collect::<Result<_, _>>()?;
    if paths.len() > MAX_BATCH {
        return Err(AppError::Internal("too many import choices".into()));
    }
    Ok(Some(paths))
}

fn item_path(item: &IShellItem) -> Result<PathBuf, AppError> {
    // SAFETY: callers keep this live shell item in its creating apartment. GetDisplayName
    // allocates a null-terminated CoTaskMem string, owned only by this guard.
    let name =
        TaskMemString(unsafe { item.GetDisplayName(SIGDN_FILESYSPATH) }.map_err(native_error)?);
    if name.0.is_null() {
        return Err(AppError::Internal(
            "shell dialog returned a null path".into(),
        ));
    }
    // SAFETY: GetDisplayName's string remains allocated until `name` drops after this copy.
    absolute_path(PathBuf::from(OsString::from_wide(unsafe {
        name.0.as_wide()
    })))
}

/// Classifies a canonical folder using Windows' registered sync roots, including legacy
/// registrations. This is a warning, not an access grant. Unregistered providers cannot be
/// detected. The class is registered as both-threaded, so it runs in the caller's apartment, or in
/// the process's MTA on a thread without one.
pub fn sync_provider(root: &Path) -> Result<Option<SyncProvider>, AppError> {
    hold_mta()?;
    let roots = StorageProviderSyncRootManager::GetCurrentSyncRoots().map_err(native_error)?;
    for index in 0..roots.Size().map_err(native_error)? {
        let registered = roots.GetAt(index).map_err(native_error)?;
        let path = registered
            .Path()
            .and_then(|folder| folder.Path())
            .map_err(native_error)?;
        let path = PathBuf::from(path.to_os_string());
        let path = match path.canonicalize() {
            Ok(path) => path,
            // A stale registration on a missing drive cannot contain the existing choice.
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => {
                return Err(AppError::Internal(format!(
                    "resolve registered sync root: {error}"
                )));
            }
        };
        if inside_root(root, &path)? {
            let id = registered.Id().map_err(native_error)?;
            return Ok(Some(provider_from_id(&id.to_string_lossy())));
        }
    }
    Ok(None)
}

fn absolute_path(path: PathBuf) -> Result<PathBuf, AppError> {
    if !path.is_absolute() || path.as_os_str().encode_wide().any(|unit| unit == 0) {
        return Err(AppError::Internal(
            "shell choice must be an absolute path without NUL".into(),
        ));
    }
    Ok(path)
}

fn provider_from_id(id: &str) -> SyncProvider {
    // Windows defines the id as provider!user-SID!account; account names are not provider names.
    let provider = id.split('!').next().unwrap_or_default();
    if ["iCloud", "iCloudDrive", "iCloudPhotos"]
        .iter()
        .any(|name| provider.eq_ignore_ascii_case(name))
    {
        SyncProvider::ICloud
    } else if provider.eq_ignore_ascii_case("OneDrive") {
        SyncProvider::OneDrive
    } else if provider.eq_ignore_ascii_case("Dropbox") {
        SyncProvider::Dropbox
    } else {
        SyncProvider::Other
    }
}

/// Both paths are canonical, including reparse resolution and their verbatim drive/share prefix.
fn inside_root(path: &Path, root: &Path) -> Result<bool, AppError> {
    let mut path = path.components();
    for root_component in root.components() {
        let Some(component) = path.next() else {
            return Ok(false);
        };
        let left: Vec<_> = component.as_os_str().encode_wide().collect();
        let right: Vec<_> = root_component.as_os_str().encode_wide().collect();
        if left.len() > i32::MAX as usize || right.len() > i32::MAX as usize {
            return Err(AppError::Internal(
                "sync-root path component is too long".into(),
            ));
        }
        // SAFETY: both slices outlive the call, and their lengths fit the native signed count.
        let comparison = unsafe { CompareStringOrdinal(&left, &right, true) };
        if comparison.0 == 0 {
            return Err(native_error(windows::core::Error::from_thread()));
        }
        if comparison != CSTR_EQUAL {
            return Ok(false);
        }
    }
    Ok(true)
}

fn in_sta<T: Send>(work: impl FnOnce() -> Result<T, AppError> + Send) -> Result<T, AppError> {
    std::thread::scope(|scope| {
        std::thread::Builder::new()
            .name("folio-shell-com".into())
            .spawn_scoped(scope, || {
                // SAFETY: a new thread has no conflicting apartment; this makes it an STA. All
                // interfaces drop before the apartment guard.
                unsafe { RoInitialize(RO_INIT_SINGLETHREADED) }.map_err(native_error)?;
                let _apartment = Apartment;
                work()
            })
            .map_err(|error| AppError::Internal(format!("start shell COM worker: {error}")))?
            .join()
            .map_err(|_| AppError::Internal("shell COM worker panicked".into()))?
    })
}

static MTA_HELD: AtomicBool = AtomicBool::new(false);

/// Keeps COM initialized until the process exits; call before any WinRT call. windows-rs caches
/// WinRT activation factories for the whole process. When the last apartment ends, COM shuts
/// down and may unload their DLLs (Windows Server 2022 unloads windows.storage.dll), and the next
/// call through the cache reads unloaded code: STATUS_ACCESS_VIOLATION.
fn hold_mta() -> Result<(), AppError> {
    if !MTA_HELD.load(Ordering::Relaxed) {
        // SAFETY: no preconditions. The cookie is dropped without CoDecrementMTAUsage on purpose,
        // so the hold lasts as long as the process; two first callers may both take one.
        unsafe { CoIncrementMTAUsage() }.map_err(native_error)?;
        MTA_HELD.store(true, Ordering::Relaxed);
    }
    Ok(())
}

struct Apartment;

impl Drop for Apartment {
    fn drop(&mut self) {
        // SAFETY: runs on the same thread, once per successful RoInitialize, after COM objects.
        unsafe { RoUninitialize() };
    }
}

struct TaskMemString(PWSTR);

impl Drop for TaskMemString {
    fn drop(&mut self) {
        // SAFETY: the pointer came from GetDisplayName; only this guard frees it, including null.
        unsafe { CoTaskMemFree(Some(self.0.as_ptr().cast())) };
    }
}

fn native_error(error: windows::core::Error) -> AppError {
    AppError::Internal(format!(
        "Windows file/folder selection or sync-root lookup: {error}"
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_import_override_means_cancelled() {
        assert_eq!(
            import_paths_override(std::ffi::OsStr::new("")).unwrap(),
            None
        );
    }

    #[test]
    fn import_override_rejects_relative_nul_and_empty_segments() {
        for invalid in [
            "relative",
            r"C:relative",
            r"\relative",
            "C:\\chosen\0other",
            ";",
            r"C:\chosen;;C:\other",
        ] {
            assert!(
                matches!(
                    import_paths_override(std::ffi::OsStr::new(invalid)),
                    Err(AppError::Internal(_))
                ),
                "accepted invalid override: {invalid:?}"
            );
        }
    }

    #[test]
    fn import_override_keeps_multiple_files_and_folders_in_order() {
        let dir = tempfile::tempdir().unwrap();
        let paths = vec![
            dir.path().join("first.txt"),
            dir.path().join("课程 notes.txt"),
            dir.path().join("folder;with separator"),
        ];
        std::fs::write(&paths[0], b"first").unwrap();
        std::fs::write(&paths[1], b"notes").unwrap();
        std::fs::create_dir(&paths[2]).unwrap();
        let encoded = std::env::join_paths(&paths).unwrap();
        assert_eq!(import_paths_override(&encoded).unwrap(), Some(paths));
    }

    #[test]
    fn native_import_selection_count_reports_the_user_limit_as_invalid_input() {
        assert!(check_import_selection_count(MAX_BATCH as u32).is_ok());
        assert!(matches!(
            check_import_selection_count(MAX_BATCH as u32 + 1),
            Err(AppError::InvalidArgument(_))
        ));
        assert!(matches!(
            check_import_selection_count(0),
            Err(AppError::Internal(_))
        ));
    }

    #[test]
    fn import_override_enforces_the_batch_limit() {
        let paths = vec![PathBuf::from(r"C:\chosen.txt"); MAX_BATCH];
        let at_limit = std::env::join_paths(&paths).unwrap();
        assert_eq!(
            import_paths_override(&at_limit).unwrap().unwrap().len(),
            MAX_BATCH
        );
        let over_limit = std::env::join_paths(paths.iter().chain(paths.first())).unwrap();
        assert!(matches!(
            import_paths_override(&over_limit),
            Err(AppError::Internal(_))
        ));
    }

    #[test]
    fn folder_choices_reject_relative_or_nul_paths() {
        for invalid in ["", "relative", r"C:relative", "C:\\folder\0other"] {
            assert!(absolute_path(PathBuf::from(invalid)).is_err());
        }
        assert_eq!(
            absolute_path(PathBuf::from(r"C:\chosen")).unwrap(),
            PathBuf::from(r"C:\chosen")
        );
    }

    #[test]
    fn sync_root_matching_is_component_aware_and_ignores_windows_case() {
        let root = Path::new(r"\\?\C:\Users\Student\OneDrive");
        for path in [
            r"\\?\c:\users\student\onedrive",
            r"\\?\C:\Users\Student\OneDrive\课程",
        ] {
            assert!(inside_root(Path::new(path), root).unwrap());
        }
        for path in [
            r"\\?\C:\Users\Student\OneDrive-copy",
            r"\\?\C:\Users\Student",
            r"\\?\D:\Users\Student\OneDrive",
        ] {
            assert!(!inside_root(Path::new(path), root).unwrap());
        }
    }

    /// Short-lived STAs must not unload cached WinRT factories (see `hold_mta`). Only Windows
    /// Server 2022 crashes without the hold; the flag check covers Windows 11.
    #[test]
    fn sync_root_lookups_hold_com_for_the_process() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        for _ in 0..3 {
            // The answer depends on this machine's registrations; the process must survive.
            let _ = in_sta(|| sync_provider(&root));
        }
        assert!(MTA_HELD.load(Ordering::Relaxed));
    }

    #[test]
    fn only_the_registered_provider_part_selects_the_label() {
        for (id, expected) in [
            ("iCloudDrive!sid!account", SyncProvider::ICloud),
            ("iCloudPhotos!sid!account", SyncProvider::ICloud),
            ("onedrive!sid!Personal", SyncProvider::OneDrive),
            ("Dropbox!sid!account", SyncProvider::Dropbox),
            ("Other!sid!OneDrive", SyncProvider::Other),
            ("OneDrive-copy!sid!account", SyncProvider::Other),
        ] {
            assert_eq!(provider_from_id(id), expected);
        }
    }
}
