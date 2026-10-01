//! Folio desktop shell: a thin Tauri layer over `folio-core` (ADR-0001). It validates input,
//! calls the core, maps errors to the IPC error union and integrates with Windows.

mod commands;
mod diagnostics;
mod dialogs;
mod file_scheme;
// Public: the IPC contract is this crate's interface to the UI (docs/specs/ipc-m1.md).
pub mod error;
pub mod ipc;
mod jobs;
mod library;
mod open;
mod paths;
mod preview;
mod thumbnail;
mod window_background;
mod window_chrome;

use std::sync::Arc;
use tauri::Manager;
use tauri_specta::Event;

/// Starts the app. Panics only if Tauri itself cannot start.
pub fn run() {
    let builder = ipc::builder();
    let app = tauri::Builder::default()
        .invoke_handler(builder.invoke_handler())
        .register_uri_scheme_protocol(preview::SCHEME, |ctx, request| {
            preview::respond(ctx.app_handle(), &request)
        })
        .register_asynchronous_uri_scheme_protocol(
            file_scheme::SCHEME,
            |ctx, request, responder| {
                let app = ctx.app_handle().clone();
                if ctx.webview_label() != "main" {
                    responder.respond(file_scheme::failure(
                        &error::AppError::AccessDenied(
                            "the scheme is for the main window".to_owned(),
                        ),
                        tauri::http::StatusCode::FORBIDDEN,
                    ));
                    return;
                }
                tauri::async_runtime::spawn_blocking(move || {
                    let (response, error) = file_scheme::respond(
                        &app.state::<library::LibraryState>(),
                        &app.state::<thumbnail::Cache>(),
                        &request,
                    );
                    if let Some(error) = error {
                        diagnostics::report(&app, &format!("file request failed: {error}"));
                    }
                    responder.respond(response);
                });
            },
        )
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let (app, window) = (window.app_handle().clone(), window.clone());
                drain_then(&app, move || {
                    // The page cannot veto the shell's destroy.
                    if let Err(error) = window.destroy() {
                        diagnostics::report(
                            window.app_handle(),
                            &format!("failed to close window: {error}"),
                        );
                    }
                });
            }
        })
        .setup(move |app| {
            builder.mount_events(app);
            let data_dir = paths::resolve_data_dir(std::env::var_os(paths::DATA_DIR_ENV), || {
                app.path()
                    .app_local_data_dir()
                    .map_err(|error| error.to_string())
            });
            app.manage(paths::DataDir::new(data_dir.clone()));
            app.manage(Arc::new(diagnostics::Logger::new(data_dir.clone())));
            // Tests redirect caches with the same existing data override, so no e2e run
            // reads or evicts Sirui's real thumbnail cache.
            let cache = if std::env::var_os(paths::DATA_DIR_ENV).is_some() {
                data_dir.clone().map(|path| path.join("cache"))
            } else {
                app.path()
                    .app_cache_dir()
                    .map_err(|error| error::AppError::FileSystem(error.to_string()))
            };
            app.manage(thumbnail::Cache::new(
                cache.map(|path| path.join("thumbnails")),
            ));
            let handle = app.handle().clone();
            let library = library::LibraryState::new(
                data_dir,
                Arc::new(move |event| {
                    use ipc::events::{JobChanged, LibraryStateChanged, ProblemsChanged};
                    let result = match event {
                        library::Event::Library(status) => {
                            LibraryStateChanged { status }.emit(&handle)
                        }
                        library::Event::Catalog(event) => event.emit(&handle),
                        library::Event::Job(job) => JobChanged { job }.emit(&handle),
                        library::Event::Problems(total) => ProblemsChanged { total }.emit(&handle),
                        library::Event::Error(error) => {
                            diagnostics::report(&handle, &error);
                            return;
                        }
                    };
                    if let Err(error) = result {
                        diagnostics::report(&handle, &format!("library event failed: {error}"));
                    }
                }),
            );
            app.manage(library.clone());
            tauri::async_runtime::spawn_blocking(move || library.initialize());

            // Built here rather than from the configuration at start-up, so its first frame has
            // the app background of Windows' app mode instead of WebView2's white.
            let config = app
                .config()
                .app
                .windows
                .iter()
                .find(|window| window.label == "main")
                .ok_or("tauri.conf.json declares no main window")?
                .clone();
            let dark = window_background::apps_use_dark_mode();
            let main = tauri::WebviewWindowBuilder::from_config(app.handle(), &config)?
                .background_color(window_background::first_frame(dark))
                .build()?;
            if let Err(error) = window_chrome::install(&main) {
                // The title bar still works without it; only the snap layouts flyout is lost.
                diagnostics::report(app.handle(), &format!("snap layouts unavailable: {error}"));
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while running Folio");
    app.run(|app, event| {
        if let tauri::RunEvent::ExitRequested { api, .. } = event
            && !app.state::<library::LibraryState>().is_closed()
        {
            api.prevent_exit();
            let exiting = app.clone();
            drain_then(app, move || exiting.exit(0));
        }
    });
}

/// Closing the window and exiting share one drain: the first request stops new work, cancels
/// jobs and joins the library worker off the UI thread, then runs `then`. Later requests wait.
fn drain_then(app: &tauri::AppHandle, then: impl FnOnce() + Send + 'static) {
    let state = app.state::<library::LibraryState>().inner().clone();
    if !state.begin_close() {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        if let Err(error) = state.shutdown() {
            diagnostics::report(&app, &format!("library shutdown failed: {error}"));
        }
        then();
    });
}

#[cfg(test)]
mod tests {
    /// The workspace pins `windows` and `windows-core` to the versions Tauri locks (Cargo.toml),
    /// so each compiles once. A Tauri upgrade that moves them must move the pins too.
    #[test]
    fn windows_crates_follow_tauri() {
        let lock = include_str!("../../../Cargo.lock");
        for name in ["windows", "windows-core"] {
            let entry = format!("name = \"{name}\"");
            let versions = lock.lines().filter(|line| *line == entry).count();
            assert_eq!(
                versions, 1,
                "Cargo.lock holds {versions} versions of `{name}`; pin Tauri's in Cargo.toml"
            );
        }
    }
}
