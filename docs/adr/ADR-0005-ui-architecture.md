# ADR-0005: UI architecture

- **Status:** Accepted (Sirui, 2026-09-28), with the product decisions below
- **Date:** 2026-09-28
- **Deciders:** Sirui Mei
- **Inputs:**
  - [`docs/specs/ui-architecture.md`](../specs/ui-architecture.md), the design this ADR shapes;
  - [`docs/design/handoff/app-shell.md`](../design/handoff/app-shell.md) §10–§11;
  - [ADR-0004](ADR-0004-ipc-contract.md) and [`docs/specs/ipc-m1.md`](../specs/ipc-m1.md) §5, §10,
    §11, §15; [ADR-0001](ADR-0001-application-stack.md) (preview renderers, action item 5);
    [`docs/specs/library-core.md`](../specs/library-core.md) §6;
  - npm registry metadata and the published type definitions of the candidates, read on
    2026-09-28.

## Context

M1 wave 2 starts the first real screens (roadmap §5): the app shell, then the Library view, search
and previews, built by parallel lanes. Before any of them writes a view, the choices every view
depends on must be the same everywhere; changing them later touches every screen.

Forces:

1. **Scale.** 50,000 entries. The contract serves offset pages with totals and a revision
   (ADR-0004 §4); the UI holds pages, never the catalog, and lists must jump anywhere with the
   scroll bar.
2. **Things change underneath the UI.** One `CatalogChanged` event with a revision and up to 200
   changes tells the UI what to refetch (ADR-0004 §3). The UI must never show a page older than an
   event it has seen, and must follow moved entries.
3. **Accessibility is a build requirement** (handoff §11): a WAI-ARIA tree for the library,
   keyboard access everywhere, dialogs that trap and return focus, tooltips that expose truncated
   text, a polite live region.
4. **Hostile files.** Previews parse user files. The security baseline puts them in a sandboxed
   frame with no IPC, no network and an opaque origin (ADR-0001 action item 5), and search
   highlights must be rendered as text (library core §6).
5. **Platform constraints.** The production CSP forbids inline styles and scripts; Tauri's native
   file drop turns off HTML5 drag and drop inside the page on Windows; Chinese input goes through
   an IME; the machine may be offline.
6. **Parallel lanes.** Several UI lanes and core lanes run at once (roadmap §4). UI lanes need
   realistic data before the core commands exist, and must not edit the same files.
7. **Maintenance budget.** One owner and AI agents: few dependencies, widely used ones, each at
   least one day old (CLAUDE.md §5).

## Decision

1. **Server state: TanStack Query v5.** Every shell result lives in one query cache, keyed by
   library and request. One app-level handler turns `CatalogChanged` into invalidations with a
   per-query "touched" predicate; pages older than the last event are refetched; mutations never
   write to the cache (spec §5).
2. **Client state: zustand stores, no router.** A navigation store (rail view, open dialog, reveal
   target), a session store, persisted UI preferences and one store per feature (spec §6.1). Rail
   views stay mounted under React's `<Activity>`, so they keep their state and stop their effects
   while hidden (spec §6.2).
3. **Accessible primitives: React Aria Components**, wrapped once each in `components/`, for
   dialogs, menus, context menus (with react-aria's `useContextMenu`), tooltips, tag chips,
   toggles, form controls and the search palette. **Large collections are our own**: a
   virtualised tree, listbox and grid following the WAI-ARIA patterns, on shared roving-focus,
   selection and type-ahead hooks (spec §7).
4. **Virtualisation: TanStack Virtual** with fixed row heights from tokens. The Library tree is a
   flat list of visible rows with placeholders for pages not loaded yet (spec §8).
5. **A fake shell below the bindings.** `src/ipc/mock/` implements the M1 commands and events on an
   in-memory library, installed through `@tauri-apps/api/mocks`, so the real `ipc` module runs
   unchanged. It loads automatically when the dev server's page is opened outside Tauri (the
   browser pane), backs component tests, and never ships (spec §11).
6. **Feature folders.** `src/<feature>/` for each view or dialog, so each UI lane owns one folder;
   shared layers `app/`, `components/`, `data/`, `lib/`, `ipc/`. Features never import each other;
   ESLint enforces the import rules (spec §3, §4). Each feature folder reads its own i18n
   namespace; the namespaces themselves (English only in v1, one per view) come from lane
   `feat/ui-i18n-english` and are described, not decided, in spec §12.
7. **Previews.** Images, audio and video render in the window from `folio-file` URLs; text, code,
   Markdown and PDF render in the sandboxed frame, one fresh frame per file (spec §10). M1
   libraries:
   - PDF: **pdf.js 6** (`pdfjs-dist`) with its viewer component, fed from bundled modules, never
     fetching;
   - Markdown: **markdown-it 15**, maths through **`@mdit/plugin-tex` + Temml** (MathML in the
     system maths font, as the handoff specifies), all HTML through **DOMPurify**;
   - code: **lowlight 3** with highlight.js 11 grammars, turned into DOM with text only;
   - images a note names by relative path: the shell resolves them to catalogued entries
     (`resolve_paths`, product decision 1), the window fetches them, the frame shows them from
     `blob:` URLs.
8. **Preview frame CSP gains `worker-src blob:` and `'wasm-unsafe-eval'`**, for the pdf.js worker and
   its image decoders, on the `folio-preview` scheme only. The main window's CSP does not change.
   `feat/ui-preview` makes the change with `/security-review` and e2e probes (spec §10.4).
9. **UI security rules are lint rules**: no HTML-parsing APIs outside the frame, one component
   that renders `<iframe>`, no `eval` (spec §14).

## Options considered

### 1. Server state

| Option | Complexity | Assessment |
|---|---|---|
| Own cache | Medium–high | Exactly our model, but we would write and test deduplication, stale-while-revalidate, garbage collection, request races and error states ourselves |
| Redux Toolkit Query | Medium | Tag-based invalidation fits resources, but brings Redux for a UI whose client state is small, and its tags cannot express "a change inside this scope" without a tag per folder |
| **TanStack Query v5 (chosen)** | Low–medium | Keys per request, predicate invalidation, `useQueries` for page windows, infinite queries for search, typed errors; the most used library of its kind |

Two defaults must change and are written into the spec: `networkMode: 'always'` (the default
pauses queries when Windows reports no network) and `staleTime: Infinity` (freshness comes from
events, not timers).

### 2. Client state and view switching

| Option | Verdict |
|---|---|
| React context + `useReducer` | No selectors: a selection change in a 50,000-row list re-renders every consumer |
| A router (memory history) | Solves URLs and history, which a desktop window without an address bar or back button does not have; views and dialogs are a handful of states |
| **zustand (chosen)** | About 1 KB, selectors, `persist` for UI preferences; one store per concern keeps ownership with the lane |

| Keeping hidden views | Verdict |
|---|---|
| Unmount, save state in stores, restore | Every view must serialise everything, including focus and expansion |
| Keep mounted, hide with CSS | Hidden views keep listening to events and re-rendering |
| **React `<Activity>` (chosen)** | State and DOM are kept; effects stop while hidden; React 19.2 made it stable and the app runs 19.3 |

### 3. Accessible primitives

| Option | Assessment |
|---|---|
| Radix Primitives | Dialog, menus, context menu, tooltip; no tree, listbox, combobox or tag group, so the palette and chips would be ours too. The umbrella package depends on 55 packages |
| Base UI 1.8 | Maintained, with a context menu and a combobox; no tree, listbox or tag group, so most of our collections stay our own anyway |
| Ariakit | Good composite and combobox; no tree; pre-1.0 (0.4.x) |
| React Aria Components for everything, including `Tree` with its `Virtualizer` | Complete patterns, but its collections are built by rendering every item: 50,000 rows, or placeholders for them, would cost far more than a frame, and they do not fit sparse offset pages |
| Our own everything | Dialog focus traps, menus with submenus, tooltips and positioning are exactly where home-made widgets fail screen readers |
| **RAC for everything but large collections; own virtualised tree, listbox and grid (chosen)** | RAC covers dialogs, menus, tooltips, tags, form controls and the search palette (≤ 500 results) with tested behaviour and its own i18n; we own the three components where scale and our paging decide the design |

RAC 1.21 has no context-menu component; react-aria's `useContextMenu` handles mouse, keyboard and
screen-reader triggers, and a controlled `Menu` in a `Popover` renders it. RAC's drag and drop is
not used (HTML5 drag events, off under Tauri's native drop).

### 4. Virtualisation

| Option | Verdict |
|---|---|
| react-window 2 | Small and fast, but renders its own containers, so the tree's roles and attributes sit on elements we do not own |
| react-virtuoso | Rich (groups, dynamic sizes), heavier, and also owns the markup |
| RAC `Virtualizer` | Tied to RAC collections (see 3) |
| **TanStack Virtual (chosen)** | Headless: we render every element; `rangeExtractor` keeps the focused row mounted; `initialOffset` restores scroll; fixed sizes need no measuring |

### 5. Running without the shell

| Option | Verdict |
|---|---|
| `vi.mock` of the `ipc` module in each test (today) | Fine for small components; every view test would script every call, and the browser pane gets nothing |
| Swap the `ipc` module for a mock build with a Vite alias | Skips the real wrappers (`typedError`, events), so their bugs hide |
| **A fake shell under `@tauri-apps/api/mocks` (chosen)** | One implementation for the browser pane and view tests; the generated bindings and event helpers run as in the app; typed by the bindings, so shape drift fails `tsc` |

The cost is behaviour drift between the fake and the real shell; e2e runs on the real shell, and
each command file of the fake names the spec sections it follows.

### 6. Folder layout

| Option | Verdict |
|---|---|
| By kind (`components/`, `hooks/`, `pages/`) | Every feature lane edits every folder: the collision the roadmap (§4 rule 4) wants to avoid |
| `views/<view>/` | Dialogs and the search palette are not views; nesting adds nothing |
| **`src/<feature>/` plus shared layers (chosen)** | One lane, one folder; shared layers split into one file per resource |

### 7. Preview libraries

| Need | Options | Chosen and why |
|---|---|---|
| PDF | pdf.js; Chromium's built-in PDF viewer | **pdf.js 6**: the built-in viewer is a plugin, which the frame's sandbox and the `object-src 'none'` policy block, and it cannot carry the handoff's page pill. pdf.js 6.3 contains no `eval` or `new Function`, and its `BinaryDataFactory` lets it load CMaps (Chinese PDFs), fonts and wasm without fetching |
| Markdown | markdown-it; marked; unified (remark / rehype, react-markdown) | **markdown-it 15**: CommonMark, link validation built in, few dependencies. marked is faster but looser; unified is many packages for the same result |
| Maths | KaTeX; Temml; MathJax | **Temml**: LaTeX to MathML, which Chromium renders natively in Cambria Math, the handoff's `font.family.math`; no maths fonts to bundle; screen readers read MathML. KaTeX draws formulas in its own fonts, against the handoff; MathJax is the heaviest. KaTeX stays the fallback if Temml misrenders real notes |
| Highlighting | highlight.js HTML; lowlight (highlight.js as a tree); Shiki; Prism | **lowlight 3**: a tree we turn into DOM with text only, split per line for line numbers; class names map to `color.syntax.*`. Shiki is more accurate but heavier and asynchronous; Prism's next major never shipped |
| Sanitiser | DOMPurify; sanitize-html; the browser's Sanitizer API | **DOMPurify**: the standard, maintained, handles MathML. sanitize-html targets Node; revisit the Sanitizer API once WebView2 ships it |

### 8. The pdf.js worker and decoders

| Option | Security | Verdict |
|---|---|---|
| pdf.js on the frame's thread, JS image decoders | No CSP change | Parsing a large PDF may block the window if WebView2 runs the frame in the window's process; scanned PDFs decode slowly |
| **`worker-src blob:` and `'wasm-unsafe-eval'` for the frame only (chosen)** | The worker inherits the frame's CSP (no network) and gets no IPC; `'wasm-unsafe-eval'` allows compiling WebAssembly, not JavaScript `eval` | Parsing leaves the frame's thread; JPEG 2000 and JBIG2 (scanned readings) decode at native speed. Falls back to the first option if WebView2 refuses a worker in the sandboxed frame |

## Trade-off analysis

- **A library cache against our own.** TanStack Query adds a dependency and a model to learn, and
  its defaults need two changes; in exchange, request races, garbage collection and error states
  are solved and tested elsewhere. The part that is ours, deciding what an event touches, is a
  pure function with unit tests.
- **Mixed primitives.** RAC plus own collections means two sources of keyboard behaviour. The own
  ones are three components following written patterns, tested with user-event and axe; RAC's
  collection model would not survive 50,000 sparse rows. The alternative, one library that does
  neither well, is worse.
- **Event-driven freshness against optimistic updates.** After a rename, the row updates when the
  event's refetch arrives (about 100–150 ms: events are merged up to ten per second, pages take
  under 50 ms), not instantly. In exchange there is one path that changes the cache, and it always
  agrees with the catalog's sort and filters.
- **Keeping views alive.** Hidden views keep their DOM, so memory grows with the views visited
  (three in v1). Their queries still expire, so data does not.
- **A fake shell to maintain.** It is code with no user, and it can drift. It lets UI lanes build and
  review screens before the core lanes land (roadmap §4 rule 2), and gives design and
  accessibility reviews a 50,000-entry library in the browser pane.
- **Two CSP additions in the frame** widen what previewed content can do there: start a worker and
  compile WebAssembly. Both stay inside the sandbox, which keeps an opaque origin, no network and
  no IPC; e2e probes prove it.
- **Images in notes** let a hostile note ask for other files of the library by relative path. The
  shell answers only with catalogued files inside the library, the window fetches only image types
  within size limits, and the frame can show them but send them nowhere: the note gains nothing the
  user could not open in Folio anyway.

## Consequences

**Easier**
- UI lanes start from one data model, one set of primitives and one folder each, before the core
  commands exist.
- Freshness is automatic: views never subscribe to catalog events.
- Reviews in the browser pane see realistic data at full scale.
- Keyboard and screen-reader behaviour of dialogs, menus and tooltips comes tested.

**Harder**
- The virtual tree, listbox and grid, and their keyboard patterns, are ours to build and test.
- The touch predicates must follow every event kind the contract adds later (M2 `WorkspaceChanged`,
  M3 sync events).
- The fake shell must follow the contract.
- pdf.js needs care in the frame: worker creation, bundled CMaps and fonts, measured start-up.

**Revisit when**
- React Aria moves to its next major (nightly builds are already versioned 3.0).
- WebView2 ships the HTML Sanitizer API: replace DOMPurify.
- A folder or filter routinely exceeds the tree's caps (spec §8.2): ask for a position command in
  the contract, or keyset pages (ADR-0004).
- A second window appears: the query client and stores are per window today.
- Profiling shows the UI thread busy with rendering: consider the React Compiler.

## Product decisions (Sirui, 2026-09-28)

Four questions this ADR left open, with the options Sirui was given and his choice.

1. **Markdown notes with images next to them** (`![](figure.png)`, as Typora and Obsidian write).
   The frame cannot load them.
   - (A) M1 shows the image's alt text in a placeholder, and images come later.
   - **(B) M1 shows them (chosen).** A new command resolves paths relative to an entry; the window
     fetches the images from the `folio-file` scheme and hands them to the frame (spec §10.4).
     Contract first (roadmap §4 rule 2): a small lane `feat/ipc-m1-resolve-paths` declares the
     command and lands before `feat/data-browse-queries` implements it.
   - Images on the web (`https://…`) stay placeholders: the frame has no network, by design.
2. **Links inside previews** (Markdown, PDF).
   - **(A) Inert in M1 (chosen).** Hovering shows the address; clicking shows it in a popover
     with "Copy address" (spec §10.4). Links within the same document still scroll.
   - (B) Open `http` and `https` links in the default browser, through a new shell command with
     its own `/security-review`. Left for a later version.
3. **Changes and History in the v0.1 rail**, before M2 exists.
   - **(A) Hidden until M2 (chosen)**: the rail shows Library only, and `Ctrl+2` / `Ctrl+3` do
     nothing until the M2 views register them (spec §6.2).
   - (B) Shown and disabled, with a tooltip.
4. **Lane plan.**
   - **The data layer and the fake shell get their own wave 2 lane, `feat/ui-data-layer` (chosen)**,
     beside `feat/ui-app-shell` (spec §4, §18), so the app-shell lane stays one lane's work and the
     Library view can start sooner.

## Action items

1. [x] Sirui approves and answers the open decisions; Status set to Accepted (2026-09-28).
2. [x] The roadmap's wave 2 gains `feat/ui-data-layer` and `feat/ipc-m1-resolve-paths`
   (2026-09-28, this lane).
3. [x] `chore/build-deps-ui-m1`: install the packages of spec §16 after re-checking release ages
   (2026-09-29: installed as listed, every lockfile addition at least one day old; spec §16).
4. [ ] `feat/ipc-m1-resolve-paths`: declare `resolve_paths` in ipc-m1 and the bindings, planned and
   not registered (spec §10.4 has the proposed shape); `feat/data-browse-queries` implements it.
5. [ ] `feat/ui-data-layer`: data layer and fake shell (spec §5, §11).
6. [ ] `feat/ui-app-shell`: stores, `<Activity>` view host, shortcuts, layout mode, component
   wrappers, ESLint import and security rules (spec §3, §6, §7.1, §14).
7. [ ] `feat/ui-library-view`: the virtual collections and the flattened tree (spec §7.2, §8).
8. [ ] `feat/ui-preview`: renderers, the frame protocol, Markdown images and the CSP additions with
   `/security-review` (spec §10); record the pdf.js worker and Temml results here.
