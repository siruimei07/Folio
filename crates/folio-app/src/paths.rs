use std::ffi::OsString;
use std::path::{Path, PathBuf};

use crate::error::AppError;

/// Redirects all local app data to another folder. Used by tests, e2e runs and per-lane
/// isolation (docs/specs/testing-strategy.md). Must be an absolute path.
pub const DATA_DIR_ENV: &str = "FOLIO_DATA_DIR";

/// The data directory, resolved once at startup and kept in Tauri state. A failure is kept as
/// well, so that commands report it to the UI.
pub struct DataDir(Result<PathBuf, AppError>);

impl DataDir {
    pub fn new(resolved: Result<PathBuf, AppError>) -> Self {
        Self(resolved)
    }

    pub fn path(&self) -> Result<&Path, AppError> {
        self.0.as_deref().map_err(Clone::clone)
    }
}

/// Chooses the data directory: the [`DATA_DIR_ENV`] override if it is set, otherwise `default`.
pub fn resolve_data_dir(
    override_dir: Option<OsString>,
    default: impl FnOnce() -> Result<PathBuf, String>,
) -> Result<PathBuf, AppError> {
    match override_dir {
        Some(value) => {
            let path = PathBuf::from(value);
            if path.is_absolute() {
                Ok(path)
            } else {
                Err(AppError::DataDirUnavailable(format!(
                    "{DATA_DIR_ENV} must be an absolute path, got `{}`",
                    path.display()
                )))
            }
        }
        None => default().map_err(AppError::DataDirUnavailable),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn default_must_not_run() -> Result<PathBuf, String> {
        panic!("the default must not be used when an override is set")
    }

    #[test]
    fn absolute_override_wins() {
        let dir = resolve_data_dir(Some(r"C:\folio-test".into()), default_must_not_run).unwrap();
        assert_eq!(dir, PathBuf::from(r"C:\folio-test"));
    }

    #[test]
    fn relative_override_is_rejected() {
        let err = resolve_data_dir(Some("relative".into()), default_must_not_run).unwrap_err();
        assert!(matches!(err, AppError::DataDirUnavailable(_)));
    }

    #[test]
    fn default_is_used_without_override() {
        let dir = resolve_data_dir(None, || Ok(PathBuf::from(r"C:\default"))).unwrap();
        assert_eq!(dir, PathBuf::from(r"C:\default"));
    }

    #[test]
    fn default_failure_is_reported() {
        let err = resolve_data_dir(None, || Err("no local app data".to_owned())).unwrap_err();
        assert!(matches!(err, AppError::DataDirUnavailable(msg) if msg == "no local app data"));
    }
}
