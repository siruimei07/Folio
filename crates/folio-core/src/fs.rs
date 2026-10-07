//! The file-system adapter: how the core reads the user's files (docs/specs/library-scan.md §3).
//!
//! The library reaches the files it manages only through [`FileSystem`], so tests can use a fake
//! and the Windows adapter (`win::WindowsFileSystem`) can add what `std` cannot report, such as
//! NTFS file ids. Folio's own files in `.folio/` are read and written with `std::fs` by the `meta`
//! module.

use std::ffi::OsString;
use std::fs::{self, File};
use std::io::{self, BufReader, Cursor, Read, Seek};
use std::path::Path;
use std::time::SystemTime;

pub use crate::files::is_in_use;

/// Read access to the files of a library.
pub trait FileSystem: Send + Sync {
    /// The entries directly in `folder`, in any order, without `.` and `..`.
    fn read_dir(&self, folder: &Path) -> io::Result<Vec<DirEntry>>;

    /// What is at `path`, without following a link there.
    fn metadata(&self, path: &Path) -> io::Result<Metadata>;

    /// Opens the file at `path` for reading, without keeping other programs from reading,
    /// writing or deleting it.
    fn open(&self, path: &Path) -> io::Result<Box<dyn Read + '_>>;

    /// Opens the file at `path` as [`FileSystem::open`] does, for reading in any order: a Word
    /// document is read from its end, and only the parts that hold text.
    ///
    /// This default reads the whole file through `open` into memory, which suits fakes; an
    /// adapter over real files returns the file itself.
    fn open_seekable(&self, path: &Path) -> io::Result<Box<dyn ReadSeek + '_>> {
        let mut bytes = Vec::new();
        self.open(path)?.read_to_end(&mut bytes)?;
        Ok(Box::new(Cursor::new(bytes)))
    }
}

/// A reader that can also seek, as [`FileSystem::open_seekable`] returns.
pub trait ReadSeek: Read + Seek {}

impl<T: Read + Seek + ?Sized> ReadSeek for T {}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DirEntry {
    pub name: OsString,
    pub metadata: Metadata,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Metadata {
    pub kind: FileKind,
    /// Bytes; 0 for anything but files.
    pub size: u64,
    /// Nanoseconds since the Unix epoch.
    pub modified_ns: Option<i64>,
    pub created_ns: Option<i64>,
    /// An id that stays the same while the file is renamed or moved on its volume, and differs
    /// between files; opaque. `None` when the file system cannot provide one.
    pub file_id: Option<String>,
    pub presence: Presence,
}

impl Metadata {
    /// Metadata whose size counts only for files.
    pub(crate) fn new(
        kind: FileKind,
        size: u64,
        modified_ns: Option<i64>,
        created_ns: Option<i64>,
        file_id: Option<String>,
        presence: Presence,
    ) -> Self {
        Self {
            kind,
            size: if kind == FileKind::File { size } else { 0 },
            modified_ns,
            created_ns,
            file_id,
            presence,
        }
    }
}

/// Whether the content of a file is on this disk (docs/specs/windows-adapter.md §3.1).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Presence {
    /// On this disk.
    Local,
    /// A cloud placeholder, such as a OneDrive or iCloud file that is only in the cloud: reading
    /// it downloads it first.
    Placeholder,
    /// In offline storage: reading it may be slow or fail.
    Offline,
}

impl Presence {
    /// What a file's Windows attributes say, whatever adapter read them.
    #[cfg(windows)]
    pub(crate) fn of_attributes(attributes: u32) -> Self {
        use windows_sys::Win32::Storage::FileSystem::{
            FILE_ATTRIBUTE_OFFLINE, FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS,
            FILE_ATTRIBUTE_RECALL_ON_OPEN,
        };
        if attributes & (FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS | FILE_ATTRIBUTE_RECALL_ON_OPEN) != 0
        {
            Self::Placeholder
        } else if attributes & FILE_ATTRIBUTE_OFFLINE != 0 {
            Self::Offline
        } else {
            Self::Local
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum FileKind {
    File,
    Folder,
    /// A symbolic link or a junction; never followed.
    Link,
    /// Anything else, such as a device, a socket or a pipe.
    Other,
}

/// The adapter over `std::fs`. It reports no file ids (docs/specs/library-scan.md §3); on Windows,
/// `win::WindowsFileSystem` does.
#[derive(Debug, Clone, Copy, Default)]
pub struct StdFileSystem;

impl FileSystem for StdFileSystem {
    fn read_dir(&self, folder: &Path) -> io::Result<Vec<DirEntry>> {
        fs::read_dir(folder)?
            .map(|entry| {
                let entry = entry?;
                // On Windows this comes from the directory listing; no file is opened.
                let metadata = metadata_of(&entry.metadata()?);
                Ok(DirEntry {
                    name: entry.file_name(),
                    metadata,
                })
            })
            .collect()
    }

    fn metadata(&self, path: &Path) -> io::Result<Metadata> {
        Ok(metadata_of(&fs::symlink_metadata(path)?))
    }

    fn open(&self, path: &Path) -> io::Result<Box<dyn Read + '_>> {
        // `std` opens files on Windows sharing reading, writing and deletion.
        Ok(Box::new(File::open(path)?))
    }

    fn open_seekable(&self, path: &Path) -> io::Result<Box<dyn ReadSeek + '_>> {
        // Buffered: readers that seek, such as zip's, make many small reads in between.
        Ok(Box::new(BufReader::new(File::open(path)?)))
    }
}

fn metadata_of(metadata: &fs::Metadata) -> Metadata {
    let file_type = metadata.file_type();
    let kind = if file_type.is_symlink() {
        FileKind::Link
    } else if file_type.is_dir() {
        FileKind::Folder
    } else if file_type.is_file() {
        FileKind::File
    } else {
        FileKind::Other
    };
    Metadata::new(
        kind,
        metadata.len(),
        metadata.modified().ok().and_then(unix_ns),
        metadata.created().ok().and_then(unix_ns),
        None,
        presence_of(metadata),
    )
}

#[cfg(windows)]
fn presence_of(metadata: &fs::Metadata) -> Presence {
    use std::os::windows::fs::MetadataExt;
    Presence::of_attributes(metadata.file_attributes())
}

#[cfg(not(windows))]
fn presence_of(_metadata: &fs::Metadata) -> Presence {
    Presence::Local
}

/// Nanoseconds since the Unix epoch, negative before it; `None` beyond the range of `i64`
/// (about the years 1678–2262).
pub fn unix_ns(time: SystemTime) -> Option<i64> {
    match time.duration_since(SystemTime::UNIX_EPOCH) {
        Ok(after) => i64::try_from(after.as_nanos()).ok(),
        Err(before) => i64::try_from(before.duration().as_nanos())
            .ok()
            .map(|ns| -ns),
    }
}

#[cfg(test)]
mod tests {
    use std::io::Write;
    use std::time::Duration;

    use super::*;

    #[test]
    fn lists_kinds_sizes_and_times_without_file_ids() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("笔记.md"), "# 线性代数").unwrap();
        fs::create_dir(dir.path().join("作业")).unwrap();

        let mut entries = StdFileSystem.read_dir(dir.path()).unwrap();
        entries.sort_by(|a, b| a.name.cmp(&b.name));
        let summary: Vec<_> = entries
            .iter()
            .map(|entry| {
                let metadata = &entry.metadata;
                assert!(metadata.modified_ns.is_some());
                assert_eq!(metadata.file_id, None);
                assert_eq!(metadata.presence, Presence::Local);
                (entry.name.to_str().unwrap(), metadata.kind, metadata.size)
            })
            .collect();
        assert_eq!(
            summary,
            [
                ("作业", FileKind::Folder, 0),
                ("笔记.md", FileKind::File, "# 线性代数".len() as u64),
            ]
        );

        let file = StdFileSystem.metadata(&dir.path().join("笔记.md")).unwrap();
        assert_eq!(file, entries[1].metadata);
        let mut text = String::new();
        StdFileSystem
            .open(&dir.path().join("笔记.md"))
            .unwrap()
            .read_to_string(&mut text)
            .unwrap();
        assert_eq!(text, "# 线性代数");
    }

    /// Reads `len` bytes at `from`, and then the last `tail` bytes, through `file`.
    fn seek_and_read(
        file: &mut dyn ReadSeek,
        from: u64,
        len: usize,
        tail: i64,
    ) -> (Vec<u8>, Vec<u8>) {
        use std::io::SeekFrom;
        let mut middle = vec![0; len];
        file.seek(SeekFrom::Start(from)).unwrap();
        file.read_exact(&mut middle).unwrap();
        let mut end = Vec::new();
        file.seek(SeekFrom::End(-tail)).unwrap();
        file.read_to_end(&mut end).unwrap();
        (middle, end)
    }

    #[test]
    fn opens_the_file_itself_for_seeking() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("论文.docx");
        fs::write(&path, b"0123456789").unwrap();
        let mut file = StdFileSystem.open_seekable(&path).unwrap();
        assert_eq!(
            seek_and_read(&mut *file, 4, 3, 2),
            (b"456".to_vec(), b"89".to_vec())
        );
        // The file itself, not a copy: what another program appends shows, and it may write
        // while Folio reads.
        std::fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .unwrap()
            .write_all(b"AB")
            .unwrap();
        assert_eq!(
            seek_and_read(&mut *file, 9, 1, 2),
            (b"9".to_vec(), b"AB".to_vec())
        );
        let missing = StdFileSystem.open_seekable(&dir.path().join("missing.docx"));
        assert_eq!(
            missing.err().map(|error| error.kind()),
            Some(io::ErrorKind::NotFound)
        );
    }

    /// Only `open`: one file, `file.docx`, whose opens it counts.
    struct OpenOnly(std::sync::atomic::AtomicUsize);

    impl FileSystem for OpenOnly {
        fn read_dir(&self, _folder: &Path) -> io::Result<Vec<DirEntry>> {
            Err(io::ErrorKind::Unsupported.into())
        }

        fn metadata(&self, _path: &Path) -> io::Result<Metadata> {
            Err(io::ErrorKind::Unsupported.into())
        }

        fn open(&self, path: &Path) -> io::Result<Box<dyn Read + '_>> {
            if path != Path::new("file.docx") {
                return Err(io::ErrorKind::NotFound.into());
            }
            self.0.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            Ok(Box::new(&b"0123456789"[..]))
        }
    }

    #[test]
    fn opening_for_seeking_reads_through_open_by_default() {
        let fake = OpenOnly(Default::default());
        let mut file = fake.open_seekable(Path::new("file.docx")).unwrap();
        assert_eq!(
            seek_and_read(&mut *file, 4, 3, 2),
            (b"456".to_vec(), b"89".to_vec())
        );
        assert_eq!(fake.0.load(std::sync::atomic::Ordering::Relaxed), 1);
        let missing = fake.open_seekable(Path::new("missing.docx"));
        assert_eq!(
            missing.err().map(|error| error.kind()),
            Some(io::ErrorKind::NotFound)
        );
    }

    #[cfg(unix)]
    #[test]
    fn reports_links_without_following_them() {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir(dir.path().join("target")).unwrap();
        std::os::unix::fs::symlink(dir.path().join("target"), dir.path().join("link")).unwrap();
        let link = StdFileSystem.metadata(&dir.path().join("link")).unwrap();
        assert_eq!(link.kind, FileKind::Link);
        let listed = StdFileSystem.read_dir(dir.path()).unwrap();
        assert!(
            listed
                .iter()
                .any(|entry| entry.name == "link" && entry.metadata.kind == FileKind::Link)
        );
    }

    #[cfg(windows)]
    #[test]
    fn presence_follows_the_recall_and_offline_attributes() {
        use windows_sys::Win32::Storage::FileSystem::{
            FILE_ATTRIBUTE_ARCHIVE, FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_OFFLINE,
            FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS, FILE_ATTRIBUTE_RECALL_ON_OPEN,
            FILE_ATTRIBUTE_REPARSE_POINT, FILE_ATTRIBUTE_SPARSE_FILE,
        };
        // An iCloud file only in the cloud, as a placeholder-aware process sees it.
        let exposed = FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS
            | FILE_ATTRIBUTE_OFFLINE
            | FILE_ATTRIBUTE_SPARSE_FILE
            | FILE_ATTRIBUTE_REPARSE_POINT
            | FILE_ATTRIBUTE_ARCHIVE;
        assert_eq!(exposed, 0x0040_1620);
        for (attributes, expected) in [
            (exposed, Presence::Placeholder),
            // The same file as Folio sees it.
            (0x0040_0020, Presence::Placeholder),
            (
                FILE_ATTRIBUTE_RECALL_ON_OPEN | FILE_ATTRIBUTE_DIRECTORY,
                Presence::Placeholder,
            ),
            (
                FILE_ATTRIBUTE_OFFLINE | FILE_ATTRIBUTE_ARCHIVE,
                Presence::Offline,
            ),
            (
                FILE_ATTRIBUTE_ARCHIVE | FILE_ATTRIBUTE_REPARSE_POINT,
                Presence::Local,
            ),
        ] {
            assert_eq!(
                Presence::of_attributes(attributes),
                expected,
                "{attributes:#x}"
            );
        }
    }

    #[test]
    fn converts_times_on_both_sides_of_the_epoch() {
        let epoch = SystemTime::UNIX_EPOCH;
        assert_eq!(unix_ns(epoch + Duration::from_nanos(1_500)), Some(1_500));
        assert_eq!(
            unix_ns(epoch - Duration::from_secs(1)),
            Some(-1_000_000_000)
        );
        let year_2270 = epoch + Duration::from_secs(300 * 365 * 86_400);
        assert_eq!(unix_ns(year_2270), None);
    }
}
