//! The Windows adapters (docs/specs/windows-adapter.md). Only the modules that call Win32 allow
//! unsafe code; the buffers Windows fills are parsed by safe code.

mod dir_info;
mod files;
mod handle;

pub use files::WindowsFileSystem;
pub use handle::Volume;
