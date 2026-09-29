# UI architecture

System design for the React UI in `apps/desktop`: how it caches catalog pages, keeps view state,
builds accessible and virtualised collections, runs in a browser without the shell, lays out its
folders, and renders previews. Decisions that are costly to reverse are in
[ADR-0005](../adr/ADR-0005-ui-architecture.md); this spec fixes the details the M1 UI lanes build on.

- Status: accepted with ADR-0005 (Sirui, 2026-09-28), including its four product decisions;
  written in lane `docs/adr-0005-ui-architecture`. Nothing is installed yet: §16 lists the
  packages for `chore/build-deps-ui-m1`.
- Inputs: [app-shell handoff](../design/handoff/app-shell.md) (§10 shared components, §11 build
  requirements); [ADR-0004](../adr/ADR-0004-ipc-contract.md) and [ipc-m1](ipc-m1.md) (§5 pages,
  §10 search, §11 preview, §15 events); [ADR-0001](../adr/ADR-0001-application-stack.md) (preview
  renderers, action item 5 security baseline); [library core](library-core.md) §6 (highlights are
  text); [system overview](system-overview.md); [testing strategy](testing-strategy.md);
  [roadmap](../product/roadmap.md) §4–§5.
- Existing code this builds on: `src/ipc/` (generated bindings, `shellEvents`, `contentUrl`),
  `src/preview/` (the sandboxed frame and its protocol), `src/titlebar/`, `src/tokens/`,
  `src/i18n/`, `src/test/setup.ts` (`mockIPC`).

## 1. Scope

| In this spec | Elsewhere |
|---|---|
| Data layer: page cache, invalidation, references, jobs and problems | Command semantics: [ipc-m1](ipc-m1.md) |
| View state, rail switching, dialogs, shortcuts, layout modes | Look and copy of each screen: handoff specs |
| Accessible primitives and virtualised collections | i18n structure: lane `feat/ui-i18n-english` (§12 describes it) |
| The fake shell for the browser pane and component tests | E2E harness: [testing strategy](testing-strategy.md) |
| Folder layout, import rules, lane ownership in `apps/desktop/src` | Office previews (M4): spike `spike/ui-office-preview` |
| M1 preview renderers and the frame protocol | The `folio-file` scheme: lane `feat/core-file-scheme` |

## 2. Requirements

Functional (M1, handoff §2–§10, brief §5.1–§5.3):

| Need | Where it lands |
|---|---|
| Library tree: courses → folders → files, quick views, tag filter, List / Tree toggle, grid of a selected folder | §5, §7, §8 |
| Multi-select and batch actions (tags, move, delete) on up to `LIMITS.batch` entries | §7.2 |
| Changes made outside Folio appear by themselves; the preview follows moves | §5.4, §5.5 |
| `Ctrl+K` search: results while typing, grouped, highlights, arrows and Enter | §9 |
| Preview: images, PDF, Markdown with maths and highlighted code, code, text, audio, video | §10 |
| Settings dialogs, semester menu, context menus, tooltips | §7 |
| Rail views keep their state when the user switches away and back | §6 |
| Every screen works in a plain browser with realistic data, including 50,000 entries | §11 |

Non-functional:

- **Scale.** 50,000 entries: the UI holds pages, never the catalog (system overview §6). A list of
  50,000 rows scrolls at 60 fps and jumps anywhere with the scroll bar.
- **Latency.** A page of 200 rows arrives in under 50 ms (ipc-m1 §2); the UI renders a screen of
  rows within one frame. Search shows results about 200 ms after typing stops. Common previews
  appear within 1 s (brief §12).
- **Accessibility** (handoff §11): everything by keyboard, WAI-ARIA tree for the library, dialogs
  that trap and return focus, tooltips that expose truncated text, 24 × 24 px targets, a polite
  live region, `prefers-reduced-motion` and the app's own reduce-motion setting.
- **Security.** The UI is untrusted (CLAUDE.md §5) and renders hostile files. File content is
  parsed and rendered only inside the sandboxed preview frame; the window never turns library data
  into HTML (§14).
- **No silent failures.** Every query and mutation ends in data or a visible error state (§13).
- **Chinese input.** IME composition never triggers a search, a shortcut or type-ahead.

Constraints: React 19.3, Vite 8, TypeScript 6, WebView2 (current Chromium); the production CSP has
no `'unsafe-inline'`, so no library may inject `<style>` elements at runtime (setting styles
through the `style` prop is fine); Tauri's native file drop disables HTML5 drag and drop inside
the page on Windows (ADR-0001), so in-app dragging uses pointer events; new packages are at least
one day old (CLAUDE.md §5).

## 3. Layers

```text
+-- main window (http://tauri.localhost) ------------------------------------------------------+
|  app/        providers, window layout, rail, toolbar, view switching, shortcuts, announcer    |
|  features    library/ search/ preview/ settings/ import/ first-run/  (changes/ history/ M2)  |
|     |  read: data hooks        act: data mutations        navigate: app/navigation store     |
|  components/ presentational components (handoff §10), RAC wrappers, virtual collections      |
|  data/       TanStack Query client, query keys, paged lists, CatalogChanged -> invalidation   |
|  ipc/        generated bindings, events, folio-file URLs   |  ipc/mock/ fake shell (dev only)  |
+-------|------------------------------------------------------|--------------------------------+
        | invoke / events (Tauri IPC)                           | postMessage (bytes, commands)
        v                                                       v
   shell (folio-app)  <--- GET folio-file URLs (images, media, bytes for the frame)
                                                   +-- preview frame (sandbox="allow-scripts") -+
                                                   |  preview/frame/: text, code, Markdown, PDF  |
                                                   |  no IPC, no network, no parent DOM          |
                                                   +---------------------------------------------+
```

Rules:

1. Features read through `data/` hooks and act through `data/` mutations; they never call `ipc`
   commands directly. `ipc` types, `contentUrl` and `thumbnailUrl` are free to use.
2. Features never import each other. Cross-feature actions ("reveal this file in the Library",
   "open Library settings on Tags") go through the navigation store (§6.1).
3. `components/` is presentational: no data hooks, no stores.
4. `preview/frame/` imports only `preview/protocol.ts`, `lib/` and its renderer packages: never
   React, `ipc`, `data` or `i18n`.

`feat/ui-app-shell` adds these as `no-restricted-imports` overrides in `apps/desktop/eslint.config.js`
(CLAUDE.md §3.7).

## 4. Folder layout

Feature folders sit directly under `src/`, so each UI lane owns `apps/desktop/src/<feature>/**`
(roadmap §4 rule 4); each folder matches one i18n namespace (§12). Shared layers are split into one
file per resource or component, so parallel lanes add files instead of editing the same list.

```text
apps/desktop/src/
  main.tsx               i18n, fake shell in a dev browser (§11), createRoot
  App.tsx                providers + <Shell />
  app/                   Shell layout, Rail, Toolbar, ViewHost (<Activity>), navigation.ts, shortcuts.ts,
                         layout.ts (wide / narrow), Announcer, ErrorBoundary
  titlebar/              existing TitleBar (app-shell lane moves or keeps it)
  components/            CourseBadge, CourseLabel, TagDot, TagChip, FileTypeIcon, ChangeStatusIcon,
                         CountPill, Button, IconButton, SegmentedControl, Switch, Dialog, Menu,
                         ContextMenu, Tooltip, ErrorState, EmptyState, Skeleton …  (one folder each,
                         component + CSS + test)
    collections/         VirtualList, VirtualTree, VirtualGrid, useRovingFocus, useSelection,
                         useTypeahead (§7.2)
  data/                  client.ts, keys.ts, session.ts, events.ts (CatalogChanged), references.ts,
                         paged.ts, errors.ts; one file per command group: library.ts, groups.ts
                         (semesters, courses), tags.ts, entries.ts, search.ts, jobs.ts, problems.ts,
                         files.ts (open, reveal), import.ts
  lib/                   pure helpers: paths.ts, revision.ts, format.ts (Intl dates, sizes),
                         file-types.ts (extension → class, icon, renderer)
  library/               Library view
  search/                Ctrl+K palette
  preview/               PreviewPane, PreviewFrame (the only <iframe>), ImagePreview, MediaPreview,
                         protocol.ts
    frame/               runs inside the frame: frame.ts (entry), text.ts, code.ts, markdown.ts, pdf.ts
  settings/              library/ and app/ dialogs
  import/                drop target, import dialog, progress
  first-run/             welcome, new library, take over, first semester and courses
  changes/ history/ diff/            M2
  sync/ conflicts/ remote-setup/     M3
  ipc/                   existing; mock/ holds the fake shell (§11)
  i18n/                  owned by feat/ui-i18n-english (§12)
  tokens/                generated CSS (and, from the app-shell lane, generated TS constants)
  test/                  setup.ts, render.tsx (providers + fake shell), virtual.ts (§11.4)
```

Conventions: components are `PascalCase.tsx` with a co-located `PascalCase.css` using BEM-like
classes (as `TitleBar.css` does); hooks are `useThing.ts`; tests sit next to their file as
`*.test.ts(x)`. CSS reads only token custom properties (CLAUDE.md §5). Icons come only from
`lucide-react` (handoff decision 3; caption buttons keep Segoe Fluent Icons).

| Path | First owner | Later lanes |
|---|---|---|
| `app/`, `components/`, `lib/`, `titlebar/` | `feat/ui-app-shell` | add files; edit shared files with small additive hunks |
| `data/` (client, keys, session, events, references, paged) and `ipc/mock/` | `feat/ui-data-layer` (§18) | add one file per command group |
| `library/`, `search/`, `preview/`, `settings/`, `import/`, `first-run/` | the lane named after it (roadmap §5) | — |

## 5. Data layer

### 5.1 Query client

TanStack Query v5 is the cache for everything the shell returns (ADR-0005 §1). One `QueryClient`
per app, created in `data/client.ts`:

| Option | Value | Why |
|---|---|---|
| `networkMode` | `'always'` | The default `'online'` pauses queries while Windows reports no network; IPC never needs one |
| `retry` | `false` | Command errors are deterministic; a `Transport` error is a bug |
| `staleTime` | `Infinity` | Data stays fresh until an event says otherwise (§5.4) |
| `refetchOnWindowFocus`, `refetchOnReconnect` | `false` | Same reason |
| `gcTime` | 60 s for page queries, default (5 min) otherwise | Bounds memory for long lists |
| `structuralSharing` | default (on) | Unchanged rows keep their identity, so memoised rows skip rendering |

Commands never reject (ADR-0001 §4d). Query functions unwrap the result and throw an
`IpcFailure` (an `Error` subclass that holds the `IpcError`) for Query's error channel;
`data/errors.ts` registers it as Query's `defaultError`, so `query.error.error.code` is typed.
Mutations use the same wrapper.

### 5.2 Query keys

Every key starts with the library it belongs to, so a library switch can drop everything at once
and no page of one library answers a query of another:

```ts
['lib', libraryId, 'children', { folder: EntryRef | null, sort }, pageIndex]
['lib', libraryId, 'files',    { scope: EntryRef | null, filter, sort }, pageIndex]
['lib', libraryId, 'count',    'children' | 'files', request]   // a page with limit 0
['lib', libraryId, 'search',   { text, scope }]                 // infinite query, pages of 50
['lib', libraryId, 'entry',    id]
['lib', libraryId, 'semesters'] | ['lib', libraryId, 'courses', semesterPath | null]
['lib', libraryId, 'tags'] | ['lib', libraryId, 'jobs'] | ['lib', libraryId, 'problems', pageIndex]
['app', 'libraryStatus']
```

`data/keys.ts` is the only place that builds keys; the invalidation predicates (§5.4) read them.

### 5.3 Paged lists

A virtualised list asks for the pages its visible range needs (§8). `data/paged.ts` provides
`usePagedList(listKey, fetchPage)`:

- Pages of 200 rows (`LIST_PAGE`, under `LIMITS.pageSize`), one query per page:
  `[...listKey, pageIndex]`. Page 0 is always requested, because it carries `total`.
- Input: the visible row range from the virtualiser. Output: `total`, `rowAt(index)` (an
  `EntryRow` or `undefined` for a row whose page is not loaded), `status`, `error`, and the
  revision of the newest page.
- Pages within 50 rows of the visible range are prefetched.
- `total` comes from the newest page. The virtualiser's `count` follows it.
- Row keys are entry ids, which stay stable across renames and moves (ipc-m1 §5.1); a row whose
  page is not loaded is keyed `placeholder:<index>` and renders a skeleton.

Counts (quick views, course and folder counts) are separate queries with `limit: 0`.

### 5.4 CatalogChanged and revisions

One subscription at the app root (`data/events.ts`, mounted by the data provider) handles every
catalog event; components never subscribe to `CatalogChanged` themselves.

**Revisions.** `data/session.ts` keeps `libraryId` and `lastRevision`, the revision of the newest
`CatalogChanged`. Revisions wrap at 2³² (ipc-m1 §15.2), so `lib/revision.ts` compares them with
serial-number arithmetic: `a` is older than `b` when `(b - a) mod 2³²` is between 1 and 2³¹ − 1. A
page whose revision is older than `lastRevision` arrived after an event that may have changed it:
its query is invalidated once for that event revision.

**On `CatalogChanged { revision, entries, complete, tags, groups }`:**

1. Set `lastRevision`.
2. `complete: false` (too many changes, or a rebuild): invalidate every `['lib', id, …]` query.
   Active queries refetch; inactive ones are removed. Reference followers get a "rebuilt" notice
   (§5.5).
3. Otherwise, for each query, ask whether a change touches it (table below). Touched active
   queries refetch and keep showing their data until the new page arrives; touched inactive page
   queries are removed, so a page scrolled into view later never shows rows of an older revision.
4. `tags` → invalidate `tags`; `groups` → invalidate `semesters` and `courses`.
5. Pass the entry changes to the reference followers (§5.5).

A change at path `P` (and, for `moved`, from path `F`) touches:

| Query | Touched when |
|---|---|
| `children` of folder `X` | `parent(P)` or `parent(F)` is `X`; for `tagged` on a folder: `X` is `P` or below it (their `folderTags` changed) |
| `files` / `count` / `search` over scope `S` | `P` or `F` is inside `S` (`null` = everything); for `tagged` on a folder: also `S` inside `P` |
| `entry` `id` | the change's entry id is `id`; for `tagged` on a folder: the entry is below `P` |
| `courses`, `semesters` | `groups`, or any `added`, `removed` or `moved` change (course file counts) |
| `tags` | `tags`, or any `tagged` change (usage counts) |
| `jobs`, `problems` | never: `JobChanged` and `ProblemsChanged` update them (§5.6) |

Paths are compared as `/`-separated names, case included (ipc-m1 §5.1): `inside(P, S)` is
`P === S || P.startsWith(S + '/')`.

**Mutations don't write to the cache.** Every catalog write ends in a `CatalogChanged`, which
refreshes what it touched; a second, optimistic path would have to agree with the catalog's sorting
and filtering (ADR-0004 §3). A mutation's result is used for focus and selection only (for
example, select and focus the renamed row by id). Settings mutations that raise no catalog event
(from `feat/core-app-settings`) invalidate their own keys.

**On `LibraryStateChanged`:** remove every `['lib', …]` query, reset `session`, and reset the
stores that hold references (§5.5, §6). A new library id makes every old key unreachable anyway.

### 5.5 References the UI holds

Selections, the previewed entry, expanded folders and the reveal target hold `EntryRef`s or paths.
`data/references.ts` lets their stores follow the catalog:

- `moved`: replace the path; for a folder, every held path below `from` gets the new prefix.
- `removed`: drop the reference; the preview closes and shows its empty state.
- "rebuilt" (`complete: false`): ids changed (ipc-m1 §13), so check each held reference with
  `get_entry`; drop the ones that answer `NotFound`.

Expanded folders are kept **by path**, not id: search results and "reveal" know a file's ancestors
only by path (§9), and a path is enough to expand the tree top-down (§8.2).

### 5.6 Jobs and problems

- `jobs` is filled by `list_jobs` once, then kept current by `JobChanged`: each event replaces that
  job in the cached list with `setQueryData` (it carries the whole `Job`); no refetch.
- `ProblemsChanged { total }` updates a `problemsTotal` value and invalidates `problems` pages.
- After a reload (`pnpm dev` reloads, WebView2 crashes), everything is rebuilt from `list_jobs` and
  the first pages: no UI state has to survive a reload.

## 6. View state

### 6.1 Stores

No router: a desktop window has no address bar and no back button. Client state lives in small
zustand stores (ADR-0005 §2); server state stays in the query cache, never copied into a store.

| Store | File | Holds | Persisted |
|---|---|---|---|
| Navigation | `app/navigation.ts` | active rail view; the open dialog (`search`, `librarySettings` + page, `appSettings` + page, `import`, …); a pending reveal target | no |
| Session | `data/session.ts` | library id, `lastRevision`, current semester path | current semester, per library |
| UI preferences | `app/preferences.ts` | List / Tree mode, sort, History panel width, last settings page | yes, `localStorage` (per machine, not synced; parsed defensively, versioned key) |
| Library view | `library/state.ts` | expanded paths, selection, focused row, filters, previewed entry, scroll offset | no |

Theme, reduce motion and device name are shell settings (`feat/core-app-settings`), not UI
preferences: the shell needs the theme before the first frame (no white flash, roadmap §3.4).

Components select narrow slices (`useStore(selector)`, `useShallow` for objects), so a selection
change re-renders the rows it affects, not the list.

### 6.2 Switching rail views

- `app/ViewHost.tsx` renders each visited view inside React's `<Activity>`: the active view is
  `visible`, the others `hidden`. A hidden view keeps its React state and DOM, its effects are
  cleaned up (event subscriptions stop) and its queries become inactive, so it costs little and
  refreshes when shown again. A view mounts the first time it is shown, not at start-up.
- Scroll positions are stored in the view's store and restored through the virtualiser's
  `initialOffset`, so they survive whether or not the browser keeps a hidden element's offset.
- Rail buttons carry `aria-current="page"` on the active view (handoff §4). Until M2 the rail
  shows Library only: Changes and History stay hidden, not disabled (ADR-0005, product decision
  3). Each view registers its rail button and its `Ctrl+<n>` shortcut when it exists, so the M2
  lanes add theirs without touching the Library.
- Dialogs (search, settings, import) are not views: the navigation store opens one at a time, and
  closing returns focus to the element that opened it (§7.1).

### 6.3 Layout, theme and motion

- **Narrow layout** (window width < `size.narrow-breakpoint`, handoff §2): media queries cannot
  read custom properties, so the token generator also emits the tokens that code needs as numbers
  (the breakpoint, `size.row`, tile sizes) as TypeScript constants (app-shell lane).
  `app/layout.ts` watches `matchMedia` and sets `data-layout="narrow"` or `"wide"` on the root;
  CSS selects on that attribute. The narrow "preview covers the list" state lives in the Library
  view store.
- **Theme and reduce motion**: `data-theme` and `data-reduce-motion` on the root, set before the
  first render from the shell's settings (app-shell lane, roadmap §3.4). Components read durations
  only from tokens; the reduce-motion tokens set them to 0.

### 6.4 Keyboard shortcuts

`app/shortcuts.ts` holds one registry and one `keydown` listener on the window:

| Keys | Action | Where |
|---|---|---|
| `Ctrl+K` | open search | everywhere, also from an input |
| `Ctrl+1` | Library | not inside a dialog |
| `Ctrl+2` / `Ctrl+3` | Changes / History | registered by the M2 views (§6.2) |
| `Ctrl+,` | Library settings | not inside a dialog |
| `Ctrl+O` | Add files (Library) | Library view |
| `Ctrl+Enter`, `Ctrl+Shift+S` | commit (M2), sync (M3) | their lanes register them |

- Ignored while `event.isComposing` (IME), and while a modal dialog is open unless the shortcut says
  otherwise. Esc belongs to the dialog.
- The preview frame forwards these key combinations to the window (§10.3), so shortcuts work while
  it has focus.
- WebView2's browser accelerator keys (reload, print, find, zoom) should be off in release builds;
  the app-shell lane checks what Tauri exposes and hands a shell change to a backend lane if needed.

## 7. Accessible primitives

### 7.1 From React Aria Components

React Aria Components (RAC) 1.21 and `react-aria` hooks provide everything that is not a large
collection (ADR-0005 §3). Each is wrapped once in `components/`, styled with tokens, and used only
through the wrapper:

| Handoff need | RAC / react-aria | Notes |
|---|---|---|
| Settings dialogs, import dialog, confirmations (handoff §9) | `ModalOverlay` + `Modal` + `Dialog` | Focus trap and return, Esc, `aria-modal`. The scrim starts below the title bar; `shouldCloseOnInteractOutside` ignores the title bar, so the caption buttons neither close the dialog nor get blocked |
| Search dialog (handoff §8) | `ModalOverlay` + `Dialog` + `Autocomplete` + `SearchField` + `ListBox` / `ListBoxSection` / `ListBoxLoadMoreItem` | Virtual focus: the input keeps focus, arrows move the active option (`aria-activedescendant`). No `filter`: the shell ranks (§9) |
| Semester menu, "More", options chevron | `MenuTrigger` + `Menu` + `MenuItem` + `SubmenuTrigger` + `Popover` | |
| Context menus on rows (handoff §3) | `useContextMenu` (react-aria) + a controlled `Menu` in a `Popover` anchored at the pointer | Right-click, Shift+F10 and the Menu key; one `ContextMenu` wrapper. RAC 1.21 has no context-menu component |
| Tooltips on icon buttons, rail, tag dots | `TooltipTrigger` + `Tooltip` | Hover and keyboard focus; the delay becomes a `motion.*` token (none exists yet) |
| Tooltips on truncated row text | one shared `Tooltip` positioned at the hovered or focused row | One overlay for a whole list instead of a trigger per row |
| Tag chips with remove, "+ Tag" (handoff §5) | `TagGroup` + `TagList` + `Tag` (`onRemove`) | "Remove tag Notes" labels |
| List / Tree / Grid toggles | `ToggleButtonGroup` + `ToggleButton` | segmented control |
| Switches, selects, text fields, radio groups (handoff §9) | `Switch`, `Select`, `TextField`, `TextArea`, `RadioGroup` | |
| Checkboxes with a 24 × 24 hit area | `Checkbox` | |
| History resize handle (handoff §7, M2) | own `role="separator"` with `aria-valuenow/min/max` | a few lines; not worth a component |
| Landmarks, focus scopes | `useLandmark`, `FocusScope` | |
| Polite live region (handoff §3, §11) | own `Announcer` in `app/` | two `aria-live` regions; RAC's announcer is internal |

`I18nProvider` gets the UI language, so RAC's own hidden labels follow it. RAC's drag and drop is
not used: it builds on HTML5 drag events, which Tauri's native file drop turns off (§2).

### 7.2 Own virtualised collections

Large collections are built in `components/collections/` on TanStack Virtual (§8), following the
WAI-ARIA Authoring Practices patterns. They share three hooks:

- `useRovingFocus`: one row has `tabIndex=0`; arrows, Home, End, PageUp and PageDown move it and
  scroll it into view. The focused row is always rendered (the virtualiser's `rangeExtractor` adds
  its index), so focus never lands on a removed element.
- `useSelection`: single, toggle (`Ctrl`+click, `Ctrl+Space`), range (`Shift`+click,
  `Shift+arrows`) and all (`Ctrl+A`). A selection is a set of ids plus, for "all", the list's key
  and the ids left out; actions resolve it to `EntryRef`s by loading the pages they need, capped at
  `LIMITS.batch` with a message beyond it.
- `useTypeahead`: characters typed within 500 ms find the next loaded row whose name starts with
  them (case-insensitive, `Intl.Collator` in the UI locale); ignored during IME composition.

| Component | Pattern | Used by |
|---|---|---|
| `VirtualTree` | `role="tree"`, `treeitem` with `aria-level`, `aria-expanded`, `aria-selected`, `aria-setsize`, `aria-posinset` | Library tree (handoff §5) |
| `VirtualList` | `role="listbox"`, `aria-multiselectable`, options with `aria-setsize` / `aria-posinset` | Library list mode, Changes list (M2) |
| `VirtualGrid` | layout grid: `role="grid"` with `aria-rowcount` / `aria-colcount`, rows with `aria-rowindex`; 2-D arrow keys | grid of a selected course or folder |

Tree keys follow handoff §5: Up/Down move, Right expands or enters, Left collapses or goes to the
parent, Home/End, Enter opens the preview, type-ahead by name. Each row's accessible name carries
the full text ("MAT232 Calculus of Several Variables, 10 files"), whatever the truncation.

Handoff §11 check:

| Requirement | Covered by |
|---|---|
| Everything reachable by keyboard (tree, rail, dialogs, resize handle, search) | §7.1, §7.2, §6.4 |
| Targets ≥ 24 × 24 px, checkbox hit area | component CSS from tokens; checked in `design:accessibility-review` |
| Truncated text in a tooltip and the accessible name | shared row tooltip; names built from full text |
| Dialogs trap focus and return it | `Modal` / `Dialog` |
| Sync results in a polite live region | `Announcer` |
| Contrast on built screens | `design:accessibility-review` and axe in e2e (§15) |

## 8. Virtualisation

### 8.1 Lists and grids

- TanStack Virtual (`useVirtualizer`), headless, so our components own every element and ARIA
  attribute. Rows have the fixed height `size.row` (32 px): `estimateSize` returns it from the
  generated token constants (§6.3) and nothing is measured. 50,000 × 32 px = 1.6 million px, far
  inside Chromium's limit.
- `overscan` of 8 rows; the visible range feeds `usePagedList` (§5.3), which prefetches nearby
  pages. Dragging the scroll bar to row 40,000 loads only the pages around it.
- Rows are memoised components that take primitive props (the row, `selected`, `focused`), so
  scrolling renders only rows that enter the window.
- `VirtualGrid` virtualises rows of tiles: columns = ⌊(width + gap) / (min tile + gap)⌋ from a
  `ResizeObserver`; a virtual row holds that many tiles and maps to row-major indexes in the pages.

### 8.2 The Library tree as a flat list

The tree is rendered as one flat, virtualised list of visible rows, rebuilt when an expansion or a
page changes:

```text
rows = quick views (2) + separator
     + for each course in list_courses(current semester):
         course row
         if expanded(course.folder.path):  children(course.folder)
children(folder) = for i in 0 ..< total(folder):
                     row = page(folder, i / 200)[i % 200]   or a placeholder row if not loaded
                     emit row (level, posinset = i + 1, setsize = total)
                     if row is a folder and expanded(row.path): children(row)
```

- A folder's `total` comes from its first page; until it arrives the folder shows one loading row.
- Pages of an expanded folder stay cached while it is expanded (`gcTime: Infinity` for tree pages,
  removed on collapse), so the rows below never jump when a page is evicted and reloaded.
- The flattener keeps prefix sums per expanded folder, so mapping a row index to its folder and
  child index costs O(expanded folders), not O(rows).
- **Reveal** (search result, "Show in Library"): expand every ancestor path, then load pages of the
  parent until the entry appears (one page for folders under 200 entries), then select, focus and
  scroll to it.
- **Tag filter** (handoff §5): `list_files` over the semester sorted by `path` (ipc-m1 §9.1); the
  flattener inserts a folder row wherever the path prefix changes and shows every folder expanded.
  The filtered tree loads up to 5,000 matches (25 pages, the first rendered at once); beyond that
  it offers the flat list with path prefixes. `feat/ui-library-view` tunes the cap on the 50,000
  entry fixture.

## 9. Search palette

- `search/` renders the dialog of handoff §8 with RAC (§7.1); results are an infinite query
  `['lib', id, 'search', { text, scope }]` with pages of 50 (`offset + limit ≤ LIMITS.searchResults`,
  ipc-m1 §10). `ListBoxLoadMoreItem` asks for the next page while `more` is true.
- The query text updates 120 ms after the last keystroke, never during IME composition
  (`compositionstart` … `compositionend`), and is trimmed; text over `LIMITS.queryChars` shows
  the `QueryTooLong` message without calling the shell. A new text is a new key, so a superseded
  response never shows; `placeholderData: keepPreviousData` keeps the old results until the new
  ones arrive.
- Groups: "File names" holds hits with a matched span in `name`, "Contents" the rest, each in rank
  order. Loading more pages appends to both groups.
- **Highlights are text** (library core §6): `Span[]` render as `<mark>` elements with text
  children, styled with `color.search.highlight`. Never HTML (§14).
- Enter: close the dialog, set the reveal target in the navigation store, switch to Library (§8.2).
  Esc or the scrim closes it; focus returns to where it was.

## 10. Previews

### 10.1 Where each type renders

| Type (by extension, `lib/file-types.ts`) | Renders in | How |
|---|---|---|
| Images: png, jpg, gif, webp, avif, bmp, ico, svg | window | `<img src={contentUrl(entry)}>`: an SVG in `<img>` runs no script |
| HEIC | window | Chromium cannot decode it: `feat/ui-preview` checks the shell thumbnail (WIC) as the preview, else "Open with default app" (brief §5.3) |
| Audio, video | window | `<audio>` / `<video controls>` with `contentUrl`; the scheme answers `Range` |
| Text (txt, csv, log …) | frame | decoded text, line numbers |
| Code (by extension map) | frame | lowlight, line numbers |
| Markdown (md, markdown) | frame | markdown-it → maths → sanitiser → highlighted code blocks |
| PDF | frame | pdf.js viewer |
| Word, Excel, PowerPoint | — | M4, per the spike; M1 shows "Open with default app" |
| Anything else | window | icon, name, note, "Open with default app" (handoff §5) |

Everything parsed from file content runs in the frame; the window only points media elements at
`folio-file` URLs. The window fetches bytes for the frame with `fetch(contentUrl(entry))` (the main
CSP admits the scheme in `connect-src`, ipc-m1 §11.2) and transfers the `ArrayBuffer`.

Size limits, beyond which the preview shows "too large to preview" and "Open with default app":
text and code 5 MB (highlighted up to 1 MB and 20,000 lines, plain above), Markdown 2 MB, PDF
256 MB. Text is decoded as UTF-8 (with BOM detection for UTF-16), falling back to GB18030 when it
is not valid UTF-8: many Chinese notes written on Windows are GBK.

### 10.2 The frame

- `PreviewFrame` is the only component that renders an `<iframe>` (ADR-0001 action item 5): it
  sets `sandbox="allow-scripts"`, `src` on the `folio-preview` scheme, and a `title` naming the file.
  It is keyed by the entry id and `modifiedMs`, so every file, and every new version of it, gets a
  fresh frame.
- Renderers load on demand (`import()` per renderer), so a text preview never loads pdf.js.
- The frame builds its DOM itself and loads `tokens.css` and its renderer CSS from its own
  origin. The theme comes in the render message, since the app's theme can differ from Windows'.
- Document pages stay light in dark mode (`color.surface.page`, handoff §5); Markdown and code
  follow the theme.

### 10.3 Protocol

`preview/protocol.ts` grows from today's single `text` message. Every message is a tagged object;
each side validates shape and source before acting.

| Direction | Message | Content |
|---|---|---|
| frame → window | `ready` | the frame's script has loaded |
| window → frame | `render` | `renderer` (`text`, `code`, `markdown`, `pdf`), `bytes` (transferred), `language` (code), `theme`, `reduceMotion` |
| window → frame | `pdf` | `goToPage`, `zoom` (`fit-width`, `fit-page`, percent) |
| frame → window | `rendered` / `failed` | `failed.reason`: `tooLarge`, `unsupported`, `corrupt`, `renderer` |
| frame → window | `pdfState` | page, page count, zoom: the window draws the "1 / 4 · 100%" pill and its buttons, so their text and focus stay in the window |
| frame → window | `shortcut` | one of the §6.4 combinations pressed inside the frame |
| frame → window | `images` | the relative image paths a rendered note names (§10.4), deduplicated, at most 64 |
| window → frame | `image` | one path and its bytes (transferred) and MIME type, or `missing`; one message per image, as each arrives |
| frame → window | `link` | the address of a clicked link and the link's position in the frame, for the popover (§10.4) |

- The window accepts a message only when `event.source` is that frame's `contentWindow` and the
  origin is `"null"` (opaque); the frame accepts only `window.parent` (as today).
- No `ready` within 5 s, or no `rendered` within 15 s, shows the error state.
- The frame keeps removing WebRTC before any renderer runs (ADR-0001 action item 5).

### 10.4 Renderers

**PDF: pdf.js 6 (`pdfjs-dist`).**

- `PDFViewer` from `pdfjs-dist/web/pdf_viewer.mjs` with `EventBus` and `PDFLinkService`: lazy page
  rendering, a text layer for selection and screen readers, zoom. No scripting manager (PDF
  JavaScript never runs), `enableXfa: false`, annotations displayed but not editable.
- **No fetches.** The frame's CSP has no `connect-src`. `getDocument({ data, useWorkerFetch: false,
  BinaryDataFactory })`: a small factory returns CMaps (needed for Chinese PDFs), standard fonts and
  wasm files from bundled, lazily imported modules (`import()` is `script-src 'self'`).
- **Worker.** The frame's opaque origin cannot start a worker from a URL on another origin, so the
  worker is created from a `blob:` URL holding the bundled worker (Vite `?worker&inline`), which
  needs `worker-src blob:` in the preview CSP. The worker inherits the frame's CSP and gets no
  Tauri IPC. If WebView2 refuses the worker in the sandboxed frame, pdf.js runs on the frame's
  thread instead (its "fake worker": the frame imports the worker module and sets
  `globalThis.pdfjsWorker`); `feat/ui-preview` measures whether that blocks the window.
- **Wasm decoders** (JPEG 2000, JBIG2: common in scanned readings, ICC colour): need
  `'wasm-unsafe-eval'` in the preview CSP, which allows compiling WebAssembly and nothing else. If
  refused, `useWasm: false` falls back to the JS decoders pdf.js ships, slower.
- Both CSP additions are for the `folio-preview` scheme only (`crates/folio-app/src/preview.rs`),
  made by `feat/ui-preview` with `/security-review` and an e2e probe that the worker cannot reach
  the network or IPC. The main window's CSP does not change.

**Markdown: markdown-it 15.**

- Options: CommonMark plus tables and strikethrough, `linkify`, `html: true`: notes use raw HTML
  such as `<br>`, `<sub>` or `<details>`, and the sanitiser below removes everything else.
  markdown-it's own link validation stays on (no `javascript:`, `vbscript:`, `file:`).
- **Maths:** `@mdit/plugin-tex` (`delimiters: 'all'`, `mathFence: true`) finds `$…$`, `$$…$$`,
  `\(…\)`, `\[…\]` and ` ```math ` blocks and hands each formula to **Temml**
  (`renderToString`), which writes MathML. Chromium renders MathML Core natively with the system
  maths font, which is what handoff §5 asks for (`font.family.math`: Cambria Math). Temml runs
  with `trust: false`, `maxSize` and `maxExpand` limits, and `throwOnError: false`, so a broken
  formula shows as its source text. MathML is also what screen readers read.
- **Sanitiser:** the whole HTML output goes through DOMPurify (HTML and MathML profiles) into a
  fragment: no `script`, `style`, `iframe`, `object`, `embed`, `form`, `input`, `button`, `link`,
  `meta`, `base`; no event handler attributes; URLs limited to relative paths, `http`, `https`,
  `mailto` and `#` fragments, and for images also `data:` and `blob:`. The frame's CSP and sandbox
  would stop script anyway; sanitising keeps the rendered tree to what a note can mean.
- **Code blocks** are highlighted after sanitising, from their `textContent` (below).
- **Images next to the note** (`![](figure.png)`, `<img src="images/a.png">`, typical for Typora and
  Obsidian notes) are shown (ADR-0005, product decision 1):
  1. The frame renders every image with a relative path as a placeholder showing its alt text,
     and sends their paths in one `images` message (at most 64 per note; the rest keep their
     placeholders).
  2. The window checks the message (strings of at most 1,024 characters), percent-decodes each
     path, drops anything absolute (`/…`, `C:…`, `\\…`) or with a scheme, and calls
     `resolve_paths` with the note's `EntryRef` (shape below).
  3. For each path that resolves to a file with an image extension (`lib/file-types.ts`), the window
     fetches `contentUrl(entry)`, up to 20 MB per image and 100 MB per note, and posts an `image`
     message with the bytes; everything else gets `missing`.
  4. The frame makes a `blob:` URL (its CSP allows `img-src blob:`) and swaps it into the
     placeholder; a missing image keeps its alt text and a "not found" mark.
  - Images on the web (`https://…`) keep their placeholder with the address: the frame has no
    network, by design. `data:` images render directly.
  - A hostile note can name other files of the library this way, but the shell answers with
    catalogued files only, the window passes on image types only, and the frame can send nothing
    anywhere (ADR-0005, trade-off analysis).
- **Links** are inert (ADR-0005, product decision 2). In the frame, a link shows its address as a
  native tooltip (`title`); `#fragment` links scroll within the note; any other click is cancelled
  and sends `link` to the window, which shows the address in a small popover next to it with
  "Copy address" (the window has the clipboard; the frame does not). PDF links behave the same
  through `PDFLinkService`, with page destinations inside the document still working. Opening
  addresses in a browser, or other library files from a note, is left for a later version.

Proposed shape of `resolve_paths`, for the contract lane `feat/ipc-m1-contract-fixes` to settle in
ipc-m1 (the contract lane may rename or reshape it):

```ts
resolve_paths({ base: EntryRef; paths: string[] }) → (EntryRow | null)[]   // same order as `paths`
```

- `base` is a file; each path is resolved against its folder. Paths are relative text as a note
  writes it after percent-decoding: names separated by `/` or `\`, with `.` and `..`. The shell
  normalises (NFC, library core §3) and resolves in the catalog.
- An item is `null` when it leaves the library, is not catalogued (missing, ignored, `.folio/`),
  or is a folder. No absolute path is ever accepted (ipc-m1 §17 rule 1).
- Limits: at most 64 paths (a new `LIMITS` key), each at most 1,024 characters: `InvalidArgument`.
  `base` stale or gone: `NotFound`.
- It reads only: no grant beyond reading the catalog, like `get_entry`.

**Code and highlighting: lowlight 3 (highlight.js 11 grammars).**

- lowlight returns a syntax tree; the frame builds `<span>`s from it with `textContent` only, one
  element per line (for line numbers), so no highlighted file is ever parsed as HTML.
- The language comes from the extension (`lib/file-types.ts`), never from auto-detection, which
  is slow and wrong on short files. Grammars load on demand; lowlight's common set covers most
  course files, and `feat/ui-preview` registers the rest it needs (MATLAB, R, LaTeX, Verilog …).
- highlight.js classes map to the `color.syntax.*` tokens in the frame's CSS.

### 10.5 Keyboard and focus

- The frame forwards the §6.4 combinations as `shortcut` messages and handles everything else
  (scrolling, text selection, `Ctrl+C`).
- Esc inside the frame moves focus back to the preview header.

## 11. Fake shell for the browser pane and tests

### 11.1 Design

A fake shell in `src/ipc/mock/` stands in for the Tauri shell (ADR-0005 §5). It plugs in below the
generated bindings through `@tauri-apps/api/mocks` (`mockWindows('main')`,
`mockIPC(handler, { shouldMockEvents: true })`), exactly as `src/test/setup.ts` already does, so
the real `ipc` module, `typedError` and `shellEvents` run unchanged.

```text
src/ipc/mock/
  index.ts        installFakeShell(options): installs the mocks, returns controls
  shell.ts        FakeShell: an in-memory library, catalog revision, jobs, problems, choice tokens;
                  dispatch(command, args) -> data, or throws an AppError { code, detail }
  commands/       one file per command group: library, groups, tags, entries, search, files, import, jobs
  fixtures/       small (hand-written), large (seeded generator, 50,000 entries), first-run, read-only
  scenarios.ts    URL parameters -> fixture, latency, forced errors
```

Behaviour it reproduces, per ipc-m1:

- Pages, totals and revisions; natural name order with folders first (`Intl.Collator` with
  `numeric`), ties by path; `LIMITS` checks (`InvalidArgument`).
- References: an `EntryRef` whose id is not at that path is `NotFound`.
- Mutations change the in-memory library, bump the revision and emit `CatalogChanged` through the
  typed `events.*.emit`, so the data layer's invalidation runs as in the app. Jobs emit `JobChanged`.
- Search: case-insensitive substring over names, paths and tag names, with `Span`s, a window of 500
  and `more`; `QueryTooLong`.
- Dialog commands (`pick_library_folder`, `pick_import_files`) return a scripted choice token.
- Fixture names mix Chinese and English, course codes, NFC paths, nested folder tags, sizes from
  bytes to gigabytes, and a few problems.

It does not reproduce the file system, scans or the `folio-file` scheme: media previews show their
error state in the browser, and the fixtures serve a few sample files through
`blob:` URLs where a screen needs them.

### 11.2 In the browser pane

- `main.tsx`: when `import.meta.env.DEV` and the page is not in Tauri (`__TAURI_INTERNALS__` is
  absent), import and install the fake shell before the first render. The same Vite dev server then
  serves both the app (`pnpm dev`) and the browser pane: open `http://localhost:5173/`.
- Parameters: `?scenario=small|large|first-run|read-only|errors`, `?latency=<ms>` for loading
  states, `?fail=<command>:<code>` for error states.
- Production builds contain no fake shell: `import.meta.env.DEV` is statically false, so the import
  is removed. The fake sets `window.__FOLIO_FAKE_SHELL__`; an e2e test checks that the real app
  has no such property.
- A `.claude/launch.json` entry that attaches to `http://localhost:5173` lets agents open it in the
  browser pane without a second dev server (CLAUDE.md §7.5: one dev server).

### 11.3 In component tests

- `src/test/render.tsx`: `renderApp(ui, { fixture, fail })` creates a fresh `QueryClient`
  (`retry: false`, `gcTime: Infinity`), the providers, and a fake shell with the fixture.
  View-level tests use it; small components keep `vi.mock('../ipc')` as today.
- `@testing-library/user-event` drives keyboard patterns (tree keys, type-ahead, dialogs).
- Every state a handoff spec names (loading, empty, error, success) gets a component test
  (testing strategy, coverage targets).

### 11.4 Virtualisation in jsdom

jsdom has no layout, so a virtualiser renders nothing. `src/test/virtual.ts` provides a context
that gives the collections an `initialRect` (for example 800 × 600) in tests; real scrolling is
covered by e2e.

### 11.5 Drift

The fake is typed by `bindings.ts`, so `tsc` catches any change of shape. Behaviour can drift:
each command file states which spec sections it follows, the e2e flows run against the real shell,
and when a core lane implements a command, the next UI lane that uses it compares the fake with the
implementation. Codex lanes do not edit `apps/desktop` (roadmap §4.1): they hand differences over
in writing.

## 12. i18n structure (from `feat/ui-i18n-english`)

The lane `feat/ui-i18n-english` decided the i18n structure, not this spec; it landed on 2026-09-28
(`5e88bd0`, `720c5b9`). This section describes what it built; `apps/desktop/src/i18n/README.md` is
the reference, and wins if the two ever differ.

- **One locale in v1: `en`**, the default and the fallback. No language detection: the UI never
  follows the Windows display language; `<html lang="en">`. `zh-CN` is not kept as a second locale
  until the Chinese UI version (README, "Simplified Chinese").
- **One namespace per view**, each in `src/i18n/locales/en/<namespace>.json`, created up front for
  every UI lane on the roadmap, so parallel lanes add strings to different files: `common`,
  `errors`, `titlebar`, `shell` (toolbar, rail, layout, failed window commands), `library`,
  `search`, `preview`, `import`, `settings`, `first-run`, `diff`, `changes`, `history`, `sync`,
  `conflicts`, `remote-setup`.
- `common` holds only the product name and strings that shared components need; `errors` has one
  message per `AppError` code plus `Transport`.
- `src/i18n/resources.ts` lists the namespaces once, for the runtime and for i18next's type
  declaration (`resources: typeof en`, `defaultNS: 'common'`), so `tsc` rejects a key `en`
  lacks. A new namespace is one JSON file and one line there, added in its own lane or at a sync
  point.
- Plurals use i18next suffixes with `count`; dates, times and numbers are formatted in the UI
  language (`{{when, datetime}}` in a string, or `toLocale…String` / `Intl` with `i18n.language`
  in code), never with the system locale; ESLint rejects those calls without a locale.

How this architecture uses it:

| Folder | Namespaces |
|---|---|
| `app/` | `shell`, `common`, `errors` |
| `titlebar/` | `titlebar` |
| `components/` | `common` only (shared components carry no view's strings) |
| `library/`, `search/`, `preview/`, `import/`, `settings/`, `first-run/` | its own (`useTranslation(['library', 'common', 'errors'])`), then `common` and `errors` |
| `preview/frame/` | none: the frame shows no UI text; the window draws the PDF pill and every message (§10.3) |
| M2 and M3 folders (`changes/`, `history/`, `diff/`, `sync/`, `conflicts/`, `remote-setup/`) | their namespace of the same name |

Error states take their message from `errors` by `AppError` code (ipc-m1 §16.1); the preset tag
names sent to `create_library` come from `first-run` (ipc-m1 §6); `lib/format.ts` wraps `Intl`
with `i18n.language` for sizes and dates (handoff: "Sep 27", 12-hour "5:05 PM"). RAC's
`I18nProvider` gets the same language (§7.1).

## 13. Errors and states

- Every region that shows data renders exactly one of: loading, empty, error, ready. Loading shows
  skeleton rows after 150 ms (no flash for fast pages); the empty and error states follow the
  Cowork specs of `design/design-m1-flows`.
- `ErrorState` shows the message for the error's code from `errors` and a Retry button that
  refetches. `NotFound` on a reference refreshes the list the reference came from and says the item
  moved or was deleted. `Busy` names the running rebuild and re-enables when its `JobChanged`
  finishes. `ReadOnly` libraries (`LibraryInfo.readOnly`) disable editing controls up front.
- Batch results (`BatchResult.failed`) list every failed item with its message; nothing is dropped.
- Mutation errors show where the action started (the dialog, or the row's inline editor) and go to
  the live region.
- Each rail view, dialog and the preview sits in an error boundary that shows the `Internal` message
  with "Reload this view". Uncaught errors reach the console through `createRoot`'s
  `onUncaughtError` / `onCaughtError`; writing them to the shell's log needs a command (§18).
- Window-command failures (today only on the console) get an error state in `feat/ui-app-shell`
  (roadmap §3.4).

## 14. Security rules for the UI

1. **The window never parses library data as HTML.** No `dangerouslySetInnerHTML`, `innerHTML`,
   `outerHTML`, `insertAdjacentHTML`, `document.write`, `srcdoc`, `DOMParser` or
   `Range.createContextualFragment` outside `src/preview/frame/`; search spans and names render
   as text. Enforced by `no-restricted-syntax` / `no-restricted-properties` in ESLint (app-shell
   lane).
2. **Only `PreviewFrame` renders `<iframe>`**, with `sandbox="allow-scripts"` (ESLint rule on JSX
   `iframe`). Never `allow-same-origin`, never a `folio-file` URL as a frame source.
3. **Media only by URL.** The window shows library files only through `<img>`, `<audio>` and
   `<video>` with `folio-file` URLs; never `<object>`, `<embed>` or inline SVG from a file.
4. **Messages are validated** on both sides of the frame (§10.3).
5. **No `eval`**, `new Function` or string timers anywhere (typescript-eslint's `no-implied-eval`
   and core `no-new-func`); the one exception is WebAssembly compilation inside the frame (§10.4).
6. **Links from files never navigate anything.** The frame cancels link clicks (§10.4) and the
   main CSP's `frame-src` keeps the frame on `folio-preview`; opening a web address would need its
   own reviewed command (ADR-0005, product decision 2: not in M1).
7. **The fake shell never ships** (§11.2).

## 15. Testing

| Layer | What | Tool |
|---|---|---|
| Unit | revision compare, path scope checks, touch predicates for every event kind, flattener (prefix sums, placeholders, reveal), reference following, text decoding fallback | Vitest |
| Component | each collection's keyboard pattern and ARIA attributes; each state of each region; dialogs trap and return focus; search ignores IME composition | Vitest + Testing Library + user-event, fake shell |
| Browser pane | design critique and accessibility review of built screens on the `small` and `large` fixtures | Vite dev server, fake shell |
| E2E | one flow per feature on the real shell; axe with no serious or critical violations; reduced motion; the frame cannot reach IPC, the network or the `folio-file` scheme; the pdf.js worker and wasm stay inside the frame; no fake shell in the app | Playwright over CDP, `@axe-core/playwright` |
| Performance | on the 50,000 entry fixture in the browser pane: scroll the list and the expanded tree at 60 fps, jump to row 40,000, open search | manual in the browser pane, later a Playwright trace |

## 16. Packages for `chore/build-deps-ui-m1`

Versions are the newest stable releases at least one day old on 2026-09-28 (npm registry
publication times, UTC). The dependency lane re-checks every version, including transitive ones,
against pnpm's minimum release age when it installs; a newer patch that passes the check may
replace one listed here. Majors are fixed here.

`apps/desktop` dependencies:

| Package | Version | Published | Licence | For |
|---|---|---|---|---|
| `@tanstack/react-query` | 5.104.0 | 2026-09-26 | MIT | page cache (§5) |
| `@tanstack/react-virtual` | 3.14.13 | 2026-09-14 | MIT | virtualisation (§8) |
| `react-aria-components` | 1.21.1 | 2026-09-04 | Apache-2.0 | primitives (§7.1) |
| `react-aria` | 3.52.1 | 2026-09-04 | Apache-2.0 | `useContextMenu`, `FocusScope`, `useLandmark`; the exact version `react-aria-components` 1.21.1 depends on, so one copy is installed |
| `zustand` | 5.0.15 | 2026-08-13 | MIT | client state (§6) |
| `lucide-react` | 1.48.0 | 2026-09-24 | ISC | icons (handoff decision 3) |
| `pdfjs-dist` | 6.3.289 | 2026-08-29 | Apache-2.0 | PDF (§10.4) |
| `markdown-it` | 15.0.2 | 2026-09-11 | MIT | Markdown; ships its own types |
| `@mdit/plugin-tex` | 1.1.2 | 2026-09-26 | MIT | maths delimiters (peer `markdown-it` ^15.0.2) |
| `temml` | 0.13.5 | 2026-08-28 | MIT | LaTeX → MathML |
| `lowlight` | 3.3.0 | 2024-12-14 | MIT | syntax tree for highlighting |
| `highlight.js` | 11.11.2 | 2026-08-11 | BSD-3-Clause | grammars; lowlight 3.3.0 requires `~11.11.0`, so not 11.12 |
| `dompurify` | 3.4.16 | 2026-09-23 | MPL-2.0 OR Apache-2.0 | sanitiser; ships its own types |

`apps/desktop` devDependencies:

| Package | Version | Published | Licence | For |
|---|---|---|---|---|
| `@testing-library/user-event` | 14.6.7 | 2026-09-02 | MIT | keyboard tests (§11.3) |
| `@types/hast` | 3.0.5 | 2026-07-09 | MIT | types of lowlight's tree |
| `@tanstack/eslint-plugin-query` | 5.104.0 | 2026-09-26 | MIT | lint: query keys cover what the query function uses |

`e2e` devDependencies:

| Package | Version | Published | Licence | For |
|---|---|---|---|---|
| `@axe-core/playwright` | 4.13.0 | 2026-08-11 | MPL-2.0 | the accessibility layer of the testing strategy |

Considered and not added: `katex` (replaced by Temml, §10.4), `marked`, the unified / remark /
rehype family (more packages for the same result), `shiki` (heavier; lowlight's tree is enough),
`sanitize-html` (Node-oriented), `radix-ui` and `@base-ui/react` (ADR-0005 §3), `react-window`,
`react-virtuoso`, a router, `@tanstack/react-query-devtools`, `@dnd-kit/*` (no M1 design drags
inside the page), `katex` fonts and CSS.

## 17. Open items for the implementation lanes

1. pdf.js in the sandboxed frame: whether WebView2 starts a `blob:` worker there; time to first page
   on a 300-page scanned PDF; the fake-worker fallback's effect on the window (`feat/ui-preview`).
2. Temml's output on real course notes (aligned environments, matrices, `\mathbb`) with Cambria
   Math; KaTeX with its own fonts is the fallback if it falls short (`feat/ui-preview`).
3. The filtered-tree cap of 5,000 matches (`feat/ui-library-view`, §8.2).
4. Whether Tauri exposes WebView2's browser accelerator keys setting (`feat/ui-app-shell`, §6.4).

## 18. Next lanes and changes to other documents

- **New lane `feat/ui-data-layer`** (wave 2, beside `feat/ui-app-shell`; Claude Code, front end,
  M): `data/` client, keys, session, events, references and paged lists; `ipc/mock/` with the
  `small`, `large` and `first-run` fixtures; `test/render.tsx` and `test/virtual.ts`; the
  `.claude/launch.json` browser-pane entry. `feat/ui-app-shell` then owns only `app/`,
  `components/`, `lib/`, `titlebar/`, and the ESLint rules of §3 and §14. Added to the roadmap's
  wave 2 on 2026-09-28 (ADR-0005, product decision 4).
- **`feat/ui-preview`**: `worker-src blob:` and `'wasm-unsafe-eval'` in `preview.rs` with
  `/security-review` (§10.4); the frame protocol (§10.3); images next to notes and the link
  popover (§10.4); moves `src/preview/frame.ts` into `src/preview/frame/`.
- **New lane `feat/ipc-m1-contract-fixes`** (wave 2, contract, S; ADR-0005 product decision 1;
  first named `feat/ipc-m1-resolve-paths`, renamed on 2026-09-28 when the M1 design hand-off's
  contract gaps joined it, roadmap wave 2): declares `resolve_paths` (§10.4) in ipc-m1 and
  `crates/folio-app/src/ipc/`, planned and not registered (ipc-m1 §3), regenerates the bindings,
  and adds its `LIMITS` key. It lands before `feat/data-browse-queries` implements the command;
  `feat/ui-data-layer` or `feat/ui-preview` adds it to the fake shell.
- **Not in M1**: a reviewed command that opens `http`/`https` links in the default browser
  (ADR-0005, product decision 2).
- **Contract for UI error logging**: a command that writes UI errors to the shell's log (§13),
  declared by `feat/ipc-m1-contract-fixes` and implemented by `chore/core-logging` (roadmap wave 2).
- **Testing strategy**: add the fake shell, the `renderApp` helper and `@axe-core/playwright` to
  its layers when `feat/ui-data-layer` lands.
- **CLAUDE.md §6 directory map**: describe `apps/desktop/src` by feature folders once the app-shell
  lane has created them.
