# Library core: paths, metadata, catalog and search

System design for the data layer of M1 (brief §11) inside `folio-core`. Decisions stay in the
ADRs; this spec fixes the details the ADRs leave open and the API the next lanes build on.

- Status: accepted with the lane, 2026-09-27 (lane `claude/amazing-johnson-pzvhzd`).
- Inputs: [brief](../product/brief.md) §4, §5.1, §5.2, §5.8; [ADR-0002](../adr/ADR-0002-data-storage.md);
  [ADR-0003](../adr/ADR-0003-versioning-and-sync.md) §2, §10; [system overview](system-overview.md)
  §2–§5; [testing strategy](testing-strategy.md).
- Section 9 lists where this spec refines ADR-0002. Sirui approved them on 2026-09-27, and
  ADR-0002 now includes them.
- M1 metadata v2, catalog migration 2 and the folder-tag/all-tags clarifications below
  were approved by Sirui on 2026-09-29 (ipc-m1 §20).
  Sirui approved the narrow in-app move recovery extension on 2026-09-30: durable local
  intent, stable catalog identities, fail-closed conflicts and interrupted-recovery safety
  ([library-scan.md](library-scan.md) §7.1; ADR-0002 §1).

## 1. Scope

| In this lane | Next lanes |
|---|---|
| `paths`: library-relative paths and their case-insensitive keys | Scan and reconcile: walk the library, ignore rules, file classes, BLAKE3 hashes, catalog updates, twins |
| `meta`: the `.folio/` layout and its JSON files | Library operations: create, take over, semesters, courses, tags, import |
| `catalog`: the SQLite catalog, migrations, derived versions, recovery, repositories | Windows adapters: watcher, file ids, Recycle Bin (tested on Windows) |
| `search`: query building, ranking, highlights | IPC contract for M1, then the UI once the design handoff exists |

Nothing here touches Tauri, IPC or the UI. Everything runs and is tested on any OS; nothing in
this lane calls a Windows API.

## 2. Modules

| Module | Owns | Uses |
|---|---|---|
| `paths` | `RelPath`, `PathKey`, Windows name rules | — |
| `files` | Atomic file replacement, retries on transient Windows errors | — |
| `meta` | `Layout` (every path under `.folio/`), the metadata file types, ids, reading and writing | `paths`, `files` |
| `catalog` | `Catalog` (connections, schema, versions, recovery) and its repositories | `paths`, `meta`, `search` |
| `search` | Tokenizer (done), `SearchQuery`, highlight spans | — |

The core API is synchronous and returns typed errors (`thiserror`). The shell holds one
`Arc<Catalog>` per open library and calls the core through `spawn_blocking` (ADR-0002 §4).

## 3. Paths

`RelPath` is a path relative to a folder: the library root for catalog entries, a course folder
for tag keys. Its text form is the only form stored or sent anywhere.

- Segments are joined by `/`. No empty segment, so no leading, trailing or doubled `/`.
- Unicode NFC. Parsing rejects other forms instead of normalising them: normalising is the scan
  lane's job, because it has to report NFC/NFD twins (ADR-0003 §7).
- Every segment is a valid Windows name:
  - not `.` or `..`;
  - no `< > : " / \ | ? *` and no control character U+0000–U+001F;
  - no trailing `.` or space;
  - not a reserved device name, compared without case and with any extension:
    `CON PRN AUX NUL CONIN$ CONOUT$ COM0–COM9 LPT0–LPT9 COM¹ COM² COM³ LPT¹ LPT² LPT³`
    (`nul.txt` counts);
  - at most 255 UTF-16 code units (NTFS).
- The whole path is at most 32,767 UTF-16 code units (NTFS). The scan lane checks the length of
  the absolute path.

`PathKey` is the case-insensitive identity used for lookups and twin detection. It maps every
character to its Unicode simple uppercase when that is a single character, like the NTFS upcase
table, and leaves the rest alone (`ß` stays `ß`).

- It is **indexed but not unique**. NTFS upcase tables come from older Unicode versions than
  Rust's (Rust 1.97 upper-cases Georgian Mkhedruli, which NTFS may not), and directories with
  WSL's per-directory case sensitivity can hold case twins. A unique key could make a scan fail
  on files that legitimately coexist. Twins are found with a query and reported instead.
- `PATHS_VERSION` changes whenever the keys or the name rules change; a test pins
  `char::UNICODE_VERSION`, so a toolchain update that moves the case tables fails until the
  version is bumped. When it differs, the catalog reads every stored path again, which replaces a
  catalog holding paths that no longer validate, and recomputes the keys (§5.4).

A valid `RelPath` can still name Folio's own folder. `meta::is_folio_owned` recognizes it
whatever its case (`.FOLIO`); operations on user entries that take paths from the UI refuse such
paths. Its 8.3 short name (`FOLIO~1`) cannot be told from the text: the Windows adapter resolves
short names when it turns UI paths into `RelPath`s.

`SemesterPath` (one name) and `CoursePath` (two names) wrap a `RelPath` whose depth is part of
its type. Functions that take a semester or a course take these, so the depth is checked once,
when the path is made (`paths::WrongDepth`); `RelPath::semester_and_rest` and `course_and_rest`
split a path into them without checking again.

## 4. Metadata files

### 4.1 Layout

`meta::Layout` builds every path under `<library>/.folio/`; nothing else joins these paths.

| Path | Content |
|---|---|
| `library.json` | Library id, name, versioning rules |
| `tags.json` | Tag definitions |
| `ignore` | Ignore rules, gitignore syntax (scan lane) |
| `meta/_root.json` | Tags of files at the library root |
| `meta/<semester>/_group.json` | Settings of a semester (or other first-level group), tags of files directly in it |
| `meta/<semester>/<course>.json` | Settings of a course, tags of everything inside it |
| `local/staging/` | Temporary files for atomic writes; never synced (ADR-0003 §4) |

**Name escaping.** A course folder named `_group` would otherwise share `_group.json` with its
semester, and a semester named `_root.json` would collide with that file. So a semester or course
name that starts with `_` gets one more `_` in these paths (`_misc` → `__misc.json`). Names that
Folio owns start with exactly one `_`, so the two sets never meet, also without regard to case.
Decoding strips one `_`. A name that would exceed 255 UTF-16 units once escaped and suffixed is
an explicit error.

Semester and course folders themselves carry no tags: `meta::tag_location` has no location for
them. A key in a course file names a file or a subfolder inside the course, relative to it
(`作业/hw2.pdf`); keys in `_group.json` and `_root.json` name files directly in the folder.

### 4.2 Format (current `format_version` 2; v1 readable)

Common rules (ADR-0002 §3): UTF-8 without BOM, LF, two-space indent, trailing newline. Objects
are expanded one field per line; arrays stay on one line, so each tag assignment is one line.
Top-level fields follow the order below; the fields inside objects and all map keys are sorted by
code point; tag lists and extension lists are sorted and free of duplicates.

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
    "复习笔记.md": ["exam", "notes"]
  }
}
```

| File | Fields after `format_version` |
|---|---|
| `library.json` | `id`: 32 lowercase hex (128 random bits); `name`; `versioning`: `text_extensions`, `text_max_size` (bytes), `word_extensions` |
| `tags.json` | `tags`: map from tag id to `{color, name, order}` |
| `_root.json` | `tags` |
| `_group.json` | `group`: `{archived, order}`, left out until the group is configured; `tags` |
| `<course>.json` | `course`: `{archived, order}` with optional `abbr`, `code`, `color`, left out until configured; `tags` |

Value rules:

- Tag ids: 1–32 of `a–z 0–9 _ -`, starting with a letter or digit. Presets are `notes`, `slides`,
  `homework`, `exam`, `reference`; new tags get 16 random lowercase hex digits. The core owns the
  preset ids, colours and order; the preset **names** come from the caller (UI strings, CLAUDE.md
  §2).
- Colours are palette keys (1–32 of `a–z 0–9 -`, starting with a letter). The current palette
  is red, orange, amber, green, teal, blue, indigo, violet, pink, stone. Unknown valid keys
  display neutrally. New presets keep their ids; Reference uses stone. Stored definitions,
  including the former gray key, are not rewritten or recoloured on open.
- `abbr` is 1–3 extended grapheme clusters without whitespace or control characters;
  `MAX_ABBR_GRAPHEMES` is exposed by core. Operation inputs trim and NFC-normalize it before
  validation/storage. Missing/null means no explicit badge; the UI derives it from the code, else
  the name (app-shell handoff §10).
- `code` is 1–32 Unicode scalar values without surrounding whitespace or control characters;
  `MAX_COURSE_CODE_CHARS` is exposed by core. Operation inputs trim and NFC-normalize it before
  validation/storage. Missing/null means no code; an empty string is invalid, so callers clear
  it with null.
- Course colour is optional too. Readers accept omitted/null optional fields and writers omit
  absent fields; IPC responses retain explicit nulls (ipc-m1 §4). Derived badges/colours are
  never stored. Present values use the core value types.
- Names (library, tag) are 1–128 Unicode scalar values without surrounding whitespace or
  control characters. Core exposes `MAX_DISPLAY_NAME_CHARS`; IPC LIMITS references these three
  core limits without changing their exported values.
- Versions 1 and 2 use the current structs and current value rules (`1..=FORMAT_VERSION`).
  There is no separate legacy course shape or mapping. Unknown fields and invalid values
  remain invalid in both versions.
- Folder keys assign own tags inside a course; descendants inherit them for filtering and
  "untagged". Several selected tags require all effective tags. This does not change the
  assignment representation; browse/search filtering belongs to its query lane.
- `order` is an unsigned 32-bit integer. Ties sort by name.
- Extensions are stored lower-case without the dot. Defaults: common text, markup, data and
  source-code extensions (`meta::VersioningRules::default`), Word `docx`, and a 10 MiB text limit
  (brief §5.8). A file's **class** (text, Word, other) comes from its extension alone; whether a
  version is **stored** also depends on the size limit (ADR-0003 §2). Files without an extension
  are "other" in v1.

### 4.3 Reading and writing

- **Read.** Files over 32 MiB are rejected. A BOM is tolerated. `format_version` must be an
  integer:
  - newer than the app supports → `MetaError::NewerFormat`; the library layer then makes the
    library metadata read-only (ADR-0002 §3);
  - supported (1 or 2) → deserialize the current structs strictly: an unknown field, a wrong type, an invalid key, an exact or
    case-insensitive duplicate key or an invalid value is `MetaError::Invalid`, naming the file
    and the problem. Every change to a format bumps `format_version`, so an unknown field never
    means "newer".
  - A missing file reads as `None`; the caller decides the defaults.
  - Lists mean the same whatever their order or repetitions, so unsorted lists and repeated
    items are read as sets and written normalized; empty tag lists are dropped. Duplicate keys,
    by contrast, are ambiguous and rejected.
- **Write.** Always the current version, with the deterministic formatting above. The bytes go
  to a new file in `local/staging/`, are flushed with `sync_all`, and replace the target with one
  rename on the same volume. On Windows, sharing and lock violations (antivirus, indexers,
  Explorer previews) are retried with backoff for about two seconds, then reported.
  Reading/opening does not upgrade files. The first authorized write uses v2 while preserving
  assignments and authored settings. Never overwrite source metadata from the derived catalog.

## 5. Catalog

### 5.1 Connections

- One read-write connection behind a mutex; every write runs in a `BEGIN IMMEDIATE`
  transaction. A mutex gives ADR-0002's single writer without a dedicated thread; see §9.
- Read-only connections from a small pool, each read in a deferred transaction, so one call
  sees one snapshot. WAL lets them run alongside the writer.
- Every connection registers `folio_cjk` first and sets `synchronous=NORMAL`, `foreign_keys=ON`,
  `trusted_schema=OFF`, `busy_timeout=5000` and `temp_store=MEMORY`. The writer also sets
  `journal_mode=WAL` (and checks it took effect) and `journal_size_limit` (64 MiB), and runs
  `PRAGMA optimize=0x10002` when it opens; read-only connections cannot run `ANALYZE`.
  `Catalog::optimize` runs the periodic `PRAGMA optimize`.
- A panic inside a transaction rolls it back; a poisoned mutex is recovered, because the
  connection is consistent after the rollback.

### 5.2 Schema v5 (migrations 1 to 4 preserved)

`rusqlite_migration` tracks the version in `PRAGMA user_version`. Its `validate()` opens a
connection without `folio_cjk`, so the test applies the migrations to a connection that has it.
This lane preserves migration 1 and adds migration 2 with a populated v1 fixture test
(ADR-0002 §4), even though pre-release migrations were previously editable in place.

| Table | Columns |
|---|---|
| `info` | `key`, `value`: `library_id`, `tokenizer_version`, `paths_version`; the scan's `scan_journal` and `first_scan_ns` ([library-scan.md](library-scan.md) §6.3, §7.1); the workspace's `history_head`, `history_version` and `workspace_disk_files` ([versioning.md](versioning.md) §6.5, §13.1) |
| `semesters` | `path` (one segment), `sort_order`, `archived` |
| `courses` | `path` (two segments), nullable `abbr`, nullable `code`, nullable `color`, `sort_order`, `archived` |
| `entries` | `id`; `path` (unique); `path_key` (indexed); `parent_id` (not cascading); `name`; `kind` (`file`, `folder`); `class` (`text`, `word`, `other`); `size`; `mtime_ns`; `file_id`; `hash` (`b3:` + 64 hex); `added_ns` (when a scan first saw it; a rebuild takes the file's creation time, [library-scan.md](library-scan.md) §6.3) |
| `tags` | `id`, `name`, `color`, `sort_order` |
| `entry_tags` | `entry_id` (cascading), `tag_id`. No foreign key to `tags`: an assignment may name a tag that `tags.json` has not synced yet, or no longer defines |
| `search` | FTS5 over `name`, `path` (the parent folder), `tags` (tag names), `body`; `rowid` = entry id; `folio_cjk`, `detail=full`, `prefix='3'` |
| `packs` | The local history's packs ([versioning.md](versioning.md) §4.3, §13.1): `name` (64 hex, the file name without `.pack`), `size` (at least 150 bytes), `objects` (at least 1) |
| `objects` | Where each history object is: `id` (`b3:` + 64 hex, like `entries.hash`), `pack` (cascading from `packs`, indexed), `offset` of its record (at least 12); one location per object, from the pack indexed first |
| `extracts` | What extracting each text and Word file's text gave ([versioning.md](versioning.md) §10.2–§10.3): `entry_id` (cascading from `entries`); the `hash` and `class` (`text`, `word`) it was extracted from; the extractor's `version`; `status` (`text`, `empty`, `binary`, `skipped`, `failed`); `failure` (`invalid`, `too_large`) and `detail` (for logs, at most 500 characters) on failed rows only; a partial index on the failed rows. The text itself is the `search` row's `body` |
| `head_files` | `HEAD`'s flattened tree ([versioning.md](versioning.md) §6.1, §13.1): `path` (primary key, without rowid), `kind` (`file`, `folder`), `hash` (a file's content hash or a folder's tree id, `b3:` + 64 hex), `size` and `stored` (files only), `entry_id` (the paired entry; `ON DELETE SET NULL`); a partial unique index on the paired rows' `entry_id` |
| `unhashed` | Why a file is still unhashed ([versioning.md](versioning.md) §6.2): `entry_id` (cascading from `entries`), `reason` (`not_local`, `unreadable`), and the entry's `size`, `mtime_ns` and `file_id` when the hash pass recorded it |

All ordinary tables are `STRICT`. Entries hold no semester or course ids: a semester or course
view is a range scan on `path` (`path > 'P/' AND path < 'P0'`), so a rename touches only paths.
Thumbnails and recents get their tables with their features.

Migration 2 replaces only the courses mirror in the migration transaction, retaining STRICT,
WITHOUT ROWID and the archive check. It copies each path, explicit abbreviation/colour, order
and archive value, with code initialized to NULL. All other data, entry ids, tags/assignments,
search text, indexes and info remain intact. Fresh databases run every migration. Regression tests
open a populated v1 fixture through `Catalog::open`, verify preservation and the latest
`user_version` (5 since migration 5), exercise nullable/three-grapheme/code settings, and reopen
without recovery or data loss.
Catalog schema version is separate from metadata `format_version`; SQLite stays rebuildable.

Migration 3 (feat/core-object-store) adds `packs` and `objects`, empty, and leaves every other
table as it is; fresh databases run all three. Their rows derive from the packs' indexes like the
rest of the catalog, so a rebuild reads the packs again ([versioning.md](versioning.md) §13.2);
`catalog/objects.rs` holds their repository. Its regression test takes the populated v1 fixture to
version 2, opens it through `Catalog::open` twice, and checks that every row stays without
recovery and that the two tables arrive empty, `STRICT` and without rowids, with the cascading
reference and the index on `objects (pack)`.

Migration 4 (feat/core-text-extract) adds `extracts`, empty; the covering partial index
`entries_extractable` on `entries (id, hash, class, kind)` for the hashed text and Word files; and
the trigger `entries_not_extractable`, which deletes an entry's row and clears its body in the
update that makes it a folder or another class (a rename to another extension, other versioning
rules), while a file waiting for its new hash keeps both until it is extracted again. Every other
table stays as it is; fresh databases run all four. The next hash job extracts every text and
Word file, so a library from an older build gets its search bodies without a rebuild.
`catalog/extracts.rs` holds the repository:

- `pending_extracts(after, limit, version)` (by id, like `unhashed_files`) and
  `count_pending_extracts(version)`: hashed text and Word files without a row, or whose row has
  another hash, class or extractor version. Never folders, `other` files or files without a hash.
  The count, most of a pass with nothing to do, pairs two scans in id order (the index, and the
  table `extracts`) instead of looking up each entry's row, which overflows SQLite's page cache on
  a large library (21,600 files: 5 ms against 85). A new extractor version (`extract::VERSION`)
  re-extracts every file through the ordinary pass, with no work while the catalog opens.
- `record_extract(file, version, state)` writes the row only if the entry still has the id, hash
  and class the caller read (`INSERT … SELECT … WHERE EXISTS … ON CONFLICT DO UPDATE`), and only
  then sets the body (the text, or `NULL` for every other status) with `set_body`; a file deleted
  or changed meanwhile is passed over (`false`), never an error. A failure is stored with the hash
  and tried again only when the content, class or version changes. `record_extracts(version,
  outcomes)` does the same for a batch, every row before any body: each row's insert opens a
  statement savepoint, at which FTS5 writes what it holds as a new index segment, so interleaving
  would cost a segment and its merges per file.
- `failed_extracts(version)`, by path: the failed rows that still hold for their entry's hash and
  class and the given version, read through the partial index.

The row and the body change in the caller's transaction. Rows go with their entries through the
cascade (which needs `foreign_keys=ON`; `sqlite3_changes` does not count cascades, so delete
counts stay exact), and with `reset_for_rebuild`; rebuilt entries have new ids, so a late guarded
write after a rebuild changes nothing. Its regression test takes the populated v1 fixture to
version 3, adds a pack and an object, opens it through `Catalog::open` twice, and checks that every
row stays without recovery and that `extracts` arrives empty and `STRICT`, with the cascading
reference and the partial index.

Migration 5 (feat/core-workspace) adds `head_files` and `unhashed`, empty, and leaves every other
table as it is; fresh databases run all five. `head_files` derives from `HEAD` (the head sync,
`workspace::sync`, which records `history_head` and `history_version` once its rows are in), and
`unhashed` from the hash pass, which writes a row for a file it found not local or could not read
and removes it when it stores the file's hash. `reset_for_rebuild` removes the `unhashed` rows with
their entries and leaves the `head_files` rows unpaired; the rebuild's forced head sync derives
them again and pairs them by path. `catalog/head_files.rs` and
`catalog/unhashed.rs` hold the repositories. No index of the unpaired rows: re-pairing scans the
table in path order, and a second B-tree keyed by paths doubles what a crafted `HEAD` of long
paths costs to write. Its regression test takes a populated version-4 catalog through
`Catalog::open` and checks that every row stays and that the two tables arrive empty and `STRICT`,
with their references (`SET NULL`, cascading), the partial index and the kind checks.

The entry repositories keep the `search` row in step: an entry's `name` and `path` columns are
written with the entry, `tags` whenever its tags or a tag's name change, and `body` by extraction.
Deleting an entry deletes its subtree by path range; a trigger removes the `search` row of every
deleted entry, however it goes. `parent_id` does not cascade, so a delete that would leave
children behind fails instead of silently taking them, and the change count is exact.

Inserts avoid `RETURNING`: it makes SQLite open a statement journal, and FTS5 then flushes its
pending terms on every insert (a full scan of 48,000 entries took 21 s instead of 0.9 s).

### 5.3 Opening and recovery

`Catalog::open(path, library_id)` creates the folder, opens the writer, migrates, checks `info`,
brings derived data up to date (§5.4), and returns whether it had to recover:

- An **error**, moving nothing, when the environment fails: I/O, permissions, a full disk, a
  lock held by another process, memory (`SQLITE_IOERR`, `SQLITE_PERM`, `SQLITE_FULL`,
  `SQLITE_BUSY`, `SQLITE_LOCKED`, `SQLITE_CANTOPEN`, `SQLITE_READONLY`, `SQLITE_NOMEM`,
  `SQLITE_INTERRUPT`, `SQLITE_PROTOCOL`), or when the file system cannot do WAL. A new file would
  not help.
- **Recovered** when anything else fails while opening: the file is not a database or is
  corrupt, has a newer or invalid schema version, holds data that fails validation, or names
  another library. The catalog is derived, so replacing it loses nothing. The database and its
  `-wal` and `-shm` files are moved to `catalog.broken.sqlite*` (replacing an older broken copy)
  and a new catalog is created; if that fails too, it is an error. The caller must then rebuild
  the catalog from the disk and `.folio/` (scan lane).

### 5.4 Derived versions

`info` stores the versions that produced the derived data. When one differs from the code:

- `tokenizer_version` (`search::TOKENIZER_VERSION`): FTS5 `rebuild` re-tokenises the stored text.
- `paths_version` (`paths::PATHS_VERSION`): every stored path is read again, which checks it
  against the current rules (§5.3), and every `path_key` is recomputed.

Both happen in the opening transaction, before anything reads or writes.

## 6. Search

**Query building** (`search::SearchQuery::parse`), the only way user text reaches `MATCH`:

1. Input longer than 256 characters is `QueryError::TooLong`; the IPC layer maps it before
   anything else runs.
2. Split at whitespace. Each term becomes one quoted phrase (`search::phrase`); terms are ANDed.
   Terms without tokens are dropped; no terms left → no query, no results.
3. The last term gets the prefix operator (`"alg" *`) when its last token is a non-CJK word of at
   least two characters. A one-letter word matches whole words only; CJK never gets a prefix.

**Ranking.** `bm25(search, 10.0, 3.0, 5.0, 1.0)` for name > tags > path > body (weights in
column order name, path, tags, body). The best `max(4 × limit, 100)` matches are then re-ranked
in Rust: relevance (`-bm25`) times a recency boost of up to 1.5 that halves every 30 days since
the entry's modification time. Ties go to the shorter path.

**Highlights.** Computed only for rows on screen, one query per row (`MATCH … AND rowid = ?`):
the name with its matches, and a snippet of the body (16 tokens; none without body text). The markers are U+0001 and
U+0002, which no Windows name contains and which are removed from body text before it is stored;
the core returns spans (text plus a highlighted flag), and the UI renders them as text. Body text
is also stripped of NUL and capped at 1 MiB, cut at a character boundary.

## 7. Errors

| Type | Variants |
|---|---|
| `paths::PathError` | `Empty`, `NotNfc`, `DotSegment`, `ReservedCharacter`, `TrailingDotOrSpace`, `ReservedName`, `NameTooLong`, `TooLong` |
| `paths::WrongDepth` | A path that is not a semester or course folder |
| `meta::MetaError` | `Io`, `TooLarge`, `Invalid`, `NewerFormat` (each names the file); `NameTooLong` (a semester or course name too long for its metadata file); `Random` (no ids without the OS random number generator) |
| `meta::ValueError` | A value that breaks its rule, such as a tag id; deserialization reports it as `Invalid` |
| `catalog::CatalogError` | `Sqlite` (stored data that fails validation is a conversion error), `Migration`, `Io`, `Invalid` (the catalog cannot be set up), `MissingParent`, `NoEntry` |
| `catalog::Recovery` | Why `open` replaced the database: `Unreadable`, `NewerSchema`, `OtherLibrary` |
| `search::QueryError` | `TooLong` |

The shell maps them to the IPC error union ([ipc-m1.md](ipc-m1.md) §16); `detail` strings are for
logs.

## 8. Tests

| Area | Tests |
|---|---|
| `paths` | Every name rule, NFC, join and prefix helpers; properties: valid paths round-trip, keys ignore case, parsing never panics |
| `meta` | Golden bytes per file; round trips; deterministic output; sorted keys; `NewerFormat`; missing or unknown fields; BOM; duplicate and case-duplicate keys; escaping round trip (property); atomic replace leaves no temporary file; retry on transient errors |
| `catalog` | `Migrations::validate()`; reopen keeps data; WAL and PRAGMAs; readers can query `search`; tokenizer and path-key version changes; recovery from garbage, a newer schema and another library; I/O errors are not recovered; subtree delete removes `search` rows; tags feed the `tags` column; semester and course mirrors; reads while a write is open; `extracts`: pending selection, guarded records and batches (one index segment per batch), cascades and rebuilds, the trigger for entries that stop being text, the count's two scans, failures through their index, search over recorded bodies, a model-based property test |
| `search` | Quoting, prefix rules, NUL and quotes, too-long input; ranking by column; recency boost; highlight spans; marker characters removed from bodies |

## 9. Refinements to ADR-0002

1. **`path_key` is indexed, not unique** (§3): uniqueness would depend on the NTFS upcase table of
   each volume.
2. **Escaped metadata names** (§4.1): semester and course names starting with `_` get one extra
   `_`, so they cannot collide with `_group.json` or `_root.json`.
3. **Temporary files live in `.folio/local/staging/`** (ADR-0003 §4) instead of next to the
   target: same volume, one rename, and nothing temporary appears in tracked folders.
4. **The single writer is a mutex, not a thread** (§5.1): the same guarantee with less code; the
   shell already calls the core from blocking tasks.
5. **Module name `catalog`**, as in the system overview, instead of `storage`.
6. **Entries carry no semester or course ids** (§5.2): views use path ranges.

A seventh refinement, decided by the roadmap session under Sirui's authorization (2026-10-07,
roadmap decision `search-generated-by-name`; proposed by `feat/core-text-extract`, 2026-10-06):
**generated files are skipped by name only**, where ADR-0002 §5 skips "generated or
minified files": a name whose stem ends in `.min`, and known lockfiles (`extract::is_generated`,
[versioning.md](versioning.md) §13.3). Telling minified code by its content misfires on notebooks
with outputs, so a minified bundle under an ordinary name (`dist/bundle.js`) is indexed, within the
1 MiB cap.

## 10. Next lanes

1. **Scan and reconcile**: done, specified in [library-scan.md](library-scan.md) (2026-09-27).
2. **Library operations**: create a library (writes `library.json` and `tags.json`), take over a
   folder, semesters and courses, tagging, import.
3. **Windows adapters** on Sirui's machine: watcher, file ids, Recycle Bin, NTFS checks.
   Specified in [windows-adapter.md](windows-adapter.md) (2026-09-27).
4. **IPC contract for M1**, then the UI from the design handoff.
