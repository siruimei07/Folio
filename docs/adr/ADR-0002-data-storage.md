# ADR-0002: Data storage

- **Status:** Accepted (Sirui, 2026-09-26)
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
| Logs | `%LOCALAPPDATA%\<app-id>\logs\` | Text; daily rotation; 7 days kept | No | n/a |

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
- A key may name a folder, which tags the folder itself.

**Writing and merging**
- Writes are atomic: write a temporary file in the same folder, call `sync_all`, then rename it over
  the old file. Sharing violations (antivirus, Explorer previews) are retried.
- Merge rules and versioning of these files are defined in ADR-0003, which treats them as fully
  versioned text.

**Format versions**
- Readers accept every older `format_version` and always write the current one.
- A file with a newer `format_version` than the app understands switches the library metadata to
  read-only and asks the user to update Folio. This stops an older Folio on another PC from
  overwriting newer data.

Example, `.folio/meta/2026 秋/线性代数.json`:

```json
{
  "format_version": 1,
  "course": {
    "abbr": "线代",
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
- One writer thread owns the read-write connection and receives work over a channel.
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
| `entries` | One row per file or folder: path, `path_key` (case-folded NFC, unique), parent, kind, size, mtime, NTFS file id (for rename detection), content hash (algorithm-prefixed, set by ADR-0003), class (text / Word / other), semester and course ids, `first_seen_at` |
| `semesters`, `courses`, `tags`, `entry_tags` | Mirrors of the `.folio/` metadata, for filtering and sorting |
| `extracts` | Text-extraction status per entry and the content hash it was extracted from |
| `search` | FTS5 table, described in the next section |
| `thumbs` | Thumbnail cache index: hash, size, last access |
| `recents` | Recent searches and files, local only |

### 5. Full-text search for Chinese

**A custom FTS5 tokenizer, `folio_cjk`**
- Written in Rust and registered on every connection through the `fts5_api` of `libsqlite3-sys`.
  rusqlite itself has no tokenizer API.
- Chinese, Japanese and Korean text: each character becomes a one-character token, and a
  two-character token (the character plus the next one) is stored at the same position
  (`FTS5_TOKEN_COLOCATED`).
  - A 1-character query matches the one-character token.
  - A 2-character query matches one two-character token.
  - A longer query becomes a phrase of two-character tokens at consecutive positions.

  So any query matches as a contiguous substring, the same pattern as Lucene's CJK bigram filter
  with unigrams enabled.
- All other text is split on Unicode word boundaries, NFKC-normalised (which folds full-width
  forms) and case-folded.
- Token offsets point into the original text. FTS5's own `highlight()` and `snippet()` therefore
  work, and the table stores the original text only once.
- It uses current Unicode tables, not `unicode61`'s Unicode 6.1, so newer Han characters are still
  tokens.
- Callbacks catch panics, and no unwinding crosses the FFI boundary.

**The `search` table**
- Columns: name, path, tags, body.
- `detail=full`, which phrase queries need.
- Prefix indexes support as-you-type prefixes of Latin-script words.
- Ranking: `bm25` with column weights name > tags > path > body, plus a recency boost applied in
  Rust.

**Queries and limits**
- The core builds every MATCH expression from user input. Each term is quoted and escaped, and no
  raw user text reaches MATCH.
- Body text is capped per file (for example the first 1 MB), and generated or minified files are
  skipped.

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
2. [ ] ADR-0003 defines:
   - the history store inside `.folio/`;
   - merge rules for the metadata files;
   - the content-hash algorithm (the catalog stores the hash opaque, with an algorithm prefix);
   - the path-normalisation rules it shares with this ADR.
3. [ ] Scaffold:
   - `folio-core::storage` (catalog, migrations, repositories);
   - `folio-core::search` (tokenizer and query builder);
   - `folio-core::meta` (metadata read/write).
4. [ ] Spike, alongside the ADR-0001 spikes:
   - register `folio_cjk` through `fts5_api`;
   - property tests over random Unicode (no panics across FFI; offsets always on character
     boundaries; `highlight()` output correct);
   - index size and query latency on a sample of 50,000 entries and 10,000 text files.
5. [ ] Tests:
   - migrations `validate()` plus fixtures for each released schema version;
   - metadata round-trips, fixtures for older formats, and read-only mode for a newer format;
   - a property test that a full rebuild equals the incrementally maintained catalog.
6. [x] Update system overview §5.
