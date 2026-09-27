//! Folio desktop shell: a thin Tauri layer over `folio-core` (ADR-0001). It validates input,
//! calls the core, maps errors to the IPC error union and integrates with Windows.

mod commands;
mod error;
mod ipc;
mod paths;

use tauri::Manager;

/// Starts the app. Panics only if Tauri itself cannot start.
pub fn run() {
    let builder = ipc::builder();
    tauri::Builder::default()
        .invoke_handler(builder.invoke_handler())
        .setup(move |app| {
            builder.mount_events(app);
            let data_dir = paths::resolve_data_dir(std::env::var_os(paths::DATA_DIR_ENV), || {
                app.path()
                    .app_local_data_dir()
                    .map_err(|error| error.to_string())
            });
            app.manage(paths::DataDir::new(data_dir));
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Folio");
}
