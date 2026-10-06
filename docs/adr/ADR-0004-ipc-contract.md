# ADR-0004: IPC contract for M1

- **Status:** Accepted (Sirui, 2026-09-28)
- **Date:** 2026-09-27
- **Deciders:** Sirui Mei
- **Inputs:**
  - [`docs/specs/ipc-m1.md`](../specs/ipc-m1.md), the contract this ADR shapes;
  - [ADR-0001](ADR-0001-application-stack.md) §3–§4 and action item 5,
    [ADR-0002](ADR-0002-data-storage.md), [ADR-0003](ADR-0003-versioning-and-sync.md) §7, §10;
  - [`docs/specs/library-core.md`](../specs/library-core.md),
    [`docs/specs/library-scan.md`](../specs/library-scan.md),
    [`docs/design/handoff/app-shell.md`](../design/handoff/app-shell.md);
  - Tauri 2.11.6 and tauri-specta 2.0.0-rc.25 sources, read on 2026-09-27.

## Context

M1's UI and core lanes are about to run in parallel, so the contract between them lands first
(CLAUDE.md §7.3, rule 11). ADR-0001 settled the mechanism: Rust types are the source of truth,
tauri-specta generates the TypeScript, commands never reject. This ADR settles the shape of the
contract where a change later would touch both sides of every feature.

Forces:

1. **The UI is untrusted** (CLAUDE.md §5). Previews render hostile files, and a script that gets
   into the main window has its IPC grants. Whatever the UI can name, a compromised UI can name.
2. **Catalog ids are not durable.** The catalog is derived and rebuildable (ADR-0002 §1), a
   rebuild numbers entries anew, and SQLite reuses the highest rowid once its entry is gone
   (`entries.id` is an `INTEGER PRIMARY KEY` without `AUTOINCREMENT`).
3. **Scale.** 50,000 entries, virtualised lists, search about 200 ms after typing stops.
4. **Things change underneath the UI.** Other programs edit the library (brief §5.1); scans run in
   the background; a list can be stale by the time the user acts on it.
5. **Platform facts** (ADR-0001 action item 5, Tauri sources):
   - Tauri treats pages of app-registered schemes as local, with the window's permissions, and
     wry injects the IPC script into every frame.
   - Tauri's drop handler forwards dropped paths to the page and adds them to the asset-protocol
     and file-system scopes.
   - With an app ACL manifest, Tauri rejects any app command that is not granted, before
     dispatch.
   - Windows opens a file with the program registered for it, and for `.bat`, `.js` or a `.py`
     associated with Python that program runs the file.
6. **Existing shape.** `AppError` serializes as `{ code, detail }`, and shell code constructs its
   variants as tuple variants (`AppError::Window(detail)`).
7. **The UI lanes need typed functions before the implementations exist**, and each command must
   still get a security review when it gains behaviour.

## Decision

1. **Entries are named by reference.** The UI sends `{ id, path }` exactly as the shell gave it.
   The shell acts only if the catalog has that id at that path, checked in the transaction that
   acts; otherwise `NotFound`. The UI never sends an absolute path (spec §5.1).
2. **Places outside the library come from the user, through the shell.** Folder and file dialogs
   run in the shell, and the shell receives dropped files itself. The UI gets a single-use choice
   token, bound to its kind and forgotten after 10 minutes (spec §4.2).
3. **One change event with a revision.** Every committed catalog change bumps a per-library
   revision counter. `CatalogChanged` carries the revision and up to 200 entry changes (id, path,
   kind of change), with `complete: false` when it holds fewer than happened; pages carry the
   revision they were read at (spec §15).
4. **Offset pages with totals.** List commands take `{ offset, limit }` and return the total and
   the revision. Search pages slice one ranked window of at most 500 results (spec §5.3, §10).
5. **Background work is jobs.** Scans, hashing, imports and catalog rebuilds share one registry,
   one `JobChanged` event, `list_jobs` and `cancel_job` (spec §13).
6. **File bytes come from a read-only `folio-file` scheme**, not IPC messages: catalogued files
   only, addressed like references, with `Range`, `nosniff`, `no-store` and
   `Content-Security-Policy: sandbox; default-src 'none'` on every response. Only the main
   window's CSP admits the scheme (spec §11.2).
7. **The error union stays flat:** `{ code, detail }`, one code for each case the UI words
   differently; batch commands return per-item failures instead of richer errors (spec §16).
8. **Contract before implementation.** Every planned command is declared with its final signature
   and exported to the bindings, but is not registered at runtime, not in the app manifest and not
   granted. Its implementation lane adds all three with contract tests and `/security-review`; a
   test keeps the three lists equal (spec §3).
9. **Opening a file never runs code.** Programs and scripts whose registered program is an
   interpreter open with their "edit" verb, or not at all (`Blocked`); everything else opens with
   its default program (Sirui, 2026-09-27; spec §11.1).

## Options considered

### 1. Naming entries

| Option | Verdict |
|---|---|
| Catalog ids only | Short and stable across moves, but a stale id can name another file after an id is reused or the catalog is rebuilt |
| Library-relative paths only | Durable and what the user sees, but a UI still holding a path after a rename and a new file at that path acts on the new file; list keys change on every rename |
| `AUTOINCREMENT` ids plus a catalog generation | Stops reuse within one catalog, but needs a generation in every id to survive rebuilds: more state than a path check |
| **`{ id, path }`, both checked (chosen)** | Acts only on the entry the UI showed; stale references fail loudly; ids stay stable list keys |

### 2. Places outside the library

| Option | Verdict |
|---|---|
| Absolute paths from the UI (a dialog plugin, or the paths Tauri forwards on drop) | A compromised page could import any readable file, then preview it, or send any file to the Recycle Bin with "delete originals"; the shell cannot tell a path the user chose from one a script made up |
| Tokens valid for the whole session | Replayable for no gain |
| **Shell-owned dialogs and drops, single-use tokens (chosen)** | The user's gesture in Windows UI is the grant; the shell validates a token, not a path |

### 3. Change notification

| Option | Complexity | Assessment |
|---|---|---|
| "Something changed" only | Low | Every view refetches on every outside save; the preview cannot follow a moved file |
| Full deltas with rows | High | The UI would re-sort, re-filter and re-count pages itself, duplicating the catalog's queries; payloads grow with the change |
| **Revision and a capped change list (chosen)** | Medium | The UI refetches only the pages a change touches, follows moved and removed entries, and refetches everything when the list is incomplete |

### 4. Pagination

| Option | Verdict |
|---|---|
| Whole lists | Up to 50,000 rows per call |
| Keyset cursors | Stable under inserts and cheap at any depth, but no totals or jumps, which virtualised lists with scroll bars need; cursors over nullable sort keys are fiddly |
| **Offset windows with a total and the revision (chosen)** | Jump anywhere and size the scroll bar; a deep offset costs a scan of the index, tens of milliseconds at 50,000; the revision says when windows stop agreeing |

For search, re-ranking a larger candidate set for each page would let pages overlap or skip,
because the recency boost reorders candidates (library core §6). A fixed window of 500 keeps
pages of one revision consistent.

### 5. Background work

| Option | Verdict |
|---|---|
| A Tauri `Channel<T>` per call | Ordered and fast, but it dies with the page, and work the shell starts itself (the start-up scan) has no call to attach to |
| **A job registry with one event (chosen)** | One model for every kind of work; the UI rebuilds its view after a reload with `list_jobs` |

### 6. File bytes for previews

| Option | Complexity | Assessment |
|---|---|---|
| IPC responses (JSON, or raw `tauri::ipc::Response`) | Low | Whole files through the IPC bridge and no `Range` for audio and video; tauri-specta cannot type raw responses |
| Tauri's asset protocol (`convertFileSrc`) | Low | Built in, with `Range`, but scoped by path globs rather than by the catalog: it would serve `.folio/` and ignored files under the root, and drops widen its scope on their own |
| **Own read-only `folio-file` scheme (chosen)** | Medium | Serves catalogued files only, addressed like references; Folio sets the headers, including a `sandbox` CSP, so a document from the scheme cannot script or reach IPC |

### 7. Errors

| Option | Verdict |
|---|---|
| Structured errors (`detail` as an object, or extra fields) | Could carry names and rules, but `detail` would have two types, and the shell's existing tuple variants would have to change |
| **Flat `{ code, detail }`, one code per worded case (chosen)** | One message per code; batch results already say which item failed; the shape stays |

### 8. Commands that are not implemented yet

| Option | Security | Verdict |
|---|---|---|
| Register and grant placeholder handlers | About 35 new callable commands; later diffs change behaviour behind grants that already exist, so nothing marks the review point | Rejected |
| Export types only | No change | The UI gets no typed functions and would hand-write `invoke` calls: a second copy of the contract |
| **Declare for the bindings only (chosen)** | No change: no handler, no manifest entry, no grant; stubs compile only in tests; the ACL rejects calls before dispatch | Typed functions now; the grant arrives with the code and its review |

### 9. Opening files

| Option | Verdict |
|---|---|
| Always the default program, like a double-click in File Explorer | Runs `.bat`, `.js` and Python-associated `.py` files; a compromised page could rename a text file to `.bat` and open it |
| Refuse every script type | Also blocks code files that open in an editor, such as `.py` in VS Code |
| **Never run programs; scripts only if their program is not an interpreter; otherwise the edit verb or `Blocked` (chosen)** | Sirui's choice (2026-09-27): editing stays one click, running never is |

## Trade-off analysis

- **Security against a little code.** References, tokens, the own scheme and the open policy each
  add a check or a small module to the shell. Together they limit a compromised UI to what the user
  could do through Folio's own buttons: it can reach catalogued files only, cannot pick outside
  paths, and cannot run anything.
- **Offsets against cursors.** Offsets cost a scan for deep pages and can shift under concurrent
  changes; the revision makes the shift visible, and 50,000 entries keep the scan short. Keyset
  paging would return if libraries grow by an order of magnitude.
- **One event against precise deltas.** The UI refetches a little more than a delta-applying UI
  would, in exchange for a UI with no second copy of the catalog's sorting and filtering.
- **Contract first against drift.** Declared-but-unregistered commands can drift from what the
  implementation lanes need. Each lane may change its commands' signatures with a spec update; the
  drift test keeps the bindings honest.

## Consequences

**Easier**
- UI lanes build against typed functions and a browser mock now; core lanes implement against a
  fixed shape.
- Security reviews have one place to look per command: the change that grants it.
- The UI's cache logic is generic: pages keyed by request, invalidated by revision and change list.

**Harder**
- Two command lists (export and runtime) and a test that keeps them, the manifest and the grants in
  step.
- The shell owns dialogs, drop handling, a URI scheme, a job registry and a revision counter.
- Every mutation checks references inside its transaction.

**Revisit when**
- A second window or webview appears: scope event targets and choice tokens to the window.
- Several libraries per machine: references and tokens gain the library id.
- Libraries grow far beyond 50,000 entries: keyset pages for deep lists.
- Tauri 3 or a tauri-specta release changes schemes, the ACL or typed errors.

## Action items

1. [x] Sirui approves; set Status to Accepted.
2. [x] Contract lane (`feat/ipc-m1-contract`, 2026-09-27): types in `crates/folio-app/src/ipc/`,
   regenerated `bindings.ts`, UI wrappers in `apps/desktop/src/ipc/`, the placeholder test.
3. [ ] Implementation lanes of spec §21, each registering and granting its commands with contract
   tests and `/security-review`.
   - 2026-09-28, `feat/core-library-state` (§21 item 1): the 8 library and job commands,
     registered per feature group (`commands/<group>/manifest.rs`, `capabilities/<group>.json`);
     contract tests and `/security-review` passed. Remaining: items 2–6 (item 6's watcher part is
     in: scoped scans already feed `CatalogChanged`).
   - 2026-09-30, `feat/core-library-ops` (§21 item 3): the 18 semester, course, tag and entry
     commands in their own group (`commands/operations/manifest.rs`,
     `capabilities/operations.json`, main window only) and the `library_status` retry; contract
     tests, `/code-review` and `/security-review` passed, bindings unchanged.
   - 2026-10-01, `feat/data-browse-queries` (§21 item 2): `list_children`, `list_files`,
     `get_entry`, `search` and `resolve_paths` in the browse group (`commands/browse/manifest.rs`,
     `capabilities/browse.json`, main window only). Pages and events carry the catalog's commit
     stamp (§15.2); search snippets come from a browse-local FTS5 function. Contract tests,
     `/code-review` and `/security-review` passed, bindings unchanged. Remaining: items 4–6.
   - 2026-10-02, `feat/core-import` (§21 item 4): the three import commands and individual
     main-window grants, native choices/drops, FIFO jobs and verified-copy recovery are
     implemented locally. Codex code/security/unsafe/simplify reviews, `pnpm check` and
     app-locked `pnpm e2e` (40/40) passed; bindings are byte-identical. Separate Claude Code
     audit remains pending; the lane has not landed.
   - 2026-10-03, `feat/core-discard-move` (§21 item 10): `unfinishedMove` and
     `discard_unfinished_move` are implemented locally with the contract and individual
     main-window grant. Discard keeps user files untouched, restores only eligible metadata
     images and retains the record/status on failure. Generated bindings, fake-shell drift
     and crash/retry/concurrency tests pass. Codex code/security/simplify reviews,
     `pnpm check` and app-locked `pnpm e2e` (44/44) passed. Separate Claude Code audit is
     pending; neither this lane nor its final UI action has landed.
   - 2026-10-04, `feat/ipc-m2-contract`: the M2 contract
     ([`ipc-m2.md`](../specs/ipc-m2.md)) under this ADR's decisions: 25 commands in three new
     groups (`workspace`, `history`, `ai`) declared as test-only stubs, with empty manifests and no
     grants (decision 8), the events `WorkspaceChanged`, `HistoryChanged` and `AiSettingsChanged`,
     29 new error codes (decision 7), the `folio-file` version route (decision 6), and the fake
     shell's M2 scenarios. No command gained power. Sirui's decision of 2026-10-04: storing an AI
     key for a service other than DeepSeek asks the user in a Windows dialog (ipc-m2.md §12.3).
   - 2026-10-06, `fix/core-recycle-icloud-startup`: a cloud provider that refuses to move an item
     for now (iCloud for Windows for about 20 minutes after it starts) is the core's new
     `RecycleFailure::CloudBusy`, which `delete_entries` and an import's replace report as the
     existing `InUse` (ipc-m1.md §9.2, §16.1, §16.2) until `feat/ipc-recycle-cloud-trash` gives it
     a code of its own. No command, grant or binding changed. Independent audit (code and security)
     and `/simplify` passed.
4. [x] Operations lane: amend ADR-0002 and library core §4.2 for the course code, optional badge
   text and colour, 1–3 character badges, and palette keys for preset tags (spec §20).
5. [ ] Preview lane: the `folio-file` scheme, the main window's CSP sources, and an e2e test that
   the preview frame cannot load the scheme.
6. [ ] Import lane: shell-side drop handling, `dragDropEnabled`, and the replacement for the test
   `main_window_does_not_publish_native_drag_paths` (spec §17).
   - 2026-10-01, `feat/core-import`: native choices/drop handling, per-command grants, FIFO import
     jobs and guarded verified publication are implemented locally. The replacement regression
     keeps the asset protocol/filesystem plugin off; unknown commands still have no grant.
     `imported` includes replaced/renamed files (spec §12). Rust checks and 24 app-locked e2e
     tests passed in the combined workspace. The latest `pnpm check` remains blocked by the
     concurrent UI lane's lint errors. Completion awaits that gate and the separate Claude Code
     `/code-review`, `/security-review`, `/simplify` handoff; this record does not approve landing.
