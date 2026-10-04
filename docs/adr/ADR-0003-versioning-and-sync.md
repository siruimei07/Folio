# ADR-0003: Versioning and sync format

- **Status:** Accepted (Sirui, 2026-09-26). Refined on 2026-10-03, when Sirui approved
  [`remote-format.md`](../specs/remote-format.md), whose §14 lists the refinements, and
  [ADR-0006](ADR-0006-history-retention.md).
- **Date:** 2026-09-26
- **Deciders:** Sirui Mei
- **Inputs:**
  - [`docs/product/brief.md`](../product/brief.md) §4, §5.4–§5.6, §12;
  - [`docs/specs/system-overview.md`](../specs/system-overview.md);
  - [ADR-0001](ADR-0001-application-stack.md), [ADR-0002](ADR-0002-data-storage.md);
  - research on iCloud for Windows and the Rust crates involved, 2026-09-26 (key sources at the end).

## Context

### What the product needs (brief)

- **History.** One linear history for the library, with no branches.
- **Two tiers.**
  - Text files and Word documents keep every version.
  - Every other file records events only (added, modified, deleted, moved), without old content.
- **Remote.** A plain folder in iCloud Drive holding two things:
  - a browsable copy of the library that iPhone, iPad and Mac can open and edit;
  - the hidden history.
- **Sync.** On the user's click: pull, then push.
  - Edits made directly in the remote are detected and imported.
  - Conflicts follow brief §5.5.
- **Safety.** Nothing is lost silently; replaced or deleted files go to the Recycle Bin.
- **A future Swift app.** It must read and write the same remote.

### What iCloud for Windows actually does

| # | Fact (research, 2026-09-26) | Consequence for the design |
|---|---|---|
| 1 | No locks; eventual consistency; no ordering between files. A small file can arrive before a large one, and uploads have stalled for days | Nothing may depend on locks or arrival order. "Not arrived yet" is a normal state, not an error |
| 2 | Concurrent changes to one file end in a silent winner or in conflict copies, whose names on Windows are inconsistent: `name 2`, `name (1)`, `name（2）`, `name(01)` | No two writers may ever write the same file in the history area |
| 3 | Writing a temp file and then renaming it over the original inside iCloud Drive on Windows can leave the temp file behind and delete the original (Excel reports) | Folio writes in a staging folder outside the sync root and publishes with a single rename |
| 4 | Files are cloud-files placeholders. Files over 1 MB stay cloud-only until opened, and reading one blocks until it has downloaded. Background reads raise a toast that lets the user block the app. Any app may pin or unpin files (`CfSetPinState`) | Pin the history folder. Never read a mirror placeholder unless the content is actually needed |
| 5 | Modification times have 1-second resolution, folder times get reset, and times change without content changes. Changing a time locally marks the file as modified | Never trust mtime. Never touch timestamps or attributes inside the sync root |
| 6 | Names from Apple devices may arrive in NFD, and NTFS can hold NFC and NFD twins side by side. Names invalid on Windows reportedly never reach Windows. Some names are never synced at all (`.nosync`, `.tmp`, `~$…`) | Normalise to NFC on import and detect twins. Folio's own files avoid the skipped patterns and zero-byte files |
| 7 | Deleting a downloaded file on Windows sends it to the Recycle Bin, and iCloud keeps deletions in Recently Deleted for 30 days | Folio deletes through the shell, so both safety nets apply |
| 8 | Tens of thousands of files are slow for iCloud for Windows (a report of days to count 50,000 files). Git and SQLite stored in iCloud are known to corrupt. Hard links into the sync root are not allowed | The history is a few large immutable files, with no database and no Git in the remote. The mirror costs a real second copy |
| 9 | The development machine runs iCloud for Windows 13.4 (x86); the current Microsoft Store version is 15.x | Update the client before real-iCloud tests |

## Decision

### 1. A custom content-addressed history, not Git

Folio keeps its own history format. It is modelled on Git's objects but designed for an eventually
consistent folder. Options considered explains the choice.

### 2. Object model

- **Content hash.** The BLAKE3-256 hash of a file's raw bytes, written `b3:<64 hex digits>`. It is
  used for every file in trees, in the catalog (ADR-0002), and to verify the mirror.
- **Blob.** The raw bytes of a stored file version. Its id is its content hash.
- **Tree.** One directory: entries in ascending byte order of name, each `{name, kind: file|dir,
  hash}`, and for a file also `size` and `stored`.
  - `hash` is the content hash of a file, or the id of a subtree.
  - `stored` says whether the version's blob is kept. It is true for text and Word files under the
    size limit, by the rules in the same commit's `.folio/library.json`, and for every file under
    `.folio/`, so equal content under equal rules gives equal trees.
- **Commit.** Its fields:

  | Field | Meaning |
  |---|---|
  | `parent` | Previous commit; left out on the first |
  | `tree` | Root tree |
  | `device` | `{id, name}` of the device that made it |
  | `time` | UTC, `YYYY-MM-DDTHH:MM:SSZ` |
  | `kind` | `commit`, `import` (direct edits found in the remote) or `prune` (thinning, ADR-0006) |
  | `summary`, `body` | The commit message: a one-line summary and optional details, the two fields of the commit box |
  | `changes` | Optional: `{op: add|modify|delete|move, kind: file|dir, path, from?, old?, new?}` per change, where `old` and `new` are `{hash, size, stored}`. Folders have records, and a folder move covers what moved with it |
  | `rebased_from` | Optional; the commit this one was rebased from |
  | `pruned` | Prune commits only: the blobs thinned out |

  `changes` duplicates what the trees already say. It is kept so the history view is fast and moves
  are recorded, and readers check that it matches (remote-format.md §8).
- **Encoding.** Trees and commits are canonical JSON, the RFC 8785 subset of remote-format.md §5:
  UTF-8, keys sorted by byte order, no insignificant whitespace, no `null`, integers from 0 to
  2^53 − 1 only, at most 16 levels deep. Their ids use BLAKE3's `derive_key` mode with the contexts
  `folio tree v1` and `folio commit v1`, so a tree or commit id can never equal a blob id.
- **Paths and names.** Unicode NFC, `/` as separator, valid on Windows, at most 32,767 UTF-16 code
  units per path.
  - Trees cover the whole library, including the `.folio/` metadata files (ADR-0002);
    remote-format.md §7.4 fixes what `.folio/` may hold.
  - They exclude `.folio/local/` and ignored files.
- **Local operation log.** Sync, reword and uncommit events in the history view come from
  `.folio/local/oplog.jsonl`, not from commits.

### 3. Packs

- Objects live only in packs, never one file per object. This keeps iCloud's file count low.
- **Layout**, in order, with little-endian fields of fixed width (remote-format.md §9):
  1. Header: magic `FOLIOPK1` and the format version.
  2. Records: type, flags, id, raw length, stored length, payload. The payload is compressed with
     zstd at level 3, except for already-compressed formats such as `.docx`. A frame fits an 8 MiB
     window and decodes to exactly the raw length.
  3. Index: ids in sorted order, with their offsets.
  4. Trailer: the number of index entries, an end magic, and the BLAKE3 hash of every byte before
     the hash, the count included.
- A pack's file name is its trailer hash, so every pack verifies itself.
- **Local store:** one or more packs per commit. **Remote store:** one or more packs per push; a
  push may carry several commits. A large Word version gets a pack of its own, so thinning can
  delete it whole (ADR-0006).
- Which pack and offset holds each object is recorded in a derived table in the catalog
  (ADR-0002). It can be rebuilt from the pack indexes.
- No deltas between objects in v1.

### 4. Local store

`<library>/.folio/local/` is never synced by any client.

```text
.folio/local/
  packs/<hash>.pack   one or more per commit
  HEAD                local head commit id (replaced atomically)
  remote.json         last integrated canonical head and its Lamport value
  oplog.jsonl         local operation log (sync, reword, uncommit, restore)
  journal/            journals of in-progress commits and syncs
  staging/            temporary files for atomic writes
```

### 5. Remote layout

```text
<remote>/                                  a folder inside iCloud Drive
  2026 秋/线性代数/第3讲.pptx              mirror: the library tree, browsable
  .folio/library.json, tags.json, meta/…   mirror of the tracked metadata files
  .folio/store/                            history area (not part of any tree)
    FORMAT.json                            written once: format version, library id
    packs/<hash>.pack                      immutable
    intents/<device-id>/<seq>.json         immutable: mirror writes about to happen
    heads/<device-id>/<seq>.json           immutable: one head record per push
```

Rules for `.folio/store/`:

- **Write once.** Every file is written once and never modified or renamed in place. Packs are the
  only files ever deleted: after thinning, under remote-format.md §10.1 (ADR-0006, which replaces
  "v1 has no remote garbage collection").
- **Device-owned paths.** Each device writes only under its own device id, and its intents and head
  records share one counter. No two writers ever touch the same path, so iCloud has nothing to turn
  into a conflict copy.
- **Single-rename publishing.** A file is written in a staging folder outside the sync root on the
  same NTFS volume, flushed, and moved into place with one rename.
- **Safe names.** Names avoid the patterns iCloud skips (`.tmp`, `.nosync`, `~$…`) and there are
  no zero-byte files.
- **Pinned.** Folio pins `.folio/store/` ("Always keep on this device"). iCloud then downloads
  packs on its own, and reading them never triggers a download toast.
- **Library check.** `FORMAT.json` must name the same library id as the local
  `.folio/library.json`. A remote can only be created in an empty folder.

A head record:

```json
{
  "format_version": 1,
  "library_id": "3f2c…",
  "device": { "id": "8c1e…", "name": "G16" },
  "seq": 42,
  "lamport": 97,
  "head": "b3:4f0a…",
  "intent": 42,
  "packs": [{ "name": "9d2c….pack", "size": 18231 }],
  "time": "2026-09-26T23:41:07Z"
}
```

### 6. Canonical head: one linear history without a coordinator

- **Lamport value.** Each head record's Lamport value is 1 plus the largest Lamport value the device
  has seen.
- **Canonical head.** The head record with the greatest (Lamport, device id) that is complete:
  every object reachable from its head is present and verified in some pack, or pruned, wherever it
  is (remote-format.md §10.3). A record whose objects have not arrived yet is *pending*, never an
  error.
- **Pushing.** A device pushes only commits that sit on top of the canonical head it has
  integrated.
- **Simultaneous pushes.** Two devices pushing at the same moment get the same Lamport value, and
  the tie-break picks one. The other device finds at its next sync that its commits are not
  canonical. It rebases them onto the canonical head, recording `rebased_from`, and pushes again.
  Commits that become empty during a rebase are dropped; this happens when two devices import the
  same iPad edit.
- **Only the author rebases.** A device rebases only its own commits. Commits from a device that
  never comes back stay in the store, where their stored versions remain recoverable, and the sync
  status reports them. Their mirror writes are protected by the import rule in §7.

### 7. Mirror rules

**Base records**
- Each device keeps a base record per mirror path in its catalog: content hash, size and NTFS file
  id. It is the state the device last wrote or verified.
- Enumeration with `FileIdExtdDirectoryInfo` gives size, file id and placeholder state without
  opening any file.

**Classifying a mirror file that differs from its base.** Folio hashes it. Reading downloads it,
which is expected: a real change has to come down anyway. Then:

| Result | Meaning | Action |
|---|---|---|
| Matches the canonical tree | Already in sync | Nothing |
| Matches an older version of that path, or a write listed in a recent intent | Another device's push is still arriving | Mark pending and wait |
| Anything else, once unchanged for a settle period (initially 2 minutes) | A direct edit from iPad, Mac or iCloud.com | Import it |

- Imports become a `kind: import` commit on top of the canonical head, attributed to `iCloud`.
- New files named like iCloud conflict copies (`name 2`, `name (1)`, `name（2）`, `name(01)`) are
  imported and flagged.
- Placeholders whose metadata still matches the base are never read.

**Import before overwrite**
- A push writes a mirror path only if the file still matches its base record or already holds the
  new content. Otherwise the sync round starts over with the import. This is the same rule as
  git-annex export.
- Pushes write mirror files by a single rename from the staging folder. The iCloud test harness
  (Action item 4) settles whether an existing file is replaced by renaming over it or by first
  moving the old copy to the Recycle Bin.

**Other rules**
- Deletions go through the shell (Recycle Bin), so iCloud's 30-day Recently Deleted also applies.
- Folio never changes timestamps or attributes inside the sync root.
- **Free up space** is on by default and can be turned off. After a verified push, mirror files are
  unpinned in batches of about 50 so iCloud can dehydrate them. `.folio/store/` stays pinned.
- **Names.**
  - Imports normalise names to NFC.
  - NFC/NFD twins and case-only twins are reported as conflicts.
  - A name that is invalid on Windows is skipped with a warning.
  - The default ignore rules include the patterns iCloud does not sync.
- **Untrusted input.** Everything read from the remote is treated as untrusted and validated before
  it touches the library:
  - pack hashes;
  - record and JSON schemas;
  - paths (no `..`, no absolute paths, no Windows reserved names).

### 8. One sync round

The order of steps matters, both for crash safety and for readers on other devices.

1. **Fetch.** List `.folio/store/`, verify and index new packs, and find the canonical head.
   Pending records are waited for, not failed.
2. **Import direct edits** (§7) as a commit on top of the canonical head.
3. **Integrate.**
   - Rebase local unsynced commits onto the result. Uncommitted changes stay in the working tree.
   - Paths changed on both sides go through the merge rules (§9).
   - An open conflict pauses the round, in a resumable state, until the user decides.
4. **Materialise.**
   - Stored files come from packs.
   - Other files are copied from the mirror after their hash is checked.
   - Local files that will be replaced or deleted go to the Recycle Bin first.
   - A file whose mirror copy has not arrived stays **pending**: it is shown in the UI, excluded
     from change detection, and filled in later. HEAD still advances.
5. **Push**, when there are local commits:
   1. publish the packs;
   2. publish an intent listing the mirror writes;
   3. write the mirror files (§7);
   4. publish the head record **last**.

   The head record is the commit point. Readers ignore anything it does not reference.
6. **Finish.** Record the new base records and remote state, clear the journal, and unpin the
   pushed mirror files.

Every step is idempotent and journalled. After a crash, the journal resumes or rolls back the round.

### 9. Merge rules (paths changed on both sides)

| File | Rule |
|---|---|
| Text (stored) | Line-based 3-way merge against the common version from the store. A clean merge applies automatically; otherwise the user chooses keep local, keep remote, or keep both |
| Word (stored) | No automatic merge; the user chooses |
| Other files | Keep both; the remote copy gets a `（云端）` suffix |
| `.folio/**/*.json` metadata | Structural merge. Tag sets per path combine additions and removals from both sides. For a conflicting scalar field (colour, abbreviation, order, tag name) the later commit time wins; a tie goes to local |
| `.folio/ignore` | Union of lines |
| Delete vs modify | Keep the modified file, and report it |
| Rename vs modify | Apply both |
| Renamed differently on each side | Keep the local name, and report it |

Text merges use `diffy` (diff3) behind a `TextMerge` interface. `gix-merge` or `similar`'s
`TextMerge` can replace it later, for example to merge Chinese paragraphs, often written as one long
line, at a finer granularity.

### 10. Local change detection (feeds the workspace)

- **Watcher.** A thin watcher on `ReadDirectoryChangesExW` (NTFS only) with a large buffer, rename
  pairing by file id, and a full rescan on overflow. Periodic reconciliation scans use
  `FileIdExtdDirectoryInfo`.
- **NTFS.** The library must be on NTFS. On any other file system Folio falls back to plain
  `ReadDirectoryChangesW` and scans more often.
- **Hashing.** A file is re-hashed only when its size or file id changes or a scan flags it. Mtime is
  only a hint.
- **Renames.** Paired by file id, confirmed by hash. Tag assignments move with the renamed file in
  the same commit.
- **Ignore rules.** `.folio/ignore` is evaluated with the `ignore` crate's `Gitignore`, one per
  directory, plus Folio's own evaluation up the ancestor chain. Global Git excludes are not used.

### 11. Crash safety

- **Commit.** Write the packs in `staging/`, record the operation in a journal, rename the packs
  into `packs/`, then replace `HEAD`, the commit point (versioning.md §7.5).
- **Sync.** The journal records the round's plan and each completed step. Remote writes are either
  content-addressed or device-owned, so repeating them is harmless.

### 12. iCloud integration

- Find the iCloud Drive path at runtime through `StorageProviderSyncRootManager`. Require NTFS and a
  running iCloud client.
- A remote outside any sync root is allowed but untested, and Folio says so.
- At start-up, call `RtlSetProcessPlaceholderCompatibilityMode(PHCM_EXPOSE_PLACEHOLDERS)` so
  placeholder attributes are visible.
- Pin and unpin with `CfSetPinState`; never call `CfDehydratePlaceholder`.
- A missing pack, a blocked read and a stalled upload all appear in the UI as "waiting for iCloud",
  together with the items being waited on.

### 13. Format documentation and compatibility

- `docs/specs/remote-format.md` is the normative, language-neutral spec, with golden test vectors in
  the repository. It covers canonical JSON, the BLAKE3 contexts, the objects, the pack layout, zstd
  frames and the remote's records; the mirror rules belong to `docs/specs/sync.md`. It is written
  before M2, because the local store uses the same objects and packs.
- Each part of the format has its own version, which a reader reads first: the pack header,
  `FORMAT.json` and every record carry one (remote-format.md §3). Readers are strict within a
  version, every change raises it, and writers write the lowest version a file needs. Newer data is
  not interpreted: a newer pack makes the local history read-only, and a newer remote file makes the
  remote read-only; both prompt for an update.
- A Swift app can use the official BLAKE3 C code and facebook/zstd's Swift package, or reuse
  `folio-core` through UniFFI (ADR-0001).

## Options considered

### History engine

| Option | Verdict |
|---|---|
| Git bare repository in iCloud Drive | Rejected. Git's shared, mutable refs, packed-refs and index files are exactly what iCloud duplicates (`refs/heads/main 2`) and corrupts. Binary files would bloat it. Sirui chose a browsable remote over a Git remote |
| Git locally, plus one bundle file per push | Considered: bundles are immutable single files. Rejected: event-only binaries would need pointer files and clean/smudge filters; course folders often contain their own Git repositories; ordering heads over iCloud would still be custom work; a Swift app would need libgit2 |
| CRDT library (Automerge) | Rejected. Its model is merging documents; binary files and a browsable tree do not fit |
| **Custom store: content-addressed packs plus per-device head records (chosen)** | Fits both tiers exactly, has a small documented format, and every remote write is immutable |

### Coordination on the remote

| Option | Verdict |
|---|---|
| Shared `HEAD` file | Rejected: two writers produce iCloud conflict copies |
| Lock file | Rejected: locks are only advisory on eventually consistent storage (restic, Joplin) |
| **Per-device immutable head records with Lamport ordering (chosen)** | No shared writes, a deterministic canonical head, and tolerance of delays |

### Object granularity on the remote

| Option | Verdict |
|---|---|
| One file per object | Rejected: tens of thousands of small files slow iCloud for Windows down badly and create more partially-arrived states |
| **Packs: one or a few per push (chosen)** | Few files. A push arrives as its packs plus one head record |

### Mirror updates

| Option | Verdict |
|---|---|
| Overwrite the mirror blindly | Rejected: silently destroys edits made on iPad or Mac |
| **Verify against the base record, import first, then write (chosen)** | No silent overwrites (the git-annex export rule) |

## Trade-off analysis

- **Custom format versus Git.** The custom format costs specification and testing effort, but each
  part is small. The rules that matter are few and testable:
  - files are immutable and owned by one device;
  - the head record is published last;
  - imports happen before overwrites.

  Git would bring mature merging but none of the iCloud safety, and adds nested-repository and
  pointer-file complexity.
- **Latency versus correctness.** Folio never trusts arrival order or timestamps. It therefore
  sometimes waits (pending packs, pending mirror files) instead of acting on partial data, and the
  UI shows what it is waiting for.
- **Storage.**
  - Every Word version is stored whole, since `.docx` is already compressed.
  - Every text version is stored with zstd, without deltas.
  - The mirror is a second full copy of the library, because hard links are impossible in the sync
    root. Unpinning mirror files after a push mitigates this.
  - The number of packs grows with every push; compaction comes later, with thinning (ADR-0006).
- **What Folio cannot fix.** iCloud's slowness with many files, stalled uploads, and conflicts that
  Apple devices resolve silently among themselves before Folio sees them. Folio's history protects
  everything Folio has seen, and its status shows what is still in flight.

## Consequences

**Easier**
- The remote is always safe to read, because nothing in the history area is ever rewritten.
- The protocol can be simulated completely, so tests are deterministic.
- A Swift app can implement the documented format, or reuse the Rust core.

**Harder**
- We write and maintain our own format, merge glue and watcher.
- Simulation and crash-injection test infrastructure is required, not optional.
- Some states mean "waiting for iCloud" and need clear UI.

**Revisit when**
- There are more than about 1,000 packs, or the remote store grows large. Then add compaction: new
  packs, tombstones, and deletion only after a grace period of at least 30 days (the kopia and
  Duplicacy pattern).
- Word history grows too large. Then consider a retention policy (decided ahead of time: ADR-0006,
  2026-10-03).
- Real-iCloud tests contradict an assumption, such as conflict naming or how replaced files behave.
- A second Folio device is used regularly. Then add merging of orphaned commits from absent devices.

## Action items

1. [x] Sirui approves; set Status to Accepted. Sirui also confirmed that free up space is on by
   default (2026-09-26).
2. [x] Before M2, write `docs/specs/remote-format.md` with golden test vectors (approved by Sirui on
   2026-10-03; its §14 refinements are applied above).
3. [ ] Before M3, build the sync simulation harness.
   - **The fake remote** is an eventually consistent folder that simulates:
     - per-file delays and reordering;
     - head records that arrive before their packs;
     - conflict copies in every observed naming pattern;
     - NFD names;
     - placeholders that block;
     - silent overwrites;
     - stalls that last days.
   - **The actors** are two Folio devices plus an "iPad" writer, running random operation
     sequences, with a crash injected at every journal step.
   - **Invariants:**
     - nothing that was ever canonical is lost: it is stored in a pack, or present in the library,
       the mirror or the Recycle Bin, unless a prune commit lists it and each device's own
       evaluation agrees (ADR-0006);
     - devices converge after quiet periods;
     - no direct edit is ever silently overwritten;
     - there is one linear canonical history.
4. [ ] Run a real-iCloud test plan on client 15.x, manual or semi-automated. It must answer:
   - how conflict copies are named, for edits and for new files;
   - how an update reaches a downloaded file, and whether watchers see it;
   - what happens to NFD names and to names invalid on Windows;
   - how case-only renames behave;
   - whether remote deletions reach the Recycle Bin;
   - whether new files in a pinned folder inherit the pin;
   - latency and ordering between a head record and a large pack;
   - renaming over an existing mirror file versus deleting it first and then moving the new file in.
5. [ ] Sirui: update iCloud for Windows on the development machine from 13.4 to the current
   Microsoft Store version before item 4.
6. [x] Update system overview §3 and §7.

## Key sources

- Apple, keep files downloaded / free up space in iCloud for Windows:
  <https://support.apple.com/guide/icloud-windows/keep-files-downloaded-icw8531ad6b7/icloud>
- Apple, deleted files in iCloud for Windows: <https://support.apple.com/en-us/121314>
- Apple TN2336, iCloud conflicts:
  <https://developer.apple.com/library/archive/technotes/tn2336/_index.html>
- Microsoft, `CfSetPinState`:
  <https://learn.microsoft.com/en-us/windows/win32/api/cfapi/nf-cfapi-cfsetpinstate>
- Microsoft, building a cloud sync engine (placeholder visibility):
  <https://learn.microsoft.com/en-us/windows/win32/cfapi/build-a-cloud-file-sync-engine>
- Obsidian on iCloud Drive for Windows: <https://obsidian.md/help/sync-notes>
- Git repository in iCloud Drive (`refs/heads/main 2`):
  <https://architchandra.com/articles/a-side-effect-of-storing-a-git-repository-in-icloud-drive>
- Excel safe-save in iCloud Drive on Windows: <https://discussions.apple.com/thread/255997623>
- 50,000 files in iCloud for Windows: <https://discussions.apple.com/thread/253313383>
- kopia on eventually consistent storage: <https://github.com/kopia/kopia/issues/1090>
- git-annex export (import before overwrite): <https://git-annex.branchable.com/git-annex-export/>
