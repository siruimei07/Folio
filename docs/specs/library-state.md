# Library state and jobs

Implementation design for `feat/core-library-state`, applying ADR-0002, ADR-0004 and
[ipc-m1.md](ipc-m1.md) sections 6, 13–15 and 18. IPC shapes remain unchanged. The prerequisite
Tauri 2.12 upgrade and roadmap step 0.5 are on `origin/main` at `ce27ffd`.

## Command ownership

Each feature owns its handlers, test-only planned declarations, runtime registration and build
manifest list under `crates/folio-app/src/commands/`, and its capability in `capabilities/`.
The composition layer wires the known M1 groups once. Export paths remain stable as a group
replaces a stub with its handler. Browse, operations, file scheme and import lanes only change
their group files. Planned functions compile only in tests and remain absent from the runtime
manifest and capabilities. The runtime/declaration/grant equality and no-default-sets tests
remain mandatory. All grants target `main`; the page receives no filesystem/dialog plugin.

The operations lane additionally owns `folio-core::library::operations`, course metadata and
catalog migration 2 (Sirui approved the narrow supporting files on 2026-09-29). Core returns
typed results plus `CommittedScan` deltas; its list calls emit no change. The operations shell
hooks and `library_status` retry build on landed `feat/core-file-scheme` (main 1ebd2ad),
reusing its guarded `with_entry` transition pattern. This approval does not transfer
browse/search query or generated-binding ownership.

## State and threads

```text
Tauri command -> validate -> spawn_blocking -> LibraryState
                                               | transition gate
                                               v
                                   one active library session
                              Library + Arc<Catalog> + job registry
                                     |              |
                       Windows watcher -> coalesced work -> blocking worker
                                               |
                              committed report -> revision and event emitter
```

`LibraryState` holds startup completion, a transition gate, choice tokens and the active session.
Its state lock only protects snapshots/handle replacement, never disk I/O or a thread join.
Startup opens the configured root before resolving `library_status`. Missing/unsupported roots
produce `Unavailable`, with the reason decided where opening failed (ipc-m1 §6); a missing
settings file means `None`. Settings failures are explicit
`DataDirUnavailable` errors, never silently treated as first run.

One session serializes scans, scoped rescans, hashing and rebuilding on a blocking worker. The
watcher callback only merges pending work and wakes the worker. This prevents two disk walks
from committing stale snapshots in reverse order. Reads and cancellation remain available;
SQLite's existing WAL readers and single writer remain the storage boundary. No new runtime,
database pool or dependency is needed. Revisit concurrent hashing only after measuring delay.

Operation execution must serialize with the entire worker disk walk and commit, validate each
entry's id and exact path in the action's transaction, and drain before switching/shutdown.
The catalog writer lock alone does not stop an older disk walk committing afterwards. A
successful operation's returned committed report uses the existing revision/event merger.
Authored edits reuse atomic Layout writers; multi-file partial I/O failures leave those files
authoritative and require reconciliation. A successful disk action followed by catalog failure
returns `DiskChanged`; the shell schedules recovery rather than claiming the disk rolled back.
Metadata-only edits return `RecoveryRequired` when an authored write succeeds before later
reconciliation fails. A batch stops if continuing is unsafe and reports each remaining item
as not attempted; no requested item disappears from its failure list.

The worker and commands share a session operation mutex through each complete disk walk,
metadata edit and catalog commit. WAL list reads remain available during rebuilding. Failed
disk/metadata reconciliation queues a full scan and blocks further writes until it succeeds;
a write refused meanwhile asks for that scan again if the user cancelled it. An ambiguous
journal fails the session closed. Before work or a mutation, explicit move-intent
recovery commits and publishes its own report, so a later failed scan cannot hide that commit.
All command work runs through the existing blocking-task boundary. Pending event wakeups
hold the worker's wait mutex. A write takes its session under the transition but waits for
the operation mutex outside it, so a write queued behind a long walk or hash job holds up
no list read, file action, switch or close; the session drain waits for a running write, and
a later one finds the session stopped.

Discarding an unfinished move (Sirui, 2026-09-30). A retained move intent that recovery
cannot reconcile keeps the library unavailable (`catalogFailed`), and a rebuild cannot bypass
it, so today the only way out is removing `.folio/local/journal/scan.json` by hand. The user
gets an explicit, confirmed action instead: wave 3 lane `feat/core-discard-move` (roadmap
§2, task board) adds its own unavailable reason and the command, and `feat/ui-first-run` shows
it on the library-unavailable screen. Discarding never moves or deletes the user's files and
never overwrites an authored metadata file that no longer matches the journal's images; it
removes the journal, and a full scan rebuilds the catalog from the disk and authored metadata.

Retry applies only when status was unavailable at call entry (ipc-m1 §6). It reopens the
configured root behind the transition gate without saving settings or consuming a choice.
Startup and concurrent calls share one attempt, even if it fails with the identical reason;
an attempt generation distinguishes that case. Success publishes a fresh session/startup scan,
failure returns this attempt's reason, and shutdown cannot resurrect a session. None/open
statuses are read unchanged.

The watcher starts before startup reconciliation. Its first `Full` event consumes the queued
startup scan job; there is no second independent startup scan. Scoped/metadata rescans are not
jobs. Pending rescans merge by the watcher's own rule (`Rescan::merge`: outermost scopes, their
common folder beyond eight, else a full rescan). A full rescan's job is queued under the worker's
wait lock, so shutdown's cancellation always sees it.
Watcher failure marks the active library unavailable and reports the failure; it cannot leave
an apparently current catalog. A later open establishes a fresh watcher and full reconciliation.

## Persistence and choices

Core-owned, versioned `settings.json` lives in the resolved per-machine data directory. Its
library path is absolute. Use bounded JSON reads and the existing atomic-write helper with
staging on the same volume. Unknown future versions fail without overwriting. Preserve fields
belonging to later settings lanes. Catalog location is `libraries/<library-id>/catalog.sqlite`.
Switching libraries and App settings (ipc-m1 §22) both write the file, each through
`Settings::update`, which loads, changes and saves it under one lock for the process; the App
settings fields read a value they do not know as their default.

The Windows folder dialog returns a native path to the shell only. A debug-only environment
override supplies the dialog result for isolated e2e tests. The shell canonicalizes the choice,
classifies existing/ancestor libraries and cloud sync roots, and issues a random 128-bit token.
Tokens expire after ten minutes, are consumed once, and are invalidated when the library changes.
Commands never accept an absolute path. Revalidate the selected root when consuming a choice.
The shell keeps canonical `\\?\` paths; every path it sends to the UI drops that prefix. The
sync-root label only warns: a failed lookup is logged and gives no label, never a refused choice.

Creation validates and NFC-normalizes all names before writing. It creates the `.folio`
directory, writes presets, then publishes `library.json` last using atomic writes.
Existing content is neither moved nor deleted. Existing or nested libraries are refused. A
failed creation leaves recoverable metadata and reports the exact failure; choosing the folder
again reports it `incomplete`, and creation finishes it in place, keeping what `.folio` holds
(ipc-m1 §6, 2026-09-29). The transition gate serializes creations in one app. The settings file
is updated only after the chosen library and catalog have opened successfully. Switching waits
for the previous session to quiesce before the new session can publish events. If the new
session fails, the shell reopens the library `settings.json` still names, so the running state
matches the settings; the command still returns its error.

Before reading or recovering metadata, reject symbolic links and junctions in owned metadata
paths, including `.folio/meta/` parents and `.folio/local/` staging/journal parents. Repeat the
check inside the writer boundary after walking files. Cloud placeholders that do not redirect
names retain the existing adapter policy. This is protection against a library containing
links, not an OS sandbox against a concurrent same-user process replacing directories between
validation and access.

## Jobs, commits and problems

Jobs have random identifiers, one active job per kind, cancellable flags and the existing
queued/running/done/failed/cancelled union. Return active jobs before the last 20 finished jobs.
Emit transitions immediately; progress events are limited to one every 250 ms. Cancelling an
unknown/finished job is `NotFound`; a non-cancellable job is `InvalidArgument`. Cancelling a
queued job finishes it as cancelled at once, and the worker skips it; a running job stops at
its next check. The worker moves a job to running when it starts the work.

Scan control checks cancellation between visited entries and before starting a catalog
transaction. Once metadata journal publication starts, finish or roll back the transaction
without cancellation. Hashing reuses its cancellation flag and batch commits. Fresh files are
retried after the core's freshness window, with bounded scheduling; placeholders remain pending
without hydration or a busy retry loop.

Core reports include the actual widened scan scope and committed entry identities, including
the old reference for removals and stable identity for moves. Tag/group mirror changes are
reported in the same transaction. The shell advances the revision only after committed
changes, merges notifications to at most ten per second, and limits entries to 200 with
`complete: false` on overflow or rebuild. Events are scoped to the active session.

Problems replace the latest results of the actual scanned scope, while metadata and hashing
results retain their own scope. Unchanged problems retain their identifiers. Pagination checks
the shared page-size limit and reads the revision together with its snapshot. Changes emit
`ProblemsChanged`, even when the count stays the same.

Rebuild clears derived catalog content transactionally on the existing catalog, after settling
any metadata journal. This avoids replacing SQLite files beneath live readers. Keep metadata,
library identity and derived-format versions; clear first-scan state so file creation times
are recovered. Entry allocation retains a high-water mark across resets so old references
cannot identify rebuilt entries; each batch reserves its ids with one read and one write. Report `Busy` for writes while rebuilding, expose growing
reads, and send a full invalidation. Cancellation may leave a valid partial/empty derived
catalog; the next full scan reconstructs it from source files.

## Shutdown

The native close request belongs to the shell. Prevent the immediate close, reject new work,
stop the watcher, cancel queued/running cancellable jobs and wake/join workers off the UI
thread. Finish any in-flight atomic metadata write or SQLite commit before destroying the
window. The page's close listener cannot veto the final destroy. Exit requests use the same
idempotent shutdown path. Switching libraries uses the same session drain, without exiting.
No forced timeout kills a writer halfway through a transaction.
Every condition-variable predicate change holds its wait mutex, including activation and
shutdown, so a wakeup cannot be lost between testing the predicate and beginning the wait.
Library locks recover from poisoning: a panic elsewhere must not stop a drain, and shutdown
always marks the app closed so the final exit request is not held back.

## Verification and handoff

- Rust contract tests cover every implemented command, validation codes, expired/replayed
  choices, create/takeover/open/startup failures, jobs/cancellation, problems and rebuild.
- Core regressions cover pre-commit cancellation, committed removed/moved identities, actual
  scopes, metadata deltas and stale identities after rebuild. Existing scan/hash tests remain.
- Temporary-folder e2e creates through the real IPC surface with the debug dialog double,
  observes an outside change via `CatalogChanged`, and closes with active work. Planned-command
  and least-privilege regressions remain enabled.
- Run targeted checks, then coordinated `pnpm check` and app-locked `pnpm e2e`. Combined-workspace
  results are identified as such. Coordinate generated bindings with their current owner and
  verify that this lane leaves the existing IPC types and exported bindings unchanged.
- Codex code/security/simplification passes precede `Status: review`. A Claude Code session
  still runs `/code-review`, `/security-review`, `/simplify`; Sirui approves landing separately.

Platform references: [Tauri capabilities](https://v2.tauri.app/security/capabilities/) and
[IFileOpenDialog](https://learn.microsoft.com/en-us/windows/win32/api/shobjidl_core/nn-shobjidl_core-ifileopendialog).
