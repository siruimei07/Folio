//! Shell-authorized external files, copied and verified before any item is recycled.
//!
//! The shell serializes the whole job with scans and operations. This module never accepts
//! paths from IPC and never recycles a source during crash recovery.

mod journal;

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::fmt;
use std::fs::{self, File};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use unicode_normalization::UnicodeNormalization;

use super::{EntryRef, MAX_BATCH, OperationError, folder};
use crate::catalog::{self, Catalog};
use crate::files;
use crate::fs::{FileKind, FileSystem, Metadata, Presence};
use crate::hash::ContentHash;
use crate::library::rules::{
    GITIGNORE, Gitignores, Rules, VENV_MARKER, Verdict, is_always_ignored, read_rules,
};
use crate::library::{CommittedScan, Library, state};
use crate::meta::{EntryKind, LibraryId, MetaTree, TagId};
use crate::paths::{PathKey, RelPath, same_name};
use crate::recycle::RecycleBin;

const RESULTS: usize = 100;
const COPY_CHUNK: usize = 256 * 1024;

/// A user-selected native path and its identity. Constructed only by the privileged shell.
#[derive(Clone)]
pub struct Source {
    path: PathBuf,
    name: String,
    selected: Metadata,
    fs: Arc<dyn FileSystem>,
}

impl fmt::Debug for Source {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Source")
            .field("path", &self.path)
            .field("selected", &self.selected)
            .finish_non_exhaustive()
    }
}

impl Source {
    /// Inspects the item before canonicalizing, so a selected link remains a skipped link.
    pub fn select(path: PathBuf) -> Result<Self, OperationError> {
        Self::select_in(path, &mut HashMap::new())
    }

    /// Selects a whole batch; items in one folder share its file-system adapter, so a drop of
    /// many files probes their folder once.
    pub fn select_all(paths: Vec<PathBuf>) -> Result<Vec<Self>, OperationError> {
        let mut adapters = HashMap::new();
        paths
            .into_iter()
            .map(|path| Self::select_in(path, &mut adapters))
            .collect()
    }

    fn select_in(
        path: PathBuf,
        adapters: &mut HashMap<PathBuf, Arc<dyn FileSystem>>,
    ) -> Result<Self, OperationError> {
        if !path.is_absolute() || path.file_name().is_none() {
            return Err(OperationError::InvalidArgument(
                "source is not an absolute item",
            ));
        }
        let parent = path
            .parent()
            .ok_or(OperationError::InvalidArgument("source has no parent"))?;
        let parent = fs::canonicalize(parent).map_err(|error| io_at(parent, error))?;
        let source_fs = match adapters.get(&parent) {
            Some(adapter) => Arc::clone(adapter),
            None => {
                let adapter = source_fs(&parent)?;
                adapters.insert(parent.clone(), Arc::clone(&adapter));
                adapter
            }
        };
        let original = parent.join(
            path.file_name()
                .ok_or(OperationError::InvalidArgument("source has no name"))?,
        );
        let selected = source_fs
            .metadata(&original)
            .map_err(|error| io_at(&original, error))?;
        let canonical = if matches!(selected.kind, FileKind::Link | FileKind::Other)
            || selected.presence != Presence::Local
        {
            original
        } else {
            fs::canonicalize(&original).map_err(|error| io_at(&original, error))?
        };
        let name = canonical
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or(OperationError::InvalidArgument(
                "source name is not Unicode",
            ))?
            .to_owned();
        let current = source_fs
            .metadata(&canonical)
            .map_err(|error| io_at(&canonical, error))?;
        if !same_source(&current, &selected) {
            return Err(changed_source(&canonical));
        }
        Ok(Self {
            path: canonical,
            name,
            selected,
            fs: source_fs,
        })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }
    pub fn name(&self) -> &str {
        &self.name
    }
    pub fn kind(&self) -> EntryKind {
        if self.selected.kind == FileKind::Folder {
            EntryKind::Folder
        } else {
            EntryKind::File
        }
    }

    fn validate(&self) -> Result<(), OperationError> {
        let current = self
            .fs
            .metadata(&self.path)
            .map_err(|error| io_at(&self.path, error))?;
        if same_source(&current, &self.selected) {
            Ok(())
        } else {
            Err(changed_source(&self.path))
        }
    }

    fn inspect(&self, path: &Path, expected: &Metadata) -> Result<(), OperationError> {
        let relative = path
            .strip_prefix(&self.path)
            .map_err(|_| OperationError::InvalidArgument("source escaped its selection"))?;
        let mut current = self.path.clone();
        for part in relative.components() {
            let ancestor = self
                .fs
                .metadata(&current)
                .map_err(|error| io_at(&current, error))?;
            if ancestor.kind != FileKind::Folder {
                return Err(changed_source(&current));
            }
            current.push(part);
        }
        let actual = self.fs.metadata(path).map_err(|error| io_at(path, error))?;
        if !same_source(&actual, expected) {
            return Err(changed_source(path));
        }
        if expected.kind == FileKind::File && expected.presence != Presence::Local {
            return Err(OperationError::NotLocal {
                path: path.to_owned(),
            });
        }
        Ok(())
    }
}

fn same_source(actual: &Metadata, expected: &Metadata) -> bool {
    if actual.kind == FileKind::Folder && expected.kind == FileKind::Folder {
        // Directory listing timestamps can lag handle metadata. A folder's identity stays
        // bound; the complete child manifest and file hashes guard original recycling.
        actual.created_ns == expected.created_ns
            && actual.file_id == expected.file_id
            && actual.presence == expected.presence
    } else {
        actual == expected
    }
}

#[cfg(windows)]
fn source_fs(root: &Path) -> Result<Arc<dyn FileSystem>, OperationError> {
    Ok(Arc::new(
        crate::win::WindowsFileSystem::open(root).map_err(|error| io_at(root, error))?,
    ))
}

#[cfg(not(windows))]
fn source_fs(_root: &Path) -> Result<Arc<dyn FileSystem>, OperationError> {
    Ok(Arc::new(crate::fs::StdFileSystem))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Conflict {
    Replace,
    KeepBoth,
    Skip,
}

#[derive(Debug, Clone)]
pub struct Request {
    pub sources: Vec<Source>,
    pub target: EntryRef,
    pub tags: BTreeSet<TagId>,
    pub on_conflict: Conflict,
    pub delete_originals: bool,
}

#[derive(Debug, Default)]
pub struct Check {
    pub files: u32,
    pub folders: u32,
    pub bytes: u64,
    pub skipped: u32,
    pub conflicts: Vec<String>,
    pub conflict_count: u32,
}

#[derive(Debug, Default)]
pub struct Report {
    /// Successful files, including the replaced and renamed subsets; folders do not count.
    pub imported: u32,
    pub replaced: u32,
    pub renamed: u32,
    pub skipped: u32,
    pub originals_deleted: u32,
    pub failures: Vec<(String, OperationError)>,
    pub failure_count: u32,
    /// Reconciliation cannot depend on the capped failure details sent to the shell.
    pub needs_reconciliation: bool,
    pub cancelled: bool,
}

impl Report {
    fn fail(&mut self, name: String, error: OperationError) {
        self.failure_count = self.failure_count.saturating_add(1);
        self.needs_reconciliation |= matches!(
            error,
            OperationError::DiskChanged { .. } | OperationError::RecoveryRequired { .. }
        );
        if self.failures.len() < RESULTS {
            self.failures.push((name, error));
        }
    }
}

#[derive(Debug, Clone, Default)]
pub struct Progress {
    pub done: u32,
    pub total: u32,
    pub bytes: u64,
    pub total_bytes: u64,
    pub current: String,
}

#[derive(Debug)]
struct Item {
    source: usize,
    native: PathBuf,
    tail: RelPath,
    metadata: Metadata,
}

#[derive(Default)]
struct Plan {
    items: Vec<Item>,
    skipped: u32,
    failures: Vec<(usize, String, OperationError)>,
    retained: Vec<bool>,
}

struct Pending {
    source: usize,
    native: PathBuf,
    tail: RelPath,
    metadata: Metadata,
    rules: Gitignores,
}

struct Copied {
    source: usize,
    native: PathBuf,
    metadata: Metadata,
    destination: RelPath,
    hash: ContentHash,
}

struct Occupied {
    /// None when a non-NFC spelling or multiple twins make replacing/merging ambiguous.
    path: Option<RelPath>,
    metadata: Metadata,
}

impl Library {
    /// Cheap validation for enqueueing and job start; no source directory walk or disk writes.
    pub fn validate_import(
        &self,
        catalog: &Catalog,
        request: &Request,
    ) -> Result<(), OperationError> {
        self.validate_import_sources(catalog, &request.sources, &request.target)?;
        state::validate_metadata(self.root())?;
        if !request.tags.is_empty() {
            let tree = MetaTree::read(&self.layout)?;
            if tree.is_read_only() {
                return Err(OperationError::ReadOnly);
            }
            let definitions = self
                .layout
                .read_tags()?
                .ok_or(OperationError::InvalidArgument(
                    "tag definitions are missing",
                ))?;
            if request
                .tags
                .iter()
                .any(|id| !definitions.tags.contains_key(id))
            {
                return Err(OperationError::InvalidArgument("undefined import tag"));
            }
        }
        Ok(())
    }

    fn validate_import_sources(
        &self,
        catalog: &Catalog,
        sources: &[Source],
        target: &EntryRef,
    ) -> Result<(), OperationError> {
        if sources.is_empty() || sources.len() > MAX_BATCH {
            return Err(OperationError::InvalidArgument("invalid source count"));
        }
        catalog.read_stamped(|tx, _| {
            let target = folder(tx, target)?;
            if target.record.path.depth() < 2 {
                return Err(OperationError::InvalidArgument(
                    "target is not inside a course",
                ));
            }
            self.entry_disk(&target)?;
            Ok::<_, OperationError>(())
        })?;
        let root = fs::canonicalize(self.root()).map_err(|error| io_at(self.root(), error))?;
        // ponytail: selected-source overlap checks are quadratic up to MAX_BATCH; sort path
        // keys if profiling large selections warrants the extra normalization machinery.
        for (index, source) in sources.iter().enumerate() {
            source.validate()?;
            if native_below(&source.path, &root) || native_below(&root, &source.path) {
                return Err(OperationError::InvalidArgument(
                    "source overlaps the library",
                ));
            }
            if sources[..index].iter().any(|other| {
                native_below(&source.path, &other.path) || native_below(&other.path, &source.path)
            }) {
                return Err(OperationError::InvalidArgument("import sources overlap"));
            }
        }
        Ok(())
    }

    pub fn check_import(
        &self,
        catalog: &Catalog,
        sources: &[Source],
        target: &EntryRef,
    ) -> Result<Check, OperationError> {
        self.validate_import_sources(catalog, sources, target)?;
        let plan = self.import_plan(sources, &target.path, &AtomicBool::new(false))?;
        if let Some((_, _, error)) = plan.failures.into_iter().next() {
            return Err(error);
        }
        let mut check = Check {
            skipped: plan.skipped,
            ..Check::default()
        };
        let mut wanted = HashMap::<PathKey, EntryKind>::new();
        let mut folders = BTreeMap::<RelPath, RelPath>::new();
        for item in plan.items {
            let parent = item
                .tail
                .parent()
                .and_then(|parent| folders.get(&parent))
                .unwrap_or(&target.path);
            let mut path = parent.join(&RelPath::parse(item.tail.name())?)?;
            let disk = self.import_collision(&path)?;
            if item.metadata.kind == FileKind::Folder {
                check.folders = increment(check.folders)?;
                path = match disk {
                    Some(entry) if entry.metadata.kind == FileKind::Folder => match entry.path {
                        Some(path) => path,
                        None => self.import_free_name_avoiding(&path, &wanted)?,
                    },
                    None if wanted.get(&path.key()) != Some(&EntryKind::File) => path,
                    _ => self.import_free_name_avoiding(&path, &wanted)?,
                };
                folders.insert(item.tail, path.clone());
                wanted.insert(path.key(), EntryKind::Folder);
            } else {
                check.files = increment(check.files)?;
                check.bytes = check
                    .bytes
                    .checked_add(item.metadata.size)
                    .ok_or(OperationError::InvalidArgument("import size overflow"))?;
                if disk
                    .as_ref()
                    .is_some_and(|entry| entry.metadata.kind == FileKind::File)
                    || wanted.get(&path.key()) == Some(&EntryKind::File)
                {
                    check.conflict_count = increment(check.conflict_count)?;
                    if check.conflicts.len() < RESULTS {
                        check.conflicts.push(
                            disk.and_then(|entry| entry.path)
                                .unwrap_or(path.clone())
                                .to_string(),
                        );
                    }
                } else if disk.is_some() || wanted.get(&path.key()) == Some(&EntryKind::Folder) {
                    path = self.import_free_name_avoiding(&path, &wanted)?;
                }
                wanted.insert(path.key(), EntryKind::File);
            }
        }
        Ok(check)
    }

    #[expect(
        clippy::too_many_arguments,
        reason = "the existing blocking job supplies cancellation, progress and committed reports"
    )]
    pub fn import_files(
        &self,
        catalog: &Catalog,
        request: &Request,
        bin: &dyn RecycleBin,
        now_ns: i64,
        cancel: &AtomicBool,
        progress: &mut dyn FnMut(Progress),
        on_commit: &mut dyn FnMut(CommittedScan),
    ) -> Result<Report, OperationError> {
        on_commit(self.recover_pending(catalog)?);
        self.validate_import(catalog, request)?;
        let plan = self.import_plan(&request.sources, &request.target.path, cancel)?;
        let mut report = Report {
            skipped: plan.skipped,
            cancelled: cancel.load(Ordering::Relaxed),
            ..Report::default()
        };
        let mut retained = plan.retained;
        for (source, name, error) in plan.failures {
            retained[source] = true;
            report.fail(name, error);
        }
        let mut state = Progress {
            total: u32::try_from(
                plan.items
                    .iter()
                    .filter(|item| item.metadata.kind == FileKind::File)
                    .count(),
            )
            .map_err(|_| OperationError::InvalidArgument("too many import files"))?,
            total_bytes: plan
                .items
                .iter()
                .filter(|item| item.metadata.kind == FileKind::File)
                .try_fold(0u64, |sum, item| sum.checked_add(item.metadata.size))
                .ok_or(OperationError::InvalidArgument("import size overflow"))?,
            ..Progress::default()
        };
        progress(state.clone());
        // Bytes of finished files, whatever their outcome; a copy adds its partial bytes on top.
        let mut finished_bytes = 0u64;
        let mut folders = BTreeMap::<RelPath, RelPath>::new();
        let mut top_created = vec![false; request.sources.len()];
        let mut blocked = BTreeSet::<(usize, RelPath)>::new();
        let mut copied = Vec::new();
        for item in &plan.items {
            if cancel.load(Ordering::Relaxed) {
                report.cancelled = true;
                break;
            }
            state.current = item.tail.to_string();
            if item
                .tail
                .ancestors()
                .any(|path| blocked.contains(&(item.source, path)))
            {
                retained[item.source] = true;
                if item.metadata.kind == FileKind::File {
                    finished_bytes = finish_file(&mut state, finished_bytes, &item.metadata)?;
                    progress(state.clone());
                }
                continue;
            }
            let parent = item
                .tail
                .parent()
                .and_then(|parent| folders.get(&parent))
                .unwrap_or(&request.target.path);
            let path = parent.join(&RelPath::parse(item.tail.name())?)?;
            let result = (|| {
                request.sources[item.source].inspect(&item.native, &item.metadata)?;
                self.validate_import_target(catalog, &request.target)?;
                if item.metadata.kind == FileKind::Folder {
                    let (destination, created) =
                        self.import_folder(catalog, &path, now_ns, on_commit)?;
                    folders.insert(item.tail.clone(), destination.clone());
                    if item.tail.depth() == 1 {
                        top_created[item.source] = created;
                        if created {
                            self.import_tags(catalog, &destination, &request.tags, on_commit)?;
                        }
                    }
                    return Ok(());
                }
                let collision = self.import_collision(&path)?;
                let mut replaced = false;
                let mut renamed = false;
                let mut destination = path.clone();
                let old = match collision {
                    Some(entry)
                        if entry.metadata.kind == FileKind::File
                            && request.on_conflict == Conflict::Skip =>
                    {
                        report.skipped = increment(report.skipped)?;
                        retained[item.source] = true;
                        return Ok(());
                    }
                    Some(entry)
                        if entry.metadata.kind == FileKind::File
                            && request.on_conflict == Conflict::Replace =>
                    {
                        destination = entry.path.ok_or(OperationError::AlreadyExists)?;
                        replaced = true;
                        Some(entry.metadata)
                    }
                    Some(_) => {
                        destination = self.import_free_name(&path)?;
                        renamed = true;
                        None
                    }
                    None => None,
                };
                let tags = if top_created[item.source] {
                    BTreeSet::new()
                } else {
                    request.tags.clone()
                };
                let Some(hash) = self.copy_import_file(
                    catalog,
                    &request.sources[item.source],
                    item,
                    &destination,
                    old.as_ref(),
                    &tags,
                    bin,
                    now_ns,
                    cancel,
                    &mut state,
                    progress,
                    on_commit,
                )?
                else {
                    report.cancelled = true;
                    return Ok(());
                };
                report.imported = increment(report.imported)?;
                report.replaced += u32::from(replaced);
                report.renamed += u32::from(renamed);
                if request.delete_originals {
                    copied.push(Copied {
                        source: item.source,
                        native: item.native.clone(),
                        metadata: item.metadata.clone(),
                        destination,
                        hash,
                    });
                }
                Ok::<_, OperationError>(())
            })();
            match result {
                Ok(()) => {}
                Err(error) if super::recovery_required(&error) => return Err(error),
                Err(error) => {
                    retained[item.source] = true;
                    if item.metadata.kind == FileKind::Folder {
                        blocked.insert((item.source, item.tail.clone()));
                    }
                    report.fail(item.tail.to_string(), error);
                }
            }
            if item.metadata.kind == FileKind::File {
                finished_bytes = finish_file(&mut state, finished_bytes, &item.metadata)?;
            }
            progress(state.clone());
            if report.cancelled {
                break;
            }
        }
        if request.delete_originals && !report.cancelled {
            for (index, source) in request.sources.iter().enumerate() {
                if cancel.load(Ordering::Relaxed) {
                    report.cancelled = true;
                    break;
                }
                if retained[index] {
                    report.fail(
                        source.name.clone(),
                        OperationError::InvalidArgument(
                            "original retained: some items were skipped or failed",
                        ),
                    );
                    continue;
                }
                let result = self
                    .verify_import_source(source, index, &plan.items, &copied, cancel)
                    .and_then(|_| {
                        if cancel.load(Ordering::Relaxed) {
                            return Err(OperationError::InvalidArgument(
                                "original retained: import cancelled",
                            ));
                        }
                        // ponytail: pathname checks exclude existing links, not a concurrent local
                        // ancestor replacement; pin handles if that OS sandbox becomes a requirement.
                        bin.recycle(&source.path).map_err(OperationError::from)
                    });
                match result {
                    // The Recycle Bin or, for a file only in the cloud, its provider's trash.
                    Ok(_) => report.originals_deleted = increment(report.originals_deleted)?,
                    Err(error) => {
                        // Report even a failure that raced a cancel: the original may be partly
                        // in the Recycle Bin.
                        report.fail(source.name.clone(), error);
                        if cancel.load(Ordering::Relaxed) {
                            report.cancelled = true;
                            break;
                        }
                    }
                }
            }
        }
        report.cancelled |= cancel.load(Ordering::Relaxed);
        Ok(report)
    }

    fn validate_import_target(
        &self,
        catalog: &Catalog,
        target: &EntryRef,
    ) -> Result<(), OperationError> {
        catalog.read_stamped(|tx, _| {
            let entry = folder(tx, target)?;
            self.entry_disk(&entry)?;
            Ok(())
        })
    }

    fn import_folder(
        &self,
        catalog: &Catalog,
        path: &RelPath,
        now_ns: i64,
        on_commit: &mut dyn FnMut(CommittedScan),
    ) -> Result<(RelPath, bool), OperationError> {
        if let Some(collision) = self.import_collision(path)? {
            if collision.metadata.kind == FileKind::Folder
                && let Some(path) = collision.path
            {
                return Ok((path, false));
            }
            let free = self.import_free_name(path)?;
            return self.import_folder(catalog, &free, now_ns, on_commit);
        }
        let parent = path.parent().ok_or(OperationError::InvalidArgument(
            "import has no course parent",
        ))?;
        let entry = catalog
            .read(|tx| catalog::entry(tx, &parent))?
            .ok_or(OperationError::NotFound)?;
        let outcome = self.create_folder(catalog, &EntryRef::from(&entry), path.name(), now_ns)?;
        on_commit(outcome.committed);
        Ok((outcome.value.record.path, true))
    }

    fn import_tags(
        &self,
        catalog: &Catalog,
        path: &RelPath,
        tags: &BTreeSet<TagId>,
        on_commit: &mut dyn FnMut(CommittedScan),
    ) -> Result<(), OperationError> {
        if tags.is_empty() {
            return Ok(());
        }
        let entry = catalog
            .read(|tx| catalog::entry(tx, path))?
            .ok_or(OperationError::NotFound)?;
        let outcome =
            self.set_entry_tags(catalog, &[EntryRef::from(&entry)], tags, &BTreeSet::new())?;
        on_commit(outcome.committed);
        if let Some((_, error)) = outcome.value.failures.into_iter().next() {
            return Err(error);
        }
        Ok(())
    }

    fn import_collision(&self, path: &RelPath) -> Result<Option<Occupied>, OperationError> {
        self.native_length(path)?;
        let parent = path.parent().ok_or(OperationError::InvalidArgument(
            "import target has no parent",
        ))?;
        match self.disk_path(&parent, EntryKind::Folder) {
            Ok(_) => {}
            Err(OperationError::NotFound) => return Ok(None),
            Err(error) => return Err(error),
        }
        let native = parent.to_native(self.root());
        let mut found: Option<Occupied> = None;
        for candidate in self
            .fs
            .read_dir(&native)
            .map_err(|error| io_at(&native, error))?
        {
            let Some(name) = candidate.name.to_str() else {
                continue;
            };
            let normalized: String = name.nfc().collect();
            if same_name(&normalized, path.name()) {
                let spelling = RelPath::parse(name)
                    .and_then(|tail| parent.join(&tail))
                    .ok();
                if let Some(existing) = &mut found {
                    existing.path = None;
                } else {
                    found = Some(Occupied {
                        path: spelling,
                        metadata: candidate.metadata,
                    });
                }
            }
        }
        Ok(found)
    }

    fn import_free_name(&self, path: &RelPath) -> Result<RelPath, OperationError> {
        self.import_free_name_avoiding(path, &HashMap::new())
    }

    fn import_free_name_avoiding(
        &self,
        path: &RelPath,
        wanted: &HashMap<PathKey, EntryKind>,
    ) -> Result<RelPath, OperationError> {
        let parent = path
            .parent()
            .ok_or(OperationError::InvalidArgument("import has no parent"))?;
        let (stem, extension) = match path.name().rsplit_once('.') {
            Some((stem, ext)) if !stem.is_empty() => (stem, format!(".{ext}")),
            _ => (path.name(), String::new()),
        };
        for number in 2..=u32::MAX {
            let tail = RelPath::parse(&format!("{stem} ({number}){extension}"))?;
            let candidate = parent.join(&tail)?;
            if !wanted.contains_key(&candidate.key())
                && self.import_collision(&candidate)?.is_none()
            {
                return Ok(candidate);
            }
        }
        Err(OperationError::AlreadyExists)
    }

    fn import_plan(
        &self,
        sources: &[Source],
        target: &RelPath,
        cancel: &AtomicBool,
    ) -> Result<Plan, OperationError> {
        state::validate_metadata(self.root())?;
        let mut problems = Vec::new();
        let rules = Rules::load(&self.layout, &mut problems)?;
        let mut inherited = Gitignores::default();
        let mut ancestors: Vec<_> = target.ancestors().collect();
        ancestors.reverse();
        for path in std::iter::once(None).chain(ancestors.iter().map(Some)) {
            let native = path.map_or_else(
                || self.root().to_owned(),
                |path| path.to_native(self.root()),
            );
            inherited =
                import_gitignore(&rules, &inherited, path, &native, &*self.fs, &mut problems)?;
        }
        let mut plan = Plan {
            retained: vec![false; sources.len()],
            ..Plan::default()
        };
        let mut queue = Vec::new();
        for (index, source) in sources.iter().enumerate().rev() {
            let normalized: String = source.name.nfc().collect();
            match RelPath::parse(&normalized) {
                Ok(tail) => queue.push(Pending {
                    source: index,
                    native: source.path.clone(),
                    tail,
                    metadata: source.selected.clone(),
                    rules: inherited.clone(),
                }),
                Err(error) => {
                    plan.retained[index] = true;
                    plan.failures
                        .push((index, source.name.clone(), error.into()));
                }
            }
        }
        while let Some(pending) = queue.pop() {
            if cancel.load(Ordering::Relaxed) {
                break;
            }
            let is_folder = pending.metadata.kind == FileKind::Folder;
            let path = target.join(&pending.tail)?;
            let verdict = rules.verdict(&pending.rules, path.as_str(), is_folder);
            if is_always_ignored(pending.tail.name())
                || verdict == Verdict::Ignored
                || matches!(pending.metadata.kind, FileKind::Link | FileKind::Other)
            {
                plan.skipped = increment(plan.skipped)?;
                plan.retained[pending.source] = true;
                continue;
            }
            let source = &sources[pending.source];
            if let Err(error) = source.inspect(&pending.native, &pending.metadata) {
                plan.retained[pending.source] = true;
                plan.failures
                    .push((pending.source, pending.tail.to_string(), error));
                continue;
            }
            if is_folder {
                let mut listing = match source.fs.read_dir(&pending.native) {
                    Ok(listing) => listing,
                    Err(error) => {
                        plan.retained[pending.source] = true;
                        plan.failures.push((
                            pending.source,
                            pending.tail.to_string(),
                            io_at(&pending.native, error),
                        ));
                        continue;
                    }
                };
                if verdict == Verdict::Unmatched
                    && listing.iter().any(|entry| {
                        entry.metadata.kind == FileKind::File
                            && entry
                                .name
                                .to_str()
                                .is_some_and(|name| same_name(name, VENV_MARKER))
                    })
                {
                    plan.skipped = increment(plan.skipped)?;
                    plan.retained[pending.source] = true;
                    continue;
                }
                let child_rules = match import_gitignore(
                    &rules,
                    &pending.rules,
                    Some(&path),
                    &pending.native,
                    &*source.fs,
                    &mut problems,
                ) {
                    Ok(child_rules) => child_rules,
                    Err(error) => {
                        plan.retained[pending.source] = true;
                        plan.failures
                            .push((pending.source, pending.tail.to_string(), error));
                        continue;
                    }
                };
                listing.sort_by(|a, b| a.name.cmp(&b.name));
                for child in listing.into_iter().rev() {
                    let Some(name) = child.name.to_str() else {
                        plan.retained[pending.source] = true;
                        plan.failures.push((
                            pending.source,
                            pending.tail.to_string(),
                            OperationError::InvalidArgument("source name is not Unicode"),
                        ));
                        continue;
                    };
                    let normalized: String = name.nfc().collect();
                    match RelPath::parse(&normalized).and_then(|tail| pending.tail.join(&tail)) {
                        Ok(tail) => queue.push(Pending {
                            source: pending.source,
                            native: pending.native.join(&child.name),
                            tail,
                            metadata: child.metadata,
                            rules: child_rules.clone(),
                        }),
                        Err(error) => {
                            plan.retained[pending.source] = true;
                            plan.failures.push((
                                pending.source,
                                format!("{}/{}", pending.tail, name),
                                error.into(),
                            ));
                        }
                    }
                }
            }
            plan.items.push(Item {
                source: pending.source,
                native: pending.native,
                tail: pending.tail,
                metadata: pending.metadata,
            });
        }
        Ok(plan)
    }

    #[expect(
        clippy::too_many_arguments,
        reason = "one copy uses the job's existing progress and commit callbacks"
    )]
    fn copy_import_file(
        &self,
        catalog: &Catalog,
        source: &Source,
        item: &Item,
        destination: &RelPath,
        old: Option<&Metadata>,
        tags: &BTreeSet<TagId>,
        bin: &dyn RecycleBin,
        now_ns: i64,
        cancel: &AtomicBool,
        state: &mut Progress,
        progress: &mut dyn FnMut(Progress),
        on_commit: &mut dyn FnMut(CommittedScan),
    ) -> Result<Option<ContentHash>, OperationError> {
        state::validate_metadata(self.root())?;
        self.native_length(destination)?;
        let staging = self.layout.staging_dir();
        fs::create_dir_all(&staging).map_err(|error| io_at(&staging, error))?;
        let stage = staging.join(format!("import-{}.part", LibraryId::generate()?.as_str()));
        let result = (|| {
            source.inspect(&item.native, &item.metadata)?;
            let limit = item
                .metadata
                .size
                .checked_add(1)
                .ok_or(OperationError::InvalidArgument("import size overflow"))?;
            let mut reader = source
                .fs
                .open(&item.native)
                .map_err(|error| io_at(&item.native, error))?
                .take(limit);
            let mut file = File::create_new(&stage).map_err(|error| io_at(&stage, error))?;
            let Some((count, hash)) = copy_bytes(&mut reader, &mut file, cancel, state, progress)
                .map_err(|error| io_at(&stage, error))?
            else {
                return Ok(None);
            };
            file.sync_all().map_err(|error| io_at(&stage, error))?;
            drop(file);
            source.inspect(&item.native, &item.metadata)?;
            if count != item.metadata.size {
                return Err(changed_source(&item.native));
            }
            let mut buffer = Vec::new();
            let verified = ContentHash::read(
                File::open(&stage).map_err(|error| io_at(&stage, error))?,
                cancel,
                &mut buffer,
            )
            .map_err(|error| io_at(&stage, error))?;
            if verified.is_none() {
                return Ok(None);
            }
            if verified.as_ref() != Some(&hash) {
                return Err(changed_source(&stage));
            }
            if cancel.load(Ordering::Relaxed) {
                return Ok(None);
            }
            // Finish an ordinary metadata journal before claiming the separate import intent.
            catalog.with_writer(|tx| -> Result<(), OperationError> {
                self.read_meta(tx)?;
                Ok(())
            })?;
            let intent = journal::Intent::new(self, &stage, destination, &hash, old, tags, now_ns)?;
            intent.write(self)?;
            if let Some(old) = old {
                // Nothing was recycled yet: a changed old file fails only this item.
                let current = self.disk_path(destination, EntryKind::File);
                // Report the cause, not a failed abandon: an intent left behind turns the
                // cause into a recovery error below, and recovery settles that intent.
                if current.as_ref().ok() != Some(old) {
                    let _ = intent.abandon(self);
                    return Err(current
                        .err()
                        .unwrap_or_else(|| changed_source(&destination.to_native(self.root()))));
                }
                if let Err(error) = bin.recycle(&destination.to_native(self.root())) {
                    let _ = intent.abandon(self);
                    return Err(error.into());
                }
            }
            // No cancellation once the intent is durable: finish publication and its tags.
            let (committed, abandoned) = self
                .settle_import(catalog)
                .map_err(|error| OperationError::recovery(error.into()))?;
            on_commit(committed);
            if abandoned {
                let error = changed_source(&destination.to_native(self.root()));
                // The recycled old file left the catalog stale: ask the shell for a full scan.
                return Err(if old.is_some() {
                    OperationError::DiskChanged {
                        path: destination.clone(),
                        source: Box::new(error),
                    }
                } else {
                    error
                });
            }
            Ok(Some(hash))
        })();
        // A pending intent owns its verified bytes. Never remove them after a failed publish.
        if journal::path(self)
            .try_exists()
            .map_err(|error| io_at(&journal::path(self), error))?
        {
            return result.map_err(OperationError::recovery);
        }
        let cleanup = match stage.try_exists() {
            Ok(true) => fs::remove_file(&stage),
            Ok(false) => Ok(()),
            Err(error) => Err(error),
        }
        .map_err(|error| io_at(&stage, error));
        // The copy's own failure is the one to report; a stage left behind is Folio's own
        // temporary file and only matters when it is the sole failure.
        result.and_then(|hash| cleanup.map(|()| hash))
    }

    fn verify_import_source(
        &self,
        source: &Source,
        index: usize,
        items: &[Item],
        copied: &[Copied],
        cancel: &AtomicBool,
    ) -> Result<(), OperationError> {
        self.verify_import_manifest(source, index, items, cancel)?;
        let mut buffer = Vec::new();
        for file in copied.iter().filter(|file| file.source == index) {
            source.inspect(&file.native, &file.metadata)?;
            let hash = source
                .fs
                .open(&file.native)
                .and_then(|reader| ContentHash::read(reader, cancel, &mut buffer))
                .map_err(|error| io_at(&file.native, error))?;
            if hash.as_ref() != Some(&file.hash) {
                return Err(changed_source(&file.native));
            }
            source.inspect(&file.native, &file.metadata)?;
            let native = file.destination.to_native(self.root());
            let metadata = self.disk_path(&file.destination, EntryKind::File)?;
            if metadata.presence != Presence::Local {
                return Err(OperationError::NotLocal { path: native });
            }
            let hash = self
                .fs
                .open(&native)
                .and_then(|reader| ContentHash::read(reader, cancel, &mut buffer))
                .map_err(|error| io_at(&native, error))?;
            if hash.as_ref() != Some(&file.hash)
                || self.disk_path(&file.destination, EntryKind::File)? != metadata
            {
                return Err(changed_source(&native));
            }
        }
        // Rewalk after hashing: a nested arrival need not change the selected root's mtime.
        self.verify_import_manifest(source, index, items, cancel)
    }

    fn verify_import_manifest(
        &self,
        source: &Source,
        index: usize,
        items: &[Item],
        cancel: &AtomicBool,
    ) -> Result<(), OperationError> {
        source.validate()?;
        let mut expected = BTreeMap::new();
        for item in items.iter().filter(|item| item.source == index) {
            expected.insert(item.native.clone(), &item.metadata);
        }
        let mut queue = vec![source.path.clone()];
        let mut seen = BTreeSet::new();
        while let Some(path) = queue.pop() {
            if cancel.load(Ordering::Relaxed) {
                return Err(changed_source(&source.path));
            }
            let metadata = expected.get(&path).ok_or_else(|| changed_source(&path))?;
            source.inspect(&path, metadata)?;
            seen.insert(path.clone());
            if metadata.kind == FileKind::Folder {
                for child in source
                    .fs
                    .read_dir(&path)
                    .map_err(|error| io_at(&path, error))?
                {
                    queue.push(path.join(child.name));
                }
            }
        }
        if seen.len() != expected.len() {
            return Err(changed_source(&source.path));
        }
        source.validate()
    }
}

fn import_gitignore(
    rules: &Rules,
    inherited: &Gitignores,
    folder: Option<&RelPath>,
    native: &Path,
    fs: &dyn FileSystem,
    problems: &mut Vec<crate::library::Problem>,
) -> Result<Gitignores, OperationError> {
    let listing = fs.read_dir(native).map_err(|error| io_at(native, error))?;
    let Some(file) = listing.iter().find(|entry| {
        entry.metadata.kind == FileKind::File
            && entry
                .name
                .to_str()
                .is_some_and(|name| same_name(name, GITIGNORE))
    }) else {
        return Ok(inherited.clone());
    };
    if file.metadata.presence != Presence::Local {
        return Err(OperationError::NotLocal {
            path: native.join(&file.name),
        });
    }
    let path = RelPath::parse(file.name.to_str().ok_or(OperationError::InvalidArgument(
        "ignore name is not Unicode",
    ))?)?
    .below(folder)?;
    let text = fs
        .open(&native.join(&file.name))
        .and_then(read_rules)
        .map_err(|error| io_at(&native.join(&file.name), error))?
        .ok_or(OperationError::InvalidArgument("ignore file is too large"))?;
    Ok(rules.with_gitignore(inherited, folder, &path, &text, problems))
}

fn native_below(path: &Path, ancestor: &Path) -> bool {
    let mut parts = path.components();
    ancestor.components().all(|part| {
        parts.next().is_some_and(|candidate| {
            same_name(
                &candidate.as_os_str().to_string_lossy(),
                &part.as_os_str().to_string_lossy(),
            )
        })
    })
}

/// Counts a file as done, skipped and failed ones included, so byte progress reaches the total.
fn finish_file(
    state: &mut Progress,
    finished: u64,
    file: &Metadata,
) -> Result<u64, OperationError> {
    state.done = increment(state.done)?;
    let finished = finished.saturating_add(file.size);
    state.bytes = finished;
    Ok(finished)
}

fn increment(value: u32) -> Result<u32, OperationError> {
    value
        .checked_add(1)
        .ok_or(OperationError::InvalidArgument("import count overflow"))
}

/// The only streaming copy loop; a failing writer is tested before any intent or recycle call.
fn copy_bytes(
    reader: &mut dyn Read,
    writer: &mut dyn Write,
    cancel: &AtomicBool,
    state: &mut Progress,
    progress: &mut dyn FnMut(Progress),
) -> io::Result<Option<(u64, ContentHash)>> {
    let mut buffer = vec![0; COPY_CHUNK];
    let mut hasher = blake3::Hasher::new();
    let mut count = 0u64;
    loop {
        if cancel.load(Ordering::Relaxed) {
            return Ok(None);
        }
        let read = match reader.read(&mut buffer) {
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            result => result?,
        };
        if read == 0 {
            break;
        }
        writer.write_all(&buffer[..read])?;
        hasher.update(&buffer[..read]);
        count = count
            .checked_add(read as u64)
            .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "file size overflow"))?;
        state.bytes = state.bytes.saturating_add(read as u64);
        progress(state.clone());
    }
    let hash = ContentHash::parse(&format!("b3:{}", hasher.finalize().to_hex()))
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
    Ok(Some((count, hash)))
}

fn changed_source(path: &Path) -> OperationError {
    io_at(
        path,
        io::Error::new(
            io::ErrorKind::InvalidData,
            "file identity or content changed during import",
        ),
    )
}

fn io_at(path: &Path, source: io::Error) -> OperationError {
    if source.kind() == io::ErrorKind::NotFound {
        OperationError::NotFound
    } else if files::is_in_use(&source) {
        OperationError::InUse {
            path: path.to_owned(),
        }
    } else {
        OperationError::Io {
            path: path.to_owned(),
            source,
        }
    }
}

#[cfg(all(test, windows))]
#[path = "import/tests.rs"]
mod tests;
