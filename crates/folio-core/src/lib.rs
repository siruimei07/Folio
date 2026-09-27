//! Folio core: library model, catalog, history and sync.
//!
//! This crate must stay free of Tauri, UI and IPC types so the shell can change and a future
//! Swift app can reuse it (ADR-0001). It reaches the OS only through adapter traits.

pub mod search;

/// Version of the core crate, reported to the UI for diagnostics.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");
