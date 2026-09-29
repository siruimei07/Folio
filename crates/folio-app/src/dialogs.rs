//! Shell-owned folder choices and registered Windows sync roots (ADR-0004).

#![allow(
    unsafe_code,
    reason = "Windows COM FFI; each unsafe block states why it is sound"
)]

use std::ffi::OsString;
use std::os::windows::ffi::{OsStrExt, OsStringExt};
use std::path::{Path, PathBuf};

use windows::Storage::Provider::StorageProviderSyncRootManager;
use windows::Win32::Foundation::{ERROR_CANCELLED, HWND};
use windows::Win32::Globalization::{CSTR_EQUAL, CompareStringOrdinal};
use windows::Win32::System::Com::{CLSCTX_INPROC_SERVER, CoCreateInstance, CoTaskMemFree};
use windows::Win32::System::WinRT::{RO_INIT_SINGLETHREADED, RoInitialize, RoUninitialize};
use windows::Win32::UI::Shell::{
    FOS_DONTADDTORECENT, FOS_FORCEFILESYSTEM, FOS_NOCHANGEDIR, FOS_PATHMUSTEXIST, FOS_PICKFOLDERS,
    FileOpenDialog, IFileOpenDialog, SIGDN_FILESYSPATH,
};
use windows::core::{HRESULT, PWSTR};

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
        // SAFETY: the item is live. GetDisplayName allocates a null-terminated CoTaskMem string.
        let name =
            TaskMemString(unsafe { item.GetDisplayName(SIGDN_FILESYSPATH) }.map_err(native_error)?);
        if name.0.is_null() {
            return Err(AppError::Internal(
                "folder dialog returned a null path".into(),
            ));
        }
        // SAFETY: GetDisplayName's string remains allocated until `name` drops after this copy.
        let path = PathBuf::from(OsString::from_wide(unsafe { name.0.as_wide() }));
        absolute_path(path).map(Some)
    })
}

/// Classifies a canonical folder using Windows' registered sync roots, including legacy
/// registrations. This is a warning, not an access grant. Unregistered providers cannot be
/// detected.
pub fn sync_provider(root: &Path) -> Result<Option<SyncProvider>, AppError> {
    in_sta(|| {
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
    })
}

fn absolute_path(path: PathBuf) -> Result<PathBuf, AppError> {
    if !path.is_absolute() || path.as_os_str().encode_wide().any(|unit| unit == 0) {
        return Err(AppError::Internal(
            "folder choice must be an absolute path without NUL".into(),
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
                // SAFETY: a new thread has no conflicting apartment. RoInitialize initializes
                // COM and WinRT together; all interfaces drop before the apartment guard.
                unsafe { RoInitialize(RO_INIT_SINGLETHREADED) }.map_err(native_error)?;
                let _apartment = Apartment;
                work()
            })
            .map_err(|error| AppError::Internal(format!("start shell COM worker: {error}")))?
            .join()
            .map_err(|_| AppError::Internal("shell COM worker panicked".into()))?
    })
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
        "Windows folder selection or sync-root lookup: {error}"
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

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
