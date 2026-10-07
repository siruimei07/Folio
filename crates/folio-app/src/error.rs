use serde::Serialize;
use specta::Type;

/// The error every command returns (CLAUDE.md §5, "No silent failures"; docs/specs/ipc-m1.md
/// §16).
///
/// Serialised as `{ code, detail }`. The UI maps `code` to a message in
/// `apps/desktop/src/i18n/locales/en/errors.json`; `tsc` fails if a code has no message. Each
/// case the UI words differently has its own code. `detail` is for logs and bug reports, never
/// shown to users on its own.
///
/// The M2 codes (docs/specs/ipc-m2.md §15) are declared before the lanes that return them: each
/// expects to be dead code outside tests until then, and the lane that first returns one removes
/// its expectation (clippy fails on an expectation that no longer holds).
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
    /// The Recycle Bin cannot take the item: its drive has none, its path is too long for it, or
    /// it is larger than the bin allows. Nothing moved; Folio never deletes for good.
    #[error("the Recycle Bin cannot take it: {0}")]
    NotRecyclable(String),
    /// The file's content is not on this disk: a cloud placeholder or an offline file, which
    /// the shell never downloads.
    #[error("not on this disk: {0}")]
    NotLocal(String),
    /// Windows cannot make a thumbnail of the file: no thumbnail handler for its type, or a
    /// damaged file.
    #[error("no thumbnail: {0}")]
    NoThumbnail(String),
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
    // M2 (docs/specs/ipc-m2.md §15)
    /// The changes changed since the UI read them (the fingerprint or the base).
    #[error("the workspace changed: {0}")]
    WorkspaceChanged(String),
    /// The selection and the metadata hold no change.
    #[cfg_attr(
        not(test),
        expect(dead_code, reason = "returned once its M2 lane lands")
    )]
    #[error("nothing to commit: {0}")]
    NothingToCommit(String),
    /// A file kept changing while Folio read it, or a restore's target changed before it was
    /// replaced.
    #[cfg_attr(
        not(test),
        expect(dead_code, reason = "returned once its M2 lane lands")
    )]
    #[error("the file changed: {0}")]
    FileChanged(String),
    /// `start_history`: the history has started already.
    #[cfg_attr(
        not(test),
        expect(dead_code, reason = "returned once its M2 lane lands")
    )]
    #[error("the history exists: {0}")]
    HistoryExists(String),
    /// Another commit, reword, uncommit or restore is running, or recovery of an earlier one.
    #[cfg_attr(
        not(test),
        expect(dead_code, reason = "returned once its M2 lane lands")
    )]
    #[error("another history operation is running: {0}")]
    HistoryBusy(String),
    /// `uncommit`: the commit is no longer the newest.
    #[cfg_attr(
        not(test),
        expect(dead_code, reason = "returned once its M2 lane lands")
    )]
    #[error("not the newest commit: {0}")]
    NotHead(String),
    /// The first commit, a prune commit, or a synced one cannot be undone.
    #[cfg_attr(
        not(test),
        expect(dead_code, reason = "returned once its M2 lane lands")
    )]
    #[error("the commit cannot be undone: {0}")]
    CannotUncommit(String),
    /// A prune commit's or a synced commit's message cannot be changed.
    #[cfg_attr(
        not(test),
        expect(dead_code, reason = "returned once its M2 lane lands")
    )]
    #[error("the message cannot be changed: {0}")]
    CannotReword(String),
    /// A newer Folio wrote the history: commits, rewords, uncommits and restores wait for an
    /// update.
    #[cfg_attr(
        not(test),
        expect(dead_code, reason = "returned once its M2 lane lands")
    )]
    #[error("the history is read-only: {0}")]
    HistoryReadOnly(String),
    /// `HEAD`, a pack or an object is missing or damaged. The files are fine.
    #[cfg_attr(
        not(test),
        expect(dead_code, reason = "returned once its M2 lane lands")
    )]
    #[error("the history is damaged: {0}")]
    HistoryDamaged(String),
    /// That version was not kept: an event-only file, or text over the size limit.
    #[cfg_attr(
        not(test),
        expect(dead_code, reason = "returned once its M2 lane lands")
    )]
    #[error("the version was not kept: {0}")]
    NotStored(String),
    /// That version was thinned out.
    #[cfg_attr(
        not(test),
        expect(dead_code, reason = "returned once its M2 lane lands")
    )]
    #[error("the version was thinned out: {0}")]
    Pruned(String),
    /// `restore_version`: the file already has that content.
    #[cfg_attr(
        not(test),
        expect(dead_code, reason = "returned once its M2 lane lands")
    )]
    #[error("nothing to restore: {0}")]
    Unchanged(String),
    /// A commit summary is empty.
    #[cfg_attr(
        not(test),
        expect(dead_code, reason = "returned once its M2 lane lands")
    )]
    #[error("empty summary: {0}")]
    SummaryEmpty(String),
    /// A commit summary is longer than `LIMITS.summaryChars`.
    #[cfg_attr(
        not(test),
        expect(dead_code, reason = "returned once its M2 lane lands")
    )]
    #[error("summary too long: {0}")]
    SummaryTooLong(String),
    /// A commit summary holds a control character, a line break included.
    #[cfg_attr(
        not(test),
        expect(dead_code, reason = "returned once its M2 lane lands")
    )]
    #[error("invalid character in the summary: {0}")]
    SummaryInvalid(String),
    /// A commit body is longer than `LIMITS.bodyChars`.
    #[cfg_attr(
        not(test),
        expect(dead_code, reason = "returned once its M2 lane lands")
    )]
    #[error("body too long: {0}")]
    BodyTooLong(String),
    /// A commit body holds a control character other than tab and line feed.
    #[cfg_attr(
        not(test),
        expect(dead_code, reason = "returned once its M2 lane lands")
    )]
    #[error("invalid character in the body: {0}")]
    BodyInvalid(String),
    /// AI is off, or no key is stored for the endpoint.
    #[cfg_attr(
        not(test),
        expect(dead_code, reason = "returned once its M2 lane lands")
    )]
    #[error("AI is not set up: {0}")]
    AiNotConfigured(String),
    /// The AI service could not be reached: name, connection or TLS.
    #[cfg_attr(
        not(test),
        expect(dead_code, reason = "returned once its M2 lane lands")
    )]
    #[error("AI network error: {0}")]
    AiNetwork(String),
    /// The AI service did not answer in time.
    #[cfg_attr(
        not(test),
        expect(dead_code, reason = "returned once its M2 lane lands")
    )]
    #[error("AI timeout: {0}")]
    AiTimeout(String),
    /// The AI service refused the key (401, 403).
    #[cfg_attr(
        not(test),
        expect(dead_code, reason = "returned once its M2 lane lands")
    )]
    #[error("AI key rejected: {0}")]
    AiRejected(String),
    /// The AI service asks to wait (429).
    #[cfg_attr(
        not(test),
        expect(dead_code, reason = "returned once its M2 lane lands")
    )]
    #[error("AI rate limited: {0}")]
    AiRateLimited(String),
    /// The AI service failed (5xx).
    #[cfg_attr(
        not(test),
        expect(dead_code, reason = "returned once its M2 lane lands")
    )]
    #[error("AI service unavailable: {0}")]
    AiUnavailable(String),
    /// The AI service's answer could not be used.
    #[cfg_attr(
        not(test),
        expect(dead_code, reason = "returned once its M2 lane lands")
    )]
    #[error("unusable AI answer: {0}")]
    AiBadResponse(String),
    /// Windows Credential Manager failed; the detail names its error code, never the key.
    #[cfg_attr(
        not(test),
        expect(dead_code, reason = "returned once its M2 lane lands")
    )]
    #[error("credential store failed: {0}")]
    AiCredential(String),
    /// A typed AI endpoint is not an `https` address with a host and no user name, query or
    /// fragment.
    #[cfg_attr(
        not(test),
        expect(dead_code, reason = "returned once its M2 lane lands")
    )]
    #[error("invalid AI endpoint: {0}")]
    AiEndpointInvalid(String),
    /// A typed AI model name is empty, too long or not visible ASCII.
    #[cfg_attr(
        not(test),
        expect(dead_code, reason = "returned once its M2 lane lands")
    )]
    #[error("invalid AI model: {0}")]
    AiModelInvalid(String),
    /// A typed AI key is empty, too long or not visible ASCII.
    #[cfg_attr(
        not(test),
        expect(dead_code, reason = "returned once its M2 lane lands")
    )]
    #[error("invalid AI key: {0}")]
    AiKeyInvalid(String),
    /// A commit or the first commit would make the history larger than Folio keeps: a folder
    /// holds too many files (the failed job's `file`), or the library as a whole does. Found
    /// before anything is read; nothing is written, and it is not damage. A job's failure only,
    /// never a command's answer (docs/specs/ipc-m2.md §7.1, §13).
    #[cfg_attr(
        not(test),
        expect(dead_code, reason = "returned once its M2 lane lands")
    )]
    #[error("the history would be too large: {0}")]
    HistoryTooLarge(String),
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

    fn errors() -> Vec<(&'static str, AppError)> {
        every_error![
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
            NotRecyclable,
            NotLocal,
            NoThumbnail,
            FileSystem,
            QueryTooLong,
            ChoiceExpired,
            Blocked,
            Busy,
            Internal,
            WorkspaceChanged,
            NothingToCommit,
            FileChanged,
            HistoryExists,
            HistoryBusy,
            NotHead,
            CannotUncommit,
            CannotReword,
            HistoryReadOnly,
            HistoryDamaged,
            NotStored,
            Pruned,
            Unchanged,
            SummaryEmpty,
            SummaryTooLong,
            SummaryInvalid,
            BodyTooLong,
            BodyInvalid,
            AiNotConfigured,
            AiNetwork,
            AiTimeout,
            AiRejected,
            AiRateLimited,
            AiUnavailable,
            AiBadResponse,
            AiCredential,
            AiEndpointInvalid,
            AiModelInvalid,
            AiKeyInvalid,
            HistoryTooLarge,
        ]
    }

    #[test]
    fn every_error_serializes_as_its_code_and_a_detail() {
        for (code, error) in errors() {
            assert_eq!(
                serde_json::to_value(&error).unwrap(),
                serde_json::json!({ "code": code, "detail": "detail" })
            );
        }
    }

    /// The `folio-file` scheme names its failures with these codes (docs/specs/ipc-m1.md §11.2).
    #[test]
    fn file_error_codes_are_error_codes() {
        let codes: Vec<&str> = errors().into_iter().map(|(code, _)| code).collect();
        for code in crate::ipc::entries::FILE_ERROR_CODES {
            assert!(codes.contains(&code), "`{code}` is not an AppError code");
        }
    }
}
