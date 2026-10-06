//! The Recycle Bin adapter: how the core deletes the user's files without losing them
//! (docs/specs/windows-adapter.md §4).
//!
//! Folio never deletes a user's file for good: deleting moves it to the Recycle Bin, and what the
//! Recycle Bin cannot take stays where it is, with an error that says why. The UI may then offer a
//! permanent deletion as its own, confirmed action. A file whose content is only in the cloud is
//! the exception the shell makes: it leaves that file to its cloud provider's trash (§4).

use std::io;
use std::path::{Component, Path, PathBuf};

use crate::fs::{FileKind, FileSystem, Presence};

/// Moves files and folders to the Recycle Bin.
pub trait RecycleBin: Send + Sync {
    /// Moves the file or folder at `path`, with everything below it, to the Recycle Bin, and
    /// says where it went. `path` is absolute, below a drive or share, without `..`. Never
    /// deletes anything for good, and never reads or downloads a file to recycle it.
    fn recycle(&self, path: &Path) -> Result<Recycled, RecycleError>;
}

/// Where a recycled item went. Either way it left its path.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Recycled {
    /// The Recycle Bin, with everything below it.
    RecycleBin,
    /// A file whose content was only in the cloud: the Recycle Bin could take it only by
    /// downloading it, so the shell leaves its deletion to the cloud provider, which keeps it in
    /// its own trash (iCloud Drive: Recently Deleted, for 30 days).
    CloudTrash,
}

/// Something that did not go to the Recycle Bin. It stayed where it was, unless the shell failed
/// and the item left its path anyway (`Other`), as a file that became cloud-only while it was
/// recycled does: the shell then left it to its provider's trash after all
/// (docs/specs/windows-adapter.md §4.2).
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{} did not go to the Recycle Bin: {detail}", path.display())]
pub struct RecycleError {
    pub path: PathBuf,
    pub failure: RecycleFailure,
    /// For logs; the UI words each case from `failure`.
    pub detail: String,
}

/// Why something did not go to the Recycle Bin.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RecycleFailure {
    NotFound,
    /// The drive has no Recycle Bin (network shares, removable drives), the path is too long for
    /// it, or the item is larger than it takes.
    Unrecyclable,
    /// Another program holds it, or something below it, open.
    InUse,
    /// A folder that is, or holds, something whose content is only in the cloud: the shell would
    /// put the folder in the Recycle Bin without it, and leave it to the cloud provider's trash.
    CloudOnly,
    /// The cloud provider refused to move it, and it stayed where it was. iCloud for Windows
    /// refuses every folder and downloaded file for about 20 minutes after it starts, and then
    /// takes them (docs/specs/windows-adapter.md §4.2), so trying again later may work. The
    /// refusal does not say why: another provider, or another cause, may refuse every time. Never
    /// `Unrecyclable`: the Recycle Bin may take it once the provider lets go.
    CloudBusy,
    Denied,
    /// A path no caller should pass (relative, a whole drive, `..`), or one that the shell
    /// resolves to another file than the one on disk: a bug or a trap, never the user's doing.
    Invalid,
    Other,
}

impl RecycleError {
    pub(crate) fn new(path: &Path, failure: RecycleFailure, detail: impl Into<String>) -> Self {
        Self {
            path: path.to_owned(),
            failure,
            detail: detail.into(),
        }
    }

    /// The error for `error`, which reading what is at `path` returned.
    pub(crate) fn of_io(path: &Path, error: &io::Error) -> Self {
        let failure = if error.kind() == io::ErrorKind::NotFound {
            RecycleFailure::NotFound
        } else if crate::files::is_in_use(error) {
            RecycleFailure::InUse
        } else if error.kind() == io::ErrorKind::PermissionDenied {
            RecycleFailure::Denied
        } else {
            RecycleFailure::Other
        };
        Self::new(path, failure, error.to_string())
    }
}

/// Where the item at `path` goes, decided from listings alone: nothing is read or downloaded, no
/// link is followed, and a folder that is a placeholder is not listed (listing it would fetch it).
/// A file whose content is only in the cloud goes to its provider's trash; a folder that is, or
/// holds, anything like that stays (`CloudOnly`), and so does one that cannot be listed; the rest
/// goes to the Recycle Bin. Folders below are listed by their names joined to `path`, so on
/// Windows `path` is verbatim: Win32 reads some names otherwise in a plain path (windows-adapter
/// §4.1).
pub(crate) fn destination(fs: &dyn FileSystem, path: &Path) -> Result<Recycled, RecycleError> {
    let metadata = fs
        .metadata(path)
        .map_err(|error| RecycleError::of_io(path, &error))?;
    let cloud_only = metadata.presence == Presence::Placeholder;
    match metadata.kind {
        FileKind::File if cloud_only => return Ok(Recycled::CloudTrash),
        FileKind::Folder if cloud_only => return Err(cloud_only_in(path, path)),
        FileKind::Folder => {}
        _ => return Ok(Recycled::RecycleBin),
    }
    let mut folders = vec![path.to_owned()];
    while let Some(folder) = folders.pop() {
        let entries = fs.read_dir(&folder).map_err(|error| {
            let error = RecycleError::of_io(path, &error);
            // A folder below the item that its parent just listed is not found when something
            // changed under the item in the meantime: the item is gone only if it is gone too.
            let failure = match error.failure {
                RecycleFailure::NotFound if folder != path && is_there(fs, path) => {
                    RecycleFailure::Other
                }
                failure => failure,
            };
            RecycleError {
                failure,
                detail: format!("{}: {}", folder.display(), error.detail),
                ..error
            }
        })?;
        for entry in entries {
            if entry.metadata.presence == Presence::Placeholder {
                return Err(cloud_only_in(path, &folder.join(&entry.name)));
            }
            if entry.metadata.kind == FileKind::Folder {
                folders.push(folder.join(&entry.name));
            }
        }
    }
    Ok(Recycled::RecycleBin)
}

/// Whether anything is at `path`, as far as a look can tell.
pub(crate) fn is_there(fs: &dyn FileSystem, path: &Path) -> bool {
    !matches!(fs.metadata(path), Err(error) if error.kind() == io::ErrorKind::NotFound)
}

fn cloud_only_in(folder: &Path, below: &Path) -> RecycleError {
    RecycleError::new(
        folder,
        RecycleFailure::CloudOnly,
        format!("{} is only in the cloud", below.display()),
    )
}

/// Refuses what no Recycle Bin may be asked to take: a relative path, a whole drive or share, a
/// path through `..`, or one with a NUL, which Windows would cut short.
pub(crate) fn check(path: &Path) -> Result<(), RecycleError> {
    let valid = path.is_absolute()
        && path.parent().is_some()
        && !path
            .components()
            .any(|component| matches!(component, Component::ParentDir))
        && !path.as_os_str().as_encoded_bytes().contains(&0);
    if valid {
        Ok(())
    } else {
        Err(RecycleError::new(
            path,
            RecycleFailure::Invalid,
            "not an absolute path to a file or folder",
        ))
    }
}

#[cfg(test)]
mod tests {
    use std::io::Read;
    use std::sync::Arc;

    use super::*;
    use crate::fs::{DirEntry, Metadata};
    use crate::test_support::MemFs;

    fn fake() -> (tempfile::TempDir, Arc<MemFs>) {
        let dir = tempfile::tempdir().unwrap();
        let fs = MemFs::new(dir.path());
        (dir, fs)
    }

    fn failure(result: Result<Recycled, RecycleError>) -> RecycleFailure {
        result.unwrap_err().failure
    }

    #[test]
    fn the_fake_recycles_files_and_folders_with_what_is_below_them() {
        let (dir, fs) = fake();
        fs.file("2026 秋/线代/笔记.md", b"x");
        fs.file("2026 秋/线代/作业/hw1.pdf", b"y");
        fs.file("2026 秋/概率/笔记.md", b"z");
        // Offline storage is not the cloud: moving it needs no content.
        fs.set_presence("2026 秋/线代/作业/hw1.pdf", Presence::Offline);

        for path in ["2026 秋/概率/笔记.md", "2026 秋/线代"] {
            let recycled = fs.recycle(&dir.path().join(path));
            assert_eq!(recycled, Ok(Recycled::RecycleBin), "{path}");
        }
        assert_eq!(fs.kind_of("2026 秋/线代/作业/hw1.pdf"), None);
        assert_eq!(fs.kind_of("2026 秋/概率"), Some(FileKind::Folder));
        assert_eq!(fs.recycled(), ["2026 秋/概率/笔记.md", "2026 秋/线代"]);
        assert!(fs.cloud_trashed().is_empty());
    }

    #[test]
    fn a_file_only_in_the_cloud_goes_to_the_cloud_trash() {
        let (dir, fs) = fake();
        fs.file("线代/lecture.mp4", b"x");
        fs.set_presence("线代/lecture.mp4", Presence::Placeholder);

        let recycled = fs.recycle(&dir.path().join("线代/lecture.mp4"));
        assert_eq!(recycled, Ok(Recycled::CloudTrash));
        assert_eq!(fs.kind_of("线代/lecture.mp4"), None);
        assert_eq!(fs.cloud_trashed(), ["线代/lecture.mp4"]);
        assert!(fs.recycled().is_empty());
    }

    #[test]
    fn a_folder_holding_anything_only_in_the_cloud_stays() {
        let (dir, fs) = fake();
        fs.file("线代/笔记.md", b"x");
        fs.file("线代/作业/第一周/hw1.pdf", b"y");
        fs.set_presence("线代/作业/第一周/hw1.pdf", Presence::Placeholder);
        fs.folder("概率/未下载");
        fs.set_presence("概率/未下载", Presence::Placeholder);

        let error = fs.recycle(&dir.path().join("线代")).unwrap_err();
        assert_eq!(
            (&error.path, error.failure),
            (&dir.path().join("线代"), RecycleFailure::CloudOnly)
        );
        assert!(error.detail.contains("hw1.pdf"), "{error}");
        // A folder that is a placeholder itself, and any folder above it.
        for path in ["概率/未下载", "概率"] {
            let failure = failure(fs.recycle(&dir.path().join(path)));
            assert_eq!(failure, RecycleFailure::CloudOnly, "{path}");
        }
        assert_eq!(fs.kind_of("线代/笔记.md"), Some(FileKind::File));
        assert_eq!(fs.kind_of("概率/未下载"), Some(FileKind::Folder));
        assert!(fs.recycled().is_empty() && fs.cloud_trashed().is_empty());
    }

    #[test]
    fn a_folder_that_cannot_be_listed_stays() {
        let (dir, fs) = fake();
        fs.file("线代/作业/hw1.pdf", b"y");
        fs.fail_listing("线代/作业");

        let error = fs.recycle(&dir.path().join("线代")).unwrap_err();
        assert_eq!(
            (&error.path, error.failure),
            (&dir.path().join("线代"), RecycleFailure::Denied)
        );
        assert!(error.detail.contains("作业"), "{error}");
        assert_eq!(fs.kind_of("线代/作业/hw1.pdf"), Some(FileKind::File));
    }

    /// The fake, with `removed` taken away right before `folder` is listed, as a sync client may
    /// do while a folder is being looked at.
    struct Racing {
        fs: Arc<MemFs>,
        folder: PathBuf,
        removed: &'static str,
    }

    impl FileSystem for Racing {
        fn read_dir(&self, folder: &Path) -> io::Result<Vec<DirEntry>> {
            if folder == self.folder {
                self.fs.remove(self.removed);
            }
            self.fs.read_dir(folder)
        }

        fn metadata(&self, path: &Path) -> io::Result<Metadata> {
            self.fs.metadata(path)
        }

        fn open(&self, path: &Path) -> io::Result<Box<dyn Read + '_>> {
            self.fs.open(path)
        }
    }

    #[test]
    fn only_the_item_itself_is_reported_gone() {
        let (dir, fs) = fake();
        let folder = dir.path().join("线代");
        // A folder below that its parent listed but that is not found: the item is still there,
        // unless it went too.
        for (listed, removed, failure) in [
            ("线代", "线代", RecycleFailure::NotFound),
            ("线代/作业", "线代/作业", RecycleFailure::Other),
            ("线代/作业", "线代", RecycleFailure::NotFound),
        ] {
            fs.file("线代/作业/hw1.pdf", b"y");
            let racing = Racing {
                fs: Arc::clone(&fs),
                folder: dir.path().join(listed),
                removed,
            };
            let error = destination(&racing, &folder).unwrap_err();
            let case = format!("{listed} listed, {removed} removed");
            assert_eq!((&error.path, error.failure), (&folder, failure), "{case}");
            let name = Path::new(listed).file_name().unwrap().to_str().unwrap();
            assert!(error.detail.contains(name), "{error}");
        }
    }

    #[test]
    fn links_are_recycled_as_themselves_and_never_followed() {
        let (dir, fs) = fake();
        fs.file("线代/笔记.md", b"x");
        fs.special("线代/作业", FileKind::Link);
        fs.special("概率", FileKind::Link);

        for path in ["概率", "线代"] {
            let recycled = fs.recycle(&dir.path().join(path));
            assert_eq!(recycled, Ok(Recycled::RecycleBin), "{path}");
        }
        assert_eq!(fs.recycled(), ["概率", "线代"]);
    }

    #[test]
    fn what_cannot_be_recycled_stays_with_the_reason() {
        let (dir, fs) = fake();
        fs.file("big.mp4", b"x");
        fs.file("线代/作业/open.docx", b"y");
        fs.fail_recycling("big.mp4", RecycleFailure::Unrecyclable);
        fs.fail_recycling("线代/作业/open.docx", RecycleFailure::InUse);

        let big = dir.path().join("big.mp4");
        let error = fs.recycle(&big).unwrap_err();
        assert_eq!(
            (error.path, error.failure),
            (big, RecycleFailure::Unrecyclable)
        );
        // A file in use keeps its folder too, as on Windows.
        for path in ["线代/作业/open.docx", "线代"] {
            let failure = failure(fs.recycle(&dir.path().join(path)));
            assert_eq!(failure, RecycleFailure::InUse, "{path}");
        }
        assert_eq!(fs.kind_of("big.mp4"), Some(FileKind::File));
        assert_eq!(fs.kind_of("线代/作业/open.docx"), Some(FileKind::File));
        assert!(fs.recycled().is_empty());
    }

    #[test]
    fn missing_and_invalid_paths_are_refused() {
        let (dir, fs) = fake();
        fs.file("线代/笔记.md", b"x");
        let missing = failure(fs.recycle(&dir.path().join("missing.md")));
        assert_eq!(missing, RecycleFailure::NotFound);
        let drive = dir.path().ancestors().last().unwrap();
        for path in [
            PathBuf::from("线代/笔记.md"),
            drive.to_owned(),
            dir.path().join("线代/../线代/笔记.md"),
        ] {
            assert_eq!(
                failure(fs.recycle(&path)),
                RecycleFailure::Invalid,
                "{path:?}"
            );
        }
        assert_eq!(fs.kind_of("线代/笔记.md"), Some(FileKind::File));
    }
}
