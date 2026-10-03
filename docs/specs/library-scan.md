# Library scan and reconcile

System design for the lane after [library core](library-core.md): walking the library, deciding
what belongs in it, and bringing the catalog and the `.folio/meta/` files in line with the disk.
Decisions stay in the ADRs; this spec fixes the details they leave open.

- Status: draft, 2026-09-27 (lane `claude/amazing-johnson-pzvhzd`).
- Inputs: [brief](../product/brief.md) §4, §5.1, §9; [ADR-0002](../adr/ADR-0002-data-storage.md)
  §1–§4; [ADR-0003](../adr/ADR-0003-versioning-and-sync.md) §2, §7, §10;
  [library core](library-core.md); [system overview](system-overview.md) §2–§3, §6.
- Section 11 lists what this spec adds to or changes in earlier documents.

## 1. Scope

| In this lane | Later lanes |
|---|---|
| `fs`: the file-system adapter, its standard implementation and a fake for tests | Windows adapter: `FileIdExtdDirectoryInfo` enumeration with file ids, placeholder states, the watcher |
| `library::scan`: walk, ignore rules, names and twins, catalog updates, moves by file id | Library operations: create and take over a library, semesters, courses, tagging, import, renaming names to NFC |
| Tags and settings that follow moved entries in `.folio/meta/` | IPC contract and UI for problems, progress and settings |
| The metadata mirror: `tags.json`, semester and course settings, entry tags | Text extraction (M2) |
| `library::hash_pending`: resumable, cancellable BLAKE3 hashing | Commits and history (M2) |

Everything runs and is tested on any OS; nothing here calls a Windows API.

## 2. Modules

| Module | Owns | Uses |
|---|---|---|
| `fs` | `FileSystem` (the adapter trait), `StdFileSystem` | — |
| `library` | `Library`: scan, reconcile, metadata mirror, hashing; ignore rules; problems | `fs`, `paths`, `meta`, `catalog`, `hash` |
| `meta::tree` | Every file in `.folio/meta/` read at once, moved along with entries, written back | `meta` |
| `catalog` | New repository functions for the reconcile (§6.3) | — |

`Library` holds the library root, its `meta::Layout` and an `Arc<dyn FileSystem>`. It does not
own the catalog; the shell passes the library's `Catalog` to each call.

## 3. The file-system adapter

```rust
pub trait FileSystem: Send + Sync {
    fn read_dir(&self, folder: &Path) -> io::Result<Vec<DirEntry>>;   // no `.` or `..`
    fn metadata(&self, path: &Path) -> io::Result<Metadata>;          // does not follow links
    fn open(&self, path: &Path) -> io::Result<Box<dyn Read + '_>>;    // shared with other programs
}
pub struct DirEntry { pub name: OsString, pub metadata: Metadata }
pub struct Metadata {
    pub kind: FileKind,             // File, Folder, Link (symbolic link or junction), Other
    pub size: u64,
    pub modified_ns: Option<i64>,   // nanoseconds since the Unix epoch
    pub created_ns: Option<i64>,     // for the first scan's `added_ns` (§6.3)
    pub file_id: Option<String>,    // stable across renames on one volume; opaque
    pub presence: Presence,         // Local, Placeholder or Offline (windows-adapter.md §3.1)
}
```

- The adapter reaches the user's files only. Folio's own files in `.folio/` are read and written
  by `meta` with `std::fs`, as before.
- `StdFileSystem` uses `std::fs`. On Windows, `read_dir` takes metadata from the directory listing
  without opening files, and `File::open` shares files for reading, writing and deletion. It
  reports **no file ids**: std exposes them only on nightly, and Unix inode numbers are reused
  right after a delete, which would pair unrelated files. `win::WindowsFileSystem` adds NTFS
  file ids (volume serial number and 128-bit file id) from `FileIdExtdDirectoryInfo`, and
  behaves like `StdFileSystem` off local NTFS ([windows-adapter.md](windows-adapter.md) §3).
- Tests use `MemFs`, an in-memory fake with NTFS-like ids: kept by renames, new for new files.
  It can also hold names that Windows cannot, and inject listing and read failures.

## 4. What belongs in the library

The walk starts at the library root (or at a scope, §6.4), lists each folder once through the
adapter and descends into folders that belong in the library. Each name goes through these
steps, in order:

1. **Folio's folder.** `.folio` at the root, in any case, is skipped (`meta::is_folio_owned`).
2. **Unicode.** A name that is not valid Unicode (unpaired UTF-16 surrogates on Windows) is
   reported (`NotUnicode`) and skipped with everything below it.
3. **Ignore rules** (§5). An ignored entry is skipped silently, with everything below it.
4. **Kind.** Links (symbolic links and junctions) are reported (`Link`) and never followed.
   Anything that is neither a file nor a folder is reported (`Special`).
5. **Windows name rules** (library core §3). An invalid name is reported (`InvalidName`) and
   skipped.
6. **NFC.** A name in another normalization form is reported (`NotNfc`) and skipped with
   everything below it, together with the NFC name next to it if there is one (an NFC/NFD twin,
   ADR-0003 §7). The scan never renames anything: renaming to NFC is a library operation the UI
   offers. Until then the file is not in the catalog, like any other name Folio cannot store.
7. **Case twins.** Names in one folder that differ only in case (possible in case-sensitive
   directories) are all catalogued and reported together (`CaseTwins`): the remote and every
   other device need them to differ.

A folder that cannot be listed is reported (`Unreadable`), and its catalog entries are kept as
they are instead of being removed. When the root itself cannot be listed, the scan fails.

## 5. Ignore rules

Brief §5.1: system and temporary files, the folders of version control, dependencies and virtual
environments are ignored, `.gitignore` files are honoured, and the rules are editable. ADR-0003
§10 chose the `ignore` crate's `Gitignore` for gitignore semantics.

**Precedence**, from the rules that win to the rules that yield:

| Rules | Where | Can be overridden |
|---|---|---|
| Built-in | Code: names iCloud never syncs (`*.nosync`, `*.tmp`, `~$*`, ADR-0003 §7) and the macOS `Icon\r` file | No: a remote could not hold them |
| `.gitignore` files | Any folder in the library; each applies below its folder, the deepest first, as in Git | By a deeper `.gitignore` |
| `.folio/ignore` | Library-wide, synced (ADR-0002 §2), gitignore syntax relative to the root | By `.gitignore` files |
| Defaults | Code (`library::DEFAULT_IGNORE_RULES`), evaluated before `.folio/ignore` in one matcher | By `.folio/ignore`, e.g. `!node_modules/` |
| Virtual environments | A folder containing `pyvenv.cfg` | By any rule that matches the folder with `!` |

Defaults: `.DS_Store`, `._*`, `.AppleDouble/`, `.Spotlight-V100/`, `.Trashes/`, `.fseventsd/`,
`.TemporaryItems/`, `Thumbs.db`, `ehthumbs.db`, `desktop.ini`, `$RECYCLE.BIN/`,
`System Volume Information/`, `.~lock.*#`, `.git`, `.svn/`, `.hg/`, `node_modules/`,
`__pycache__/`, `.venv/`, `.ipynb_checkpoints/`, `.pytest_cache/`, `.mypy_cache/`, `.ruff_cache/`,
`.gradle/`, `.idea/`, `.vs/`. Build folders such as `build/` or `target/` are common names for
real folders, so only a project's `.gitignore` ignores them.

- Matching ignores case (NTFS does), and runs on NFC text: rule lines and names are normalized
  first, so a rule typed on a Mac still matches.
- `.gitignore` files are honoured with or without a `.git` folder next to them; Git's global and
  per-repository excludes are not read.
- A line that is not a valid pattern is reported (`InvalidIgnoreRule`, with the `.gitignore`, or
  none for `.folio/ignore`, and the line) and skipped; the other lines still apply. A
  `.gitignore` that cannot be read is reported (`Unreadable`); `.folio/ignore` is read by `meta`
  like the other files of `.folio/`, and one that cannot be read stops the scan.
- Changing the rules needs a full scan: newly ignored entries leave the catalog, and newly
  included ones enter it. Their tags stay in `.folio/meta/`, so they come back with them.

## 6. Reconcile

### 6.1 Matching the disk to the catalog

The walk produces a snapshot: every entry that belongs in the library with its metadata. Each
catalog entry in the scope is matched to at most one snapshot entry:

1. **By file id**, when both have one, the id is unique on both sides, and the kind is the same.
   The entry moved if the paths differ, including a change of case only.
2. **By the path it should have now**: its own path, rewritten when its nearest ancestor moved
   by file id. Entries without ids thereby follow a moved folder.
3. A snapshot entry that matches nothing is **added**; a catalog entry that matches nothing is
   **removed** with its subtree.

A matched file is **modified** when its size, modification time or file id changed; its hash is
cleared for the hashing pass (§8). A matched entry whose kind changed is removed and added
again. The class (from `library.json`, library core §4.2) is refreshed on every match, so a
change of the versioning rules only needs a scan.

What cannot be paired:

- Without file ids (`StdFileSystem`), a rename outside a running Folio is a removal and an
  addition, and the tags stay behind in `.folio/meta/` (§7.3 reports orphaned settings).
- With file ids, a file saved through a temporary file (a new id) *and* moved before the next
  scan: same result. The watcher lane narrows the window by pairing renames from its events.

Pairing by content hash was considered and left out: it needs hashes of every candidate before
the catalog can change, and fails for exactly the edited files above.

### 6.2 Changes

The scan returns its changes (`Added`, `Removed`, `Modified`, `Moved { from, to }`, one per
entry, a moved and modified file both) and its problems. The shell turns them into
`fs.changed` events; the workspace (M2) diffs against the last commit on its own.

### 6.3 Applying the changes

One write transaction per scan, in this order, so no statement breaks `UNIQUE(path)` or the
`parent_id` foreign key, and every entry ends up with the folder entry at its parent path:

1. Moved entries get a temporary path (`U+0001` and their id, never a valid path, never read)
   and no parent. Entries that stay while their folder entry moves or goes keep their path but
   lose their parent too: another entry may take the folder's path, such as a folder renamed to
   its name that cannot be listed, below which the old entries stay (§4).
2. Removed entries are deleted in one statement, at whose end SQLite checks the foreign key; the
   trigger removes their search rows (library core §5.2).
3. Moved entries get their new path, key and name, and their search rows the new name and folder.
4. Added entries are inserted, parents before children.
5. The entries of step 1 get the folder entry at their parent path.
6. Matched entries get their new metadata.

`catalog::apply_changes` does this for any set of changes, so its callers never reason about
parents.

**When an entry came in** (`added_ns`, ADR-0002's `first_seen_at`), for the brief's "recently
added" view: a scan records the time it first saw the entry, since a file moved in from
elsewhere on the same NTFS volume keeps its old creation time. A catalog that no scan has
committed to yet, a new library's or a rebuilt one, takes each file's creation time instead (its
modification time where there is none, never later than now), so a rebuild does not make
everything look new. The first scan that commits records itself in `info` (`first_scan_ns`), so
a library that started empty dates what comes in later by the scan, like any other. Moves keep
the entry, and with it the time. The schema is unreleased, so migration 1 changes in place.

### 6.4 Scopes

`scan(catalog, None)` covers the library. `scan(catalog, Some(folder))` covers one folder and
everything below it, for the watcher lane: the scope widens to the nearest ancestor the catalog
knows, the `.gitignore` files of its ancestors are read first, and an ignored or missing scope
removes its entries. A scope that is a `.gitignore` or `pyvenv.cfg` (any case) covers its folder,
whose entries it decides; at the root, the library. Moves are only found inside the scope; the watcher pairs moves by file id
and scopes both ends into one scan ([windows-adapter.md](windows-adapter.md) §5.3).

## 7. Metadata

### 7.1 Tags and settings follow moves

Tags are keyed by path in `.folio/meta/` (ADR-0002 §3), so every move the scan finds is applied
there too (ADR-0003 §10: "tag assignments move with the renamed file"). `meta::tree` reads every
file of `.folio/meta/` once, and a move rewrites paths by the most specific move that covers
them. Paths are compared as NTFS compares names, without case: a key or a file name there may
differ in case from its entry, say after a sync. Where two files name one folder, which only a
case-sensitive disk allows, moves write into the one the mirror reads (§7.2).

- **Tags** of the moved entry and of every path below it move to their new file and key,
  `meta::tag_location` deciding which file holds them. Assignments for paths that no longer exist
  move too, so the tags of a file that has not arrived from sync yet follow its folder.
- **Settings** of a semester or course move when it stays a semester or course. Otherwise they
  stay where they were, and the file is reported as orphaned (§7.3) instead of deleted.
- A moved assignment replaces one for the same path at the target, compared without case, so a
  stale assignment never blocks the write. `Assignments::set` does this for every writer, so a
  file never holds two paths that name one file.
- Files are then written back where they changed: a rename (on NTFS the only way to change the
  case of a name) for a file or semester folder whose new name differs only in case, then atomic
  writes, then deletions of files left without settings or tags, then empty semester folders.
- A file that cannot be read (invalid, or written by a newer Folio) is never written or deleted.
  Moves that would need it are reported (`NotRelocated`) and leave its tags where they are, as
  do tags whose new path would be too long.

Semester and course settings become optional in their files (`group` and `course` may be left
out), so a file can hold the tags of a folder nobody has configured yet, such as a subfolder
that became a course. The UI shows defaults for a semester or course without settings.

**Crash safety** (ADR-0002 §1, ADR-0003 §4). The metadata files are written before the catalog
changes, through a journal, `.folio/local/journal/scan.json`:

1. Renames of names that changed only in case, which need no journal: the next plan finds them
   done or does them again.
2. The journal, written atomically: an id, and what each file about to change held before.
3. The files, then the catalog, whose transaction records the journal's id; then the journal is
   removed.

A normal scan journal is settled before metadata is read. If the catalog holds its id, the
scan committed and the journal only goes. Otherwise its files are restored before the scan
starts over. Applying the same moves twice would be wrong: a swap would swap back. A new
catalog knows no old paths, so it removes a plain scan journal and leaves the authored files.
Ordinary scans retain the case-rename ordering above; explicit operations use the protocol below.

An in-app rename or move writes local journal format 3 before metadata or the Windows rename,
including when no tags change. It records the validated source/destination, complete catalogued
subtree identities and disk fingerprints, metadata before/after images and physical metadata
case renames. This local format is separate from synced metadata format 2. Readers accept prior
scan journal versions 1 and 2; legacy move pairs are recovered only when the catalog and disk
still provide enough identity evidence. An existing unsettled journal cannot be overwritten.
Publication is capped at the existing 32 MiB metadata read limit and fails before changing files
if the record would exceed it.

`Library::recover_pending` runs a separate writer transaction before walking or starting another
operation. A matching source with no destination means the OS rename was not performed: restore
the before state. A matching destination with no source means it completed: keep the authored
after state and apply the explicit catalog moves, preserving entry ids, hashes, bodies and added
times even without file ids. Exact directory spelling distinguishes case-only renames on both
case-insensitive and case-sensitive directories. Conflicting/missing paths, replaced identities,
unreadable evidence or externally changed metadata stop with a typed error
(`LibraryError::UnfinishedMove`; failing to read or write a metadata file stays `Meta`, and a
folder on the move's paths that cannot be listed fails as that folder, `Root`, so the user tries
again instead of discarding) and retain the files and journal. Recovery never overwrites a competing authored edit. It commits
the reconciled catalog and journal marker before cleanup, so another crash is safe to retry. A
rebuild cannot bypass an unresolved operation intent.

**Discarding an unfinished move** (Sirui, 2026-09-30; lane `feat/core-discard-move`). Only the
user lets go of an intent recovery cannot reconcile (ipc-m1 §6, `discard_unfinished_move`).
`Library::discard_move` runs under the writer's lock, like every writer of `.folio/`:

1. It never moves, deletes or opens a user file; it only lists folders to see where the item is.
   It uses the listing's metadata, without individual attribute probes that open file handles.
2. When the item is at its source and not at its destination, by exact spelling as recovery
   checks it, its kind still matches the intent (or the legacy catalog identity), and every
   metadata file the journal names holds its before- or after-image
   (`validate_images`), the before-images go back (`restore`, case renames first). In every
   other case (the move happened, the item is in both places or neither, a link or another kind
   of entry is on the way, a file holds something else) no metadata file changes; a folder that
   cannot be listed fails the discard (`Root`) rather than guess. The files the move wrote
   before the rename stand, and a file edited since is never overwritten. A journal whose
   catalog update committed only goes.
3. Then the journal goes, and the caller runs a full scan. Its catalog may still be the one from
   before the move (the operation's transaction rolled back), replaced, or rebuilt; the scan
   brings it in line with the disk and the metadata files. It relocates no tags twice: moves it
   finds between the old catalog and the disk only carry what the metadata still holds at the
   old paths. The catalog is not reset: entries keep their ids, hashes and dates.

A failure while restoring or removing the journal keeps the journal, and calling again is safe:
the images are checked again, restoring writes the same bytes, and the journal goes last. A
journal that names no move (a scan's) is left for the next scan; one that cannot be read is not
discarded (`catalogFailed`).
Only an image conflict found before restoration may leave metadata unchanged and discard the
record. An invalid case rename encountered during restoration returns a typed error and keeps
the record, including after a prior rename succeeded. A committed journal is cleanup only and
does not inspect the user's move paths.

The shell serializes recovery with the full worker walk and operations, and publishes its
committed report before dependent work; a later failed or cancelled scan cannot hide it. Direct
core callers likewise publish `recover_pending` before work that may fail. These recovery
guarantees and the narrow startup/journal extension were approved by Sirui on 2026-09-30.

The journal is input like any other file in the library folder. Each path in it must name a
metadata file as the layout spells it (`_root.json`, `<semester>/_group.json` or
`<semester>/<course>.json`, names escaped), and undoing writes to the path the layout builds from
it, never to the text itself. A journal that cannot be read, or names anything else, stops the
scan with a typed error (`MetaError::Invalid`): Folio writes it atomically and only with paths
it built, so it was damaged or put there. Recovery records are retained while their operation
cannot be safely reconciled.

### 7.2 The mirror

After every scan, the same transaction brings the catalog's copy of `.folio/` in line:

- `tags.json` replaces the tag definitions when they differ; a missing file means no tags.
- A semester or course row exists for every semester or course folder whose file has settings.
  A file whose name differs in case from its folder still counts. Where two files name one
  folder, which only a case-sensitive disk allows, one holds its metadata (`meta::Owners`): the
  one spelled like the folder, else the first by name, whether or not it can be read. The other
  is reported as orphaned.
- Entry tags come from every tag file: each key is resolved to the entry at that path (the exact
  path first, then the only entry with the same key) and kept only if `tag_location` of that
  entry points back at the same file and key.
- What a file that cannot be read gave the catalog before stays: its settings rows and the tags
  of the entries it holds. A file locked for a moment must not clear a course's tags.

Every scan reads all of `.folio/meta/`, a few kilobytes per course; only differences are
written, so writes grow with what changed, not with the library.

### 7.3 Problems

`OrphanedMetadata` names a semester or course file whose folder does not exist, so the UI can
offer to reattach or delete it. A metadata file that cannot be read is reported (`Metadata`,
with `MetadataFailure::Newer` when a newer Folio wrote it); with a newer file, the library's
metadata becomes read-only (ADR-0002 §3), so no move rewrites any file.

### 7.4 One writer

Every writer of `.folio/meta/` runs inside `Catalog::write`, so the catalog's writer mutex also
serializes the metadata files. The scan reads the metadata tree inside its transaction.

## 8. Hashing

`Library::hash_pending(catalog, now_ns, cancel, progress)` computes the BLAKE3 hash of every file
whose hash is missing (ADR-0003 §2): after a scan added or modified it. It is a background job:

- It works in batches: up to 1,024 pending rows are read, hashed without holding the writer,
  and stored in short writes at least every 250 ms, so progress survives a crash or
  cancellation, whatever the size of the files, and the next run continues.
- A hash is stored only if the file's size, modification time and file id are the same before
  and after reading it and still match the catalog row.
- Files modified less than two seconds before `now_ns` are deferred: they may still be written
  (Git's racy-clean problem). The report counts them so the caller can run again.
- A file that cannot be read (locked, access denied) is reported (`Unreadable`) and stays
  pending; a file that vanished waits for the next scan.
- A file whose content is not on this disk (a cloud placeholder or an offline file) is never
  read, since reading it downloads it: it stays pending and is counted (`not_local`,
  [windows-adapter.md](windows-adapter.md) §3.4).
- `cancel` is checked between files and every 256 KiB; `progress` receives files done and the
  total.

Scans never hash, so a new library is browsable before its hashes are done (system overview §6).

## 9. Errors and problems

| Type | Meaning |
|---|---|
| `library::LibraryError` | The current scan stopped: the root cannot be listed, `library.json` is missing, invalid or newer, a metadata file cannot be written, recovery evidence conflicts (`UnfinishedMove` for an in-app move recovery cannot reconcile, §7.1), or the catalog failed. A recovery committed before the scan remains committed and is published separately |
| `library::Problem` | Something the user should see, the scan went on: `NotUnicode`, `InvalidName`, `NotNfc`, `CaseTwins`, `Link`, `Special`, `Unreadable`, `InvalidIgnoreRule`, `Metadata`, `OrphanedMetadata`, `NotRelocated` |
| `library::ReadFailure` | Why something could not be read: `Denied`, `InUse` (another program holds it; Windows sharing and lock violations), `TooLarge`, `Other` |
| `library::MetadataFailure` | `Newer`, `Invalid`, `Unreadable(ReadFailure)` |
| `meta::StrandedCause` | Why tags or settings could not follow a move: `ReadOnly`, `FolderTags`, `Unreadable`, `TooLong` |

Every case the UI words differently has its own variant; `detail` strings are for logs (library
core §7). Problems are recomputed by every scan; the shell keeps the latest list per scope.

## 10. Tests

| Area | Tests |
|---|---|
| `fs` | `StdFileSystem` lists kinds, sizes and times, and does not follow links |
| Walk | Each step of §4 with `MemFs`, including names Windows cannot hold; unreadable folders keep their entries |
| Ignore rules | Precedence of §5 row by row; case and NFC; invalid lines; `.gitignore` in scopes; a scope that is a `.gitignore` covers its folder, or the library at the root (it fails without that: checked once by hand) |
| Reconcile | Add, modify, remove, kind change; moves by id of files and folders, case-only moves, swaps; id-less entries following a moved folder; entry ids survive moves; entries that stay while their folder entry moves or goes, below a folder that cannot be listed too, get the folder entry at their parent path; `added_ns` of a first scan, a later one and a library that started empty |
| Metadata | Tags and settings follow every kind of move, also where names in `.folio/meta/` differ in case; case-only renames of files and semester folders; broken and newer files are never written; paths that would be too long |
| Journal | A swap interrupted between the metadata and the catalog is undone and redone, not swapped back; a half-written move is finished; the journal of a committed scan is removed, not undone; a journal that names other files (`..`, `\`, absolute, drive or UNC paths, unescaped names) stops before touching anything and is retained through a failed rebuild; `sync_metadata` settles an interrupted scan first. Explicit operation tests cover no-id and case-only moves, second recovery crashes, conflicting/unreadable evidence, legacy journals, the size cap and cleanup failure. Discarding (`operations/entries_tests.rs`): every conflict is `UnfinishedMove` and its discard writes no metadata; a replaced catalog rebuilds by a scan with the tags where the file is; an unmoved item gets its before-images back without a user file being opened; a metadata file edited since is left with every other; a discard stopped while restoring or before the journal goes finishes on the next call; a scan's journal and a committed move's are never reverted. Mutation checks: undoing nothing, undoing committed journals, or joining the journal's paths as written, fails a test |
| Mirror | Definitions, settings and entry tags; orphaned files; tag files of unconfigured folders; a file that cannot be read keeps what it gave; of two files that name one folder, the one spelled like it holds moved tags |
| Hashing | Deferral, verification, locked files, cancellation, resume |
| Property | ADR-0002: after random creations, edits, saves through temporary files, deletions, renames (case-only ones included), tagging, settings and hashing, the incrementally maintained catalog equals one rebuilt from scratch, apart from when entries were added (§6.3); entries keep their ids and times, files their tags, and semesters and courses their settings while their file ids survive. Mutation checks: each of eight deliberate bugs in matching, relocation, catalog updates and hashing fails it or a unit test |
| Benchmark | `tests/scan_benchmark.rs`, ignored by default, release builds. In the cloud container (tmpfs, `StdFileSystem`), 49,920 files took 0.91 s for the first scan, 0.30 s for a scan without changes, 0.65 s to hash (100 MB) and 0.33 s to rescan after renaming a 1,040-file course; the catalog was 29 MB. On NTFS on Sirui's machine (2026-09-28: Core Ultra 9 275HX, NVMe SSD, Microsoft Defender real-time protection on, no other build running; the second of two rounds): `StdFileSystem` 0.59 s, 0.16 s, 9.6 s and 0.20 s (the rename as 2,092 removals and additions), `WindowsFileSystem` 0.64 s, 0.19 s, 9.4 s and 0.24 s (1,046 moves); catalogs of 28.6 MB and 33.4 MB (file ids). Hashing takes about 190 µs a file on NTFS against 13 µs in the container (§12 item 4). Removals go in one statement: one per entry made FTS5 flush for each, about 1 ms apiece |

## 11. Additions to earlier documents

1. **`added_ns` replaces `first_seen_at`** (ADR-0002 §4 sketch, library core §5.2): nanoseconds,
   and a rebuild takes files' creation times instead of making everything new (§6.3).
2. **Semester and course settings are optional** in their metadata files (library core §4.2), so
   tags can move into a folder without settings.
3. **`StdFileSystem` reports no file ids**; renames outside a running Folio are detected once the
   Windows adapter supplies them (§3, §6.1).
4. `catalog::remove_semester` removes only the semester's row; the mirror removes course rows
   itself.

## 12. Next lanes

1. **Windows adapter** on Sirui's machine: `FileIdExtdDirectoryInfo`, file ids, placeholder and
   offline attributes, the watcher (`ReadDirectoryChangesExW`) calling scoped scans. Specified in
   [windows-adapter.md](windows-adapter.md) (2026-09-27), with the Recycle Bin.
2. **Library operations**: create, take over, semesters and courses, tagging, import, rename to
   NFC, reattaching orphaned metadata; the shell's scan and hashing jobs. If operations update
   the catalog through scoped scans, `catalog::apply_changes` is its only writer of entries and
   `upsert_entry` and `delete_entry`, which only tests call today, go.
3. **IPC contract for M1**, then the UI.
4. **Performance**, measured with the benchmark once libraries grow:
   - The mirror resolves every tag assignment on every scan, about 100 ms per 17,000
     assignments. It could skip files whose content and covered entries are unchanged since
     the last mirror, given a fingerprint per file in the catalog.
   - Relocation visits every assignment when anything moved, about 40 ms per 17,000; files that
     no move lies above or below could be skipped.
   - Hashing checks each file's metadata by path before and after reading it, so it opens every
     file three times: about 190 µs a file on NTFS with Defender (§10), 9.5 s for 50,000 files.
     The check after reading can come from the handle that read the file, saving one of the
     three opens. The check before must stay an open for attributes only: it is what keeps a
     cloud placeholder from being read ([windows-adapter.md](windows-adapter.md) §3.4).
