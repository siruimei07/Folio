# ADR-0002: Data storage

- **Status:** Accepted (Sirui, 2026-09-26). Amended 2026-09-27 with the six refinements of
  [`library-core.md`](../specs/library-core.md) §9, approved by Sirui.
  M1 metadata amendments approved by Sirui on 2026-09-29: shared format version 2,
  optional course fields, preset palette keys and folder-tag filtering (§3).
  In-app move recovery extension approved by Sirui on 2026-09-30 (§1): a durable local
  operation intent preserves metadata and entry identities until reconciliation commits.
- **Date:** 2026-09-26
- **Deciders:** Sirui Mei
- **Inputs:**
  - [`docs/product/brief.md`](../product/brief.md) §5, §9 and §12;
  - [`docs/specs/system-overview.md`](../specs/system-overview.md) §5;
  - [ADR-0001](ADR-0001-application-stack.md).

  Versions and facts were checked against primary sources on 2026-09-26.

## Context

ADR-0001 puts all storage in the Rust core. The UI never touches storage, and the shell only calls
the core. Folio holds six kinds of state (system overview §5):

1. **User files** in the library folders.
2. **Synced library data** that the user authors:
   - tag definitions and tag assignments;
   - semester and course settings;
   - library-wide rules (what to ignore, which files get full versions).

   It must sync between PCs through Folio's history (ADR-0003), merge when two PCs change different
   things, and stay readable by a future Swift app.
3. **Local derived data**: the catalog of entries (paths, sizes, hashes), extracted text, the
   full-text index, thumbnails.
4. **Local settings**: library and remote paths, device id and name, theme, AI options.
5. **Secrets**: the DeepSeek key, kept in Windows Credential Manager (ADR-0001).
6. **Logs.**

Requirements:

- 50,000 entries per library. Search results about 200 ms after typing stops.
- 1–2 character Chinese queries (`线代`, `期中`) must match as contiguous substrings in names,
  paths, tags and text. SQLite's trigram tokenizer cannot match anything shorter than 3 characters,
  and `unicode61` treats a whole run of Han characters as one token, so neither works on its own.
- Losing or corrupting the local database must never lose anything the user authored.
- Every format is versioned from the first release, with migrations and migration tests
  (CLAUDE.md §5).
- Synced formats are language-neutral (UTF-8 JSON), so a Swift app can read them.
- The database must stay out of cloud-synced folders. Sync clients copy databases mid-transaction
  and separate them from their `-wal` files, which are the corruption patterns in
  sqlite.org/howtocorrupt.html.

## Decision

### 1. Principle

**Text files are the source of truth for everything the user authors. SQLite is a local, derived,
rebuildable catalog and index.**

Writes go to the metadata file first (atomically), then to the catalog. On start-up the catalog
reconciles itself from the files, so a crash between the two steps loses nothing.

An in-app rename/move records its validated source, destination and catalogued subtree
identities before changing metadata or the disk. Recovery accepts only a matching source
or destination state; conflicts and unreadable identity evidence stop recovery with a typed
error and retain the journal and authored files. The intent is cleared after reconciliation
commits, so another crash during recovery remains retryable, including without file IDs.
This is local recovery data, not a synced metadata format change (Sirui, 2026-09-30).

### 2. Where state lives

`<app-id>` below is the Tauri bundle identifier, chosen at scaffold time.

| State | Location | Format | Synced | Rebuildable |
|---|---|---|---|---|
| User files | Library folder | As-is | Yes (ADR-0003) | — |
| Library config: id, name, versioning rules (fully versioned extensions, 10 MB text limit) | `.folio/library.json` | JSON | Yes | No |
| Ignore rules | `.folio/ignore` | gitignore syntax | Yes | No |
| Tag definitions | `.folio/tags.json` | JSON | Yes | No |
| Semester settings, plus tags of files directly in the semester folder | `.folio/meta/<semester>/_group.json` | JSON | Yes | No |
| Course settings, plus tags of files in the course | `.folio/meta/<semester>/<course>.json` | JSON | Yes | No |
| Tags of files at the library root | `.folio/meta/_root.json` | JSON | Yes | No |
| History store | `.folio/` (layout in ADR-0003) | ADR-0003 | Yes | No |
| Catalog, extracted text, full-text index, thumbnail index | `%LOCALAPPDATA%\<app-id>\libraries\<library-id>\catalog.sqlite` | SQLite | No | Yes |
| Thumbnails | `%LOCALAPPDATA%\<app-id>\cache\` | Image files keyed by content hash; LRU cap 2 GB by default | No | Yes |
| Settings (per machine) | `%LOCALAPPDATA%\<app-id>\settings.json` | JSON | No | No (small; re-enter) |
| DeepSeek API key | Windows Credential Manager | — | No | Re-enter |
| Logs | `%LOCALAPPDATA%\<app-id>\logs\` | Text; daily rotation; 7 days kept; at most 8 MiB a day | No | n/a |

A semester or course name that starts with `_` gets one more `_` inside `.folio/meta/`
(`_misc` → `__misc.json`), so it never collides with `_group.json` or `_root.json`.

**Why the versioning and ignore rules sync.** Every PC must agree on which files get full versions
and which files are ignored. Otherwise two PCs would record different histories for the same
library.

**Why settings live in Local, not Roaming, AppData.** Paths such as the library location are
specific to one machine.

### 3. Synced metadata files

**Serialisation**
- UTF-8 without BOM, LF line endings, 2-space indentation.
- Top-level fields appear in a fixed order. Map keys are sorted by code point, and tag lists are
  sorted too, so the output is deterministic and diffs stay line-stable.
- Each tag assignment sits on its own line.
- Every file carries an integer `format_version`.

**Keys and paths**
- Inside a course file, keys are paths relative to the course folder. Renaming a course therefore
  renames one file instead of rewriting every key.
- Paths use `/` separators, Unicode NFC, and their original case. Uniqueness is checked
  case-insensitively, because Windows file systems are case-insensitive.
- A key may name a subfolder inside a course. It assigns own tags to that folder;
  descendants inherit them for filtering and "untagged". Semester and course folders carry
  no tags. A filter selecting several tags requires every selected effective tag
  ([ipc-m1.md](../specs/ipc-m1.md) §8.2, §9.1).

**Writing and merging**
- Writes are atomic: write a temporary file in `.folio/local/staging/` (same volume, never synced;
  ADR-0003 §4), call `sync_all`, then rename it over the old file. No temporary file ever appears
  in a synced folder. Sharing violations (antivirus, Explorer previews) are retried.
- Merge rules and versioning of these files are defined in ADR-0003, which treats them as fully
  versioned text.

**Format versions**
- Readers accept every older `format_version` and always write the current one.
- A file with a newer `format_version` than the app understands switches the library metadata to
  read-only and asks the user to update Folio. This stops an older Folio on another PC from
  overwriting newer data.
- M1 writes version 2 and reads versions 1 and 2 with the current structs: v2 is a superset
  of v1. Reading does not rewrite files; the next authorized write to a file uses v2.
- A configured course has required archive/order settings and optional abbreviation, code
  and colour. Absent values mean the UI derives its defaults; derived values are never
  persisted. Abbreviations accept 1–3 grapheme clusters. Operation inputs trim and NFC-normalize
  abbreviation and code before validation/storage, following the name normalization boundary.
  [library-core.md](../specs/library-core.md) §4.2 defines the field rules.
- New-library presets use design palette keys; Reference uses `stone`. Stored tag definitions
  remain authored data and are never recoloured merely by opening a library.

Example, `.folio/meta/2026 秋/线性代数.json`:

```json
{
  "format_version": 2,
  "course": {
    "abbr": "线代",
    "archived": false,
    "code": "MAT232",
    "color": "blue",
    "order": 1
  },
  "tags": {
    "作业/hw2.pdf": ["homework"],
    "复习笔记.md": ["exam", "notes"],
    "第3讲 特征值.pptx": ["slides"]
  }
}
```

Tag ids are stable ASCII strings: the presets are `notes`, `slides`, `homework`, `exam` and
`reference`, and user-created tags get generated ids. Display names such as `考试` live only in
`.folio/tags.json`, so renaming a tag touches one file.

### 4. Catalog database

**Library**
- `rusqlite` 0.40.1 or later with the `bundled` feature. That bundles SQLite 3.53.2 with FTS5
  compiled in; it has the WAL-reset corruption fix and 0.40.1's SAVEPOINT-injection fix.
- Only one copy of `libsqlite3-sys` can be linked, so every other dependency must accept the same
  version.

**Connections**
- One read-write connection behind a mutex serves every write, so one write runs at a time. The
  shell already calls the core from blocking tasks, so a dedicated writer thread would add
  nothing.
- Writes use `BEGIN IMMEDIATE`. Bulk rebuilds commit in batches far below 100 MB per transaction.
- A few read-only connections serve queries; WAL lets them run alongside the writer.
- The core API is synchronous, and the shell calls it through `spawn_blocking`. This keeps the core
  free of an async runtime and easy to expose through UniFFI later.

**PRAGMAs on every connection**
- `journal_mode=WAL` (it persists).
- `synchronous=NORMAL`. This is safe because the database is rebuildable.
- `foreign_keys=ON`. The bundled build already defaults it on; set it explicitly anyway.
- `trusted_schema=OFF`.
- `busy_timeout=5000`.
- `temp_store=MEMORY`.
- `journal_size_limit`, for example 64 MB.
- `PRAGMA optimize=0x10002` when a connection opens, and `PRAGMA optimize` periodically.

**Query layer**
- Hand-written SQL in repository modules, with typed row mapping. Every statement runs in tests.
- No ORM and no query builder.

**Schema changes**
- `rusqlite_migration` 2.6, which tracks the version in `PRAGMA user_version`.
- A unit test calls `Migrations::validate()`.
- Fixture tests open a database from each released schema version and migrate it.
- If a migration fails or the file is corrupt, the database is moved aside and rebuilt from the
  disk and `.folio/`, with progress shown to the user.

**Main tables.** This is a sketch; the migrations are the real schema.

| Table | Purpose |
|---|---|
| `entries` | One row per file or folder: path, `path_key` (case-insensitive; indexed but not unique, because NTFS upcase tables differ between volumes and case-sensitive directories can hold case twins, which the scan reports instead), parent, kind, size, mtime, NTFS file id (for rename detection), content hash (algorithm-prefixed, set by ADR-0003), class (text / Word / other), `first_seen_at` (now `added_ns`; a rebuild takes files' creation times, [`library-scan.md`](../specs/library-scan.md) §6.3). No semester or course ids: a semester or course view is a range scan on `path`, so renaming one touches only paths |
| `semesters`, `courses`, `tags`, `entry_tags` | Mirrors of the `.folio/` metadata, for filtering and sorting |
| `extracts` | Text-extraction status per entry and the content hash it was extracted from |
| `search` | FTS5 table, described in the next section |
| `thumbs` | Thumbnail cache index: hash, size, last access |
| `recents` | Recent searches and files, local only |

### 5. Full-text search for Chinese

**A custom FTS5 tokenizer, `folio_cjk`**
- Written in Rust and registered on every connection through the `fts5_api` of `libsqlite3-sys`.
  rusqlite itself has no tokenizer API.
- Text is normalised before it is split: default-ignorable characters (soft hyphen, zero-width
  space, variation selectors) are removed, then NFKC folds full-width forms, Kangxi radicals and
  decomposed Hangul and kana.
- Chinese, Japanese and Korean text (letters of the Han, Hiragana, Katakana and Hangul scripts,
  including marks kana share such as `ー`, but no Common or Inherited letters such as `µ`): each
  character becomes a one-character token, and a two-character token (the character plus the
  next one) is stored at the same position (`FTS5_TOKEN_COLOCATED`).
  - A 1-character query matches the one-character token.
  - A longer query becomes a phrase of its two-character tokens at consecutive positions,
    followed by its last character as a one-character token: `线性代数` becomes
    `线性 性代 代数 数`. The last token makes the phrase cover one position per character, so
    `highlight()` and `snippet()` mark every character (spike, action item 4).
  - One CR, LF or CRLF between two such characters does not break the pair, because PDF text
    wraps lines inside sentences. Spaces, tabs, punctuation, blank lines, NUL and invalid UTF-8
    do.

  So any query matches as a contiguous substring, the same pattern as Lucene's CJK bigram filter
  with unigrams enabled.
- All other text is split into words of letters and numbers (with their combining marks) at
  everything else, including `_ . : ' ’`: `Linear_Algebra_HW1.pdf` has the words `linear`,
  `algebra`, `hw1` and `pdf`. Words are lower-cased, not fully case-folded.
- Token offsets point into the original text, also where normalisation changed or expanded a
  character (an expansion shares the range of its source). FTS5's own `highlight()` and
  `snippet()` therefore work, and the table stores the original text only once.
- It uses Unicode 17 tables (a test pins them), not `unicode61`'s Unicode 6.1, so newer Han
  characters are still tokens.
- `search::TOKENIZER_VERSION` (now 2) changes whenever the tokens change, new Unicode tables
  included. The catalog stores it and rebuilds the index before reading or writing when it
  differs.
- Callbacks catch panics, and no unwinding crosses the FFI boundary. The crate refuses to build
  with `panic = "abort"`, which would turn a tokenizer panic into a crash.

**The `search` table**
- Columns: name, path, tags, body.
- `detail=full`, which phrase queries need.
- `prefix = '3'`: a prefix index for as-you-type prefixes of Latin-script words. A two-character
  prefix index would also copy every Chinese pair (spike: 44% more space).
- Ranking: `bm25` with column weights name > tags > path > body, plus a recency boost applied in
  Rust.

**Queries and limits**
- The core builds every MATCH expression from user input. Each term is quoted and escaped, and no
  raw user text reaches MATCH. FTS5 reads the query as a C string, so a NUL becomes a space. The
  privileged layer rejects over-long query text with a typed error before building MATCH.
- The last Latin term matches as a prefix from two letters on; a single letter matches whole
  words only. A CJK term never gets the prefix operator.
- Highlights and snippets are computed only for the rows on screen, one query per row
  (`MATCH … AND rowid = ?`). In the ranked query they would be computed for every match. The UI
  renders them as text, never as HTML: the markers `highlight()` inserts are characters removed
  from stored text beforehand.
- Body text is capped per file (for example the first 1 MB), and generated or minified files are
  skipped. Stored text is valid UTF-8 without NUL: `highlight()` and `snippet()` drop the text
  after a NUL.
- Every connection registers the tokenizer, also those that only run `quick_check` or
  `integrity_check`, which fail without it. A failed write to the `search` table rolls back its
  transaction or savepoint.

**Fallback.** If the FFI tokenizer proves unstable in the spike, reuse the same tokenisation code
to pre-tokenise text into a `unicode61` column and do the highlighting in Rust. Query semantics
stay the same; the cost is more storage.

**Later.** Pinyin search (brief §14) can be added later without changing this design, through
`ib-matcher` at query time or pinyin tokens colocated in the index.

### 6. Library location guard

When the user picks the library folder, Folio warns if it is inside a cloud-sync root (iCloud
Drive, OneDrive, Dropbox). No other sync client may write to the library or its `.folio/`. The
iCloud folder is the remote (ADR-0003), not the library.

## Options considered

### Source of truth

- **A. Text files for synced data, derived SQLite (chosen).** Losing the database loses nothing,
  and the files diff, merge and stay readable in any language.
- **B. SQLite as the source of truth.** The history would sync a binary database: no merges, a new
  whole-file version per change, and a corrupt file loses the user's tags. Rejected.
- **C. Files only, with an in-memory index built at start-up.** Start-up is slow and there is no
  persistent full-text index for 50,000 files. Rejected.

### Query layer

| Option | Verdict |
|---|---|
| **rusqlite + hand-written SQL (chosen)** | Current (0.40.2), synchronous, direct FTS5 access |
| sqlx 0.9 | Async only, one thread per connection; compile-time checks need `.sqlx` metadata. Its `libsqlite3-sys` range (< 0.38) cannot link next to rusqlite 0.40 |
| diesel 2.3 | Compatible, but FTS5 tables have no primary key for `table!`, so MATCH, `bm25` and `snippet` would be raw SQL anyway |
| sea-orm (sync) | Pins rusqlite 0.38, i.e. SQLite 3.51.1 from before the WAL-reset fix |
| tauri-plugin-sql | Lets the webview run SQL directly, which breaks the privilege boundary (CLAUDE.md §5) |

### Migrations

| Option | Verdict |
|---|---|
| **rusqlite_migration 2.6 (chosen)** | Maintained, supports rusqlite 0.40, `validate()` for tests |
| refinery 0.9.2 | Supports rusqlite only up to 0.39; an open issue asks whether the project is still alive |

### Chinese search

| Option | 1–2 character queries | Highlighting | Cost | Verdict |
|---|---|---|---|---|
| **Custom FTS5 tokenizer** | Contiguous match | Native | A small unsafe FFI layer | Chosen; the spike decides |
| Pre-tokenised `unicode61` column | Contiguous match | Done in Rust | Text stored twice | Fallback |
| Trigram + LIKE fallback | Full table scan | Native at 3+ characters | Slow on file text | Rejected |
| `simple` tokenizer (C++) | Characters ANDed, not contiguous | Yes | Needs cmake and make on Windows, plus jieba dictionaries | Rejected |
| Tantivy + jieba or n-grams | n-gram positions break phrases | Yes | A second store with its own lock | Rejected for v1 |
| jieba segmentation alone | Misses abbreviations such as `线代` | — | 5 MB dictionary | Possible ranking aid later |

### Metadata layout

| Option | Verdict |
|---|---|
| One file for all tags | Every tag change rewrites, and versions, a file that grows with the library; merges are frequent |
| A sidecar file in every folder | Clutter: dotfiles are not hidden in Explorer, and the files would show up in the remote too |
| **Per-course files under `.folio/meta/` (chosen)** | Small files; each change stays local to one course; one hidden folder |

### Settings

| Option | Verdict |
|---|---|
| **Core-owned JSON in `%LOCALAPPDATA%` (chosen)** | Readable before the database opens; machine-specific paths never roam |
| tauri-plugin-store | Ties settings to the shell, but the core must stay shell-agnostic |
| Inside SQLite | Lost on every rebuild |

## Consequences

**Easier**
- The database can be deleted at any time.
- Metadata can be diffed, merged and read by any language.
- One storage engine holds the catalog and the index in a single transactional file.
- Native search snippets, and correct matches for 1–2 character Chinese queries.

**Harder**
- A small unsafe FFI tokenizer to write, fuzz and maintain.
- Reconciliation code to keep the files and the catalog consistent.
- Discipline around `format_version` for every JSON file.

**Revisit when**
- Pinyin search is requested.
- Full-text search for PDF and PowerPoint arrives (v2) and grows the index: re-measure size and
  latency.
- Libraries grow beyond 50,000 files, or the index beyond 1 GB.
- Chinese ranking needs word-level relevance: add jieba-based boosts.

## Action items

1. [x] Sirui approves; set Status to Accepted.
2. [x] ADR-0003 defines:
   - the history store inside `.folio/`;
   - merge rules for the metadata files;
   - the content-hash algorithm (the catalog stores the hash opaque, with an algorithm prefix);
   - the path-normalisation rules it shares with this ADR.
   - Done in ADR-0003 §2, §4 and §9 (accepted 2026-09-26). The shared path rules are specified
     in [`docs/specs/library-core.md`](../specs/library-core.md) §3 and implemented in
     `folio-core::paths`.
3. [x] Scaffold:
   - `folio-core::catalog` (catalog, migrations, repositories);
   - `folio-core::search` (tokenizer and query builder);
   - `folio-core::meta` (metadata read/write).
   - Result (2026-09-27, lane `claude/amazing-johnson-pzvhzd`, spec
     [`library-core.md`](../specs/library-core.md)): `paths` (library-relative paths, Windows
     name rules, case-insensitive keys), `meta` (the `.folio/` layout and files, deterministic
     and atomic writes, `format_version` handling), `catalog` (schema v1, WAL, recovery,
     derived versions, repositories) and `search::SearchQuery` with ranked search and
     highlights. The storage module is named `catalog`, as in the system overview.
   - The spec (§9) refined this ADR in six places, approved by Sirui on 2026-09-27 and folded
     into §2–§4 above: `path_key` indexed but not unique; semester and course names starting
     with `_` escaped in `.folio/meta/`; temporary files in `.folio/local/staging/`; the single
     writer behind a mutex instead of a thread; the module name `catalog`; no semester or
     course ids on entries (path ranges instead).
4. [x] Spike, alongside the ADR-0001 spikes (2026-09-27, lane `spike/data-fts5-cjk-tokenizer`):
   - register `folio_cjk` through `fts5_api`;
   - property tests over random Unicode (no panics across FFI; offsets always on character
     boundaries; `highlight()` output correct);
   - index size and query latency on a sample of 50,000 entries and 10,000 text files.
   - Result: the tokenizer works through `fts5_api` on SQLite 3.53.2, so the fallback is not
     needed. A connection that has not registered it cannot read the table.
   - Property tests (proptest in `crates/folio-core`; 256 cases each in `pnpm check`, 20,000 in
     one run): offsets are UTF-8 ranges inside the text, also for text with invalid UTF-8;
     `highlight()` marks exactly the occurrences of a Chinese term; any user text passed through
     `search::phrase` is a valid query. They found two bugs, now fixed:
     - queries of two or more characters were highlighted one character short: FTS5 marks one
       position per query token, with the offsets of the first token at each position. The query
       form in §5 now ends with the last character;
     - a NUL in a search term ended the query early (`unterminated string`).
   - The code review of the spike found four gaps in the text rules, each now fixed with a
     regression test (`TOKENIZER_VERSION` 2): Common and Inherited letters such as `µ` and `ℂ`
     (1,175 code points) counted as CJK; `_ . : '` stayed inside words, so `algebra` missed
     `Linear_Algebra_HW1.pdf`; CJK was classified before normalisation (Kangxi radicals,
     decomposed Hangul and kana); default-ignorable characters and line breaks split Chinese
     words.
   - Benchmark (`crates/folio-core/tests/search_benchmark.rs`, release build on g16-strix): 50,000
     synthetic entries with Zipf-distributed words, 10,000 of them with bodies of 200–20,000
     characters (44 M characters, 106 MB). The most common character is 10% of the text, against
     about 4% for 的 in real Chinese, so common-character queries are pessimistic.
     - Build: 18 s. 334 MB in use with `prefix = '3'` (index 216 MB, stored text 117 MB), about
       7.5 bytes per body character, so the database passes 1 GB at about three times this
       sample. `optimize` saves 2%.
     - A page of 50 results ranked by bm25, with highlights and snippets (median): rare terms
       1–4 ms; the most common character 45 ms; a two-character word ending in it 81 ms (the
       worst case); four characters 16 ms; a Latin word or three-letter prefix 6 ms.
     - Snippets computed inside the ranked query: 13–350 ms, because every match gets one.
     - A Latin prefix without a prefix index is expanded again for every row's snippet: 324–380
       ms for one letter (two runs), 35 ms for two. One filtered query for the whole page
       (`+rowid IN (…)`) expands it once (29 ms) but repeats the phrase match, up to 113 ms.
     - `prefix = '2 3'` adds 44% to the size and 70% to the build time, because every Chinese
       pair is also a two-character prefix; `prefix = '3'` adds 2%.
     - Tokenizer alone: 268 MB/s when indexing and 386 MB/s when `highlight()` and `snippet()`
       read the text again (they skip the pairs, so it leaves them out). Before the review's
       normalisation rules it was 307 and 478 MB/s, and 32 MB/s before fast paths for the main
       Han block. A rerun with the final rules stayed within 10% on every other figure here.
     - Rare normalisation paths are slow: 1 MB of U+FDFA, which NFKC expands to 18 characters,
       takes 0.84 s. The body cap also bounds this worst case.
5. [ ] Tests:
   - migrations `validate()` plus fixtures for each released schema version;
   - metadata round-trips, fixtures for older formats, and read-only mode for a newer format;
   - a property test that a full rebuild equals the incrementally maintained catalog.
   - Progress (2026-09-27): migrations apply to an empty database with the tokenizer
     registered (`validate()` itself opens a connection without it); metadata files have golden
     bytes, round-trip property tests and a `NewerFormat` error for read-only mode. Fixtures
     wait for the first released schema and the first older format.
   - The rebuild property test exists (2026-09-27, scan lane,
     [`library-scan.md`](../specs/library-scan.md) §10): after random creations, edits,
     deletions, renames (case-only ones included), tagging, settings and hashing, the catalog
     that scans kept up to date equals one rebuilt from scratch, and entries keep their ids,
     files their tags and semesters and courses their settings while their file ids survive.
     It found one bug before the lane was done: an entry that stayed at its path while another
     folder took its parent's name kept its old parent, and the scan failed on the foreign key.
6. [x] Update system overview §5.
