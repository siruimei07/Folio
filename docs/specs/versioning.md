# Versioning (M2): local store, workspace, commits, history, diffs, restore, AI messages

System design for milestone M2 (brief §11: "知道改了什么，能找回旧版本"): the history Folio keeps on
this computer, the workspace that shows what changed since the last commit, commits and their crash
safety, the history view, diffs, restoring a version, and AI commit messages. The objects and packs
are defined in [remote-format.md](remote-format.md); this spec builds the local side on them.

- Status: approved by Sirui with remote-format.md on 2026-10-03, lane `docs/specs-history-format`.
  Section 17 outlines the contract for `feat/ipc-m2-contract`, §18 the crates for
  `chore/build-deps-m2`, §19 checks the planned M2 lanes.
- Inputs: [brief](../product/brief.md) §4, §5.4, §5.6–§5.8, §9;
  [ADR-0002](../adr/ADR-0002-data-storage.md); [ADR-0003](../adr/ADR-0003-versioning-and-sync.md)
  §2–§4, §10–§11; [ADR-0006](../adr/ADR-0006-history-retention.md);
  [system overview](system-overview.md); [library core](library-core.md);
  [library scan](library-scan.md); [ipc-m1](ipc-m1.md).

**Sirui's decisions (2026-10-03).** Asked with concrete options while this spec was written:

1. **Retention:** old Word versions are thinned out: all for 30 days, then one a day up to 6 months,
   then one a week; text versions are kept forever (ADR-0006, §5.4).
2. **Size limits:** text files up to 10 MiB keep their versions; Word files at any size (unchanged).
3. **Versioned files:** the text extensions and `.docx` (unchanged); everything else records change
   events only.
4. **Tag and settings changes** always go into the next commit; they are listed, without a check box
   (§6.4).
5. **Uncommit** takes back only the newest commit, as often as needed (§8.4).
6. **History starts by itself:** a library without history records a first commit automatically
   (§7.7).
7. **AI messages** may send up to about 32,000 characters of changed text, about 8,000 per file
   (§12.3).

## 1. Scope

| In M2 (this spec) | Later |
|---|---|
| The local object store, `HEAD`, the operation log, journals | The remote store and sync (M3, sync.md) |
| The workspace: the disk compared with the last commit | Conflicts and merges (M3) |
| Commits, the automatic first commit, reword, uncommit | Thinning and compaction (M3, `feat/core-retention`, §5.4) |
| History: timeline, commit details, one file's history | Restoring several files or a whole folder |
| Diffs of text, Word text and metadata; restore one version | Discarding uncommitted changes (not in the brief) |
| AI commit messages (DeepSeek, OpenAI-compatible) | |
| The catalog's tables for all of the above; full-text search of text and Word files (`feat/core-text-extract`) | PDF, PowerPoint and Excel text (brief §5.2) |

## 2. Requirements

| Need (brief) | Here |
|---|---|
| Changes made anywhere show up as uncommitted changes: added, modified, deleted, renamed or moved; tags and course settings too (§5.4.1) | §6 |
| Each change can be left out of a commit, except tag and settings changes (§5.4.2; decision 4) | §6.3, §6.4, §7 |
| Text and Word show a diff with the last version; Word compares text only; other files show "modified (old version not kept)" (§5.4.3) | §10 |
| A message from a title and a description, both optional: AI if configured, else a template such as `MAT232: add 2 files; CSC207: update 1 file`; `Ctrl+Enter` (§5.4.4) | §8, §12 |
| Edit the message or undo the commit before sync (§5.4.5) | §8.3, §8.4 |
| A timeline of commits and operations; files with their changes; the source device; one file's history (§5.6) | §9 |
| Restore a text or Word version as a new change; never rewrite history (§5.6) | §11 |
| AI only from the privileged layer; the key in Windows Credential Manager; what is sent is capped and can be turned off (§5.7, §12) | §12 |

Non-functional:

| Quality | Target |
|---|---|
| Scale | 50,000 files: the workspace's summary and first page within 100 ms with a few changes, within 500 ms when everything changed; a history page within 50 ms |
| Commit | A commit of a few files within a second; a first commit of a large library runs as a job with progress |
| Diff | A 1 MiB text file within 300 ms; anything larger than the limits (§10.2) shows a summary |
| Safety | A commit, reword, uncommit or restore is whole or absent after any crash; nothing in the library is ever lost: replaced content is in history or in the Recycle Bin |
| Privacy | M2 adds one network call, the AI request: only with a key, sending only what §12.3 lists |

## 3. Modules

| Core module (`crates/folio-core/src/`) | Owns | Lane |
|---|---|---|
| `store/` | Object ids, canonical JSON, trees and commits, packs (remote-format.md), the local store's packs and `HEAD` (§4.2–§4.3) | `feat/core-object-store` |
| `workspace/` | Pairing the disk with `HEAD`, items, metadata changes, summaries, `WorkspaceChanged` (§6) | `feat/core-workspace` |
| `history/` | Commit, the first commit, reword, uncommit, the journal, the operation log, history queries (§4.4–§4.5, §7–§9) | `feat/core-commit-history` |
| `extract/` | Decoding text files, Word paragraphs, search bodies (§10.2–§10.3) | `feat/core-text-extract` |
| `diff/` and `restore/` | Diffs (§10), restore (§11) | `feat/core-diff-restore` (§19) |
| `ai/` | The AI request, its client, the key's adapter (§12) | `feat/core-ai-message` |

The shell gets three command groups, `commands/workspace.rs`, `commands/history.rs` and
`commands/ai.rs` (ipc-m1 §3), and the UI three views: `changes/`, `history/` and the AI page of
`settings/`, sharing a diff component.

```text
disk ──scan, hash (M1)──> catalog entries ─┐
                                           ├─ workspace: items + metadata changes ─> commit
.folio/local/HEAD ─> head_files (catalog) ─┘                                          │
                                                                                      v
.folio/local/packs <── blobs, trees, commit ── history ── HEAD switch ── catalog: commits, objects
```

## 4. The local store

### 4.1 Layout

```text
.folio/local/              never synced by any client (ADR-0003 §4)
  packs/<hash>.pack        one or more per commit, reword or thinning; never modified
  HEAD                     the newest commit (§4.2)
  oplog.jsonl              the operation log (§4.4)
  journal/history.json     commit, first commit, reword, uncommit (§7.5)
  journal/restore.json     restore (§11.4)
  journal/scan.json        M1 (library-scan.md §7.1)
  journal/import.json      M1 (library-import.md)
  staging/                 temporary files for atomic writes
  remote.json              M3
```

### 4.2 `HEAD`

```json
{"format_version":1,"head":"b3:c053593cc5e0a70b01d804d389cd0249b9b78e3254193013eef7ed980fc3133c"}
```

- Canonical JSON (remote-format.md §5) without a final line break. No `HEAD` and no pack: the
  library has no history yet. No `HEAD` while `packs/` holds a pack is damage, not a new start
  (`HistoryError::Damaged`, below): no first commit is written over it (§7.7).
- Replaced atomically: written in `staging/`, flushed, renamed over the old file. The rename uses
  `MOVEFILE_WRITE_THROUGH` (`files::write_atomically` gains a durable variant), because `HEAD` is
  the commit point (§7.5).
- A `HEAD` that cannot be read, or that names a commit the store does not have, means the history is
  damaged (`HistoryError::Damaged`): the library stays usable, history is read-only, and the problem
  is reported. A newer `format_version` makes history read-only (remote-format.md §3).

### 4.3 Packs and objects

- Packs follow remote-format.md §9; the writing guidance of §9.5 applies, so a Word version of at
  least 1 MiB gets a pack of its own and thinning can later delete it whole.
- The store holds every object reachable from `HEAD`, except blobs pruned by prune commits, plus
  objects nothing references any more: commits that were reworded or uncommitted, which the
  operation log names, and packs a crash left behind. M2 deletes nothing, except the packs of a
  first commit that crashed before its commit point (§7.5). Thinning (M3) deletes only what
  remote-format.md §7.5 allows; removing unreferenced objects needs a design of its own.
- Indexing a pack reads its header, trailer and index (remote-format.md §11, steps 1–4 and 6): the
  catalog's `objects` table maps each id to its pack and offset (§13). Reading an object reads its
  record and checks its id (steps 7–11). A full check of every pack (step 5 and the walk over all
  records) is a later "Check history" action.
- Packs are written in `staging/`, flushed, and renamed into `packs/` with `MOVEFILE_WRITE_THROUGH`
  before anything names them. A pack whose name exists already is kept when its trailer hash
  checks, as two packs with one name hold the same bytes; a damaged one is replaced by the new copy.
- Objects that no commit of `HEAD`'s chain reaches (an uncommitted or reworded commit, a blob only
  it stored) never leave this device: M3's push publishes only what the pushed head reaches
  (remote-format.md §9.5).

### 4.4 The operation log

`oplog.jsonl`: one canonical JSON object per line, each followed by a line feed, appended and never
rewritten. History shows these operations beside commits (brief §5.6: 修改说明、撤销提交、恢复版本).
Commits themselves are not logged: the chain from `HEAD` is their record.

| `op` | Fields besides `format_version` (1), `id` (16 lowercase hex digits), `op`, `time` |
|---|---|
| `reword` | `commit` (the old id), `new` (its new id), `head_before`, `head_after` |
| `uncommit` | `commit` (the commit taken back), `head_after` (its parent) |
| `restore` | `commit` and `path` (the version), `hash` (its blob), `target` (the library path written), `recycled` (whether the file there went to the Recycle Bin) |

M3 adds the sync operations. A last line without its line feed is what a crash while appending
leaves: readers skip it, and the next append removes it first. Lines are at most 64 KiB.

### 4.5 Local format versions

`HEAD` 1, the operation log 1, the history journal 1 (§7.5) and the restore journal 1 (§11.4) are
local formats with versions of their own, separate from the history format. Each follows ADR-0002
§3's rule: readers accept older versions, write the current one, and treat a newer one as read-only.
v0.2 freezes them (§14).

### 4.6 This device

Commits name the device that made them (remote-format.md §7.3), and in M3 the device owns its paths
in the remote, so two installations must never share an id.

- `settings.json` (ADR-0002 §2, per Windows user and machine) gains `device_id` (32 lowercase
  hexadecimal digits, random) and `device_machine`: the first 32 hexadecimal digits of the BLAKE3
  hash of the Windows `MachineGuid` (`HKLM\SOFTWARE\Microsoft\Cryptography\MachineGuid`).
- At start-up Folio reads `MachineGuid`. When `device_machine` is missing or different, as after
  copying the data folder to another Windows installation, it generates a new `device_id` and saves
  both, through `Settings::update` like every writer of the file (library-state.md). A
  `MachineGuid` that cannot be read keeps the stored id.
- The binding catches a copied data folder, not a cloned disk, which copies `MachineGuid` too. The
  general guard is sync.md's: a head in the device's own folder that it did not write.
- The device's name is App settings' device name, else the name Windows gives the computer, read
  once a run (ipc-m1 §22.1).

## 5. Full versions and change events

### 5.1 Which files keep versions

A file's class comes from its extension (library-core.md §4.2): text, Word or other. Whether a
version is **stored** follows `library.json`'s versioning rules in the commit that introduces it
(Sirui, decisions 2 and 3):

| Class | Stored |
|---|---|
| Text (the ~70 default extensions) | When at most `text_max_size` (10 MiB by default) |
| Word (`docx`) | Always, at any size |
| Other (PDF, PowerPoint, Excel, images, audio, video, archives, files without an extension) | Never: change events only |
| `.folio/` metadata files | Always (remote-format.md §7.4) |

### 5.2 Writing `stored`

`stored` follows the commit's own `library.json` and nothing else (remote-format.md §7.2): equal
content under equal rules gives equal trees, whoever writes them. Since the rules always go into the
next commit (§6.4):

- A change of rules turns `stored` on or off for every file it concerns, in the commit that records
  it; a flag that changes is a `modify` record whose hash and size stay the same.
- A file it turns on must have its blob in that commit. The commit reads it from the disk; when the
  file's own change is held back (its committed content is no longer on the disk), that change is
  bound to the rules change and committed with it (§6.3). A file that is not on this disk fails the
  commit (`NotLocal`).
- A file it turns off keeps its earlier blobs: earlier versions stay restorable.

So a larger text limit, say, makes the next commit store every file it now covers, which may read
many files.

### 5.3 Change events

For other files a commit records add, delete, modify and move with the hash and size. History
shows them with their sizes (brief §5.6); a diff or a restore is not possible.

### 5.4 Thinning old Word versions

The rule of ADR-0006, implemented in M3 (`feat/core-retention`); M2 keeps everything.

- A **Word version** is the blob a commit stored for a Word-class file when it added it, modified
  it, or moved it with new content. Versions belong to a file's line: a move record, or a folder
  move that carried the file, continues it (remote-format.md §8); a delete ends it; an add starts a
  new one. Without `changes` a line continues where the path stays the same.
- **Times.** Clocks can be wrong (remote-format.md §6.2), so ages use each commit's *effective
  time*: the later of its own `time` and its parent's effective time, which never decreases along
  the history. `now` is the device's clock, in UTC. A version's **age** is `now` minus the effective
  time of the commit that introduced it. The job does nothing when `now` is earlier than the newest
  effective time, which means this clock, or another device's, is wrong.
- **Kept**, per line:
  1. every version still in `HEAD`'s tree;
  2. every version up to 30 days old;
  3. from 30 to 183 days, the last version introduced on each UTC calendar day;
  4. older, the last version introduced in each ISO 8601 week (Monday to Sunday, UTC).

  "Last" means latest in the history's order, which settles equal times.
- A blob is thinned out when no version keeps it; a blob that several lines or files share stays
  while any of them keeps it.
- **When.** At most once a day, as the first step of a commit job: the prune commit goes below the
  user's new commit, so the newest commit stays one the user can uncommit (§8.4).
- **Deleting bytes.** Each device compacts its own store, and deletes a blob only when a prune
  commit lists it (remote-format.md §7.5) *and* its own evaluation of this rule agrees, so a device
  with a wrong clock cannot make others delete. Without a remote it compacts right after the prune
  commit; with one, after that commit has been pushed and is canonical (M3), because a rebase may
  still change its list. Remote packs follow remote-format.md §10.1.
- Text, metadata and other files are never thinned.

## 6. The workspace

The workspace is the disk, as the catalog knows it, compared with `HEAD`'s tree (ADR-0003 §10). It
reuses M1's scan and hashing (library-scan.md §6–§8): no second walker.

### 6.1 Pairing the disk with the last commit

The catalog keeps `HEAD`'s tree flattened in `head_files` (§13): one row per path with its kind, hash
(a folder's tree id), size and `stored`, and the id of the catalog entry that *is* that file or
folder.

- Catalog entry ids survive moves and saves through a temporary file (library-scan.md §6.1), so a
  row stays paired while the file moves or changes.
- When the scan removes an entry, its row loses the pairing (the foreign key sets it to null): the
  file was deleted. A row without a pairing pairs again with a new entry at exactly its path, such as
  a file deleted and created again.
- `head_files` changes with `HEAD`, by the commit's changes rather than by rewriting every row: a
  commit applies its records and pairs each committed path with the entry it came from; an uncommit
  applies them backwards, pairing through their moves and then by path. After a catalog rebuild,
  rows are flattened from `HEAD` and pair by path only, so moves since the last commit show as a
  deletion and an addition.

Comparing the two (one join, indexed) gives, for each file and folder: unchanged, added (an entry no
row pairs with), deleted (a row without an entry), modified (same path, other hash), moved (another
path, maybe modified).

### 6.2 Readiness

A file's comparison needs its hash. An entry whose hash is missing (the hashing job has not reached
it) is **hashing**; one whose content is not on this disk is **not local** (library-scan.md §8); one
the hashing job could not read is **unreadable**. An added file is listed in any of these states; a
modified file is listed once its hash differs. A commit hashes what is still hashing; items that are
not local or unreadable cannot be committed yet (§7.4).

### 6.3 Items

Each item is one change the user can include or leave out. Its **key** names it while it exists: the
kind and its main path (the new path, or the old one for a deletion).

| Item | When | Covers |
|---|---|---|
| File added | An entry no row pairs with | The file |
| File deleted | A file row without an entry, outside a deleted folder | The file |
| File modified | Paired, same path, other hash | The file |
| File moved | Paired, other path, outside a folder that moved with it; maybe modified | The file |
| Folder moved | A folder row paired with a folder at another path | The folder and what moved with it unchanged; changes inside are items of their own |
| Folder deleted | A folder row without an entry | The folder and what was deleted with it; entries that left it are items of their own |
| Folder added | A new folder with nothing below it (an empty folder) | The folder; a new folder with content comes in with its first committed file |

- Items cover disjoint paths: a folder item covers only what has no item of its own.
- **Bound items.** Some items cannot be committed without each other; they are bound into one row,
  committed together, so no selection builds an invalid tree or drops a file:
  - one writes a path, or a folder above one, that the last commit holds and another item removes
    or replaces (a file replaced by a moved file, a swap of two names, a file replaced by a
    folder);
  - one deletes a folder and another moves or deletes an entry from inside it (hw2.pdf moved out of
    `作业` before `作业` went, in the example of remote-format.md §12);
  - a change of the versioning rules and the held-back change of a file whose `stored` it turns on
    (§5.2).
- An item carries what the views need: its paths, the class, sizes before and after, whether the
  old and new versions are stored (so the diff view knows what it can show), its readiness, a count
  for folder items, and the tag changes of its entry (§6.4).

### 6.4 Tag and settings changes (decision 4)

The metadata files are read as data, not compared as files. The workspace compares, entry by entry
and through the pairing of §6.1:

- the tags of each file and folder;
- the settings of each semester and course;
- the tag definitions (`tags.json`), the library settings (`library.json`) and the ignore rules
  (`.folio/ignore`, compared as text).

These **metadata changes** have no check box. Every commit records the metadata as it is on the
disk, with one exception that keeps it consistent with the files: the tags and settings of an entry
that an unselected item holds back follow that entry. An entry whose addition is held back keeps
them for the commit that adds it; a deleted entry that the commit still holds has its last committed
ones; an entry whose move is held back has its current ones at its old path. In the list, an
entry's tag change is part of its item when it has one, and a row of its own otherwise.

- A metadata file that cannot be read keeps its last committed content in every commit, and the
  problem list says so (library-scan.md §7.3).
- A metadata file written by a newer Folio stops commits (`ReadOnly`, ADR-0002 §3): a commit would
  write it back in the older format.

### 6.5 Revision, fingerprint and events

- The workspace has no counter of its own. Everything it depends on (entries, hashes, the metadata
  mirror, `head_files`) changes in catalog transactions, so its pages carry the catalog revision
  like every `Page` (ipc-m1 §5.3, §15.2).
- Its **fingerprint** is 128 bits: the sum, modulo 2^128, of the first 16 bytes of BLAKE3 of each
  item's and metadata change's key, so it is updated as items come and go and needs no sorting. A
  commit names the fingerprint it was built on (§7.1), so it never commits a set of changes the user
  did not see. A file edited again keeps its key, so the fingerprint stays. It is computed for
  `get_workspace` and for the commit, not for every event.
- `WorkspaceChanged` carries the catalog revision, the totals and `HEAD`, at most four times a
  second. It follows `CatalogChanged`, hashing batches, metadata changes and `HEAD` changes. While
  the first commit is running (§7.7) the workspace lists nothing.

### 6.6 Summary

For the commit box and the template message (§8.1), the core summarizes a selection without the UI
holding every item: per course (code, name and badge from the catalog), per semester and for the
library root, the counts of files added, modified, deleted and moved, of tag changes and of settings
changes.

## 7. Commit

### 7.1 Request

- **Selection**: every item except the listed keys, or only the listed keys (at most `batch`, 10,000,
  either way).
- **Fingerprint** and **base** (`HEAD` when the UI read the workspace). If either changed, the
  commit fails with `WorkspaceChanged` before writing anything.
- **Summary** and optional **body** (remote-format.md §6.7). The UI always sends a summary: what the
  user typed, the AI's, or the template (§8.1).

### 7.2 Building the tree

Starting from `HEAD`'s tree:

1. Folder moves, outermost first: the folder's committed subtree moves to its new path.
2. Folder deletions: the folder goes with what it covers (§6.3).
3. File items: each removes its old path, where the commit holds it now, and writes its new path
   with the disk's entry. Missing parent folders are created.
4. Folder additions: the empty folder.
5. `.folio/`: the metadata of §6.4, serialized with M1's deterministic writer (library-core.md
   §4.3), so a file that did not change is the same blob as before.
6. `stored` (§5.2): for the files this commit writes, and for every file when the versioning rules
   changed.

Only the folders on changed paths are encoded again; every other folder keeps its tree id from
`head_files`. `changes` comes from the selected items, with their moves (remote-format.md §8); a move
whose old path holds the same entry again, such as a folder renamed while a new folder took its old
name, is recorded as an addition (§8 rule 6). A commit that changes nothing is refused
(`NothingToCommit`).

Properties the tests check (§16), with a full rebuild of the tree from the disk as the oracle:
committing every item gives a tree equal to the disk; committing a selection and then the rest gives
the same tree as committing everything at once; every commit's `changes` passes remote-format.md §8.

### 7.3 Reading files

- A stored file is read whole, hashed while it is read, and written into the pack (remote-format.md
  §9.5). A file that is not stored needs only its hash: the catalog's, when the file's size,
  modification time and file id still match the hashed row; else the commit hashes it.
- Size, modification time and file id are compared before and after reading, as hashing does
  (library-scan.md §8). A file that changes while it is read is read again, up to three times, and
  then fails the commit (`FileChanged`). A commit takes the file as it is when read, so a file edited
  after the diff was shown commits its newest content under the same item.
- A file not on this disk, or one that cannot be read, fails the commit (`NotLocal`, `InUse`,
  `AccessDenied`) and names the file. Nothing has been written; the selection and message stay.

### 7.4 Readiness

Items that are hashing are hashed by the commit itself. Items that are not local or unreadable fail
the commit (§7.3), except in the first commit (§7.7).

### 7.5 Writing, the journal and crash safety

A commit runs as a job (kind `commit`) with progress in bytes. Reading and packing happen without
holding the catalog's writer; the switch holds it, serializing it with scans, imports and every
other writer of `.folio/` (library-scan.md §7.4).

1. Read the files and write the pack or packs in `staging/` (§7.3), flushed.
2. Write the journal `journal/history.json` atomically: `format_version` 1, an `id`, `op`
   (`commit`, `reword` or `uncommit`), `head_before` (left out for a first commit), `head_after`,
   the packs, and the operation log entry to append, if any.
3. Rename the packs into `packs/` (§4.3).
4. Replace `HEAD`: **the commit point**.
5. Append the operation log entry, if any, flushed.
6. Update the catalog in one transaction: `objects`, `commits`, `commit_changes`, `pruned`,
   `info.history_head`, and `head_files` by the commit's changes (§6.1). Each committed path is
   paired with the entry the commit read when that entry still exists with the file id read;
   otherwise the row pairs by path.
7. Delete the journal.

Recovery, at start-up and before the next history operation:

| State found | Means | Recovery |
|---|---|---|
| A journal, `HEAD` = `head_before` | Crashed before the commit point | Delete the journal; the packs it names are orphans (§4.3). A first commit's packs are deleted with it, as nothing else can reference them: a library without `HEAD` keeps no pack (§4.2) |
| A journal, `HEAD` = `head_after` | Committed | Append the log entry unless an entry with its `id` is there, update the catalog (pairing committed paths by path), delete the journal |
| A journal, `HEAD` is neither | Something else changed `HEAD` | `HistoryError::Damaged`; keep the journal |
| No journal, `info.history_head` ≠ `HEAD` | The catalog missed an update, or was rebuilt | Rebuild the history tables (§13.2) |

The journal comes before the packs reach `packs/`, so in a library without `HEAD` a pack that no
journal names is never a first commit's leftover: it means damage (§4.2). Cancelling stops before
step 2 and deletes what step 1 staged. Crash injection runs at every step.
At most one history or restore operation runs at a time; none starts while a journal of M1 is
unsettled, and a history or restore operation and a catalog rebuild exclude each other (whichever
comes second fails with `Busy`).

### 7.6 Errors

`WorkspaceChanged`, `NothingToCommit`, `FileChanged`, `NotLocal`, `InUse`, `AccessDenied`,
`DiskFull`, `ReadOnly` (newer metadata, §6.4), `HistoryReadOnly` (a newer history, §4.2),
`HistoryDamaged`, `Cancelled`.

### 7.7 The first commit (decision 6)

A library without history records its first commit by itself, so the workspace starts empty:

- **When:** after the library's first full scan and hashing have finished, when there is no `HEAD`
  and no pack (§4.2): a new library, a folder just taken over, or a library first opened with v0.2.
- **How:** the UI starts it with the summary from its strings ("Start history"; the core writes no
  UI text, CLAUDE.md §2) through `start_history`, which commits every item that is ready and the
  metadata. Items that are not local or cannot be read are left out and stay in the workspace. The
  call fails with `HistoryExists` once `HEAD` exists, so it is safe to repeat.
- It is an ordinary commit job with progress: reading every text and Word file of a large library
  can take minutes. A failure (a full disk) leaves no history, shows the error, and the next opening
  of the library tries again.
- The first commit cannot be uncommitted (§8.4), or the library would start its history again at
  once.

## 8. Messages, reword and uncommit

### 8.1 The template

The template (brief §5.4.4) is UI text, so the UI writes it from the summary of §6.6 and its own
strings: one clause per course, by its code (or name when it has none), with the counts in a fixed
verb order, joined by `; ` (`MAT232: add 2 files; CSC207: update 1 file`). Files outside courses use
their semester's name, or `Library` at the root; tag-only and settings-only commits get their own
phrases (`MAT232: tag 3 files`, `Update course settings`). After three courses it ends with `and N
more`. A result over the summary's 256 characters is cut at the last space before the limit, with
no white space left at its end (remote-format.md §6.7).

### 8.2 With AI

When AI is configured and on, the commit box's Generate and a commit with both fields empty ask the
core for a message (§12), at most 30 seconds, cancellable. Any failure falls back to the template, so
committing never depends on the network.

### 8.3 Reword

- Any commit of kind `commit` or `import` that has not been synced: in M2, every one. A prune
  commit has no message (`CannotReword`).
- The commit is written again with the new message, keeping its tree, parent, device, time, kind
  and changes; every later commit is written again on top of it, unchanged otherwise (a later prune
  commit too, with the same list). One new pack holds them.
- The switch follows §7.5 with `op: reword` and logs `reword`. The old commits stay in the store,
  unreferenced, and the log names them.

### 8.4 Uncommit (decision 5)

- Only `HEAD` (`NotHead` otherwise), only a commit of kind `commit` or `import`, never the first
  commit, and in M3 only an unsynced one (`CannotUncommit` for the others). Thinning puts its prune
  commit below the user's next commit (§5.4), so the user's newest commit can always be taken back;
  the one below a prune commit cannot.
- `HEAD` moves to the parent; the files on the disk do not change, so the commit's changes return
  to the workspace. The switch follows §7.5 with `op: uncommit` and logs `uncommit`.

## 9. History

### 9.1 Timeline

- Commits of `HEAD`'s chain and operations of the log, newest first by effective time (§5.4, which
  keeps commits in the chain's order whatever their clocks said), then by their order in the chain
  or the log; paged (ipc-m1 §5.3), and filterable by type (brief §6.2's "All types").
- An operation that names a commit a later reword rewrote shows the commit it became: a reword's
  `head_before` and `head_after` chains have equal length, so the catalog maps old ids to new ones
  by position when it reads the log (§13).
- A commit shows its time, kind, summary, body, short id (the first 7 hexadecimal digits), device
  name (`iCloud` for imports, brief §5.6), its first changed files and their count. A prune commit
  shows how many old versions were thinned out.
- "Not synced" marks commits after the remote's canonical head; in M2 every commit is unsynced,
  and the not-synced list of the workspace is empty until M3.

### 9.2 Commit details

The changed files of one commit, paged, from `commit_changes`: operation, paths, kind, class, sizes
before and after, and whether each side is stored (or pruned). `.folio/` paths are not listed as
files; their changes appear as tag and settings changes (§10.4).

### 9.3 One file's history

From a file in the Library (brief §5.6), or from a file card: its versions, newest first, following
its line backwards through move records to where it was added. Each row is a commit with the
operation, the path the file had then, its size and whether that version is stored or pruned. Paged.

### 9.4 Viewing a version

A stored version's bytes reach the preview through the `folio-file` scheme (ipc-m1 §11.2) with a
version route: the blob's id and the file's name, for the content type. The shell serves only blobs
that a version of `HEAD`'s chain stores (§13), verified, with the scheme's headers. The preview renders them as it
renders current files (brief §5.6: 文本类和 Word 显示这一版的内容).

## 10. Diffs

### 10.1 What can be compared

| Before → after | Shown |
|---|---|
| Text, both versions available | A line diff with changes inside lines (§10.2) |
| Word, both available | A paragraph diff of its text (§10.3); "only formatting changed" when the text is equal |
| Metadata | Tag and settings changes (§10.4) |
| Added or deleted, one version available | That version's text, all added or all removed |
| A side not stored, pruned, not local, unreadable, binary, or over the limits | No diff: the reason, the sizes, and the current file's preview |

In the workspace "before" is `HEAD`'s version and "after" the disk; in history, the parent's
version and the commit's.

### 10.2 Text

- **Decoding** follows the preview's rule (ui-architecture.md §10.1, `preview/frame/decode.ts`), so
  a version reads the same in its preview and in its diff, and full-text search shares it
  (`extract`, with `encoding_rs`): a byte order mark (UTF-8, UTF-16 LE or BE) decides; otherwise a
  NUL in the first 8 KiB means binary; otherwise valid UTF-8; otherwise GB18030, which contains GBK.
  Line breaks become LF.
- **Line diff:** the Patience algorithm (`similar`) on lines, and changes inside each changed line
  by words, or by characters for CJK text. Line endings are compared as LF; a change of line endings
  alone is reported as such.
- **Limits:** each side at most 8 MiB of text and 200,000 lines, and one second of diffing (beyond
  that, line changes only, marked approximate). Hunks have 3 lines of context and are paged.

### 10.3 Word

The text of `word/document.xml` (`extract`, the same reader as search): paragraphs in reading order,
including table cells, then footnotes and endnotes; inserted text counts and deleted text (tracked
changes) does not; tabs and line breaks inside a paragraph are kept. Paragraphs are diffed like
lines, with changes inside them. The reader opens the ZIP without running anything, refuses
DTDs, and caps the expanded size (64 MiB) and the number of entries.

### 10.4 Metadata

Tags added and removed per file, settings that changed per semester and course (old → new), tag
definitions added, renamed, recoloured, reordered or deleted, the library's name and versioning
rules, and the ignore rules as a text diff.

## 11. Restore

### 11.1 What it does

Restoring a stored text or Word version writes it to the disk as a **new uncommitted change** (brief
§5.6). History is never rewritten; the user commits the change like any other.

### 11.2 Where it goes

- The file's line (§5.4) is followed from the version's commit to `HEAD`, then to the disk through
  the pairing (§6.1). If the file exists, the version replaces it at its current path.
- If it was deleted, the version goes back to its last committed path, recreating folders. If a
  different file now has that name, it goes beside it under M1's keep-both name (import's numbering,
  ipc-m1 §12).
- Restoring the content the file already has changes nothing and says so (`Unchanged`).
- Paths under `.folio/` cannot be restored. Every folder on the way and the file replaced must have
  exactly the names of the path, never an 8.3 alias such as `FOLIO~1` (remote-format.md §7.4).

### 11.3 Safety

The file being replaced is never lost: when its content is a version that history keeps (stored by a
commit of `HEAD`'s chain and not pruned, §13), it is in history; otherwise it goes to the Recycle
Bin first. Being in the store is not enough: the store also holds objects no commit reaches (§4.3).
If the Recycle Bin cannot take it, the restore stops (`NotRecyclable`). A file not on this disk is
not replaced (`NotLocal`); a file another program holds fails with `InUse`. Like an import that
replaces a file (library-import.md), restore records the identity of what it replaces (file id,
size, modification time and content hash) and checks it again right before replacing: a file saved
in between is never overwritten (`FileChanged`, nothing replaced).

### 11.4 Steps and recovery

1. Read and verify the blob into `staging/` (`restore-<id>`), flushed.
2. Write the journal `journal/restore.json`: `format_version` 1, `id`, `commit`, `path`, `hash`,
   `target`, the identity of the file there (or that there is none), and whether it goes to the
   Recycle Bin.
3. Check the target's identity again; recycle the current file if it must.
4. Rename the staged file onto the target.
5. Append the operation log's `restore`; delete the journal.

It runs under the catalog's writer, like M1's file operations, and reuses the import intent's
identity checks and recovery rules (library-import.md): recovery finishes only from states it can
prove, judged by the staged file, which the journal's existence says was written.

| Found | Recovery |
|---|---|
| The staged file is gone | Step 4 renamed it: step 5 (the log entry unless one with its `id` is there) |
| The staged file, and at the target the recorded identity | Steps 3–5 |
| The staged file, and nothing at the target | The recorded file was recycled or deleted: steps 4–5 |
| The staged file, and another file at the target (edited or replaced while Folio was closed) | Abandon: remove the staged file and the journal, keep the target, report it |

## 12. AI commit messages

### 12.1 Settings

- `settings.json` gains `ai`: `enabled` (default `true`), `endpoint` (default
  `https://api.deepseek.com`), `model` (default `deepseek-chat`; the lane checks DeepSeek's current
  names) and `send_content` (default `true`). AI runs when it is enabled and a key is stored. These
  values read leniently, like the other App settings (ipc-m1 §22.1).
- The **key** lives in Windows Credential Manager, a generic credential for this Windows user
  (target `Folio/ai-api-key`). It is never written to a file or a log, never sent over IPC to the UI,
  and leaves the machine only in the `Authorization` header to the configured endpoint.
- The key is **bound to the endpoint** it was entered for: the credential keeps that endpoint's
  origin (scheme, host and port) as its user name. A request goes out only when it equals the
  current endpoint's origin, and changing the endpoint to another origin deletes the key, so a key
  never reaches a host it was not entered for, whether the user switched services or a script in
  the UI changed the setting.
- The endpoint is any OpenAI-compatible service (brief §5.7): `https` only, a host, an optional path
  (`/v1`), no user name, query or fragment. Requests go to `<endpoint>/chat/completions`.

### 12.2 The request

- `POST`, JSON: `model`, `messages` (a system message with the instructions, a user message with the
  changes), `temperature` 0.2, `max_tokens` 300, `stream` false; `Authorization: Bearer <key>`.
- Redirects are not followed; a 10-second connection timeout and a 30-second total; a response of
  at most 256 KiB. TLS with rustls and the Windows certificate store.
- The instructions ask for English (the UI's language, brief §5.7): one summary line of at most 72
  characters that starts with the course code, or the course name without one, then optionally up to
  five short detail lines; plain text only.

### 12.3 What is sent (Sirui, brief §5.7 and decision 7)

| Always, when AI is used | Only with `send_content` (on by default) | Never |
|---|---|---|
| For each selected item, up to 200 (beyond: counts per course and change): the course code or name, the path inside the course (or the semester), the change, the class, tags added and removed by name | For text and Word items: the changed lines (`+` and `-`) with one line of context, at most about 8,000 characters per file and 32,000 in all, items in list order until the budget is spent | Contents of other files (PDF, images, PowerPoint, Excel); unchanged text beyond one context line; items left out of the commit; absolute paths; the library's and the device's names; earlier commit messages |
| The metadata changes: tag names added and removed, which settings changed (not their values) | | |
| The description the user typed, at most 2,000 characters | | |

Building the excerpts is bounded too: at most 64 MiB read and 10 seconds in all, reusing the
workspace's diffs and extracted text where they exist; items beyond the bound are sent without an
excerpt.

### 12.4 The answer

From `choices[0].message.content`, after removing code fences and surrounding quotes, converting
line breaks to LF and removing other control characters: the first non-empty line, trimmed, is the
summary; the rest, without its leading and trailing blank lines and trailing white space, is the
body, or no body when nothing is left. A summary that still breaks remote-format.md §6.7 (over 256
characters) is a failure (`BadResponse`), never cut silently; so is a body over 16,384 characters.
The user can edit both fields before committing.

### 12.5 Failures

`NotConfigured` (off or no key), `Network` (name, connection or TLS), `Timeout`, `Rejected` (401,
403: the key), `RateLimited` (429), `Unavailable` (5xx), `BadResponse`, `Credential` (Credential
Manager failed). Each falls back to the template (§8.2). The diagnostics log records the endpoint's
host, the status, the duration and the sizes of request and response, never their content or the
key. The lane gets `/security-review` (network egress, secrets).

## 13. The catalog for M2

### 13.1 Tables

Derived from `.folio/local/` and the disk, like everything in the catalog (ADR-0002 §1); the
migrations are the real schema, and each M2 lane appends its own (§14).

| Table | Purpose | Lane |
|---|---|---|
| `packs` | Each local pack: name, size, object count | object store |
| `objects` | Object id → pack and offset, from the pack's index (§4.3); one location per object | object store |
| `head_files` | `HEAD`'s flattened tree: path, kind, hash (a folder's tree id), size, `stored`, paired entry id (`ON DELETE SET NULL`) | workspace |
| `commits` | `HEAD`'s chain: position (1 = first commit), id, parent, tree, kind, effective time (§5.4) and time, summary, body, device id and name, change count, `rebased_from`, pruned count | commit and history |
| `commit_changes` | Each change record (or, without `changes`, each difference of the trees), by commit position; indexed by path and by `from` | commit and history |
| `pruned` | Each blob a prune commit of the chain lists, with that commit's position: a version is pruned when its blob is not in `objects` and a later prune commit lists it (remote-format.md §7.5) | commit and history |
| `operations` | The operation log, by time | commit and history |
| `extracts` | Per file: the content hash its text was extracted from, and the status | text extraction |

`info` gains `history_head` (the `HEAD` the tables reflect) and `history_version` (the version of
the code that derives them; a new version rebuilds them, like `tokenizer_version`).

### 13.2 Rebuilding

When `history_head` differs from `HEAD`, `history_version` changed, or the catalog was rebuilt:
index every pack (header, trailer and index, §4.3), walk the chain from `HEAD`, fill `commits`,
`commit_changes` (from `changes`, or by diffing trees) and `pruned`, flatten `HEAD`'s tree into
`head_files` (pairing by path), and read the operation log. A catalog rebuild (ipc-m1 §13) includes
this. Ordinary commits, rewords and uncommits update the tables by their changes instead (§6.1,
§7.5).

## 14. Format versions M2 changes

ADR-0002 §3 froze v0.1's formats. M2 changes these, each with a migration, a migration test and a
fixture of the new version next to `v0.1/`, which keeps opening:

| Format | v0.1 | v0.2 | Why |
|---|---|---|---|
| Catalog schema (`user_version`) | 2 | 3 and up | §13: each M2 lane appends one migration in landing order; the gate records the last |
| `settings.json` | 1 | 2 | `device_id`, `device_machine` (§4.6) and `ai` (§12.1). The lanes that add them extend version 2 until v0.2 ships |
| Metadata `format_version` | 2 | 2 (unchanged) | Decisions 2–4 need no new field: the defaults stay, and thinning is fixed in code |
| Scan journal | 3 | 3 (unchanged) | — |
| Import intent | 1 | 1 (unchanged) | — |

New formats in v0.2, frozen with it: history format 1 (remote-format.md Part A, the local packs),
`HEAD` 1, operation log 1, history journal 1, restore journal 1. `gate/m2-acceptance` writes the
`v0.2/` fixtures with the v0.2 code, as the M1 gate did: a library with history (packs, `HEAD`, the
operation log with each operation), its catalog, `settings.json` 2, and a history journal and a
restore journal stopped between their steps; `format_fixtures.rs` opens them.

Going back is not supported. v0.1 refuses a newer `settings.json` without overwriting it
(library-state.md), so it no longer starts once v0.2 has run. The library itself would survive a
v0.1 run: v0.1 replaces a newer catalog (the catalog is derived) and leaves the `.folio/local/`
files it does not know alone, so v0.2 opens it again with its history.

## 15. Errors

| Core type | Variants |
|---|---|
| `store::StoreError` | `Io`, `Invalid` (what and why), `Newer`, `Missing` (an object), `Pruned` (a blob), `TooLarge` |
| `workspace::WorkspaceError` | `ReadOnly` (newer metadata), `Catalog`, `Meta` |
| `history::HistoryError` | `WorkspaceChanged` (fingerprint or base, §7.1), `NothingToCommit`, `FileChanged`, `NotLocal`, `Unreadable` (with `ReadFailure`: in use, denied), `NotHead`, `CannotUncommit`, `CannotReword`, `HistoryExists`, `NotFound`, `ReadOnly` (newer metadata), `Newer` (a newer history: read-only), `Damaged`, `Cancelled`, `Store`, `Io` |
| `diff::DiffError` | `NotStored`, `Pruned`, `NotLocal`, `Unreadable`, `Binary`, `TooLarge`, `Store` |
| `restore::RestoreError` | `NotStored`, `Pruned`, `NotLocal`, `InUse`, `Denied`, `NotRecyclable`, `DiskFull`, `FileChanged`, `Unchanged`, `ReadOnly`, `Store` |
| `ai::AiError` | §12.5 |

The shell maps them to IPC codes (§17.4): `Newer` and `StoreError::Newer` to `HistoryReadOnly`,
`Damaged`, `Missing` and `Invalid` to `HistoryDamaged`, `Unreadable` and `Io` by their I/O error
(ipc-m1 §16.2), and `Cancelled` to the job's cancelled state. `detail` strings are for logs
(library-core.md §7).

## 16. Tests

| Area | Tests |
|---|---|
| Format | Every file of `remote-format-vectors/v1/` (remote-format.md §12); property tests: encode then decode returns the same objects; a flipped byte anywhere in a pack is caught; a truncated pack is refused; large blobs stream in bounded memory |
| Workspace | Each item kind and readiness; binding; pairing through moves, saves through temporary files, case-only renames and a catalog rebuild; metadata changes and what unselected items hold back; fingerprints |
| Commit | Property: random edits, moves, deletions, tags and settings, then committing everything gives the disk's tree, and committing a random selection then the rest gives the same tree; `changes` always valid; files that change while read; `stored` under changed rules |
| Crash safety | A crash injected at every step of §7.5 and §11.4, then recovery: the history is whole or absent, the catalog matches `HEAD`, the log has each operation once, and no file is lost; a pack left zero-filled by a power loss is replaced, not trusted; a lost `HEAD` beside packs is reported, never restarted |
| Reword, uncommit | Later commits rewritten unchanged otherwise; uncommit returns the changes to the workspace; the first commit and prune commits refuse |
| History | Paging at 50,000 files and 1,000 commits; one file's history across moves and a folder rename |
| Diff | Encodings (UTF-8 with and without BOM, UTF-16, GBK), CRLF, binary detection, the limits and the deadline; Word paragraphs, tables, footnotes, tracked changes, formatting-only changes; a ZIP bomb and a DTD refused |
| Restore | Each target case of §11.2; the safety rule with committed and uncommitted current files, and with content only an uncommitted commit holds; a target saved between the check and the rename; Recycle Bin failure stops |
| AI | Against a local fake server: what is sent per §12.3 and nothing more, the caps, every failure of §12.5, no redirects, the key absent from logs and from every IPC response, and never sent to an endpoint it was not entered for |
| Thinning (M3) | The rule of §5.4 on synthetic histories: day and week boundaries, shared blobs, lines through moves, a version brought back after it was thinned, clocks that run ahead or behind |
| Fixtures | `v0.2/` (§14) opens; `v0.1/` still opens |
| E2E | Commit from the workspace, the first commit, reword and uncommit, restore, the AI fallback (fake endpoint) |

## 17. M2 contract outline (for `feat/ipc-m2-contract`)

The contract lane writes `docs/specs/ipc-m2.md` in the style of ipc-m1, declares every command
(ipc-m1 §3) and updates the fake shell. This outline fixes its shape.

### 17.1 `workspace.*`

| Command | Request → response |
|---|---|
| `get_workspace` | — → `WorkspaceSummary`: revision, fingerprint, `head` (id or null), totals per item kind and readiness, metadata change count, `historyState` (`none`, `starting`, `ready`, `readOnly`, `damaged`) |
| `list_workspace_items` | `{ page }` → `Page<WorkspaceItem>`, sorted by path; a bound item is one row with its parts (§6.3) |
| `list_metadata_changes` | `{ page }` → `Page<MetadataChange>` (§6.4) |
| `get_workspace_diff` | `{ key, page }` → `Diff` (§10) |
| `summarize_selection` | `{ selection, fingerprint }` → `SelectionSummary` (§6.6) |
| `commit` | `{ selection, fingerprint, base, summary, body }` → job id (kind `commit`); the result names the new commit |
| `start_history` | `{ summary }` → job id (§7.7) |

Event `WorkspaceChanged { revision, total, fingerprint, head }` (§6.5).

### 17.2 `history.*`

| Command | Request → response |
|---|---|
| `list_history` | `{ page, filter }` → `Page<HistoryItem>`: a commit or an operation (§9.1) |
| `get_commit` | `{ commit }` → `CommitDetail` |
| `list_commit_changes` | `{ commit, page }` → `Page<ChangeRow>` (§9.2) |
| `list_file_history` | `{ entry }` or `{ commit, path }`, `page` → `Page<FileVersion>` (§9.3) |
| `get_version_diff` | `{ commit, path, page }` → `Diff` |
| `reword_commit` | `{ commit, summary, body }` → the new id (§8.3); `CannotReword` for a prune commit |
| `uncommit` | `{ commit }` → null (§8.4); `NotHead`, `CannotUncommit` |
| `restore_version` | `{ commit, path }` → `{ target, recycled }` (§11); `FileChanged` when the target changed before it was replaced |

Event `HistoryChanged { head, revision }`. The `folio-file` scheme gains the version route (§9.4).

### 17.3 `ai.*`

| Command | Request → response |
|---|---|
| `get_ai_settings` | — → `{ enabled, endpoint, model, sendContent, hasKey }` |
| `update_ai_settings` | Any of `enabled`, `endpoint`, `model`, `sendContent` → the settings; an endpoint with another origin deletes the key (§12.1) |
| `set_ai_key` | `{ key }` → null: write-only; at most 512 characters |
| `clear_ai_key` | — → null |
| `test_ai` | — → null or an AI error: a minimal request |
| `generate_commit_message` | `{ selection, fingerprint, description }` → `{ summary, body }` (§12) |

Event `AiSettingsChanged`. The UI can set, test and clear the key, never read it.

### 17.4 Shared parts

- **Jobs:** kind `commit` (with `start_history`), progress in bytes, a cancellable result naming the
  commit. Thinning (M3) runs as the first step of a commit job (§5.4) and adds no kind.
- **Limits:** summary 256 and body 16,384 characters, AI description 2,000, key 512, selection keys
  `batch`, diff pages of 500 lines.
- **New codes:** `WorkspaceChanged`, `NothingToCommit`, `FileChanged`, `HistoryExists`, `NotHead`,
  `CannotUncommit`, `CannotReword`, `HistoryReadOnly`, `HistoryDamaged`, `NotStored`, `Pruned`,
  `Unchanged`, `SummaryEmpty`, `SummaryTooLong`, `SummaryInvalid`, `BodyTooLong`, `BodyInvalid`, and
  `AiNotConfigured`, `AiNetwork`, `AiTimeout`, `AiRejected`, `AiRateLimited`, `AiUnavailable`,
  `AiBadResponse`, `AiCredential`. Existing codes keep their meaning (`NotLocal`, `InUse`,
  `AccessDenied`, `DiskFull`, `NotRecyclable`, `ReadOnly`, `NotFound`, `Busy`, `FileSystem`,
  `Internal`).
- **Fake shell scenarios** (the lane's prompt, plus): a library before its first commit; a long
  history with imports and a prune commit; pruned versions; metadata changes; a bound item; a
  failed commit; a restore; a read-only history; AI unavailable.

## 18. Crates for `chore/build-deps-m2`

Selected on 2026-10-04 from the approved candidates. These maintained stable releases are all
at least a day old and not yanked (crates.io publication dates below are UTC). The workspace
requirements are exact, and `cargo update -p <crate> --precise <version>` pins each in Cargo.lock.
Existing locked package versions are retained; added transitive packages also meet the age rule.

| Need | Crate/version | Published | Licence | Features and rationale |
|---|---|---|---|---|
| zstd (remote-format.md §9.3) | [`zstd` 0.14.0](https://crates.io/crates/zstd/0.14.0) | 2026-09-04 | BSD-3-Clause (wrapper and bundled libzstd) | Defaults off; bundled libzstd 1.5.7 through `zstd-safe` 8.0.0 / `zstd-sys` 2.1.0+zstd.1.5.7. Safe streaming API, pledged size and 8 MiB window cap; uses the existing C compiler, without bindgen or CMake |
| Text diff | [`similar` 3.2.0](https://crates.io/crates/similar/3.2.0) | 2026-08-17 | Apache-2.0 | Defaults off; `std`, `text`, `inline`. Patience, deadlines (`std`) and inline changes without another diff engine |
| Word (`.docx`) | [`zip` 8.6.0](https://crates.io/crates/zip/8.6.0) | 2026-04-25 | MIT | Defaults off; `deflate-flate2-zlib-rs` only. Reuses the locked pure-Rust flate2/zlib-rs backend; unlike `deflate`, adds no zopfli encoder. Stored entries remain supported; other optional codecs and AES stay off |
| Word XML | [`quick-xml` 0.42.0](https://crates.io/crates/quick-xml/0.42.0) | 2026-08-22 | MIT | Defaults off; event reader, no Serde XML/DTD entity resolver. Reuses the version already locked by Tauri |
| Legacy encodings | [`encoding_rs` 0.8.42](https://crates.io/crates/encoding_rs/0.8.42) | 2026-09-24 | (Apache-2.0 OR MIT) AND BSD-3-Clause | Default `alloc` only; GB18030 (contains GBK) and UTF-16 per §10.2 |
| HTTPS for the AI call | [`ureq` 3.4.2](https://crates.io/crates/ureq/3.4.2) | 2026-09-13 | MIT OR Apache-2.0 | Defaults off; `rustls`, `platform-verifier`. Synchronous (ADR-0002 §4); rustls 0.23.45 with ring 0.17.14 and rustls-platform-verifier 0.7.1. No native TLS, aws-lc-rs, async runtime, gzip or ureq JSON helper; existing serde_json handles JSON |
| Credential Manager, `MachineGuid` | `windows-sys` 0.61.2 | Existing pin | MIT OR Apache-2.0 | Add only `Win32_Security_Credentials` and `Win32_System_Registry` to the core's Windows features |

Implementation notes for the feature lanes (this lane adds no parsing, store or network code):

- **Packs:** use `window_log(23)` and `set_pledged_src_size`, and `window_log_max(23)` for
  decoding. Call the fallible `Decoder::finish_frame()` before `finish()`; `finish()` discards
  its error. A window cap alone does not check exactly one frame, its dictionary, raw length or
  trailing bytes: enforce remote-format.md §9.3/§11 with the safe APIs re-exported as
  `zstd::zstd_safe` and the store's own validation.
- **Word:** explicitly reject `quick_xml::events::Event::DocType`; the event reader exposes it
  rather than refusing it. Reject encrypted ZIP entries (legacy ZipCrypto is built in). Entry
  count and expanded-byte limits remain the reader's job (§10.3); no macros or external process
  is needed.
- **AI:** build `TlsConfig` with `RootCerts::PlatformVerifier` explicitly. The supported `rustls`
  feature also includes webpki-roots (CDLA-Permissive-2.0), and ureq defaults to those roots;
  enabling the verifier feature alone does not select Windows trust. Disable redirects, enforce
  HTTPS, set the connect/global deadlines and cap response reads per §12.2. Platform certificate
  verification is synchronous with an OS retrieval timeout, so test the wall-clock bound in the
  AI lane. Keep TRACE logging off for ureq/ureq-proto, which can log wire data (§12.5).

API and feature sources: [zstd](https://docs.rs/zstd/0.14.0/zstd/),
[similar](https://docs.rs/similar/3.2.0/similar/), [zip features](https://docs.rs/crate/zip/8.6.0/features),
[quick-xml events](https://docs.rs/quick-xml/0.42.0/quick_xml/events/enum.Event.html),
[ureq TLS](https://docs.rs/ureq/3.4.2/ureq/tls/index.html).

Not needed: `blake3` already has `derive_key`; times in the one format of remote-format.md §6.2 and
hexadecimal need no crate; no encoding detector, because the preview's rule decides (§10.2).

## 19. The M2 lanes, checked

The lanes fit, with these proposed changes (for Sirui; this lane edits no other lane's entry):

1. **`feat/core-diff-restore` also waits for `feat/core-text-extract`.** Word diffs and text
   decoding use the extraction lane's `extract` module (§10.2–§10.3); one reader for search and
   diffs, not two.
2. **`feat/core-ai-message` waits for `feat/core-diff-restore`** (Sirui chose this on 2026-10-03).
   Its request lists the selected items (§12.3) and their changed lines, which need the workspace
   and the diff. One lane then owns everything that decides what leaves the machine, under one
   `/security-review`; the cost is one more step at the end of M2 (the AI settings page,
   `feat/ui-settings-ai`, still needs only the contract). The alternative not chosen: the AI lane
   starts as planned with the client, key, settings and prompt, and `feat/core-diff-restore` adds
   `generate_commit_message` with the digest; faster, but two lanes share the `ai` command group and
   the privacy review.
3. **A new lane `feat/core-retention` in M3** (ADR-0006): the thinning job, prune commits, local and
   remote compaction; after `feat/core-sync-round`, before `gate/m3-acceptance`. `docs/specs-sync`
   specifies remote compaction, and `test/core-sync-simulation` adds prune commits and pack deletion
   to its fake remote and invariants.
4. **`feat/core-commit-history`** also does the first commit (§7.7) and `settings.json`'s device id
   (§4.6); **`feat/ui-changes-view`** starts the first commit from an always-on registry control (the
   shell stays data-agnostic) and shows metadata changes without check boxes.
5. **`design/design-m2-details`** adds: metadata change rows, bound items, the first commit's
   progress, pruned versions ("not kept"), and the restore confirmation's Recycle Bin sentence.
6. **Catalog migrations** are appended in landing order; parallel lanes renumber when they rebase.
7. **`gate/m2-acceptance`** writes the `v0.2/` fixtures (§14) and checks the golden vectors and the
   targets of §2.
8. **`feat/core-object-store`** passes every file of the golden vectors (remote-format.md §12) in
   its own tests; `pnpm check` already keeps the vectors equal to their generator
   (`check:vectors`, added by this lane).

With change 2 the critical path becomes `feat/ipc-m2-contract` → `feat/core-object-store` →
`feat/core-workspace` → `feat/core-commit-history` → `feat/core-diff-restore` →
`feat/core-ai-message` → `gate/m2-acceptance`; `feat/core-text-extract` runs beside the first three,
and the UI lanes work on the fake shell from the contract on.

## 20. Changes to earlier documents

- **ADR-0003:** the refinements of remote-format.md §14, applied when Sirui approved (2026-10-03).
- **ADR-0006:** new (retention), accepted 2026-10-03.
- **Brief:** §5.4–§5.7 record decisions 1, 4, 5, 6 and 7 (v0.4); §5.6 lists thinning among the
  record types; §12's constraints 1 and 3 note thinning, the one exception to an append-only remote
  and to keeping every Word version.
- **ADR-0002 §3:** the gate records the versions v0.2 freezes (§14).
- **System overview:** §2's `versioning` module is this spec's `store`, `workspace`, `history`,
  `diff` and `restore`; §7's conflict-copy row follows remote-format.md §10.1.
- **Testing strategy:** golden vectors live in `docs/specs/remote-format-vectors/`, and `pnpm check`
  regenerates them (`check:vectors`).
