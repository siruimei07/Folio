use std::io;

use folio_core::catalog::CatalogError;
use folio_core::library::LibraryError;
use folio_core::meta::MetaError;

use crate::error::AppError;
use crate::ipc::library::Unavailable;

pub(crate) fn io(error: io::Error) -> AppError {
    let detail = error.to_string();
    if folio_core::fs::is_in_use(&error) {
        return AppError::InUse(detail);
    }
    match error.kind() {
        io::ErrorKind::NotFound => AppError::NotFound(detail),
        io::ErrorKind::AlreadyExists => AppError::AlreadyExists(detail),
        io::ErrorKind::PermissionDenied => AppError::AccessDenied(detail),
        io::ErrorKind::StorageFull => AppError::DiskFull(detail),
        _ => AppError::FileSystem(detail),
    }
}

pub(super) fn meta(error: MetaError) -> AppError {
    match error {
        MetaError::Io { source, .. } => io(source),
        MetaError::NewerFormat { .. } => AppError::NewerFormat(error.to_string()),
        _ => AppError::Internal(error.to_string()),
    }
}

pub(super) fn catalog(error: CatalogError) -> AppError {
    match error {
        CatalogError::Io { source, .. } => io(source),
        CatalogError::NoEntry(_) | CatalogError::MissingParent(_) => {
            AppError::NotFound(error.to_string())
        }
        _ => AppError::Internal(error.to_string()),
    }
}

/// Why a library cannot be opened, or stopped working. The reason is decided where the failure
/// happens (ipc-m1 §6): the flattened `AppError` cannot tell a missing library folder from a
/// catalog file that could not be created.
#[derive(Debug)]
pub(super) struct Failure {
    pub reason: Unavailable,
    pub error: AppError,
}

impl Failure {
    /// Opening, listing or watching the library folder failed.
    pub fn root(error: AppError) -> Self {
        let reason = match error {
            AppError::AccessDenied(_) => Unavailable::AccessDenied,
            _ => Unavailable::Missing,
        };
        Self { reason, error }
    }

    /// Reading or writing `.folio/` failed. The folder was there a moment ago, so a full disk
    /// or a file another program holds is not a missing library.
    pub fn metadata(error: MetaError) -> Self {
        let error = meta(error);
        let reason = match error {
            AppError::NewerFormat(_) => Unavailable::NewerFormat,
            AppError::AccessDenied(_) => Unavailable::AccessDenied,
            AppError::DiskFull(_) | AppError::InUse(_) => Unavailable::CatalogFailed,
            // A damaged file, or a link where metadata belongs.
            AppError::Internal(_) => Unavailable::NotALibrary,
            _ => Unavailable::Missing,
        };
        Self { reason, error }
    }

    /// Folio's own state on this machine failed: the catalog, or the background work.
    pub fn own(error: AppError) -> Self {
        Self {
            reason: Unavailable::CatalogFailed,
            error,
        }
    }

    pub fn not_a_library(detail: String) -> Self {
        Self {
            reason: Unavailable::NotALibrary,
            error: AppError::NotALibrary(detail),
        }
    }
}

impl From<Failure> for AppError {
    fn from(failure: Failure) -> Self {
        failure.error
    }
}

pub(super) fn library(error: LibraryError) -> Failure {
    match error {
        LibraryError::Root { source, .. } => Failure::root(io(source)),
        LibraryError::NotALibrary { .. } => Failure::not_a_library(error.to_string()),
        LibraryError::Meta(error) => Failure::metadata(error),
        LibraryError::Catalog(error) => Failure::own(catalog(error)),
    }
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use super::*;

    fn io_at(kind: io::ErrorKind) -> MetaError {
        MetaError::Io {
            path: PathBuf::from("library.json"),
            source: kind.into(),
        }
    }

    #[test]
    fn reasons_follow_where_opening_failed_not_the_error_code() {
        let catalog_io = |kind: io::ErrorKind| {
            LibraryError::Catalog(CatalogError::Io {
                path: PathBuf::from("catalog.sqlite"),
                source: kind.into(),
            })
        };
        let root_io = |kind: io::ErrorKind| LibraryError::Root {
            path: PathBuf::from("library"),
            source: kind.into(),
        };
        let cases = [
            // A catalog file that cannot be found or opened is still Folio's own state.
            (
                catalog_io(io::ErrorKind::NotFound),
                Unavailable::CatalogFailed,
            ),
            (
                catalog_io(io::ErrorKind::PermissionDenied),
                Unavailable::CatalogFailed,
            ),
            (root_io(io::ErrorKind::NotFound), Unavailable::Missing),
            // A drive that is not ready is not the catalog's fault.
            (
                LibraryError::Root {
                    path: PathBuf::from("library"),
                    source: io::Error::from_raw_os_error(21),
                },
                Unavailable::Missing,
            ),
            (
                root_io(io::ErrorKind::PermissionDenied),
                Unavailable::AccessDenied,
            ),
            (
                LibraryError::NotALibrary {
                    path: PathBuf::from("library.json"),
                },
                Unavailable::NotALibrary,
            ),
            (
                LibraryError::Meta(io_at(io::ErrorKind::PermissionDenied)),
                Unavailable::AccessDenied,
            ),
            (
                LibraryError::Meta(io_at(io::ErrorKind::Other)),
                Unavailable::Missing,
            ),
            // A scan that cannot write .folio/meta: the folder is there.
            (
                LibraryError::Meta(io_at(io::ErrorKind::StorageFull)),
                Unavailable::CatalogFailed,
            ),
            (
                LibraryError::Meta(MetaError::Io {
                    path: PathBuf::from("tags.json"),
                    // ERROR_SHARING_VIOLATION
                    source: io::Error::from_raw_os_error(32),
                }),
                Unavailable::CatalogFailed,
            ),
            (
                LibraryError::Meta(MetaError::NewerFormat {
                    path: PathBuf::from("library.json"),
                    found: 9,
                }),
                Unavailable::NewerFormat,
            ),
            (
                LibraryError::Meta(MetaError::Invalid {
                    path: PathBuf::from("library.json"),
                    reason: "not JSON".to_owned(),
                }),
                Unavailable::NotALibrary,
            ),
        ];
        for (error, reason) in cases {
            let detail = error.to_string();
            assert_eq!(library(error).reason, reason, "{detail}");
        }
        assert_eq!(
            Failure::root(AppError::InvalidArgument("not a folder".to_owned())).reason,
            Unavailable::Missing
        );
    }
}
