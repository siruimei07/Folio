//! The Windows adapters (docs/specs/windows-adapter.md). Only the modules that call Win32 allow
//! unsafe code; the buffers Windows fills are parsed by safe code.

mod dir_info;
mod files;
mod handle;
mod recycle;

pub use files::WindowsFileSystem;
pub use handle::Volume;
pub use recycle::WindowsRecycleBin;

/// The folder `FOLIO_TEST_NON_NTFS_DIR` names, on a volume that is not NTFS (on Sirui's machine
/// one on `I:`, exFAT), for the ignored tests that need one.
#[cfg(test)]
fn non_ntfs_dir() -> std::path::PathBuf {
    std::env::var_os("FOLIO_TEST_NON_NTFS_DIR")
        .expect("FOLIO_TEST_NON_NTFS_DIR")
        .into()
}
