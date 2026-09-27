//! Folio desktop shell: a thin Tauri layer over `folio-core` (ADR-0001). It validates input,
//! calls the core, maps errors to the IPC error union and integrates with Windows.

mod commands;
mod diagnostics;
mod error;
mod ipc;
mod paths;
mod preview;
mod window_chrome;

use tauri::Manager;

/// Starts the app. Panics only if Tauri itself cannot start.
pub fn run() {
    let builder = ipc::builder();
    tauri::Builder::default()
        .invoke_handler(builder.invoke_handler())
        .register_uri_scheme_protocol(preview::SCHEME, |ctx, request| {
            preview::respond(ctx.app_handle(), &request)
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                // The shell owns closing; a page event listener must not veto it.
                // Revisit before introducing background writes or unsaved documents.
                if let Err(error) = window.destroy() {
                    diagnostics::report(
                        window.app_handle(),
                        &format!("failed to close window: {error}"),
                    );
                }
            }
        })
        .setup(move |app| {
            builder.mount_events(app);
            let data_dir = paths::resolve_data_dir(std::env::var_os(paths::DATA_DIR_ENV), || {
                app.path()
                    .app_local_data_dir()
                    .map_err(|error| error.to_string())
            });
            app.manage(paths::DataDir::new(data_dir));

            let main = app
                .get_webview_window("main")
                .ok_or("tauri.conf.json declares no main window")?;
            if let Err(error) = window_chrome::install(&main) {
                // The title bar still works without it; only the snap layouts flyout is lost.
                diagnostics::report(app.handle(), &format!("snap layouts unavailable: {error}"));
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Folio");
}
