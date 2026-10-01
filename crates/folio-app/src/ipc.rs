//! The IPC contract: every command and event the UI can use (CLAUDE.md §5, "One IPC contract";
//! docs/specs/ipc-m1.md).
//!
//! Rust types are the source of truth. The `export_bindings` test below generates the TypeScript
//! side into `apps/desktop/src/ipc/bindings.ts`; never edit that file by hand.
//!
//! Each feature owns its handlers in `commands/<group>.rs`, its runtime/build list in
//! `commands/<group>/manifest.rs` and its grant in `capabilities/<group>.json`. Planned commands
//! live in the group's test-only module for the bindings: Tauri never registers them.
//! `runtime_commands_are_declared_and_granted` keeps the lists in step.
//!
//! The modules are public because, until their commands are implemented, the bindings are what
//! uses most of their types. Once all planned commands are implemented, make them private again
//! (here and in `lib.rs`), so that dead-code warnings come back.

pub mod entries;
pub mod events;
pub mod groups;
pub mod import;
pub mod jobs;
pub mod library;
pub mod log;
pub mod problems;
pub mod search;
pub mod tags;
pub mod types;

use tauri_specta::{Builder, collect_commands, collect_events};

use crate::{commands, window_chrome};

/// Replaces tauri-specta's `typedError`, so that every generated command resolves to one result
/// and never rejects. A command's own error is an `AppError`: an object with a string `code`.
/// Anything else is a failure of the call itself (Tauri rejects a denied or unknown command with
/// a plain string) and becomes a `Transport` error.
const TYPED_ERROR_IMPL: &str = r#"export type TransportError = { code: "Transport"; detail: string };

async function typedError<T, E>(result: Promise<T>): Promise<{ status: "ok"; data: T } | { status: "error"; error: E | TransportError }> {
    try {
        return { status: "ok", data: await result };
    } catch (e: unknown) {
        const code = typeof e === "object" && e !== null ? (e as { code?: unknown }).code : undefined;
        if (typeof code === "string") return { status: "error", error: e as E };
        return { status: "error", error: { code: "Transport", detail: e instanceof Error ? e.message : String(e) } };
    }
}"#;

// tauri-specta's commands() replaces the previous list. Append each group's tokens first,
// then collect once; path fragments would be opaque to collect_commands!'s identifier parser.
macro_rules! implemented_commands {
    ([$($commands:tt)*];) => {
        collect_commands![$($commands)*]
    };
    ([$($commands:tt)*]; $group:ident $(, $remaining:ident)*) => {
        commands::manifest::$group::append_commands!(
            implemented_commands, [$($commands)*]; $($remaining),*
        )
    };
}

/// What the app runs: the implemented commands.
pub fn builder() -> Builder<tauri::Wry> {
    contract(Builder::<tauri::Wry>::new().commands(implemented_commands!(
        []; shell, library, browse, operations, file, import, jobs, log, settings
    )))
}

/// The fixed M1 contract order keeps bindings stable when a group implements its commands.
/// Group re-exports resolve to the handler or its test-only stub; later M1 lanes edit no index.
#[cfg(test)]
fn export_builder() -> Builder<tauri::Wry> {
    contract(Builder::<tauri::Wry>::new().commands(collect_commands![
        commands::shell::app_info,
        commands::shell::set_maximize_button_bounds,
        commands::library::library_status,
        commands::library::pick_library_folder,
        commands::library::create_library,
        commands::library::open_library,
        commands::operations::list_semesters,
        commands::operations::create_semester,
        commands::operations::update_semester,
        commands::operations::reorder_semesters,
        commands::operations::list_courses,
        commands::operations::create_course,
        commands::operations::update_course,
        commands::operations::reorder_courses,
        commands::operations::list_tags,
        commands::operations::create_tag,
        commands::operations::update_tag,
        commands::operations::reorder_tags,
        commands::operations::delete_tag,
        commands::operations::set_entry_tags,
        commands::browse::list_children,
        commands::browse::list_files,
        commands::browse::get_entry,
        commands::operations::create_folder,
        commands::operations::rename_entry,
        commands::operations::move_entries,
        commands::operations::delete_entries,
        commands::browse::search,
        commands::browse::resolve_paths,
        commands::file::open_entry,
        commands::file::reveal_entry,
        commands::import::pick_import_files,
        commands::import::check_import,
        commands::import::import_files,
        commands::jobs::list_jobs,
        commands::jobs::cancel_job,
        commands::jobs::rebuild_catalog,
        commands::jobs::list_problems,
        commands::log::log_ui_error,
        commands::settings::get_app_settings,
        commands::settings::update_app_settings,
        commands::settings::get_ignore_rules,
        commands::settings::set_ignore_rules,
    ]))
}

/// What both builders share: the events, the limits and the typed-error runtime. Events carry no
/// privilege: they flow from the shell to the UI only.
fn contract(builder: Builder<tauri::Wry>) -> Builder<tauri::Wry> {
    builder
        .events(collect_events![
            window_chrome::MaximizeButtonChanged,
            events::LibraryStateChanged,
            events::CatalogChanged,
            events::JobChanged,
            events::ProblemsChanged,
            events::FilesDropped,
            events::DropHover,
            events::AppSettingsChanged,
            events::IgnoreRulesChanged,
        ])
        .constant("LIMITS", types::LIMITS)
        .constant("FILE_ERROR_HEADER", entries::FILE_ERROR_HEADER)
        .constant("FILE_ERROR_CODES", entries::FILE_ERROR_CODES)
        .constant(
            "DEFAULT_IGNORE_RULES",
            folio_core::library::DEFAULT_IGNORE_RULES,
        )
        .typed_error_impl(TYPED_ERROR_IMPL)
}

// App and library settings (spec §22). Kept apart from the module list above while
// feat/core-import rewrites that list; it joins the list once both lanes have landed.
pub(crate) mod settings;

#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;
    use std::fs;
    use std::path::Path;
    use std::sync::atomic::{AtomicU32, Ordering};

    use tauri_specta::Builder;

    /// The TypeScript a builder exports.
    fn typescript(builder: &Builder<tauri::Wry>) -> String {
        static NEXT: AtomicU32 = AtomicU32::new(0);
        let file = std::env::temp_dir().join(format!(
            "folio-bindings-{}-{}.ts",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        builder
            .export(specta_typescript::Typescript::default(), &file)
            .expect("failed to export TypeScript bindings");
        let text = fs::read_to_string(&file).expect("failed to read the exported bindings");
        fs::remove_file(&file).expect("failed to remove the exported bindings");
        text
    }

    /// The commands the exported functions invoke, in order.
    fn invoked(typescript: &str) -> Vec<String> {
        typescript
            .split("__TAURI_INVOKE(\"")
            .skip(1)
            .map(|rest| rest.split('"').next().unwrap_or_default().to_owned())
            .collect()
    }

    /// Fails when `bindings.ts` is out of date, and then rewrites it, so `cargo test` catches
    /// bindings that were not regenerated and committed. It compares files instead of using Git,
    /// because GitButler leaves the Git index behind the workspace. An up-to-date file is left
    /// untouched, so a running dev server does not reload.
    #[test]
    fn export_bindings() {
        let path =
            Path::new(env!("CARGO_MANIFEST_DIR")).join("../../apps/desktop/src/ipc/bindings.ts");
        let expected = typescript(&super::export_builder());
        if fs::read_to_string(&path).ok().as_deref() != Some(expected.as_str()) {
            fs::write(&path, expected).expect("failed to update bindings.ts");
            panic!("bindings.ts was out of date and has been regenerated; review and commit it");
        }
    }

    /// A command gains power in one change: its handler, its manifest entry and its grant land
    /// together, and a planned command has none of them (docs/specs/ipc-m1.md §3).
    #[test]
    fn runtime_commands_are_declared_and_granted() {
        let runtime = invoked(&typescript(&super::builder()));
        let declared = invoked(&typescript(&super::export_builder()));
        let unique: BTreeSet<&String> = declared.iter().collect();
        assert_eq!(unique.len(), declared.len(), "a command is declared twice");
        for command in &runtime {
            assert!(
                unique.contains(command),
                "`{command}` is missing from the bindings"
            );
        }

        let runtime_count = runtime.len();
        let runtime: BTreeSet<String> = runtime.into_iter().collect();
        assert_eq!(
            runtime.len(),
            runtime_count,
            "a runtime command is registered twice"
        );
        assert_eq!(
            manifest_commands(),
            runtime,
            "build.rs lists other commands"
        );
        assert_eq!(
            granted_commands(),
            runtime,
            "capabilities grant other commands"
        );
    }

    /// The same feature-owned command names `build.rs` passes to the app manifest.
    fn manifest_commands() -> BTreeSet<String> {
        let commands = crate::commands::manifest::commands();
        let unique: BTreeSet<&str> = commands.iter().copied().collect();
        assert_eq!(
            unique.len(),
            commands.len(),
            "a manifest command is listed twice"
        );
        unique.into_iter().map(str::to_owned).collect()
    }

    /// The app commands the capabilities allow, from their `allow-<command>` permissions.
    fn granted_commands() -> BTreeSet<String> {
        permissions()
            .iter()
            .filter_map(|(_, id)| id.strip_prefix("allow-"))
            .map(|command| command.replace('-', "_"))
            .collect()
    }

    /// Every permission identifier in `capabilities/`, with the file that grants it.
    fn permissions() -> Vec<(String, String)> {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("capabilities");
        let mut ids = Vec::new();
        for entry in fs::read_dir(dir).expect("failed to list capabilities/") {
            let path = entry.expect("failed to read capabilities/").path();
            let text = fs::read_to_string(&path).expect("failed to read a capability file");
            let capability: serde_json::Value = serde_json::from_str(&text)
                .unwrap_or_else(|error| panic!("{}: {error}", path.display()));
            let permissions = capability["permissions"]
                .as_array()
                .unwrap_or_else(|| panic!("{}: no permissions array", path.display()));
            for permission in permissions {
                // An entry is an identifier, or an object with one when it carries a scope.
                let id = permission
                    .as_str()
                    .or_else(|| permission["identifier"].as_str())
                    .unwrap_or_else(|| panic!("{}: unreadable permission", path.display()));
                ids.push((path.display().to_string(), id.to_owned()));
            }
        }
        ids
    }

    /// Capabilities list individual permissions only (CLAUDE.md §5). A default set such as
    /// `core:default` would grant the UI commands it does not use.
    #[test]
    fn capabilities_grant_individual_permissions_only() {
        for (file, id) in permissions() {
            assert!(
                id != "default" && !id.ends_with(":default"),
                "{file}: grant individual permissions instead of `{id}`"
            );
        }
    }

    #[test]
    fn main_window_does_not_publish_native_drag_paths() {
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let main = config["app"]["windows"]
            .as_array()
            .unwrap()
            .iter()
            .find(|window| window["label"] == "main")
            .unwrap();
        assert_eq!(main["dragDropEnabled"], false);
    }
}
