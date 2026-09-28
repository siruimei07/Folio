//! Ignore rules (docs/specs/library-scan.md §5).

use std::io::{self, Read};
use std::path::Path;
use std::rc::Rc;

use ignore::Match;
use ignore::gitignore::{Gitignore, GitignoreBuilder};
use unicode_normalization::UnicodeNormalization;

use super::{LibraryError, Problem};
use crate::files;
use crate::meta::Layout;
use crate::paths::{RelPath, same_name};

/// Folio's default ignore rules, in gitignore syntax. `.folio/ignore` can re-include any of them
/// with `!`.
pub const DEFAULT_IGNORE_RULES: &str = "\
# Files that operating systems leave behind
.DS_Store
._*
.AppleDouble/
.Spotlight-V100/
.Trashes/
.fseventsd/
.TemporaryItems/
Thumbs.db
ehthumbs.db
desktop.ini
$RECYCLE.BIN/
System Volume Information/
# Lock files of office suites
.~lock.*#
# Version control
.git
.svn/
.hg/
# Dependencies, caches and virtual environments of code projects
node_modules/
__pycache__/
.venv/
.ipynb_checkpoints/
.pytest_cache/
.mypy_cache/
.ruff_cache/
.gradle/
.idea/
.vs/
";

/// The most bytes read from one file of rules.
pub(super) const MAX_RULES_BYTES: u64 = 1 << 20;

/// The rules of a folder and everything below it, in gitignore syntax.
pub(super) const GITIGNORE: &str = ".gitignore";

/// The file whose presence makes a folder a Python virtual environment.
pub(super) const VENV_MARKER: &str = "pyvenv.cfg";

/// Whether a file with this name, whatever its case, decides what its folder keeps.
pub(super) fn is_rules_file(name: &str) -> bool {
    same_name(name, GITIGNORE) || same_name(name, VENV_MARKER)
}

/// What the rules say about an entry.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Verdict {
    Ignored,
    /// A rule with `!` keeps it.
    Kept,
    Unmatched,
}

impl From<Match<&ignore::gitignore::Glob>> for Verdict {
    fn from(matched: Match<&ignore::gitignore::Glob>) -> Self {
        match matched {
            Match::None => Self::Unmatched,
            Match::Ignore(_) => Self::Ignored,
            Match::Whitelist(_) => Self::Kept,
        }
    }
}

/// Names that are left out whatever the rules say: iCloud never syncs them (ADR-0003 §7), so a
/// remote could not hold them, and macOS keeps a folder's icon in `Icon\r`.
pub(super) fn is_always_ignored(name: &str) -> bool {
    let ends_with = |suffix: &str| {
        name.len() >= suffix.len()
            && name.as_bytes()[name.len() - suffix.len()..].eq_ignore_ascii_case(suffix.as_bytes())
    };
    name.starts_with("~$") || ends_with(".tmp") || ends_with(".nosync") || name == "Icon\r"
}

/// The rules of one library: the defaults, then `.folio/ignore`, in one matcher, so that
/// `.folio/ignore` can override the defaults.
pub(super) struct Rules {
    library: Gitignore,
    root: Box<Path>,
}

impl Rules {
    /// Reads `.folio/ignore`; a missing file has no rules. Invalid lines are reported and
    /// skipped.
    pub fn load(layout: &Layout, problems: &mut Vec<Problem>) -> Result<Self, LibraryError> {
        let text = layout.read_ignore()?.unwrap_or_default();
        let mut builder = builder(layout.root());
        add_lines(&mut builder, DEFAULT_IGNORE_RULES, None, problems);
        add_lines(&mut builder, &text, None, problems);
        Ok(Self {
            library: build(&builder, None, problems),
            root: layout.root().into(),
        })
    }

    /// What the rules say about `path`: NFC, relative to the library root, a folder if `is_dir`.
    /// The nearest `.gitignore` that has an opinion decides, then the library's rules.
    pub fn verdict(&self, gitignores: &Gitignores, path: &str, is_dir: bool) -> Verdict {
        for layer in gitignores.0.iter().rev() {
            let relative = match &layer.folder {
                None => path,
                Some(folder) => &path[folder.as_str().len() + 1..],
            };
            match Verdict::from(layer.rules.matched(Path::new(relative), is_dir)) {
                Verdict::Unmatched => {}
                decided => return decided,
            }
        }
        self.library.matched(Path::new(path), is_dir).into()
    }

    /// `gitignores` with the rules of the `.gitignore` in `folder` (`None`: the library root)
    /// added. Invalid lines are reported and skipped.
    pub fn with_gitignore(
        &self,
        gitignores: &Gitignores,
        folder: Option<&RelPath>,
        file: &RelPath,
        text: &str,
        problems: &mut Vec<Problem>,
    ) -> Gitignores {
        let mut builder = builder(&self.root);
        add_lines(&mut builder, text, Some(file), problems);
        let mut layers = gitignores.0.clone();
        layers.push(Rc::new(Layer {
            folder: folder.cloned(),
            rules: build(&builder, Some(file), problems),
        }));
        Gitignores(layers)
    }
}

/// The `.gitignore` files that apply inside one folder: its own and its ancestors', the deepest
/// last.
#[derive(Clone, Default)]
pub(super) struct Gitignores(Vec<Rc<Layer>>);

struct Layer {
    folder: Option<RelPath>,
    rules: Gitignore,
}

/// A matcher for rules relative to the folder of their file. Candidates are relative to that
/// folder too: the matcher only strips `root` from candidates that start with it, which relative
/// ones never do, so any absolute `root` will do.
fn builder(root: &Path) -> GitignoreBuilder {
    let mut builder = GitignoreBuilder::new(root);
    // NTFS ignores case, and so do Git's rules on Windows (`core.ignorecase`).
    builder
        .case_insensitive(true)
        .expect("setting case insensitivity never fails");
    builder
}

fn add_lines(
    builder: &mut GitignoreBuilder,
    text: &str,
    file: Option<&RelPath>,
    problems: &mut Vec<Problem>,
) {
    for (index, line) in text.lines().enumerate() {
        // Names are NFC, so rules must be too, whatever keyboard typed them.
        let line: String = line.nfc().collect();
        if let Err(error) = builder.add_line(None, &line) {
            problems.push(Problem::InvalidIgnoreRule {
                file: file.cloned(),
                line: index + 1,
                detail: error.to_string(),
            });
        }
    }
}

fn build(
    builder: &GitignoreBuilder,
    file: Option<&RelPath>,
    problems: &mut Vec<Problem>,
) -> Gitignore {
    builder.build().unwrap_or_else(|error| {
        problems.push(Problem::InvalidIgnoreRule {
            file: file.cloned(),
            line: 0,
            detail: error.to_string(),
        });
        Gitignore::empty()
    })
}

/// The text of a `.gitignore`, without a byte order mark, invalid UTF-8 replaced; `None` if it
/// is larger than [`MAX_RULES_BYTES`].
pub(super) fn read_rules(reader: impl Read) -> io::Result<Option<String>> {
    Ok(files::read_capped(reader, MAX_RULES_BYTES)?.map(|bytes| files::lossy_text(&bytes)))
}
