//! Scan, hashing and text extraction times on a synthetic library of 50,000 files on disk
//! (system overview §6), for each file-system adapter: `StdFileSystem`, and on Windows
//! `WindowsFileSystem` too (docs/specs/windows-adapter.md §6). The Markdown and text files hold
//! Chinese and Latin course notes and the Word files small real documents, so extraction indexes
//! text like a student's; the other files are filler. Ignored by default; run it in release mode:
//!
//! ```text
//! cargo test -p folio-core --release --test scan_benchmark -- --ignored --nocapture
//! ```
//!
//! The library goes to the temporary folder, or below `FOLIO_BENCH_DIR` if that is set.

use std::fs;
use std::io::{Cursor, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use std::time::{Instant, SystemTime};

use folio_core::catalog::Catalog;
use folio_core::fs::{FileSystem, StdFileSystem};
use folio_core::library::Library;
use folio_core::meta::{DisplayName, Layout, LibraryConfig, LibraryId, TagDefinitions};
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipWriter};

const SEMESTERS: usize = 6;
const COURSES: usize = 8;
const FOLDERS: [&str; 5] = ["作业", "课件", "笔记", "考试", "参考资料"];
/// Files per course folder, so 6 × 8 × 5 × 208 = 49,920 files.
const FILES: usize = 208;
const EXTENSIONS: [&str; 7] = ["pdf", "docx", "pptx", "md", "txt", "xlsx", "png"];
/// Bytes per file, and of text per Markdown or text file and per Word document.
const SIZE: usize = 2048;
/// Rounds over all adapters, which take turns so that none always runs on a colder cache.
const ROUNDS: usize = 2;

/// Words of the notes, Chinese and Latin, separated by spaces.
const CHINESE: &str = "线性代数 特征值 特征向量 矩阵 向量空间 行列式 微积分 导数 积分 极限 级数 \
    收敛 概率 随机变量 期望 方差 定理 证明 引理 推论 习题 作业 考试 复习 实验 报告 函数 连续 方程 解 基 维数";
const LATIN: &str = "eigenvalue eigenvector matrix vector space determinant derivative integral \
    limit series converges probability variance expectation theorem proof lemma corollary lecture \
    homework exam review function continuous equation solution linear basis dimension kernel rank \
    orthogonal";

/// An adapter and its name.
type Adapter = (&'static str, Arc<dyn FileSystem>);

fn now() -> i64 {
    folio_core::fs::unix_ns(SystemTime::now()).unwrap()
}

/// Course notes of `SIZE` bytes for file `seed`: sentences of Chinese and Latin words in turn,
/// one per line, from a fixed random sequence.
fn notes(seed: usize) -> String {
    let chinese_words: Vec<_> = CHINESE.split_whitespace().collect();
    let latin_words: Vec<_> = LATIN.split_whitespace().collect();
    let mut state = (seed as u64).wrapping_mul(0x9E37_79B9_7F4A_7C15) | 1;
    let mut next = |bound: usize| {
        // xorshift64
        state ^= state << 13;
        state ^= state >> 7;
        state ^= state << 17;
        (state % bound as u64) as usize
    };
    let mut text = String::with_capacity(SIZE + 64);
    let mut chinese = seed.is_multiple_of(2);
    while text.len() < SIZE {
        let words = 6 + next(7);
        if chinese {
            for _ in 0..words {
                text.push_str(chinese_words[next(chinese_words.len())]);
            }
            text.push_str("。\n");
        } else {
            for index in 0..words {
                if index > 0 {
                    text.push(' ');
                }
                text.push_str(latin_words[next(latin_words.len())]);
            }
            text.push_str(".\n");
        }
        chinese = !chinese;
    }
    text.truncate(text.floor_char_boundary(SIZE));
    while text.len() < SIZE {
        text.push('\n');
    }
    text
}

/// A Word document whose paragraphs are the lines of `text`, deflated as Word writes it.
fn docx(text: &str) -> Vec<u8> {
    let body: String = text
        .lines()
        .filter(|line| !line.is_empty())
        .map(|line| format!("<w:p><w:r><w:t>{line}</w:t></w:r></w:p>"))
        .collect();
    let parts = [
        (
            "[Content_Types].xml",
            r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>"#.to_owned(),
        ),
        (
            "_rels/.rels",
            r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>"#.to_owned(),
        ),
        (
            "word/document.xml",
            format!(
                r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>{body}<w:sectPr/></w:body></w:document>"#
            ),
        ),
    ];
    let mut zip = ZipWriter::new(Cursor::new(Vec::new()));
    let options = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
    for (name, content) in parts {
        zip.start_file(name, options).unwrap();
        zip.write_all(content.as_bytes()).unwrap();
    }
    zip.finish().unwrap().into_inner()
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
                    let bytes = match extension {
                        "md" | "txt" => notes(count).into_bytes(),
                        "docx" => docx(&notes(count)),
                        _ => vec![(file % 251) as u8; SIZE],
                    };
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

/// The catalog's size on disk: the database and its write-ahead log.
fn catalog_size(path: &Path) -> f64 {
    let mut wal = path.as_os_str().to_owned();
    wal.push("-wal");
    let size = |path: &Path| fs::metadata(path).map_or(0, |metadata| metadata.len());
    (size(path) + size(Path::new(&wal))) as f64 / 1e6
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
    println!(
        "  catalog after hashing: {:.1} MB",
        catalog_size(catalog_path)
    );
    // The same rename before and after extraction: search bodies make updating search rows dearer.
    let course = root.join("2025 秋").join("课程 3");
    let renamed = course.with_file_name("课程 三");
    let rename_scan = |label: &str| {
        fs::rename(&course, &renamed).unwrap();
        time(label, &mut || {
            library.scan(&catalog, None, now()).unwrap().changes.len()
        });
        fs::rename(&renamed, &course).unwrap();
        library.scan(&catalog, None, now()).unwrap();
        // A scan without file ids may see the moved files as new ones.
        library
            .hash_pending(&catalog, i64::MAX, &AtomicBool::new(false), &mut |_, _| {})
            .unwrap();
    };
    rename_scan("scan after renaming a course, before extraction (changes)");
    let extract = |label: &str| {
        time(label, &mut || {
            let report = library
                .extract_pending(&catalog, &AtomicBool::new(false), &mut |_, _| {})
                .unwrap();
            assert!(report.complete && report.problems.is_empty(), "{report:?}");
            report.extracted as usize
        });
    };
    extract("text extraction (files)");
    extract("text extraction with nothing pending (files)");
    println!(
        "  catalog after extraction: {:.1} MB",
        catalog_size(catalog_path)
    );
    rename_scan("scan after renaming a course (changes)");
    extract("text extraction after renaming a course and back (files)");
    println!("  catalog: {:.1} MB", catalog_size(catalog_path));
}
