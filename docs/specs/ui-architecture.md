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

As built (`feat/ui-app-shell`, 2026-09-30): features may import `ipc` types and the file URL
helpers but not the `ipc`, `shellEvents` or `windowControls` values, nor `ipc/bindings`, `events`,
`window` or `mock`; `components/` and `lib/` may import `ipc` types only, and neither imports
`app/`, `data/` or a feature; `lib/` imports no React or state library. `app/` (the shell) may import
anything, and features may import `app/` stores (`navigation`, `toasts`, `announcer`). The §14
rules are `no-restricted-syntax` selectors in the same file. `data/` has no import rule.

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
  preview/               PreviewPane, PreviewHeader, PreviewBody, PreviewFrame (the only <iframe>),
                         protocol.ts, kinds.ts (§10.6)
    frame/               runs inside the frame: main.ts (entry), text.ts, highlight.ts, markdown.ts, pdf.ts
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
['lib', libraryId, 'count',    'children' | 'files' | 'problems', request]   // a page with limit 0
['lib', libraryId, 'search',   { text, scope }]                 // infinite query, pages of 50
['lib', libraryId, 'entry',    entry]                           // the EntryRef, see below
['lib', libraryId, 'semesters'] | ['lib', libraryId, 'courses', semesterPath | null]
['lib', libraryId, 'tags'] | ['lib', libraryId, 'jobs'] | ['lib', libraryId, 'problems', pageIndex]
['app', 'libraryStatus']
```

`data/keys.ts` is the only place that builds keys; the invalidation predicates (§5.4) read them.

As built (`feat/ui-data-layer`, 2026-09-30): an `entry` key holds the whole reference, not only the
id. The query function needs the path, and after a move the old key must not be refetched under
the same key: the reference followers (§5.5) give the holder the new path, and the old key
answers `NotFound` if anyone still shows it. `data/touch.ts` holds the predicates; a key kind it
does not know is touched by every change, so a lane that adds one refreshes too often rather than
too rarely until it adds its rule.

As built (`feat/ui-data-m1-hooks`, 2026-09-30): `courses` has no semester path. Every view needs
the courses of every semester (course codes in paths), so `list_courses` with `semester: null` is
cached once and `useCourses(semesterPath)` and `useCourseOf(path)` select from it. Two kinds were
added: `['lib', id, 'resolve', { base, paths }]` (`resolve_paths`), touched by every entry change,
since a note may name any path and names match without case; and `['lib', id, 'importCheck',
{ source, target }]` (`check_import`), touched by entries coming, going and moving in its target
(not by tags or content), so name clashes stay current. `tags` touches `search` too: the search index holds tag names (library core §5.2).

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

Counts (quick views, course and folder counts) are separate queries with `limit: 0`
(`useCount` in `data/paged.ts`).

As built:
- `usePagedList(listKey, fetchPage, range)` takes `listKey` as a function of the library id
  (`keys.children`, …) and asks nothing while no library is open; single queries do the same
  through `libraryQuery` in `data/keys.ts`.
- While the visible range keeps moving, pages are asked for at most every 100 ms
  (`RANGE_SETTLE_MS`), and the last range always lands: dragging the scroll bar to row 40,000 asks
  for the pages where it rests, not for every page it passes (§8.1). Rows of pages not yet asked
  for show placeholders meanwhile.
- Pages fetched ahead are not watched (`queryClient.query`), so a refresh removes them and they
  are fetched again once visible.
- While pages of two revisions are on screen (a refetch is under way), a row the newer pages
  already hold is a placeholder in the older page, so no id is rendered twice.

### 5.4 CatalogChanged and revisions

One subscription at the app root (`data/events.ts`, mounted by the data provider) handles every
catalog event; components never subscribe to `CatalogChanged` themselves.

**Revisions.** `data/session.ts` keeps `libraryId` and `lastRevision`, the revision of the newest
`CatalogChanged`. Revisions wrap at 2³² (ipc-m1 §15.2), so `lib/revision.ts` compares them with
serial-number arithmetic: `a` is older than `b` when `(b - a) mod 2³²` is between 1 and 2³¹ − 1. A
page whose revision is older than `lastRevision` arrived after an event that may have changed it:
its query is invalidated once for that event revision.

As built (`feat/ui-data-layer`, 2026-09-30), the overtaken answer is handled when the event
arrives instead: a touched query whose fetch is still under way is cancelled and asked again
(`refresh` in `data/events.ts`). That covers every kind of query, counts and single entries too,
which carry no revision; TanStack Query would otherwise let a running first load finish with its
older answer. Revisions then serve one purpose: a touched query whose data was read at the event's
revision or later is not refetched. `lastRevision` lives beside the store in `data/session.ts`
(`latestRevision()`), since only the event handler reads it. The fake shell sends a command's
events before its answer when `?latency` is set, so the browser pane and tests see this race.

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

As built (`feat/ui-data-m1-hooks`): `data/mutations.ts` wraps every command mutation.
`useCommandMutation` rejects with the typed `IpcFailure`; `useBatchMutation` resolves with
`BatchResult` as the shell sent it, every failed item with its `AppError`, and rejects only when the
whole request fails. A `NotFound` for an entry the request named (or, for a batch, a failed item's
`NotFound`) refreshes at once what shows that entry (`touchesGone` in `data/touch.ts`: what its
removal would touch), which is library-actions §9.4 "refetches the view"; a `NotFound` for a tag
refreshes `tags`. Queries keyed by the stale reference or something below it are left to the
reference followers, since asked again they would only answer `NotFound` until the event moves
their holders; the refresh goes to the library the request was sent for. `check_import` does not
use up its token and `import_files` does, so the import dialog stops the check (passes `null`, or
closes) once it sends the import. Creating or opening a library resolves before or after its
LibraryStateChanged; the cache switches on the event only.

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
- `ProblemsChanged { total }` updates a `problemsTotal` value and invalidates `problems` pages. As
  built, the value is the problem count query (`useProblemsTotal`), written with `setQueryData`.
- As built, `data/jobs.ts` replays JobChanged events that arrive while `list_jobs` runs, and an
  event never takes a job back (queued, running, finished; progress never decreases), so an event
  that overtook `list_jobs` cannot leave a finished job spinning.
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

Theme, reduce motion and device name are shell settings (ipc-m1 §22), not UI preferences: the
shell needs the theme before the first frame (no white flash, roadmap §3.4).

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

As built (`feat/ui-app-shell`): `app/registry.ts` lists what the shell hosts, and each lane adds
its entry there with a one-line edit: `VIEWS` (rail button, `Ctrl+<n>`, component; the Library
entry is a placeholder until `feat/ui-library-view` replaces it), `DIALOGS` (a component per
`DialogKind` of `app/navigation.ts`, which gets `isOpen`, `params` and `onClose` and stays mounted
so its closing animation plays) and `TOOLBAR` (`sync`, `semester`, `activity` controls, each
rendered wide or `compact`). Registering `search` shows the toolbar's search button and `Ctrl+K`,
`librarySettings` the gear and `Ctrl+,`, `appSettings` the avatar: until then they stay hidden,
like the M2 views. `app/Toolbar.tsx` provides `SemesterButton` and `app/activity/` the `Activity`
button and popover, both presentational, for the lanes that wire them to data.

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

As built (`feat/ui-app-shell`): the generator writes `src/tokens/tokens.ts` beside `tokens.css`,
with every `size.*` and `space.*` token in pixels (`SIZE.narrowBreakpoint`, `SIZE.row`,
`SPACE[8]`), for media queries, icon sizes and overlay offsets. Before the first render,
`main.tsx` awaits `startAppearance()` (`app/appearance.ts`, from `feat/core-app-settings`: the
stored settings through `get_app_settings`, loaded while the strings load, then every
`AppSettingsChanged`, so `feat/ui-settings` only calls `update_app_settings`) and calls
`watchLayout()`. The shell builds the main window itself (`create: false` in `tauri.conf.json`)
with `color.surface.app` of the stored theme, or of Windows' app mode for System, as the window
and WebView2 background (`crates/folio-app/src/window_background.rs`, whose test keeps the
colours equal to the tokens), and repaints it when App settings change the theme, so a dark
first frame never flashes white.

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

As built (`feat/ui-app-shell`): `registerShortcut(combo, run, options)` and the `useShortcut` hook
register; `handleShortcut(press)` is the one matcher, which the window's listener
(`installShortcuts`, mounted by `App`) and the preview frame's forwarded presses both call. The
newest registration of a combination wins while it exists, and where the press happened is looked
at only once it matches. A modal counts as open while any shared `Modal` is on screen (its overlay
carries `MODAL_ATTRIBUTE`, `isModalOpen()`), the navigation store's or a view's own. The combos
live beside the registry (`SEARCH_KEYS`, `LIBRARY_SETTINGS_KEYS`, `viewKeys(n)`), and tooltips,
menus and key caps print them with `useShortcutLabel` ("Ctrl+K", or "Ctrl K" on a key cap; key
names from `shell:keys`).

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

As built (`feat/ui-app-shell`): the wrappers are `Button`, `IconButton` (tooltip with the label
and shortcut), `Tooltip` (`TOOLTIP_DELAY_MS` from `lib/timing.ts`), `SegmentedControl`,
`TagToggle` and `TagChipList`, `Menu` / `MenuItem` / `Submenu` / `MenuButton`, `ContextMenu` with
`useContextMenuTrigger`, `Modal` and `DialogFrame`, and `ProgressBar`; the presentational parts of
app-shell handoff §10 and library-actions §2 (`CourseBadge`, `CourseLabel`, `TagDot`,
`FileTypeIcon`, `ChangeStatusIcon`, `CountPill`, `KeyCap`, `Panel`, `StateBlock`, `Banner`,
`Callout`, `FieldError`, `Toast`, `ProgressRing`, `Spinner`, `Skeleton`, `MiddleTruncate`) are own
markup. Menus, submenus, context menus and the Activity popover share one `Popover` surface;
banners, state blocks, toasts and the activity icons take their tone colours from
`components/tone.css` (`data-tone`), as badges and dots take palette colours from `palette.css`;
fades and rises share the keyframes of `components/motion.css`. The folder picker
(library-actions §2.9) is built from the tree rows, so it comes with `feat/ui-library-view`.

While a modal dialog or modal popover is open, React Aria makes the rest of the window inert.
Three parts stay usable through its markers: the caption buttons and the toast stack carry
`data-react-aria-top-layer` (`TOP_LAYER_ATTRIBUTE`), which `ariaHideOutside`,
`useInteractOutside` and `FocusScope` honour, and the `Announcer` carries
`data-live-announcer`. The title bar's own element stays out of the inert set because it holds
the caption buttons, so it still drags the window; a press on it never closes a dismissable
modal (`WINDOW_BAR_ATTRIBUTE`). The narrow bar's toolbar controls go inert with the rest.

Deviations:

- Toasts are own markup (`components/Toast`, the queue in `app/toasts.ts`, the region in
  `app/ToastRegion.tsx`), not RAC 1.21's `UNSTABLE_Toast`: that one is unstable, gives each toast
  `role="alertdialog"` and puts it in the tab order through its landmark, where the handoff asks
  for `role="status"` / `"alert"` toasts that never take focus. Toast buttons stay reachable with
  Tab at the end of the page, so "Copy details" of a failed window command, which has no other
  place, works from the keyboard.
- RAC composes a tag's remove button name from its own label and the tag's: the label is
  "Remove tag", the name "Remove tag Notes".
- A disabled menu item is skipped by the arrow keys (RAC's behaviour), where library-actions §2.7
  asks for it to stay focusable; RAC 1.21 has no option for that. The item keeps
  `aria-disabled` and the tertiary colour.
- RAC's `DialogTrigger` does not set `aria-haspopup="dialog"`; the activity button and the rail's
  gear and avatar set it themselves.

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

As built (`feat/ui-library-view`, 2026-10-01): the three hooks became helpers in
`components/collections/`: `keys.ts` (`handleCollectionKey`: arrows, Home, End, Page Up, Page
Down, Space, Enter, Ctrl+A, type-ahead), `selection.ts` (what a key or click does: replace,
toggle, extend, focus), `rows.ts` (one delegated listener per collection, rows found by
`data-index`), `useTypeahead.ts` and `useVirtualRows.ts` (the virtualiser; the focused row always
rendered; focus put back when React replaces the focused element, as when a placeholder's page
arrives; the range reported in steps of 16 rows, so scrolling re-renders the view every few rows;
`sizesKey` for rows of other heights that move, `itemsPerRow` so a grid reports its range again
when its columns change). A held key repeats only moving and type-ahead (`ignoreRepeat`): Space,
Enter, Ctrl+A and a view's own keys such as Delete act once. The selection lives in the view (`library/state.ts`,
`library/selecting.ts`): selected entries by id, the anchor and the focused row as key and index.
"All" is not stored as a list key with exceptions: Ctrl+A and Shift ranges load the pages they need
first (`loadPage` on the lists of `usePagedList` and `useFolderChildren`), then select up to
`LIMITS.batch` entries, with a message beyond. `VirtualTree` also takes `multiselectable` (the Move
dialog's folder picker chooses one) and `collapsible` (the filtered tree shows everything open).
Shared components added on the way: `Select`, `DeskIllustration`, `MenuSection`; `ContextMenu`
takes a `label` (its popover is a dialog without a trigger) and closes when a menu inside it
chooses an item, Enter in a submenu included; `Panel` takes a `countLabel`; `FileTypeIcon` has a
thumbnail size. `app/panes.ts` holds the slot `feat/ui-preview` fills with its preview pane, and
`HostedDialogs` (`app/navigation.ts`) tells a view which dialogs another lane has registered.

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

As built (`feat/ui-library-view`, 2026-10-01): `library/tree/layout.ts` (`TreeLayout`) keeps the
quick views, each course with its expanded folders as prefix sums, and the semester's loose files
after a separator; rows are built when first read and kept for the layout's life, so memoised
rows do not re-render. `useTreeData` watches page 0 of the semester and of every expanded folder,
the page that holds each expanded folder's own row, the rows on screen and 50 beyond, the focused
row's page, and while a reveal waits every page of its folder up to the first missing one, then
the page that holds it. `useFolderChildren` keeps a folder's list object while its pages and errors
stay the same, so another folder's page does not lay the tree out again.
Tree pages use the default `gcTime`, not `Infinity` removed on collapse: totals and the rows of
expanded folders come from pages the tree always watches, so an evicted page only shows
placeholders and nothing below it moves. Only rows of a page that failed say so; a failed first
page of the semester is one row after the courses. The filtered tree (`library/tree/filtered.ts`)
asks for page 0, then the pages up to the total or the cap, and shows every course and folder open
(not collapsible); "New folder" turns the filter off, since a folder without files cannot show in
it, and a narrow window, where the filter bar is hidden, shows the whole tree. §17 item 3: the cap
stays at 5,000 (`FILTER_CAP`); beyond it an information banner offers the List mode, which pages
through every match. It was not timed on the 50,000-entry fixture.

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

As built (`feat/ui-data-m1-hooks`): `useSearch(text, scope)` in `data/search.ts` returns hits, a
status (`idle` without text), `isPrevious`, `hasMore` and `loadMore`. It trims the text, answers
`QueryTooLong` without calling the shell, and asks for no page past `LIMITS.searchResults`. The
shell ranks its window once per revision, so a page read at another revision than the first page
could overlap or skip: it is dropped with the pages after it, and the first page is asked again
(one call; the list asks for the rest as it scrolls). Text is sent well formed
(`toWellFormed`), since a lone surrogate would fail the call as `Transport`. `keepPreviousData`
never keeps another library's hits. The 120 ms pause and IME handling stay in
the palette.

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

- `PDFViewer` from `pdfjs-dist/legacy/web/pdf_viewer.mjs` (the legacy build, §10.6) with
  `EventBus` and `PDFLinkService`: lazy page rendering, a text layer for selection and screen
  readers, zoom. No scripting manager (PDF JavaScript never runs), `enableXfa: false`, annotations
  displayed but not editable.
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
ipc-m1 (the contract lane may rename or reshape it). Settled on 2026-09-29 with this shape and the
limits `resolvePaths` and `relativePathChars`; ipc-m1 §9.1 is the reference (the window also drops
`?…` and `#…` parts before percent-decoding):

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

### 10.6 As built (`feat/ui-preview`, 2026-10-01)

- **Pane.** `preview/PreviewPane.tsx` is `PREVIEW_PANE` in `app/panes.ts`. Its props: `entry`,
  `onBack`, `moreMenu`, `tagMenu` (the host's Tags menu for "+ Tag") and `actions`
  (`open`, `showInExplorer`, `setTags`): the host passes its own commands, so the toasts of
  library-actions §9.3 exist once. The Library passes `useLibraryCommands()` and its
  `TagsSubmenu`. The header follows app-shell §5 without "View history of this file" (M2); a
  narrow window keeps Open and More. A read-only library shows tags without remove buttons or
  "+ Tag". The body remounts for every id, path, version and "Try again".
- **Kinds** by extension live in `preview/kinds.ts` (`previewKindOf`, `codeLanguageOf`,
  `imageTypeOf`), on top of `lib/file-types.ts`. Audio and video Chromium cannot play (wma, aiff,
  avi, wmv, mpg) get the card; so does a media file that fails to decode. Folding these tables
  into `lib/file-types.ts` as one table per extension is left for a later cleanup.
- **HEIC and TIFF** (HEIC checked 2026-10-01 with a file from Windows' own HEIF encoder):
  WebView2 154 cannot decode them in `<img>`. The 256 px thumbnail the scheme makes through WIC
  shows, with "Reduced preview from Windows" and "Open with default app"; when Windows has no
  thumbnail (no HEIF extension, say) the scheme answers `NoThumbnail` and the card shows.
- **Protocol** (`preview/protocol.ts`, validated on both sides, unknown keys refused) adds to
  §10.3: `render.strings`, the few words the frame shows (its document title, image placeholder
  notes, the label of the text), since the frame has no UI strings; an `appearance` message when
  the app's theme or reduced motion changes while a file shows. Esc arrives as a `shortcut`
  message, and `isForwardedPress` (Esc, or Ctrl with one character or Enter) decides on both
  sides which presses travel, so a misbehaving frame can press no other key in the window. PDF
  zoom is `fit-width` or a percentage. The size limits are in the protocol, so the frame checks
  them too. The frame starts while the window fetches the bytes; `render` goes once both are
  ready.
- **Text and code** show the line numbers as one text node in a sticky gutter and the text as one
  `<pre>`, highlighted spans or plain, instead of one element per line: a 5 MB log costs a handful
  of elements, and selecting text never takes numbers.
- **PDF.** The worker is the bundled `pdf.worker.mjs` behind Vite's `?worker&inline` (a `blob:`
  URL; Vite's `data:` fallback is refused by `worker-src blob:`). The frame waits up to 3 s for its
  `ready` and otherwise imports the worker module, so pdf.js runs on the frame's thread. CMaps,
  standard fonts and the three decoders (`openjpeg`, `jbig2`, `qcms_bg`; not `quickjs-eval`, the
  PDF JavaScript engine) are bundled as lazily imported `data:` modules (`?url&inline` globs) that
  a `BinaryDataFactory` decodes; `iccUrl` stays unset (pdf.js reads that profile with a
  synchronous fetch, which the CSP refuses). Zoom starts at pdf.js's `auto` (the panel's width,
  at most 125 %, a whole page for landscape pages).
  Measured 2026-10-01 in the debug build, WebView2 154, a 300-page 100 MB scanned PDF with an
  ICC-profiled image per page: the `blob:` worker starts in the sandboxed frame; the first page
  renders 1.46 s after the click (three runs, 1.46–1.49 s); the window's longest frame gap during
  the load is 90–95 ms. The frame runs in its own renderer process (another site), so a frame
  thread kept busy for 2 s left the window's longest frame gap at 6 ms: the fallback cannot block
  the window. An e2e probe checks that a worker in the frame starts from `blob:` only, compiles
  WebAssembly, and reaches neither the network, IPC, the `folio-file` scheme, other scripts nor
  `eval`.
  The frame loads pdf.js's **legacy build** (`pdfjs-dist/legacy/…`), since 2026-10-02: the modern
  build of 6.3 calls JavaScript added after Chromium 131 (`Map.prototype.getOrInsertComputed`,
  `Math.sumPrecise`, `Uint8Array.fromBase64`), so on WebView2 131, which CI's windows-2022 runner
  has and an Evergreen runtime held back by policy can have, every PDF failed. The legacy build
  brings them as polyfills; the same 300-page PDF's first page takes 1.38–1.40 s with it against
  1.36–1.48 s with the modern build (debug build, WebView2 154), and the frame's pdf.js chunk grows
  by 0.1 MB. A pdf.js error that is not a password or a damaged file is logged in the frame's
  console.
- **Maths** (§17 item 2): Temml with Cambria Math renders aligned environments, `pmatrix`,
  `cases`, `\mathbb`, sums, integrals and fractions on a real midterm review cleanly in both
  themes; KaTeX is not needed. `Temml-Local.css` comes along for `\cancel`, boxes and script
  letters. Temml loads only for notes with `$`, `\(`, `\[` or a ` ```math ` fence, and the
  grammars only for fenced code (each block up to the code renderer's 1 MB).
- **Images next to a note** follow §10.4; the frame sends the raw paths, the window decodes them
  (`notePath`), and a path that names a catalogued file that is not an image (a PDF, say) gets
  `missing`, so its bytes never reach the frame.
- **Loading** shows skeleton rows over the frame (not instead of it: a hidden frame would not
  render its first page) until `rendered`.

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
  states, `?fail=<command>:<code>` for error states. As built (`src/ipc/mock/scenarios.ts`) also
  `?scenario=unavailable` with `?reason=<Unavailable>` and `?retry=open` (then "Try again"
  opens it), and for `first-run` `?choice=<FolderContent kind>` and `?sync=<SyncProvider>`.
  The console drives the fake through `window.__FOLIO_FAKE_SHELL__`: `finishJobs()`,
  `dropFiles()`, `setProblems()`, `makeUnavailable()`, `setFailure()`.
- Production builds contain no fake shell: `import.meta.env.DEV` is statically false, so the import
  is removed. The fake sets `window.__FOLIO_FAKE_SHELL__`; an e2e test checks that the real app
  has no such property.
- A `.claude/launch.json` entry that attaches to `http://localhost:5173` lets agents open it in the
  browser pane without a second dev server (CLAUDE.md §7.5: one dev server). As built:
  `desktop-browser-pane` attaches; `desktop-vite` starts the dev server when none runs.

### 11.3 In component tests

- `src/test/render.tsx`: `renderApp(ui, { fixture, fail })` creates a fresh `QueryClient`
  (`retry: false`, `gcTime: Infinity`), the providers, and a fake shell with the fixture.
  View-level tests use it; small components keep `vi.mock('../ipc')` as today. As built,
  `renderAppHook(hook, …)` does the same for data hooks, and the library status is in the cache
  before the first render, as in the app once `library_status` has answered.
- `@testing-library/user-event` drives keyboard patterns (tree keys, type-ahead, dialogs).
- Every state a handoff spec names (loading, empty, error, success) gets a component test
  (testing strategy, coverage targets).

### 11.4 Virtualisation in jsdom

jsdom has no layout, so a virtualiser renders nothing. `src/test/virtual.ts` provides a context
that gives the collections an `initialRect` (for example 800 × 600) in tests; real scrolling is
covered by e2e.

As built: no context. TanStack Virtual measures its scroll element (`offsetWidth`,
`offsetHeight`) as soon as it mounts and replaces `initialRect` with jsdom's 0 × 0, so
`mockLayout()` gives every element an 800 × 600 box instead, and `renderApp` applies it by
default (`layout: false` turns it off). The collections need no test-only code.

### 11.5 Drift

The fake is typed by `bindings.ts`, so `tsc` catches any change of shape. Behaviour can drift:
each command file states which spec sections it follows, the e2e flows run against the real shell,
and when a core lane implements a command, the next UI lane that uses it compares the fake with the
implementation. Codex lanes do not edit `apps/desktop` (roadmap §4.1): they hand differences over
in writing.

As built: `src/ipc/mock/contract.ts` derives the handler types from `commands`, so a new command
fails `tsc` until the fake answers it, and `contract.test.ts` fails whenever `bindings.ts` changes
(doc comments included) until someone compares the change with the fake and records the new
fingerprint, which the failure prints. That someone is the contract lane that regenerated the
bindings, in the same change: only contract lanes change `bindings.ts` (roadmap §4 rule 2), and
they are Claude Code lanes, so the drift never reaches `main`.

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
  `onUncaughtError` / `onCaughtError`, and the shell's log through `log_ui_error` (ipc-m1 §16.4,
  declared 2026-09-29; `chore/core-logging` implements it).
- Window-command failures (today only on the console) get an error state in `feat/ui-app-shell`
  (roadmap §3.4).

As built (`feat/ui-app-shell`): `ipc/window.ts` reports each failed window command to one handler
(`setWindowFailureHandler`), which `App` sets to `app/windowErrors.ts`: the toast of
library-actions §9.5 per command, replacing that command's earlier toast, the background one once
per session, "Copy details", and `log_ui_error` with kind `command`. The title bar starts dragging
(`start_dragging`) and double-click maximizing (`toggle_maximize`) itself instead of Tauri's
drag-region script, whose failures would only reach the console; the unused
`core:window:allow-internal-toggle-maximize` grant is gone. `app/log.ts` has `reportUiError`
(console, then `log_ui_error` with well-formed text cut to `LIMITS.logChars`) and
`reportUncaughtErrors` for the window's `error` and `unhandledrejection`; `main.tsx` passes
`onUncaughtError` and `onCaughtError` to `createRoot`, the latter with the `source` of the
`ErrorBoundary` that caught it (`view.<id>`, `dialog.<kind>`, `shell`). The boundary shows the
state block of library-actions §9.6 and "Reload this view" mounts the view afresh.

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

Installed as listed by `chore/build-deps-ui-m1` on 2026-09-29: no package had a newer patch at
least one day old (`lucide-react` 1.49.0 is a newer minor, and was hours old), and all 51 package
versions the lockfile gained were published at least one day earlier. The lane also set
`minimumReleaseAge` and `minimumReleaseAgeStrict` in `pnpm-workspace.yaml`: without strict mode,
pnpm 11 installs a younger version and adds it to `minimumReleaseAgeExclude` by itself; with it,
the install fails. One copy each of `react-aria`, `react-stately` and `highlight.js`.
`pdfjs-dist` brings its optional `@napi-rs/canvas` 1.0.9 (MIT), a native Node canvas (37 MB on
win32-x64) that only pdf.js's Node build uses; the WebView never loads it.

Considered and not added: `katex` (replaced by Temml, §10.4), `marked`, the unified / remark /
rehype family (more packages for the same result), `shiki` (heavier; lowlight's tree is enough),
`sanitize-html` (Node-oriented), `radix-ui` and `@base-ui/react` (ADR-0005 §3), `react-window`,
`react-virtuoso`, a router, `@tanstack/react-query-devtools`, `@dnd-kit/*` (no M1 design drags
inside the page), `katex` fonts and CSS.

## 17. Open items for the implementation lanes

1. pdf.js in the sandboxed frame: whether WebView2 starts a `blob:` worker there; time to first page
   on a 300-page scanned PDF; the fake-worker fallback's effect on the window (`feat/ui-preview`).
   Settled 2026-10-01: the worker starts; first page in 1.5 s; the fallback cannot block the window (§10.6).
2. Temml's output on real course notes (aligned environments, matrices, `\mathbb`) with Cambria
   Math; KaTeX with its own fonts is the fallback if it falls short (`feat/ui-preview`).
   Settled 2026-10-01: Temml is enough; no KaTeX (§10.6).
3. The filtered-tree cap of 5,000 matches (`feat/ui-library-view`, §8.2).
4. Whether Tauri exposes WebView2's browser accelerator keys setting (`feat/ui-app-shell`, §6.4).
   Checked 2026-09-30: no. wry 0.57 has `with_browser_accelerator_keys`, but tauri-runtime-wry 2.12
   does not pass it through and Tauri's config has no key for it (zoom keys are already off,
   `zoomHotkeysEnabled: false`). The shell can set `ICoreWebView2Settings3::
   SetAreBrowserAcceleratorKeysEnabled(false)` in release builds through
   `WebviewWindow::with_webview` and the controller, before the first navigation; that needs
   `webview2-com` as a direct dependency (already in the lockfile through wry). Handed to a backend
   lane (Codex): release builds only, since debug builds and e2e keep DevTools.

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
  Declared on 2026-09-29 as `log_ui_error` (ipc-m1 §16.4); `resolve_paths` likewise (§10.4).
- **Testing strategy**: add the fake shell, the `renderApp` helper and `@axe-core/playwright` to
  its layers when `feat/ui-data-layer` lands.
- **CLAUDE.md §6 directory map**: describe `apps/desktop/src` by feature folders once the app-shell
  lane has created them.
