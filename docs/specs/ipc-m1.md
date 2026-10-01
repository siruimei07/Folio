# IPC contract for M1

System design for the interface between the M1 UI and the shell: the commands, typed events and
error union the UI uses for the local library (brief §11, M1). Decisions that are costly to
reverse are in [ADR-0004](../adr/ADR-0004-ipc-contract.md); this spec fixes the details.

- Status: accepted with ADR-0004 (Sirui, 2026-09-28); written 2026-09-27 in lane
  `feat/ipc-m1-contract`. The types live in `crates/folio-app/src/ipc/`; no command has
  behaviour yet (§3). The implementation lanes of §21 change this line as they land. Contract
  fixes of 2026-09-29 (`feat/ipc-m1-contract-fixes`): §20.2.
- Inputs: [brief](../product/brief.md) §4, §5.1–§5.3, §7, §9, §13;
  [app-shell handoff](../design/handoff/app-shell.md); [ADR-0001](../adr/ADR-0001-application-stack.md)
  §3, §4 and action item 5; [ADR-0002](../adr/ADR-0002-data-storage.md);
  [ADR-0003](../adr/ADR-0003-versioning-and-sync.md) §7, §10;
  [system overview](system-overview.md) §2–§4; [library core](library-core.md);
  [library scan](library-scan.md).
- Product decisions for this contract (Sirui, 2026-09-27):
  1. Import asks before it overwrites: one choice (replace, keep both, skip) for all name clashes.
  2. A folder's tags apply to everything below it, in filters and in "untagged".
  3. A filter with several tags matches files that have all of them.
  4. Courses get an optional code, typed by the user and never guessed from folder names.
  5. Course badge text is 1–3 characters.
  6. "Open with default app" never runs programs or scripts.

## 1. Scope

| In this contract | In later contracts |
|---|---|
| Library: status, choose a folder, create or take over, open | Settings: device name, theme, AI, ignore rules, file types |
| Semesters and courses: list, create, update, reorder | Actions on problems: rename to NFC, reattach or discard orphaned metadata |
| Tags: list, create, update, reorder, delete, assign | Workspace, commits and history (M2) |
| Entries: list, filter, get, create a folder, rename, move, delete to the Recycle Bin | Sync (M3) |
| Search with pages | Office previews (M4) |
| Preview: file bytes and thumbnails, open with the default app, show in File Explorer | |
| Import: pick or drop, check, import with tags | |
| Jobs (scans, hashing, imports, catalog rebuilds), problems, change notifications | |

## 2. Requirements

| Need | Commands and events |
|---|---|
| First run: new library or take over a folder (brief §5.1, §7) | `library_status`, `pick_library_folder`, `create_library`, `open_library`, `LibraryStateChanged` |
| Semester switcher, archived semesters (handoff §3) | `list_semesters`, `create_semester`, `update_semester`, `reorder_semesters` |
| Courses with badge, code and file count; Settings → Courses (handoff §5, §9) | `list_courses`, `create_course`, `update_course`, `reorder_courses` |
| Tag filter bar, chips, Settings → Tags, batch tagging (brief §5.1, handoff §5, §9) | `list_tags`, `create_tag`, `update_tag`, `reorder_tags`, `delete_tag`, `set_entry_tags` |
| Tree, list and grid; sort by name, date, size, type; "Recently added", "Untagged"; counts (brief §5.1, handoff §5) | `list_children`, `list_files`, `get_entry` |
| New folder, rename, move between courses, delete to the Recycle Bin (brief §5.1) | `create_folder`, `rename_entry`, `move_entries`, `delete_entries` |
| `Ctrl+K` search as you type, grouped results with highlights (brief §5.2, handoff §8) | `search` |
| Preview, open with the default app, show in File Explorer (brief §5.3, handoff §5) | `folio-file` scheme, `open_entry`, `reveal_entry` |
| Images next to a Markdown note (ADR-0005 product decision 1) | `resolve_paths` |
| UI errors in the shell's log (UI architecture §13) | `log_ui_error` |
| Import by drop or "Add files", with tags, optionally deleting the originals (brief §5.1) | `pick_import_files`, `FilesDropped`, `DropHover`, `check_import`, `import_files` |
| Progress of scans, hashing and imports; "Rebuild search index" (handoff §9) | `list_jobs`, `cancel_job`, `rebuild_catalog`, `JobChanged` |
| Problems found by scans (library-scan §9) | `list_problems`, `ProblemsChanged` |
| Changes made in other programs show up on their own (brief §5.1) | `CatalogChanged` |

Non-functional:

- **Latency.** A page of 200 rows in under 50 ms and a search page of 50 hits with highlights in
  under 100 ms at 50,000 entries (ADR-0002 benchmark: 1–81 ms per page of 50). Commands are async
  and call the core through `spawn_blocking`, so the UI thread never waits on disk.
- **Scale.** The UI holds pages, never the whole catalog (system overview §6).
- **Security.** The UI is untrusted (CLAUDE.md §5). It names only what the shell gave it: entries
  by reference (§5.1), user choices by token (§4.2), tags by id. The only free text it sends is
  names the user typed and search text, and the shell validates both (§16.3, §17).
- **No silent failures.** Every command resolves to data or an `AppError`; batch commands list
  every item that failed.
- **Language.** The shell sends no UI text: errors are codes, and the only strings are user data
  (names, file text) and `detail` strings for logs.

## 3. Placeholders: declared, not registered

Every command of this spec is declared now with its final signature, so the generated bindings
give the UI typed functions and the UI lanes can start. None is registered with Tauri until its
implementation lands (ADR-0004 §8):

| Where | Planned command | Implemented command |
|---|---|---|
| Stub in its group's `crates/folio-app/src/commands/<group>.rs`, compiled only in test builds | yes | removed |
| `ipc::export_builder` (`export_bindings` test, so `bindings.ts`) | yes | yes |
| `ipc::builder` (the runtime `invoke_handler`), from `commands/<group>/manifest.rs` | no | yes |
| App manifest in `crates/folio-app/build.rs`, from the same `manifest.rs` | no | yes |
| Grant in `crates/folio-app/capabilities/<group>.json` | no | yes |

Since `feat/core-library-state` (2026-09-28) each feature group owns these files
([library-state.md](library-state.md), "Command ownership"); later lanes edit only their group's.

Security impact:

- **The runtime surface does not change.** No handler, manifest entry or grant is added. The app
  has an ACL manifest, so Tauri checks every app command against the capabilities and rejects a
  planned command before any handler runs (`Command … not allowed by ACL`); the UI gets a
  `Transport` error.
- **No shipped build contains a stub.** Stubs exist only under `cfg(test)`, so no mistake in the
  runtime builder can mount one.
- **A command gains power in exactly one change.** Its lane adds the handler, the manifest entry
  and the grant together, with contract tests and `/security-review`, so the capability diff marks
  the review point. The test `runtime_commands_are_declared_and_granted` fails if the three lists
  differ or if a planned command is in any of them.
- The generated TypeScript names functions that do nothing yet; they expose no data.
- Rejected: registering and granting placeholder handlers now. About 35 commands would be
  callable with no review point when each gains behaviour, since later diffs would change code
  behind grants that already exist.
- Rejected: exporting types only. The UI would have no typed functions, and hand-written `invoke`
  calls would duplicate the contract.

Events are registered in both builders: they flow from the shell to the UI only, the window has no
`core:event:allow-emit` grant, and the shell listens to none of them.

## 4. Conventions

| Topic | Rule |
|---|---|
| Names | `snake_case` commands become camelCase functions: `list_children` is `ipc.listChildren` |
| Arguments | None, or one request object named `request`, so fields can be added without reordering |
| Fields | camelCase; every key is always present; a missing value is `null` |
| Enums | Enums without data are string unions (`"name"`); enums with data are objects tagged by `kind` (`state` for statuses, `code` for errors) |
| Integers | `u32` (TypeScript `number`) for counts, offsets, limits and positions. 64-bit values are decimal strings: entry ids, sizes in bytes, times in milliseconds since the Unix epoch (`modifiedMs`) |
| Paths | Library-relative path text (library core §3): NFC, `/` between names, no leading `/`. Where a folder is expected, `null` is the library root. The only absolute paths are for display: library roots (`LibraryInfo.root`, `LibraryStatus` `unavailable`, `FolderContent` `insideLibrary`) and the chosen folder (`FolderChoice.path`) |
| Order | Lists arrive sorted and the UI keeps their order: semesters, courses and tags in the user's order, pages in the requested order |
| Unknown fields | Ignored, so an `EntryRow` can be passed where an `EntryRef` is expected |
| Malformed requests | A request that does not deserialize is rejected by Tauri before the handler runs: `Transport`. Values the UI should never send are `InvalidArgument` |

### 4.1 Limits

One constant, `LIMITS`, is exported with the bindings; the shell enforces the same values.

| Key | Value | Limits |
|---|---|---|
| `pageSize` | 500 | `limit` of a page request |
| `searchResults` | 500 | `offset + limit` of a search page |
| `queryChars` | 256 | Search text, in characters (`search::MAX_QUERY_CHARS`) |
| `batch` | 10,000 | Entries in one batch command |
| `filterTags` | 16 | Tags in one filter |
| `nameUnits` | 255 | A file or folder name, in UTF-16 code units (`paths::MAX_NAME_UNITS`) |
| `displayNameChars` | 128 | A library or tag name, in characters |
| `abbrGraphemes` | 3 | A course badge text, in grapheme clusters |
| `courseCodeChars` | 32 | A course code, in characters |
| `eventEntries` | 200 | Changes listed in one `CatalogChanged` |
| `resolvePaths` | 64 | Paths in one `resolve_paths` request |
| `relativePathChars` | 1,024 | A relative path in `resolve_paths`, in characters |
| `logChars` | 8,192 | The `message`, and the `stack`, of one `log_ui_error` report, in characters |

### 4.2 User choices

Folders and files outside the library reach the shell only through the user: a native dialog the
shell opens, or files dropped on the window, which the shell receives from Windows (ADR-0004 §2).
The shell keeps the paths and gives the UI a **choice token**:

- 32 lower-case hexadecimal digits (128 random bits);
- single use, and bound to its kind: a library folder choice cannot be an import source;
- forgotten after 10 minutes and when the library changes; an unknown, used or expired token is
  `ChoiceExpired`.

No command accepts an absolute path. For end-to-end tests, the dialogs have a test double that an
environment variable selects in debug builds only, like `FOLIO_DATA_DIR`.

## 5. Shared types

### 5.1 Entry references

```ts
type EntryRef = { id: string; path: string };
```

- `id` is the catalog id: stable while the entry exists, kept when it moves or is renamed
  (library scan §6.1). `path` is where the UI saw it.
- The shell resolves a reference in the same catalog transaction as what it does with it: the
  entry must exist and be at `path`, case included; otherwise `NotFound`. A stale reference
  therefore never acts on another entry: SQLite may reuse the highest id after that entry goes,
  and a rebuilt catalog numbers its entries anew.
- References are the only way the UI names entries. `.folio/`, ignored files and links are never
  in the catalog, so the UI cannot name them.

### 5.2 Rows

```ts
type EntryRow = {
  id: string; path: string;      // as in EntryRef
  name: string;                  // the last name of the path
  kind: "file" | "folder";
  class: "text" | "word" | "other"; // from the extension (library core §4.2); "other" for folders
  size: string;                  // bytes; "0" for folders
  modifiedMs: string | null;     // a hint only (ADR-0003 §10)
  addedMs: string;               // when it came into the library (library scan §6.3)
  tags: string[];                // its own tag ids, in tag order
  folderTags: string[];          // tag ids from folders above it (§8.2), not repeating `tags`
};
```

Tag ids can name tags that `tags.json` does not define (yet); the UI shows them as unknown.

### 5.3 Pages and sorting

```ts
type PageRequest = { offset: number; limit: number };   // limit 0..=pageSize; 0 returns only `total`
type Page<T> = { items: T[]; offset: number; total: number; revision: number };
type EntrySort = { key: SortKey; descending: boolean };
type SortKey = "name" | "path" | "modified" | "size" | "type" | "added";
```

- Pages are offset windows with a total, so virtualised lists can jump to any row and size their
  scroll bars. `revision` is the catalog revision the page was read at (§15.2).
- `name` sorts like File Explorer: without case, and digits by value (`hw2` before `hw10`).
  `type` sorts by extension, then name. `path` sorts by path, for building a tree from flat pages.
  Missing modification times sort last in both directions. Ties go to the path, so the order is
  total and pages never overlap.
- `list_children` puts folders before files, whatever the key.

### 5.4 Batch results

```ts
type BatchResult = { done: number; failed: ItemFailure[] };
type ItemFailure = { entry: EntryRef; error: AppError };
```

Items are independent: one failure does not stop the others, because a file system has no
transaction across files. `failed` lists every item that failed.

## 6. Library

| Command | Request → response | Errors |
|---|---|---|
| `library_status` | — → `LibraryStatus` | `DataDirUnavailable` |
| `pick_library_folder` | — → `FolderChoice \| null` (null: cancelled) | `Internal` |
| `create_library` | `CreateLibrary` → `LibraryOpened` | `ChoiceExpired`, `AlreadyALibrary`, name errors (§16.3), `AccessDenied`, `DiskFull`, `FileSystem` |
| `open_library` | `OpenLibrary` → `LibraryOpened` | `ChoiceExpired`, `NotALibrary`, `NewerFormat`, `AccessDenied`, `FileSystem`, `Internal` |

```ts
type LibraryStatus =
  | { state: "none" }                                  // no library on this machine yet
  | { state: "open"; library: LibraryInfo }
  | { state: "unavailable"; root: string; reason: Unavailable };
type Unavailable = "missing" | "notALibrary" | "newerFormat" | "accessDenied" | "catalogFailed";
type LibraryInfo = { id: string; name: string; root: string; readOnly: boolean; recovered: boolean };

type FolderChoice = { token: string; path: string; content: FolderContent; syncRoot: SyncProvider | null };
type FolderContent =
  | { kind: "empty" }
  | { kind: "library"; name: string }                  // already a Folio library: open it
  | { kind: "insideLibrary"; root: string }            // inside another library: refused
  | { kind: "incomplete"; folders: number; files: number } // .folio/ without library.json: finish it
  | { kind: "folders"; folders: number; files: number }; // content to take over, first level only
type SyncProvider = "iCloud" | "oneDrive" | "dropbox" | "other";

type CreateLibrary = { folder: string; name: string; presetTags: PresetTagNames };
type PresetTagNames = { notes: string; slides: string; homework: string; exam: string; reference: string };
type OpenLibrary = { folder: string };
type LibraryOpened = { library: LibraryInfo; scan: string };   // the id of the scan job it started
```

- The shell opens the configured library when it starts; `library_status` waits for that, so the
  UI never sees a half-open library. Later changes arrive as `LibraryStateChanged`.
- **`library_status` retries an unavailable library**, which is the unavailable screen's "Try
  again" (first-run handoff §7). When the status is `unavailable` and was so before the call
  began, the shell opens the configured library again, as at start-up and behind the same gate as
  `open_library`, and answers with the outcome: `open`, with `LibraryStateChanged` and a new
  start-up scan, or `unavailable` with this attempt's reason. A status that became `unavailable`
  while the call waited, from start-up or from another call's retry, is answered as it is, so
  start-up never opens twice and calls at the same moment retry once. `none` and `open` are
  answered as they are. A retry never changes `settings.json`.
- `readOnly`: a metadata file was written by a newer Folio, so tags and settings cannot change
  until Folio is updated (ADR-0002 §3). `recovered`: the catalog was replaced when it opened
  (library core §5.3), and the scan rebuilds it.
- `create_library` covers both first-run paths (brief §7): in an empty folder it starts a new
  library, in a folder with content it takes the content over without moving anything. It writes
  `library.json` and `tags.json` with the preset tags, named by the UI in its language (library
  core §4.2), makes the folder this machine's library (brief §13: one per machine), and starts a
  full scan. A folder that is, or is inside, a library is `AlreadyALibrary`.
- `incomplete`: the folder has a `.folio/` folder but no `library.json`, as a creation that failed
  leaves it (a full disk, a crash), or a library whose `library.json` was lost. `create_library`
  finishes it in place: everything `.folio/` holds stays, tags included, only missing files are
  written (the preset tags only when there is no `tags.json`), and `library.json` comes last with
  a new library id. `open_library` still answers `NotALibrary` there. The counts leave `.folio/`
  out. A file or a link named `.folio` is not an incomplete library: it counts as content, and
  `create_library` fails with `Internal` without writing anything.
- `syncRoot`: the folder is inside a cloud-sync folder. The UI warns (ADR-0002 §6); the shell does
  not refuse.
- `open_library` opens a folder that holds `.folio/library.json`, for example after reinstalling.

The shell decides an `Unavailable` reason where the failure happens: opening the folder, reading
`.folio/`, opening the catalog, or the library's background work (a scan, hashing, a rebuild, the
watcher). It never guesses the reason from an `AppError` code, which cannot tell a missing folder
from a catalog file that could not be created.

| Reason | Covers |
|---|---|
| `missing` | The folder cannot be reached: it is gone or not a folder, or its drive or share is not connected. Also any other failure to open, list or watch it, or to read `.folio/`, except those below |
| `notALibrary` | The folder is there, but `.folio/library.json` is missing or damaged, or `.folio/` holds a link |
| `newerFormat` | `library.json` comes from a newer Folio |
| `accessDenied` | Windows denied access to the folder or to `.folio/` |
| `catalogFailed` | The folder is there, but Folio's own state failed: the catalog in the data directory could not be opened or written (another copy of Folio holds it, the disk is full, the database is damaged beyond recovery), `.folio/` could not be read or written because its disk is full or another program holds a file, or the background work failed |

## 7. Semesters and courses

```ts
type Semester = { folder: EntryRef; name: string; archived: boolean };
type Course = {
  folder: EntryRef; name: string;
  abbr: string | null;    // badge text, 1–3 characters; null: the UI derives it from the name
  code: string | null;    // e.g. "MAT232", typed by the user
  color: string | null;   // a palette key; null: the UI's default
  archived: boolean;
  files: number;          // files inside, at any depth
};
```

| Command | Request → response | Errors |
|---|---|---|
| `list_semesters` | — → `Semester[]` | `NoLibrary` |
| `create_semester` | `{ name }` → `Semester` | name errors, `AlreadyExists`, `ReadOnly`, file-system errors |
| `update_semester` | `{ semester: EntryRef; archived }` → `Semester` | `NotFound`, `ReadOnly` |
| `reorder_semesters` | `{ semesters: EntryRef[] }` → `Semester[]` | `NotFound`, `InvalidArgument` (not every semester exactly once), `ReadOnly` |
| `list_courses` | `{ semester: EntryRef \| null }` → `Course[]` (null: every semester's, by semester) | `NotFound` |
| `create_course` | `{ semester: EntryRef; name; abbr; code; color }` → `Course` | name errors, `AlreadyExists`, `ReadOnly`, file-system errors |
| `update_course` | `{ course: EntryRef; abbr; code; color; archived }` → `Course` | `NotFound`, name errors (`abbr`, `code`), `ReadOnly` |
| `reorder_courses` | `{ semester: EntryRef; courses: EntryRef[] }` → `Course[]` | `NotFound`, `InvalidArgument`, `ReadOnly` |

- A semester is any folder directly in the library and a course any folder directly in a semester
  (brief §4), with or without settings. A new semester or course goes last; folders without an
  order follow the ordered ones, by name.
- `abbr`: 1–3 grapheme clusters without whitespace or control characters. `code`: 1–32
  characters without surrounding whitespace or control characters. `color`: a key of the tag and
  course palette (`design/tokens/`: red, orange, amber, green, teal, blue, indigo, violet, pink,
  stone); the core checks only its form, so the UI shows a key it does not know in a neutral
  colour. `null` stores nothing: defaults follow the name when it changes.
- `update_course` replaces all four fields: send what the dialog shows.
- Paths show course codes in place of course folders (handoff decision 27B), so the UI keeps the
  courses of every semester: `list_courses` with `semester: null`, refreshed when
  `CatalogChanged` reports `groups`.
- Archiving moves nothing on disk (brief §5.1).
- Renaming, moving and deleting a semester or course are `rename_entry`, `move_entries` and
  `delete_entries` on its folder. Settings and tags follow a rename or a move (library scan §7.1);
  a course moved into another semester stays a course.

## 8. Tags

### 8.1 Commands

```ts
type Tag = { id: string; name: string; color: string; usage: number };  // usage: entries that carry it themselves
```

| Command | Request → response | Errors |
|---|---|---|
| `list_tags` | — → `Tag[]` | `NoLibrary` |
| `create_tag` | `{ name; color }` → `Tag` | name errors, `AlreadyExists` (same name, ignoring case), `ReadOnly` |
| `update_tag` | `{ id; name; color }` → `Tag` | `NotFound`, name errors, `AlreadyExists`, `ReadOnly` |
| `reorder_tags` | `{ tags: string[] }` → `Tag[]` | `InvalidArgument` (not every tag exactly once), `ReadOnly` |
| `delete_tag` | `{ id }` → `{ assignments: number }` | `NotFound`, `ReadOnly` |
| `set_entry_tags` | `{ entries: EntryRef[]; add: string[]; remove: string[] }` → `BatchResult` | per item: `NotFound`, `InvalidArgument` (a semester or course folder), `ReadOnly`, file-system errors |

- `create_library` defines the presets; after that they are ordinary tags.
- `delete_tag` removes the definition and every assignment, and reports how many it removed.
- `set_entry_tags` adds and removes; `add` and `remove` must not overlap, and every tag in `add`
  must be defined. Removing a tag that an entry only gets from a folder changes nothing: it is the
  folder's.

### 8.2 Folder tags apply below them

A file's **effective tags** are its own and those of every folder above it inside its course
(semester and course folders carry no tags, library core §4.1). Tag filters and "untagged" use
effective tags; `EntryRow` lists the two sets apart, so the UI can show which tags a remove button
can take away.

## 9. Entries

### 9.1 Listing

| Command | Request → response | Errors |
|---|---|---|
| `list_children` | `{ folder: EntryRef \| null; sort: EntrySort; page }` → `Page<EntryRow>` | `NotFound`, `InvalidArgument` (not a folder) |
| `list_files` | `{ scope: EntryRef \| null; filter: EntryFilter; sort; page }` → `Page<EntryRow>` | `NotFound`, `InvalidArgument` |
| `get_entry` | `{ entry: EntryRef }` → `EntryRow` | `NotFound` |
| `resolve_paths` | `{ base: EntryRef; paths: string[] }` → `(EntryRow \| null)[]` | `NotFound` (`base`), `InvalidArgument` (`base` a folder, over the limits) |

```ts
type EntryFilter = { tags: TagFilter | null; addedAfterMs: string | null };
type TagFilter =
  | { kind: "withAll"; tags: string[] }   // effective tags include every one (1..=filterTags)
  | { kind: "untagged" };                 // no effective tags
```

- `list_children` lists one folder (`null`: the library root). `list_files` lists files only, at
  any depth below `scope` (`null`: the whole library, archived semesters included).
- How the handoff uses them: the tree expands with `list_children`; a tag filter in the tree is
  `list_files` over the semester sorted by `path`, from which the UI builds the tree; "Recently
  added" and "Untagged" are `list_files` with `addedAfterMs` or `untagged`; every count is a page
  with `limit: 0`; the grid is `list_children` of the selected folder.

`resolve_paths` finds the files a note names by relative path, such as `![](figure.png)` or
`<img src="images/a.png">` next to a Markdown note (ADR-0005 product decision 1; UI architecture
§10.4 has the flow):

- `base` is the note, a file; each path is resolved against its folder. The answer has one item
  per path, in the same order: the file's `EntryRow`, or `null`. Duplicates get one item each.
- A path arrives as the note writes it, percent-decoded by the window, without its `?…` and `#…`
  parts: names separated by `/` or `\`, with `.` and `..`; empty names (`a//b`) are skipped. The
  shell converts each name to NFC and resolves the path in the catalog, in one read. Names match
  as Windows matches them: an exact match first, otherwise the one entry whose name differs only
  in case (case twins without an exact match: `null`).
- An item is `null` when its path is absolute (`/…`, `\…`, `C:…`, `\\…`) or has a scheme
  (`https:`, `file:`, `data:`), goes above the library root, names a folder, or names nothing
  catalogued: a missing, ignored or linked file, or anything in `.folio/`. Paths may leave the
  note's course: a vault's shared attachments folder is common.
- Limits: at most `resolvePaths` paths, each at most `relativePathChars` characters; beyond them,
  or a `base` that is a folder, the call is `InvalidArgument`. A stale `base` is `NotFound`. The
  window leaves out paths that are not well-formed text (`String.prototype.isWellFormed`): the
  shell's JSON parser refuses lone surrogates, which would fail the whole call as `Transport`.
- It reads only, like `get_entry`, and needs no grant beyond reading the catalog. Wiki embeds
  (`![[figure.png]]`, found by name anywhere) are not in M1.

### 9.2 Changing

| Command | Request → response | Errors |
|---|---|---|
| `create_folder` | `{ parent: EntryRef; name }` → `EntryRow` | `NotFound`, `InvalidArgument` (parent not inside a course), name errors, `AlreadyExists`, file-system errors |
| `rename_entry` | `{ entry: EntryRef; name }` → `EntryRow` | `NotFound`, name errors, `AlreadyExists`, `ReadOnly`, `InUse`, file-system errors |
| `move_entries` | `{ entries: EntryRef[]; to: EntryRef \| null }` → `BatchResult` | `NotFound` (the target); per item: `NotFound`, `InvalidMove`, `AlreadyExists`, `ReadOnly`, `InUse`, file-system errors |
| `delete_entries` | `{ entries: EntryRef[] }` → `BatchResult` | per item: `NotFound`, `InUse`, `NotRecyclable`, file-system errors |

- `create_folder` makes folders inside courses; semesters and courses have their own commands,
  which also write their settings.
- `rename_entry` takes one name (§16.3). A change of case only is a rename too.
- `move_entries` moves into a folder or the library root. `InvalidMove`: a folder into itself or a
  folder below it, or a semester folder (rename it instead). Other moves change what an entry is
  as a move in File Explorer would, and the scan's rules apply (library scan §7.1): a folder moved
  directly into a semester becomes a course, and tags that cannot follow are reported as problems.
- `rename_entry` and `move_entries` fail with `ReadOnly` when tags or settings would have to follow
  and the metadata is read-only.
- `delete_entries` moves entries to the Recycle Bin (brief §5.1), a folder with everything in it.
  Tags stay in `.folio/meta/`, so a file restored from the Recycle Bin gets them back. An item the
  Recycle Bin cannot take (its drive has none, its path is too long for it, it is too large) fails
  with `NotRecyclable` and stays where it is: Folio never deletes for good (Windows adapter §4). A
  later version may offer "Delete permanently" for it, as its own confirmed command.

## 10. Search

| Command | Request → response | Errors |
|---|---|---|
| `search` | `{ text; scope: EntryRef \| null; page }` → `SearchPage` | `QueryTooLong`, `NotFound` (scope), `InvalidArgument` |

```ts
type SearchPage = { items: SearchHit[]; offset: number; more: boolean; revision: number };
type SearchHit = { entry: EntryRow; name: Span[]; snippet: Span[] | null };
type Span = { text: string; matched: boolean };
```

- `text` longer than `queryChars` is `QueryTooLong`, checked before anything else (library core
  §6). Text without searchable words gives an empty page, not an error.
- `scope` limits results to a folder, such as the current semester; `null` searches the whole
  library.
- Ranking follows library core §6. A search ranks the best `searchResults` matches at one
  revision, and pages slice that list, so pages of one revision never overlap or skip;
  `offset + limit` must not exceed `searchResults`. `more` says whether the list goes on.
- `name` covers the whole name; `snippet` is body text around a match (16 tokens), or `null` when
  the body has no match. Render spans as text, never as HTML. The handoff's "File names" group is the hits whose name has
  a matched span; "Contents" holds the rest.
- The UI waits for a pause in typing and drops the response to a superseded query.

## 11. Preview and opening files

### 11.1 Commands

| Command | Request → response | Errors |
|---|---|---|
| `open_entry` | `{ entry: EntryRef }` → `{ mode: "default" \| "editor" }` | `NotFound`, `Blocked`, `FileSystem` |
| `reveal_entry` | `{ entry: EntryRef }` → `null` | `NotFound`, `FileSystem` |

`open_entry` never runs a program or a script (ADR-0004 §9):

- A file runs code when its extension is a program or shortcut type (`exe com scr pif cpl msi msp
  msix appx application appref-ms lnk url website hta jar reg scf` and the like, including Office
  add-ins, which Office loads as code: `xll wll xla xlam xlm ppa ppam`, and installers such as
  `ppkg vsto xbap`), or when the program registered to open it is a command interpreter or script
  host (cmd, PowerShell, Windows Script Host, mshta, Python, Java, Node, bash or WSL, and the like).
- A registration the shell cannot verify as one program taking the file (a COM handler, such as
  Explorer's for `.zip`, or no registered program) fails with `Blocked` as well; the detail names
  why, for the log.
- Such a file opens with its registered "edit" verb (`mode: "editor"`, for example a `.bat` in
  Notepad). Without one, the command fails with `Blocked`, and the UI offers "Show in File
  Explorer".
- Anything else opens with its default program (`mode: "default"`); a folder opens in File
  Explorer. A `.py` that opens in an editor opens normally.
- The shell decides from the file's extension and its registered programs, never from anything the
  UI says about the file.

`reveal_entry` opens File Explorer with the entry selected.

### 11.2 The `folio-file` scheme

File bytes do not travel in IPC messages (system overview §2). A read-only scheme serves them
(ADR-0004 §6):

| URL | Serves |
|---|---|
| `http://folio-file.localhost/content/{id}/{path}` | The file's bytes; `Range` requests get `206` |
| `http://folio-file.localhost/thumbnail/{id}/{size}/{path}` | A PNG thumbnail, `size` 64, 128 or 256 |

- `{path}` is the entry's path with each name percent-encoded as UTF-8. The shell serves a
  catalogued file whose id is at that path, like an `EntryRef`, and answers `404` otherwise. Only
  `GET` and `HEAD`.
- **Sizes.** Tauri buffers each response. Without `Range` a response holds at most 256 MiB, the
  preview's PDF limit (UI architecture §10.1); a larger file answers `InvalidArgument` and is read
  with ranges. A `Range` response holds at most 8 MiB from the range's start, and
  `Content-Range` names what it holds, so a media element asks again for the rest. Ask for
  `bytes=N-` or `bytes=N-M`: a suffix range (`bytes=-N`) is not CORS-safelisted, so `fetch` sends
  `OPTIONS` first, which the scheme refuses (`Transport`).
- Thumbnails are cached by content hash under the catalog's hash of the file (system overview
  §5); until the hashing job has read a new or changed file, each request makes the image again.
- **Files not on this disk.** The scheme never reads a cloud placeholder or an offline file, for
  content or for a thumbnail (Sirui, 2026-09-29; the same rule as hashing, Windows adapter §3.4):
  reading one downloads it, and a folder of thumbnails would download the whole folder. It
  answers `NotLocal`; "Open with default app" downloads the file through its own app. A thumbnail
  Windows can give without reading the file (cloud providers keep their own) may be served.
- Every response carries `X-Content-Type-Options: nosniff`, `Cache-Control: no-store` and
  `Content-Security-Policy: sandbox; default-src 'none'`: a document loaded from the scheme can
  run no script, because Tauri treats app-registered schemes as local pages with the window's
  permissions (ADR-0001 action item 5). `Content-Type` comes from the extension for images, audio,
  video, PDF and plain text, and is `application/octet-stream` otherwise.
  `Access-Control-Allow-Origin` names the main window's origin only.
- The main window's CSP allows the scheme in `img-src`, `media-src` and `connect-src`. The preview
  frame's CSP does not: the window fetches the bytes and posts them into the frame
  (`apps/desktop/src/preview/protocol.ts`).
- `contentUrl(entry)` and `thumbnailUrl(entry, size)` in `apps/desktop/src/ipc` build these URLs.
  The preview lane implements the scheme and adds the CSP sources.

**Failures.** Every failed response names why in the header `X-Folio-Error`: the code of the
`AppError` it failed with, so the preview can use that code's message from `errors`. The body is
empty; the log has the details. `Access-Control-Expose-Headers: X-Folio-Error` lets the window
read it.

| Code | Status | When |
|---|---|---|
| `InvalidArgument` | `400`; `405` for a method other than `GET` and `HEAD`; `416` for a range outside the file, with `Content-Range: bytes */{size}` | A URL the UI never builds: an unknown route, an id that is not a number, a size other than 64, 128 or 256, a path that is not library path text; a file over 256 MiB without `Range` |
| `NotFound` | `404` | No catalogued file with that id at that path, or the file went away |
| `NoLibrary` | `503` | No library is open, or it is unavailable |
| `AccessDenied` | `403` | Windows denied reading the file |
| `InUse` | `409` | Another program holds the file without sharing reading |
| `NotLocal` | `409` | The file's content is not on this disk (above) |
| `NoThumbnail` | `404` | Thumbnails only: Windows has no thumbnail handler for the type, or the file is damaged |
| `FileSystem`, `Internal` | `500` | Another read failure; a bug |

- The header's name and the codes are exported with the bindings as `FILE_ERROR_HEADER` and
  `FILE_ERROR_CODES` (`crates/folio-app/src/ipc/entries.rs`); the scheme sends no other code, and
  a test checks that each is an `AppError` code.
- `fileError(response)` in `apps/desktop/src/ipc/files.ts` reads the code (`null` for a success,
  `Internal` for a failure without a code the scheme sends). `<img>`, `<audio>` and `<video>`
  cannot read their responses: after their `error` event the preview asks again with `HEAD`,
  which answers the same status and header without the bytes. Grids and lists show the type
  icon for any failed thumbnail and do not ask why, since each `HEAD` repeats the work.
- A `fetch` that rejects never reached the scheme: `Transport`.

## 12. Import

| Command or event | Request → response | Errors |
|---|---|---|
| `pick_import_files` | — → `ImportSource \| null` (null: cancelled) | `Internal` |
| `FilesDropped` event | `{ source: ImportSource; position: Point }` | — |
| `DropHover` event | `{ position: Point \| null }` | — |
| `check_import` | `{ source: string; target: EntryRef }` → `ImportCheck` | `ChoiceExpired`, `NotFound`, `InvalidArgument` (target not a folder) |
| `import_files` | `ImportFiles` → job id | `ChoiceExpired`, `NotFound`, `InvalidArgument`, `ReadOnly` (with tags), `Busy` |

```ts
type ImportSource = { token: string; files: number; folders: number; names: ImportName[] }; // the first 10 top-level items
type ImportName = { name: string; kind: EntryKind };   // what the item is itself: a link is a "file"
type Point = { x: number; y: number };   // CSS pixels in the window's client area
type ImportCheck = {
  files: number; folders: number; bytes: string;
  skipped: number;                       // ignored by the library's rules, links, special files
  conflicts: ImportConflict[];           // the first 100
  conflictCount: number;
};
type ImportConflict = { path: string };  // a file in the library the import would replace
type ImportFiles = {
  source: string; target: EntryRef; tags: string[];
  onConflict: "replace" | "keepBoth" | "skip"; deleteOriginals: boolean;
};
```

- The UI calls `check_import` first and, when `conflictCount` is not 0, asks once how to handle
  the clashes: the choice applies to all of them (product decision 1).
  - `replace`: the file in the library goes to the Recycle Bin, and the new file takes its path and
    keeps its tags.
  - `keepBoth`: the new file takes the first free name `name (2).ext`, `name (3).ext`, …
  - `skip`: the new file stays out.
  - Clashes that appear after the check follow the same choice. A file never replaces a folder, or
    the other way round: those keep both.
- A dropped folder whose name exists in the target merges into it; only files clash.
- `skipped` items are not copied: what the library's ignore rules would ignore (library scan §5,
  such as `node_modules/` and `.git`), links and special files.
- `tags` go on every top-level item the import creates. A new folder carries them itself, so
  everything in it gets them (§8.2); files a merge adds to an existing folder get them one by one.
- `deleteOriginals`: once every item of a source is copied and its hash checked, the source goes to
  the Recycle Bin (brief §5.1). A source with anything skipped or failed stays, and the result
  lists it. A source, or a file `replace` would put in the Recycle Bin, that the Recycle Bin
  cannot take is a failure with `NotRecyclable`; for `replace`, the new file then stays out.
- `names` lets the dialog show folder icons and "Folder" (library-actions handoff §4); `files`
  and `folders` count the same top-level items.
- `target` is a folder: the current course, or a folder in it (brief §13).
- The job's result is an `ImportResult` (§13).

## 13. Jobs

| Command | Request → response | Errors |
|---|---|---|
| `list_jobs` | — → `Job[]` | `NoLibrary` |
| `cancel_job` | `{ job: string }` → `null` | `NotFound` (unknown or finished), `InvalidArgument` (not cancellable) |
| `rebuild_catalog` | — → job id | `NoLibrary`, `Busy` |

```ts
type Job = { id: string; kind: "scan" | "hash" | "import" | "rebuild"; cancellable: boolean; status: JobStatus };
type JobStatus =
  | { state: "queued" }
  | { state: "running"; progress: Progress }
  | { state: "done"; result: JobResult }
  | { state: "failed"; error: AppError }
  | { state: "cancelled" };
type Progress = {
  done: number; total: number | null;     // items: files or entries
  permille: number | null;                // 0–1000 by bytes, for jobs that measure bytes
  current: string | null;                 // the item in progress, for display
};
type JobResult =
  | { kind: "scan"; changes: number; problems: number }
  | { kind: "hash"; hashed: number; deferred: number }
  | ({ kind: "import" } & ImportResult)
  | { kind: "rebuild"; entries: number };
type ImportResult = {
  imported: number; replaced: number; renamed: number; skipped: number; originalsDeleted: number;
  failures: ImportFailure[]; failureCount: number;   // the first 100 failures
};
type ImportFailure = { name: string; error: AppError }; // name: the item's path below its source
```

- Jobs are the background work the user can see: full scans (after a library opens or is created,
  and after its ignore rules change), hashing after scans, imports and catalog rebuilds. Scans of
  one folder after a change outside Folio are not jobs; their results arrive as `CatalogChanged`
  and `ProblemsChanged`.
- One job of each kind runs at a time; imports queue. `list_jobs` returns the queued and running
  jobs, then the last 20 finished ones.
- Cancelling stops between files and keeps what is done: copied files stay, hashes stay.
- `rebuild_catalog` replaces the catalog and scans from scratch (library core §5.3). Entry ids
  change, so every reference the UI holds becomes stale. While it runs, commands that write fail
  with `Busy`; reads see the catalog as it grows.

## 14. Problems

| Command | Request → response | Errors |
|---|---|---|
| `list_problems` | `{ page }` → `Page<ProblemItem>` | `NoLibrary`, `InvalidArgument` |

```ts
type ProblemItem = { id: string; problem: Problem; detail: string };
type Problem =
  | { kind: "notUnicode"; folder: string | null; name: string }
  | { kind: "invalidName"; folder: string | null; name: string; rule: NameRule }
  | { kind: "notNfc"; folder: string | null; name: string; twin: boolean }
  | { kind: "caseTwins"; paths: string[] }
  | { kind: "link"; folder: string | null; name: string }
  | { kind: "special"; folder: string | null; name: string }
  | { kind: "unreadable"; path: string; failure: ReadFailure }
  | { kind: "invalidIgnoreRule"; file: string | null; line: number }
  | { kind: "metadata"; file: string; failure: MetadataFailure }
  | { kind: "orphanedMetadata"; folder: string }
  | { kind: "notRelocated"; from: string; to: string; cause: StrandedCause };
type NameRule = "empty" | "notNfc" | "dotName" | "invalidCharacter" | "trailingDotOrSpace"
  | "reservedName" | "tooLong" | "pathTooLong";
type ReadFailure = "denied" | "inUse" | "tooLarge" | "other";
type MetadataFailure = { kind: "newer" } | { kind: "invalid" } | { kind: "unreadable"; failure: ReadFailure };
type StrandedCause = "readOnly" | "folderTags" | "unreadable" | "tooLong";
```

- The variants are the core's (library scan §9); `detail` is for logs.
- The shell keeps the latest problems of every scan scope, plus files that hashing could not read.
  An `id` stays the same while its problem does, so later actions can name it.
- `ProblemsChanged` reports the new total whenever the list changes.

## 15. Events

### 15.1 List

| Event | Payload | When |
|---|---|---|
| `LibraryStateChanged` | `{ status: LibraryStatus }` | The library opens, is created, becomes unavailable or read-only |
| `CatalogChanged` | `{ revision; entries: EntryChange[]; complete; tags; groups }` | After committed catalog changes, Folio's own or from outside; at most ten per second, merged |
| `JobChanged` | `{ job: Job }` | A job changes state; while it runs, at most every 250 ms |
| `ProblemsChanged` | `{ total }` | The problem list changed |
| `FilesDropped` | `{ source: ImportSource; position: Point }` | Files or folders were dropped on the window (§12) |
| `DropHover` | `{ position: Point \| null }` | Files are dragged over the window; `null` when they leave or the drag ends |
| `MaximizeButtonChanged` | `{ hovered; pressed }` | Existing (ADR-0001 action item 4b) |

```ts
type EntryChange =
  | { kind: "added" | "modified" | "removed" | "tagged"; entry: EntryRef }
  | { kind: "moved"; entry: EntryRef; from: string };
```

- `removed` carries the reference as it was. `tagged`: the entry's own tags changed; for a folder,
  the `folderTags` of everything below it changed too.
- `complete: false`: more changed than `eventEntries`, or the catalog was rebuilt; refetch
  everything.
- `tags`: tag definitions changed (name, colour, order, deletion). `groups`: semesters or courses
  changed (their folders, settings or order).

### 15.2 Revisions

The shell counts committed catalog changes for the open library: `revision` starts at 0 when the
library opens and grows with every change (wrapping at 2³²). Every page carries the revision it
was read at, and every `CatalogChanged` the revision after the changes it reports. Pages of one
revision agree with each other; a page older than the last event is stale.

### 15.3 How the UI uses them

- Keep pages per query. On `CatalogChanged`, refetch the visible pages of queries that a change
  touches: `list_children` of each changed entry's parent (and old parent), and `list_files`,
  `search` and counts over a scope that contains one; everything when `complete` is `false`.
- Follow the previewed entry: `moved` gives its new path, `removed` closes the preview.
- On `LibraryStateChanged`, drop every cached page and reference.

## 16. Errors

### 16.1 Codes

`AppError` keeps its shape: `{ code, detail }` (`crates/folio-app/src/error.rs`). The UI shows the
message for `code` from `errors` in the locale file (`tsc` fails when one is missing); `detail` is
for logs and bug reports. Each case the UI words differently has its own code.

| Code | Meaning |
|---|---|
| `DataDirUnavailable`, `InvalidArgument`, `Window` | Existing: no data directory; a request the UI should never send; a window operation failed |
| `NoLibrary` | No library is open |
| `NotALibrary` | The folder has no `.folio/library.json` |
| `AlreadyALibrary` | The folder is, or is inside, a library |
| `NewerFormat` | A newer Folio wrote the library: update Folio to open it |
| `ReadOnly` | A newer Folio wrote some metadata: tags and settings cannot change until Folio is updated |
| `NotFound` | The entry, tag, semester, course or job is gone, or not where the UI saw it; refresh |
| `AlreadyExists` | The name is taken in that folder (ignoring case), or by another tag |
| `InvalidMove` | A folder into itself or below itself, or a semester folder |
| `NameEmpty`, `NameTooLong`, `NameInvalidCharacter`, `NameTrailingDotOrSpace`, `NameReserved`, `PathTooLong` | A typed name breaks a rule (§16.3) |
| `InUse` | Another program holds the file |
| `AccessDenied` | Windows denied access |
| `DiskFull` | The disk is full |
| `NotRecyclable` | The Recycle Bin cannot take the item: its drive has none, its path is too long for it, or it is too large. Nothing moved |
| `NotLocal` | The file's content is not on this disk (a cloud placeholder or offline file), and the shell does not download it (§11.2) |
| `NoThumbnail` | Windows cannot make a thumbnail of the file (§11.2) |
| `FileSystem` | Another file-system failure |
| `QueryTooLong` | Search text over `queryChars` |
| `ChoiceExpired` | A choice token is unknown, used or expired: choose again |
| `Blocked` | `open_entry` will not run a program or script |
| `Busy` | The catalog is being rebuilt |
| `Internal` | A bug or damaged state; the log has the details |

`Transport` (TypeScript only) stays: the call itself failed, for example a command the window may
not call.

### 16.2 From the core

| Core error | Code |
|---|---|
| `search::QueryError::TooLong` | `QueryTooLong` |
| `catalog::CatalogError::NoEntry`, `MissingParent` | `NotFound` |
| `catalog::CatalogError` (other) | `Internal` |
| `meta::MetaError::NewerFormat` | `NewerFormat` when opening, `ReadOnly` when writing |
| `meta::MetaError::Invalid`, `TooLarge`, `Random` | `Internal` (the problem list names the file) |
| `library::LibraryError::NotALibrary` | `NotALibrary` |
| `io::Error` | Not found: `NotFound`; sharing or lock violation: `InUse`; permission denied: `AccessDenied`; storage full: `DiskFull`; otherwise `FileSystem` |
| `paths::PathError` from typed names | §16.3 |
| `recycle::RecycleFailure` (Windows adapter §4) | `NotFound`: `NotFound`; `Unrecyclable`: `NotRecyclable`; `InUse`: `InUse`; `Denied`: `AccessDenied`; `Invalid`: `Internal`; `Other`: `FileSystem` |
| `fs::Presence` other than `Local`, where the shell would read the file | `NotLocal` |

### 16.3 Names the user types

The shell trims whitespace at both ends of a typed name and converts it to NFC, as File Explorer
and IMEs expect, then checks it:

| Name | Rules | Codes |
|---|---|---|
| File or folder (`create_folder`, `rename_entry`, `create_semester`, `create_course`) | Library core §3; `.folio` at the library root, in any case, is reserved | `NameEmpty`, `NameTooLong`, `NameInvalidCharacter`, `NameTrailingDotOrSpace`, `NameReserved`, `PathTooLong` |
| Library and tag names | 1–128 characters, no control characters | `NameEmpty`, `NameTooLong`, `NameInvalidCharacter` |
| Course badge (`abbr`) | 1–3 grapheme clusters, no whitespace or control characters | `NameEmpty`, `NameTooLong`, `NameInvalidCharacter` |
| Course code | 1–32 characters, no control characters | `NameEmpty`, `NameTooLong`, `NameInvalidCharacter` |

The UI knows which field it sent, so each code needs one message per field at most.

### 16.4 UI errors in the log

Errors in the window reach the console only; the shell's log is where bug reports come from (UI
architecture §13). One command writes them there; `chore/core-logging` implements it with the
logging module.

| Command | Request → response | Errors |
|---|---|---|
| `log_ui_error` | `LogUiError` → `null` | `InvalidArgument`, `AccessDenied`, `DiskFull`, `FileSystem` |

```ts
type LogUiError = {
  kind: "uncaught" | "boundary" | "command";
  source: string;        // where: a view, dialog or command, e.g. "preview", "windowControls.minimize"
  message: string;       // at most logChars characters
  stack: string | null;  // the error's stack and React's component stack; at most logChars
};
```

- `kind`: `uncaught` for what nothing caught (React's `onUncaughtError`, `window` `error` and
  `unhandledrejection`); `boundary` for what an error boundary caught and shows as "Reload this
  view" (`onCaughtError`); `command` for a failed command or event subscription whose failure the
  UI shows itself, such as a window command (library-actions handoff §9.5).
- `source` is 1–64 ASCII letters, digits, `.`, `-` and `_`: a name from the code, never data.
  `message` and `stack` hold error text only: the UI never puts file content, search text or
  names the user typed in them. It makes both well-formed (`String.prototype.toWellFormed`) and
  cuts them to at most `logChars` characters at a character boundary (`Array.from(text)`), never
  inside a surrogate pair: a lone surrogate fails the whole call as `Transport`, because the
  shell's JSON parser refuses it. The shell rejects longer text with `InvalidArgument`.
- The shell writes each report as one record with its time, escaping line breaks and control
  characters, so a report cannot forge other records.
- At most 30 reports a minute are written. The shell drops the rest and writes how many it
  dropped with the next record it keeps; a dropped report is not an error, because the UI can do
  nothing about it.
- One UTC date's file holds at most 8 MiB, whoever writes to it (failed file requests come from
  the page too). The record that reaches the budget is followed by a note, and later records that
  date are dropped; a UI report dropped this way counts as dropped above.
- When the log cannot be written, the command fails with the file-system code. The UI then writes
  to the console only and never shows an error about logging.

## 17. Security rules

Every implementation lane checks these; `/security-review` checks them again.

1. **No absolute paths from the UI.** Entries come as references resolved in the catalog (§5.1),
   outside locations as choice tokens (§4.2). A path the shell acts on is built from a catalog
   path, validated names and the library root (`RelPath::to_native`), never from other text.
   `resolve_paths` takes relative text from a note, but only looks it up in the catalog: it never
   touches the disk with it, answers `null` for anything absolute or above the root, and returns
   only catalogued files (§9.1).
2. **`.folio/` stays out of reach.** It is never catalogued, and the reserved name check (§16.3)
   keeps renames, moves and new folders from creating it at the root.
3. **Resolve and act in one transaction**, so no other change lands between the check and the
   action; disk operations follow the catalog check without yielding to other writers.
4. **Bounded work.** Page sizes, search windows, batch sizes, filter sizes, query lengths, path
   lists and log reports (§4.1) are checked before any query or write runs. Events carry at most
   `eventEntries` changes. The log takes at most 30 reports a minute and 8 MiB a day (§16.4).
5. **Nothing runs.** `open_entry` follows §11.1. Import copies files and never opens them.
6. **Scheme headers.** Every `folio-file` response follows §11.2, errors included. A failure
   sends its code only, never its detail.
7. **Drops.** Tauri's drop handler forwards dropped paths to the page (`tauri://drag-drop`) and
   adds them to its asset and file-system scopes. Folio enables neither the asset protocol nor a
   file-system plugin, so the scope change grants nothing; the page may learn the paths, but no
   command accepts them. The import lane turns on `dragDropEnabled` and replaces the test
   `main_window_does_not_publish_native_drag_paths` with one that checks the asset protocol and
   file-system plugins stay off.
8. **Logs, not the UI, get absolute paths.** `detail` strings may hold them; events and rows hold
   library-relative paths only.
9. **Reports cannot forge the log.** `log_ui_error` writes one escaped record per report, with a
   `source` limited to a name from the code (§16.4).
10. **Nothing is deleted for good, and nothing downloads.** What the Recycle Bin cannot take stays
    (`NotRecyclable`); the scheme never reads a file that is not on this disk (`NotLocal`).

## 18. Shell-side design

```text
UI  --invoke-->  command handler  --spawn_blocking-->  folio-core (Library, Catalog)
 ^                  |  validate: structure (serde) -> values -> references (catalog)
 |                  v
 +---events-----  LibraryState: Library, Arc<Catalog>, revision, jobs, choices, problems
```

- Tauri state holds one `LibraryState` behind a lock that is held only to clone the handles: the
  core `Library`, an `Arc<Catalog>`, the revision counter, the job registry, the choice tokens
  and the latest problems. Opening, creating or rebuilding a library swaps it and emits
  `LibraryStateChanged`.
- A handler validates in order: the request's values (limits, names, tokens), the library, then
  its references inside the catalog transaction of the operation. Writes go through
  `Catalog::write_with`, which also serializes the metadata files (library scan §7.4).
- After a commit, the handler bumps the revision and hands the changes to one emitter task, which
  merges bursts into at most ten `CatalogChanged` per second.
- Jobs run on a blocking thread each, with an `AtomicBool` for cancelling (library scan §8), and
  report progress through the registry, which throttles `JobChanged`.

## 19. Tests

| Where | Tests |
|---|---|
| This lane (Rust) | Bindings drift (`export_bindings`, now over every declared command); `runtime_commands_are_declared_and_granted` (§3); every `AppError` serializes as `{ code, detail }` with a unique code; `LIMITS` matches the core's constants |
| This lane (TypeScript) | Event helpers subscribe and release their listeners and report failures; URL helpers percent-encode every name and keep `/` between them |
| Contract fixes (`feat/ipc-m1-contract-fixes`) | The planned-command test with `resolve_paths` and `log_ui_error` declared and not registered; the new codes serialize; `Unavailable` reasons from where opening fails (a damaged `library.json` is `notALibrary`, a file in place of the folder `missing`, catalog failures `catalogFailed` whatever their I/O error); an incomplete `.folio/` is reported, refused by `open_library` and finished in place with its tags kept; a `.folio` file is refused untouched; `fileError` reads the header |
| Each implementation lane | For every command: each validation rule returns its code; a stale reference is `NotFound` and changes nothing; limits are `InvalidArgument`; tokens are single use, expire and keep to their kind; `.folio` cannot be named or created; events carry the right revision and changes |
| End to end | One flow per feature (testing strategy); until a command is implemented, calling it is rejected (`not allowed`) |

## 20. Changes to earlier documents

### 20.1 From this contract

To be made by the lanes that implement them:

1. **Course information** (library core §4.2, ADR-0002 §3): the `course` object gains an optional
   `code`, and `abbr` and `color` become optional (`null` means the default derived from the name),
   so a course can be ordered or archived before anyone types its badge. `abbr` allows 1–3 grapheme
   clusters instead of 1–2 (`meta::Abbr`); the catalog's `courses` table follows. The rules for
   display names, badges and codes become core constants, and `LIMITS` takes them from there
   (`crates/folio-app/src/ipc/types.rs`).
2. **Folder tags apply below them** (§8.2), for filters and "untagged"; ADR-0002 §3 says only that
   a key may name a folder.
3. **Tag filters with several tags match all of them.**
4. **Preset tag colours** use palette keys: `gray` is not in the palette, `stone` is its neutral
   (`meta::PresetTag`).
5. **System overview §4** points here: `fs.changed` is `CatalogChanged`, `job.progress` is
   `JobChanged`.

### 20.2 Contract fixes (2026-09-29)

Lane `feat/ipc-m1-contract-fixes` (roadmap appendix A.4) closed the gaps the M1 design hand-off
and the UI architecture found. It replaced the planned `feat/ipc-m1-resolve-paths` (ADR-0005
action item 4). Sirui's decisions (2026-09-29): an incomplete `.folio/` is finished in place;
the scheme never downloads files that are not on this disk; items 7 and 8 below are implemented
here, not only declared.

| # | Change | Where | Implemented by |
|---|---|---|---|
| 1 | `resolve_paths` and the `resolvePaths` and `relativePathChars` limits | §4.1, §9.1 | `feat/data-browse-queries` |
| 2 | `log_ui_error` and the `logChars` limit, in a new `log` command group | §4.1, §16.4 | `chore/core-logging` |
| 3 | `ImportSource.names` is `ImportName[]` (`{ name, kind }`) | §12 | `feat/core-import` |
| 4 | `NotRecyclable` for what the Recycle Bin cannot take, in place of `FileSystem` | §9.2, §12, §16 | `feat/core-library-ops`, `feat/core-import` |
| 5 | `folio-file` failures name their code in `X-Folio-Error` (`FILE_ERROR_HEADER`, `FILE_ERROR_CODES`); new codes `NotLocal` and `NoThumbnail`; the scheme never downloads | §11.2, §16 | `feat/core-file-scheme` |
| 6 | `library_status` retries an unavailable library | §6 | `feat/core-library-ops` |
| 7 | `FolderContent` `incomplete`; `create_library` finishes it in place (`folio_core::library::state::create`) | §6 | this lane |
| 8 | `Unavailable` reasons decided where opening fails (`library/errors.rs` `Failure`), with what each covers | §6 | this lane |

Generated bindings changed for 1, 2, 3, 4, 5 and 7, and in doc comments for 8; the wrappers in
`apps/desktop/src/ipc/` gained `fileError` for 5. `errors.json` has the three new codes' messages.
Other documents: first-run handoff §4.2, §7 and §12; library-actions handoff §4, §7.4, §9.2 and
§16; UI architecture §10.4, §13 and §18; Windows adapter §4; ADR-0005 action item 4.

## 21. Next lanes

1. **Done (2026-09-28).** **Library state and jobs** (`feat/core-library-state`): the settings
   file, `LibraryState`, the job registry and events, `library_status`, `pick_library_folder`,
   `create_library`, `open_library`, the start-up scan and hashing, `list_jobs`, `cancel_job`,
   `rebuild_catalog`, `list_problems` ([library-state.md](library-state.md)).
2. **Browse and search** (`feat/data-browse-queries`): the core queries for §9.1 and §10 (natural
   name order, effective tags, filters, scopes, the fixed search window) and their commands,
   and `resolve_paths`.
3. **Library operations** (`feat/core-library-ops`): §7, §8 and §9.2 with the metadata changes of
   §20.1, the Recycle Bin adapter with `NotRecyclable`, `CatalogChanged`, and the `library_status`
   retry (§6).
4. **Import** (`feat/core-import`): dialogs, drops, `check_import` with `ImportName`, the import
   job.
5. **Preview** (`feat/core-file-scheme`): the `folio-file` scheme with its failure codes (§11.2),
   thumbnails, `open_entry`, `reveal_entry`, the CSP sources.
6. **Windows adapter**: the watcher's scoped scans feed `CatalogChanged` (library scan §12).
7. **Contract fixes** (`feat/ipc-m1-contract-fixes`, 2026-09-29): §20.2.
8. **Logging** (`chore/core-logging`): the logging module and `log_ui_error` (§16.4).
