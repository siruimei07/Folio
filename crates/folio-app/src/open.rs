//! Confined native file actions. UI paths are resolved in LibraryState's catalog transaction.

#![allow(
    unsafe_code,
    reason = "Win32/COM calls with owned handles and SAFETY contracts"
)]

use std::ffi::OsString;
use std::fs::{File, OpenOptions};
use std::io;
use std::os::windows::ffi::OsStringExt;
use std::os::windows::fs::{MetadataExt, OpenOptionsExt};
use std::os::windows::io::AsRawHandle;
use std::path::{Component, Path, PathBuf, Prefix};

use folio_core::catalog::Entry;
use folio_core::meta::{EntryKind, folio_part};
use windows_sys::Win32::Foundation::GENERIC_READ;
use windows_sys::Win32::Storage::FileSystem::DELETE;
use windows_sys::Win32::Storage::FileSystem::{
    FILE_ATTRIBUTE_OFFLINE, FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS, FILE_ATTRIBUTE_RECALL_ON_OPEN,
    FILE_ATTRIBUTE_REPARSE_POINT, FILE_ATTRIBUTE_TAG_INFO, FILE_FLAG_BACKUP_SEMANTICS,
    FILE_FLAG_OPEN_NO_RECALL, FILE_FLAG_OPEN_REPARSE_POINT, FILE_ID_INFO,
    FILE_INFO_BY_HANDLE_CLASS, FILE_LIST_DIRECTORY, FILE_READ_ATTRIBUTES, FILE_SHARE_READ,
    FILE_SHARE_WRITE, FileAttributeTagInfo, FileIdInfo, GetFileInformationByHandleEx,
    GetFinalPathNameByHandleW,
};

use crate::error::AppError;
use crate::library::io_error;

mod actions;
pub(crate) use actions::{open, reveal};

/// COM interfaces remain on the blocking thread that creates them, and drop before this guard.
pub(crate) struct Apartment(bool);

impl Apartment {
    pub fn new() -> Result<Self, AppError> {
        use windows::Win32::System::Com::{COINIT_APARTMENTTHREADED, CoInitializeEx};
        // SAFETY: this initializes COM on the calling thread, with no shared interface values.
        let result = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) };
        if result == windows::core::HRESULT(0x80010106_u32 as i32) {
            // A runtime thread may already have an apartment; never uninitialize its owner.
            return Ok(Self(false));
        }
        result
            .ok()
            .map_err(|error| AppError::FileSystem(format!("initialize COM: {error}")))?;
        Ok(Self(true))
    }
}

impl Drop for Apartment {
    fn drop(&mut self) {
        if self.0 {
            // SAFETY: balances exactly this guard's successful initialization on this thread.
            unsafe { windows::Win32::System::Com::CoUninitialize() };
        }
    }
}

/// Holds directory components against replacement and the original leaf object for revalidation.
/// File content/path actions obtain a sharing-participating handle with read() or freeze().
/// Never put a path from the UI directly in this type.
///
/// Resolve it inside `LibraryState::with_entry`, then act on it after that returns: the handles
/// keep the checked path, so the catalog writer and library switches need not wait for a read,
/// a thumbnail or an app launch.
pub(crate) struct PinnedEntry {
    pub path: PathBuf,
    pub folder: bool,
    /// The library root, its ancestors and the entry's parent folders.
    folders: Vec<File>,
    leaf: File,
    identity: (u64, [u8; 16]),
}

impl PinnedEntry {
    pub fn resolve(root: &Path, entry: &Entry) -> Result<Self, AppError> {
        let mut folders = pin_directories(root)?;
        let mut path = root.to_path_buf();
        let folder = entry.record.kind == EntryKind::Folder;
        let names = entry.record.path.names().collect::<Vec<_>>();
        let mut leaf = None;
        for (index, name) in names.iter().enumerate() {
            path.push(name);
            let last = index + 1 == names.len();
            let file = pin(&path, last && !folder)?;
            let resolved = final_path(&file)?;
            let relative = resolved
                .strip_prefix(root)
                .map_err(|_| AppError::NotFound("the entry escaped the library".to_owned()))?;
            let first = relative.components().next();
            if first.is_some_and(|name| folio_part(&[name.as_os_str().to_owned()]).is_some()) {
                return Err(AppError::NotFound(
                    "Folio metadata is not an entry".to_owned(),
                ));
            }
            let metadata = file.metadata().map_err(io_error)?;
            if !last {
                if !metadata.is_dir() {
                    return Err(AppError::NotFound(
                        "an entry parent is not a folder".to_owned(),
                    ));
                }
                folders.push(file);
                continue;
            }
            if metadata.is_dir() != folder || (!folder && !metadata.is_file()) {
                return Err(AppError::NotFound("the entry changed kind".to_owned()));
            }
            leaf = Some(file);
        }
        let leaf =
            leaf.ok_or_else(|| AppError::Internal("an entry path has no names".to_owned()))?;
        Ok(Self {
            path,
            folder,
            folders,
            identity: identity(&leaf)?,
            leaf,
        })
    }

    pub fn local(&self) -> Result<bool, AppError> {
        local(&self.leaf)
    }

    /// The leaf's size and modification time, read without opening its content.
    pub fn metadata(&self) -> Result<std::fs::Metadata, AppError> {
        self.leaf.metadata().map_err(io_error)
    }

    /// The leaf's file id as the Windows scanner records it (`EntryRecord::file_id`: volume
    /// serial and 128-bit id in hexadecimal, folio-core `win::dir_info::file_id_text`).
    pub fn file_id(&self) -> String {
        let (serial, id) = self.identity;
        format!("{serial:x}-{:x}", u128::from_le_bytes(id))
    }

    /// Detects attribute-only redirection as well as ordinary path replacement.
    pub fn validate(&self) -> Result<(), AppError> {
        for file in self.folders.iter().chain([&self.leaf]) {
            no_redirect(file)?;
        }
        if final_path(&self.leaf)? != self.path {
            return Err(AppError::NotFound("the entry path changed".to_owned()));
        }
        Ok(())
    }

    pub fn read(&self) -> Result<File, AppError> {
        if self.folder {
            return Err(AppError::NotFound("the entry is a folder".to_owned()));
        }
        if !self.local()? {
            return Err(AppError::NotLocal(
                "the scheme never downloads files".to_owned(),
            ));
        }
        let file = self.reopen(GENERIC_READ)?;
        if !local(&file)? {
            return Err(AppError::NotLocal("the file is no longer local".to_owned()));
        }
        Ok(file)
    }

    /// Revalidates before a path-based shell API and holds against deletion/data writes.
    /// Attribute-only reparse changes are not excluded by Windows sharing checks.
    /// For a nonlocal file use DELETE access,
    /// without deleting anything or requesting data; NO_RECALL and OPEN_REPARSE remain set.
    /// If the ACL denies that right, fail closed rather than expose an unpinned cloud path.
    pub fn freeze(&self) -> Result<File, AppError> {
        self.validate()?;
        if self.folder {
            return self.leaf.try_clone().map_err(io_error);
        }
        self.reopen(if self.local()? {
            GENERIC_READ
        } else {
            DELETE | FILE_READ_ATTRIBUTES
        })
    }

    fn reopen(&self, access: u32) -> Result<File, AppError> {
        // ReOpenFile rejects OPEN_NO_RECALL with error 87 on the supported local NTFS
        // machine. CreateFile supports that flag: pin ancestors, open without following
        // the leaf reparse point, then match its 128-bit identity to the original handle.
        let file = OpenOptions::new()
            .access_mode(access)
            .share_mode(FILE_SHARE_READ)
            .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_OPEN_NO_RECALL)
            .open(&self.path)
            .map_err(io_error)?;
        no_redirect(&file)?;
        if identity(&file)? != self.identity || final_path(&file)? != self.path {
            return Err(AppError::NotFound("the entry path changed".to_owned()));
        }
        Ok(file)
    }
}

/// One `GetFileInformationByHandleEx` class. `T` must be the plain-data structure of `class`.
fn information<T: Copy>(file: &File, class: FILE_INFO_BY_HANDLE_CLASS) -> Result<T, AppError> {
    let mut info = std::mem::MaybeUninit::<T>::zeroed();
    // SAFETY: the live handle and a writable output of exactly the structure's ABI size; the
    // callers pair each class with its structure, which holds integers and byte arrays only.
    if unsafe {
        GetFileInformationByHandleEx(
            file.as_raw_handle(),
            class,
            info.as_mut_ptr().cast(),
            std::mem::size_of::<T>() as u32,
        )
    } == 0
    {
        return Err(io_error(io::Error::last_os_error()));
    }
    // SAFETY: the call succeeded and filled the structure.
    Ok(unsafe { info.assume_init() })
}

fn identity(file: &File) -> Result<(u64, [u8; 16]), AppError> {
    let info = information::<FILE_ID_INFO>(file, FileIdInfo)?;
    Ok((info.VolumeSerialNumber, info.FileId.Identifier))
}

/// Protects ancestors too: replacing a parent of the library with a junction must not
/// redirect a later shell API even though the original root handle is still alive.
fn pin_directories(path: &Path) -> Result<Vec<File>, AppError> {
    let mut current = PathBuf::new();
    let mut guards = Vec::new();
    for component in path.components() {
        current.push(component.as_os_str());
        if matches!(component, Component::Prefix(_)) {
            continue;
        }
        let file = pin(&current, false)?;
        if final_path(&file)? != current || !file.metadata().map_err(io_error)?.is_dir() {
            return Err(AppError::NotFound("a checked directory changed".to_owned()));
        }
        guards.push(file);
    }
    Ok(guards)
}

/// Opens a folder, or only the metadata of a file, so that nobody can rename, delete or replace
/// it while the handle lives. Folders share writing too: a folder handle that denies it makes
/// Windows refuse every rename into that folder, by any program (saves through a temporary file,
/// sync clients, Folio's own renames). A file may be edited by its default app.
fn pin(path: &Path, is_file: bool) -> Result<File, AppError> {
    let file = OpenOptions::new()
        .access_mode(FILE_READ_ATTRIBUTES | if is_file { 0 } else { FILE_LIST_DIRECTORY })
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
        .custom_flags(
            FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_OPEN_NO_RECALL,
        )
        .open(path)
        .map_err(io_error)?;
    no_redirect(&file)?;
    Ok(file)
}

fn local(file: &File) -> Result<bool, AppError> {
    Ok(file.metadata().map_err(io_error)?.file_attributes()
        & (FILE_ATTRIBUTE_OFFLINE
            | FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS
            | FILE_ATTRIBUTE_RECALL_ON_OPEN)
        == 0)
}

fn no_redirect(file: &File) -> Result<(), AppError> {
    let info = information::<FILE_ATTRIBUTE_TAG_INFO>(file, FileAttributeTagInfo)?;
    // Cloud reparse tags are allowed; name-surrogate tags (links/junctions) never are.
    if info.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0 && info.ReparseTag & 0x2000_0000 != 0
    {
        return Err(AppError::NotFound(
            "links and junctions are not library entries".to_owned(),
        ));
    }
    Ok(())
}

fn final_path(file: &File) -> Result<PathBuf, AppError> {
    // Most paths fit; a longer one gets the size it needs, up to the longest Windows path.
    let mut buffer = vec![0_u16; 512];
    loop {
        // SAFETY: a live handle and a writable UTF-16 buffer; DOS/normalized names use flags 0.
        let length = unsafe {
            GetFinalPathNameByHandleW(
                file.as_raw_handle(),
                buffer.as_mut_ptr(),
                buffer.len() as u32,
                0,
            )
        } as usize;
        if length == 0 {
            return Err(io_error(io::Error::last_os_error()));
        }
        if length < buffer.len() {
            return Ok(PathBuf::from(OsString::from_wide(&buffer[..length])));
        }
        // Too small: `length` counts the terminating NUL.
        if length > 32_768 || buffer.len() >= length {
            return Err(AppError::FileSystem("resolved path is too long".to_owned()));
        }
        buffer.resize(length, 0);
    }
}

/// Shell parsing APIs reject verbatim paths. Convert only a pinned, canonical path and
/// verify the ordinary spelling resolves identically, so Win32 normalization cannot redirect it.
pub(crate) fn shell_path(path: &Path) -> Result<PathBuf, AppError> {
    let mut parts = path.components();
    let mut plain = match parts.next() {
        Some(Component::Prefix(prefix)) => match prefix.kind() {
            Prefix::VerbatimDisk(letter) => PathBuf::from(format!("{}:", char::from(letter))),
            Prefix::VerbatimUNC(server, share) => {
                let mut prefix = OsString::from(r"\\");
                prefix.push(server);
                prefix.push(r"\");
                prefix.push(share);
                PathBuf::from(prefix)
            }
            _ => return Ok(path.to_path_buf()),
        },
        _ => {
            return Err(AppError::FileSystem(
                "shell path has no absolute prefix".to_owned(),
            ));
        }
    };
    plain.extend(parts);
    if plain.canonicalize().map_err(io_error)? != path {
        return Err(AppError::NotFound(
            "shell path normalization changed the entry".to_owned(),
        ));
    }
    Ok(plain)
}

#[cfg(test)]
pub(crate) mod tests;
