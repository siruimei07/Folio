//! Scan and hashing times on a synthetic library of 50,000 files on disk (system overview §6),
//! for each file-system adapter: `StdFileSystem`, and on Windows `WindowsFileSystem` too
//! (docs/specs/windows-adapter.md §6). Ignored by default; run it in release mode:
//!
//! ```text
//! cargo test -p folio-core --release --test scan_benchmark -- --ignored --nocapture
//! ```
//!
//! The library goes to the temporary folder, or below `FOLIO_BENCH_DIR` if that is set.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use std::time::{Instant, SystemTime};

use folio_core::catalog::Catalog;
use folio_core::fs::{FileSystem, StdFileSystem};
use folio_core::library::Library;
use folio_core::meta::{DisplayName, Layout, LibraryConfig, LibraryId, TagDefinitions};

const SEMESTERS: usize = 6;
const COURSES: usize = 8;
const FOLDERS: [&str; 5] = ["作业", "课件", "笔记", "考试", "参考资料"];
/// Files per course folder, so 6 × 8 × 5 × 208 = 49,920 files.
const FILES: usize = 208;
const EXTENSIONS: [&str; 7] = ["pdf", "docx", "pptx", "md", "txt", "xlsx", "png"];
/// Bytes per file.
const SIZE: usize = 2048;
/// Rounds over all adapters, which take turns so that none always runs on a colder cache.
const ROUNDS: usize = 2;

/// An adapter and its name.
type Adapter = (&'static str, Arc<dyn FileSystem>);

fn now() -> i64 {
    folio_core::fs::unix_ns(SystemTime::now()).unwrap()
}

fn build(root: &Path) -> usize {
    let mut count = 0;
    for semester in 0..SEMESTERS {
        for course in 0..COURSES {
            for folder in FOLDERS {
                let dir = root
                    .join(format!(
                        "{} {}",
                        2024 + semester / 2,
                        ["春", "秋"][semester % 2]
                    ))
                    .join(format!("课程 {course}"))
                    .join(folder);
                fs::create_dir_all(&dir).unwrap();
                for file in 0..FILES {
                    let extension = EXTENSIONS[file % EXTENSIONS.len()];
                    let bytes = vec![(file % 251) as u8; SIZE];
                    fs::write(dir.join(format!("第{file}讲 资料.{extension}")), bytes).unwrap();
                    count += 1;
                }
            }
        }
    }
    count
}

fn adapters(root: &Path) -> Vec<Adapter> {
    let mut adapters: Vec<Adapter> = vec![("StdFileSystem", Arc::new(StdFileSystem))];
    adapters.extend(windows_adapter(root));
    adapters
}

#[cfg(windows)]
fn windows_adapter(root: &Path) -> Option<Adapter> {
    let adapter = folio_core::win::WindowsFileSystem::open(root).unwrap();
    println!("volume: {:?}", adapter.volume());
    Some(("WindowsFileSystem", Arc::new(adapter)))
}

#[cfg(not(windows))]
fn windows_adapter(_root: &Path) -> Option<Adapter> {
    None
}

#[test]
#[ignore = "benchmark; run it in release mode with --ignored --nocapture"]
fn scans_and_hashes_fifty_thousand_files() {
    let base = std::env::var_os("FOLIO_BENCH_DIR").map_or_else(std::env::temp_dir, PathBuf::from);
    let dir = tempfile::tempdir_in(base).unwrap();
    let root = dir.path().join("library");
    let layout = Layout::new(&root);
    let config = LibraryConfig::new(DisplayName::parse("资料").unwrap()).unwrap();
    layout.write_library(&config).unwrap();
    layout.write_tags(&TagDefinitions::default()).unwrap();
    let started = Instant::now();
    let files = build(&root);
    println!(
        "created {files} files in {:.1?} in {}",
        started.elapsed(),
        root.display()
    );

    let adapters = adapters(&root);
    for round in 1..=ROUNDS {
        for (name, adapter) in &adapters {
            println!("round {round}, {name}:");
            let catalog = dir.path().join(format!("{name}-{round}.sqlite"));
            run(&root, adapter.clone(), &catalog, &config.id);
        }
    }
}

/// Times one adapter with a new catalog of its own, and leaves the library as it found it.
fn run(root: &Path, adapter: Arc<dyn FileSystem>, catalog_path: &Path, id: &LibraryId) {
    let library = Library::new(root, adapter);
    let catalog = Catalog::open(catalog_path, id).unwrap().catalog;
    let time = |label: &str, run: &mut dyn FnMut() -> usize| {
        let started = Instant::now();
        let count = run();
        println!("  {label}: {count} in {:.2?}", started.elapsed());
    };

    time("first scan (changes)", &mut || {
        library.scan(&catalog, None, now()).unwrap().changes.len()
    });
    time("scan without changes (changes)", &mut || {
        library.scan(&catalog, None, now()).unwrap().changes.len()
    });
    time("hashing (files)", &mut || {
        let report = library
            .hash_pending(&catalog, i64::MAX, &AtomicBool::new(false), &mut |_, _| {})
            .unwrap();
        report.hashed as usize
    });
    let course = root.join("2025 秋").join("课程 3");
    let renamed = course.with_file_name("课程 三");
    fs::rename(&course, &renamed).unwrap();
    time("scan after renaming a course (changes)", &mut || {
        library.scan(&catalog, None, now()).unwrap().changes.len()
    });
    fs::rename(&renamed, &course).unwrap();
    let size = fs::metadata(catalog_path).unwrap().len();
    println!("  catalog: {:.1} MB", size as f64 / 1e6);
}
