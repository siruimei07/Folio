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
| Core integration | `cargo test` with temp dirs and fake adapters | Migrations (`validate()` plus one fixture per released schema), metadata formats including older and newer `format_version`, commit and restore on a temp library, watcher reconciliation | Every change; CI |
| Golden vectors | `cargo test` | Remote format: fixed inputs must produce fixed ids and bytes (ADR-0003 §13) | CI |
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

The shell has smoke tests only; the UI has component tests for the data layer and the fake
shell. `folio-core` has unit, property and integration tests
for paths, metadata files (with golden bytes), the catalog, search and library scans. Scan tests
run on `MemFs`, an in-memory file system with NTFS-like file ids in `test_support` (unit tests
only), plus one test on a real folder; `tests/scan_benchmark.rs` times a 50,000-file library.
Coverage tooling, the public `testkit` module, golden vectors for the remote format and the
simulation harness arrive with the modules that need them (M1–M3).

The Windows adapters ([windows-adapter.md](windows-adapter.md)) are tested on the real OS in
temporary folders on NTFS, on CI too. Tests that need another file system are ignored by default
and run by hand with `FOLIO_TEST_NON_NTFS_DIR` set to a folder on exFAT or FAT (`--ignored`).
