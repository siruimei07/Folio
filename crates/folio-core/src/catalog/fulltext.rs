//! Full-text search over the catalog (ADR-0002 §5, docs/specs/library-core.md §6).

use rusqlite::{Connection, OptionalExtension, params};

use super::entries::{self, COLUMNS};
use super::{CatalogError, Entry, EntryId};
use crate::search::SearchQuery;

/// The most body text kept per entry.
pub const MAX_BODY_BYTES: usize = 1 << 20;

/// Highlight markers: no Windows name contains them, and they are removed from body text.
const OPEN: char = '\u{1}';
const CLOSE: char = '\u{2}';

/// Column weights in column order (name, path, tags, body): name > tags > path > body.
const RANK: &str = "bm25(search, 10.0, 3.0, 5.0, 1.0)";

/// A match and its score; higher is better.
#[derive(Debug, Clone, PartialEq)]
pub struct Hit {
    pub entry: Entry,
    pub score: f64,
}

/// Text with its matches marked, to render as text (never as HTML).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Span {
    pub text: String,
    pub matched: bool,
}

/// What a result row shows: the name with its matches, and a snippet of the body if it has one.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HitText {
    pub name: Vec<Span>,
    pub snippet: Option<Vec<Span>>,
}

/// Sets the searchable text of an entry, or clears it. The text is cut to [`MAX_BODY_BYTES`] at
/// a character boundary, and NUL and the highlight markers are removed.
pub fn set_body(conn: &Connection, entry: EntryId, body: Option<&str>) -> Result<(), CatalogError> {
    let body = body.map(|text| {
        text[..text.floor_char_boundary(MAX_BODY_BYTES)]
            .chars()
            .filter(|&ch| !matches!(ch, '\0' | OPEN | CLOSE))
            .collect::<String>()
    });
    let changed = conn
        .prepare_cached("UPDATE search SET body = ?2 WHERE rowid = ?1")?
        .execute(params![entry.0, body])?;
    if changed == 0 {
        return Err(CatalogError::NoEntry(entry));
    }
    Ok(())
}

/// The best `limit` matches. The best `max(4 × limit, 100)` by weighted bm25 are re-ranked with a
/// recency boost (up to 1.5, halving every 30 days since the entry was modified); ties go to the
/// shorter path. `now` is in seconds since the Unix epoch.
pub fn search(
    conn: &Connection,
    query: &SearchQuery,
    limit: u32,
    now: i64,
) -> Result<Vec<Hit>, CatalogError> {
    let candidates = (i64::from(limit) * 4).max(100);
    // The inner query ranks and cuts before the join, so only the candidates are looked up.
    let mut hits = conn
        .prepare_cached(&format!(
            "SELECT {COLUMNS}, ranked.score FROM (
                 SELECT rowid, {RANK} AS score FROM search WHERE search MATCH ?1
                 ORDER BY score LIMIT ?2) AS ranked
             JOIN entries ON entries.id = ranked.rowid"
        ))?
        .query_map(params![query.expression(), candidates], |row| {
            let entry = entries::from_row(row)?;
            let score = -row.get::<_, f64>(9)? * recency_boost(entry.record.mtime_ns, now);
            Ok(Hit { entry, score })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    hits.sort_by(|a, b| {
        let (a_path, b_path) = (a.entry.record.path.as_str(), b.entry.record.path.as_str());
        b.score
            .total_cmp(&a.score)
            .then(a_path.len().cmp(&b_path.len()))
            .then(a_path.cmp(b_path))
    });
    hits.truncate(limit as usize);
    Ok(hits)
}

fn recency_boost(mtime_ns: Option<i64>, now: i64) -> f64 {
    let Some(mtime_ns) = mtime_ns else {
        return 1.0;
    };
    let age_days = (now - mtime_ns.div_euclid(1_000_000_000)).max(0) as f64 / 86_400.0;
    1.0 + 0.5 * 0.5_f64.powf(age_days / 30.0)
}

/// The marked name and body snippet of one result, or `None` if `entry` does not match. Run it
/// only for the rows on screen: FTS5 would compute these for every match in a ranked query.
pub fn hit_text(
    conn: &Connection,
    query: &SearchQuery,
    entry: EntryId,
) -> Result<Option<HitText>, CatalogError> {
    let row = conn
        .prepare_cached(
            "SELECT highlight(search, 0, char(1), char(2)),
                    snippet(search, 3, char(1), char(2), '…', 16)
             FROM search WHERE search MATCH ?1 AND rowid = ?2",
        )?
        .query_row(params![query.expression(), entry.0], |row| {
            // `snippet()` is NULL when the entry has no body.
            Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?))
        })
        .optional()?;
    Ok(row.map(|(name, snippet)| HitText {
        name: spans(&name),
        snippet: snippet
            .map(|snippet| spans(&snippet))
            .filter(|spans| !spans.is_empty()),
    }))
}

fn spans(marked: &str) -> Vec<Span> {
    let mut spans = Vec::new();
    let mut text = String::new();
    let mut matched = false;
    for ch in marked.chars() {
        if ch == OPEN || ch == CLOSE {
            if !text.is_empty() {
                spans.push(Span {
                    text: std::mem::take(&mut text),
                    matched,
                });
            }
            matched = ch == OPEN;
        } else {
            text.push(ch);
        }
    }
    if !text.is_empty() {
        spans.push(Span { text, matched });
    }
    spans
}
