# Testing strategy

Living document. Update it when a new kind of test or tool is added.

- Inputs: [ADR-0001](../adr/ADR-0001-application-stack.md) (stack, e2e over CDP),
  [ADR-0002](../adr/ADR-0002-data-storage.md) (catalog, migrations, tokenizer),
  [ADR-0003](../adr/ADR-0003-versioning-and-sync.md) (history, sync, simulation harness),
  [system overview](system-overview.md) §8.
- Policy: CLAUDE.md §4.2 (pipeline) and §8 (definition of done).

## Principles

1. **Test where data can be lost.** Most tests belong to `folio-core`: metadata, catalog, history,
   sync, search. A bug there costs user files; a bug in a button costs a click.
2. **Deterministic by default.** Automated tests never touch the network, real iCloud or the
   user's data.
   - The core reaches the OS through adapters (system overview §2), so tests use fakes and
     temporary directories.
   - Property tests use recorded seeds.
3. **Isolated data.** Every test and every lane gets its own temporary library and data directory
   (CLAUDE.md §7.5). The app honours `FOLIO_DATA_DIR` for that purpose.
4. **Every bug fix ships with a regression test** in the lowest layer that can reproduce it.
5. **Checks run locally before landing.** Lanes land with `but land`, without pull requests, so CI
   on `main` is the backstop. Run `pnpm check` (all checks below except e2e) and `pnpm e2e` before
   asking Sirui to land.

## Layers

| Layer | Tool | What it covers | When it runs |
|---|---|---|---|
| Core unit | `cargo test` | Pure logic: path normalisation, canonical JSON, hashing, pack encode/decode, merge rules, tokenizer, ignore evaluation | Every change; CI |
| Core property | `proptest` | Invariants such as `decode(encode(x)) == x`, tokenizer offsets on character boundaries, contiguous-substring matching, rebuilt catalog equals incremental catalog | Every change; CI |
| Core integration | `cargo test` with temp dirs and fake adapters | Migrations (`validate()` plus one fixture per released schema), metadata formats including older and newer `format_version`, commit and restore on a temp library, watcher reconciliation. The formats v0.1 released are frozen in `crates/folio-core/tests/fixtures/formats/v0.1/` and opened by `tests/format_fixtures.rs` (ADR-0002 §3) | Every change; CI |
| Golden vectors | `cargo test` | History format: fixed inputs must produce fixed ids and bytes, and every refused input is refused (ADR-0003 §13). The vectors are language-neutral JSON in `docs/specs/remote-format-vectors/v1/` ([remote-format.md](remote-format.md) §12) | CI |
| Sync simulation (M3) | `cargo test`; long runs nightly or on demand | ADR-0003 Action item 3: eventually consistent fake remote, two devices plus an iPad writer, crash injection at every journal step | Short seeds on every change; long runs nightly |
| IPC contract | `cargo test` in `folio-app` | Every command rejects bad input (paths outside the library, oversized values) and maps failures to the typed error union. Generated bindings match the Rust types. The commands Tauri runs are exactly those in the app manifest and the capabilities; planned ones are in none of them ([ipc-m1.md](ipc-m1.md) §3, §19) | CI |
| UI component | Vitest + Testing Library (jsdom), user-event | Small components with the `ipc` module mocked (`vi.mock`); views and data hooks with `renderApp` / `renderAppHook` (`src/test/render.tsx`) against the fake shell; loading, empty, error and success states from the handoff specs. `tsc` (part of `pnpm check`) fails on a `t()` key that the `en` locale lacks | Every change; CI |
| Data layer and fake shell | Vitest | `src/data/`: touch predicates for every event kind, revisions across the wrap, reference following, paged lists, jobs; `src/ipc/mock/`: the fake shell against the contract through the real bindings, and its drift test (below) | Every change; CI |
| UI in a browser | Vite dev server with the fake shell (`src/ipc/mock/`) | Design and accessibility reviews in the browser pane on realistic data (`?scenario=` `small`, `large`, `first-run`, `read-only`, `unavailable`, `errors`); fast full-Chromium checks | Local |
| End to end | Playwright over WebView2 CDP | The real app: start-up, IPC round trip, one flow per user-facing feature, keyboard use, reduced motion | CI after the build |
| Accessibility | `@axe-core/playwright` (4.13, installed in `e2e/`) inside e2e specs, plus `design:accessibility-review` in the browser pane | WCAG 2.1 AA: no serious or critical violations | CI; before a UI lane is done |
| Manual | Written test plans | Real iCloud (ADR-0003 Action item 4), installer and updates, SmartScreen | Before releases |

## Coverage targets

- `folio-core` modules for storage, metadata, history, sync and search: at least 80 % line coverage,
  measured with `cargo llvm-cov` once the first real module lands. Every merge rule and every error
  path has a test.
- IPC: every command has a contract test.
- UI: every state named in a handoff spec has a component test.
- E2E: at least one flow per user-facing feature.
- Not tested directly: Tauri and React internals, generated bindings, and one-off scripts.

## Fake shell

`apps/desktop/src/ipc/mock/` implements every M1 command and event on an in-memory library, below
the generated bindings (`@tauri-apps/api/mocks`), so the real `ipc` module runs unchanged (UI
architecture §11). It serves two layers:

- **Browser pane.** `main.tsx` installs it when the dev server's page runs outside Tauri. URL
  parameters pick the fixture, latency and forced failures (`src/ipc/mock/scenarios.ts`); the
  console can drive it through `window.__FOLIO_FAKE_SHELL__` (`finishJobs()`, `dropFiles()`,
  `setProblems()`, `makeUnavailable()`). `.claude/launch.json` has `desktop-vite` (starts the
  dev server) and `desktop-browser-pane` (attaches to a running one; CLAUDE.md §7.5).
- **View tests.** `renderApp(ui, { scenario, fixture, fail, now })` and `renderAppHook(hook, …)`
  give a fresh query client, the providers and a fake shell; `src/test/virtual.ts` gives elements
  a box so virtualised lists render rows in jsdom. `now` is the time the fixtures count from, the
  fake shell dates new entries with and `Date` starts at (it keeps running), so dates the UI works
  out, such as "Recently added", match the fixtures whatever the real time.

Fixtures: `small` (hand-written), `large` (50,000 entries from a seeded generator), `first-run`
(no library; the folder dialog answers with each kind of folder), plus `read-only`,
`unavailable` and `errors` variants.

**Drift.** The fake is typed by `bindings.ts`, so a changed command shape fails `tsc`.
`src/ipc/mock/contract.test.ts` also fails whenever `bindings.ts` changes at all (doc comments
included) until the fake is compared with the change and the new fingerprint is recorded in
`src/ipc/mock/contract.ts`; the failure prints the value. Only contract lanes change
`bindings.ts` (roadmap §4 rule 2), and they update the fake and the fingerprint in the same
change, so `pnpm check` passes on every land; implementation lanes, Codex's included, leave the
file as it is. E2E runs on the real shell and checks that the app has no fake shell
(`e2e/tests/fake-shell.spec.ts`).

## End-to-end harness

Follows Playwright's WebView2 guide (ADR-0001 §7). The contract is below; `e2e/fixtures.ts` has
the details.

1. **Build.** Build the UI, then the debug app (`folio-app.exe`).
2. **Launch.** Every test starts its own app with a fresh `WEBVIEW2_USER_DATA_FOLDER`, a fresh
   `FOLIO_DATA_DIR`, and a remote-debugging port chosen by the OS, so parallel runs (other
   workers, other lanes) never attach to each other's app.
3. **Connect.** Attach with `chromium.connectOverCDP` once the app has loaded its page.
4. **Teardown.** Stop the app and delete the temporary folders.

Known limits:

- `connectOverCDP` has lower fidelity than a normal Playwright connection.
- Native dialogs cannot be driven. Keep them behind an adapter so e2e can inject the result.
- CI runs one worker until run times are known.

Specs that reach the desktop (`e2e/desktop.ts`) run on CI, and locally only with
`FOLIO_E2E_DESKTOP=1`: a native file drop presses, moves and releases the mouse for about two
seconds (Windows starts a drag only while a button is down), and an import that recycles its
originals adds files to the Recycle Bin. `tests/performance.spec.ts` runs only with
`FOLIO_E2E_PERF=1` (below).

## Performance

Targets (brief §9, M1 acceptance): a page of 200 rows under 50 ms, a page of search results under
100 ms, a common file previewed within 1 s, on a library of 50,000 files.

How to measure, in a quiet window: the app lock held, no other `cargo`, `rustc`, `link`,
`folio-app` or pnpm/Vite/Vitest/Playwright process for 30 s before and during the run (sampled
every 2 s; a run that saw one is repeated), and Defender's state recorded, never changed.

- Core, release build: `cargo test -p folio-core --release --test search_benchmark --
  --ignored --nocapture browse_and_search_pages` (a 50,000-entry catalog; it fails past the two
  targets) and `--test scan_benchmark` (49,920 files of 2 KB on disk, the Markdown, text and Word
  files holding Chinese and Latin notes; first scan, rescan, hashing, text extraction, a pass with
  nothing to extract, a course rename before and after extraction). Run the built test binaries
  directly, so no `cargo` process competes.
- The workspace, release build: the folio-core lib test `workspace::bench` (`cargo test -p
  folio-core --release --lib --locked --no-run`, then the binary with `workspace::bench --ignored
  --nocapture --test-threads 1`): 49,920 files in the scan benchmark's shape on a MemFs with a real
  catalog, course settings and a tag on every eighth file; the refresh the shell's tracker runs on
  a notification, and the commands from its cache. It fails past 100 ms with a few changes and
  500 ms when everything changed (versioning.md §2). 2026-10-07, feat/core-workspace after its
  audit fixes (head sync in runs, no unpaired index, the disk-files digest and link check on every
  refresh), this machine, undisturbed but for another lane's idle Vite dev server, median /
  slowest: refresh 63 / 64 ms with nothing changed, 61 / 63 ms after a few changes of every kind (19
  items, 2 metadata rows), 66 / 67 ms after a course rename; every file edited 200 / 204 ms before
  hashing and 147 / 154 ms after, every file renamed 217 / 218 ms, every semester renamed 117 / 118
  ms, everything deleted 57 / 57 ms, everything written again (every row paired again by path, one
  run) 265 ms; head sync 350 ms the first time, 422 / 435 ms forced after a rebuild, 42 / 43 ms with
  `HEAD` already in the catalog; from the cache a 200-row page under 0.01 ms, a summary of 49,920
  items 8–11 ms, the comparison with the last snapshot sent 6–9 ms; a commit's tree of everything
  (`apply`) 64 ms.
- The app: `e2e/tests/performance.spec.ts` with `FOLIO_E2E_PERF=1` on an optimised build that
  keeps the debug-only test hooks (`CARGO_PROFILE_RELEASE_DEBUG_ASSERTIONS=true`, its own
  `CARGO_TARGET_DIR`, `tauri build --no-bundle`; `FOLIO_APP_PATH` names the exe). It writes the
  same 49,920 files plus five common files, takes the folder over, and times the first scan, IPC
  round trips of a 200-row page and a 50-result search page, and five clicks on each common file
  until it is rendered. It fails past 1 s for a preview.

Results, 2026-10-03, gate `gate/m1-acceptance` at `6775b0a`: main `27b3cda` plus the gate's first
four commits (`bb48159` on main, after a rebase that changed docs only). DESKTOP-N7UG6S7: Intel Core Ultra 7 270K Plus (24 cores), 32 GB, WD Blue SN5000 NVMe,
Windows 11 Pro 26200, Defender real-time protection on; Rust 1.97.1, Node 24.19.0, SQLite 3.53.2
(libsqlite3-sys 0.38.2), WebView2 154.0.4258.53. Times are median / slowest; every run undisturbed.

| Measure | Core benchmark (release) | The app (optimised, IPC included) | Target |
|---|---|---|---|
| A page of 200 rows | 7.6–38.5 ms by sort key and filter; slowest 39.9 ms (size, descending) | 27 / 28 ms by name, 19 / 19 ms by size | < 50 ms |
| A page of 50 search results with highlights | Slowest 57.9 ms (the commonest character, whole library); two characters 28.7 ms; Latin 18.6 ms | 讲 29 / 30 ms, 资料 34 / 34 ms, `pdf` 15 / 16 ms | < 100 ms |
| First scan of 49,920 files | 0.53 s (`WindowsFileSystem`), 0.49 s (`StdFileSystem`); rescan without changes 0.14 s; hashing 2.5 s; catalog 33 MB | 0.74 s; hashing in the background job until 26.9 s | — |
| Preview, click to rendered | — | 30-page PDF 346 / 446 ms; 12-page scanned PDF (1275 × 1650 images, ICC) 341 / 465 ms; 12-megapixel PNG 54 / 80 ms; 3,000-line Python 284 / 301 ms; Markdown with 40 formulas and code blocks 148 / 184 ms | < 1 s |

The app's hashing job runs at a steady 2,200 files a second (49,920 in 22.7 s), a tenth of the
benchmark's pass over the same files; a 200-row page still answered in 25–30 ms throughout, so the
Library stays usable. The cause is open (Defender scanning files a new process opens is one
guess); `test/build-release-candidate` takes it with its loose end on hashing (each file opened
three times).

Text extraction, 2026-10-06, `feat/core-text-extract` (versioning.md §13.3), core benchmark on the
same machine and toolchain, Defender real-time protection on, undisturbed, two rounds: of the
49,920 files, 21,600 are text and Word files (7,200 each of Markdown, plain text and `.docx`, 2 KB
of notes each). The first extraction pass takes 8.45–8.53 s with either adapter (about 2,500 files
a second), and a pass with nothing to extract 7–11 ms, which every hash job adds. The catalog grows
from 58 to 195 MB (`WindowsFileSystem`: 66 to 203 MB; database and write-ahead log, the M1 figure
above is the database alone). With the bodies in the index, the scan after renaming a course takes
0.30–0.31 s for its 2,092 changes against 0.17–0.19 s before (`WindowsFileSystem`, 1,046 changes:
0.57–0.65 s against 0.24–0.25 s), because scans write entries and search rows interleaved; and
without file ids the renamed course's 450 text and Word files are extracted again (0.40–0.42 s).

## Test data

- A `testkit` module in `folio-core` generates libraries: semesters, courses, Chinese and NFD
  names, sparse large files, and small `.docx` files built in code.
- Real course files (Office samples for the preview spike) stay out of the repository unless we
  created them or they are licensed for it.

## CI

- GitHub Actions on `windows-2022`, on pushes to `main` that change more than docs, and on
  manual dispatch (any branch). Not `windows-latest`: WebView2 on the Windows Server 2025 image
  never opens its remote-debugging port (actions/runner-images#14738).
- Jobs:
  - Web: `install --frozen-lockfile`, typecheck, ESLint, Vitest.
  - Rust: `fmt --check`, `clippy -D warnings`, `test`, including the bindings drift check
    (`export_bindings`) and the capability check.
  - E2E, which depends on the build.
- Cache the Cargo registry and target directory (saved from `main` only), plus the pnpm store.
- Minutes on the private repository are limited, and Windows runners count double. Keep jobs lean,
  and move long simulation runs to a nightly schedule when they exist.

## Gaps today

Every M1 user flow has an e2e on the real app (docs/specs/m1-acceptance.md §1). `folio-core` has
unit, property and integration tests for paths, metadata files (with golden bytes and the frozen
v0.1 fixtures), the catalog, search, library scans and operations. Scan tests run on `MemFs`, an
in-memory file system with NTFS-like file ids in `test_support` (unit tests only), plus tests on
real folders; `tests/scan_benchmark.rs` times a 50,000-file library. The golden vectors of the
history format exist (2026-10-03): an independent JavaScript implementation writes them, a separate
program recomputed every hash, id, pack layout and canonical encoding once with the official Rust
crates and `folio-core`'s name rules ([remote-format.md](remote-format.md) §12), and `pnpm check`
keeps them equal to their generator (`check:vectors`). `folio-core`'s test of them arrives with
`feat/core-object-store`. Coverage tooling, the public `testkit` module and the simulation harness
arrive with the modules that need them (M2–M3).

The Windows adapters ([windows-adapter.md](windows-adapter.md)) are tested on the real OS in
temporary folders on NTFS, on CI too. Tests that need another file system are ignored by default
and run by hand with `FOLIO_TEST_NON_NTFS_DIR` set to a folder on exFAT or FAT (`--ignored`).
