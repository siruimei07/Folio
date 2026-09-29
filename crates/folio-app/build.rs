use std::path::Path;

// The app consumes these macros; the build script needs only their command names.
#[allow(unused_imports, unused_macros)]
#[path = "src/commands/manifest.rs"]
mod manifest;

fn main() {
    // AppManifest requires a static slice; these names live until the build process exits.
    let commands = Box::leak(manifest::commands().into_boxed_slice());
    let attributes = tauri_build::Attributes::new()
        .app_manifest(tauri_build::AppManifest::new().commands(commands))
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
