# M1 acceptance (gate `gate/m1-acceptance` → v0.1)

The record of how milestone M1 was proven before v0.1. The criteria are the four in
`docs/roadmap/roadmap.json` (`milestones`, M1) and the gate's prompt (`pnpm roadmap prompt
gate/m1-acceptance`). Policy: [testing strategy](testing-strategy.md); CLAUDE.md §8.

Status: accepted. Sirui tried the v0.1 installer on a copy of his library and accepted M1 on
2026-10-03 (no clear problems so far); his one finding, a course badge taken from the course code,
became an M2 lane. Baseline before the gate, on the integrated main `27b3cda`: `pnpm check` passed
(web 682 tests, Rust 586) and `pnpm e2e` 45/45. Commit ids below are the ones on main; the gate was
rebased onto main before it landed, which changed docs only.

## 1. Every user flow has a Playwright e2e

E2E runs on the real app over WebView2 CDP (`e2e/fixtures.ts`). Specs that use the mouse or the
Recycle Bin run on CI, and locally with `FOLIO_E2E_DESKTOP=1` (`e2e/desktop.ts`).

| Flow | Specs | Added by the gate |
|---|---|---|
| First run: new library, take over a folder, missing settings and Try again | `first-run.spec.ts` | Reduced motion on the steps |
| Browse semesters and courses | `library-view.spec.ts` | The toolbar's semester switcher; Recently added and Untagged |
| Tags: menu, filter, preview tag row, new tag | `library-view`, `preview`, `settings-ui` | — |
| Ctrl+K search | `search.spec.ts` | One- and two-character Chinese queries, marked exactly |
| Preview: PDF, image, text, code, note; Office and other files show "Open with default app" | `preview.spec.ts` | No console error from the page or its frames (pdf.js fonts, §4) |
| Import: Add files, a tag, name clashes | `import.spec.ts`, `ipc-planned.spec.ts` | — |
| Import: a drop from outside the app | `desktop-import.spec.ts` | A real OLE drag of a file and a folder onto a folder row |
| Import: originals to the Recycle Bin | `desktop-import.spec.ts` | The sources leave their folder; the Recycle Bin lists them |
| Import: a cancelled import | `import.spec.ts` | 1,000 files cancelled from the toast: what was copied stays whole, every original stays |
| Move and rename | `library-view.spec.ts` | Dragging a row onto a folder |
| Delete to the Recycle Bin | `delete.spec.ts` | Del on a file; a course after its confirmation |
| Discard an unfinished move | `discard-move.spec.ts` | — |
| Library and App settings | `settings-ui.spec.ts`, `settings.spec.ts` | — |
| Problems list | `problems.spec.ts` | — |

Results: CI on the gate branch (`gh workflow run`, windows-2022, WebView2 131, one worker), with the
drop and the Recycle Bin specs running: run 37153681921 at `bb48159` passed 52/52, and run
37157738302 at `bb48159` passed 53 and skipped the timing spec. The final local run, with
`FOLIO_E2E_DESKTOP=1` (Sirui agreed) and two workers, passed 53 and skipped the timing spec. An
earlier local run with two workers found the drop target covered by the window of the delete spec
running beside it; the drop now keeps Folio's window above others for the drag.

Design reviews of built screens. The lane gates in `roadmap.json` record `designCritique` and
`a11y` as `pass` for search, first run, preview, settings, import, discard move and problems; every
one of those screens has a reduced-motion e2e. The window shell and the Library view landed before
gates were recorded, so the gate reviewed both in the browser pane (fake shell, `small` and `large`,
light and dark, 1100 and 700 px wide) with `design:design-critique` and
`design:accessibility-review`:

- Nothing blocks v0.1. Layout, hierarchy and states match app-shell §2–§5 and library-actions
  §6–§8: the context menu, the "Date modified" sort, the narrow window without the tag filter (by
  design), dark mode.
- Accessibility: axe in `shell.spec.ts` and `library-view.spec.ts` finds no serious or critical
  violation on the real app; tree rows show a 2 px accent focus ring; all 23 visible controls are
  at least 24 × 24 px; Shift+F10, F2, Del, Ctrl+Shift+N and the arrows work from the keyboard;
  reduced motion stops rows and tiles. 200 % scaling halves the CSS space, which is the narrow
  layout (down to 500 × 320). Screen readers (NVDA, Narrator) were not tried: the full review in
  `test/build-release-candidate`.
- For later design work (`design/design-m2-details`): with nine tags the filter bar wraps to three
  rows at the panel's default width; the quick views count the whole library while the panel's
  count is the semester's (24,601 untagged beside 4,114); a course of folders shows folders as
  full-size tiles.

## 2. 50,000-file library

Measured in a quiet window on DESKTOP-N7UG6S7; method and the full table in the
[testing strategy](testing-strategy.md#performance).

| Measure | Target | Result |
|---|---|---|
| A page of 200 rows | < 50 ms | Core 39.9 ms at worst; the app 28 ms at worst, IPC included |
| A page of search results with highlights | < 100 ms | Core 57.9 ms at worst; the app 34 ms at worst |
| A common file previewed | < 1 s | 465 ms at worst (12-page scanned PDF); 30-page PDF 446 ms, PNG 80 ms, code 301 ms, note 184 ms |
| First scan of 49,920 files | record | 0.53 s core, 0.74 s in the app; hashing in the background 22.7 s |

## 3. Frozen formats (ADR-0002 action item 5)

`crates/folio-core/tests/fixtures/formats/v0.1/`, written once by the v0.1 code (README there):
metadata format 2 (`library.json`, `tags.json`, `ignore`, `meta/…`), catalog schema 2 (tokenizer
2, paths 1), scan journal 3, import intent 1, `settings.json` 1. `tests/format_fixtures.rs` opens
each one (7 tests); a tampered fixture fails four of them. ADR-0002 §3, §4 and action item 5 record
the versions.

## 4. Tech debt and loose ends

`engineering:tech-debt` over M1: no TODO or FIXME markers; dependencies a patch behind at most
(TypeScript 7 and highlight.js 11.12 held back on purpose). Loose ends:

| Loose end | Lane | Settled |
|---|---|---|
| pdf.js standard fonts by `bundled:` URL, refused by the preview CSP | feat/ui-preview | Fixed here (`bb48159`): no standard-font URL, so no `url()` in substituted fonts; the PDF e2e fails on any console error |
| Search highlights rendered as text only | feat/ui-search-palette | A requirement, met: `search/Highlighted.tsx` and its test render `<b>` and `<img onerror>` as text |
| Shared name rules (UI and fake shell) | feat/ui-first-run | Fixed here (`bb48159`): `lib/names.ts`; the fake shell had drifted (CONIN$, COM0, `CON .txt`) and the rename field let DEL and C1 through |
| LibraryView's unused "no library" branch | feat/ui-first-run | Removed here (`bb48159`) with its strings and test |
| Shared failure states | feat/ui-search-palette | Done by `58330bf` and `f80f0d6` (`app/feedback.tsx`) |
| Shared e2e helpers | feat/ui-search-palette | Done here (`bb48159`) |
| Shared selection bar (four CSS copies on the same tokens) | feat/ui-search-palette | To `feat/ui-changes-view`, before its list adds a fifth |
| Dialog look (import dialog 96 px from the top, the pending button) | feat/ui-search-palette | To `feat/ui-history-view`, which adds dialogs |
| `discard.rs:46` root kind by `from` | feat/core-discard-move | Not needed: `ScanJournal::read` refuses an intent whose first entry is not the moved item; a comment says so (`bb48159`) |
| A successful discard logged under `Event::Error` | feat/core-discard-move | To `feat/core-commit-history`: an info level in the diagnostics log, which commits need too |
| The app hashes at a tenth of the benchmark's rate | (new) | To `test/build-release-candidate`, with its hashing loose end |

## 5. Installer

`engineering:deploy-checklist`, then `pnpm bundle`: an unsigned NSIS installer, version 0.1.0
(Sirui keeps the scaffold's version and tags only after he accepts), `installMode: currentUser`,
WebView2 bootstrapper embedded. Smart App Control on DESKTOP-N7UG6S7 is in evaluation mode, which
does not block; if Windows turns it on, an unsigned Folio cannot run (ADR-0001 action item 6).

Built on 2026-10-03 from `bb48159` (later commits change docs and the timing spec only):
`target/release/bundle/nsis/Folio_0.1.0_x64-setup.exe`, 9.01 MiB, SHA-256
`b998616e66bd6209400043850ca8fadce5b75c57f41398f8e5b2e887015850fb`. The Tauri CLI fetched NSIS 3.11
and nsis_tauri_utils 0.5.3 (hash-checked) and Microsoft's WebView2 bootstrapper. Smoke test of the
release exe inside it (`FOLIO_APP_PATH`): the 9 specs that need no debug-only hook pass (app info,
capabilities, no fake shell, the preview scheme and its CSP, the close veto, overlays, the title
bar, no dev gallery); the 3 shell specs that open a library need the debug build's folder hook.

## 6. Decisions

- Desktop specs: CI always, locally on request (Sirui, 2026-10-03).
- Version: the installer stays 0.1.0; no tag until Sirui accepts (Sirui, 2026-10-03).
- Version plan (decision `version-plan`): confirmed by Sirui on 2026-10-03.
- M1 accepted and the land approved (Sirui, 2026-10-03). His finding from the trial: a course's
  badge should come from the first three letters of its course code (CSC207 → CSC, MAT232 → MAT),
  else from its name, with a badge he typed still winning; the roadmap adds it as an M2 UI lane.
