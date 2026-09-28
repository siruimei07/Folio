//! ADR-0002's property: after random changes, the catalog that scans kept up to date equals one
//! built from scratch. Also: entries keep their ids, files their tags, and semesters and courses
//! their settings, as long as their file ids survive.

use proptest::prelude::*;

use super::*;
use crate::catalog::all_entry_tags;
use crate::meta::Settings;
use crate::paths::SemesterPath;

/// The paths operations pick from: semesters, courses, subfolders, case variants, names the
/// rules ignore, and a `.gitignore` that ignores `build/`.
const POOL: &[&str] = &[
    "a.md",
    "A.md",
    "b.txt",
    "s1",
    "S1",
    "s1/x.md",
    "s1/X.md",
    "s1/Thumbs.db",
    "s1/c1",
    "s1/C1",
    "s1/c1/y.txt",
    "s1/c1/sub",
    "s1/c1/sub/z.pdf",
    "s1/c1/sub/笔记.md",
    "s1/c1/.gitignore",
    "s1/c1/build",
    "s1/c1/build/o.bin",
    "s1/c2",
    "s1/c2/y.txt",
    "s1/c2/sub",
    "s2",
    "s2/c1",
    "s2/c1/w.docx",
    "s2/c1/sub",
    "s2/c1/sub/y.txt",
    "s2/资料.pdf",
];

/// What every case starts from, scanned once.
const SEED: &[&str] = &[
    "a.md",
    "s1/x.md",
    "s1/c1/y.txt",
    "s1/c1/sub/z.pdf",
    "s1/c2/y.txt",
    "s2/c1/w.docx",
];

/// An operation. `Remove`, `Rename`'s source, `Tag` and `Settings` pick among what exists, so
/// that most operations do something.
#[derive(Debug, Clone)]
enum Op {
    Write(usize, u8),
    /// Saves through a temporary file: a new file id at the same path.
    Replace(usize, u8),
    Folder(usize),
    Remove(usize),
    Rename(usize, usize),
    Tag(usize, u8),
    Settings(usize, u8),
    Scan,
    Hash,
}

fn op() -> impl Strategy<Value = Op> {
    let index = || 0..POOL.len();
    prop_oneof![
        2 => (index(), any::<u8>()).prop_map(|(at, byte)| Op::Write(at, byte)),
        1 => (index(), any::<u8>()).prop_map(|(at, byte)| Op::Replace(at, byte)),
        1 => index().prop_map(Op::Folder),
        1 => any::<usize>().prop_map(Op::Remove),
        4 => (any::<usize>(), index()).prop_map(|(from, to)| Op::Rename(from, to)),
        2 => (any::<usize>(), any::<u8>()).prop_map(|(pick, bits)| Op::Tag(pick, bits)),
        2 => (any::<usize>(), any::<u8>()).prop_map(|(pick, order)| Op::Settings(pick, order)),
        3 => Just(Op::Scan),
        1 => Just(Op::Hash),
    ]
}

/// The disk and what the tests expect of the catalog kept up to date by scans.
struct Model {
    f: Fixture,
    /// The tags of each file, by file id.
    tags: BTreeMap<String, BTreeSet<TagId>>,
    /// The settings of each semester and course folder, by file id.
    settings: BTreeMap<String, Settings>,
    /// The entry id, path and time added of each file id after the last scan.
    known: BTreeMap<String, (EntryId, RelPath, i64)>,
    /// Files saved through a temporary file since the last scan: new id, path, tags. The tags
    /// stay with the path, so the new file has them if it is still there at the next scan; if
    /// it moved too, nothing can pair it with its entry.
    replaced: Vec<(String, RelPath, BTreeSet<TagId>)>,
}

impl Model {
    fn new() -> Self {
        let mut model = Self {
            f: Fixture::new(),
            tags: BTreeMap::new(),
            settings: BTreeMap::new(),
            known: BTreeMap::new(),
            replaced: Vec::new(),
        };
        for file in SEED {
            model.f.fs.file(file, file.as_bytes());
        }
        model.scan();
        model
    }

    /// The pool's paths that exist now.
    fn existing(&self) -> Vec<&'static str> {
        POOL.iter()
            .copied()
            .filter(|at| self.f.fs.kind_of(at).is_some())
            .collect()
    }

    /// One of the catalog's entries, by its file id and catalog path, that `keep` accepts.
    fn pick_known(
        &self,
        pick: usize,
        keep: impl Fn(&RelPath) -> bool,
    ) -> Option<(String, RelPath)> {
        let candidates: Vec<(&String, &RelPath)> = self
            .known
            .iter()
            .map(|(id, (_, known, _))| (id, known))
            .filter(|(_, known)| keep(known))
            .collect();
        let (id, known) = candidates.get(pick % candidates.len().max(1))?;
        Some(((*id).clone(), (*known).clone()))
    }

    fn file_id(&self, at: &str) -> Option<String> {
        let native = path(at).to_native(self.f.library.root());
        self.f.fs.metadata(&native).ok()?.file_id
    }

    /// Whether `at` could be created, with its missing folders, without a folder in the way
    /// and without names that differ only in case (`except` aside): tag files cannot tell
    /// those apart.
    fn creatable(&self, at: &str, except: Option<&str>) -> bool {
        let mut prefixes: Vec<&str> = at.match_indices('/').map(|(end, _)| &at[..end]).collect();
        prefixes.push(at);
        prefixes
            .iter()
            .enumerate()
            .all(|(index, prefix)| match self.f.fs.kind_of(prefix) {
                Some(FileKind::Folder) => index + 1 < prefixes.len(),
                Some(_) => false,
                None => !POOL.iter().any(|other| {
                    other != prefix
                        && Some(*other) != except
                        && path(other).key() == path(prefix).key()
                        && self.f.fs.kind_of(other).is_some()
                }),
            })
    }

    fn apply(&mut self, op: &Op) {
        let fs = &self.f.fs;
        let content = |at: &str, byte: u8| {
            if at.ends_with(".gitignore") {
                b"build/\n".to_vec()
            } else {
                vec![byte; usize::from(byte % 5) + 1]
            }
        };
        match *op {
            Op::Write(at, byte) => {
                let at = POOL[at];
                if fs.kind_of(at) == Some(FileKind::File) || self.creatable(at, None) {
                    fs.file(at, &content(at, byte));
                }
            }
            Op::Replace(at, byte) => {
                let at = POOL[at];
                if fs.kind_of(at) == Some(FileKind::File) {
                    let old = self.file_id(at).unwrap();
                    fs.replace(at, &content(at, byte));
                    let tags = self.tags.remove(&old);
                    let unmoved = self
                        .known
                        .get(&old)
                        .is_some_and(|(_, known, _)| *known == path(at));
                    if let (Some(tags), true) = (tags, unmoved) {
                        self.replaced
                            .push((self.file_id(at).unwrap(), path(at), tags));
                    }
                }
            }
            Op::Folder(at) => {
                if self.creatable(POOL[at], None) {
                    fs.folder(POOL[at]);
                }
            }
            Op::Remove(pick) => {
                let existing = self.existing();
                if let Some(at) = existing.get(pick % existing.len().max(1)) {
                    fs.remove(at);
                }
            }
            Op::Rename(pick, to) => {
                let existing = self.existing();
                let Some(&from) = existing.get(pick % existing.len().max(1)) else {
                    return;
                };
                let to = POOL[to];
                let below = to
                    .strip_prefix(from)
                    .is_some_and(|rest| rest.starts_with('/'));
                if from != to && !below && self.creatable(to, Some(from)) {
                    fs.rename(from, to);
                }
            }
            // Folio tags the entries in its catalog, at their catalog paths, whatever happened
            // on disk since the last scan.
            Op::Tag(pick, bits) => {
                let Some((id, known)) = self.pick_known(pick, |_| true) else {
                    return;
                };
                if self.f.entry(known.as_str()).record.kind != EntryKind::File {
                    return;
                }
                let ids: BTreeSet<TagId> = ["notes", "slides", "homework"]
                    .into_iter()
                    .enumerate()
                    .filter(|(bit, _)| bits & (1 << bit) != 0)
                    .map(|(_, id)| TagId::parse(id).unwrap())
                    .collect();
                set_tags(
                    self.f.layout(),
                    known.as_str(),
                    EntryKind::File,
                    ids.clone(),
                );
                // A file saved through a temporary file at that path gets these tags instead.
                self.replaced.retain(|(_, at, _)| *at != known);
                if ids.is_empty() {
                    self.tags.remove(&id);
                } else {
                    self.tags.insert(id, ids);
                }
            }
            // Like tags, at the folder's catalog path.
            Op::Settings(pick, order) => {
                let Some((id, known)) = self.pick_known(pick, |known| known.depth() <= 2) else {
                    return;
                };
                if self.f.entry(known.as_str()).record.kind != EntryKind::Folder {
                    return;
                }
                let layout = self.f.layout();
                let order = u32::from(order);
                let value = match known.depth() {
                    1 => {
                        let semester = SemesterPath::new(known.clone()).unwrap();
                        let group = GroupSettings {
                            archived: order % 2 == 0,
                            order,
                        };
                        let mut meta = layout
                            .read_group_meta(&semester)
                            .unwrap()
                            .unwrap_or_default();
                        meta.group = Some(group.clone());
                        layout.write_group_meta(&semester, &meta).unwrap();
                        Settings::Group(group)
                    }
                    2 => {
                        set_course(layout, known.as_str(), settings("课", order));
                        Settings::Course(settings("课", order))
                    }
                    _ => return,
                };
                self.settings.insert(id, value);
            }
            Op::Scan => self.scan(),
            Op::Hash => {
                self.f.hash_all();
            }
        }
    }

    /// Scans and checks that entry ids and tags followed the file ids.
    fn scan(&mut self) {
        self.f.scan();
        let entries = self.f.entries();
        for (file_id, at, tags) in std::mem::take(&mut self.replaced) {
            let unmoved = entries.iter().any(|entry| {
                entry.record.file_id.as_ref() == Some(&file_id) && entry.record.path == at
            });
            if unmoved {
                self.tags.insert(file_id, tags);
            }
        }
        let stored = self.f.catalog.read(|tx| all_entry_tags(tx)).unwrap();
        let groups = self.f.catalog.read(|tx| semesters(tx)).unwrap();
        let courses = self.f.catalog.read(|tx| all_courses(tx)).unwrap();
        let mut known = BTreeMap::new();
        for entry in &entries {
            let Some(file_id) = &entry.record.file_id else {
                continue;
            };
            if let Some((id, _, added_ns)) = self.known.get(file_id) {
                assert_eq!(*id, entry.id, "entry id of {}", entry.record.path);
                assert_eq!(
                    *added_ns, entry.added_ns,
                    "added time of {}",
                    entry.record.path
                );
            }
            known.insert(
                file_id.clone(),
                (entry.id, entry.record.path.clone(), entry.added_ns),
            );
            if let Some(expected) = self.tags.get(file_id) {
                assert_eq!(
                    stored.get(&entry.id),
                    Some(expected),
                    "tags of {}",
                    entry.record.path
                );
            }
            // Settings follow a folder while it stays a semester or a course; otherwise they
            // stay behind.
            let path = &entry.record.path;
            match self.settings.get(file_id) {
                Some(Settings::Group(expected)) if path.depth() == 1 => {
                    let found = groups.iter().find(|(group, _)| group.path() == path);
                    assert_eq!(found.map(|(_, found)| found), Some(expected), "{path}");
                }
                Some(Settings::Course(expected)) if path.depth() == 2 => {
                    let found = courses.iter().find(|(course, _)| course.path() == path);
                    assert_eq!(found.map(|(_, found)| found), Some(expected), "{path}");
                }
                Some(_) => {
                    self.settings.remove(file_id);
                }
                None => {}
            }
        }
        // Tags and settings are promised only while the entry stays in the library.
        self.tags.retain(|file_id, _| known.contains_key(file_id));
        self.settings
            .retain(|file_id, _| known.contains_key(file_id));
        self.known = known;
    }
}

/// Everything in a catalog, by path: entries, tags, search rows, settings and definitions. Not
/// when entries were added: scans record when they first saw an entry, a rebuild takes the
/// file's creation time (docs/specs/library-scan.md §6.3).
fn contents(catalog: &Catalog) -> String {
    let rows = catalog
        .read(|tx| {
            let mut rows = Vec::new();
            let mut statement = tx.prepare(
                "SELECT entries.path, entries.kind, entries.class, entries.size,
                        entries.mtime_ns, entries.file_id, entries.hash,
                        parent.path, search.name, search.path, search.tags
                 FROM entries
                 LEFT JOIN entries AS parent ON parent.id = entries.parent_id
                 JOIN search ON search.rowid = entries.id
                 ORDER BY entries.path",
            )?;
            let mut query = statement.query([])?;
            while let Some(row) = query.next()? {
                let values: Vec<String> = (0..11)
                    .map(|column| format!("{:?}", row.get_ref(column).unwrap()))
                    .collect();
                rows.push(values.join(" | "));
            }
            let searches: i64 =
                tx.query_row("SELECT count(*) FROM search", [], |row| row.get(0))?;
            rows.push(format!("search rows: {searches}"));
            Ok(rows)
        })
        .unwrap();
    let tags: BTreeMap<String, BTreeSet<TagId>> = catalog
        .read(|tx| {
            let entries = entries_in(tx, None)?;
            let tags = all_entry_tags(tx)?;
            Ok(entries
                .into_iter()
                .filter_map(|entry| {
                    let ids = tags.get(&entry.id)?.clone();
                    Some((entry.record.path.to_string(), ids))
                })
                .collect())
        })
        .unwrap();
    let semesters = catalog.read(|tx| semesters(tx)).unwrap();
    let courses = catalog.read(|tx| all_courses(tx)).unwrap();
    let definitions = catalog.read(|tx| tag_definitions(tx)).unwrap();
    format!("{rows:#?}\n{tags:?}\n{semesters:?}\n{courses:?}\n{definitions:?}")
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(48))]

    #[test]
    fn a_rebuilt_catalog_equals_the_one_scans_kept_up_to_date(
        ops in prop::collection::vec(op(), 1..32),
    ) {
        let mut model = Model::new();
        for op in &ops {
            model.apply(op);
        }
        model.scan();
        model.f.hash_all();

        let dir = tempfile::tempdir().unwrap();
        let rebuilt = open_catalog(dir.path());
        model.f.scan_into(&rebuilt);
        model.f.hash_all_into(&rebuilt);
        prop_assert_eq!(contents(&model.f.catalog), contents(&rebuilt));
    }
}
