# Windows adapter: file ids, the Recycle Bin and the watcher

System design for the three lanes after [library scan](library-scan.md): the OS adapters that
`folio-core` reaches Windows through ([ADR-0001](../adr/ADR-0001-application-stack.md), system
overview §2). Decisions stay in the ADRs; this spec fixes the details they leave open, and records
what Windows actually reported on Sirui's machine (Windows 11 build 26200, 2026-09-27).

- Status: draft, 2026-09-27 (lane `feat/core-windows-fs`; stack `feat/core-windows-fs` →
  `feat/core-windows-recycle-bin` → `feat/core-windows-watcher`).
- Inputs: [library core](library-core.md) §10 item 3; [library scan](library-scan.md) §3, §6.4,
  §8, §12 item 1; [ADR-0003](../adr/ADR-0003-versioning-and-sync.md) §7, §10, §12;
  [system overview](system-overview.md) §2, §3, §6.
- Section 10 lists what this spec adds to or changes in earlier documents.

## 1. Scope

| Lane | Delivers |
|---|---|
| `feat/core-windows-fs` | `WindowsFileSystem`: listings through `FileIdExtdDirectoryInfo`, NTFS file ids, placeholder and offline states, NTFS detection and the fallback off NTFS; hashing that never reads a file whose content is not on this disk; the scan benchmark on NTFS with both adapters |
| `feat/core-windows-recycle-bin` | `RecycleBin` (trait), `WindowsRecycleBin`, a fake on `MemFs` |
| `feat/core-windows-watcher` | `Watcher` (`ReadDirectoryChangesExW`), renames paired by file id, a full rescan on overflow, debounced scoped scans through `Library::rescan` |

Later lanes: the shell's jobs and events around these adapters; library operations that delete
through the Recycle Bin; the Cloud Files API (placeholder compatibility mode at start-up, pinning,
ADR-0003 §12); watching the remote (sync lane).

Constraints (Sirui, 2026-09-27): only `folio-core` and its docs change. Win32 goes through
`windows-sys`; COM through the `windows` crate's workspace entry that WP-03 adds, so the Recycle
Bin lane lands after WP-03. Unsafe code follows `search/fts5.rs` (§9).

## 2. Modules

| Module | Owns | Unsafe |
|---|---|---|
| `fs` | `FileSystem`, `Metadata` with `Presence`, `StdFileSystem` | No |
| `recycle` | `RecycleBin`, `RecycleError` | No |
| `watch` | `Record`, `Rescan`, the coalescer, `WatchOptions` | No |
| `library` | `Library::rescan`; hashing skips files not on this disk | No |
| `win` (Windows only) | Declares the submodules below and re-exports their types | No |
| `win::handle` | Opening files and folders as handles, typed file information, `Volume` | Yes |
| `win::files` | `WindowsFileSystem` | Yes |
| `win::dir_info` | Parses `FILE_ID_EXTD_DIR_INFO` buffers; attribute rules | No |
| `win::recycle` | `WindowsRecycleBin` | Yes |
| `win::watcher` | `Watcher`: its thread and overlapped reads | Yes |
| `win::notify` | Parses `FILE_NOTIFY_EXTENDED_INFORMATION` and `FILE_NOTIFY_INFORMATION` buffers | No |

The traits and all logic that needs no Windows API (the coalescer, record parsing, attribute
rules) are plain Rust and tested with byte buffers and fakes. `win` compiles only on Windows; its
parsers use `OsString::from_wide`, the rest is FFI.

```text
 shell (later lane)
   │  WindowsFileSystem::open(root) ─────────────┐
   │  Library::new(root, Arc<WindowsFileSystem>) │ has_file_ids()
   │  Watcher::start(root, file_ids, options, sink)
   │        │ thread: ReadDirectoryChangesExW → win::notify → watch coalescer
   │        └──► sink(WatchEvent::Rescan(..)) ──► job queue ──► Library::rescan(catalog, ..)
   │                                                               └──► Library::scan(scope)
   └─ delete: WindowsRecycleBin.recycle(path) ──► scoped scan (or the watcher sees it)
```

## 3. File-system adapter

### 3.1 Presence

`Metadata` gets `presence: Presence`, whether a file's content is on this disk:

| Attributes | `Presence` |
|---|---|
| `FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS` or `FILE_ATTRIBUTE_RECALL_ON_OPEN` | `Placeholder`: a cloud placeholder (OneDrive, iCloud); reading it downloads it first |
| `FILE_ATTRIBUTE_OFFLINE` without those | `Offline`: in offline storage; reading it may be slow or fail |
| Anything else | `Local` |

- Measured in `C:\Users\sirui\iCloudDrive`: a cloud-only file reads `0x00401620` in a
  placeholder-aware process (PowerShell) and `0x00400020` in a default one, which is what Folio
  is until the shell sets the compatibility mode (ADR-0003 §12). `RECALL_ON_DATA_ACCESS` is there
  in both, so presence does not depend on that mode. Opening the files for their attributes
  (§3.2) downloaded none of them.
- `StdFileSystem` reports presence too on Windows, from the attributes std exposes; elsewhere
  everything is `Local`.
- Presence is not stored in the catalog, and a change of presence does not make an entry
  modified: freeing up space changes no content. A "only in the cloud" badge needs it in the
  catalog later.

### 3.2 `WindowsFileSystem`

```rust
pub struct WindowsFileSystem { /* volume, file_ids */ }
impl WindowsFileSystem {
    /// The adapter for the library at `root`. Fails when `root` cannot be opened.
    pub fn open(root: &Path) -> io::Result<Self>;
    pub fn volume(&self) -> &Volume;
    pub fn has_file_ids(&self) -> bool;
}
pub struct Volume {
    pub file_system: String, // "NTFS", "exFAT", …
    pub local: bool,         // a drive of this computer
}
impl Volume {
    /// Local NTFS: file ids and extended change records.
    pub fn is_local_ntfs(&self) -> bool;
}
```

`open` opens `root` (following a link there, as std does: a library root may be a junction),
reads the file system's name (`GetVolumeInformationByHandleW`) and whether the volume is local:
the handle's final path starts with a drive letter whose type is not `DRIVE_REMOTE`. A UNC path,
or anything else, counts as not local. It then decides once whether the library gets file ids
(`has_file_ids`): on local NTFS whose root it can list as below, since some file systems call
themselves NTFS without these listings. `read_dir` and `metadata` both follow that decision, so
a listing and the file it lists always agree on whether there is an id; the hashing pass compares
the two.

**With file ids:**

- `read_dir` opens the folder with `FILE_LIST_DIRECTORY`, sharing reading, writing and deletion,
  and `FILE_FLAG_BACKUP_SEMANTICS`, then calls `GetFileInformationByHandleEx` with
  `FileIdExtdDirectoryRestartInfo` and then `FileIdExtdDirectoryInfo` into a 64 KiB buffer (one
  per thread, reused) until `ERROR_NO_MORE_FILES`. No file is opened. Each record gives the name,
  attributes, reparse tag, `EndOfFile`, `LastWriteTime`, `CreationTime` and the 128-bit file id;
  `.` and `..` are skipped.
- **Kind**, as std decides it: a reparse point whose tag is a name surrogate (symbolic link,
  junction, WSL link) is a `Link`; an `AF_UNIX` socket is `Other` (std calls it a file, and reading
  it would fail on every hashing run); a directory is a `Folder`; the rest is a `File`.
- **Times** are FILETIMEs converted the way std converts them (`(t − 116444736000000000) × 100`
  nanoseconds, `None` outside `i64`), so both adapters report the same times.
- `metadata` opens the path with `FILE_READ_ATTRIBUTES` only and
  `FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT` (a link is never followed), then
  makes one query, `GetFileInformationByHandle`: attributes, times, size, the volume's 32-bit
  serial number and the 64-bit file index. It asks for the reparse tag only on a reparse point.
  The file id is the file index with the serial number `open` read from the root; a handle on
  another volume (its 32-bit serial number differs) gets that volume's own from `FileIdInfo`.
  Measured: the same id and times as the listing.
- `open` is std's `File::open`, as in `StdFileSystem`.

**Without file ids** the adapter behaves like `StdFileSystem`:

| Volume | Why no ids |
|---|---|
| exFAT, FAT32 | No stable ids. Measured on `I:` (exFAT): `FileIdExtdDirectoryInfo` and `FileIdInfo` fail with `ERROR_INVALID_PARAMETER` |
| Network shares | The server makes the ids up: Samba reports `NTFS` and uses inode numbers, which come back right after a delete (library scan §3) |
| ReFS (Dev Drive) | Stable 128-bit ids, but ADR-0003 §10 names NTFS; revisit (§11) |

The shell can show `volume()` and `has_file_ids()` to say why renames made outside Folio lose
their tags there (ADR-0003 §10: "The library must be on NTFS").

**Opening.** Folders and files are opened through std's `OpenOptions` with an access mode and
flags, then kept as `OwnedHandle`s: std opens only what exists, shares reading, writing and
deletion, and passes paths longer than `MAX_PATH` in verbatim form. Whether the volume is local
comes from `std::fs::canonicalize(root)`, whose prefix is a drive letter or a share.

### 3.3 File ids

- Text: the volume serial number and the file id in lowercase hexadecimal without leading
  zeros, joined by `-`: `141ebf091ebee2c2-700000000273ee`. Opaque to everything but tests.
- On NTFS the file id's upper 64 bits are zero and the lower 64 are the file reference number: a
  48-bit MFT record number and a 16-bit sequence number that changes when the record is reused,
  so an id does not come back right after a delete. Measured: the listing's id, `FileIdInfo` and
  `GetFileInformationByHandle`'s file index agree.
- Hard links share an id; the scan does not pair an id that occurs twice (library scan §6.1).
- The serial number keeps volumes apart: a library copied to another disk gets new ids, so
  every file is modified once and hashed again, which is the safe outcome.
- A catalog that `StdFileSystem` filled gets its ids from the first scan with this adapter: one
  update per entry, no change reported, hashes kept (`None` → `Some` is not a modification,
  library scan §6.1).

### 3.4 Hashing skips what is not on this disk

`Library::hash_pending` never reads a file whose presence is not `Local` (Sirui, 2026-09-27):
reading a placeholder downloads it, which fills the disk, costs traffic and makes Windows ask the
user whether to block Folio. The check uses the metadata the hashing pass already reads before
opening a file. Such a file stays pending and is counted in `HashReport::not_local`, so the UI can
say how many files wait to be hashed until they are downloaded (not how many are only in the
cloud: a file hashed before its space was freed up is not counted). Downloading a file changes
neither its size nor its time, so the next hashing run takes it without a scan.

### 3.5 Tests

| Area | Tests |
|---|---|
| Parsing | `FILE_ID_EXTD_DIR_INFO` buffers built in the test: several records, `.` and `..`, unpaired surrogates, a record or name that overruns the buffer is an error |
| Rules | Kind from attributes and tags (junction, symbolic link, WSL link, `AF_UNIX`, cloud tags); presence; id text; FILETIME conversion against std's |
| NTFS (temporary folders, also on CI) | The listing equals `StdFileSystem`'s apart from ids; `read_dir` and `metadata` agree; ids survive renames and moves and differ between files; hard links share one; junctions are links and are not followed; a missing path is `NotFound`; paths longer than `MAX_PATH`; a folder renamed outside Folio keeps its entries and tags through a real scan |
| Off NTFS | Ignored tests that run in `FOLIO_TEST_NON_NTFS_DIR` (on Sirui's machine a folder on `I:`, exFAT): no ids, the same listing as std |
| Hashing | `MemFs` placeholders and offline files are skipped, counted and hashed once local |

## 4. Recycle Bin

```rust
pub trait RecycleBin: Send + Sync {
    /// Moves the file or folder at `path`, with everything below it, to the Recycle Bin.
    /// Never deletes anything for good: what the Recycle Bin cannot take stays where it is.
    fn recycle(&self, path: &Path) -> Result<(), RecycleError>;
}
pub struct RecycleError { pub path: PathBuf, pub failure: RecycleFailure, pub detail: String }
```

`RecycleFailure`: `NotFound`; `Unrecyclable` (the drive has no Recycle Bin, the path is too long
for it, or the item is larger than its limit); `InUse` (another program holds it or something
below it); `Denied`; `Invalid`; `Other`. `detail` is for logs, as `Problem::Unreadable`'s is.
`Invalid` means a path no caller should pass (relative, a whole drive or share, `..`, NUL) or one
the shell resolves to another file: a bug or a trap, never the user's doing, so the shell maps it
to an internal error. The UI later offers "delete permanently" for `Unrecyclable` as its own
confirmed action; this adapter never does it.

The Recycle Bin takes native paths like `FileSystem`. Which paths may be deleted at all (never
the library root or `.folio`) is the delete operation's rule, in the library layer.

### 4.1 `WindowsRecycleBin`

- `IFileOperation` with `FOF_ALLOWUNDO | FOFX_RECYCLEONDELETE | FOF_NO_UI | FOFX_EARLYFAILURE`,
  one item per call.
- **The guard.** An `IFileOperationProgressSink` whose `PreDeleteItem` returns `E_ABORT` unless
  its flags contain `TSF_DELETE_RECYCLE_IF_POSSIBLE`. Without it, the shell deletes for good
  whatever the Recycle Bin cannot take, silently under `FOF_NO_UI`. Measured: a 318-character
  path on `E:` (no 8.3 names) and a 26-level, 386-character path on `C:` arrive with flags `0x202`
  instead of `0x282`; with the guard both files stayed. A drive whose Recycle Bin is turned off,
  or an item in the Recycle Bin itself, arrives the same way.
- **Success** is `PostDeleteItem` reporting the item done and naming the new item in the Recycle
  Bin (`C:\$Recycle.Bin\<SID>\$R….txt`, `I:\$RECYCLE.BIN\$R….txt` on exFAT); anything else is
  an error, whatever the rest of the operation reports.
- **Errors** come from the item's HRESULT: `E_ABORT` after the guard → `Unrecyclable`;
  `COPYENGINE_E_SHARING_VIOLATION_SRC` (`0x80270027`, measured on a file open without
  `FILE_SHARE_DELETE`), `COPYENGINE_E_SHARING_VIOLATION_DEST` (`0x80270028`, measured on a
  folder holding such a file) or a sharing violation → `InUse`; access denied, at the source or
  the destination → `Denied`; `COPYENGINE_E_RECYCLE_*` → `Unrecyclable`; file or path not found
  → `NotFound`.
- **Paths.** The shell's parser rejects `\?\` (`E_INVALIDARG`), so the path is rebuilt name by
  name after its drive or share, refusing empty names, `.`, `..`, `/` and NUL: outside a verbatim
  path Win32 would give them a meaning (`\?\C:\srv\share` would become a share). Longer paths
  still work where the shell can recycle them (it uses 8.3 names where the volume has them).
- **The same file.** The parser follows folder shortcuts (a `desktop.ini` naming a CLSID with a
  `target.lnk`) and namespace junctions (`name.{CLSID}`), so a library path could stand for
  another file. The item's file-system path must name the same file as the path asked for: the
  same volume serial number and file index. Otherwise `Invalid`, and nothing moves.
- `IFileOperation` works only in a single-threaded apartment, so each call runs on a short-lived
  thread of its own (`CoInitializeEx` with `COINIT_APARTMENTTHREADED`), whatever the caller's
  thread.
- A folder goes to the Recycle Bin as one item, with everything below it.
- **Dependencies.** The `windows` crate for the COM interfaces (WP-03's workspace entry, a
  version already in `Cargo.lock`). Its `#[implement]` macro expands to `::windows_core` paths,
  so the sink also needs `windows-core` as a direct dependency: a workspace entry pinned to
  0.61.2, the version `windows` 0.61.3 uses (Sirui, 2026-09-27, instead of a hand-written
  vtable). Nothing new is downloaded.

### 4.2 Fake

`MemFs` implements `RecycleBin`: each call puts one item in a bin that tests can inspect, and a
test can make a path unrecyclable or in use. A failure set for a path also stops recycling any
folder above it, as a file open in another program does on Windows.

### 4.3 Tests

The fake and the real Recycle Bin are tested for the same cases: a missing path, a relative
path, a drive root, a path through `..`, a file held open without `FILE_SHARE_DELETE` and a
folder holding one (in use; nothing moves), a 26-level path (unrecyclable: nothing reaches the
Recycle Bin), and a file and a folder that go to the Recycle Bin. The last two are ignored by
default because they add to the user's Recycle Bin; they run by hand, also in
`FOLIO_TEST_NON_NTFS_DIR`, and passed on Sirui's machine on NTFS (`C:`) and exFAT (`I:`) on
2026-09-28. The Windows side also checks the path rebuilding and that a parsed item is told from
another file. Tests touch only temporary files they created and never empty the Recycle Bin.

## 5. Watcher

### 5.1 What Windows reports

Measured with `ReadDirectoryChangesExW` and `ReadDirectoryNotifyExtendedInformation` on NTFS (file
ids in every record):

| Operation | Records |
|---|---|
| Create a file | `ADDED`, `MODIFIED` |
| Overwrite it | `MODIFIED`, `MODIFIED` |
| Rename in a folder | `RENAMED_OLD`, `RENAMED_NEW` |
| Move to another folder in the tree | `REMOVED` (old path), `ADDED` (new path), often in separate reads |
| Rename changing only case | `REMOVED` (old name), `RENAMED_OLD`, `RENAMED_NEW` |
| Save through a temporary file | `ADDED` of the temporary file, `RENAMED_OLD`/`NEW` twice, `REMOVED` of the old file: two ids |
| Move out of the tree / into it | `REMOVED` / `ADDED` (a folder's contents come without records) |
| Add, remove or rename an entry | Usually also `MODIFIED` of its folder |

Every record of one file carries its id, and a move between folders is a removal and an addition,
so renames are paired by file id across records and reads, not by record type.

On exFAT (`I:`), the extended class fails with `ERROR_INVALID_FUNCTION`. Plain records
(`ReadDirectoryNotifyInformation`) work, without ids and without the folder `MODIFIED`; a
case-only rename produced no record at all. With a 4 KiB buffer, 6,000 records in a burst arrived
without an overflow, because the next read was armed at once.

### 5.2 `Watcher`

```rust
impl Watcher {
    pub fn start(
        root: &Path,
        file_ids: bool, // WindowsFileSystem::has_file_ids
        options: WatchOptions,
        sink: impl FnMut(WatchEvent) + Send + 'static,
    ) -> io::Result<Watcher>;
    pub fn stop(self); // also on drop
}
pub enum WatchEvent { Rescan(Rescan), Failed(io::Error) }
pub enum Rescan {
    Full,                  // the whole library
    Scopes(Vec<RelPath>),  // these, none below another; each scan also mirrors .folio/meta
    Metadata,              // only .folio/meta/ or tags.json changed
}
```

- One thread per watcher. It opens the root (`FILE_LIST_DIRECTORY`, sharing everything,
  `FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OVERLAPPED`) and waits on the read, a stop event and the
  next due time.
- With file ids: extended records. Otherwise, or when the extended call
  fails, plain records.
- Filter: file and folder names, size and last write. Not attributes: freeing up space in a
  folder of placeholders would scan for nothing.
- Buffer: 256 KiB on local volumes, 64 KiB on network ones (their limit). The next read is armed
  before the records are processed.
- **First a full rescan.** Changes made before the watch started are unknown, so the first event
  is always `Rescan::Full`: the shell starts the watcher and lets that rescan be the start-up
  reconciliation (system overview §3 item 1).
- **Overflow** (a read that returns zero bytes or `ERROR_NOTIFY_ENUM_DIR`) → `Rescan::Full`.
- **Failure** (the root deleted or renamed away, the volume gone): `WatchEvent::Failed`, and the
  thread ends. Restarting begins with a full rescan again.
- `stop` sets the stop event; the thread cancels its read (`CancelIoEx`) and waits for the
  cancellation to complete before the buffer and `OVERLAPPED` go away.
- The sink runs on the watcher thread and must not block; the shell hands the event to its job
  queue.

### 5.3 From records to rescans

The coalescer is plain Rust, fed records with their time; it answers when the next rescan is due
and what it is.

1. **Folio's folder** (`.folio` at the root, any case): `ignore` or `library.json` → `Full` (the
   rules or the classes changed, library scan §5, §6.1); `tags.json` or anything in `meta/` →
   `Metadata`; the rest (`local/`, later `store/`) → nothing: Folio writes it.
2. **Net effect per file id** in the window: *before* is the path of its first record if that
   record says the file existed (`REMOVED`, `RENAMED_OLD`, `MODIFIED`), *after* the path of its
   last record if that one says it exists (`ADDED`, `RENAMED_NEW`, `MODIFIED`). Before and after
   both there and different: a move, scoped at the deepest folder holding both paths, where the
   scan pairs it by file id (library scan §6.4). Otherwise *before* and *after* are each a scope.
   Names in between, such as temporary files, never become scopes.
3. **Records without ids** (off NTFS): each path is a scope. Nothing is paired: without ids the
   scan cannot pair a rename either, so renames there lose their tags (ADR-0003 §10).
4. **Rules files**: a `.gitignore` or `pyvenv.cfg` (any case) scopes its folder, since it changes
   what belongs below it.
5. **Names the catalog cannot hold** (not Unicode, not NFC, invalid on Windows): the scope is the
   longest valid part of the path, the root meaning `Full`. The scan then reports the name. An
   8.3 alias is a valid name that matches nothing, and the scan's widening (library scan §6.4)
   takes it to the nearest folder the catalog knows.
6. **Merging.** A scope below another is dropped. More than 8 scopes become their deepest common
   folder (the root meaning `Full`), because every scan also reads `.folio/meta/` and mirrors it.

**Timing.** A rescan is due 300 ms after the last record, or 3 s after the first record of the
window if records keep coming; an overflow makes a full rescan due at once. A full rescan is also
due 60 minutes after the last one on local NTFS and 10 minutes elsewhere, where records miss more
(ADR-0003 §10: "scans more often"). These are `WatchOptions` defaults, to be tuned with use.

### 5.4 `Library::rescan`

`Library::rescan(catalog, &rescan, now_ns, on_report)` carries out a rescan: `scan(None)` for
`Full`, `scan(Some(scope))` for each scope, `sync_metadata` for `Metadata`. Each report goes to
`on_report` with its scope as soon as that scan commits, so the shell can emit `fs.changed` and
keep the latest problems per scope (library scan §9). It stops at the first error; the shell then
runs a full rescan later.

### 5.5 Tests

| Area | Tests |
|---|---|
| Parsing | Buffers of both record kinds built in the test; overruns are errors |
| Coalescer | Every row of §5.1, as recorded; `.folio` rules; rules files; invalid names; merging and the cap; timing with a fake clock; periodic and overflow rescans |
| Windows (temporary folders, also on CI) | A real watcher, library and catalog: after creations, edits, renames, moves between folders, case-only renames, saves through temporary files and deletions, the catalog equals one a fresh full scan builds; a file moved between courses keeps its tags; a 4 KiB buffer with a blocked sink overflows into a full rescan; plain records forced on NTFS; stopping cancels the read |
| Off NTFS | `FOLIO_TEST_NON_NTFS_DIR`, by hand |

Tests wait for the catalog to reach the expected state, with a timeout of seconds, instead of
counting rescans, so a slow CI machine only makes them slower.

## 6. Scan benchmark

`tests/scan_benchmark.rs` builds the 49,920-file library once and times, per adapter and with a
catalog of its own: the first scan, a scan without changes, hashing, and a scan after renaming a
course (renamed back afterwards). On Windows it runs `StdFileSystem` and then
`WindowsFileSystem`; elsewhere only `StdFileSystem`. Timing runs hold `.agents/work/locks/app`
and start only when no other `cargo` or `pnpm` process runs; Microsoft Defender stays as it is,
and its state is recorded next to the results in library scan §10.

## 7. Errors

| Type | Meaning |
|---|---|
| `io::Error` from `WindowsFileSystem` | As from `StdFileSystem`: `NotFound`, `PermissionDenied`, sharing violations (`files::is_in_use`); a malformed listing buffer is `InvalidData` |
| `recycle::RecycleError` | §4 |
| `WatchEvent::Failed(io::Error)` | The watch ended; restart it later |

## 8. Threads

- `WindowsFileSystem` holds no handle between calls; it is `Send + Sync` like the trait requires.
- `WindowsRecycleBin` starts a thread per call and joins it before returning.
- `Watcher` owns one thread and its handles; the sink is called on that thread.

## 9. Unsafe code

- Only `win::handle`, `win::files`, `win::recycle` and `win::watcher` allow `unsafe_code`, each
  with a module-level `#![allow(unsafe_code, reason = "…")]` as in `search/fts5.rs`, and every
  `unsafe` block says why it is sound.
- Buffers are parsed by safe code from byte slices: every offset and length is checked against
  the buffer, and a record that does not fit is an error.
- Handles are `std::os::windows::io::OwnedHandle`, closed on drop.
- A read's buffer and `OVERLAPPED` live until the read completes or its cancellation does.

## 10. Additions to earlier documents

1. **Library scan §3**: `Metadata::presence`; `WindowsFileSystem` is the adapter with file ids.
   **§8**: hashing skips files not on this disk. **§10**: the benchmark on NTFS. **§12 item 1**
   points here.
2. **Library core §10 item 3** points here.
3. **System overview §3 item 1**: the shell starts the watcher, and the watcher's first rescan
   is the start-up reconciliation.
4. **Testing strategy**: adapter tests on the real OS, the ignored Recycle Bin tests and
   `FOLIO_TEST_NON_NTFS_DIR`.

## 11. Revisit

- ReFS (Dev Drive): its listings and 128-bit ids work; allow ids there once measured.
- Presence in the catalog, for a badge on files only in the cloud; pin states (sync lane). It
  would also let the hashing pass skip placeholders by query: today every run opens each pending
  placeholder for its attributes again, about half a second per 50,000 of them.
- A reading method that refuses placeholders, once more background readers than hashing come
  (text extraction, history): `FileSystem::open` downloads, and the scan reads `.gitignore` files
  through it on purpose, since their rules are needed.
- Hashing's second metadata check from the open handle (library scan §12 item 4).
- Recycling many items in one `IFileOperation` if deleting many files is slow.
- A folder's `MODIFIED` record scans the whole folder; a scan of one level would be cheaper.
