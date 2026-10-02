//! Shell-owned, kind-bound choices and import job conversion (ipc-m1 §4.2, §12).

use std::collections::BTreeSet;
use std::path::PathBuf;
use std::time::Instant;

use folio_core::library::operations::import as core;
use folio_core::meta::TagId;

use super::operations::{operation_error, reference};
use super::{CHOICE_TTL, Event, LibraryState, MAX_CHOICES, lock};
use crate::error::AppError;
use crate::ipc::events::{DropHover, FilesDropped};
use crate::ipc::import::{
    CheckImport, ConflictPolicy, ImportCheck, ImportConflict, ImportFailure, ImportFiles,
    ImportName, ImportResult, ImportSource,
};
use crate::ipc::types::{LIMITS, Point};

#[derive(Clone)]
pub(super) struct Choice {
    sources: Vec<core::Source>,
    chosen: Instant,
}

impl LibraryState {
    /// Called only by the native dialog or native drop handler; no IPC payload supplies paths.
    pub fn choose_import(&self, paths: Vec<PathBuf>) -> Result<ImportSource, AppError> {
        self.accepting()?;
        if paths.is_empty() || paths.len() > LIMITS.batch as usize {
            return Err(AppError::InvalidArgument(
                "invalid import selection size".into(),
            ));
        }
        let sources = core::Source::select_all(paths).map_err(operation_error)?;
        let mut files = 0;
        let mut folders = 0;
        for source in &sources {
            match source.kind() {
                folio_core::meta::EntryKind::File => files += 1,
                folio_core::meta::EntryKind::Folder => folders += 1,
            }
        }
        let names = sources
            .iter()
            .take(10)
            .map(|source| ImportName {
                name: source.name().to_owned(),
                kind: source.kind().into(),
            })
            .collect();
        let _transition = lock(&self.0.transition);
        self.accepting()?;
        let mut choices = lock(&self.0.import_choices);
        choices.retain(|_, choice| choice.chosen.elapsed() < CHOICE_TTL);
        if choices.len() >= MAX_CHOICES
            && let Some(oldest) = choices
                .iter()
                .min_by_key(|(_, choice)| choice.chosen)
                .map(|(token, _)| token.clone())
        {
            choices.remove(&oldest);
        }
        let token = crate::jobs::id()?;
        choices.insert(
            token.clone(),
            Choice {
                sources,
                chosen: Instant::now(),
            },
        );
        Ok(ImportSource {
            token,
            files,
            folders,
            names,
        })
    }

    fn import_choice(&self, token: &str) -> Result<Choice, AppError> {
        lock(&self.0.import_choices)
            .get(token)
            .filter(|choice| choice.chosen.elapsed() < CHOICE_TTL)
            .cloned()
            .ok_or_else(|| AppError::ChoiceExpired("choose or drop the files again".into()))
    }

    pub fn check_import(&self, request: CheckImport) -> Result<ImportCheck, AppError> {
        let target = reference(&request.target)?;
        self.with_reads(|session| {
            let choice = self.import_choice(&request.source)?;
            session.read_operation(|library, catalog| {
                library.check_import(catalog, &choice.sources, &target)
            })
        })
        .map(|check| ImportCheck {
            files: check.files,
            folders: check.folders,
            bytes: check.bytes.to_string(),
            skipped: check.skipped,
            conflicts: check
                .conflicts
                .into_iter()
                .map(|path| ImportConflict { path })
                .collect(),
            conflict_count: check.conflict_count,
        })
    }

    pub fn import_files(&self, request: ImportFiles) -> Result<String, AppError> {
        let target = reference(&request.target)?;
        if request.tags.len() > LIMITS.batch as usize {
            return Err(AppError::InvalidArgument("too many import tags".into()));
        }
        let tags = request
            .tags
            .iter()
            .map(|text| {
                TagId::parse(text).map_err(|error| AppError::InvalidArgument(error.to_string()))
            })
            .collect::<Result<BTreeSet<_>, _>>()?;
        let on_conflict = match request.on_conflict {
            ConflictPolicy::Replace => core::Conflict::Replace,
            ConflictPolicy::KeepBoth => core::Conflict::KeepBoth,
            ConflictPolicy::Skip => core::Conflict::Skip,
        };
        self.with_reads(|session| {
            // Preflight is read-only and cheap; it must not wait for an earlier import's
            // operation mutex. The transition serializes token use with library switches.
            let choice = self.import_choice(&request.source)?;
            let import = core::Request {
                sources: choice.sources,
                target,
                tags,
                on_conflict,
                delete_originals: request.delete_originals,
            };
            session.read_operation(|library, catalog| library.validate_import(catalog, &import))?;
            // The worker repeats validation under the operation mutex before copying.
            let queued = session.queue_import(import)?;
            lock(&self.0.import_choices).remove(&request.source);
            Ok(queued)
        })
    }

    pub(crate) fn drop_hover(&self, position: Option<Point>) {
        (self.0.emit)(Event::DropHover(DropHover { position }));
    }

    pub(crate) fn files_dropped(&self, paths: Vec<PathBuf>, position: Point) {
        match self.choose_import(paths) {
            Ok(source) => (self.0.emit)(Event::FilesDropped(FilesDropped { source, position })),
            Err(error) => (self.0.emit)(Event::Error(format!(
                "native import selection failed: {error}"
            ))),
        }
    }

    /// Only Tauri's Rust window callback calls this. Page-emitted events cannot grant paths.
    pub(crate) fn native_drop(&self, event: &tauri::DragDropEvent, scale: f64) {
        let point = |position: &tauri::PhysicalPosition<f64>| {
            let position = position.to_logical::<i32>(scale);
            Point {
                x: position.x,
                y: position.y,
            }
        };
        match event {
            tauri::DragDropEvent::Enter { position, .. }
            | tauri::DragDropEvent::Over { position } => self.drop_hover(Some(point(position))),
            tauri::DragDropEvent::Leave => self.drop_hover(None),
            tauri::DragDropEvent::Drop { paths, position } => {
                self.drop_hover(None);
                let (state, paths, position) = (self.clone(), paths.clone(), point(position));
                tauri::async_runtime::spawn_blocking(move || state.files_dropped(paths, position));
            }
            _ => {}
        }
    }
}

pub(super) fn result(report: core::Report) -> ImportResult {
    ImportResult {
        imported: report.imported,
        replaced: report.replaced,
        renamed: report.renamed,
        skipped: report.skipped,
        originals_deleted: report.originals_deleted,
        failure_count: report.failure_count,
        failures: report
            .failures
            .into_iter()
            .map(|(name, error)| ImportFailure {
                name,
                error: operation_error(error),
            })
            .collect(),
    }
}

#[cfg(test)]
#[path = "import_tests.rs"]
mod tests;
