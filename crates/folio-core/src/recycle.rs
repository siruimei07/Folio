//! The Recycle Bin adapter: how the core deletes the user's files without losing them
//! (docs/specs/windows-adapter.md §4).
//!
//! Folio never deletes a user's file for good: deleting moves it to the Recycle Bin, and what the
//! Recycle Bin cannot take stays where it is, with an error that says why. The UI may then offer a
//! permanent deletion as its own, confirmed action.

use std::path::{Component, Path, PathBuf};

/// Moves files and folders to the Recycle Bin.
pub trait RecycleBin: Send + Sync {
    /// Moves the file or folder at `path`, with everything below it, to the Recycle Bin. `path`
    /// is absolute, below a drive or share, without `..`. Never deletes anything for good.
    fn recycle(&self, path: &Path) -> Result<(), RecycleError>;
}

/// Something that did not go to the Recycle Bin; it stayed where it was.
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
    use std::sync::Arc;

    use super::*;
    use crate::fs::FileKind;
    use crate::test_support::MemFs;

    fn fake() -> (tempfile::TempDir, Arc<MemFs>) {
        let dir = tempfile::tempdir().unwrap();
        let fs = MemFs::new(dir.path());
        (dir, fs)
    }

    fn failure(result: Result<(), RecycleError>) -> RecycleFailure {
        result.unwrap_err().failure
    }

    #[test]
    fn the_fake_recycles_files_and_folders_with_what_is_below_them() {
        let (dir, fs) = fake();
        fs.file("2026 秋/线代/笔记.md", b"x");
        fs.file("2026 秋/线代/作业/hw1.pdf", b"y");
        fs.file("2026 秋/概率/笔记.md", b"z");

        fs.recycle(&dir.path().join("2026 秋/概率/笔记.md"))
            .unwrap();
        fs.recycle(&dir.path().join("2026 秋/线代")).unwrap();
        assert_eq!(fs.kind_of("2026 秋/线代/作业/hw1.pdf"), None);
        assert_eq!(fs.kind_of("2026 秋/概率"), Some(FileKind::Folder));
        assert_eq!(fs.recycled(), ["2026 秋/概率/笔记.md", "2026 秋/线代"]);
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
