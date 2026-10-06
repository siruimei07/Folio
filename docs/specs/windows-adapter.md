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
| `win::chain` | Walks the chains of records that both kinds of buffer hold | No |
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
   │  Watcher::start(root, WatchOptions::new(file_ids), sink)
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
    /// Moves the file or folder at `path`, with everything below it, to the Recycle Bin, and
    /// says where it went. Never deletes anything for good, and never reads or downloads a file
    /// to recycle it: what cannot go stays where it is.
    fn recycle(&self, path: &Path) -> Result<Recycled, RecycleError>;
}
pub enum Recycled { RecycleBin, CloudTrash }
pub struct RecycleError { pub path: PathBuf, pub failure: RecycleFailure, pub detail: String }
```

`Recycled::CloudTrash` is a file whose content was only in the cloud: the shell leaves it to its
cloud provider's trash instead of the Recycle Bin (§4.2). Callers count both as done.

`RecycleFailure`: `NotFound`; `Unrecyclable` (the drive has no Recycle Bin, the path is too long
for it, or the item is larger than its limit); `InUse` (another program holds it or something
below it); `CloudOnly` (a folder that is, or holds, something only in the cloud, §4.2);
`Denied`; `Invalid`; `Other`. `detail` is for logs, as `Problem::Unreadable`'s is.
`Invalid` means a path no caller should pass (relative, a whole drive or share, `..`, NUL) or one
the shell resolves to another file: a bug or a trap, never the user's doing, so the shell maps it
to an internal error. The shell maps `Unrecyclable` to the IPC code `NotRecyclable` (ipc-m1
§16.2), and `CloudOnly` too until a contract lane gives it a code of its own (§4.2). The UI later
offers "delete permanently" for `Unrecyclable` as its own confirmed action; this adapter never
does it.

The Recycle Bin takes native paths like `FileSystem`. Which paths may be deleted at all (never
the library root or `.folio`) is the delete operation's rule, in the library layer.

### 4.1 `WindowsRecycleBin`

- **First a look at the item**, which decides where it should go (§4.2), through
  `StdFileSystem`: its attributes, from handles and listings alike, tell placeholders without
  opening or downloading any file (§3.1; checked on a placeholder in iCloud Drive, 2026-10-05).
  The look uses the verbatim form of the path (`\\?\`), and lists each folder below by its name
  joined to it. In a plain path Win32 drops trailing dots from names, and trailing spaces from the
  last one: measured 2026-10-05, a plain path to a folder `作业.` lists its sibling `作业`, or
  nothing when there is no sibling. The look would then miss a placeholder in `作业.`.
- `IFileOperation` with `FOF_ALLOWUNDO | FOFX_RECYCLEONDELETE | FOF_NO_UI | FOFX_EARLYFAILURE`,
  one item per call.
- **The guard.** An `IFileOperationProgressSink` whose `PreDeleteItem` returns `E_ABORT` unless
  its flags contain `TSF_DELETE_RECYCLE_IF_POSSIBLE`. Without it, the shell deletes for good
  whatever the Recycle Bin cannot take, silently under `FOF_NO_UI`. Measured: a 318-character
  path on `E:` (no 8.3 names) and a 26-level, 386-character path on `C:` arrive with flags `0x202`
  instead of `0x282`; with the guard both files stayed. A drive whose Recycle Bin is turned off,
  or an item in the Recycle Bin itself, arrives the same way.
- **Success** is `PostDeleteItem` reporting the item done and naming the new item in the Recycle
  Bin (`C:\$Recycle.Bin\<SID>\$R….txt`, `I:\$RECYCLE.BIN\$R….txt` on exFAT), or, for a file
  only in the cloud, the outcome of §4.2; anything else is an error, whatever the rest of the
  operation reports.
- **Errors** come from the item's HRESULT: `E_ABORT` after the guard → `Unrecyclable`;
  `COPYENGINE_E_SHARING_VIOLATION_SRC` (`0x80270027`, measured on a file open without
  `FILE_SHARE_DELETE`), `COPYENGINE_E_SHARING_VIOLATION_DEST` (`0x80270028`, measured on a
  folder holding such a file) or a sharing violation → `InUse`; access denied, at the source or
  the destination → `Denied`; `COPYENGINE_E_RECYCLE_*` → `Unrecyclable`; file or path not found
  → `NotFound`. The parser's not found is `NotFound` only while the verbatim path finds nothing
  either; otherwise the item is still there by a name the parser does not reach (below, Paths):
  `Other`.
- **Paths.** The shell's parser rejects `\\?\` (`E_INVALIDARG`), so the path is rebuilt name by
  name after its drive or share, refusing empty names, `.`, `..`, `/` and NUL: outside a verbatim
  path Win32 would give them a meaning (`\\?\C:\\srv\share` would become a share). It is rebuilt
  twice: plain for the shell, verbatim for the look and the same-file check. Longer paths
  still work where the shell can recycle them (it uses 8.3 names where the volume has them).
  The plain path cannot reach a name ending in a dot, or a last name ending in a space: measured
  2026-10-05, the parser does not find `alone.md.`, `alone.md `, a folder `作业.` or a file in it
  (`0x80070002`). Such an item stays, `Other`. Library entries cannot have such names
  (`paths::check_name`), but a folder above the library can. Such names can come from WSL, MSYS
  or SMB clients; iCloud renames them on Windows (field test: an iPad's `dot.` arrived as
  `dot_.txt`).
- **The same file.** The parser follows folder shortcuts (a `desktop.ini` naming a CLSID with a
  `target.lnk`) and namespace junctions (`name.{CLSID}`), so a library path could stand for
  another file. The item's file-system path must name the same file as the path asked for, read
  through its verbatim form: the same volume serial number and file index. Otherwise `Invalid`,
  and nothing moves. So a path that Win32 reads as another file outside a verbatim path (`a.md.`
  for `a.md`) is refused instead of recycling that other file.
- `IFileOperation` works only in a single-threaded apartment, so each call runs on a short-lived
  thread of its own (`CoInitializeEx` with `COINIT_APARTMENTTHREADED`), whatever the caller's
  thread.
- **WinRT needs COM held.** windows-rs caches WinRT activation factories for the whole process.
  When a short-lived apartment is the last one, its teardown shuts COM down, Windows Server 2022
  then unloads the factory's DLL, and the next call crashes (STATUS_ACCESS_VIOLATION). So code
  that calls WinRT first holds the MTA for the life of the process, as `folio-app`'s
  `dialogs::hold_mta` does (`fix/build-ci-access-violation`, 2026-09-29).
- A folder goes to the Recycle Bin as one item, with everything below it.
- **Dependencies.** The `windows` crate for the COM interfaces. Its `#[implement]` macro expands
  to `::windows_core` paths, so the sink also needs `windows-core` as a direct dependency (Sirui,
  2026-09-27, instead of a hand-written vtable). Both are workspace entries pinned to the versions
  Tauri already locks, so nothing new is downloaded.

### 4.2 Files only in the cloud

The [iCloud field test](../research/icloud-field-test.md) (§2, §6) found `WindowsRecycleBin`
reporting a failure for files that were gone. Measured again in a folder in iCloud Drive
(iCloud for Windows 15.8, build 26200, 2026-10-04, lane `fix/core-recycle-cloud-placeholder`),
recycling each item with the flags and guard above:

| Item | What the shell reports | Where it ends up |
|---|---|---|
| A downloaded file or folder | Done, with a Recycle Bin item; about 2.8 s | The Recycle Bin. iCloud's Recently Deleted (`iCloudDrive\.Trash`) also keeps a copy of a file |
| A file only in the cloud, 36 bytes or 20 MB | Done, without a Recycle Bin item; about 120 ms, nothing downloaded | iCloud's Recently Deleted only |
| A folder holding files only in the cloud | Done, with a Recycle Bin item | The folder and its downloaded files in the Recycle Bin; each file only in the cloud on its own in Recently Deleted; iCloud then puts the folder back, empty, at its old path |

The guard sees nothing to refuse: `PreDeleteItem` gets `0x282` in all three cases. iCloud's sync
root registers no `RecycleBinUri`. The field test also saw `ERROR_CLOUD_FILE_NOT_SUPPORTED`
(`0x8007017B`) once, for an item it did not record; it did not come back here.

So the Recycle Bin takes such a file only by downloading it, which Folio never does (§3.4), and
the shell leaves it to the cloud provider instead, as File Explorer does. Rules (Sirui,
2026-10-04):

- **Before the shell**, `recycle::destination` decides from attributes and listings alone: no
  file is read or downloaded, no link followed, and a folder that is a placeholder is not listed,
  since listing it would fetch it.
  - A file whose presence is `Placeholder` should go to the cloud trash.
  - A folder that is a placeholder, or holds one at any depth, stays: `CloudOnly`, and nothing
    moves. The shell would split it as above. The user can download it first ("Always keep on
    this device") or delete it elsewhere.
  - A folder that cannot be listed, at any depth, stays with the listing's failure. Only the
    item itself can be `NotFound`: a folder below it that its parent listed but that is then not
    found means something changed under the item in the meantime, so it is `Other` while the
    item is still there and `NotFound` once the item is gone too.
  - Anything else should go to the Recycle Bin.
- **After the shell**:
  - The item in the Recycle Bin is `Recycled::RecycleBin`, whatever was expected: something may
    have downloaded the file in the meantime.
  - A file expected in the cloud trash is `Recycled::CloudTrash` when the shell put nothing in
    the Recycle Bin, reported the item done or `ERROR_CLOUD_FILE_NOT_SUPPORTED`, and the file
    left its path: nothing is there, or another file (volume serial number and file index).
  - Anything else is an error, as before.
- Folio still deletes nothing itself: it hands the item to the shell as before, knowing
  beforehand where it goes. The provider keeps it: iCloud Drive's Recently Deleted keeps every
  deletion for 30 days (field test §2), restorable on an iPad, a Mac or iCloud.com, not on
  Windows.
- **Callers** count both destinations as done: `delete_entries` removes the entry, an import's
  `replace` publishes the new file, and deleting originals counts the original. Until a contract
  lane reports `CloudTrash` and gives `CloudOnly` a code (Sirui, 2026-10-04: after this lane), the
  toast says "Moved to the Recycle Bin" for these files too, and `CloudOnly` reads as
  `NotRecyclable`.
- **Known gaps.** A file that becomes cloud-only between the look and the shell is reported as
  `Other` ("nothing in the Recycle Bin") although the shell removed it; the next scan sees it
  gone. A file below a folder that does so lands in Recently Deleted, apart from its folder. An
  item the shell's parser cannot reach by name (§4.1, Paths) stays, `Other`, wherever it is.
- **For the mirror (M3).** ADR-0003 §7 deletes mirror files through the shell, and freeing up
  space makes most of them placeholders: each such file is `CloudTrash`, and a folder holding one
  is `CloudOnly`, so the mirror deletes files before their folders. Seen once while cleaning up
  the test below: deleting a placeholder with `DeleteFileW` and then its folder left neither in
  `.Trash` on Windows three minutes later, and iCloud put the emptied parent folder back. Not
  checked on the iPad; `docs/specs-sync` should measure direct deletion before relying on it.

### 4.3 Fake

`MemFs` implements `RecycleBin` with the same `destination` rules: each call puts one item in a
bin, or a placeholder file in a cloud trash beside it, which tests can inspect, and a test can
make a path unrecyclable or in use. A failure set for a path also stops recycling any folder
above it, as a file open in another program does on Windows.

### 4.4 Tests

The fake and the real Recycle Bin are tested for the same cases: a missing path, a relative
path, a drive root, a path through `..`, a file held open without `FILE_SHARE_DELETE` and a
folder holding one (in use; nothing moves), a 26-level path (unrecyclable: nothing reaches the
Recycle Bin), and a file and a folder that go to the Recycle Bin. The last two are ignored by
default because they add to the user's Recycle Bin; they run by hand, also in
`FOLIO_TEST_NON_NTFS_DIR`, and passed on Sirui's machine on NTFS (`C:`) and exFAT (`I:`) on
2026-09-28, and on NTFS again on the reviewed code of 2026-10-05, with `e2e/tests/delete.spec.ts`
(`FOLIO_E2E_DESKTOP=1`). On Windows the look before the shell refuses a missing path, so a file
gone after the look is tested on its own: the shell's parser reports it `NotFound`. A file, a
folder and a file in a folder whose names the parser does not reach (`alone.md.`, `alone.md `,
`作业.`) stay and are `Other`. The Windows side also checks
the path rebuilding, plain and verbatim, that a parsed item is told from another file, and that a
path Win32 reads as another file (`twin.md.` beside `twin.md`, held open) is `Invalid` and
nothing moves. Tests touch only temporary files they created and never empty the Recycle Bin.
`folio-app`'s `sync_root_lookups_hold_com_for_the_process` recycles a file held open between
cached WinRT factory calls: it passes the look before the shell and fails inside the recycle
STA, so that STA's teardown runs while nothing reaches the Recycle Bin (§4.1, "WinRT needs COM
held").

Files only in the cloud (§4.2):

| Area | Tests |
|---|---|
| Fake | A placeholder file goes to the cloud trash; a folder holding a placeholder at any depth, a placeholder folder and a folder that cannot be listed stay; a folder below that vanishes before it is listed is `Other`, or `NotFound` when the item went with it, and the item itself vanishing is `NotFound`; links are recycled as themselves, never listed; offline files are not the cloud |
| Outcome | `outcome` with fake shell reports: the Recycle Bin wins; done or `ERROR_CLOUD_FILE_NOT_SUPPORTED` with the file gone is `CloudTrash`; still there, or expected in the Recycle Bin, is an error; the guard, other failures and a failed path check stand |
| Adapter | On temporary files, without the Recycle Bin. `gone` for a file still there, removed, and replaced by another file at its path; the guard records the real shell's report (posted, failed, not recycled) for a file held open, which stays. The whole adapter (`recycle_with`) with a look through `StdFileSystem` that reports chosen names as placeholders, and the shell's operation played by the test through the real guard, reporting the item done with or without a Recycle Bin item, or failed: a placeholder file the operation removed is `CloudTrash`; one still there, or a local file it removed, is `Other`; a Recycle Bin item wins; a failure reported for the item (access denied) stands although the file left, and `ERROR_CLOUD_FILE_NOT_SUPPORTED` with the file gone is `CloudTrash`. A folder holding a placeholder in `作业.` beside a local `作业` is `CloudOnly` and the operation never runs; without the placeholder it goes to the operation, with `讲义.` (no sibling) listed too. A folder holding a junction (`mklink /J`) to a folder with a placeholder goes to the operation: `StdFileSystem` lists the junction as a link, which is not followed |
| Callers | `delete_entries`, an import's `replace` and deleting originals with a bin that reports `CloudTrash`: done, no failure |
| iCloud Drive | Ignored, `FOLIO_TEST_ICLOUD_DIR` (a folder in iCloud Drive): files freed up with `attrib +U -P`, then a placeholder file is `CloudTrash` and gone, a folder holding one is `CloudOnly` with its file still a placeholder, a downloaded file is `RecycleBin`. Adds to the Recycle Bin and to Recently Deleted, and iCloud may put the emptied temporary folder back. Passed twice on Sirui's machine on 2026-10-04, before the review changes of 2026-10-05 (the look through `StdFileSystem`, checked by hand on a placeholder that day, the verbatim look and identity, and the review fixes); to be run again on the current code once iCloud for Windows runs. It is the only test of the real shell and the real attributes on a placeholder; the adapter row covers the code between them |

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
| Add, remove or rename an entry | Also `MODIFIED` of its folder and of every folder above it, up to the watched one (moving `q\x1\f.md` to `q\x2`: `q\x1`, `q`, then `q\x2`) |

Every record of one file carries its id, and a move between folders is a removal and an addition,
so renames are paired by file id across records and reads, not by record type. The folders'
`MODIFIED` records come from NTFS updating its index entries; the folders' own entries have not
changed.

On exFAT (`I:`), the extended class fails with `ERROR_INVALID_FUNCTION`. Plain records
(`ReadDirectoryNotifyInformation`) work, without ids and without the folder `MODIFIED`; a
case-only rename produced no record at all. With a 4 KiB buffer, 6,000 records in a burst arrived
without an overflow, because the next read was armed at once.

### 5.2 `Watcher`

```rust
impl Watcher {
    pub fn start(
        root: &Path,
        options: WatchOptions, // WatchOptions::new(WindowsFileSystem::has_file_ids())
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
- With file ids (`WatchOptions::file_ids`): extended records. Otherwise, or when the extended call
  fails, plain records.
- Filter: file and folder names, size and last write. Not attributes: freeing up space in a
  folder of placeholders would scan for nothing.
- Buffer: 256 KiB (`WatchOptions::buffer_bytes`), at most 64 KiB when the root's volume is a
  network share (their limit). The next read is armed before the records are processed.
- **First a full rescan.** Changes made before the watch started are unknown, so the first event
  is always `Rescan::Full`: the shell starts the watcher and lets that rescan be the start-up
  reconciliation (system overview §3 item 1).
- **Overflow** (a read that returns zero bytes or `ERROR_NOTIFY_ENUM_DIR`) → `Rescan::Full`.
- **Failure** (the root deleted or renamed away, the volume gone): `WatchEvent::Failed`, and the
  thread ends. Restarting begins with a full rescan again.
- `stop`, or dropping the watcher, sets the stop event and waits for the thread; the thread
  cancels its read (`CancelIoEx`) and waits for the cancellation to complete before the buffer and
  `OVERLAPPED` go away.
- The sink runs on the watcher thread and must not block; the shell hands the event to its job
  queue. A sink that drops its own watcher does not wait for itself: the thread ends when the sink
  returns.

### 5.3 From records to rescans

The coalescer is plain Rust, fed records with their time; it answers when the next rescan is due
and what it is. Before it, the parser leaves out every extended record of a folder's
modification: scoping them would widen every change to its top-level folder, and the records of
the entries themselves say what changed. A folder's time is caught up by the next scan that
covers it. Plain records do not say what is a folder, so off NTFS nothing is left out.

1. **Folio's folder** (`.folio` at the root, any case; `meta::folio_part`, next to the paths
   `Layout` builds): the folder itself, `ignore` or `library.json` → `Full` (the rules or the
   classes changed, library scan §5, §6.1); `tags.json` or anything in `meta/` → `Metadata`; the
   rest (`local/`, later `store/`) → nothing: Folio writes it.
2. **Net effect per file id** in the window: *before* is the path of its first record if that
   record says the file existed (`REMOVED`, `RENAMED_OLD`, `MODIFIED`), *after* the path of its
   last record if that one says it exists (`ADDED`, `RENAMED_NEW`, `MODIFIED`). Before and after
   both there and different: a move, scoped at the deepest folder holding both paths, where the
   scan pairs it by file id (library scan §6.4). Otherwise *before* and *after* are each a scope.
   Names in between, such as temporary files, never become scopes.
3. **Records without ids** (off NTFS): each path is a scope. Nothing is paired: without ids the
   scan cannot pair a rename either, so renames there lose their tags (ADR-0003 §10).
4. **Rules files**: a `.gitignore` or `pyvenv.cfg` is scoped like any file; a scan scoped to one
   covers its folder (library scan §6.4), whoever asks for it. A change next to it in the same
   window is scanned a second time (§11).
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
| Parsing | Buffers of both record kinds built in the test, folder modifications left out of extended ones; overruns are errors |
| Coalescer | The rows of §5.1, as recorded; `.folio` rules; invalid names; merging (also a sibling that sorts between a folder and its contents) and the cap; timing; periodic and overflow rescans |
| Watcher (temporary folders, also on CI) | The first rescan is full; a new file is scoped; a move between folders is one scope holding both; plain records forced on NTFS cover both sides; a 4 KiB buffer behind a blocked sink overflows into a full rescan; stopping ends the events; a sink that drops its own watcher ends the thread (it fails without the check: checked once by hand) |
| Watcher, adapter and scans (temporary folders, also on CI) | A file moved between courses keeps its entry and tags (it fails with pairing turned off: checked once by hand); after creations, edits, renames, a case-only rename, a save through a temporary file, a folder moved between courses and a deletion, the catalog equals what a fresh full scan builds |
| Off NTFS | `FOLIO_TEST_NON_NTFS_DIR`, by hand: asked for extended records, the watcher falls back to plain ones (passed on `I:`, exFAT) |

Tests wait for the catalog to reach the expected state, with a timeout of seconds, instead of
counting rescans, so a slow CI machine only makes them slower.

## 6. Scan benchmark

`tests/scan_benchmark.rs` builds the 49,920-file library once and times, per adapter and with a
catalog of its own: the first scan, a scan without changes, hashing, and a scan after renaming a
course (renamed back afterwards). On Windows it runs `StdFileSystem` and then
`WindowsFileSystem`; elsewhere only `StdFileSystem`. Timing runs hold the app lock (CLAUDE.md §7.5)
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
- Buffers are parsed by safe code from byte slices, both kinds by one walker (`win::chain`):
  every offset and length is checked against the buffer, and a record that does not fit is an
  error.
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
   `FOLIO_TEST_NON_NTFS_DIR`; `FOLIO_TEST_ICLOUD_DIR` (§4.4) joins them once
   `test/core-sync-simulation`, whose lines it would touch, has landed.
5. **IPC m1 §16.2**: `RecycleFailure::CloudOnly` maps to `NotRecyclable` (§4.2).

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
- The look for placeholders lists a whole folder before the shell moves it (§4.2); presence in
  the catalog would answer it by query.
- Off NTFS, a folder's `MODIFIED` record still scopes the whole folder; a scan of one level
  would be cheaper.
- One scan of several scopes. Each scope is a scan of its own today, and each reads
  `.folio/meta/`, mirrors it and commits (about 100 ms at 17,000 tag assignments, library scan
  §12 item 4). One plan over all the scopes would pair moves between them, so a move would no
  longer widen to the folder holding both ends (between semesters, a full rescan today), the cap
  of 8 scopes could rise, and a scope that widening or a rules file puts inside another would not
  be scanned twice.
- The coalescer allocates per record (paths, scopes and their ancestors); measure a burst of tens
  of thousands of files before tuning it.
