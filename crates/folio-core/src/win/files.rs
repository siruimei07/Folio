//! `WindowsFileSystem`: file ids and placeholder states from one directory listing on local NTFS,
//! and `StdFileSystem`'s behaviour anywhere else (docs/specs/windows-adapter.md §3.2).

#![allow(
    unsafe_code,
    reason = "Win32 FFI; each unsafe block states why it is sound"
)]

use std::cell::RefCell;
use std::io::{self, Read};
use std::os::windows::io::{AsRawHandle, OwnedHandle};
use std::path::Path;

use windows_sys::Win32::Foundation::{ERROR_FILE_NOT_FOUND, ERROR_NO_MORE_FILES, FILETIME};
use windows_sys::Win32::Storage::FileSystem::{
    FILE_ATTRIBUTE_REPARSE_POINT, FILE_ATTRIBUTE_TAG_INFO, FILE_ID_INFO, FileIdExtdDirectoryInfo,
    FileIdExtdDirectoryRestartInfo, GetFileInformationByHandleEx,
};

use super::dir_info;
use super::handle::{self, Volume, unsupported};
use crate::fs::{DirEntry, FileSystem, Metadata, StdFileSystem};

/// Bytes a listing call fills; a large folder takes several calls.
const LISTING_BYTES: usize = 64 * 1024;

/// A listing buffer, aligned for the records' 8-byte fields.
#[repr(align(8))]
struct Listing([u8; LISTING_BYTES]);

thread_local! {
    /// Reused for every folder a thread lists.
    static LISTING: RefCell<Box<Listing>> = RefCell::new(Box::new(Listing([0; LISTING_BYTES])));
}

/// The file-system adapter on Windows.
#[derive(Debug, Clone)]
pub struct WindowsFileSystem {
    volume: Volume,
    /// The volume's serial number, part of every file id; `None` without file ids. Decided once,
    /// so that listings and `metadata` always agree on whether there are ids.
    serial: Option<u64>,
}

impl WindowsFileSystem {
    /// The adapter for the library at `root`, on the volume `root` is on (a link at `root` is
    /// followed). Fails when `root` cannot be opened or listed.
    pub fn open(root: &Path) -> io::Result<Self> {
        let folder = handle::open_folder(root)?;
        let volume = Volume::of(root, &folder)?;
        let serial = if volume.is_local_ntfs() {
            probe(root, &folder)?
        } else {
            None
        };
        Ok(Self { volume, serial })
    }

    pub fn volume(&self) -> &Volume {
        &self.volume
    }

    /// Whether entries get file ids, so that moves made outside Folio are found.
    pub fn has_file_ids(&self) -> bool {
        self.serial.is_some()
    }
}

/// The serial number, if the root lists with file ids: some file systems call themselves NTFS
/// without these listings.
fn probe(root: &Path, folder: &OwnedHandle) -> io::Result<Option<u64>> {
    let serial = match handle::information::<FILE_ID_INFO>(folder) {
        Ok(id) => id.VolumeSerialNumber,
        Err(error) if unsupported(&error) => return Ok(None),
        Err(error) => return Err(error),
    };
    match list(root, serial) {
        Ok(_) => Ok(Some(serial)),
        Err(error) if unsupported(&error) => Ok(None),
        Err(error) => Err(error),
    }
}

impl FileSystem for WindowsFileSystem {
    fn read_dir(&self, folder: &Path) -> io::Result<Vec<DirEntry>> {
        match self.serial {
            Some(serial) => list(folder, serial),
            None => StdFileSystem.read_dir(folder),
        }
    }

    fn metadata(&self, path: &Path) -> io::Result<Metadata> {
        let Some(serial) = self.serial else {
            return StdFileSystem.metadata(path);
        };
        let file = handle::open_attributes(path)?;
        let basic = handle::basic_information(&file)?;
        // The tag means something only on a reparse point.
        let tag = if basic.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            handle::information::<FILE_ATTRIBUTE_TAG_INFO>(&file)?.ReparseTag
        } else {
            0
        };
        // On NTFS the file index is the file id, as in listings. A path that ended up on another
        // volume gets that volume's serial number.
        let serial = if basic.dwVolumeSerialNumber == serial as u32 {
            serial
        } else {
            handle::information::<FILE_ID_INFO>(&file)?.VolumeSerialNumber
        };
        let index = (u64::from(basic.nFileIndexHigh) << 32) | u64::from(basic.nFileIndexLow);
        let filetime =
            |time: FILETIME| (i64::from(time.dwHighDateTime) << 32) | i64::from(time.dwLowDateTime);
        Ok(dir_info::metadata(
            basic.dwFileAttributes,
            tag,
            (u64::from(basic.nFileSizeHigh) << 32) | u64::from(basic.nFileSizeLow),
            filetime(basic.ftLastWriteTime),
            filetime(basic.ftCreationTime),
            dir_info::file_id_text(serial, u128::from(index)),
        ))
    }

    fn open(&self, path: &Path) -> io::Result<Box<dyn Read + '_>> {
        StdFileSystem.open(path)
    }
}

/// The folder's entries with their file ids.
fn list(folder: &Path, serial: u64) -> io::Result<Vec<DirEntry>> {
    let folder = handle::open_folder(folder)?;
    let mut entries = Vec::new();
    let mut class = FileIdExtdDirectoryRestartInfo;
    LISTING.with_borrow_mut(|listing| {
        loop {
            // SAFETY: the buffer is writable for the length passed.
            let ok = unsafe {
                GetFileInformationByHandleEx(
                    folder.as_raw_handle(),
                    class,
                    listing.0.as_mut_ptr().cast(),
                    LISTING_BYTES as u32,
                )
            };
            if ok == 0 {
                let error = io::Error::last_os_error();
                return match error.raw_os_error().map(|code| code as u32) {
                    Some(ERROR_NO_MORE_FILES) => Ok(entries),
                    // A folder with no entries at all, not even `.` and `..`.
                    Some(ERROR_FILE_NOT_FOUND) if class == FileIdExtdDirectoryRestartInfo => {
                        Ok(entries)
                    }
                    _ => Err(error),
                };
            }
            class = FileIdExtdDirectoryInfo;
            dir_info::entries(&listing.0, serial, &mut entries)?;
        }
    })
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::os::windows::ffi::OsStrExt;
    use std::path::PathBuf;
    use std::process::Command;

    use super::*;
    use crate::fs::{FileKind, Presence};

    fn adapter(dir: &Path) -> WindowsFileSystem {
        let adapter = WindowsFileSystem::open(dir).unwrap();
        assert!(adapter.has_file_ids(), "{:?}", adapter.volume());
        adapter
    }

    fn sorted(mut entries: Vec<DirEntry>) -> Vec<DirEntry> {
        entries.sort_by(|a, b| a.name.cmp(&b.name));
        entries
    }

    fn file_id(adapter: &WindowsFileSystem, path: &Path) -> String {
        adapter.metadata(path).unwrap().file_id.unwrap()
    }

    fn run(command: &mut Command) {
        let status = command.output().unwrap().status;
        assert!(status.success(), "{command:?}");
    }

    /// Unlike a symbolic link, a junction needs no privileges.
    fn junction(link: &Path, target: &Path) {
        run(Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(link)
            .arg(target));
    }

    /// The kind and id of an entry: a folder's times in its parent's listing may lag behind the
    /// folder's own (NTFS updates that copy lazily), and hashing compares files only.
    fn kind_and_id(metadata: &Metadata) -> (FileKind, Option<&str>) {
        (metadata.kind, metadata.file_id.as_deref())
    }

    #[test]
    fn lists_what_std_lists_with_file_ids() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("笔记.md"), "# 线性代数").unwrap();
        fs::write(dir.path().join("empty.txt"), "").unwrap();
        fs::create_dir(dir.path().join("作业")).unwrap();
        fs::write(dir.path().join("作业/hw1.pdf"), [0u8; 3000]).unwrap();
        let adapter = adapter(dir.path());

        let ours = sorted(adapter.read_dir(dir.path()).unwrap());
        let std = sorted(StdFileSystem.read_dir(dir.path()).unwrap());
        assert_eq!(ours.len(), 3);
        for (ours, std) in ours.iter().zip(&std) {
            let without_id = Metadata {
                file_id: None,
                ..ours.metadata.clone()
            };
            assert_eq!((&ours.name, &without_id), (&std.name, &std.metadata));
            assert_eq!(ours.metadata.presence, Presence::Local);
            let opened = adapter.metadata(&dir.path().join(&ours.name)).unwrap();
            if ours.metadata.kind == FileKind::File {
                // What the hashing pass compares: the listing and the file agree.
                assert_eq!(opened, ours.metadata);
            } else {
                assert_eq!(kind_and_id(&opened), kind_and_id(&ours.metadata));
            }
        }
        assert!(ours.iter().all(|entry| entry.metadata.file_id.is_some()));
    }

    #[test]
    fn file_ids_follow_renames_and_moves_and_differ_between_files() {
        let dir = tempfile::tempdir().unwrap();
        let (a, b) = (dir.path().join("a.md"), dir.path().join("b.md"));
        fs::write(&a, "a").unwrap();
        fs::write(&b, "b").unwrap();
        fs::create_dir(dir.path().join("sub")).unwrap();
        let adapter = adapter(dir.path());
        let id = file_id(&adapter, &a);
        assert_ne!(id, file_id(&adapter, &b));

        let renamed = dir.path().join("A 笔记.md");
        fs::rename(&a, &renamed).unwrap();
        assert_eq!(file_id(&adapter, &renamed), id);
        let moved = dir.path().join("sub/A 笔记.md");
        fs::rename(&renamed, &moved).unwrap();
        assert_eq!(file_id(&adapter, &moved), id);
        let listed = adapter.read_dir(&dir.path().join("sub")).unwrap();
        assert_eq!(listed[0].metadata.file_id.as_deref(), Some(id.as_str()));

        // A file saved through a temporary file is a new file.
        fs::write(dir.path().join("b.tmp"), "b2").unwrap();
        fs::rename(dir.path().join("b.tmp"), &b).unwrap();
        assert_ne!(file_id(&adapter, &b), id);
    }

    #[test]
    fn hard_links_share_an_id() {
        let dir = tempfile::tempdir().unwrap();
        let (file, link) = (dir.path().join("a.md"), dir.path().join("b.md"));
        fs::write(&file, "a").unwrap();
        fs::hard_link(&file, &link).unwrap();
        let adapter = adapter(dir.path());
        assert_eq!(file_id(&adapter, &file), file_id(&adapter, &link));
    }

    #[test]
    fn junctions_are_links_and_are_not_followed() {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir(dir.path().join("target")).unwrap();
        fs::write(dir.path().join("target/inside.md"), "x").unwrap();
        junction(&dir.path().join("link"), &dir.path().join("target"));
        let adapter = adapter(dir.path());

        let listed = adapter.read_dir(dir.path()).unwrap();
        let link = listed.iter().find(|entry| entry.name == "link").unwrap();
        assert_eq!(link.metadata.kind, FileKind::Link);
        let opened = adapter.metadata(&dir.path().join("link")).unwrap();
        assert_eq!(kind_and_id(&opened), kind_and_id(&link.metadata));
        let target = adapter.metadata(&dir.path().join("target")).unwrap();
        assert_ne!(opened.file_id, target.file_id);
    }

    #[test]
    fn a_library_root_behind_a_junction_is_listed() {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir(dir.path().join("target")).unwrap();
        fs::write(dir.path().join("target/inside.md"), "x").unwrap();
        let root = dir.path().join("library");
        junction(&root, &dir.path().join("target"));
        let listed = adapter(&root).read_dir(&root).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].name, "inside.md");
    }

    #[test]
    fn offline_files_are_reported_by_both_adapters() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("offline.md");
        fs::write(&file, "x").unwrap();
        run(Command::new("attrib").arg("+O").arg(&file));
        let adapter = adapter(dir.path());

        let adapters: [&dyn FileSystem; 2] = [&adapter, &StdFileSystem];
        for adapter in adapters {
            assert_eq!(adapter.metadata(&file).unwrap().presence, Presence::Offline);
            let listed = adapter.read_dir(dir.path()).unwrap();
            assert_eq!(listed[0].metadata.presence, Presence::Offline);
        }
    }

    #[test]
    fn missing_paths_are_not_found() {
        let dir = tempfile::tempdir().unwrap();
        let adapter = adapter(dir.path());
        let missing = dir.path().join("missing");
        assert_eq!(
            adapter.metadata(&missing).unwrap_err().kind(),
            io::ErrorKind::NotFound
        );
        assert_eq!(
            adapter.read_dir(&missing).unwrap_err().kind(),
            io::ErrorKind::NotFound
        );
    }

    #[test]
    fn lists_folders_with_more_entries_than_one_call_returns() {
        let dir = tempfile::tempdir().unwrap();
        // About 270 bytes per record: several calls of 64 KiB.
        let names: Vec<String> = (0..600)
            .map(|index| format!("第{index:03}讲 {}.md", "长".repeat(80)))
            .collect();
        for name in &names {
            fs::write(dir.path().join(name), "x").unwrap();
        }
        let listed = sorted(adapter(dir.path()).read_dir(dir.path()).unwrap());
        let listed: Vec<_> = listed
            .iter()
            .map(|entry| entry.name.to_str().unwrap())
            .collect();
        assert_eq!(listed, names);
    }

    #[test]
    fn paths_longer_than_max_path_work() {
        let dir = tempfile::tempdir().unwrap();
        let mut deep = PathBuf::from(dir.path());
        for _ in 0..30 {
            deep.push("文件夹文件夹文件夹");
        }
        fs::create_dir_all(&deep).unwrap();
        let file = deep.join("笔记.md");
        fs::write(&file, "deep").unwrap();
        assert!(file.as_os_str().encode_wide().count() > 260);

        let adapter = adapter(dir.path());
        let listed = adapter.read_dir(&deep).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(adapter.metadata(&file).unwrap(), listed[0].metadata);
    }

    #[test]
    #[ignore = "needs FOLIO_TEST_NON_NTFS_DIR, a folder on a volume that is not NTFS"]
    fn off_ntfs_lists_like_std_without_file_ids() {
        let dir = tempfile::tempdir_in(super::super::non_ntfs_dir()).unwrap();
        fs::write(dir.path().join("笔记.md"), "# 线性代数").unwrap();
        fs::create_dir(dir.path().join("作业")).unwrap();
        let adapter = WindowsFileSystem::open(dir.path()).unwrap();
        assert!(!adapter.has_file_ids(), "{:?}", adapter.volume());
        assert!(!adapter.volume().is_local_ntfs());

        let ours = sorted(adapter.read_dir(dir.path()).unwrap());
        assert_eq!(ours, sorted(StdFileSystem.read_dir(dir.path()).unwrap()));
        assert!(ours.iter().all(|entry| entry.metadata.file_id.is_none()));
        let file = dir.path().join("笔记.md");
        assert_eq!(
            adapter.metadata(&file).unwrap(),
            StdFileSystem.metadata(&file).unwrap()
        );
    }
}
