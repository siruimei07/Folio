use std::path::Path;

fn main() {
    // Every app command must be listed here and granted in `capabilities/`: a window can only
    // call the commands its capability grants (ADR-0001, security baseline).
    let attributes = tauri_build::Attributes::new()
        .app_manifest(
            tauri_build::AppManifest::new().commands(&["app_info", "set_maximize_button_bounds"]),
        )
        .windows_attributes(tauri_build::WindowsAttributes::new_without_app_manifest());
    tauri_build::try_build(attributes).expect("failed to run tauri-build");

    // tauri-build would embed its Windows manifest into the app binary only. Test binaries link
    // Tauri too, and without the Common Controls v6 manifest they fail to start with
    // STATUS_ENTRYPOINT_NOT_FOUND. So the linker embeds one manifest into every binary, as
    // Tauri's own crate does.
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        let manifest = Path::new(env!("CARGO_MANIFEST_DIR")).join("windows-app.manifest");
        println!("cargo:rerun-if-changed={}", manifest.display());
        println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
        println!("cargo:rustc-link-arg=/MANIFESTINPUT:{}", manifest.display());
    }
}
