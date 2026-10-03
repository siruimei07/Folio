//! Machine-local library selection and the lifetime of its background worker.

mod errors;
mod import;
mod operations;
mod problems;
mod worker;

use std::collections::HashMap;
use std::ffi::OsString;
use std::fs;
use std::path::{Component, Path, PathBuf, Prefix};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant};

use folio_core::library::state::{self, Settings};
use folio_core::meta::{DisplayName, Layout, folio_part};
use unicode_normalization::UnicodeNormalization;

use crate::error::AppError;
use crate::ipc::events::CatalogChanged;
use crate::ipc::jobs::{CancelJob, Job};
use crate::ipc::library::{
    CreateLibrary, FolderChoice, FolderContent, LibraryOpened, LibraryStatus, OpenLibrary,
    Unavailable,
};
use crate::ipc::problems::{ListProblems, ProblemItem};
use crate::ipc::types::{LIMITS, Page};
use errors::Failure;
// ipc-m1 §16.2: one mapping of catalog and I/O errors for the whole shell.
pub(crate) use errors::catalog as catalog_error;
pub(crate) use errors::io as io_error;
// One check of the page's entry references (ids, paths, `.folio/`) for every command.
pub(crate) use operations::reference as entry_reference;
use worker::Session;

pub(crate) enum Event {
    Library(LibraryStatus),
    Catalog(CatalogChanged),
    Job(Job),
    Problems(u32),
    Error(String),
    FilesDropped(crate::ipc::events::FilesDropped),
    DropHover(crate::ipc::events::DropHover),
    DropFailed(crate::ipc::events::DropFailed),
}

type Sink = Arc<dyn Fn(Event) + Send + Sync>;

#[derive(Clone)]
pub(crate) struct LibraryState(Arc<Inner>);

struct Inner {
    data_dir: Result<PathBuf, AppError>,
    transition: Mutex<()>,
    state: Mutex<State>,
    ready: Condvar,
    choices: Mutex<HashMap<String, Choice>>,
    import_choices: Mutex<HashMap<String, import::Choice>>,
    closing: AtomicBool,
    closed: AtomicBool,
    emit: Sink,
}

struct State {
    ready: bool,
    attempt: u64,
    status: Result<LibraryStatus, AppError>,
    session: Option<Arc<Session>>,
}

struct Choice {
    root: PathBuf,
    chosen: Instant,
}
const CHOICE_TTL: Duration = Duration::from_secs(10 * 60);
const MAX_CHOICES: usize = 32;

impl LibraryState {
    pub fn new(data_dir: Result<PathBuf, AppError>, emit: Sink) -> Self {
        Self(Arc::new(Inner {
            data_dir,
            transition: Mutex::new(()),
            state: Mutex::new(State {
                ready: false,
                attempt: 0,
                status: Ok(LibraryStatus::None),
                session: None,
            }),
            ready: Condvar::new(),
            choices: Mutex::new(HashMap::new()),
            import_choices: Mutex::new(HashMap::new()),
            closing: AtomicBool::new(false),
            closed: AtomicBool::new(false),
            emit,
        }))
    }

    /// Runs once on a blocking thread. Always releases commands waiting for startup.
    pub fn initialize(&self) {
        let result = self.initialize_inner();
        let mut state = lock(&self.0.state);
        if let Err(error) = result {
            state.status = Err(error);
        }
        state.ready = true;
        self.0.ready.notify_all();
    }

    fn initialize_inner(&self) -> Result<(), AppError> {
        let _transition = lock(&self.0.transition);
        if lock(&self.0.state).ready {
            return Ok(());
        }
        self.accepting()?;
        let settings = self.settings()?;
        if let Some(root) = settings.library_root {
            match Session::prepare(&root, self.data_dir()?, self.0.emit.clone()) {
                Ok(session) => {
                    self.publish(session);
                }
                Err(failure) => {
                    lock(&self.0.state).status = Ok(unavailable(&root, failure.reason));
                    (self.0.emit)(Event::Error(format!(
                        "could not open configured library: {}",
                        failure.error
                    )));
                }
            }
        }
        Ok(())
    }

    pub fn status(&self) -> Result<LibraryStatus, AppError> {
        let mut state = lock(&self.0.state);
        while !state.ready && !self.0.closing.load(Ordering::Acquire) {
            state = self
                .0
                .ready
                .wait(state)
                .unwrap_or_else(PoisonError::into_inner);
        }
        match &state.session {
            Some(session) => Ok(session.status()),
            None => state.status.clone(),
        }
    }

    /// Only an unavailable status observed at call entry may retry. Calls waiting behind
    /// startup or the same attempt return that attempt's result, including identical failures.
    pub fn retry_status(&self) -> Result<LibraryStatus, AppError> {
        let observed = {
            let state = lock(&self.0.state);
            let status = state
                .session
                .as_ref()
                .map_or_else(|| state.status.clone(), |session| Ok(session.status()));
            (state.ready && matches!(status, Ok(LibraryStatus::Unavailable { .. })))
                .then_some(state.attempt)
        };
        self.retry_observed(observed)
    }

    fn retry_observed(&self, observed: Option<u64>) -> Result<LibraryStatus, AppError> {
        self.status()?;
        let Some(observed) = observed else {
            return self.status();
        };
        let _transition = lock(&self.0.transition);
        self.accepting()?;
        if lock(&self.0.state).attempt != observed
            || !matches!(self.status()?, LibraryStatus::Unavailable { .. })
        {
            return self.status();
        }
        let settings = self.settings()?;
        let old = lock(&self.0.state).session.take();
        if let Some(old) = old {
            self.drain(&old, "closing the unavailable library failed");
        }
        match settings.library_root {
            Some(root) => {
                self.reopen(&root);
            }
            None => {
                lock(&self.0.state).status = Ok(LibraryStatus::None);
            }
        }
        let mut state = lock(&self.0.state);
        // Increment on completion so calls arriving during a failed retry also coalesce.
        state.attempt = state.attempt.wrapping_add(1);
        drop(state);
        self.status()
    }

    /// Lets go of the unfinished move that keeps the library unavailable, then opens the
    /// library again like a retry (ipc-m1 §6). Any other status is answered as it is, so a
    /// second call changes nothing. A failure keeps the move and the status.
    pub fn discard_unfinished_move(&self) -> Result<LibraryStatus, AppError> {
        let observed = {
            let state = lock(&self.0.state);
            let status = state
                .session
                .as_ref()
                .map_or_else(|| state.status.clone(), |session| Ok(session.status()));
            (state.ready
                && matches!(
                    status,
                    Ok(LibraryStatus::Unavailable {
                        reason: Unavailable::UnfinishedMove,
                        ..
                    })
                ))
            .then_some(state.attempt)
        };
        self.discard_observed(observed)
    }

    fn discard_observed(&self, observed: Option<u64>) -> Result<LibraryStatus, AppError> {
        self.status()?;
        let _transition = lock(&self.0.transition);
        self.accepting()?;
        let status = self.status()?;
        if observed != Some(lock(&self.0.state).attempt)
            || !matches!(
                status,
                LibraryStatus::Unavailable {
                    reason: Unavailable::UnfinishedMove,
                    ..
                }
            )
        {
            return Ok(status);
        }
        // Only the worker's recovery reports this reason, and its stopped session stays.
        let session = lock(&self.0.state).session.clone().ok_or_else(|| {
            AppError::Internal("no library session holds the unfinished move".to_owned())
        })?;
        session.shutdown()?;
        session.discard_move()?;
        {
            let mut state = lock(&self.0.state);
            // Readers retain the unavailable status until the replacement session is published.
            state.status = Ok(status);
            state.session = None;
        }
        // Release the old catalog before the new session opens its own.
        let root = session.root().to_owned();
        drop(session);
        self.reopen(&root);
        let mut state = lock(&self.0.state);
        // As a retry: a call that saw the old status and waited for the transition reads anew.
        state.attempt = state.attempt.wrapping_add(1);
        drop(state);
        self.status()
    }

    fn data_dir(&self) -> Result<&Path, AppError> {
        self.0.data_dir.as_deref().map_err(Clone::clone)
    }

    /// This computer's `settings.json`; failing to read it is the data directory failing.
    pub(crate) fn settings(&self) -> Result<Settings, AppError> {
        Settings::load(self.data_dir()?).map_err(settings_error)
    }

    /// Changes `settings.json` through `Settings::update`; returns it before and after.
    pub(crate) fn update_settings(
        &self,
        change: impl FnOnce(&mut Settings),
    ) -> Result<(Settings, Settings), AppError> {
        Settings::update(self.data_dir()?, change).map_err(settings_error)
    }

    fn accepting(&self) -> Result<(), AppError> {
        if self.0.closing.load(Ordering::Acquire) {
            Err(AppError::Busy("the app is closing".to_owned()))
        } else {
            Ok(())
        }
    }

    pub fn choose(&self, root: PathBuf) -> Result<FolderChoice, AppError> {
        self.accepting()?;
        let root = directory(&root)?;
        let content = classify(&root)?;
        // The sync-root label only warns (ipc-m1 §6): a failed lookup must not block the choice.
        let sync_root = crate::dialogs::sync_provider(&root).unwrap_or_else(|error| {
            (self.0.emit)(Event::Error(format!(
                "could not check cloud sync folders: {error}"
            )));
            None
        });
        let mut choices = lock(&self.0.choices);
        choices.retain(|_, choice| choice.chosen.elapsed() < CHOICE_TTL);
        if choices.len() >= MAX_CHOICES
            && let Some(oldest) = choices
                .iter()
                .min_by_key(|(_, choice)| choice.chosen)
                .map(|(id, _)| id.clone())
        {
            choices.remove(&oldest);
        }
        let token = crate::jobs::id()?;
        choices.insert(
            token.clone(),
            Choice {
                root: root.clone(),
                chosen: Instant::now(),
            },
        );
        Ok(FolderChoice {
            token,
            path: shown(&root),
            content,
            sync_root,
        })
    }

    fn consume(&self, token: &str) -> Result<PathBuf, AppError> {
        let choice = lock(&self.0.choices)
            .remove(token)
            .filter(|choice| choice.chosen.elapsed() < CHOICE_TTL)
            .ok_or_else(|| AppError::ChoiceExpired("choose the folder again".to_owned()))?;
        let root = directory(&choice.root)?;
        if root != choice.root {
            return Err(AppError::ChoiceExpired(
                "the selected folder changed".to_owned(),
            ));
        }
        Ok(root)
    }

    pub fn create(&self, request: CreateLibrary) -> Result<LibraryOpened, AppError> {
        let name = display_name(&request.name)?;
        let tags = request.preset_tags;
        // In `PresetTag::ALL` order, which `state::create` names them by.
        let names = [
            display_name(&tags.notes)?,
            display_name(&tags.slides)?,
            display_name(&tags.homework)?,
            display_name(&tags.exam)?,
            display_name(&tags.reference)?,
        ];
        self.status()?;
        let _transition = lock(&self.0.transition);
        self.accepting()?;
        // An unreadable settings.json fails before the folder changes.
        self.settings()?;
        let root = self.consume(&request.folder)?;
        state::create(&root, name, names).map_err(|error| match errors::meta(error) {
            AppError::AlreadyExists(detail) => AppError::AlreadyALibrary(detail),
            error => error,
        })?;
        self.replace(&root)
    }

    pub fn open(&self, request: OpenLibrary) -> Result<LibraryOpened, AppError> {
        self.status()?;
        let _transition = lock(&self.0.transition);
        self.accepting()?;
        self.settings()?;
        let root = self.consume(&request.folder)?;
        read_config(&root)?;
        self.replace(&root)
    }

    fn replace(&self, root: &Path) -> Result<LibraryOpened, AppError> {
        // In particular, reopening the same catalog must not overlap two writers/journals.
        let old = lock(&self.0.state).session.take();
        let previous = old.as_ref().map(|old| old.root().to_owned());
        if let Some(old) = old {
            self.drain(&old, "closing the previous library failed");
        }
        let result = self
            .data_dir()
            .and_then(|data_dir| {
                Session::prepare(root, data_dir, self.0.emit.clone()).map_err(AppError::from)
            })
            .and_then(|session| {
                // Read again under the settings lock: App settings may have changed meanwhile.
                let saved = self.update_settings(|settings| {
                    settings.library_root = Some(root.to_owned());
                });
                match saved {
                    Ok(_) => Ok(self.publish(session)),
                    Err(error) => {
                        self.drain(&session, "closing the unsaved library failed");
                        Err(error)
                    }
                }
            });
        // settings.json still names the previous library, so it stays this machine's library.
        if result.is_err()
            && let Some(previous) = previous
        {
            self.reopen(&previous);
        }
        result
    }

    /// The session is gone whatever its drain reports; a failure only goes to the log.
    fn drain(&self, session: &Session, context: &str) {
        if let Err(error) = session.shutdown() {
            (self.0.emit)(Event::Error(format!("{context}: {error}")));
        }
    }

    /// Reopens the previous library after a failed switch, or reports it unavailable.
    fn reopen(&self, root: &Path) {
        let reopened = self
            .data_dir()
            .map_err(Failure::own)
            .and_then(|data_dir| Session::prepare(root, data_dir, self.0.emit.clone()))
            .map(|session| self.publish(session));
        if let Err(failure) = reopened {
            let status = unavailable(root, failure.reason);
            lock(&self.0.state).status = Ok(status.clone());
            (self.0.emit)(Event::Error(format!(
                "could not reopen the previous library: {}",
                failure.error
            )));
            (self.0.emit)(Event::Library(status));
        }
    }

    fn publish(&self, session: Arc<Session>) -> LibraryOpened {
        let opened = session.opened();
        let status = LibraryStatus::Open {
            library: opened.library.clone(),
        };
        {
            let mut state = lock(&self.0.state);
            state.attempt = state.attempt.wrapping_add(1);
            state.status = Ok(status.clone());
            state.session = Some(session.clone());
        }
        lock(&self.0.choices).clear();
        lock(&self.0.import_choices).clear();
        (self.0.emit)(Event::Library(status));
        session.activate();
        opened
    }

    fn session(&self) -> Result<Arc<Session>, AppError> {
        self.status()?;
        self.accepting()?;
        let session = lock(&self.0.state)
            .session
            .clone()
            .ok_or_else(|| AppError::NoLibrary("open a library first".to_owned()))?;
        if matches!(session.status(), LibraryStatus::Unavailable { .. }) {
            return Err(AppError::NoLibrary("the library is unavailable".to_owned()));
        }
        Ok(session)
    }

    /// A catalog read with the same switch/shutdown boundary as the list reads (`with_reads`).
    pub(crate) fn read_catalog<T>(
        &self,
        query: impl FnOnce(&folio_core::catalog::Catalog) -> Result<T, AppError>,
    ) -> Result<T, AppError> {
        self.with_reads(|session| query(session.catalog()))
    }

    pub fn list_jobs(&self) -> Result<Vec<Job>, AppError> {
        Ok(self.session()?.jobs.list())
    }

    /// Runs a list read under the transition, like `with_entry`, so it never reads a library
    /// that a switch has already drained. Reads use WAL snapshots and never wait for the worker.
    fn with_reads<T>(
        &self,
        action: impl FnOnce(&Session) -> Result<T, AppError>,
    ) -> Result<T, AppError> {
        self.status()?;
        let _transition = lock(&self.0.transition);
        let session = self.session()?;
        action(&session)
    }

    /// Takes the session under the transition, then releases it: a write waits for the worker's
    /// operation mutex through a whole walk or hash job, and must not hold up reads, file
    /// actions, switching or closing meanwhile. `Session::shutdown` waits for a write that is
    /// running; one that starts later finds the session stopped and changes nothing.
    fn with_operations<T>(
        &self,
        action: impl FnOnce(&Session) -> Result<T, AppError>,
    ) -> Result<T, AppError> {
        self.status()?;
        let session = {
            let _transition = lock(&self.0.transition);
            self.session()?
        };
        action(&session)
    }

    /// Checks a reference against the live catalog and runs `action` on the entry while the
    /// library transition and the catalog writer are held, so no library switch and no Folio
    /// change lands between the check and the action. Everything else waits meanwhile: keep
    /// `action` short. File actions pin the path here (`open::PinnedEntry`) and read or launch
    /// after this returns.
    pub(crate) fn with_entry<T>(
        &self,
        reference: &crate::ipc::types::EntryRef,
        action: impl FnOnce(&Path, &folio_core::catalog::Entry) -> Result<T, AppError>,
    ) -> Result<T, AppError> {
        let reference = operations::reference(reference)?;
        self.status()?;
        let _transition = lock(&self.0.transition);
        self.session()?
            .with_entry(reference.id.0, &reference.path, action)
    }
    pub fn cancel(&self, request: CancelJob) -> Result<(), AppError> {
        match self.session() {
            Ok(session) => session.jobs.cancel(&request.job),
            Err(AppError::NoLibrary(_)) => {
                Err(AppError::NotFound("job is unknown or finished".to_owned()))
            }
            Err(error) => Err(error),
        }
    }
    pub fn rebuild(&self) -> Result<String, AppError> {
        self.session()?.rebuild()
    }
    pub fn problems(&self, request: ListProblems) -> Result<Page<ProblemItem>, AppError> {
        if request.page.limit > LIMITS.page_size {
            return Err(AppError::InvalidArgument(
                "page limit exceeds LIMITS.pageSize".to_owned(),
            ));
        }
        Ok(self.session()?.problems(request.page))
    }

    /// The close handler uses this before spawning a drain, so repeated page/native requests
    /// cannot start competing drains. The page never participates in the final destroy.
    pub fn begin_close(&self) -> bool {
        // Under the startup condition variable's mutex, so no waiter misses the wakeup.
        let _state = lock(&self.0.state);
        let first = !self.0.closing.swap(true, Ordering::AcqRel);
        self.0.ready.notify_all();
        first
    }
    pub fn is_closed(&self) -> bool {
        self.0.closed.load(Ordering::Acquire)
    }
    /// Always marks the app closed, so an exit request after a failed drain is not held back.
    pub fn shutdown(&self) -> Result<(), AppError> {
        self.begin_close();
        let _transition = lock(&self.0.transition);
        let session = lock(&self.0.state).session.take();
        let result = session.map_or(Ok(()), |session| session.shutdown());
        self.0.closed.store(true, Ordering::Release);
        result
    }
}

/// A panic while one of the library locks is held is a bug, and every guarded value is valid
/// between statements. Recovering keeps the shell able to drain and exit: an error here would
/// leave a close request, or the worker, stuck behind a lock that no one can release.
pub(crate) fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

fn directory(root: &Path) -> Result<PathBuf, AppError> {
    if !root.is_absolute() {
        return Err(AppError::InvalidArgument(
            "folder must be absolute".to_owned(),
        ));
    }
    let root = fs::canonicalize(root).map_err(errors::io)?;
    if !fs::metadata(&root).map_err(errors::io)?.is_dir() {
        return Err(AppError::InvalidArgument(
            "folder is not a directory".to_owned(),
        ));
    }
    Ok(root)
}

fn read_config(root: &Path) -> Result<folio_core::meta::LibraryConfig, Failure> {
    // Metadata is privileged write input; validate its parent directories before reading it.
    state::validate_metadata(root).map_err(Failure::metadata)?;
    let layout = Layout::new(root);
    layout
        .read_library()
        .map_err(Failure::metadata)?
        .ok_or_else(|| Failure::not_a_library("missing .folio/library.json".to_owned()))
}

fn classify(root: &Path) -> Result<FolderContent, AppError> {
    if Layout::new(root)
        .library_file()
        .try_exists()
        .map_err(errors::io)?
    {
        return Ok(FolderContent::Library {
            name: read_config(root)?.name.as_str().to_owned(),
        });
    }
    for ancestor in root.ancestors().skip(1) {
        if Layout::new(ancestor)
            .library_file()
            .try_exists()
            .map_err(errors::io)?
        {
            return Ok(FolderContent::InsideLibrary {
                root: shown(ancestor),
            });
        }
    }
    let (mut incomplete, mut folders, mut files) = (false, 0_u32, 0_u32);
    for entry in fs::read_dir(root).map_err(errors::io)? {
        let entry = entry.map_err(errors::io)?;
        // Not following links: a link or a file named `.folio` is ordinary content, which
        // create_library then refuses. A real folder is a creation that failed before
        // library.json.
        let folder = entry.file_type().map_err(errors::io)?.is_dir();
        if folder && folio_part(&[entry.file_name()]).is_some() {
            incomplete = true;
        } else if folder {
            folders = folders.saturating_add(1);
        } else {
            files = files.saturating_add(1);
        }
    }
    Ok(if incomplete {
        FolderContent::Incomplete { folders, files }
    } else if folders == 0 && files == 0 {
        FolderContent::Empty
    } else {
        FolderContent::Folders { folders, files }
    })
}

/// `settings.json` belongs to the data directory: failing to read or write it is the data
/// directory failing.
fn settings_error(error: folio_core::meta::MetaError) -> AppError {
    AppError::DataDirUnavailable(error.to_string())
}

/// A library, tag or device name the user typed (ipc-m1 §16.3).
pub(crate) fn display_name(value: &str) -> Result<DisplayName, AppError> {
    let value: String = value.trim().nfc().collect();
    if value.is_empty() {
        return Err(AppError::NameEmpty("display name".to_owned()));
    }
    if value.chars().count() > LIMITS.display_name_chars as usize {
        return Err(AppError::NameTooLong("display name".to_owned()));
    }
    if value.chars().any(char::is_control) {
        return Err(AppError::NameInvalidCharacter(
            "display name contains a control character".to_owned(),
        ));
    }
    DisplayName::parse(&value).map_err(|error| AppError::InvalidArgument(error.to_string()))
}

/// A path as Windows users write it, for the UI. The shell keeps canonical paths, which carry
/// the verbatim `\\?\` prefix; display only, never read back.
fn shown(path: &Path) -> String {
    let mut components = path.components();
    let plain = match components.next() {
        Some(Component::Prefix(prefix)) => match prefix.kind() {
            Prefix::VerbatimDisk(letter) => OsString::from(format!("{}:", char::from(letter))),
            Prefix::VerbatimUNC(server, share) => {
                let mut plain = OsString::from(r"\\");
                plain.push(server);
                plain.push(r"\");
                plain.push(share);
                plain
            }
            _ => return path.display().to_string(),
        },
        _ => return path.display().to_string(),
    };
    let mut plain = PathBuf::from(plain);
    plain.extend(components);
    plain.display().to_string()
}

fn unavailable(root: &Path, reason: Unavailable) -> LibraryStatus {
    LibraryStatus::Unavailable {
        root: shown(root),
        reason,
    }
}

// Library settings → Ignore rules (ipc-m1 §22).
mod ignore;

#[cfg(test)]
mod tests;
