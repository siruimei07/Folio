//! The IPC contract: every command and event the UI can use (CLAUDE.md §5, "One IPC contract").
//!
//! Rust types are the source of truth. The `export_bindings` test below generates the TypeScript
//! side into `apps/desktop/src/ipc/bindings.ts`; never edit that file by hand. New commands must
//! also be listed in `build.rs` and granted in `capabilities/`.

use tauri_specta::{Builder, collect_commands};

use crate::commands;

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

pub fn builder() -> Builder<tauri::Wry> {
    Builder::<tauri::Wry>::new()
        .commands(collect_commands![commands::app_info])
        .typed_error_impl(TYPED_ERROR_IMPL)
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::Path;

    /// Fails when `bindings.ts` is out of date, and then rewrites it, so `cargo test` catches
    /// bindings that were not regenerated and committed. It compares files instead of using Git,
    /// because GitButler leaves the Git index behind the workspace. An up-to-date file is left
    /// untouched, so a running dev server does not reload.
    #[test]
    fn export_bindings() {
        let path =
            Path::new(env!("CARGO_MANIFEST_DIR")).join("../../apps/desktop/src/ipc/bindings.ts");
        let fresh = std::env::temp_dir().join(format!("folio-bindings-{}.ts", std::process::id()));
        super::builder()
            .export(specta_typescript::Typescript::default(), &fresh)
            .expect("failed to export TypeScript bindings");
        let expected = fs::read_to_string(&fresh).expect("failed to read the exported bindings");
        fs::remove_file(&fresh).expect("failed to remove the exported bindings");
        if fs::read_to_string(&path).ok().as_deref() != Some(expected.as_str()) {
            fs::write(&path, expected).expect("failed to update bindings.ts");
            panic!("bindings.ts was out of date and has been regenerated; review and commit it");
        }
    }

    /// Capabilities list individual permissions only (CLAUDE.md §5). A default set such as
    /// `core:default` would grant the UI commands it does not use.
    #[test]
    fn capabilities_grant_individual_permissions_only() {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("capabilities");
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
                assert!(
                    id != "default" && !id.ends_with(":default"),
                    "{}: grant individual permissions instead of `{id}`",
                    path.display()
                );
            }
        }
    }
}
