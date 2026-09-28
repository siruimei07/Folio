//! Win32 handles shared by the adapters: opening folders and files without keeping other
//! programs from them, typed file information, and the volume a library is on
//! (docs/specs/windows-adapter.md §3.2).

#![allow(
    unsafe_code,
    reason = "Win32 FFI; each unsafe block states why it is sound"
)]

use std::fs::{self, OpenOptions};
use std::io;
use std::mem::{size_of, zeroed};
use std::os::windows::fs::OpenOptionsExt;
use std::os::windows::io::{AsRawHandle, OwnedHandle};
use std::path::{Component, Path, Prefix};
use std::ptr::null_mut;

use windows_sys::Win32::Foundation::MAX_PATH;
use windows_sys::Win32::Storage::FileSystem::{
    BY_HANDLE_FILE_INFORMATION, FILE_ATTRIBUTE_TAG_INFO, FILE_FLAG_BACKUP_SEMANTICS,
    FILE_FLAG_OPEN_REPARSE_POINT, FILE_ID_INFO, FILE_INFO_BY_HANDLE_CLASS, FILE_LIST_DIRECTORY,
    FILE_READ_ATTRIBUTES, FileAttributeTagInfo, FileIdInfo, GetDriveTypeW,
    GetFileInformationByHandle, GetFileInformationByHandleEx, GetVolumeInformationByHandleW,
};
use windows_sys::Win32::System::WindowsProgramming::DRIVE_REMOTE;

/// The volume a library is on (docs/specs/windows-adapter.md §3.2).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Volume {
    /// As Windows names it: `NTFS`, `exFAT`, `FAT32`, `ReFS`, …
    pub file_system: String,
    /// A drive of this computer. `false` for a network share, whatever file system it reports,
    /// and for anything Folio cannot tell from one.
    pub local: bool,
}

impl Volume {
    /// The volume of the folder at `path`, open as `folder`; a link at `path` is followed.
    pub(crate) fn of(path: &Path, folder: &OwnedHandle) -> io::Result<Self> {
        let mut name = [0u16; MAX_PATH as usize + 1];
        // SAFETY: `name` is writable for the length passed; the other outputs are optional.
        let ok = unsafe {
            GetVolumeInformationByHandleW(
                folder.as_raw_handle(),
                null_mut(),
                0,
                null_mut(),
                null_mut(),
                null_mut(),
                name.as_mut_ptr(),
                name.len() as u32,
            )
        };
        if ok == 0 {
            return Err(io::Error::last_os_error());
        }
        let length = name
            .iter()
            .position(|&unit| unit == 0)
            .unwrap_or(name.len());
        let local = drive_letter(&fs::canonicalize(path)?).is_some_and(|letter| {
            let root = [u16::from(letter), u16::from(b':'), u16::from(b'\\'), 0];
            // SAFETY: `root` is a NUL-terminated `X:\`.
            unsafe { GetDriveTypeW(root.as_ptr()) != DRIVE_REMOTE }
        });
        Ok(Self {
            file_system: String::from_utf16_lossy(&name[..length]),
            local,
        })
    }

    /// Local NTFS: stable file ids and extended change records.
    pub fn is_local_ntfs(&self) -> bool {
        self.local && self.file_system == "NTFS"
    }
}

/// The drive letter a canonical path (`\\?\C:\…`) starts with; a network share (`\\?\UNC\…`) has
/// none.
fn drive_letter(canonical: &Path) -> Option<u8> {
    match canonical.components().next()? {
        Component::Prefix(prefix) => match prefix.kind() {
            Prefix::VerbatimDisk(letter) | Prefix::Disk(letter) => Some(letter),
            _ => None,
        },
        _ => None,
    }
}

/// Opens the folder at `path` to list it, sharing it with every other program. A link at
/// `path` is followed.
pub(crate) fn open_folder(path: &Path) -> io::Result<OwnedHandle> {
    open(path, FILE_LIST_DIRECTORY, FILE_FLAG_BACKUP_SEMANTICS)
}

/// Opens what is at `path` for its attributes only, without following a link there. Opening a
/// cloud placeholder this way does not download it.
pub(crate) fn open_attributes(path: &Path) -> io::Result<OwnedHandle> {
    open(
        path,
        FILE_READ_ATTRIBUTES,
        FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
    )
}

/// std opens an existing file, shares reading, writing and deletion, and passes paths longer
/// than `MAX_PATH` in verbatim form.
fn open(path: &Path, access: u32, flags: u32) -> io::Result<OwnedHandle> {
    let file = OpenOptions::new()
        .access_mode(access)
        .custom_flags(flags)
        .open(path)?;
    Ok(file.into())
}

/// A structure that `GetFileInformationByHandleEx` fills for one information class.
///
/// # Safety
///
/// `CLASS` must fill exactly one `Self`, and every bit pattern must be a valid `Self`.
pub(crate) unsafe trait FileInformation: Copy {
    const CLASS: FILE_INFO_BY_HANDLE_CLASS;
}

// SAFETY: `FileIdInfo` fills a `FILE_ID_INFO`, an integer and a byte array.
unsafe impl FileInformation for FILE_ID_INFO {
    const CLASS: FILE_INFO_BY_HANDLE_CLASS = FileIdInfo;
}

// SAFETY: `FileAttributeTagInfo` fills a `FILE_ATTRIBUTE_TAG_INFO`, two integers.
unsafe impl FileInformation for FILE_ATTRIBUTE_TAG_INFO {
    const CLASS: FILE_INFO_BY_HANDLE_CLASS = FileAttributeTagInfo;
}

pub(crate) fn information<T: FileInformation>(handle: &OwnedHandle) -> io::Result<T> {
    // SAFETY: every bit pattern is a valid `T` (the trait's contract).
    let mut value: T = unsafe { zeroed() };
    // SAFETY: `value` is writable for `size_of::<T>()` bytes, which is what `T::CLASS` fills.
    let ok = unsafe {
        GetFileInformationByHandleEx(
            handle.as_raw_handle(),
            T::CLASS,
            (&raw mut value).cast(),
            size_of::<T>() as u32,
        )
    };
    if ok == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(value)
}

/// Attributes, times, size, volume serial number and file index of what `handle` is open on.
pub(crate) fn basic_information(handle: &OwnedHandle) -> io::Result<BY_HANDLE_FILE_INFORMATION> {
    // SAFETY: the structure holds only integers, so all zeros is valid.
    let mut value: BY_HANDLE_FILE_INFORMATION = unsafe { zeroed() };
    // SAFETY: `value` is writable and lives through the call.
    let ok = unsafe { GetFileInformationByHandle(handle.as_raw_handle(), &mut value) };
    if ok == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tells_drive_letters_from_network_shares() {
        assert_eq!(drive_letter(Path::new(r"\\?\E:\资料")), Some(b'E'));
        assert_eq!(drive_letter(Path::new(r"\\?\UNC\nas\home\资料")), None);
        assert_eq!(drive_letter(Path::new(r"\\?\Volume{0f1e2d3c}\资料")), None);
    }

    #[test]
    fn a_temporary_folder_is_on_local_ntfs() {
        let dir = tempfile::tempdir().unwrap();
        let volume = Volume::of(dir.path(), &open_folder(dir.path()).unwrap()).unwrap();
        assert!(volume.is_local_ntfs(), "{volume:?}");
    }

    #[test]
    fn opening_a_missing_path_fails_as_not_found() {
        let dir = tempfile::tempdir().unwrap();
        let error = open_attributes(&dir.path().join("missing")).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::NotFound);
    }
}
