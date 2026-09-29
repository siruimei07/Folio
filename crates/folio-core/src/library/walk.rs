//! Walking the library: what belongs in it (docs/specs/library-scan.md §4).

use std::borrow::Cow;
use std::collections::hash_map::Entry;
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

use unicode_normalization::{UnicodeNormalization, is_nfc};

use super::rules::{
    GITIGNORE, Gitignores, MAX_RULES_BYTES, Rules, VENV_MARKER, Verdict, is_always_ignored,
    read_rules,
};
use super::{LibraryError, Problem, ReadFailure};
use crate::fs::{DirEntry, FileKind, FileSystem, Metadata};
use crate::meta::is_folio_owned;
use crate::paths::{PathError, PathKey, RelPath, same_name};

/// What a walk found.
#[derive(Debug, Default)]
pub(super) struct Snapshot {
    /// Every file and folder in the walked scope that belongs in the library.
    pub entries: BTreeMap<RelPath, Metadata>,
    /// Folders that could not be listed: what is below them is unknown.
    pub unreadable: BTreeSet<RelPath>,
}

impl Snapshot {
    /// Whether `path` is below a folder that could not be listed.
    pub fn is_unknown(&self, path: &RelPath) -> bool {
        !self.unreadable.is_empty()
            && path
                .ancestors()
                .skip(1)
                .any(|folder| self.unreadable.contains(&folder))
    }
}

/// Walks the library at `root`, or only `scope` and what is below it. Fails only when the root
/// cannot be listed.
pub(super) fn walk(
    fs: &dyn FileSystem,
    root: &Path,
    rules: &Rules,
    scope: Option<&RelPath>,
    problems: &mut Vec<Problem>,
    cancel: &AtomicBool,
    progress: &mut dyn FnMut(u64),
) -> Result<Option<Snapshot>, LibraryError> {
    if cancel.load(Ordering::Relaxed) {
        return Ok(None);
    }
    let listing = fs.read_dir(root).map_err(|source| LibraryError::Root {
        path: root.to_owned(),
        source,
    })?;
    let mut walker = Walker {
        fs,
        rules,
        problems,
        snapshot: Snapshot::default(),
        queue: Vec::new(),
        cancel,
        progress,
        visited: 0,
    };
    let gitignores = walker.gitignores(None, root, &listing, &Gitignores::default());
    walker.children(None, root, listing, &gitignores, scope);
    while let Some(folder) = walker.queue.pop() {
        if cancel.load(Ordering::Relaxed) {
            return Ok(None);
        }
        walker.visit(folder);
    }
    Ok((!cancel.load(Ordering::Relaxed)).then_some(walker.snapshot))
}

struct Walker<'a> {
    fs: &'a dyn FileSystem,
    rules: &'a Rules,
    problems: &'a mut Vec<Problem>,
    snapshot: Snapshot,
    queue: Vec<Folder>,
    cancel: &'a AtomicBool,
    progress: &'a mut dyn FnMut(u64),
    visited: u64,
}

/// A folder to list.
struct Folder {
    path: RelPath,
    native: PathBuf,
    metadata: Metadata,
    gitignores: Gitignores,
    /// No rule named it, so it is left out if it turns out to be a virtual environment.
    venv_check: bool,
    /// The scope below it that the walk heads for; `None` inside the scope.
    toward: Option<RelPath>,
}

/// What becomes of one name in a listing.
enum Admission {
    Skip,
    NotNfc {
        name: String,
        nfc: String,
    },
    Keep {
        path: RelPath,
        metadata: Metadata,
        venv_check: bool,
    },
}

impl Walker<'_> {
    fn visit(&mut self, folder: Folder) {
        let listing = match self.fs.read_dir(&folder.native) {
            Ok(listing) => listing,
            Err(error) => {
                if folder.toward.is_none() {
                    self.snapshot
                        .entries
                        .insert(folder.path.clone(), folder.metadata);
                }
                self.problems
                    .push(Problem::unreadable(folder.path.clone(), &error));
                self.snapshot.unreadable.insert(folder.path);
                return;
            }
        };
        if folder.venv_check && contains_file(&listing, VENV_MARKER) {
            return;
        }
        if folder.toward.is_none() {
            self.snapshot
                .entries
                .insert(folder.path.clone(), folder.metadata);
        }
        let gitignores = self.gitignores(
            Some(&folder.path),
            &folder.native,
            &listing,
            &folder.gitignores,
        );
        self.children(
            Some(&folder.path),
            &folder.native,
            listing,
            &gitignores,
            folder.toward.as_ref(),
        );
    }

    /// Admits the entries of a listing. On the way to a scope, only the next name toward it.
    fn children(
        &mut self,
        folder: Option<&RelPath>,
        native: &Path,
        listing: Vec<DirEntry>,
        gitignores: &Gitignores,
        toward: Option<&RelPath>,
    ) {
        let next = toward.and_then(|scope| scope.names().nth(folder.map_or(0, RelPath::depth)));
        let mut kept = Vec::new();
        let mut not_nfc = Vec::new();
        for entry in listing {
            if self.cancel.load(Ordering::Relaxed) {
                return;
            }
            if next.is_some_and(|next| entry.name != next) {
                continue;
            }
            self.visited = self.visited.saturating_add(1);
            (self.progress)(self.visited);
            if self.cancel.load(Ordering::Relaxed) {
                return;
            }
            let child = (entry.metadata.kind == FileKind::Folder).then(|| native.join(&entry.name));
            let (path, metadata, venv_check) = match self.admit(folder, entry, gitignores) {
                Admission::Skip => continue,
                Admission::NotNfc { name, nfc } => {
                    not_nfc.push((name, nfc));
                    continue;
                }
                Admission::Keep {
                    path,
                    metadata,
                    venv_check,
                } => (path, metadata, venv_check),
            };
            let inside = toward.is_none_or(|scope| *scope == path);
            if let Some(native) = child {
                self.queue.push(Folder {
                    path: path.clone(),
                    native,
                    metadata,
                    gitignores: gitignores.clone(),
                    venv_check,
                    toward: if inside { None } else { toward.cloned() },
                });
            } else if inside {
                self.snapshot.entries.insert(path.clone(), metadata);
            }
            kept.push(path);
        }
        self.report_twins(folder, &kept, not_nfc);
    }

    /// Steps 1–6 of docs/specs/library-scan.md §4 for one name.
    fn admit(
        &mut self,
        folder: Option<&RelPath>,
        entry: DirEntry,
        gitignores: &Gitignores,
    ) -> Admission {
        let Some(name) = entry.name.to_str() else {
            self.problems.push(Problem::NotUnicode {
                folder: folder.cloned(),
                name: entry.name.to_string_lossy().into_owned(),
            });
            return Admission::Skip;
        };
        let folio_owned = || RelPath::parse(name).is_ok_and(|path| is_folio_owned(&path));
        if (folder.is_none() && folio_owned()) || is_always_ignored(name) {
            return Admission::Skip;
        }
        let nfc: Cow<'_, str> = if is_nfc(name) {
            Cow::Borrowed(name)
        } else {
            Cow::Owned(name.nfc().collect())
        };
        let candidate = match folder {
            None => nfc.to_string(),
            Some(folder) => format!("{folder}/{nfc}"),
        };
        let is_folder = entry.metadata.kind == FileKind::Folder;
        let verdict = self.rules.verdict(gitignores, &candidate, is_folder);
        if verdict == Verdict::Ignored {
            return Admission::Skip;
        }
        let problem = match entry.metadata.kind {
            FileKind::Link => Some(Problem::Link {
                folder: folder.cloned(),
                name: name.to_owned(),
            }),
            FileKind::Other => Some(Problem::Special {
                folder: folder.cloned(),
                name: name.to_owned(),
            }),
            FileKind::File | FileKind::Folder => None,
        };
        if let Some(problem) = problem {
            self.problems.push(problem);
            return Admission::Skip;
        }
        let path = RelPath::parse(name).and_then(|name| name.below(folder));
        match path {
            Ok(path) => Admission::Keep {
                path,
                metadata: entry.metadata,
                venv_check: is_folder && verdict == Verdict::Unmatched,
            },
            Err(PathError::NotNfc) => Admission::NotNfc {
                name: name.to_owned(),
                nfc: nfc.into_owned(),
            },
            Err(error) => {
                self.problems.push(Problem::InvalidName {
                    folder: folder.cloned(),
                    name: name.to_owned(),
                    error,
                });
                Admission::Skip
            }
        }
    }

    /// Reports names in one folder that differ only in case, and names that are not NFC.
    fn report_twins(
        &mut self,
        folder: Option<&RelPath>,
        kept: &[RelPath],
        not_nfc: Vec<(String, String)>,
    ) {
        // Where each name was first seen, by its identity; twins are rare, so only they cost more.
        let mut first = HashMap::<PathKey, usize>::with_capacity(kept.len());
        let mut twins = BTreeMap::<usize, Vec<RelPath>>::new();
        for (index, path) in kept.iter().enumerate() {
            match first.entry(path.name_key()) {
                Entry::Vacant(slot) => {
                    slot.insert(index);
                }
                Entry::Occupied(slot) => {
                    let earlier = *slot.get();
                    twins
                        .entry(earlier)
                        .or_insert_with(|| vec![kept[earlier].clone()])
                        .push(path.clone());
                }
            }
        }
        for paths in twins.into_values() {
            self.problems.push(Problem::CaseTwins { paths });
        }
        for (name, nfc) in not_nfc {
            let twin = kept.iter().any(|path| same_name(path.name(), &nfc));
            self.problems.push(Problem::NotNfc {
                folder: folder.cloned(),
                name,
                twin,
            });
        }
    }

    /// `parent` with the rules of the `.gitignore` in this listing, if there is one.
    fn gitignores(
        &mut self,
        folder: Option<&RelPath>,
        native: &Path,
        listing: &[DirEntry],
        parent: &Gitignores,
    ) -> Gitignores {
        let Some(entry) = listing.iter().find(|entry| is_file_named(entry, GITIGNORE)) else {
            return parent.clone();
        };
        let name = RelPath::parse(entry.name.to_str().expect("checked"))
            .expect("a name that differs from `.gitignore` only in case");
        let Ok(file) = name.below(folder) else {
            return parent.clone();
        };
        let text = self.fs.open(&native.join(&entry.name)).and_then(read_rules);
        match text {
            Ok(Some(text)) => {
                self.rules
                    .with_gitignore(parent, folder, &file, &text, self.problems)
            }
            Ok(None) => {
                self.problems.push(Problem::Unreadable {
                    path: file,
                    failure: ReadFailure::TooLarge,
                    detail: format!("larger than {MAX_RULES_BYTES} bytes"),
                });
                parent.clone()
            }
            Err(error) => {
                self.problems.push(Problem::unreadable(file, &error));
                parent.clone()
            }
        }
    }
}

/// Whether a listing holds a file with this name, whatever its case (NTFS ignores case).
fn contains_file(listing: &[DirEntry], name: &str) -> bool {
    listing.iter().any(|entry| is_file_named(entry, name))
}

fn is_file_named(entry: &DirEntry, name: &str) -> bool {
    entry.metadata.kind == FileKind::File
        && entry
            .name
            .to_str()
            .is_some_and(|entry_name| same_name(entry_name, name))
}
