//! Index size and query latency of the search table on a synthetic library (ADR-0002 action
//! item 4): 50,000 entries, 10,000 of them with body text. Ignored by default; run it in release
//! mode, where SQLite is compiled with optimisations:
//!
//! ```text
//! cargo test -p folio-core --release --test search_benchmark -- --ignored --nocapture
//! ```

use std::fmt::Write as _;
use std::ops::ControlFlow;
use std::path::Path;
use std::time::{Duration, Instant};

use folio_core::search::{Mode, TOKENIZER_NAME, phrase, register_tokenizer, tokenize};
use rusqlite::{Connection, OpenFlags, TransactionBehavior, params};

const ENTRIES: usize = 50_000;
/// Every fifth entry has body text.
const BODY_EVERY: usize = 5;
/// Body lengths in characters are log-uniform between these bounds (mean about 4,300).
const BODY_CHARS: (f64, f64) = (200.0, 20_000.0);
/// Rows per write transaction.
const BATCH: usize = 1_000;
/// Timed runs per query, after one warm-up run.
const RUNS: usize = 10;
/// Results shown per page.
const TOP: usize = 50;
/// Column weights in column order: name > tags > path > body (ADR-0002 §5).
const RANK: &str = "bm25(search, 10.0, 3.0, 5.0, 1.0)";

const SEMESTERS: [&str; 6] = [
    "2024 春", "2024 秋", "2025 春", "2025 秋", "2026 春", "2026 秋",
];
const FOLDERS: [&str; 5] = ["作业", "课件", "笔记", "考试", "参考资料"];
const TAGS: [&str; 5] = ["笔记", "课件", "作业", "考试", "参考"];
const EXTENSIONS: [&str; 7] = ["pdf", "docx", "pptx", "md", "txt", "xlsx", "png"];
const PUNCTUATION: [&str; 8] = ["，", "。", "、", "；", "：", "！", "？", "\n"];

/// SplitMix64 with a fixed seed, so every run indexes the same library.
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }

    /// Uniform in `0.0..1.0`.
    fn unit(&mut self) -> f64 {
        (self.next() >> 11) as f64 / (1u64 << 53) as f64
    }

    fn below(&mut self, n: usize) -> usize {
        (self.unit() * n as f64) as usize
    }
}

/// Ranks `0..n` drawn with probability proportional to `1 / (rank + 1)`: Zipf's law, which
/// character and word frequencies roughly follow.
struct Zipf(Vec<f64>);

impl Zipf {
    fn new(n: usize) -> Self {
        let mut total = 0.0;
        Zipf(
            (1..=n)
                .map(|rank| {
                    total += 1.0 / rank as f64;
                    total
                })
                .collect(),
        )
    }

    fn sample(&self, rng: &mut Rng) -> usize {
        let x = rng.unit() * self.0[self.0.len() - 1];
        self.0.partition_point(|&cumulative| cumulative <= x)
    }
}

/// Words ranked by frequency, most frequent first.
struct Vocabulary {
    chars: Vec<char>,
    chinese: Vec<String>,
    latin: Vec<String>,
    chinese_rank: Zipf,
    latin_rank: Zipf,
}

impl Vocabulary {
    fn new(rng: &mut Rng) -> Self {
        // 3,500 characters, the size of the common-character list taught in Chinese schools.
        let chars: Vec<char> = (0..3_500)
            .map(|i| char::from_u32(0x4E00 + 5 * i).unwrap())
            .collect();
        let char_rank = Zipf::new(chars.len());
        let chinese: Vec<String> = (0..30_000)
            .map(|_| {
                let len = match rng.below(20) {
                    0..2 => 1,
                    2..15 => 2,
                    15..18 => 3,
                    _ => 4,
                };
                (0..len).map(|_| chars[char_rank.sample(rng)]).collect()
            })
            .collect();
        let latin: Vec<String> = (0..5_000)
            .map(|_| {
                (0..2 + rng.below(9))
                    .map(|_| char::from(b'a' + rng.below(26) as u8))
                    .collect()
            })
            .collect();
        Vocabulary {
            chinese_rank: Zipf::new(chinese.len()),
            latin_rank: Zipf::new(latin.len()),
            chars,
            chinese,
            latin,
        }
    }

    fn chinese_word(&self, rng: &mut Rng) -> &str {
        &self.chinese[self.chinese_rank.sample(rng)]
    }

    fn latin_word(&self, rng: &mut Rng) -> &str {
        &self.latin[self.latin_rank.sample(rng)]
    }

    /// About `chars` characters of running text: Chinese words without spaces between them,
    /// Latin words, punctuation and line breaks.
    fn text(&self, rng: &mut Rng, chars: usize) -> String {
        let mut text = String::new();
        let mut count = 0;
        while count < chars {
            match rng.below(100) {
                0..85 => {
                    let word = self.chinese_word(rng);
                    text.push_str(word);
                    count += word.chars().count();
                }
                85..95 => {
                    let word = self.latin_word(rng);
                    write!(text, " {word} ").unwrap();
                    count += word.len() + 2;
                }
                _ => {
                    text.push_str(PUNCTUATION[rng.below(PUNCTUATION.len())]);
                    count += 1;
                }
            }
        }
        text
    }
}

struct Entry {
    name: String,
    path: String,
    tags: String,
    body: Option<String>,
}

fn library(rng: &mut Rng, vocabulary: &Vocabulary) -> Vec<Entry> {
    let courses: Vec<String> = (0..40)
        .map(|_| {
            format!(
                "{}{}",
                vocabulary.chinese_word(rng),
                vocabulary.chinese_word(rng)
            )
        })
        .collect();
    (0..ENTRIES)
        .map(|i| {
            let mut name = String::new();
            for _ in 0..1 + rng.below(3) {
                name.push_str(vocabulary.chinese_word(rng));
            }
            if rng.below(3) == 0 {
                write!(name, " {}", vocabulary.latin_word(rng)).unwrap();
            }
            if rng.below(2) == 0 {
                write!(name, " 第{}讲", 1 + rng.below(16)).unwrap();
            }
            write!(name, ".{}", EXTENSIONS[rng.below(EXTENSIONS.len())]).unwrap();
            let path = format!(
                "{}/{}/{}/{name}",
                SEMESTERS[rng.below(SEMESTERS.len())],
                courses[rng.below(courses.len())],
                FOLDERS[rng.below(FOLDERS.len())],
            );
            let tags: Vec<&str> = (0..rng.below(3))
                .map(|_| TAGS[rng.below(TAGS.len())])
                .collect();
            let body = (i % BODY_EVERY == 0).then(|| {
                let (low, high) = BODY_CHARS;
                let chars = low * (high / low).powf(rng.unit());
                vocabulary.text(rng, chars as usize)
            });
            Entry {
                name,
                path,
                tags: tags.join(" "),
                body,
            }
        })
        .collect()
}

fn build(path: &Path, options: &str, entries: &[Entry]) -> Duration {
    let mut conn = Connection::open(path).unwrap();
    register_tokenizer(&conn).unwrap();
    conn.execute_batch(&format!(
        "PRAGMA journal_mode = WAL;
         PRAGMA synchronous = NORMAL;
         PRAGMA temp_store = MEMORY;
         CREATE VIRTUAL TABLE search USING fts5(
             name, path, tags, body, tokenize = '{TOKENIZER_NAME}', detail = full{options}
         );"
    ))
    .unwrap();
    let start = Instant::now();
    for batch in entries.chunks(BATCH) {
        let transaction = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .unwrap();
        {
            let mut insert = transaction
                .prepare_cached(
                    "INSERT INTO search (name, path, tags, body) VALUES (?1, ?2, ?3, ?4)",
                )
                .unwrap();
            for entry in batch {
                insert
                    .execute(params![entry.name, entry.path, entry.tags, entry.body])
                    .unwrap();
            }
        }
        transaction.commit().unwrap();
    }
    start.elapsed()
}

/// Bytes in use: pages minus free pages.
fn used_bytes(conn: &Connection) -> f64 {
    conn.query_row(
        "SELECT (SELECT page_count FROM pragma_page_count())
              - (SELECT freelist_count FROM pragma_freelist_count()),
                (SELECT page_size FROM pragma_page_size())",
        [],
        |row| Ok(row.get::<_, i64>(0)? as f64 * row.get::<_, i64>(1)? as f64),
    )
    .unwrap()
}

/// Bytes per table, largest first.
fn table_bytes(conn: &Connection) -> Vec<(String, f64)> {
    conn.prepare("SELECT name, sum(pgsize) FROM dbstat GROUP BY name ORDER BY 2 DESC")
        .unwrap()
        .query_map([], |row| Ok((row.get(0)?, row.get::<_, i64>(1)? as f64)))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap()
}

/// The median and the slowest of [`RUNS`] runs, after one warm-up run.
fn time(mut run: impl FnMut()) -> (Duration, Duration) {
    run();
    let mut times: Vec<Duration> = (0..RUNS)
        .map(|_| {
            let start = Instant::now();
            run();
            start.elapsed()
        })
        .collect();
    times.sort();
    (times[RUNS / 2], times[RUNS - 1])
}

fn ms((median, slowest): (Duration, Duration)) -> String {
    format!(
        "{:.1}/{:.1}",
        median.as_secs_f64() * 1e3,
        slowest.as_secs_f64() * 1e3
    )
}

fn mb(bytes: f64) -> String {
    format!("{:.1} MB", bytes / 1e6)
}

/// The first run of `len` Chinese characters in `text`.
fn chinese_run(text: &str, len: usize) -> String {
    let chars: Vec<char> = text.chars().collect();
    chars
        .windows(len)
        .find(|run| run.iter().all(|ch| ('\u{4E00}'..='\u{9FFF}').contains(ch)))
        .unwrap()
        .iter()
        .collect()
}

/// Labels and MATCH expressions.
fn queries(vocabulary: &Vocabulary, entries: &[Entry]) -> Vec<(String, String)> {
    let pair = |rank: usize| {
        vocabulary
            .chinese
            .iter()
            .filter(|word| word.chars().count() == 2)
            .nth(rank)
            .unwrap()
            .clone()
    };
    let body = entries[BODY_EVERY * 7].body.as_deref().unwrap();
    let common = vocabulary.chars[0].to_string();
    let latin = vocabulary.latin.iter().find(|word| word.len() > 3).unwrap();
    let terms = [
        ("1 char, most common", common.clone()),
        ("1 char, rank 1000", vocabulary.chars[1000].to_string()),
        ("2 chars, most common word", pair(0)),
        ("2 chars, word rank 2000", pair(2000)),
        ("4 chars from a body", chinese_run(body, 4)),
        ("8 chars from a body", chinese_run(body, 8)),
        ("Latin word, common", latin.clone()),
    ];
    let mut queries: Vec<(String, String)> = terms
        .into_iter()
        .map(|(label, term)| (format!("{label} {term}"), phrase(&term)))
        .collect();
    for len in 1..=3 {
        let prefix = &latin[..len];
        queries.push((
            format!("Latin prefix, {len} letters {prefix}*"),
            format!("{} *", phrase(prefix)),
        ));
    }
    queries.push((
        format!("1 char, most common, names only {common}"),
        format!("{{name path tags}} : {}", phrase(&common)),
    ));
    queries
}

fn measure(path: &Path, queries: &[(String, String)]) {
    let conn = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
    register_tokenizer(&conn).unwrap();
    conn.execute_batch("PRAGMA temp_store = MEMORY;").unwrap();
    println!(
        "{:<44} {:>7} {:>11} {:>11} {:>13} {:>13} {:>13}",
        "query (times: median/slowest ms)",
        "matches",
        "count",
        "top 50",
        "+ by rowid",
        "+ filtered",
        "ranked+snip"
    );
    for (label, query) in queries {
        let count = || -> i64 {
            conn.prepare_cached("SELECT count(*) FROM search WHERE search MATCH ?1")
                .unwrap()
                .query_row([query], |row| row.get(0))
                .unwrap()
        };
        let top = || -> Vec<i64> {
            conn.prepare_cached(&format!(
                "SELECT rowid FROM search WHERE search MATCH ?1 ORDER BY {RANK} LIMIT {TOP}"
            ))
            .unwrap()
            .query_map([query], |row| row.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap()
        };
        // What the results page needs: the name highlighted and a snippet of the body. First one
        // query per row.
        let by_rowid = |rowids: &[i64]| {
            let mut select = conn
                .prepare_cached(
                    "SELECT highlight(search, 0, '[', ']'), snippet(search, 3, '[', ']', '…', 16)
                     FROM search WHERE search MATCH ?1 AND rowid = ?2",
                )
                .unwrap();
            for rowid in rowids {
                select
                    .query_row(params![query, rowid], |row| {
                        Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?))
                    })
                    .unwrap();
            }
        };
        // Then one query that runs the match once and skips the other rows. `+` keeps the rowid
        // test out of the FTS5 plan, which would otherwise run the match once per rowid.
        let filtered = |rowids: &[i64]| {
            let ids: Vec<String> = rowids.iter().map(i64::to_string).collect();
            let rows = conn
                .prepare_cached(
                    "SELECT highlight(search, 0, '[', ']'), snippet(search, 3, '[', ']', '…', 16)
                     FROM search
                     WHERE search MATCH ?1 AND +rowid IN (SELECT value FROM json_each(?2))",
                )
                .unwrap()
                .query_map(params![query, format!("[{}]", ids.join(","))], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?))
                })
                .unwrap()
                .map(Result::unwrap)
                .count();
            assert_eq!(rows, rowids.len());
        };
        // The same page from the ranked query, which computes the snippets of every match.
        let ranked_with_snippets = || {
            conn.prepare_cached(&format!(
                "SELECT rowid, highlight(search, 0, '[', ']'), snippet(search, 3, '[', ']', '…', 16)
                 FROM search WHERE search MATCH ?1 ORDER BY {RANK} LIMIT {TOP}"
            ))
            .unwrap()
            .query_map([query], |row| row.get::<_, i64>(0))
            .unwrap()
            .for_each(|row| {
                row.unwrap();
            });
        };
        println!(
            "{label:<44} {:>7} {:>11} {:>11} {:>13} {:>13} {:>13}",
            count(),
            ms(time(|| {
                count();
            })),
            ms(time(|| {
                top();
            })),
            ms(time(|| by_rowid(&top()))),
            ms(time(|| filtered(&top()))),
            ms(time(ranked_with_snippets)),
        );
    }
}

#[test]
#[ignore = "benchmark; run it in release mode with --ignored --nocapture"]
fn normalization_path_throughput() {
    let samples = [
        (
            "Han with one full-width letter",
            format!("{}Ａ", "线".repeat(1_048_576 / 3)),
        ),
        (
            "compatibility expansion FDFA",
            "\u{FDFA}".repeat(1_048_576 / 3),
        ),
        (
            "combining marks",
            format!("a{}", "\u{301}".repeat(1_048_576 / 2)),
        ),
    ];
    for (label, text) in samples {
        for mode in [Mode::Document, Mode::Highlight] {
            let start = Instant::now();
            let mut count = 0;
            let _ = tokenize(&text, mode, &mut |_| {
                count += 1;
                ControlFlow::Continue(())
            });
            assert!(count > 0);
            let elapsed = start.elapsed().as_secs_f64();
            println!(
                "normalization stress, {label}, {mode:?}: {} bytes, {count} tokens, {:.3} s ({:.1} MB/s)",
                text.len(),
                elapsed,
                text.len() as f64 / 1e6 / elapsed
            );
        }
    }
}

#[test]
#[ignore = "benchmark; run it in release mode with --ignored --nocapture"]
fn index_size_and_query_latency() {
    println!("SQLite {}", rusqlite::version());
    let mut rng = Rng(0x466F_6C69_6F21); // "Folio!"
    let vocabulary = Vocabulary::new(&mut rng);
    let entries = library(&mut rng, &vocabulary);

    let bodies: Vec<&str> = entries
        .iter()
        .filter_map(|entry| entry.body.as_deref())
        .collect();
    let body_bytes: usize = bodies.iter().map(|body| body.len()).sum();
    let body_chars: usize = bodies.iter().map(|body| body.chars().count()).sum();
    let other_bytes: usize = entries
        .iter()
        .map(|entry| entry.name.len() + entry.path.len() + entry.tags.len())
        .sum();
    let common = vocabulary.chars[0];
    let common_share = bodies
        .iter()
        .map(|body| body.chars().filter(|&ch| ch == common).count())
        .sum::<usize>() as f64
        / body_chars as f64;
    println!(
        "corpus: {} entries, {} with body text; bodies {:.1} M characters ({}), \
         names, paths and tags {}; the most common character is {:.1}% of body text",
        entries.len(),
        bodies.len(),
        body_chars as f64 / 1e6,
        mb(body_bytes as f64),
        mb(other_bytes as f64),
        common_share * 100.0,
    );

    for mode in [Mode::Document, Mode::Highlight] {
        let start = Instant::now();
        let mut tokens = 0usize;
        for body in &bodies {
            let _ = tokenize(body, mode, &mut |_| {
                tokens += 1;
                ControlFlow::Continue(())
            });
        }
        let elapsed = start.elapsed();
        println!(
            "tokenizer alone, {mode:?} mode: {:.1} M tokens from the bodies in {:.2} s ({:.0} MB/s)",
            tokens as f64 / 1e6,
            elapsed.as_secs_f64(),
            body_bytes as f64 / 1e6 / elapsed.as_secs_f64(),
        );
    }

    let queries = queries(&vocabulary, &entries);
    let dir = tempfile::tempdir().unwrap();
    let variants = [
        ("no prefix index", ""),
        ("prefix = '3'", ", prefix = '3'"),
        ("prefix = '2 3'", ", prefix = '2 3'"),
    ];
    for (index, (variant, options)) in variants.into_iter().enumerate() {
        let path = dir.path().join(format!("catalog-{index}.sqlite"));
        let elapsed = build(&path, options, &entries);
        let conn = Connection::open(&path).unwrap();
        register_tokenizer(&conn).unwrap();
        let built = used_bytes(&conn);
        let tables: Vec<String> = table_bytes(&conn)
            .into_iter()
            .take(4)
            .map(|(name, bytes)| format!("{name} {}", mb(bytes)))
            .collect();
        println!(
            "\n[{variant}] built in {:.1} s; {} in use ({})",
            elapsed.as_secs_f64(),
            mb(built),
            tables.join(", "),
        );
        measure(&path, &queries);
        let start = Instant::now();
        conn.execute("INSERT INTO search (search) VALUES ('optimize')", [])
            .unwrap();
        println!(
            "after 'optimize' ({:.1} s): {} in use",
            start.elapsed().as_secs_f64(),
            mb(used_bytes(&conn)),
        );
    }
}
