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
| IPC contract | `cargo test` in `folio-app` | Every command rejects bad input (paths outside the library, oversized values) and maps failures to the typed error union. Generated bindings match the Rust types | CI |
| UI component | Vitest + Testing Library (jsdom) | Components and hooks with the `ipc` module mocked; loading, empty, error and success states from the handoff specs; every i18n key used exists in `zh-CN` | Every change; CI |
| UI in a browser | Vite dev server with the mocked `ipc` module | Design and accessibility reviews in the browser pane; fast full-Chromium checks | Local |
| End to end | Playwright over WebView2 CDP | The real app: start-up, IPC round trip, one flow per user-facing feature, keyboard use, reduced motion | CI after the build |
| Accessibility | `@axe-core/playwright` inside e2e, plus `design:accessibility-review` | WCAG 2.1 AA: no serious or critical violations | CI; before a UI lane is done |
| Manual | Written test plans | Real iCloud (ADR-0003 Action item 4), installer and updates, SmartScreen | Before releases |

## Coverage targets

- `folio-core` modules for storage, metadata, history, sync and search: at least 80 % line coverage,
  measured with `cargo llvm-cov` once the first real module lands. Every merge rule and every error
  path has a test.
- IPC: every command has a contract test.
- UI: every state named in a handoff spec has a component test.
- E2E: at least one flow per user-facing feature.
- Not tested directly: Tauri and React internals, generated bindings, and one-off scripts.

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

The scaffold has smoke tests only. Coverage tooling, the `testkit` module, golden vectors and the
simulation harness arrive with the modules that need them (M1–M3).
