use std::io;

use folio_core::catalog::CatalogError;
use folio_core::library::LibraryError;
use folio_core::meta::MetaError;

use crate::error::AppError;

pub(super) fn io(error: io::Error) -> AppError {
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

pub(super) fn library(error: LibraryError) -> AppError {
    match error {
        LibraryError::Root { source, .. } => io(source),
        LibraryError::NotALibrary { .. } => AppError::NotALibrary(error.to_string()),
        LibraryError::Meta(error) => meta(error),
        LibraryError::Catalog(error) => catalog(error),
    }
}
