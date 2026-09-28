use serde::Serialize;
use specta::Type;

/// The error every command returns (CLAUDE.md §5, "No silent failures"; docs/specs/ipc-m1.md
/// §16).
///
/// Serialised as `{ code, detail }`. The UI maps `code` to a message in
/// `apps/desktop/src/i18n/locales/en/errors.json`; `tsc` fails if a code has no message. Each
/// case the UI words differently has its own code. `detail` is for logs and bug reports, never
/// shown to users on its own.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error, Serialize, Type)]
#[serde(tag = "code", content = "detail")]
pub enum AppError {
    /// The data directory could not be determined or is invalid.
    #[error("data directory unavailable: {0}")]
    DataDirUnavailable(String),
    /// The UI sent a value the shell rejects: a bug in the UI.
    #[error("invalid argument: {0}")]
    InvalidArgument(String),
    /// A window operation failed.
    #[error("window operation failed: {0}")]
    Window(String),
    /// No library is open.
    #[error("no library is open: {0}")]
    NoLibrary(String),
    /// The folder has no `.folio/library.json`.
    #[error("not a Folio library: {0}")]
    NotALibrary(String),
    /// The folder is, or is inside, a library.
    #[error("already a Folio library: {0}")]
    AlreadyALibrary(String),
    /// A newer Folio wrote the library; update Folio to open it.
    #[error("written by a newer Folio: {0}")]
    NewerFormat(String),
    /// A newer Folio wrote some metadata: tags and settings cannot change until Folio is updated.
    #[error("the library metadata is read-only: {0}")]
    ReadOnly(String),
    /// The entry, tag, semester, course or job is gone, or not where the UI saw it.
    #[error("not found: {0}")]
    NotFound(String),
    /// The name is taken in that folder (ignoring case), or by another tag.
    #[error("the name is taken: {0}")]
    AlreadyExists(String),
    /// A folder into itself or below itself, or a semester folder.
    #[error("invalid move: {0}")]
    InvalidMove(String),
    /// A typed name is empty.
    #[error("empty name: {0}")]
    NameEmpty(String),
    /// A typed name is longer than its field allows.
    #[error("name too long: {0}")]
    NameTooLong(String),
    /// A typed name holds a character its field does not allow.
    #[error("invalid character in a name: {0}")]
    NameInvalidCharacter(String),
    /// A file or folder name ends with a dot or a space.
    #[error("a name ends with a dot or a space: {0}")]
    NameTrailingDotOrSpace(String),
    /// A name reserved by Windows (`CON`, `NUL`, …) or by Folio (`.folio` at the library root).
    #[error("reserved name: {0}")]
    NameReserved(String),
    /// The path would be longer than Windows allows.
    #[error("path too long: {0}")]
    PathTooLong(String),
    /// Another program holds the file.
    #[error("in use by another program: {0}")]
    InUse(String),
    /// Windows denied access.
    #[error("access denied: {0}")]
    AccessDenied(String),
    /// The disk is full.
    #[error("disk full: {0}")]
    DiskFull(String),
    /// Another file-system failure.
    #[error("file system error: {0}")]
    FileSystem(String),
    /// The search text is longer than `LIMITS.queryChars`.
    #[error("search text too long: {0}")]
    QueryTooLong(String),
    /// A choice token is unknown, used or expired: the user must choose again.
    #[error("the choice expired: {0}")]
    ChoiceExpired(String),
    /// `open_entry` does not run programs or scripts.
    #[error("blocked: {0}")]
    Blocked(String),
    /// The catalog is being rebuilt; try again when it is done.
    #[error("busy: {0}")]
    Busy(String),
    /// A bug or damaged state; the log has the details.
    #[error("internal error: {0}")]
    Internal(String),
}

#[cfg(test)]
mod tests {
    use super::AppError;

    /// Every variant with the same detail. The match fails to compile until a new variant is
    /// listed here too.
    macro_rules! every_error {
        ($($code:ident),* $(,)?) => {{
            let _listed = |error: &AppError| match error {
                $(AppError::$code(_))|* => {}
            };
            vec![$((stringify!($code), AppError::$code("detail".to_owned()))),*]
        }};
    }

    #[test]
    fn every_error_serializes_as_its_code_and_a_detail() {
        let errors = every_error![
            DataDirUnavailable,
            InvalidArgument,
            Window,
            NoLibrary,
            NotALibrary,
            AlreadyALibrary,
            NewerFormat,
            ReadOnly,
            NotFound,
            AlreadyExists,
            InvalidMove,
            NameEmpty,
            NameTooLong,
            NameInvalidCharacter,
            NameTrailingDotOrSpace,
            NameReserved,
            PathTooLong,
            InUse,
            AccessDenied,
            DiskFull,
            FileSystem,
            QueryTooLong,
            ChoiceExpired,
            Blocked,
            Busy,
            Internal,
        ];
        for (code, error) in errors {
            assert_eq!(
                serde_json::to_value(&error).unwrap(),
                serde_json::json!({ "code": code, "detail": "detail" })
            );
        }
    }
}
