# M1 import implementation

- Lane: `feat/core-import`; backend implementation, stop at review.
- Contract: ipc-m1 §4.2, §12, §13, §17; ADR-0004 options 2 and 5.
- Prerequisites: core-library-ops and browse queries landed; implementation base `3eef7bf`.

## Flow and ownership

```text
native file picker / native Windows drop
  -> shell Source selection (identity, kind, per-volume filesystem adapter)
  -> bounded, expiring import-choice token
  -> check_import (repeatable) / import_files (validate, consume, queue)
  -> session worker under existing operation mutex
  -> core import -> durable verified stage -> optional guarded recycle -> publish
  -> metadata/catalog commit -> CatalogChanged + JobChanged
```

The Rust command group owns registration, manifest and individual main-window grants. Core
owns the import module under `library::operations`, without Tauri or IPC types. Native dialog
COM objects remain in the existing STA helper; only native path values leave it. The debug-only
`FOLIO_TEST_IMPORT_FILES` override uses the OS path-list format (`join_paths`/`split_paths`),
with an empty value standing for cancellation. The native dialog selects files; native drops
also accept folders. No file-system plugin or asset protocol is enabled.

The shell alone issues choices. Import and library-folder choices have separate registries;
the ten-minute expiry and 32-choice budget match the existing library selector. Checks never
consume the token. Enqueue validates target, tags and source identity with read-only preflight;
the transition serializes token consumption with other commands and library switches. The worker
repeats validation under the operation mutex. Imports queue in submission order, while enqueue
checks rebuild/recovery/closing state under the pending-work lock. Rejected choices remain
available until their normal expiry; successful enqueue consumes once. Switching libraries
clears both registries.
Queued imports wait for a required full reconciliation scan, including after a cancelled scan.
Execution rechecks the write guard under the operation mutex: if a foreground write required
recovery after the worker selected the job, it fails with `Busy` before copying and retains its
sources. Failure-detail truncation never removes the batch's reconciliation signal.
File selection and copying run on blocking threads, never in the UI/native event callback.

## Import and recovery rules

`imported` counts successfully committed files, including `replaced` and `renamed`; those two
counts are subsets. Folders are counted by the check but are not files in the job result. Paths
in check conflicts are library-relative; failures and progress use source-relative names.
Counts and byte sizes use the existing IPC shape; bytes remain decimal strings.

Target references resolve exactly inside the writer transaction and must be a course or a
folder below it. Source selection retains link classification before canonicalizing paths.
Links and special files stay out; non-local content is never hydrated. Sources inside the
library, sources containing it, and overlapping selected sources are refused. Names and case
clashes follow the existing path and ignore rules. Existing folders merge; file/folder clashes
keep both. One replace/keep-both/skip choice applies also to clashes discovered after checking.
Preflight follows merged or automatically numbered folder destinations and reserves names
already planned in the selection, so a file/folder clash does not reject its folder's children.
Folder identity uses kind, creation time, file ID and presence: directory listing modification
timestamps can lag handle metadata. Child names/identities and file content are checked in the
complete before/after manifest; a changed folder timestamp never authorizes deleting an
uncopied arrival. Selected files retain every identity field.

Each copied file is staged and flushed on the destination volume, with a verified BLAKE3 hash.
A small machine-local import intent records only library-relative destination data, selected
destination identity, verified stage/hash and tags. It is published before the old file is
recycled. The intent is `.folio/local/journal/import.json`, with verified bytes in
`.folio/local/staging/`. It is ephemeral recovery state, not a new authored/sync format.
Recovery reuses guarded metadata/catalog writes: it publishes a verified stage into an absent
destination or settles the matching published file. It never overwrites conflicting bytes,
recycles again, follows links or deletes originals. When the destination changed under the
import (the old file is still there or was edited, something else arrived, the published copy
was changed or removed, or the destination folder moved or was replaced), recovery abandons the
copy: it removes only the verified stage and the intent, and the item fails with its original
kept. A replacement abandoned after its old file was recycled reports `DiskChanged`, so the
session rescans. A tampered intent or stage still fails closed and keeps its evidence.
Published NTFS identity retains the volume/file ID, size, modification time and full hash;
creation time can inherit the old name's value through [NTFS name tunneling](https://learn.microsoft.com/en-us/windows-hardware/drivers/ddi/fltkernel/nf-fltkernel-fltgettunneledname).
Adapters without file IDs retain all available identity fields, including creation time, and
the same complete hash check. Physical non-NTFS-volume coverage remains environment-dependent.

Replacement preserves existing tags; requested tags apply to created top-level items and to
files added by a merge. New folder tags inherit through existing metadata behavior. Commit
reports are published before subsequent work, even if that work fails. A failure after a disk
change schedules recovery through the existing session mechanism; rollback never claims to
undo an OS action. Byte progress counts every finished file, skipped and failed ones included,
so it reaches the total.
Files below a failed folder also publish their finished progress; the original folder remains.

Originals are recycled only after every intended item, tags and catalog changes have committed
and a complete source manifest/content check still matches. Anything skipped, failed, changed
or newly added retains that top-level source and is reported. Cancellation stops at a safe
boundary, preserves committed files and retains incomplete originals. All recycling uses the
existing `RecycleBin` adapter, without permanent-delete fallback.
As with existing file operations, pathname checks reject links and changed identities but
cannot pin a concurrent same-user ancestor replacement between a check and an OS operation.
Handle-based confinement would be a separate OS-boundary change.

## Checks and review

- Core integration: target/reference validation, nested folders and ignore rules, conflicts,
  tags, case/NFC names, verified copies, original retention and guarded recycling.
- Fault/recovery: disk full, file in use, metadata/catalog failures and each replacement crash
  boundary; recovery cannot overwrite an unexpected destination or escape the library.
- Shell contracts: folder flags, repeatable checks, replay/expiry/kind/switch rejection,
  validation before consumption, job result/progress/cancellation, CSS drop coordinates.
- Runtime: runtime command lists equal manifest and grants; no default grants, asset protocol
  or file-system plugin; an unknown command remains rejected in the existing e2e regression.

## Open items

- A native drop the shell rejects (more than `LIMITS.batch` items, a non-Unicode name, an
  unreadable folder) reaches only the diagnostics log: `FilesDropped` has no error form, so the
  page sees the hover end and nothing else. The import UI lane adds a typed drop-failure event
  (contract change: bindings, fake shell, ipc-m1 §12) before it ships the drop target.
- A cancelled import finishes as `JobStatus::Cancelled`, which has no result: its imported
  count, partial failures and an original-recycle failure that raced the cancel are dropped
  (committed files still reach the catalog through `CatalogChanged`). Before the import UI
  lane ships, a contract change gives `Cancelled` an optional `ImportResult` (Sirui,
  2026-10-02: land first, follow up).
- `DropHover` is emitted for every native drag-over callback, unthrottled; the import UI lane
  coalesces it (same position, or the job-progress throttle) if profiling shows the cost.
- Per-file collision checks list the destination parent each time, so very large folders
  import in quadratic time and `check_import` holds the library transition throughout; cache
  a listing per parent if profiling shows the cost.
- Coordinator: targeted Cargo checks, `pnpm check`, app-locked `pnpm e2e`; no binding shape
  change intended. Separate Claude Code `/code-review`, `/security-review`, `/simplify` still
  precede Sirui's landing approval. Actual results live in the lane record and review handoff.
