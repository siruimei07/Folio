//! Scan and hashing times on a synthetic library of 50,000 files on disk (system overview §6).
//! Ignored by default; run it in release mode:
//!
//! ```text
//! cargo test -p folio-core --release --test scan_benchmark -- --ignored --nocapture
//! ```

use std::fs;
use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use std::time::{Instant, SystemTime};

use folio_core::catalog::Catalog;
use folio_core::fs::StdFileSystem;
use folio_core::library::Library;
use folio_core::meta::{DisplayName, Layout, LibraryConfig, TagDefinitions};

const SEMESTERS: usize = 6;
const COURSES: usize = 8;
const FOLDERS: [&str; 5] = ["作业", "课件", "笔记", "考试", "参考资料"];
/// Files per course folder, so 6 × 8 × 5 × 208 = 49,920 files.
const FILES: usize = 208;
const EXTENSIONS: [&str; 7] = ["pdf", "docx", "pptx", "md", "txt", "xlsx", "png"];
/// Bytes per file.
const SIZE: usize = 2048;

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

#[test]
#[ignore = "benchmark; run it in release mode with --ignored --nocapture"]
fn scans_and_hashes_fifty_thousand_files() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("library");
    let layout = Layout::new(&root);
    let config = LibraryConfig::new(DisplayName::parse("资料").unwrap()).unwrap();
    layout.write_library(&config).unwrap();
    layout.write_tags(&TagDefinitions::default()).unwrap();
    let started = Instant::now();
    let files = build(&root);
    println!("created {files} files in {:.1?}", started.elapsed());

    let library = Library::new(&root, Arc::new(StdFileSystem));
    let catalog = Catalog::open(&dir.path().join("catalog.sqlite"), &config.id)
        .unwrap()
        .catalog;
    let time = |label: &str, run: &mut dyn FnMut() -> usize| {
        let started = Instant::now();
        let count = run();
        println!("{label}: {count} in {:.2?}", started.elapsed());
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
    fs::rename(&course, course.with_file_name("课程 三")).unwrap();
    time("scan after renaming a course (changes)", &mut || {
        library.scan(&catalog, None, now()).unwrap().changes.len()
    });
    let size = fs::metadata(dir.path().join("catalog.sqlite"))
        .unwrap()
        .len();
    println!("catalog: {:.1} MB", size as f64 / 1e6);
}
