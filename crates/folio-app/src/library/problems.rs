use std::collections::{BTreeMap, HashSet};

use folio_core::library::{EntryChange, EntryChangeKind, Problem as CoreProblem, ScanCoverage};
use folio_core::paths::{PathError, RelPath, same_name};

use crate::ipc::problems::{
    MetadataFailure, NameRule, Problem, ProblemItem, ReadFailure, StrandedCause,
};

#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
enum Source {
    Files,
    Metadata,
    Rules,
    Hash,
    /// Files whose text could not be extracted for search (the hash job's second part).
    Extract,
}

impl Source {
    /// Problems found by reading files: a commit that changes a file invalidates its own.
    fn reads(self) -> bool {
        matches!(self, Self::Hash | Self::Extract)
    }
}

#[derive(Default)]
pub(super) struct Problems {
    items: BTreeMap<(Source, String), ProblemItem>,
    next: u64,
}

impl Problems {
    pub fn items(&self) -> Vec<ProblemItem> {
        let mut items: Vec<_> = self.items.iter().collect();
        // IDs are decimal counters. Their order survives scoped replacement and filesystem
        // enumeration changes; the source breaks ties when both scanning and hashing saw it.
        items.sort_by(|((source_a, _), a), ((source_b, _), b)| {
            a.id.len()
                .cmp(&b.id.len())
                .then_with(|| a.id.cmp(&b.id))
                .then_with(|| source_a.cmp(source_b))
        });
        items.dedup_by(|(_, a), (_, b)| a.id == b.id);
        items.into_iter().map(|(_, item)| item.clone()).collect()
    }

    /// `items().len()` without cloning: a problem seen by scanning and hashing counts once.
    pub fn total(&self) -> usize {
        self.items
            .values()
            .map(|item| &item.id)
            .collect::<HashSet<_>>()
            .len()
    }

    pub fn scan(&mut self, coverage: &ScanCoverage, problems: Vec<CoreProblem>) -> bool {
        if matches!(coverage, ScanCoverage::None) {
            return false;
        }
        let visible = self.items();
        let old = self.items.clone();
        self.items.retain(|(source, _), item| match source {
            Source::Metadata => matches!(coverage, ScanCoverage::None),
            Source::Rules => matches!(coverage, ScanCoverage::Metadata),
            Source::Files => match coverage {
                ScanCoverage::Full => false,
                ScanCoverage::Scope(scope) => !within(&item.problem, scope),
                ScanCoverage::Metadata | ScanCoverage::None => true,
            },
            Source::Hash | Source::Extract => true,
        });
        for problem in problems {
            let source = if matches!(problem, CoreProblem::InvalidIgnoreRule { file: None, .. }) {
                Source::Rules
            } else if metadata(&problem) {
                Source::Metadata
            } else {
                Source::Files
            };
            self.add(source, problem, &old);
        }
        self.items() != visible
    }

    pub fn hash(&mut self, problems: Vec<CoreProblem>, cancelled: bool) -> bool {
        self.read(Source::Hash, problems, !cancelled)
    }

    /// The files whose text an extraction pass could not extract. A complete pass lists every
    /// one and replaces the earlier list; a pass that stopped early replaces only what it saw.
    pub fn extract(&mut self, problems: Vec<CoreProblem>, complete: bool) -> bool {
        self.read(Source::Extract, problems, complete)
    }

    /// Replaces the problems of a reading pass: all of them after a complete pass, else only
    /// those of the files it reported, keeping the files it did not get to.
    fn read(&mut self, from: Source, problems: Vec<CoreProblem>, complete: bool) -> bool {
        let visible = self.items();
        let old = self.items.clone();
        let visited: HashSet<_> = problems
            .iter()
            .filter_map(|problem| match problem {
                CoreProblem::Unreadable { path, .. } => Some(path.as_str()),
                _ => None,
            })
            .collect();
        self.items.retain(|(source, _), item| {
            *source != from || (!complete && !matches!(
                &item.problem, Problem::Unreadable { path, .. } if visited.contains(path.as_str())
            ))
        });
        for problem in problems {
            self.add(from, problem, &old);
        }
        self.items() != visible
    }

    /// A changed file/folder no longer has the content that failed hashing or extraction.
    /// Invalidate old errors at both ends of a move, including descendants; tag changes do not
    /// affect reads.
    pub fn invalidate_reads(&mut self, changes: &[EntryChange]) -> bool {
        // Usually none: then a first scan's 50,000 changes need no path set.
        if !self.items.keys().any(|(source, _)| source.reads()) {
            return false;
        }
        let visible = self.items();
        let mut paths = HashSet::new();
        for change in changes {
            if change.kind == EntryChangeKind::Tagged {
                continue;
            }
            paths.insert(change.path.clone());
            if let EntryChangeKind::Moved { from } = &change.kind {
                paths.insert(from.clone());
            }
        }
        self.items.retain(|(source, _), item| {
            if !source.reads() {
                return true;
            }
            let Problem::Unreadable { path, .. } = &item.problem else {
                return true;
            };
            !RelPath::parse(path)
                .is_ok_and(|path| path.ancestors().any(|ancestor| paths.contains(&ancestor)))
        });
        self.items() != visible
    }

    fn add(
        &mut self,
        source: Source,
        problem: CoreProblem,
        old: &BTreeMap<(Source, String), ProblemItem>,
    ) {
        let (problem, detail) = convert(problem);
        // The canonical variant's debug form is an infallible, process-local equality key;
        // details are deliberately excluded so a changed OS message retains the identity.
        let key = format!("{problem:?}");
        if let Some(item) = self.items.get_mut(&(source, key.clone())) {
            item.detail = detail;
            return;
        }
        let existing = |items: &BTreeMap<(Source, String), ProblemItem>| {
            [
                Source::Files,
                Source::Metadata,
                Source::Rules,
                Source::Hash,
                Source::Extract,
            ]
            .into_iter()
            .find_map(|source| {
                items
                    .get(&(source, key.clone()))
                    .map(|item| item.id.clone())
            })
        };
        let id = existing(old)
            .or_else(|| existing(&self.items))
            .unwrap_or_else(|| {
                self.next += 1;
                self.next.to_string()
            });
        self.items.insert(
            (source, key),
            ProblemItem {
                id,
                problem,
                detail,
            },
        );
    }
}

fn metadata(problem: &CoreProblem) -> bool {
    matches!(
        problem,
        CoreProblem::Metadata { .. }
            | CoreProblem::OrphanedMetadata { .. }
            | CoreProblem::NotRelocated { .. }
    )
}

fn within(problem: &Problem, scope: &RelPath) -> bool {
    let below = |path: &str| below(path, scope);
    match problem {
        Problem::NotUnicode { folder, name }
        | Problem::InvalidName { folder, name, .. }
        | Problem::NotNfc { folder, name, .. }
        | Problem::Link { folder, name }
        | Problem::Special { folder, name } => below(
            &folder
                .as_ref()
                .map_or_else(|| name.clone(), |folder| format!("{folder}/{name}")),
        ),
        Problem::Unreadable { path, .. } => {
            below(path)
                || RelPath::parse(path).is_ok_and(|path| {
                    scope.starts_with(&path)
                        || (same_name(path.name(), ".gitignore") && ancestor_rules(&path, scope))
                })
        }
        // A single-file scan cannot determine whether its sibling is still a case twin.
        Problem::CaseTwins { paths } => paths.iter().all(|path| below(path)),
        Problem::InvalidIgnoreRule {
            file: Some(file), ..
        } => below(file) || RelPath::parse(file).is_ok_and(|file| ancestor_rules(&file, scope)),
        _ => false,
    }
}

fn ancestor_rules(file: &RelPath, scope: &RelPath) -> bool {
    file.parent()
        .is_none_or(|parent| scope.starts_with(&parent))
}

fn below(path: &str, scope: &RelPath) -> bool {
    path == scope.as_str()
        || path
            .strip_prefix(scope.as_str())
            .is_some_and(|rest| rest.starts_with('/'))
}

fn folder(value: Option<RelPath>) -> Option<String> {
    value.map(|path| path.as_str().to_owned())
}

fn failure(value: folio_core::library::ReadFailure) -> ReadFailure {
    use folio_core::library::ReadFailure as C;
    match value {
        C::Denied => ReadFailure::Denied,
        C::InUse => ReadFailure::InUse,
        C::TooLarge => ReadFailure::TooLarge,
        C::Other => ReadFailure::Other,
    }
}

fn convert(value: CoreProblem) -> (Problem, String) {
    use CoreProblem as C;
    let detail = match &value {
        C::Unreadable { detail, .. }
        | C::InvalidIgnoreRule { detail, .. }
        | C::Metadata { detail, .. } => Some(detail.clone()),
        C::InvalidName { error, .. } => Some(error.to_string()),
        _ => None,
    };
    let problem = match value {
        C::NotUnicode { folder: f, name } => Problem::NotUnicode {
            folder: folder(f),
            name,
        },
        C::InvalidName {
            folder: f,
            name,
            error,
        } => Problem::InvalidName {
            folder: folder(f),
            name,
            rule: match error {
                PathError::Empty => NameRule::Empty,
                PathError::NotNfc => NameRule::NotNfc,
                PathError::DotSegment => NameRule::DotName,
                PathError::ReservedCharacter(_) => NameRule::InvalidCharacter,
                PathError::TrailingDotOrSpace => NameRule::TrailingDotOrSpace,
                PathError::ReservedName => NameRule::ReservedName,
                PathError::NameTooLong => NameRule::TooLong,
                PathError::TooLong => NameRule::PathTooLong,
            },
        },
        C::NotNfc {
            folder: f,
            name,
            twin,
        } => Problem::NotNfc {
            folder: folder(f),
            name,
            twin,
        },
        C::CaseTwins { paths } => {
            let mut paths: Vec<_> = paths.into_iter().map(|p| p.as_str().to_owned()).collect();
            paths.sort();
            paths.dedup();
            Problem::CaseTwins { paths }
        }
        C::Link { folder: f, name } => Problem::Link {
            folder: folder(f),
            name,
        },
        C::Special { folder: f, name } => Problem::Special {
            folder: folder(f),
            name,
        },
        C::Unreadable {
            path, failure: f, ..
        } => Problem::Unreadable {
            path: path.as_str().to_owned(),
            failure: failure(f),
        },
        C::InvalidIgnoreRule { file, line, .. } => Problem::InvalidIgnoreRule {
            file: folder(file),
            line: crate::jobs::count(line as u64),
        },
        C::Metadata {
            file, failure: f, ..
        } => Problem::Metadata {
            file,
            failure: match f {
                folio_core::library::MetadataFailure::Newer => MetadataFailure::Newer,
                folio_core::library::MetadataFailure::Invalid => MetadataFailure::Invalid,
                folio_core::library::MetadataFailure::Unreadable(f) => {
                    MetadataFailure::Unreadable {
                        failure: failure(f),
                    }
                }
            },
        },
        C::OrphanedMetadata { folder } => Problem::OrphanedMetadata {
            folder: folder.as_str().to_owned(),
        },
        C::NotRelocated { from, to, cause } => Problem::NotRelocated {
            from: from.as_str().to_owned(),
            to: to.as_str().to_owned(),
            cause: match cause {
                folio_core::meta::StrandedCause::ReadOnly => StrandedCause::ReadOnly,
                folio_core::meta::StrandedCause::FolderTags => StrandedCause::FolderTags,
                folio_core::meta::StrandedCause::Unreadable => StrandedCause::Unreadable,
                folio_core::meta::StrandedCause::TooLong => StrandedCause::TooLong,
            },
        },
    };
    let detail = detail.unwrap_or_else(|| format!("{problem:?}"));
    (problem, detail)
}

#[cfg(test)]
mod tests {
    use super::*;
    use folio_core::catalog::EntryId;
    use folio_core::library::{
        MetadataFailure as CoreMetadataFailure, ReadFailure as CoreReadFailure,
    };

    fn path(value: &str) -> RelPath {
        RelPath::parse(value).unwrap()
    }

    fn unreadable(value: &str) -> CoreProblem {
        CoreProblem::Unreadable {
            path: path(value),
            failure: CoreReadFailure::InUse,
            detail: "locked".to_owned(),
        }
    }

    #[test]
    fn every_path_error_maps_to_the_matching_ipc_name_rule() {
        for (error, rule) in [
            (PathError::Empty, NameRule::Empty),
            (PathError::NotNfc, NameRule::NotNfc),
            (PathError::DotSegment, NameRule::DotName),
            (
                PathError::ReservedCharacter(':'),
                NameRule::InvalidCharacter,
            ),
            (PathError::TrailingDotOrSpace, NameRule::TrailingDotOrSpace),
            (PathError::ReservedName, NameRule::ReservedName),
            (PathError::NameTooLong, NameRule::TooLong),
            (PathError::TooLong, NameRule::PathTooLong),
        ] {
            let (problem, _) = convert(CoreProblem::InvalidName {
                folder: None,
                name: "bad".to_owned(),
                error,
            });
            assert_eq!(
                problem,
                Problem::InvalidName {
                    folder: None,
                    name: "bad".to_owned(),
                    rule
                }
            );
        }
    }

    #[test]
    fn scoped_scan_replaces_its_files_and_global_metadata_but_keeps_siblings_and_hash_errors() {
        let mut problems = Problems::default();
        problems.scan(
            &ScanCoverage::Full,
            vec![
                unreadable("a/b/x.md"),
                unreadable("a/bc/y.md"),
                CoreProblem::Metadata {
                    file: ".folio/meta/z/c.json".to_owned(),
                    failure: CoreMetadataFailure::Invalid,
                    detail: "bad".to_owned(),
                },
                CoreProblem::InvalidIgnoreRule {
                    file: Some(path(".gitignore")),
                    line: 1,
                    detail: "bad pattern".to_owned(),
                },
            ],
        );
        problems.hash(vec![unreadable("a/b/hash.md")], false);
        assert!(problems.scan(&ScanCoverage::Scope(path("a/b")), Vec::new()));
        let remaining: Vec<_> = problems
            .items()
            .into_iter()
            .map(|item| item.problem)
            .collect();
        assert_eq!(
            remaining,
            [
                convert(unreadable("a/bc/y.md")).0,
                convert(unreadable("a/b/hash.md")).0
            ]
        );
    }

    #[test]
    fn unchanged_problems_keep_ids_order_and_do_not_emit_another_change() {
        let mut problems = Problems::default();
        problems.scan(
            &ScanCoverage::Full,
            vec![unreadable("a.md"), unreadable("b.md")],
        );
        let before = problems.items();
        assert!(!problems.scan(
            &ScanCoverage::Full,
            vec![unreadable("b.md"), unreadable("a.md")]
        ));
        assert_eq!(problems.items(), before);
        let changed_detail = CoreProblem::Unreadable {
            path: path("a.md"),
            failure: CoreReadFailure::InUse,
            detail: "locked again".to_owned(),
        };
        assert!(problems.scan(&ScanCoverage::Scope(path("a.md")), vec![changed_detail]));
        assert_eq!(problems.items()[0].id, before[0].id);
        assert_eq!(problems.items()[0].detail, "locked again");
    }

    #[test]
    fn metadata_only_keeps_ignore_problems_until_a_filesystem_scan_rechecks_them() {
        let mut problems = Problems::default();
        problems.scan(
            &ScanCoverage::Full,
            vec![
                CoreProblem::InvalidIgnoreRule {
                    file: None,
                    line: 1,
                    detail: "invalid library rule".to_owned(),
                },
                unreadable("a"),
                unreadable("a/.gitignore"),
            ],
        );
        let before = problems.items();
        assert!(!problems.scan(&ScanCoverage::Metadata, Vec::new()));
        assert_eq!(problems.items(), before);
        assert!(problems.scan(&ScanCoverage::Scope(path("a/b")), Vec::new()));
        assert!(problems.items().is_empty());
    }

    #[test]
    fn cancelled_hash_keeps_unvisited_failures_and_replaces_a_visited_failure() {
        let mut problems = Problems::default();
        problems.hash(vec![unreadable("a.md"), unreadable("b.md")], false);
        let untouched = problems.items()[1].clone();
        assert!(!problems.hash(Vec::new(), true));
        assert!(problems.hash(
            vec![CoreProblem::Unreadable {
                path: path("a.md"),
                failure: CoreReadFailure::Denied,
                detail: "denied".to_owned(),
            }],
            true
        ));
        assert_eq!(problems.items().len(), 2);
        assert!(problems.items().contains(&untouched));
        assert!(
            !problems
                .items()
                .iter()
                .any(|item| item.problem == convert(unreadable("a.md")).0)
        );
        assert!(problems.hash(Vec::new(), false));
        assert!(problems.items().is_empty());
    }

    #[test]
    fn a_problem_seen_by_both_scan_and_hash_stays_until_both_sources_clear_it() {
        let mut problems = Problems::default();
        problems.scan(&ScanCoverage::Full, vec![unreadable(".gitignore")]);
        let before = problems.items();
        assert!(!problems.hash(vec![unreadable(".gitignore")], false));
        assert!(!problems.scan(&ScanCoverage::Full, Vec::new()));
        assert_eq!(problems.items(), before);
        assert!(problems.hash(Vec::new(), false));
        assert!(problems.items().is_empty());
    }

    #[test]
    fn committed_moves_invalidate_hash_failures_at_both_ends_but_tags_do_not() {
        let mut problems = Problems::default();
        problems.hash(
            vec![
                unreadable("old/a.md"),
                unreadable("new/b.md"),
                unreadable("other.md"),
            ],
            false,
        );
        assert!(!problems.invalidate_reads(&[EntryChange {
            id: EntryId(1),
            path: path("other.md"),
            kind: EntryChangeKind::Tagged
        }]));
        assert!(problems.invalidate_reads(&[EntryChange {
            id: EntryId(2),
            path: path("new"),
            kind: EntryChangeKind::Moved { from: path("old") }
        }]));
        assert_eq!(problems.items().len(), 1);
        assert_eq!(
            problems.items()[0].problem,
            convert(unreadable("other.md")).0
        );
    }

    fn damaged(value: &str) -> CoreProblem {
        CoreProblem::Unreadable {
            path: path(value),
            failure: CoreReadFailure::Other,
            detail: "not a ZIP archive".to_owned(),
        }
    }

    #[test]
    fn a_complete_extraction_replaces_its_list_and_one_that_stopped_keeps_the_rest() {
        let mut problems = Problems::default();
        assert!(problems.extract(vec![damaged("a.docx"), damaged("b.docx")], true));
        let b = problems.items()[1].clone();
        // A pass that stopped early saw only a.docx, which reads now: b.docx stays listed.
        assert!(!problems.extract(Vec::new(), false));
        assert!(problems.extract(vec![unreadable("a.docx")], false));
        let listed: Vec<_> = problems
            .items()
            .into_iter()
            .map(|item| item.problem)
            .collect();
        assert_eq!(listed, [b.problem.clone(), convert(unreadable("a.docx")).0]);
        // A complete pass lists everything again, with the same ids for the same problems.
        assert!(problems.extract(vec![damaged("b.docx")], true));
        assert_eq!(problems.items(), [b]);
        assert!(problems.extract(Vec::new(), true));
        assert!(problems.items().is_empty());
    }

    #[test]
    fn extraction_problems_survive_scans_and_hashing_but_not_a_change_to_their_file() {
        let mut problems = Problems::default();
        problems.extract(vec![damaged("s/c/a.docx"), damaged("s/c/b.docx")], true);
        let before = problems.items();
        assert!(!problems.scan(&ScanCoverage::Full, Vec::new()));
        assert!(!problems.scan(&ScanCoverage::Scope(path("s/c")), Vec::new()));
        assert!(!problems.hash(Vec::new(), false));
        assert_eq!(problems.items(), before);
        assert!(!problems.invalidate_reads(&[EntryChange {
            id: EntryId(1),
            path: path("s/c/a.docx"),
            kind: EntryChangeKind::Tagged
        }]));
        assert!(problems.invalidate_reads(&[EntryChange {
            id: EntryId(1),
            path: path("s/c/a.docx"),
            kind: EntryChangeKind::Modified
        }]));
        assert_eq!(problems.items(), before[1..]);
        assert!(problems.invalidate_reads(&[EntryChange {
            id: EntryId(2),
            path: path("t"),
            kind: EntryChangeKind::Moved { from: path("s") }
        }]));
        assert!(problems.items().is_empty());
    }

    #[test]
    fn a_file_both_hashing_and_extraction_reported_counts_once() {
        let mut problems = Problems::default();
        problems.hash(vec![unreadable("a.md")], false);
        let before = problems.items();
        assert!(!problems.extract(vec![unreadable("a.md")], true));
        assert_eq!(problems.total(), 1);
        assert_eq!(problems.items(), before);
        assert!(!problems.hash(Vec::new(), false));
        assert_eq!(problems.items(), before);
        assert!(problems.extract(Vec::new(), true));
        assert!(problems.items().is_empty());
    }

    #[test]
    fn case_twins_have_canonical_identity_and_need_a_covering_scope_to_clear() {
        let mut problems = Problems::default();
        problems.scan(
            &ScanCoverage::Full,
            vec![CoreProblem::CaseTwins {
                paths: vec![path("dir/a"), path("dir/A")],
            }],
        );
        let before = problems.items();
        assert!(!problems.scan(
            &ScanCoverage::Full,
            vec![CoreProblem::CaseTwins {
                paths: vec![path("dir/A"), path("dir/a")]
            }]
        ));
        assert_eq!(problems.items(), before);
        assert!(!problems.scan(&ScanCoverage::Scope(path("dir/a")), Vec::new()));
        assert!(problems.scan(&ScanCoverage::Scope(path("dir")), Vec::new()));
        assert!(problems.items().is_empty());
    }
}
