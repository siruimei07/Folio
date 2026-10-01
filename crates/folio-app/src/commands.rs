//! Feature-owned command handlers. New implementations replace their group's test-only stubs,
//! then update that group's manifest.rs and capabilities/<group>.json in the same change.

pub(crate) mod browse;
pub(crate) mod file;
pub(crate) mod import;
pub(crate) mod jobs;
pub(crate) mod library;
pub(crate) mod log;
// Names are consumed by build.rs and tests; runtime registration consumes the macros only.
#[cfg_attr(not(test), allow(dead_code))]
pub(crate) mod manifest;
pub(crate) mod operations;
pub(crate) mod settings;
pub(crate) mod shell;

use crate::error::AppError;
use crate::library::LibraryState;

/// Runs a library call on a blocking thread: library calls wait for startup, locks and disks,
/// never on the async runtime. `what` names the call if its thread fails.
async fn blocking<T: Send + 'static>(
    state: tauri::State<'_, LibraryState>,
    what: &str,
    call: impl FnOnce(LibraryState) -> Result<T, AppError> + Send + 'static,
) -> Result<T, AppError> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || call(state))
        .await
        .map_err(|error| AppError::Internal(format!("{what} worker failed: {error}")))?
}

/// What a stub would answer. No call reaches one: Tauri's ACL rejects commands it was not given.
#[cfg(test)]
fn planned<T>(command: &str, _request: impl Sized) -> Result<T, AppError> {
    Err(AppError::Internal(format!(
        "`{command}` is declared for the bindings only"
    )))
}
