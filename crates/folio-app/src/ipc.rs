//! The IPC contract: every command and event the UI can use (CLAUDE.md §5, "One IPC contract";
//! docs/specs/ipc-m1.md).
//!
//! Rust types are the source of truth. The `export_bindings` test below generates the TypeScript
//! side into `apps/desktop/src/ipc/bindings.ts`; never edit that file by hand.
//!
//! Commands come in two sets (spec §3). Implemented commands are listed in
//! `implemented_commands!`, and each is also listed in `build.rs` and granted in `capabilities/`:
//! the app runs these. Planned commands are declared in `planned`, for the bindings only: Tauri
//! never registers them. `runtime_commands_are_declared_and_granted` keeps the lists in step.
//!
//! The modules are public because, until their commands are implemented, the bindings are what
//! uses most of their types. Once `planned` is empty, make them private again (here and in
//! `lib.rs`), so that dead-code warnings come back.

pub mod entries;
pub mod events;
pub mod groups;
pub mod import;
pub mod jobs;
pub mod library;
#[cfg(test)]
mod planned;
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

/// The implemented commands, followed by the ones given.
macro_rules! implemented_commands {
    ($($more:tt)*) => {
        collect_commands![
            commands::app_info,
            commands::set_maximize_button_bounds,
            $($more)*
        ]
    };
}

/// What the app runs: the implemented commands.
pub fn builder() -> Builder<tauri::Wry> {
    contract(Builder::<tauri::Wry>::new().commands(implemented_commands![]))
}

/// What the bindings describe: the implemented and the planned commands.
#[cfg(test)]
fn export_builder() -> Builder<tauri::Wry> {
    contract(Builder::<tauri::Wry>::new().commands(implemented_commands![
        planned::library_status,
        planned::pick_library_folder,
        planned::create_library,
        planned::open_library,
        planned::list_semesters,
        planned::create_semester,
        planned::update_semester,
        planned::reorder_semesters,
        planned::list_courses,
        planned::create_course,
        planned::update_course,
        planned::reorder_courses,
        planned::list_tags,
        planned::create_tag,
        planned::update_tag,
        planned::reorder_tags,
        planned::delete_tag,
        planned::set_entry_tags,
        planned::list_children,
        planned::list_files,
        planned::get_entry,
        planned::create_folder,
        planned::rename_entry,
        planned::move_entries,
        planned::delete_entries,
        planned::search,
        planned::open_entry,
        planned::reveal_entry,
        planned::pick_import_files,
        planned::check_import,
        planned::import_files,
        planned::list_jobs,
        planned::cancel_job,
        planned::rebuild_catalog,
        planned::list_problems,
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
        ])
        .constant("LIMITS", types::LIMITS)
        .typed_error_impl(TYPED_ERROR_IMPL)
}

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

        let runtime: BTreeSet<String> = runtime.into_iter().collect();
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

    /// The commands `build.rs` lists in the app manifest: the string literals of its list.
    fn manifest_commands() -> BTreeSet<String> {
        let build = include_str!("../build.rs");
        let (_, list) = build
            .split_once(".commands(&[")
            .expect("build.rs lists the app commands");
        let (list, _) = list.split_once("])").expect("the command list ends");
        list.split('"')
            .skip(1)
            .step_by(2)
            .map(str::to_owned)
            .collect()
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
