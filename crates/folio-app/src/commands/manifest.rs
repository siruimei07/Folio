//! Shared group wiring for the runtime and build.rs. Each group owns its command list.

#[path = "ai/manifest.rs"]
pub(crate) mod ai;
#[path = "browse/manifest.rs"]
pub(crate) mod browse;
#[path = "file/manifest.rs"]
pub(crate) mod file;
#[path = "history/manifest.rs"]
pub(crate) mod history;
#[path = "import/manifest.rs"]
pub(crate) mod import;
#[path = "jobs/manifest.rs"]
pub(crate) mod jobs;
#[path = "library/manifest.rs"]
pub(crate) mod library;
#[path = "log/manifest.rs"]
pub(crate) mod log;
#[path = "operations/manifest.rs"]
pub(crate) mod operations;
#[path = "settings/manifest.rs"]
pub(crate) mod settings;
#[path = "shell/manifest.rs"]
pub(crate) mod shell;
#[path = "workspace/manifest.rs"]
pub(crate) mod workspace;

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
        log::COMMANDS,
        settings::COMMANDS,
        workspace::COMMANDS,
        history::COMMANDS,
        ai::COMMANDS,
    ]
    .concat()
}
