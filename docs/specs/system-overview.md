# System overview

Living document: update it when the component split or a data flow changes. Decisions stay in
ADRs; this file describes the current shape of the system.

- Status: draft, 2026-09-26. The layers map onto technologies in ADR-0001: the UI is React +
  TypeScript, the shell is Tauri 2, and the core is the Rust crate `folio-core`.
- Product source: [`docs/product/brief.md`](../product/brief.md) (Chinese). Section numbers below
  (brief §N) point into it.
- Detailed data model: ADR-0002. Versioning and sync format: ADR-0003.

## 1. Requirements summary

### Functional (v1)

| Area | What the system must do | Brief |
|---|---|---|
| Library | Semester and course folders, multi-select tags, import (copy), take over existing folders, rename, move, delete to the Recycle Bin, list and grid views, tag filters, smart views | §5.1 |
| Change detection | Notice changes made by other apps inside the library; honour default and `.gitignore` ignore rules | §5.1 |
| Search | `Ctrl+K` palette over names, paths, courses, tags and the text of text and Word files | §5.2 |
| Preview | Images, PDF, Markdown with maths, code, Word, Excel, PowerPoint (no external software), audio and video | §5.3 |
| Workspace | Uncommitted changes (add, modify, delete, rename or move), per-item include, diffs for text and Word, commit with a template or AI message, reword and uncommit before sync | §5.4 |
| History | Timeline of commits and operations, per-file history, restore a text or Word version as a new change | §5.6 |
| Sync | Create or join a remote folder in iCloud Drive; sync = pull, then push; detect direct edits made in the remote from iPad or Mac; conflict handling; free up local space | §5.5 |
| AI message | Optional DeepSeek (OpenAI-compatible) call with the key in Windows Credential Manager; template fallback | §5.7 |
| Distribution | Installer, auto-update without paid code signing, first-run onboarding | §9 |

### Non-functional

| Quality | Target |
|---|---|
| Scale | 50,000 files / 100 GB per library stays fluid |
| Latency | Search results about 200 ms after typing stops; common previews under 1 s; UI never blocks on disk or network |
| Safety | No silent data loss: deletes go to the Recycle Bin, snapshot before sync, crash-safe commit and sync |
| Offline | Everything except sync and AI works offline; sync resumes later |
| Privacy | Network only for opt-in DeepSeek calls and update checks; no telemetry |
| Security | UI untrusted; privileged layer behind a narrow, typed, validated IPC surface (CLAUDE.md §5) |
| Accessibility | WCAG 2.1 AA, full keyboard operation, reduced-motion support |
| Platform | Windows 10/11 x64 (ARM64 later if needed); on-disk formats stay platform-neutral |

### Constraints and assumptions

- Team: Sirui plus AI agents; agents write most code, Sirui reviews and approves.
- Installed toolchain: Node 24, pnpm 11, Rust 1.97 (ADR-0001 pins what the project uses).
- UI follows the design pipeline (tokens, handoff specs, `frontend-design`), which assumes a web UI.
- Every user-facing flow gets a Playwright e2e test (CLAUDE.md §4.2).
- A future macOS app would be written in Swift. It must at least read and write the same remote;
  reusing the core would be better.
- Single user, one running instance per machine, one library per machine in v1 (model allows more).

## 2. Components

```text
+----------------------------------------------------------------------+
| UI (untrusted renderer)                                              |
|   views: Library, Workspace, History, Settings; command palette      |
|   preview renderers: PDF, Markdown, code, Word, Excel, PowerPoint    |
|   i18n strings, design tokens                                        |
+------------------------------ typed IPC -----------------------------+
| Shell (privileged host)                                              |
|   command handlers: validate -> call core -> typed result or error   |
|   events to the UI: changes, job progress, sync state                |
|   file-bytes protocol (read-only, scoped to library and remote)      |
|   OS integration: dialogs, open / reveal, Recycle Bin, credentials,  |
|   shell thumbnails, drag-out, window chrome, updater                 |
+----------------------------------------------------------------------+
| Core (library code, no UI or shell dependencies)                     |
|   library    scan, watch, ignore rules, courses, tags, file kinds    |
|   catalog    SQLite catalog + full-text index (derived, rebuildable) |
|   extract    text from md / code / txt / docx (pdf, pptx later)      |
|   versioning working state vs last commit, content store, commits,  |
|              diff, restore                                           |
|   sync       remote layout, pull / push, conflicts, placeholders     |
|   ai         commit-message request builder and HTTP client          |
|   jobs       background queue: progress, cancellation, one writer   |
+----------------------------------------------------------------------+
| OS adapters (interfaces the core calls; real and fake versions)      |
|   file system, watcher, Recycle Bin, credentials, cloud placeholders |
+----------------------------------------------------------------------+
```

Rules:

- The core never imports UI or shell code. It reaches the OS only through adapters, so it can be
  tested with fakes and, if the stack allows, reused by a future Swift app.
- The shell is thin: validation, mapping errors, and OS glue. Business rules live in the core.
- Large payloads (file bytes for previews) do not travel through IPC messages; the shell serves
  them through a read-only protocol limited to the library and remote roots.

## 3. Data flows

1. **Start-up**: load settings, open the library, start the watcher, then render from catalog
   queries. The watcher's first rescan is the full reconciliation that catches changes made while
   the app was closed ([windows-adapter.md](windows-adapter.md) §5.2).
2. **External change**: watcher event, debounce, then re-stat. Re-hash only when size or file id
   changed; mtime is only a hint (ADR-0003 §10). Update the catalog and the working-state diff, then
   emit `workspace.changed`.
3. **Import**: dropped paths plus target course and tags, copied by a background job with
   progress, catalogued as they land.
4. **Search**: debounced query, one catalog query (names, paths, tags, full text), top results.
5. **Preview**: the UI asks for a file by catalog id; bytes come through the scoped protocol with
   range support; Office and PDF rendering happens in the UI; thumbnails are cached by content hash.
6. **Commit**: selected changes plus an optional message.
   - The core writes one pack holding blobs for stored files, trees and the commit, then replaces
     `HEAD` (ADR-0003 §3, §11).
   - It optionally asks the AI module for a message, using the template on failure.
   - It emits `history.changed`.
7. **Sync**, one round per ADR-0003 §8:
   1. fetch and verify packs, and find the canonical head;
   2. import direct edits from the mirror;
   3. rebase local commits (conflicts go to the user);
   4. materialise files, with replaced or deleted files going to the Recycle Bin;
   5. push packs, then the intent, then the mirror files, then the head record last.

   It emits progress and a result.
8. **Remote watch**: watch or poll the remote folder. New head records or direct edits raise the
   `↓N` badge. Nothing local changes until the user syncs.

## 4. IPC surface (shape, not the final contract)

The M1 contract is specified in [ipc-m1.md](ipc-m1.md) ([ADR-0004](../adr/ADR-0004-ipc-contract.md)):
there, `fs.changed` is `CatalogChanged`, `job.progress` is `JobChanged`, and `settings.*` is §22.
The shape below still guides the M2 and M3 additions.

- **Commands** (request/response), grouped by module: `library.*`, `entries.*`, `tags.*`,
  `search.query`, `preview.*`, `workspace.*`, `history.*`, `sync.*`, `settings.*`, `ai.*`.
- **Events** (host to UI): `fs.changed`, `workspace.changed`, `history.changed`, `job.progress`,
  `sync.state`, `remote.available`.
- **Errors**: one typed union shared by every command, for example `NotFound`, `InvalidInput`,
  `PermissionDenied`, `FileLocked`, `Conflict`, `RemoteUnavailable`, `PlaceholderNotDownloaded`,
  `Network`, `Cancelled`, `Internal`. Each carries an i18n message key; the UI renders an explicit
  error state (CLAUDE.md §5).
- The contract is defined once and both sides use the same types (CLAUDE.md §5); ADR-0001 decides
  how (shared TypeScript module, or types generated from the privileged side).

## 5. Where state lives

Decided in [ADR-0002](../adr/ADR-0002-data-storage.md) §2; the history layout comes from ADR-0003.
The rule: text files are the source of truth for everything the user authors, and SQLite is a
derived, rebuildable catalog. `<app-id>` is the Tauri bundle identifier.

| Data | Location | Synced | Rebuildable |
|---|---|---|---|
| User files | Library folder | Yes | No |
| Library config, ignore rules, tag definitions | `.folio/library.json`, `.folio/ignore`, `.folio/tags.json` | Yes | No |
| Semester and course settings, tag assignments | `.folio/meta/<semester>/<course>.json` (JSON, one file per course) | Yes | No |
| History: commits and stored versions | `.folio/`, mirrored to the remote (ADR-0003) | Yes | No |
| Catalog, extracted text, full-text index | `%LOCALAPPDATA%\<app-id>\libraries\<library-id>\catalog.sqlite` | No | Yes |
| Thumbnails | `%LOCALAPPDATA%\<app-id>\cache\` (LRU, 2 GB) | No | Yes |
| Settings (per machine) | `%LOCALAPPDATA%\<app-id>\settings.json` | No | No (small) |
| DeepSeek API key | Windows Credential Manager | No | Re-enter |
| Logs | `%LOCALAPPDATA%\<app-id>\logs\` (daily, 7 days) | No | n/a |

## 6. Scale estimates

- **Initial scan**: stat 50k files takes seconds on an SSD. Hashing 100 GB is disk-bound
  (minutes), so it runs as a resumable background job. Later runs hash only files whose size or
  file id changed.
- **Catalog**: 50k rows plus full text of maybe 10k text and Word files — tens of MB of SQLite.
- **UI**: lists are virtualised; the UI holds only the visible page, never the whole catalog.
- **Watcher**: one recursive watch on the library root; on buffer overflow, fall back to a rescan.

## 7. Failure modes

| Failure | Handling |
|---|---|
| Crash during commit or sync | Journalled steps; on restart, finish or roll back, never leave half a record |
| iCloud placeholder not downloaded | Trigger hydration, wait with progress, time out with `PlaceholderNotDownloaded` |
| Head record arrived before its pack, or mirror file not yet updated | Pending, not an error: wait for iCloud and show what is outstanding (ADR-0003 §6, §8) |
| iCloud conflict copies (`name 2.ext`, `name (1).ext`) | Cannot occur in the history area (immutable, device-owned files). In the mirror they are imported and flagged |
| Direct edit on iPad or Mac collides with a push | Import before overwrite: a push never replaces a mirror file that differs from its base record |
| File locked by another app (e.g. Word) | Retry later; show it as pending, not failed |
| Invalid Windows file name from iPad or Mac | Keep it out of the local tree and explain in the sync result |
| Disk full | Abort the job cleanly and report; no partial writes (temp file + rename) |
| DeepSeek unreachable | Template message; commit still succeeds |

## 8. Testing seams

- Core: unit and integration tests against fake adapters and temp directories; golden tests for
  the remote format; property tests for sync ordering and conflict detection.
- IPC: contract tests for validation and error mapping on the privileged side.
- UI: component tests with the IPC mocked; Playwright e2e against the real app with a temporary
  library and data directory per test run (CLAUDE.md §7.5).

## 9. Revisit as the system grows

- Several libraries per machine; ARM64 builds.
- Full-text search for PDF, PowerPoint and Excel; OCR.
- Paid code signing if SmartScreen warnings bother users.
- A Swift macOS app: core reuse versus reimplementing the documented remote format.
- New features in the left rail (deadlines, statistics) as separate core modules.
