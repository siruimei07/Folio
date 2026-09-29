//! Change detection: the records a directory watcher reports, and the rescans they call for
//! (docs/specs/windows-adapter.md §5). Plain Rust; on Windows, `win::Watcher` feeds it.

use std::collections::{BTreeSet, HashMap};
use std::ffi::OsString;
use std::time::{Duration, Instant};

use crate::meta::{FolioPart, folio_part};
use crate::paths::RelPath;

/// Scopes beyond this many become their deepest common folder: every scan also reads and
/// mirrors `.folio/meta/`, so many small scans cost more than one larger one.
const MAX_SCOPES: usize = 8;

/// One change a watcher reports.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Record {
    pub action: Action,
    /// Relative to the watched folder, name by name.
    pub path: Vec<OsString>,
    /// The file's id on its volume, where the watcher reports ids.
    pub file_id: Option<u64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Action {
    Added,
    Removed,
    Modified,
    /// The old name of a renamed file or folder.
    RenamedFrom,
    /// Its new name.
    RenamedTo,
}

impl Action {
    /// Whether the record says the file was there before it.
    fn existed(self) -> bool {
        matches!(self, Self::Removed | Self::Modified | Self::RenamedFrom)
    }

    /// Whether the record says the file is there after it.
    fn exists(self) -> bool {
        matches!(self, Self::Added | Self::Modified | Self::RenamedTo)
    }
}

/// What to scan (docs/specs/windows-adapter.md §5.3).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Rescan {
    /// The whole library.
    Full,
    /// These files and folders, none below another. Every scan also brings the catalog's copy of
    /// `.folio/meta/` in line.
    Scopes(Vec<RelPath>),
    /// Only `.folio/meta/` or `tags.json` changed.
    Metadata,
}

impl Rescan {
    /// One rescan covering both, as if their records had come in one window: for a consumer
    /// that could not run the first before the second arrived.
    #[must_use]
    pub fn merge(self, other: Self) -> Self {
        match (self, other) {
            (Self::Full, _) | (_, Self::Full) => Self::Full,
            (Self::Metadata, other) | (other, Self::Metadata) => other,
            (Self::Scopes(mut scopes), Self::Scopes(more)) => {
                scopes.extend(more);
                outermost(scopes.into_iter().collect()).map_or(Self::Full, Self::Scopes)
            }
        }
    }
}

/// How a watcher reads change records, and when rescans are due.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WatchOptions {
    /// Whether the volume has file ids (`WindowsFileSystem::has_file_ids`): the watcher asks for
    /// records with them.
    pub file_ids: bool,
    /// A rescan is due this long after the last record…
    pub settle: Duration,
    /// …or this long after the first record of a window, if records keep coming.
    pub max_delay: Duration,
    /// A full rescan is due this long after the last one.
    pub full_every: Duration,
    /// Bytes a read of change records fills; a network share takes at most 64 KiB.
    pub buffer_bytes: usize,
}

impl WatchOptions {
    /// The defaults for a volume with file ids (local NTFS) or without: records miss more
    /// without, so full rescans come more often.
    pub fn new(file_ids: bool) -> Self {
        Self {
            file_ids,
            settle: Duration::from_millis(300),
            max_delay: Duration::from_secs(3),
            full_every: Duration::from_secs(if file_ids { 60 * 60 } else { 10 * 60 }),
            buffer_bytes: 256 * 1024,
        }
    }
}

/// Where one file id was before the window and is after it.
#[derive(Debug)]
struct Track {
    before: Option<Vec<OsString>>,
    after: Option<Vec<OsString>>,
}

/// The records since the last rescan.
#[derive(Debug, Default)]
struct Window {
    /// When its first and last records came; `None` while it is empty.
    times: Option<(Instant, Instant)>,
    /// What belongs in the library may have changed: a full rescan is wanted.
    full: bool,
    metadata: bool,
    tracks: HashMap<u64, Track>,
    /// Paths of records without file ids.
    paths: Vec<Vec<OsString>>,
}

/// Turns records into rescans.
#[derive(Debug)]
pub(crate) struct Coalescer {
    options: WatchOptions,
    window: Window,
    /// When a full rescan is due: at once at the start and after records were lost, else
    /// `full_every` after the last one.
    full_due: Instant,
}

impl Coalescer {
    /// Starts with a full rescan due at once: what changed before the watch began is unknown.
    pub fn new(options: WatchOptions, now: Instant) -> Self {
        Self {
            options,
            window: Window::default(),
            full_due: now,
        }
    }

    pub fn record(&mut self, record: Record, now: Instant) {
        let window = &mut self.window;
        let first = window.times.map_or(now, |(first, _)| first);
        window.times = Some((first, now));
        match (folio_part(&record.path), record.file_id) {
            (Some(FolioPart::Rules), _) => window.full = true,
            (Some(FolioPart::Metadata), _) => window.metadata = true,
            (Some(FolioPart::Local), _) => {}
            (None, None) => window.paths.push(record.path),
            (None, Some(id)) => {
                let track = window.tracks.entry(id).or_insert_with(|| Track {
                    before: record.action.existed().then(|| record.path.clone()),
                    after: None,
                });
                track.after = record.action.exists().then_some(record.path);
            }
        }
    }

    /// The watcher lost records: only a full rescan can tell what changed.
    pub fn overflow(&mut self, now: Instant) {
        self.full_due = self.full_due.min(now);
    }

    /// When the next rescan is due.
    pub fn due(&self) -> Instant {
        match self.window.times {
            Some((first, last)) => self
                .full_due
                .min(last + self.options.settle)
                .min(first + self.options.max_delay),
            None => self.full_due,
        }
    }

    /// The rescan due at `now`, if any; nothing if the window's records cancel out, such as a
    /// temporary file made and removed.
    pub fn take(&mut self, now: Instant) -> Option<Rescan> {
        if now < self.due() {
            return None;
        }
        let window = std::mem::take(&mut self.window);
        let scopes = if window.full || now >= self.full_due {
            None
        } else {
            scopes(window.tracks.into_values(), window.paths)
        };
        match scopes {
            None => {
                self.full_due = now + self.options.full_every;
                Some(Rescan::Full)
            }
            Some(scopes) if scopes.is_empty() => window.metadata.then_some(Rescan::Metadata),
            Some(scopes) => Some(Rescan::Scopes(scopes)),
        }
    }
}

/// The scopes of a window's records, none below another; `None` for the whole library.
fn scopes(tracks: impl Iterator<Item = Track>, paths: Vec<Vec<OsString>>) -> Option<Vec<RelPath>> {
    let mut scopes = BTreeSet::new();
    for track in tracks {
        match (track.before, track.after) {
            // A move: one scan sees both paths and pairs it by file id (library scan §6.4).
            (Some(before), Some(after)) if before != after => {
                scopes.insert(common_folder(&scope(&before)?, &scope(&after)?)?);
            }
            (Some(path), _) | (None, Some(path)) => {
                scopes.insert(scope(&path)?);
            }
            // Made and removed again.
            (None, None) => {}
        }
    }
    for path in paths {
        scopes.insert(scope(&path)?);
    }
    outermost(scopes)
}

/// The scopes that are below no other, or their deepest common folder beyond `MAX_SCOPES`;
/// `None` for the whole library.
fn outermost(scopes: BTreeSet<RelPath>) -> Option<Vec<RelPath>> {
    let outer: Vec<RelPath> = scopes
        .iter()
        .filter(|scope| {
            !scope
                .ancestors()
                .skip(1)
                .any(|folder| scopes.contains(&folder))
        })
        .cloned()
        .collect();
    if outer.len() > MAX_SCOPES {
        let (first, rest) = outer.split_first().expect("more than one scope");
        let common = rest
            .iter()
            .try_fold(first.clone(), |common, scope| common_folder(&common, scope))?;
        return Some(vec![common]);
    }
    Some(outer)
}

/// The scope of a changed path: its longest start that the catalog can hold; `None` for the
/// whole library. A scan of a rules file covers its folder (library scan §6.4).
fn scope(path: &[OsString]) -> Option<RelPath> {
    let mut valid: Option<RelPath> = None;
    for name in path {
        let Some(next) = name
            .to_str()
            .and_then(|name| RelPath::parse(name).ok())
            .and_then(|name| name.below(valid.as_ref()).ok())
        else {
            break;
        };
        valid = Some(next);
    }
    valid
}

/// The deepest folder holding both paths; `None` for the whole library.
fn common_folder(a: &RelPath, b: &RelPath) -> Option<RelPath> {
    a.ancestors().find(|folder| b.starts_with(folder))
}

#[cfg(test)]
impl Record {
    /// A record of the path with these names, separated by `/`.
    pub(crate) fn at(action: Action, text: &str, file_id: Option<u64>) -> Self {
        Self {
            action,
            path: crate::test_support::names(text),
            file_id,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::{not_unicode, path};

    const MS: Duration = Duration::from_millis(1);

    /// A coalescer past its first full rescan, and the time.
    fn started() -> (Coalescer, Instant) {
        let now = Instant::now();
        let mut coalescer = Coalescer::new(WatchOptions::new(true), now);
        assert_eq!(coalescer.take(now), Some(Rescan::Full));
        (coalescer, now)
    }

    /// The rescan for these records, all at once, once it is due.
    fn rescan(records: &[(Action, &str, Option<u64>)]) -> Option<Rescan> {
        let (mut coalescer, now) = started();
        for &(action, text, file_id) in records {
            coalescer.record(Record::at(action, text, file_id), now);
        }
        coalescer.take(now + 300 * MS)
    }

    fn scopes(texts: &[&str]) -> Option<Rescan> {
        Some(Rescan::Scopes(
            texts.iter().map(|text| path(text)).collect(),
        ))
    }

    use Action::{Added, Modified, Removed, RenamedFrom, RenamedTo};

    #[test]
    fn merged_rescans_keep_outer_scopes_and_widen_like_one_window() {
        let at = |texts: &[&str]| Rescan::Scopes(texts.iter().map(|text| path(text)).collect());
        assert_eq!(at(&["a/b"]).merge(at(&["a", "c"])), at(&["a", "c"]));
        assert_eq!(Rescan::Metadata.merge(at(&["a"])), at(&["a"]));
        assert_eq!(at(&["a"]).merge(Rescan::Metadata), at(&["a"]));
        assert_eq!(at(&["a"]).merge(Rescan::Full), Rescan::Full);
        let many: Vec<String> = (0..=MAX_SCOPES).map(|n| format!("s/{n}")).collect();
        let (first, rest) = many.split_at(4);
        let first: Vec<&str> = first.iter().map(String::as_str).collect();
        let rest: Vec<&str> = rest.iter().map(String::as_str).collect();
        assert_eq!(at(&first).merge(at(&rest)), at(&["s"]));
        assert_eq!(
            at(&["x/1", "x/2"]).merge(at(&["y", "y"])),
            at(&["x/1", "x/2", "y"])
        );
        assert_eq!(
            at(&first).merge(at(&["t"; MAX_SCOPES])).merge(at(&rest)),
            Rescan::Full
        );
    }

    #[test]
    fn starts_with_a_full_rescan_and_repeats_it() {
        let now = Instant::now();
        let options = WatchOptions::new(true);
        let mut coalescer = Coalescer::new(options.clone(), now);
        assert_eq!(coalescer.due(), now);
        assert_eq!(coalescer.take(now), Some(Rescan::Full));
        assert_eq!(coalescer.due(), now + options.full_every);
        assert_eq!(coalescer.take(now + options.full_every - MS), None);
        assert_eq!(coalescer.take(now + options.full_every), Some(Rescan::Full));
        assert!(WatchOptions::new(false).full_every < options.full_every);
    }

    #[test]
    fn waits_for_records_to_settle_but_not_forever() {
        let (mut coalescer, now) = started();
        coalescer.record(Record::at(Modified, "a/x.md", Some(1)), now);
        assert_eq!(coalescer.due(), now + 300 * MS);
        assert_eq!(coalescer.take(now + 299 * MS), None);
        // Records every 200 ms keep it waiting, up to 3 s after the first.
        for step in 1..=20 {
            coalescer.record(
                Record::at(Modified, "a/x.md", Some(1)),
                now + step * 200 * MS,
            );
        }
        assert_eq!(coalescer.due(), now + 3000 * MS);
        assert_eq!(coalescer.take(now + 3000 * MS), scopes(&["a/x.md"]));
        assert_eq!(coalescer.take(now + 4000 * MS), None);
    }

    #[test]
    fn pairs_renames_and_moves_by_file_id() {
        // A rename in a folder.
        assert_eq!(
            rescan(&[
                (RenamedFrom, "秋/线代/x.md", Some(7)),
                (RenamedTo, "秋/线代/y.md", Some(7)),
            ]),
            scopes(&["秋/线代"])
        );
        // A move between folders: a removal and an addition with one id.
        assert_eq!(
            rescan(&[
                (Removed, "秋/线代/x.md", Some(7)),
                (Added, "秋/概率/x.md", Some(7)),
                (Modified, "秋/线代", Some(2)),
                (Modified, "秋/概率", Some(3)),
            ]),
            scopes(&["秋"])
        );
        // Between top-level folders only the whole library holds both.
        assert_eq!(
            rescan(&[(Removed, "秋/x.md", Some(7)), (Added, "春/x.md", Some(7))]),
            Some(Rescan::Full)
        );
        // A case-only rename, with the removal Windows reports first.
        assert_eq!(
            rescan(&[
                (Removed, "秋/线代/f.txt", Some(7)),
                (RenamedFrom, "秋/线代/f.txt", Some(7)),
                (RenamedTo, "秋/线代/F.txt", Some(7)),
            ]),
            scopes(&["秋/线代"])
        );
    }

    #[test]
    fn a_save_through_a_temporary_file_scopes_the_saved_path() {
        assert_eq!(
            rescan(&[
                (Added, "b/tmp.docx.part", Some(52)),
                (Modified, "b/tmp.docx.part", Some(52)),
                (RenamedFrom, "b/y.txt", Some(51)),
                (RenamedTo, "b/y.old", Some(51)),
                (RenamedFrom, "b/tmp.docx.part", Some(52)),
                (RenamedTo, "b/y.txt", Some(52)),
                (Modified, "b/y.txt", Some(52)),
                (Removed, "b/y.old", Some(51)),
            ]),
            scopes(&["b/y.txt"])
        );
        // A temporary file made and removed leaves nothing to scan.
        assert_eq!(
            rescan(&[(Added, "b/~x.tmp", Some(9)), (Removed, "b/~x.tmp", Some(9))]),
            None
        );
    }

    #[test]
    fn records_without_ids_scope_each_path() {
        assert_eq!(
            rescan(&[
                (Removed, "秋/线代/x.md", None),
                (Added, "秋/概率/x.md", None),
                (RenamedFrom, "秋/a.md", None),
                (RenamedTo, "秋/b.md", None),
            ]),
            scopes(&["秋/a.md", "秋/b.md", "秋/概率/x.md", "秋/线代/x.md"])
        );
    }

    #[test]
    fn folios_folder_has_rules_of_its_own() {
        assert_eq!(
            rescan(&[(Modified, ".folio/meta/秋/线代.json", None)]),
            Some(Rescan::Metadata)
        );
        assert_eq!(
            rescan(&[(Modified, ".folio/TAGS.JSON", None)]),
            Some(Rescan::Metadata)
        );
        assert_eq!(
            rescan(&[(Modified, ".folio/ignore", None)]),
            Some(Rescan::Full)
        );
        assert_eq!(rescan(&[(Removed, ".folio", None)]), Some(Rescan::Full));
        assert_eq!(
            rescan(&[(Added, ".folio/local/staging/1-1.part", None)]),
            None
        );
        // Scans mirror the metadata too.
        assert_eq!(
            rescan(&[
                (Modified, ".folio/meta/_root.json", None),
                (Modified, "a.md", Some(1)),
            ]),
            scopes(&["a.md"])
        );
    }

    #[test]
    fn names_the_catalog_cannot_hold_scope_their_valid_start() {
        let mut strange = Record::at(Added, "秋/x", None);
        strange.path[1] = not_unicode();
        let (mut coalescer, now) = started();
        coalescer.record(strange, now);
        coalescer.record(Record::at(Added, "秋/Cafe\u{301}.md", None), now);
        coalescer.record(Record::at(Added, "春/a:b.md", None), now);
        assert_eq!(coalescer.take(now + 300 * MS), scopes(&["春", "秋"]));
        assert_eq!(rescan(&[(Added, "NUL", None)]), Some(Rescan::Full));
    }

    #[test]
    fn merges_scopes_and_caps_their_number() {
        // `a/b.md` sorts between `a/b` and `a/b/c.md`.
        assert_eq!(
            rescan(&[
                (Modified, "a/b/c.md", Some(1)),
                (Modified, "a/b", Some(2)),
                (Modified, "a/b.md", Some(3)),
                (Modified, "a/bc.md", Some(4)),
            ]),
            scopes(&["a/b", "a/b.md", "a/bc.md"])
        );
        let nine = |text: fn(usize) -> String| {
            let texts: Vec<String> = (0..9).map(text).collect();
            let records: Vec<_> = texts
                .iter()
                .map(|text| (Modified, text.as_str(), None))
                .collect();
            rescan(&records)
        };
        assert_eq!(nine(|n| format!("秋/线代/{n}.md")), scopes(&["秋/线代"]));
        assert_eq!(nine(|n| format!("{n}/x.md")), Some(Rescan::Full));
    }

    #[test]
    fn lost_records_call_for_a_full_rescan_at_once() {
        let (mut coalescer, now) = started();
        coalescer.record(Record::at(Modified, "a.md", Some(1)), now);
        coalescer.overflow(now + MS);
        assert_eq!(coalescer.due(), now + MS);
        assert_eq!(coalescer.take(now + MS), Some(Rescan::Full));
        assert_eq!(coalescer.take(now + 400 * MS), None);
    }
}
