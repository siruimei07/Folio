# IPC contract for M2

System design for the interface between the M2 UI and the shell: the commands, typed events and
error codes for the workspace, commits, history, diffs, restore and AI commit messages (brief §11,
M2). It extends [ipc-m1](ipc-m1.md) under the decisions of
[ADR-0004](../adr/ADR-0004-ipc-contract.md); the data behind it is
[versioning.md](versioning.md), whose §17 outlined this contract.

- Status: written 2026-10-04 in lane `feat/ipc-m2-contract`. The types live in
  `crates/folio-app/src/ipc/` (`workspace.rs`, `history.rs`, `diff.rs`, `ai.rs`); every command of
  this spec is declared and none has behaviour yet (§3); the fake shell answers all of them (§17). The implementation lanes of §20 change this line
  as they land.
- Inputs: [brief](../product/brief.md) §4, §5.4–§5.7; [versioning.md](versioning.md) (all of it,
  §15 and §17 above all); [remote-format.md](remote-format.md) §4, §6, §7.3, §7.5, §8;
  [ADR-0006](../adr/ADR-0006-history-retention.md); [workspace-history
  handoff](../design/handoff/workspace-history.md) §15 and §18;
  [UI architecture](ui-architecture.md) §11.
- Product decisions this contract follows:
  1. **"Not synced" in M2** (Sirui, 2026-10-04, decision `not-synced-list`; design decision 31A):
     the card lists the newest three commits, read from `list_history` (§8.1); versioning.md
     §9.1 now says so.
  2. **A key for another AI service needs the user's confirmation** (Sirui, 2026-10-04, asked in
     this lane): storing a key while the endpoint is not DeepSeek's opens a Windows confirmation
     that only the user can answer (§12.3). A script in a compromised UI can change the endpoint,
     but cannot then make Folio send changed text there.
  3. The decisions of versioning.md (retention, size limits, versioned files, tag and settings
     changes always committed, uncommit of the newest commit only, the automatic first commit,
     what AI may send) and of the handoff (§1, decisions 30–37).

## 1. Scope

| In this contract | In later contracts |
|---|---|
| Workspace: summary, items, tag and settings changes, selection summaries, `WorkspaceChanged` | Sync, the remote's state, "Sync now", conflicts (M3) |
| Commits as jobs, the first commit (`start_history`), message rules | Thinning as its own action (M3 runs it inside commit jobs, versioning §5.4) |
| History: timeline, commit details, one file's history, reword, uncommit, finding a version's file now | "Check history" (a full check of every pack) |
| Diffs of text, Word text and metadata, in folded pages | Restoring several files or a folder |
| Restore one version: plan, then restore | Discarding uncommitted changes (not in the brief) |
| The `folio-file` version route | Office previews (M4) |
| AI settings with a write-only key, a test, generating a message and stopping it | Other AI features |
| The `commit` and `firstCommit` job kinds; byte progress and the failed file for every job | |

## 2. Requirements

| Need (versioning, handoff) | Commands and events |
|---|---|
| The Changes badge, header count, commit button and states (handoff §2.1, §3.1, §3.8, §4.2) | `get_workspace`, `WorkspaceChanged` |
| The changes list, 50,000 rows, bound items, readiness (versioning §6.2–§6.3; handoff §3) | `list_workspace_items` |
| Tag and settings changes without check boxes (versioning §6.4; handoff §3.3) | `list_metadata_changes` |
| The template, the commit button's count, grouped mode's course headers (versioning §6.6, §8.1; handoff §3.5, §4.6) | `summarize_selection` |
| Commit with a selection, never one the user did not see (versioning §7) | `commit`, `JobChanged` (kind `commit`) |
| The first commit by itself (versioning §7.7; handoff §10) | `start_history`, `JobChanged` (kind `firstCommit`) |
| The timeline with commits and operations, day headers, "Not synced" (versioning §9.1; handoff §5, §7) | `list_history`, `HistoryChanged` |
| File cards and commit details (versioning §9.2) | `get_commit`, `list_commit_changes`, `list_commit_metadata` |
| One file's history and "Current version" (versioning §9.3; handoff §7.4) | `list_file_history` |
| Open, show or preview "the current file" of a version (handoff §6.8, §7.3) | `locate_version` |
| Edit message, undo commit (versioning §8.3–§8.4; handoff §9) | `reword_commit`, `uncommit` |
| Diffs in every state of handoff §6.8 (versioning §10) | `get_workspace_diff`, `get_version_diff` |
| The restore dialog says what will happen before it happens (handoff §8.2, open item 3) | `plan_restore` |
| Restore a version as a new change (versioning §11) | `restore_version` |
| "This version" in History (versioning §9.4; handoff §6.7) | `folio-file` version route (§11) |
| The AI page: on or off, endpoint, model, what is sent, the key (versioning §12.1) | `get_ai_settings`, `update_ai_settings`, `set_ai_key`, `clear_ai_key`, `test_ai`, `AiSettingsChanged` |
| Generate, Stop, Esc and "Use template" (versioning §8.2; handoff §4.2, open item 5) | `generate_commit_message`, `cancel_ai_request` |
| "12.4 of 48.0 MB" and the file a commit failed on (handoff §4.4, §4.5, open item 6) | `Progress.bytes`, `JobStatus` `failed` `file` (§13) |

Non-functional (versioning §2):

- **Latency.** `get_workspace` and a first page of 200 items within 100 ms with a few changes and
  500 ms when everything changed; a history page within 50 ms; a diff of a 1 MiB text file within
  300 ms. Commands are async and call the core through `spawn_blocking`, as in M1.
- **Scale.** 50,000 files and 1,000 commits: every list is paged (ipc-m1 §5.3); a selection names
  at most `batch` keys (§5.1), and "everything except" needs no page loaded.
- **Security.** The UI stays untrusted (ipc-m1 §2). It names items by the opaque keys the shell
  gave it, commits by their ids, versions by commit and path; it never sends text to the AI
  service except the description, and never reads the key (§16).
- **No silent failures.** Every command resolves to data or an `AppError`; a job that fails names
  its error and, when one file caused it, that file (§13).
- **Language.** The shell sends no UI text. Messages are user data; the template and "Start
  history" come from the UI's strings (versioning §7.7, §8.1). One exception: the confirmation of
  decision 2 is a Windows dialog the shell opens itself, like the folder picker (§12.3).

## 3. Placeholders

ipc-m1 §3 applies unchanged: every command below is declared now with its final signature in a
test-only stub of its group's `crates/folio-app/src/commands/<group>.rs`, exported to the
bindings, and neither registered, listed in `commands/<group>/manifest.rs` nor granted until its
lane implements it. The three new groups have empty manifests and no capability file yet; the
first lane that implements a command of a group adds `capabilities/<group>.json`.

| Group | Commands | Implemented by (§20) |
|---|---|---|
| `workspace` | `get_workspace`, `list_workspace_items`, `list_metadata_changes`, `summarize_selection` | `feat/core-workspace` |
| `workspace` | `commit`, `start_history` | `feat/core-commit-history` |
| `workspace` | `get_workspace_diff` | `feat/core-diff-restore` |
| `history` | `list_history`, `get_commit`, `list_commit_changes`, `list_commit_metadata`, `list_file_history`, `locate_version`, `reword_commit`, `uncommit` | `feat/core-commit-history` |
| `history` | `get_version_diff`, `plan_restore`, `restore_version` | `feat/core-diff-restore` |
| `ai` | `get_ai_settings`, `update_ai_settings`, `set_ai_key`, `clear_ai_key`, `test_ai`, `generate_commit_message`, `cancel_ai_request` | `feat/core-ai-message` |

The events `WorkspaceChanged`, `HistoryChanged` and `AiSettingsChanged` are registered in both
builders now, as every event is (ipc-m1 §3): they carry no privilege, and nothing emits them until
their lanes do.

## 4. Conventions

ipc-m1 §4 applies: one `request` object, camelCase fields that are always present, `null` for a
missing value, string unions and `kind`-tagged objects, 64-bit values as decimal strings,
library-relative paths, sorted lists. Added here:

| Topic | Rule |
|---|---|
| Object ids | Commit ids and content hashes in their text form: `b3:` and 64 lowercase hexadecimal digits (remote-format.md §4). The short id the UI shows is the first 7 hexadecimal digits (`shortId` in `apps/desktop/src/ipc`) |
| Times | Milliseconds since the Unix epoch, as decimal strings, in fields ending in `Ms`. Commit times are whole seconds (remote-format.md §6.2) |
| Effective time | `effectiveMs` orders the timeline and places its day headers (handoff §7.2). A commit's is versioning §5.4's: the later of its own time and its parent's effective time. An operation's is the later of its own time and the previous operation's effective time in the log, so the log's order holds too; the timeline merges both newest first, an operation before a commit at equal times (an operation names an earlier commit) |
| Keys | A workspace item, a metadata change and a commit's change row each have a `key`: opaque text the UI keeps and sends back as given, at most `keyChars` characters. It names the change while the change exists (versioning §6.3); the text is not part of the contract |
| Fingerprints | 32 lowercase hexadecimal digits (128 bits, versioning §6.5); 32 zeros for an empty workspace |
| Request ids | Chosen by the UI for an AI request it may stop: 1–`requestIdChars` ASCII letters, digits, `-` and `_` (`crypto.randomUUID()` qualifies) |

### 4.1 Limits

`LIMITS` gains these keys; the shell enforces the same values.

| Key | Value | Limits |
|---|---|---|
| `summaryChars` | 256 | A commit summary, in characters (remote-format.md §6.7) |
| `bodyChars` | 16,384 | A commit body, in characters |
| `descriptionChars` | 2,000 | The description `generate_commit_message` sends (versioning §12.3) |
| `aiKeyChars` | 512 | An AI key, in characters |
| `endpointChars` | 2,048 | An AI endpoint, in characters |
| `modelChars` | 128 | An AI model name, in characters |
| `requestIdChars` | 64 | An AI request id |
| `keyChars` | 32,800 | A workspace or change key, in characters |
| `diffRows` | 500 | Rows in one diff window (§9.2) |

A selection names at most `batch` (10,000) keys.

## 5. Shared types

### 5.1 Selections

```ts
type Selection =
  | { kind: "allExcept"; keys: string[] }   // every includable item but these (select-all, Ctrl+A)
  | { kind: "only"; keys: string[] };       // these items only
```

- **Includable** items are those whose readiness is `ready` or `hashing` (versioning §6.2). An
  `allExcept` selection never includes an item that is `notLocal` or `unreadable`; an `only`
  selection that names one fails the commit with that item's error (versioning §7.3).
- Metadata changes are never in a selection: every commit records them (versioning §6.4).
- Commands that take a selection also take the `fingerprint` the UI read with it. A different
  fingerprint is `WorkspaceChanged`, checked first; with an equal one, a key the workspace does
  not have is `InvalidArgument`, because the UI can only have made it up. Keys over `batch` or
  `keyChars` are `InvalidArgument` before anything is read.
- **The fingerprint also covers readiness**: each item counts with its key and whether it is
  includable (a refinement of versioning §6.5). A file that finishes downloading, or one that
  another program locks, changes the fingerprint, so an `allExcept` selection never includes an
  item the user saw as blocked, and never leaves out silently one the user saw as included.
  `hashing` and `ready` count the same, so hashing does not change it.

### 5.2 Changes and sides

```ts
type ChangeKind = "added" | "deleted" | "modified" | "moved";   // "moved": the Renamed status
type CommitKind = "commit" | "import" | "prune";               // remote-format.md §7.3
type VersionSide = {                // one version of a file in history
  hash: string;                     // content hash (remote-format.md §4)
  size: string;                     // bytes
  stored: boolean;                  // the commit stored this version (versioning §5.1)
  pruned: boolean;                  // stored, then thinned out (remote-format.md §7.5): no diff, no restore
};
```

A version can be shown, compared and restored when it is `stored` and not `pruned`.

## 6. Workspace

### 6.1 Commands

| Command | Request → response | Errors |
|---|---|---|
| `get_workspace` | — → `WorkspaceSummary` | `NoLibrary` |
| `list_workspace_items` | `{ page }` → `Page<WorkspaceItem>` | `NoLibrary`, `InvalidArgument` |
| `list_metadata_changes` | `{ page }` → `Page<MetadataChange>` | `NoLibrary`, `InvalidArgument` |
| `summarize_selection` | `{ selection: Selection; fingerprint }` → `SelectionSummary` | `WorkspaceChanged`, `InvalidArgument`, `NoLibrary` |

```ts
type HistoryState = "none" | "starting" | "ready" | "readOnly" | "damaged";
type WorkspaceSummary = {
  revision: number;            // the catalog revision (ipc-m1 §15.2)
  historyState: HistoryState;
  head: string | null;         // HEAD's commit id; null before the first commit
  fingerprint: string;
  items: number;               // rows of list_workspace_items; a bound item counts once
  metadata: number;            // rows of list_metadata_changes
  includable: number;          // items that are ready or hashing
  hashing: number;
  notLocal: number;
  unreadable: number;
};
```

- **`historyState`** (versioning §4.2, §7.7): `none` before the first commit, while the library
  waits for its first full scan and hashing; `starting` while the `firstCommit` job runs;
  `ready`; `readOnly` when a newer Folio wrote the history (commit, reword, uncommit and restore
  fail with `HistoryReadOnly`); `damaged` when `HEAD` cannot be read or names a missing commit
  (they fail with `HistoryDamaged`). A failed or cancelled first commit returns to `none`.
- While the state is `none` or `starting`, the workspace lists nothing and its totals are 0
  (versioning §6.5; the UI never shows the whole library as added, handoff §10). With `damaged`
  it lists what it can, which is nothing when `HEAD` cannot be read.
- The badge and the header count are `items + metadata`. Counts per kind come from
  `summarize_selection`.

### 6.2 Items

```ts
type WorkspaceItem = {
  key: string;
  change: ChangeKind;           // the main change; a bound item's other changes are in `parts`
  kind: EntryKind;              // "file" | "folder"
  path: string;                 // the new path; the old one for a deletion
  fromPath: string | null;      // a move: where it was
  entry: EntryRef | null;       // the catalog entry (open, reveal, history); null for a deletion
  class: FileClass;             // "other" for folders
  contentChanged: boolean;      // a moved file that was also edited; true for "modified"
  before: ItemSide | null;      // as HEAD has it; null when added, and for folders
  after: ItemSide | null;       // as the disk has it; null when deleted, and for folders
  readiness: Readiness;
  files: number;                // folder items: the files they cover; 0 for an empty folder and for files
  parts: ItemPart[];            // a bound item's other changes (versioning §6.3); [] otherwise
  required: boolean;            // bound to a metadata change, which every commit records: always included
  tagsChanged: boolean;         // the entry's tags changed too (handoff §3.3)
};
type ItemSide = {
  size: string;                 // bytes; on the disk side "0" while the file is not local
  stored: boolean;              // HEAD stored it; on the disk side, whether a commit would store it now
};
type Readiness = "ready" | "hashing" | "notLocal" | "unreadable";
type ItemPart =
  | { kind: "entry"; change: ChangeKind; entryKind: EntryKind; path: string; fromPath: string | null }
  | { kind: "versioningRules" };   // the change of the versioning rules this file's change is bound to
```

- Items are sorted like the `path` sort key (ipc-m1 §5.3), by `path`. Their kinds follow
  versioning §6.3: a file added, deleted, modified or moved; a folder moved or deleted, covering
  what went with it (`files`); an empty folder added.
- `before.stored` and `after.stored` tell the diff view what it can show before it asks.
- A bound item is one row; "2 changes" is `1 + parts.length`. A part `versioningRules` means the
  rules changed so that this file is stored now, while its own change was held back: such an item
  is `required`, so every selection includes it, an `allExcept` that lists it included (handoff
  open question for `feat/ui-changes-view`: a check box that stays on).
- `tagsChanged`: the entry also has a tag change, which the item's diff shows under its content
  (§9.3, `Diff.tags`) and which is not a row of `list_metadata_changes`.

### 6.3 Tag and settings changes

```ts
type MetadataChange = {
  key: string;
  change: ChangeKind;           // added, modified or deleted; never moved
  subject: MetadataSubject;
};
type MetadataSubject =
  | { kind: "tags"; path: string; entryKind: EntryKind; entry: EntryRef | null }   // a file's or folder's own tags
  | { kind: "semester"; path: string; folder: EntryRef | null }                   // its settings
  | { kind: "course"; path: string; folder: EntryRef | null }
  | { kind: "tagDefinitions" }                                                    // tags.json
  | { kind: "library" }                                                           // library.json: name, versioning rules
  | { kind: "ignoreRules" };                                                      // .folio/ignore
```

- The rows are the metadata changes of versioning §6.4 that are not part of an item: tags of
  entries without an item, then semester and course settings, each by path, then tag
  definitions, library settings and ignore rules. A semester or course whose folder has no
  catalog entry any more has `folder: null`.
- `change` for tags and settings is `added` when nothing was committed before (a first tag, a
  course configured for the first time), `deleted` when nothing is left, else `modified`; for tag
  definitions, `added` when tags were only added, `deleted` when they were only deleted.
- The same type names a commit's metadata changes (`list_commit_metadata`, §8.2), with `entry`
  and `folder` always `null`: history names paths as they were.

### 6.4 Selection summaries

```ts
type SelectionSummary = {
  items: number;                 // included items: the commit button counts items + metadata
  metadata: number;              // metadata changes, always included
  groups: SummaryGroup[];        // every place with a change, in path order, the library root first
  tagDefinitions: boolean;       // library-wide metadata changes, for "Update tags" …
  library: boolean;
  ignoreRules: boolean;
};
type SummaryGroup = {
  place: Place;
  files: ChangeCounts;           // included file items, by change
  folders: ChangeCounts;         // included folder items, by change
  tags: number;                  // entries in it whose tags changed (always included)
  settings: boolean;             // its own settings changed (a semester's or a course's)
  available: number;             // its includable items, included or not
  selected: number;              // its included items
};
type Place =
  | { kind: "library" }                                              // files at the library root
  | { kind: "semester"; path: string; folder: EntryRef | null; name: string }
  | { kind: "course"; path: string; folder: EntryRef | null; name: string; code: string | null };
type ChangeCounts = { added: number; modified: number; deleted: number; moved: number };
```

- An item belongs to the place of its main path: its course, else its semester (files directly
  in it or in folders that are not courses), else the library root (versioning §6.6). A course or
  semester that was deleted keeps its committed name, with `folder: null`.
- The UI writes the template from it (versioning §8.1, handoff §4.6); grouped mode's course
  header shows on, mixed or off from `selected` and `available` (handoff §3.5).
- It is computed in the core, so the UI never loads every item; the UI asks again when the
  selection changes, after a short pause.

## 7. Commits

### 7.1 Commands

| Command | Request → response | Errors |
|---|---|---|
| `commit` | `CommitChanges` → job id (kind `commit`) | `WorkspaceChanged`, `NothingToCommit`, message codes (§7.2), `ReadOnly`, `HistoryReadOnly`, `HistoryDamaged`, `HistoryBusy`, `Busy`, `InvalidArgument`, `NoLibrary` |
| `start_history` | `{ summary }` → job id (kind `firstCommit`) | `HistoryExists`, message codes, `ReadOnly`, `HistoryReadOnly`, `HistoryDamaged`, `HistoryBusy`, `Busy`, `NoLibrary` |

```ts
type CommitChanges = {
  selection: Selection;
  fingerprint: string;
  base: string | null;         // WorkspaceSummary.head when the UI read the workspace
  summary: string;             // what the user typed, the AI's, or the template: never empty
  body: string | null;
};
```

- **Before the job.** The command checks the request, then the fingerprint and the base
  (versioning §7.1: a different one is `WorkspaceChanged`), resolves the selection to its items,
  and answers with the job id; nothing is read or written yet. A selection that is empty with no
  metadata change is `NothingToCommit`, which is also the answer while the history is `none` or
  `starting` (the workspace lists nothing). The job then commits exactly the items it resolved,
  as the files are when it reads them (versioning §7.3).
- **The job** (versioning §7.5) reads the files, then switches `HEAD`. It fails with
  `FileChanged`, `NotLocal`, `InUse`, `AccessDenied`, `DiskFull`, `FileSystem` or
  `HistoryDamaged`, and names the file (§13). It is cancellable until the switch begins: then
  `cancellable` turns `false`, and a later `cancel_job` is `InvalidArgument`. A cancelled commit
  has written nothing.
- **Done:** `HistoryChanged`, then `WorkspaceChanged` without the committed items; the result
  names the commit (§13).
- **`start_history`** (versioning §7.7) commits every ready item and the metadata, leaving out
  what is not local or unreadable. The UI calls it with "Start history" from its strings once
  the first full scan and hashing have finished (handoff §10); before that it waits, and so does
  the shell: a call while the scan or hashing runs queues the job until they finish.
  `HistoryExists` once `HEAD` exists, so calling twice is safe. A failure or a cancel leaves no
  history.
- At most one commit, reword, uncommit or restore runs at a time: a second one is `HistoryBusy`,
  without queueing (versioning §7.5). A catalog rebuild and these exclude each other: `Busy` when
  the rebuild came first, `HistoryBusy` when the history operation did.

### 7.2 Messages

The shell normalizes, then checks, every summary and body it is sent (`commit`, `start_history`,
`reword_commit`), against remote-format.md §6.7:

1. Summary: white space at both ends is removed. Body: CR LF and CR become LF, then white space at
   the end and line feeds at the start are removed; an empty body becomes `null`.
2. Then, in this order: `SummaryEmpty` (nothing left), `SummaryTooLong` (over `summaryChars`),
   `SummaryInvalid` (a control character, which includes line breaks), `BodyTooLong` (over
   `bodyChars`), `BodyInvalid` (a control character other than tab and line feed).

Text is not normalized to NFC: a message is stored as typed. Lengths are counted in characters
(Unicode scalar values) before anything else is done with the text.

## 8. History

### 8.1 Timeline

| Command | Request → response | Errors |
|---|---|---|
| `list_history` | `{ page; types: HistoryType[] \| null }` → `Page<HistoryItem>` | `NoLibrary`, `InvalidArgument`, `HistoryDamaged` |
| `get_commit` | `{ commit }` → `CommitInfo` | `NotFound`, `NoLibrary`, `HistoryDamaged` |

```ts
type HistoryType = "commit" | "reword" | "uncommit" | "restore";   // null: every type
type HistoryItem =
  | { kind: "commit"; commit: CommitInfo; files: ChangeRow[] }       // files: the first four (§8.2)
  | ({ kind: "reword" } & RewordEntry)
  | ({ kind: "uncommit" } & UncommitEntry)
  | ({ kind: "restore" } & RestoreEntry);
type CommitInfo = {
  id: string;
  parent: string | null;        // null for the first commit
  kind: CommitKind;
  first: boolean;               // the library's first commit ("Start history"): cannot be undone
  head: boolean;                // the newest commit: the only one uncommit takes
  synced: boolean;              // after the remote's canonical head; false for every commit in M2
  timeMs: string;               // its own time, as its device's clock said
  effectiveMs: string;          // §4
  summary: string | null;       // null for a prune commit
  body: string | null;
  device: { id: string; name: string };   // imports show "iCloud" (the UI words it from `kind`)
  files: number;                // changed files, `.folio/` left out; the first commit's: the files the library held
  folders: number;              // changed folders; files + folders are the rows of list_commit_changes
  metadata: number;             // its tag and settings changes (list_commit_metadata)
  pruned: number;               // a prune commit: the versions it thinned out
};
type RewordEntry = {
  id: string;                   // the operation's id (16 hexadecimal digits, versioning §4.4)
  timeMs: string; effectiveMs: string;
  commit: string;               // the reworded commit's id now: its new id, or a later one when it was reworded again
  previous: string;             // its id before this reword
};
type UncommitEntry = {
  id: string; timeMs: string; effectiveMs: string;
  commit: string;               // the commit taken back
  summary: string;              // its summary ("Undid commit “…”")
};
type RestoreEntry = {
  id: string; timeMs: string; effectiveMs: string;
  commit: string;               // the version's commit, as its id is now
  path: string;                 // the version's path in that commit
  versionMs: string;            // that commit's time ("the version from Oct 10")
  target: string;               // the library path written
  recycled: boolean;            // the file there went to the Recycle Bin first
};
```

- Order and ids follow versioning §9.1: newest first by `effectiveMs`; an operation that names a
  commit a later reword rewrote names the commit it became. `types` filters (handoff §7.1):
  `commit` covers every commit kind; M3 adds sync types.
- **"Not synced" in M2** (decision 1): the card asks `list_history` with `types: ["commit"]` and
  `page: { offset: 0, limit: 3 }`, and shows `total` as its count. Every commit is unsynced until
  a remote exists, so in M3 the card filters on `synced` (or a sync-state command replaces this).
- The actions the UI offers follow from the fields (versioning §8.3–§8.4; handoff §7.3): reword
  for kinds `commit` and `import` that are not `synced`; uncommit for the `head` of kind `commit`
  or `import` that is not `first` and not `synced`. The shell checks the same rules.
- `files` holds up to four rows, for the file card; the first commit's card is not shown
  (handoff §7.2), but its rows are there.

### 8.2 Commit details

| Command | Request → response | Errors |
|---|---|---|
| `list_commit_changes` | `{ commit; page }` → `Page<ChangeRow>` | `NotFound`, `InvalidArgument`, `NoLibrary`, `HistoryDamaged` |
| `list_commit_metadata` | `{ commit; page }` → `Page<MetadataChange>` | `NotFound`, `InvalidArgument`, `NoLibrary`, `HistoryDamaged` |

```ts
type ChangeRow = {
  key: string;                  // names this change in get_version_diff
  change: ChangeKind;
  kind: EntryKind;
  path: string;                 // the path in this commit; the old one for a deletion
  fromPath: string | null;      // a move: the path in the parent
  class: FileClass;
  before: VersionSide | null;   // the parent's version; null when added, and for folders
  after: VersionSide | null;    // this commit's version; null when deleted, and for folders
};
```

- From `commit_changes` (versioning §9.2): the change records, or the differences of the trees
  for a commit without them, by path. A folder move is one row; files that moved with it
  unchanged have none (remote-format.md §8 rule 3). `.folio/` paths are never rows: their
  changes are `list_commit_metadata`'s rows, read as data like the workspace's (§6.3).
- `commit` must be a commit of `HEAD`'s chain: any other id, a reworded one included, is
  `NotFound`, as is a well-formed id the store does not have.

### 8.3 One file's history

| Command | Request → response | Errors |
|---|---|---|
| `list_file_history` | `{ file: FileRef; page; types: HistoryType[] \| null }` → `Page<FileVersion>` | `NotFound`, `InvalidArgument`, `NoLibrary`, `HistoryDamaged` |
| `locate_version` | `VersionRef` → `EntryRow \| null` | `NotFound`, `InvalidArgument`, `NoLibrary`, `HistoryDamaged` |

```ts
type FileRef =
  | { kind: "entry"; entry: EntryRef }                    // a file in the Library or the Changes list
  | { kind: "version"; commit: string; path: string };    // a row of a commit in History
type VersionRef = { commit: string; path: string };
type FileVersion =
  | { kind: "commit"; commit: CommitInfo; change: ChangeRow; others: number; current: boolean }
  | ({ kind: "restore" } & RestoreEntry);
```

- The file's line (versioning §5.4, §9.3) is followed backwards through moves to where it was
  added, or to the first commit; from an `entry`, it starts at the `HEAD` row the entry is paired
  with (versioning §6.1), from a `version` at that row. A file no commit holds yet has an empty
  history (handoff §7.4: "has no history yet"). Newest first, like `list_history`; `types`
  filters the same way, and restores of this file's versions are listed.
- `change` is the file's own row, with the path it had then; `others` counts the commit's other
  changed files ("and 2 other files in this commit").
- `current`: the newest commit entry whose version has the content the file has on the disk now
  ("Current version"; Restore disabled, handoff §7.4). None is current when the file has
  uncommitted changes, is not hashed yet, or is gone.
- **`locate_version`** finds the file a version belongs to now: the line followed forward from
  that commit to `HEAD`, then to the disk through the pairing (versioning §11.2). `null` when the
  line ends in a deletion, or its last committed path holds no catalogued file. History's "Open
  with default app", "Show in File Explorer" and the current preview of an event-only file use
  it (handoff §6.8, §7.3). It only reads.

### 8.4 Reword and uncommit

| Command | Request → response | Errors |
|---|---|---|
| `reword_commit` | `{ commit; summary; body }` → `string` (the new id) | `NotFound`, `CannotReword`, message codes (§7.2), `HistoryReadOnly`, `HistoryDamaged`, `HistoryBusy`, `Busy`, `DiskFull`, `FileSystem`, `NoLibrary` |
| `uncommit` | `{ commit }` → `null` | `NotFound`, `NotHead`, `CannotUncommit`, `HistoryReadOnly`, `HistoryDamaged`, `HistoryBusy`, `Busy`, `DiskFull`, `FileSystem`, `NoLibrary` |

- `reword_commit` (versioning §8.3) writes the commit again with the new message and every later
  commit on top of it; the answer is the commit's new id, for "b7c1e20 is now …" (handoff §9.1).
  A message equal to the stored one changes nothing and answers the same id. `CannotReword`: a
  prune commit, and in M3 a synced one.
- `uncommit` (versioning §8.4): `NotHead` when `commit` is not `HEAD` (something changed: the UI
  refreshes, handoff §9.2); `CannotUncommit` for the first commit, a prune commit, and in M3 a
  synced one. The files do not change; the commit's changes return to the workspace.
- Both run under the history journal and are fast (commits only): they answer when done, with
  `HistoryChanged` and `WorkspaceChanged` after.

## 9. Diffs

### 9.1 Commands

| Command | Request → response | Errors |
|---|---|---|
| `get_workspace_diff` | `{ key; window: DiffWindow }` → `Diff` | `NotFound` (no such item or metadata change now), `InvalidArgument`, `NoLibrary`, `HistoryDamaged`, `Internal` |
| `get_version_diff` | `{ commit; key; window: DiffWindow }` → `Diff` | `NotFound` (the commit or the change row), `InvalidArgument`, `NoLibrary`, `HistoryDamaged`, `Internal` |

- `get_workspace_diff` takes a key of `list_workspace_items` or `list_metadata_changes`;
  "before" is `HEAD`'s version and "after" the disk. `get_version_diff` takes a key of
  `list_commit_changes`, `list_commit_metadata` or a `FileVersion`'s `change`; "before" is the
  parent's version and "after" the commit's (versioning §10.1).
- Every call answers the whole header and one window of rows, so the UI can page and unfold
  without a second command. The shell may keep recent diffs to answer later windows quickly; the
  answer is always the diff of the content as it is at the call.
- Conditions that only stop the comparison are content kinds, not errors: a file that is not
  local, cannot be read, is binary or too large shows its state (handoff §6.8) without failing
  the call.

### 9.2 The diff

```ts
type DiffWindow =
  | { kind: "rows"; offset: number; limit: number }          // rows of the folded diff; limit 0..=diffRows
  | { kind: "unchanged"; line: number; count: number };      // to unfold: count (1..=diffRows) unchanged lines
                                                            // from line `line` of the after side
type Diff = {
  revision: number;             // the catalog revision it was read at
  before: DiffSide | null;      // null: nothing before (added, or a file's first version)
  after: DiffSide | null;       // null: deleted
  content: DiffContent;
  tags: TagChange | null;       // the entry's tag change, when its tags changed too (handoff §6.8)
};
type DiffSide = {
  commit: string | null;        // the commit of this version; null: the file on the disk
  timeMs: string | null;        // that commit's time ("Compared with the last commit (Oct 13, 9:30 PM)")
  path: string;
  size: string;
  hash: string | null;          // content hash; null on the disk side until it is hashed
  stored: boolean;              // on the disk side: whether a commit would store it now
  pruned: boolean;
};
type DiffContent =
  | { kind: "text"; text: TextDiff }
  | { kind: "word"; text: TextDiff }             // paragraphs of the document's text (versioning §10.3)
  | { kind: "metadata"; detail: MetadataDetail } // a metadata change's row
  | { kind: "same" }                             // the content did not change: a move without edits
  | { kind: "folder" }                           // a folder item: nothing to compare
  | { kind: "notStored" }                        // a side is not kept: an event-only file, or text over text_max_size
  | { kind: "pruned" }                           // a side was thinned out (M3)
  | { kind: "notLocal" }                         // the disk side is a cloud placeholder: never downloaded
  | { kind: "unreadable"; error: AppError }      // InUse, AccessDenied, FileSystem
  | { kind: "binary" }                           // a text file with binary content (versioning §10.2)
  | { kind: "tooLarge"; lines: number | null };  // over the limits; lines changed when known
```

- The content kind follows versioning §10.1. An added or deleted text or Word file is a `text`
  or `word` diff whose rows are all added or all removed; the Changes view shows a deletion with
  its own block instead (handoff §6.8), but the rows are there.
- The ignore rules' row is a `text` diff; the other metadata rows are `metadata` (§9.4). A
  metadata row's diff has no sides: `before` and `after` are `null`.

### 9.3 Rows

```ts
type TextDiff = {
  added: number;                // lines added (paragraphs for Word)
  removed: number;
  changes: number;              // runs of consecutive added and removed rows: "Change 2 of 5"
  rows: number;                 // rows of the folded diff, for paging
  approximate: boolean;         // past the one-second deadline: whole lines only, no marks
  lineEndings: LineEndingChange | null;   // the line endings changed
  encoding: EncodingChange | null;        // the encoding changed (the text may be the same)
  window: DiffRow[];            // the rows the window asked for
};
type DiffRow =
  | { kind: "context"; old: number; new: number; text: string }
  | { kind: "removed"; old: number; text: string; marks: TextRange[]; change: number }
  | { kind: "added"; new: number; text: string; marks: TextRange[]; change: number }
  | { kind: "fold"; old: number; new: number; lines: number };   // `lines` unchanged lines from these numbers, hidden
type TextRange = { start: number; end: number };   // UTF-16 code units of `text`, end exclusive
type LineEnding = "lf" | "crlf" | "cr" | "mixed";
type LineEndingChange = { before: LineEnding; after: LineEnding };
type TextEncoding = "utf8" | "utf8Bom" | "utf16Le" | "utf16Be" | "gb18030";
type EncodingChange = { before: TextEncoding; after: TextEncoding };
```

- **The folded diff** is what the view shows before anything is unfolded: each change with up to
  3 rows of context on each side (versioning §10.2), runs that touch merged, and a `fold` row for
  every run of hidden unchanged lines, before the first change and after the last included.
  Line and paragraph numbers count from 1; `change` counts from 0, in order.
- **Paging**: `{ kind: "rows", offset, limit }` returns rows `offset` to `offset + limit` of the
  folded diff (fewer at the end; `limit: 0` returns only the header). The UI loads pages as the
  region scrolls and F7 passes them (handoff §6.5).
- **Unfolding**: `{ kind: "unchanged", line, count }` returns `count` `context` rows from the
  after side's line `line`, which must all be unchanged lines (else `InvalidArgument`): the UI
  sends a fold's `new` and up to `diffRows` of its `lines`, and replaces the fold with them and,
  when lines remain, a smaller fold.
- **Marks** are the changed words of a line (characters for CJK text), trimmed of the spaces
  around them (handoff §6.4); `[]` when `approximate`, and on rows without a counterpart.
- "Only formatting changed" (Word) and "only the line endings changed" are diffs with
  `changes: 0`: the first has no `lineEndings`, the second has one. `encoding` alone means only
  the encoding changed. A move without edits is `same`, not an empty diff.
- Limits (versioning §10.2): each side at most 8 MiB of text and 200,000 lines, else `tooLarge`
  with `lines: null`; one second of diffing, then `approximate`.

### 9.4 Metadata

```ts
type MetadataDetail =
  | ({ kind: "tags" } & TagChange)
  | { kind: "settings"; changes: SettingChange[] }            // a semester's, a course's or the library's
  | { kind: "tagDefinitions"; changes: TagDefinitionChange[] };
type TagChange = { added: TagLabel[]; removed: TagLabel[]; now: TagLabel[] };
type TagLabel = { id: string; name: string | null; color: string | null };   // null: no definition then
type SettingChange =
  | { field: "abbr"; before: string | null; after: string | null }
  | { field: "code"; before: string | null; after: string | null }
  | { field: "color"; before: string | null; after: string | null }
  | { field: "archived"; before: boolean; after: boolean }
  | { field: "order"; before: number | null; after: number | null }
  | { field: "name"; before: string; after: string }                   // the library's name
  | { field: "textMaxSize"; before: string; after: string }            // bytes
  | { field: "textExtensions"; added: string[]; removed: string[] }
  | { field: "wordExtensions"; added: string[]; removed: string[] };
type TagDefinitionChange = { id: string; before: TagDefinition | null; after: TagDefinition | null };
type TagDefinition = { name: string; color: string; order: number };
```

- Tag labels carry the names and colours of the definitions on that side (the commit's or the
  disk's `tags.json`), so a deleted tag is still named; `now` is the "after" side's tags.
- Settings that were never configured read as their defaults: `archived: false`, the others
  `null` (library-core.md §4.2). Fields are listed in the order above, only those that changed.

## 10. Restore

| Command | Request → response | Errors |
|---|---|---|
| `plan_restore` | `VersionRef` → `RestorePlan` | `NotFound`, `NotStored`, `Pruned`, `NotLocal`, `InvalidArgument`, `HistoryReadOnly`, `HistoryDamaged`, `NoLibrary` |
| `restore_version` | `VersionRef` → `Restored` | as `plan_restore`, and `Unchanged`, `FileChanged`, `InUse`, `AccessDenied`, `NotRecyclable`, `DiskFull`, `PathTooLong`, `FileSystem`, `HistoryBusy`, `Busy` |

```ts
type RestoreOutcome = "replace" | "recreate" | "beside" | "unchanged";
type RestorePlan = {
  outcome: RestoreOutcome;
  target: string;               // where the version goes; for "unchanged", the file's path
  recycle: boolean;             // the file there goes to the Recycle Bin first
  current: EntryRow | null;     // the file the version belongs to now (locate_version)
};
type Restored = { target: string; recycled: boolean };
```

- **`plan_restore`** only reads, and answers what `restore_version` would do now (versioning
  §11.2–§11.3; handoff §8.2): `replace` the file at its current path; `recreate` it at its last
  committed path, folders included, when it was deleted; put it `beside` a different file that
  took that name, under the keep-both name (`name (2).ext`, ipc-m1 §12); or `unchanged` when the
  file already has that content. `recycle` is true when the file being replaced has content that
  no version of `HEAD`'s chain keeps (uncommitted changes): the dialog's warning block.
- **`restore_version`** takes the same arguments and plans again: the dialog's answer may be
  seconds old. It writes the version as an uncommitted change under the restore journal
  (versioning §11.4), recycling the current file first when it must, and answers where it went.
  `Unchanged` when there was nothing to do; `FileChanged` when the target changed between its
  check and the rename (nothing replaced); `NotRecyclable` when the Recycle Bin could not take the
  current file (nothing replaced), but `InUse` when another program holds it or its cloud provider
  refuses to move it (versioning §11.3). Then `HistoryChanged` (the `restore` operation) and
  `WorkspaceChanged` (the new change).
- A version that is not `stored` is `NotStored`, a thinned one `Pruned`; a current file that is
  not on this disk is `NotLocal`, never downloaded. `InvalidArgument`: a folder, or a path under
  `.folio/`, which no row the UI got can name.
- Restore is one file and answers when done, without a job: the dialog stays with a pending
  button until then (handoff §8.3). It holds the history lock (`HistoryBusy`).

## 11. The `folio-file` version route

| URL | Serves |
|---|---|
| `http://folio-file.localhost/version/{hash}/{name}` | The bytes of a stored version; `Range` requests get `206` |

- `{hash}` is the 64 hexadecimal digits of a `VersionSide.hash` (without `b3:`); `{name}` is the
  file's name, percent-encoded as UTF-8, which gives the `Content-Type` by its extension and is
  never used to find anything (versioning §9.4).
- The shell serves a blob only when a version of `HEAD`'s chain stores it and the store has it,
  verified against its id; otherwise `404`. Everything else follows ipc-m1 §11.2: `GET` and
  `HEAD` only, the size rules, `X-Content-Type-Options: nosniff`, `Cache-Control: no-store`,
  `Content-Security-Policy: sandbox; default-src 'none'`, the main window's origin only.
- Failures name their code in `X-Folio-Error`. `FILE_ERROR_CODES` gains:

| Code | Status | When |
|---|---|---|
| `NotFound` | `404` | No version of `HEAD`'s chain stores that blob |
| `Pruned` | `404` | The version was thinned out (M3) |
| `HistoryDamaged` | `500` | The store lacks an object it should have, or an object fails its check |
| `InvalidArgument` | `400` | `{hash}` is not 64 hexadecimal digits, or `{name}` is not one valid name |

- `versionUrl(side, name)` in `apps/desktop/src/ipc/files.ts` builds the URL.

## 12. AI

### 12.1 Settings

| Command | Request → response | Errors |
|---|---|---|
| `get_ai_settings` | — → `AiSettings` | `DataDirUnavailable`, `AiCredential` |
| `update_ai_settings` | `UpdateAiSettings` → `AiSettings` | `AiEndpointInvalid`, `AiModelInvalid`, `AiCredential`, `DataDirUnavailable` |
| `set_ai_key` | `{ key }` → `AiSettings \| null` (null: the user declined, §12.3) | `AiKeyInvalid`, `AiCredential`, `DataDirUnavailable` |
| `clear_ai_key` | — → `AiSettings` | `AiCredential`, `DataDirUnavailable` |
| `test_ai` | — → `null` | `AiNotConfigured`, AI failure codes (§12.4), `DataDirUnavailable` |
| `AiSettingsChanged` event | `{ settings: AiSettings }` | — |

```ts
type AiSettings = {
  enabled: boolean;            // default true
  endpoint: string;            // default DEFAULT_AI_ENDPOINT
  model: string;               // default "deepseek-chat"
  sendContent: boolean;        // send changed lines (versioning §12.3); default true
  hasKey: boolean;             // a key is stored for this endpoint's origin
};
type UpdateAiSettings = {      // null: keep the stored value
  enabled: boolean | null; endpoint: string | null; model: string | null; sendContent: boolean | null;
};
const DEFAULT_AI_ENDPOINT: string;   // "https://api.deepseek.com", exported with the bindings
```

- Storage follows versioning §12.1: `settings.json` `ai`, read leniently like the other App
  settings (ipc-m1 §22.1); one writer at a time; a request that changes nothing writes nothing and
  sends no event. Every change sends `AiSettingsChanged`, key changes included.
- **Endpoint.** Trimmed, then: at most `endpointChars`; `https`; a host; an optional port and
  path; no user name, password, query or fragment. Stored with the scheme and host lower-cased
  and without a trailing `/`. Otherwise `AiEndpointInvalid`. Requests go to
  `<endpoint>/chat/completions`. The UI names the service "DeepSeek" when the endpoint is
  `DEFAULT_AI_ENDPOINT`, "the AI service" otherwise (handoff §4.3).
- **Model.** Trimmed, then 1–`modelChars` characters from `!` to `~` (visible ASCII), else
  `AiModelInvalid`.
- **An endpoint with another origin deletes the key** (versioning §12.1), in the same update: when
  deleting fails, the update fails with `AiCredential` and nothing changes. A change of path on
  the same origin keeps it.
- AI is **on** when `enabled` and `hasKey`; otherwise `generate_commit_message` is
  `AiNotConfigured` and the UI uses the template without mentioning AI (handoff §4.2).

### 12.2 The key

The key is **write-only across IPC**: the UI can set, test and clear it, never read it back.

- `set_ai_key` trims the key, then requires 1–`aiKeyChars` characters from `!` to `~`, which also
  keeps line breaks out of the `Authorization` header; otherwise `AiKeyInvalid`. It stores the
  key in Windows Credential Manager (`Folio/ai-api-key`), bound to the current endpoint's origin,
  replacing any stored key.
- No response, event, error `detail` or log record carries the key or any part of it. Responses
  say only `hasKey`. `AiCredential`'s detail names the Windows error code, nothing else.
- `clear_ai_key` deletes it; with none stored it changes nothing and still answers the settings.
- `get_ai_settings` reads whether a key is stored for the endpoint's origin, not the key. A key
  stored for another origin (an endpoint changed by hand in `settings.json`) counts as no key and
  is never sent.

### 12.3 Confirming another service (decision 2)

When the endpoint's origin is not `DEFAULT_AI_ENDPOINT`'s, `set_ai_key` first opens a Windows
confirmation owned by the main window, which no script can answer:

- Title "Use this AI service?"; text "Folio sends the text of your changes to <host> when it
  writes commit messages. Only allow this for a service you trust."; buttons "Allow" and
  "Cancel", Cancel the default. `<host>` is the endpoint's host as stored. The shell writes this
  text itself (the one exception of §2), in English like the UI.
- "Allow" stores the key and answers the settings; "Cancel", Esc or closing the dialog answers
  `null` and stores nothing.
- The default endpoint asks nothing. Changing the endpoint asks nothing either, since it deletes
  the key; the next key for the new origin asks.
- End-to-end tests use a test double that an environment variable selects in debug builds only
  (`FOLIO_TEST_AI_CONFIRM=allow|cancel`), like the dialogs of ipc-m1 §4.2.

### 12.4 Requests

| Command | Request → response | Errors |
|---|---|---|
| `generate_commit_message` | `GenerateCommitMessage` → `CommitMessage \| null` (null: stopped) | `AiNotConfigured`, AI failure codes, `WorkspaceChanged`, `NothingToCommit`, `InvalidArgument`, `NoLibrary`, `DataDirUnavailable` |
| `cancel_ai_request` | `{ requestId }` → `null` | `InvalidArgument` |

```ts
type GenerateCommitMessage = {
  requestId: string;           // chosen by the UI (§4), to stop it
  selection: Selection;
  fingerprint: string;
  description: string;         // what the user typed; at most descriptionChars ("" when none)
};
type CommitMessage = { summary: string; body: string | null };   // valid as typed: §7.2 needs no change
```

- `generate_commit_message` builds the request from the selection, the metadata changes and the
  description, sending only what versioning §12.3 lists, and answers the message of §12.4 there.
  At most 30 seconds in all. One generation runs at a time: a new one stops the running one,
  which answers `null`. A `requestId` that is already running is `InvalidArgument`.
- `cancel_ai_request` stops the generation with that id, which then answers `null`; an id that is
  not running (finished, stopped, never started) changes nothing and is not an error, because
  Stop and an answer can cross.
- `test_ai` sends a minimal request with the stored key, whether AI is on or not, and answers
  `null` when the service answered with a message. It sends no library data.
- **Failure codes** (versioning §12.5): `AiNetwork` (name, connection or TLS), `AiTimeout`,
  `AiRejected` (401, 403: the key), `AiRateLimited` (429), `AiUnavailable` (5xx),
  `AiBadResponse` (anything else, or an answer §12.4 there refuses), `AiCredential` (Credential
  Manager failed). The UI falls back to the template on every one (handoff §4.3).

## 13. Jobs

ipc-m1 §13 applies, with these changes to its types (they apply to every job kind):

```ts
type JobKind = "scan" | "hash" | "import" | "rebuild" | "commit" | "firstCommit";
type JobStatus =
  | { state: "queued" }
  | { state: "running"; progress: Progress }
  | { state: "done"; result: JobResult }
  | { state: "failed"; error: AppError; file: string | null }   // file: the library path it failed on
  | { state: "cancelled"; result: JobResult | null };
type Progress = {
  done: number; total: number | null;      // items: files or entries
  permille: number | null;                 // 0–1000 by bytes, for jobs that measure bytes
  bytes: ByteProgress | null;              // bytes done and in all, for jobs that measure bytes
  current: string | null;
};
type ByteProgress = { done: string; total: string };
type JobResult =
  | IpcM1JobResult               // scan, hash, import, rebuild (ipc-m1 §13)
  | { kind: "commit"; commit: string; summary: string; changes: number }
  | { kind: "firstCommit"; commit: string; files: number; left: number };
```

- **`commit`** (from `commit`) and **`firstCommit`** (from `start_history`) are separate kinds, so
  the activity button and popover word them apart ("Committing 40%", "Starting history 35%",
  handoff §4.4, §10) also after a reload. Their progress counts the files the commit reads
  (`done`, `total`: the files it must read or hash, which for a first commit is "files as well",
  handoff open item 6) and the bytes (`bytes`, `permille`), with `current` the file being read.
- `commit`'s result names the new commit, its summary and its changes (items plus metadata
  changes: "Committed 9 changes"). `firstCommit`'s names the commit, the files it holds, and the
  items it `left` out because they were not local or unreadable (they stay in Changes).
- **`file`** names the file a job failed on, when one file caused it: a commit's `FileChanged`,
  `NotLocal`, `InUse` or `AccessDenied` ("Midterm review.md kept changing while Folio read it",
  handoff §4.5). `null` for every other failure and for M1's job kinds, which report their files
  in their results.
- **`bytes`** is `null` for M1's job kinds for now; hashing may fill it later without a contract
  change.

## 14. Events

| Event | Payload | When |
|---|---|---|
| `WorkspaceChanged` | `{ revision; head; historyState; total }` | The workspace's items, metadata changes, `head` or `historyState` changed; at most four a second (versioning §6.5) |
| `HistoryChanged` | `{ head; revision }` | A commit, first commit, reword, uncommit or restore was recorded (`HEAD` or the operation log changed) |
| `AiSettingsChanged` | `{ settings: AiSettings }` | The AI settings or whether a key is stored changed (§12) |

- `WorkspaceChanged.total` is `items + metadata`, for the badge; `head` is `HEAD`'s id or
  `null`. It carries no fingerprint, which is computed for `get_workspace` only (versioning §6.5):
  the UI refetches the summary and the visible pages. It follows `CatalogChanged` for the same
  catalog change, so a page refetched after `CatalogChanged` alone may still be stale for the
  workspace; wait for this event.
- `HistoryChanged`: refetch the timeline, the "Not synced" card and open file histories.
- On `LibraryStateChanged`, drop everything as in M1 (ipc-m1 §15.3): keys, fingerprints and
  commit ids belong to the library that was open.

## 15. Errors

### 15.1 New codes

| Code | Meaning |
|---|---|
| `WorkspaceChanged` | The changes changed since the UI read them (the fingerprint or the base): refresh, then try again |
| `NothingToCommit` | The selection and the metadata hold no change |
| `FileChanged` | A file kept changing while Folio read it, or a restore's target changed before it was replaced |
| `HistoryExists` | `start_history`: the history has started already |
| `HistoryBusy` | Another commit, reword, uncommit or restore is running, or recovery of an earlier one: try again when it ends |
| `NotHead` | `uncommit`: the commit is no longer the newest |
| `CannotUncommit` | The first commit, a prune commit, or (M3) a synced one |
| `CannotReword` | A prune commit, or (M3) a synced one |
| `HistoryReadOnly` | A newer Folio wrote the history: update Folio to commit, reword, undo or restore |
| `HistoryDamaged` | The history cannot be read: `HEAD`, a pack or an object is missing or damaged. The files are fine |
| `NotStored` | That version was not kept: an event-only file, or text over `text_max_size` |
| `Pruned` | That version was thinned out (M3) |
| `Unchanged` | `restore_version`: the file already has that content |
| `SummaryEmpty`, `SummaryTooLong`, `SummaryInvalid`, `BodyTooLong`, `BodyInvalid` | A message breaks a rule (§7.2) |
| `AiNotConfigured` | AI is off, or no key is stored for the endpoint |
| `AiNetwork`, `AiTimeout`, `AiRejected`, `AiRateLimited`, `AiUnavailable`, `AiBadResponse`, `AiCredential` | §12.4 |
| `AiEndpointInvalid`, `AiModelInvalid`, `AiKeyInvalid` | A typed AI setting breaks its rule (§12.1, §12.2) |

Existing codes keep their meaning; M2 uses `NotLocal`, `InUse`, `AccessDenied`, `DiskFull`,
`NotRecyclable`, `ReadOnly`, `NotFound`, `Busy`, `PathTooLong`, `FileSystem`, `InvalidArgument`,
`NoLibrary`, `DataDirUnavailable` and `Internal`. `Busy` stays "the catalog is being rebuilt".
`errors.json` has a message for each new code; the views word their own cases more precisely
from the handoff (§4.3, §4.5, §8.3, §9).

### 15.2 From the core

| Core error (versioning §15) | Code |
|---|---|
| `HistoryError::WorkspaceChanged`, `NothingToCommit`, `FileChanged`, `NotHead`, `CannotUncommit`, `CannotReword`, `HistoryExists`, `NotFound` | The code of the same name (`NotFound` for `NotFound`) |
| `HistoryError::NotLocal` | `NotLocal` |
| `HistoryError::Unreadable` (`ReadFailure`) | `InUse` for in use, `AccessDenied` for denied, else `FileSystem` |
| `HistoryError::ReadOnly`, `WorkspaceError::ReadOnly` | `ReadOnly` |
| `HistoryError::Newer`, `StoreError::Newer` | `HistoryReadOnly` |
| `HistoryError::Damaged`, `StoreError::Missing`, `StoreError::Invalid` | `HistoryDamaged` |
| `HistoryError::Cancelled` | The job's `cancelled` state, never a code |
| `HistoryError::Io`, `StoreError::Io` | By the I/O error (ipc-m1 §16.2) |
| `StoreError::TooLarge` | `HistoryDamaged` (a store object over the format's limits) |
| `StoreError::Pruned`, `DiffError::Pruned`, `RestoreError::Pruned` | `Pruned` |
| `DiffError::NotStored`, `NotLocal`, `Unreadable`, `Binary`, `TooLarge` | Content kinds of §9.2, not codes |
| `RestoreError::NotStored`, `NotLocal`, `InUse`, `Denied`, `NotRecyclable`, `DiskFull`, `FileChanged`, `Unchanged` | `NotStored`, `NotLocal`, `InUse`, `AccessDenied`, `NotRecyclable`, `DiskFull`, `FileChanged`, `Unchanged` |
| `RestoreError::ReadOnly` | `HistoryReadOnly` |
| `WorkspaceError::Catalog`, `Meta` | `Internal` (the problem list names an unreadable metadata file) |
| `ai::AiError` (versioning §12.5) | `AiNotConfigured`, `AiNetwork`, `AiTimeout`, `AiRejected`, `AiRateLimited`, `AiUnavailable`, `AiBadResponse`, `AiCredential` |
| A history operation while another runs | `HistoryBusy`; while a catalog rebuild runs, `Busy` |

`detail` strings are for logs (ipc-m1 §16.1); none carries the AI key or any file content.

## 16. Security rules

ipc-m1 §17 applies to every command here. Added for M2; every implementation lane checks them,
and `/security-review` checks them again:

1. **The UI names, the shell resolves.** Items and metadata changes by the shell's keys, checked
   against the workspace under the fingerprint; commits by id, checked against `HEAD`'s chain;
   versions by commit and path, checked against that commit's tree. A path the shell writes
   (restore) comes from the history and the catalog, never from text the UI sent.
2. **Restore never loses a file** (versioning §11.3): what it replaces is in history or goes to
   the Recycle Bin first, it never replaces a file it has not checked again just before, and it
   never writes under `.folio/` or through a name that differs from the tree's (an 8.3 alias).
3. **The version route serves history, not the store**: only blobs a version of `HEAD`'s chain
   stores, verified; objects nothing reaches (an uncommitted or reworded commit's) are not served.
4. **The AI key is write-only** (§12.2): no response, event, log record or error detail carries
   it; it leaves the machine only in the `Authorization` header to the origin it was stored for.
5. **What leaves the machine is the shell's choice**: the UI sends selection keys and the
   description, never text to send; the shell builds the request from versioning §12.3 and
   nothing else. A key for an origin other than DeepSeek's needs the user's answer in a Windows
   dialog (§12.3), so a compromised UI cannot point Folio at its own server and have changed text
   sent there.
6. **Bounded work**: selections at `batch` keys, keys at `keyChars`, messages, descriptions,
   endpoints, models, keys and request ids at their limits, diff windows at `diffRows` rows, all
   checked before anything is read; one AI generation at a time; one history operation at a time.
7. **Nothing downloads.** Commits, diffs and restore never read a file that is not on this disk
   (`NotLocal`, content `notLocal`), as hashing and the scheme do (ipc-m1 §17 rule 10).

## 17. Fake shell

The fake shell (ui-architecture §11) answers every command of this spec, so the M2 UI lanes work
in the browser pane before the core exists. `src/ipc/mock/versioning/` holds its model of the
history and the workspace; `src/ipc/mock/commands/workspace.ts`, `history.ts` and `ai.ts` answer
the commands and name the sections they follow. It reproduces the contract, not the store: no
packs, no real diff algorithm (it compares lines with a small longest-common-subsequence and folds
them like §9.3), no network.

Scenarios (`?scenario=<name>`; each starts from the small library):

| Scenario | State |
|---|---|
| `small` | History with a handful of commits and a workspace with text, Word and binary changes, a moved folder, a bound item, a not-local and an unreadable item, and tag and settings changes |
| `history-none` | A library before its first commit: `historyState: none`; `start_history` runs the `firstCommit` job with byte progress |
| `history-long` | 1,200 commits over two years, with imports, a prune commit and pruned Word versions, rewords, uncommits and restores |
| `diffs` | Changes whose diffs are large (5,000 changed lines over 40,000 rows, paged and folded), empty (only formatting, only line endings, only the encoding), binary, too large and not stored |
| `history-read-only`, `history-damaged` | `historyState` `readOnly` or `damaged` |
| `ai-off` | AI disabled, no key: Generate uses the template |

URL parameters, beside ipc-m1's:

- `?ai=ok|network|timeout|rejected|rateLimited|unavailable|badResponse|credential|slow`: what
  `generate_commit_message` and `test_ai` do; `slow` answers after 20 seconds unless stopped.
- `?commit=fail:<code>[:<file>]`: the next commit job fails with that code, naming that file
  (default `MAT232/Midterm review.md`), as a failed commit does (handoff §4.5).
- `?restore=<code>`: `restore_version` fails with that code (`InUse`, `NotRecyclable`,
  `FileChanged`, …); `?restore=unchanged` answers `Unchanged`.
- `?confirm=allow|cancel`: the answer of the confirmation of §12.3.

The console drives it through `window.__FOLIO_FAKE_SHELL__` as before, plus `editFile(path)`,
`addFile(path)`, `deleteFile(path)`, `downloadFile(path)` (a not-local item becomes ready) and
`finishJobs()`, which change the workspace and send its events.

## 18. Tests

| Where | Tests |
|---|---|
| This lane (Rust) | Bindings drift (`export_bindings`, over every declared command); `runtime_commands_are_declared_and_granted` with the new groups declared and nothing registered; every `AppError` serializes as `{ code, detail }` with a unique code; `LIMITS` keys; `FILE_ERROR_CODES` are codes |
| This lane (TypeScript) | The fake answers every command and knows every event (`contract.test.ts`); `REVIEWED_BINDINGS`; the fake follows §5–§13 (`mock/versioning/*.test.ts`): selections and fingerprints, keys checked, paging and unfolding diffs, reword and uncommit rules, restore outcomes, the AI key never in a response, one generation at a time and stopping it; `versionUrl` and `shortId` |
| Each implementation lane | For every command: each validation rule returns its code; a stale key or id is `NotFound` or `WorkspaceChanged` and changes nothing; limits are `InvalidArgument`; events carry the right revision; plus versioning §16 for its area |
| AI lane | The key absent from every IPC response, event and log; the confirmation for other origins (test double); an endpoint change to another origin deletes the key; `cancel_ai_request` crossing an answer; versioning §16's AI row |
| End to end | One flow per feature (versioning §16 "E2E"); until a command is implemented, calling it is rejected (`not allowed`) |

## 19. Changes to earlier documents

Made in this lane:

- **versioning.md:** §6.5 notes that the fingerprint covers readiness (§5.1); §9.1 says the
  not-synced list shows the newest three commits in M2 (decision 1) and defines an operation's
  effective time (§4); §12.1 points to the confirmation of §12.3; §17 points here.
- **ipc-m1.md §1:** the M2 row of "later contracts" points here.
- **ADR-0004 action item 3:** the M2 contract's line.
- **Workspace-history handoff §18:** open items 2–6 are settled here (§8.1, §10, §8.1 and §8.3,
  §12.4, §13); §15 points here.
- **UI:** the activity popover words the two new job kinds (`apps/desktop/src/app/activity/`,
  `shell.json`), with the handoff's copy; `errors.json` has the new codes.

For later lanes:

1. `feat/core-commit-history`: `settings.json` 2 gains `device_id` and `device_machine`
   (versioning §4.6); the AI lane adds `ai` to the same version.
2. `feat/core-ai-message`: moves `DEFAULT_AI_ENDPOINT` into `folio_core::ai` (it lives in
   `ipc/ai.rs` until then) and opens the confirmation of §12.3 with the shell's dialog module.
3. `feat/ui-changes-view`: a `required` item's check box (§6.2) has no design yet: on and
   disabled is the suggestion, with the bound item's banner as its reason.

## 20. Next lanes

1. **`feat/core-object-store`**: no command; the store the others read.
2. **`feat/core-workspace`**: `get_workspace`, `list_workspace_items`, `list_metadata_changes`,
   `summarize_selection`, `WorkspaceChanged`.
3. **`feat/core-commit-history`**: `commit`, `start_history`, the `commit` and `firstCommit`
   jobs, `list_history`, `get_commit`, `list_commit_changes`, `list_commit_metadata`,
   `list_file_history`, `locate_version`, `reword_commit`, `uncommit`, `HistoryChanged`.
4. **`feat/core-diff-restore`**: `get_workspace_diff`, `get_version_diff`, `plan_restore`,
   `restore_version`, the version route.
5. **`feat/core-ai-message`**: the `ai` group, `AiSettingsChanged`, the confirmation.
6. **UI lanes** (`feat/ui-diff-viewer`, `feat/ui-changes-view`, `feat/ui-history-view`,
   `feat/ui-settings-ai`) build on the fake shell (§17) and compare it with each implementation
   as it lands (ui-architecture §11.5).
