//! Shared group wiring for the runtime and build.rs. Each group owns its command list.

#[path = "browse/manifest.rs"]
pub(crate) mod browse;
#[path = "file/manifest.rs"]
pub(crate) mod file;
#[path = "import/manifest.rs"]
pub(crate) mod import;
#[path = "jobs/manifest.rs"]
pub(crate) mod jobs;
#[path = "library/manifest.rs"]
pub(crate) mod library;
#[path = "operations/manifest.rs"]
pub(crate) mod operations;
#[path = "shell/manifest.rs"]
pub(crate) mod shell;

/// The app command names tauri-build turns into individual allow/deny permissions.
pub fn commands() -> Vec<&'static str> {
    [
        shell::COMMANDS,
        library::COMMANDS,
        browse::COMMANDS,
        operations::COMMANDS,
        file::COMMANDS,
        import::COMMANDS,
        jobs::COMMANDS,
    ]
    .concat()
}
