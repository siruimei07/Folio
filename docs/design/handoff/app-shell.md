# App shell — design handoff

Build spec for the Folio window: title bar, toolbar, rail, the Library, Changes and History views,
the preview, search and the two settings dialogs. Everything the first milestones need to lay out
the app; feature behaviour stays in the brief and the specs.

- Status: ready to build. Every design decision is closed (section 1); section 12 lists the
  engineering follow-up and what is not drawn yet. Updated 2026-09-27.
- Source of truth for looks: the Cowork Design canvas "Folio 设计基础"
  (<https://claude.ai/artifact/F1eGkQ7kuFr3HYayxLtD2K>, Sirui's private artifact; boards named in
  each section) and the tokens in [`design/tokens/`](../../../design/tokens/README.md), also
  browsable with component previews in the Design System artifact "Folio Design System"
  (<https://claude.ai/artifact/QfXvWuzvoGdhUZCU4tsZyM>). Where a value has a token, the spec names
  it and gives the pixel value for orientation. Component-internal measurements without a token (for
  example the 104 px thumbnail) are given in pixels: add each one under `size.*` in
  `base.tokens.json` when the component is built, never hard-code it.
- Inputs: [brief](../../product/brief.md) §4–§6 and §9, [ADR-0001](../../adr/ADR-0001-application-stack.md)
  (frameless window, snap layouts, 500 × 320 minimum), [ADR-0002](../../adr/ADR-0002-data-storage.md)
  (course and tag metadata).
- Language: the v1 UI is English only (Sirui, 2026-09-27). All strings stay externalised; the
  strings in this spec are the English source copy. Chinese file names and content still display
  and are searchable.
- Skills: the `design:*` plugin skills are not available in Cowork. The critique and accessibility
  review in section 11 followed their checklists by hand.

## 1. Decisions

| # | Decision | Chosen |
|---|---|---|
| 1 | Style and colour | A: warm grey + teal, light and dark |
| 2 | Fonts | A: system fonts (Segoe UI Variable, Microsoft YaHei UI fallback, Cascadia Mono) |
| 3 | Icons | B: Lucide (one icon family; caption buttons keep Segoe Fluent Icons) |
| 4 | Density | B: comfortable, 14 px body, 32 px rows |
| 6 | Rail | A: outlined square buttons |
| 7 | Library layout | A: one tree (courses → folders → files) + preview |
| 8 | Tags in rows | A: coloured dots |
| 9 | Empty preview | C: "desk corner" illustration |
| 10 | History | A: GitButler's operations history layout |
| 11 | Changes | Two columns (changes list + commit lane), compressed |
| 12 | Course badge | B: tinted background, dark text |
| 13 | Tag chips | A: dot + neutral chip |
| 14 | File-type icons | B: line icons in the file type's colour |
| 15 | Search | A: centred dialog |
| 16 | Narrow window | A: the preview covers the list |
| 17 | App icon | D: stacked cards |
| 18 | Top bar | C3: title bar + toolbar, no menu bar |
| 19 | History width | C: draggable, default 440 px (360–640) |
| 20 | Change status | A: outlined square + glyph (GitButler style), no letters |
| 21 | Changes list | A: flat list with the course in the path prefix (grouping stays available as a toggle) |
| 22 | Commit message | A: summary + description |
| 23 | Badge text | A: first three letters of the course name (Cal); colour only below 20 px |
| 24 | Palette | B: Morandi |
| 25 | Settings | A: two dialogs — gear = Library settings, avatar = App settings |
| 26 | Course code in the tree | C: code first (600), then the course name in `color.text.secondary` at `font.size.label` (13 px) |
| 27 | Course label in paths | B: the course code ("MAT232/Problem sets/"); the course name only when a course has no code |

## 2. Window and layout

Board: "组合预览". Wide layout (window width ≥ `size.narrow-breakpoint`, 760 px):

```text
+--------------------------------------------------------------------------------------+
| [mark] Folio                                                         [ - ] [ □ ] [ × ] |  title bar 32
|--------------------------------------------------------------------------------------|  1 px chrome border
| (iCloud | 5 min ago) ↑2 to push ↓1 new [Sync]   [Fall 2026 v]   [Search…     Ctrl K] |  toolbar 48
+------+------------------------+---------------------------------------------------+
| rail | panel(s)               | preview                                           |
|  60  | per view, see below    | flex                                              |
+------+------------------------+---------------------------------------------------+
```

- Panels sit on `color.surface.app` with `space.panel-gap` (8 px) between them and to the right
  and bottom window edges; no gap above them (the toolbar provides it). Panels: `color.surface.panel`,
  1 px `color.border.default`, `radius.panel`.
- Panel widths: Library `size.library-panel` (340); Changes `size.changes-panel` (290) +
  `size.commit-lane` (320); History `size.history-panel` (440, draggable). The preview takes the rest.
- Window minimum stays 500 × 320 (ADR-0001).

**Narrow layout** (window width < 760 px; boards "窄窗口 · 列表 / 打开文件后盖住列表"):

- One 40 px top bar on `color.surface.chrome`: app mark, sync chip (cloud icon, ↑2 ↓1), icon-only
  Sync button, semester button (centred), icon-only search button, caption buttons. No menu button.
- Rail `size.rail-compact` (48), buttons 32 px, avatar 28 px. Course badges 20 px.
- Library: the tree takes the full width; the tag filter bar is hidden (filters stay available
  through search). Opening a file replaces the tree with the preview; the preview header starts
  with a "Back" button. Only two preview actions show: "Open with default app" and "More".
- Changes and History were not drawn for narrow windows. Default: the list takes the full width
  (Changes: the commit card and "Not synced" card stack below the list, scrolling with it); picking
  an item opens the preview over the list with "Back", like the Library.

## 3. Title bar and toolbar (18C3)

**Title bar** (existing `TitleBar` component, tokens `title-bar.*` and `caption.*`):
`color.surface.chrome`, height 32. Left: 44 px box with the 16 px app mark (the stacked-cards icon,
simplified for 16 px), then "Folio" at `title-bar.font-size` in `color.text.secondary`. The rest
of the bar is the drag region. Caption buttons 46 px each; the snap-layouts rule from ADR-0001
holds (maximize 46–92 px from the right edge, inside the top 48 px), which keeps the caption
buttons inside the shell's snap-overlay caps (button ≤ 64 px wide, within 48 px of the top and 160 px
of the right edge; coordinator notes, WP-02). A 1 px line in
`color.border.chrome` separates it from the toolbar.

**Toolbar** (height `size.toolbar`, padding 0 12 px, gap 10 px, on `color.surface.app`):

| Slot | Content |
|---|---|
| Left | Sync chip (height `size.control`, 1 px `color.border.control`, `radius.control`): cloud icon + "iCloud", divider, refresh icon + "5 min ago" in `color.text.primary` |
| Left | Counts in `color.text.secondary`, 12 px, tabular figures: up-arrow icon + "2 to push", down-arrow icon + "1 new". Each count hides at zero |
| Left | "Sync" button: `color.button.primary` background, `color.text.on-primary`, refresh icon, 600 weight |
| Centre (absolutely centred) | Semester button: calendar icon + "Fall 2026" (600) + chevron; opens the semester menu (new semester, archived semesters) |
| Right | Search button, 250 px: search icon, "Search files, courses, tags" in `color.text.tertiary`, key cap "Ctrl K"; opens search (section 8) |

Sync states (not drawn; copy for `design:ux-copy` review):

| State | Chip | Counts | Sync button |
|---|---|---|---|
| Up to date | "iCloud \| 5 min ago" | hidden; "Up to date" with a check icon instead | enabled |
| Changes waiting | as drawn | "2 to push", "1 new" | enabled |
| Syncing | "iCloud \| Syncing…" | unchanged | disabled, spinning icon (static under reduced motion) |
| Offline or iCloud unavailable | cloud-off icon + "Offline" | unchanged | disabled, tooltip explains |
| Failed | warning icon + "Sync failed" | unchanged | "Retry" |

Announce sync results in a polite live region ("Synced 2 commits to iCloud", "Sync failed: …").

**No menu bar (18C3).** Where the usual menu commands live: Add files — "+" in the Library
header (`Ctrl+O`); new course, tags, file types, ignore rules — Library settings; semesters — the
semester menu; settings — gear (`Ctrl+,`) and avatar; user guide — settings footer; check for
updates — App settings → About; quit — close button or `Alt+F4`. Context menus on rows carry the
file commands (open, show in File Explorer, rename, move, tags, history, delete).

## 4. Rail (6A)

Width `size.rail` (60), buttons `size.rail-button` (38) square, `radius.rail-button`, 10 px apart,
top aligned with the panels.

- Idle: transparent, 1 px `color.border.control`, icon `color.text.secondary`, 18 px.
- Hover: `color.surface.panel` background.
- Active: `color.surface.panel`, border `color.border.strong`, icon `color.accent.default`, and a
  3 × 20 px `color.selection.indicator` bar on the window's left edge.
- Items: Library (`Ctrl+1`), Changes (`Ctrl+2`; count badge 18 px, `color.text.primary` fill with
  2 px `color.surface.app` ring, top-right, hidden at zero), History (`Ctrl+3`). Tooltips carry the
  shortcut.
- Bottom: gear button (same style; opens Library settings, `Ctrl+,`) and the avatar: 32 px
  circle, `color.avatar.background`, the device name's first letter in `color.avatar.text` (700).
  While its dialog is open the gear shows the active style and the avatar a 2 px
  `color.accent.fill` ring.
- `aria-current="page"` on the active view; gear and avatar have `aria-haspopup="dialog"` and
  `aria-expanded`.

## 5. Library view (7A)

Boards: "组合预览", "深色", "选中课程 → 文件网格", "没选文件时".

**Panel header** (`size.panel-header`): "Library" (15 px, 600) + count pill (total files;
`color.text.primary` fill, `color.surface.panel` text, 11 px, 18 px tall); right: List / Tree
segmented toggle (Tree pressed), "+" Add files.

**Tag filter bar (13A)**: chips (`size.chip`, `radius.chip`, 12 px): "All" then the tags in their
order. Idle chip: `color.surface.panel`, 1 px `color.border.control`, `color.text.secondary`, tag
dot 7 px in `palette.<color>.dot`. Selected: `color.text.primary` fill and border,
`color.surface.panel` text, 600. Several tags can be selected; "All" clears them. Wraps to a
second row when needed. With a filter on, the tree shows only matching files, with every course
and folder that contains one expanded.

**Tree** (padding 6 px; rows `size.row`, `radius.row`, indent 16 px per level, 1 px
`color.border.guide` indent guides):

| Row | Content |
|---|---|
| Quick views | "Recently added", "Untagged" with icons and counts, then a separator |
| Course | chevron, course badge (section 10), course code (600, tabular figures), course name (`font.size.label`, 400, `color.text.secondary`), file count (11 px, `color.text.tertiary`). A course without a code shows its name at 600 in `color.text.primary` |
| Folder | chevron, folder / folder-open icon in `color.text.secondary`, name |
| File | type icon 16 px in `palette.<color>.solid`, name, up to three tag dots (7 px, 3 px apart) |

- Hover: `color.surface.hover`. Selected: `color.surface.selected` plus the 3 px
  `color.selection.indicator` bar at the row's left edge (rows only have a background otherwise).
- Clicking a course or folder toggles it and selects it (the preview shows its grid). Clicking a
  file selects it and shows it in the preview.
- Keyboard: WAI-ARIA tree pattern (`role="tree"`, `treeitem`, `aria-level`, `aria-expanded`,
  `aria-selected`, roving tab index): Up/Down move, Right expands or enters, Left collapses or goes
  to the parent, Home/End, Enter opens the preview, type-ahead by name. The canvas uses buttons
  only to keep the prototype simple.
- Truncated names show the full name in a tooltip and keep it in the accessible name. A course
  row reads "MAT232 Calculus of Several Variables, 10 files". Tag dots get
  `aria-label="Tags: Notes, Exams"` and the same tooltip.

**Preview** (flex; boards as above):

- Empty: `color.surface.app` with a 14 px dot grid (`color.pattern.dots`, 1 px dots), the desk
  illustration (240 × 170, `color.illustration.*`), "Select a file to preview" (14 px,
  `color.text.secondary`) and "Or drop files here to add them to the current course" (12 px,
  `color.text.tertiary`). In Changes: "Select a change to see what's different"; in History:
  "Select a file to see this version and what changed".
- File header (`size.panel-header`): type icon, path (`color.text.tertiary`) + name (600), then
  icon buttons "Open with default app", "Show in File Explorer", "View history of this file",
  "More" (28–30 px, tooltips).
- Tag row: tag chips with a remove button ("Remove tag Notes"), a dashed "+ Tag" chip, and on the
  right "12 KB · Modified today at 5:18 PM" (11 px, `color.text.tertiary`).
- Body by type: Markdown rendered on the panel (max width 620, padding 28/40; H1 22 px, H2 16 px,
  list line height 1.65, formulas in `font.family.math`); PDF and Word as a page on
  `color.surface.sunken` with a "1 / 4 · 100%" pill; slides as a 16:9 page with a pager pill;
  images centred on a dark backdrop; code with line numbers in `font.family.mono` 13 px and
  `color.syntax.*`; other types show a 44 px icon, the name, a note and "Open with default app".
  Document pages stay light in dark mode (`color.surface.page`).
- Course or folder selected: header with folder icon, then the course code (600) and course name
  (`color.text.secondary`) for a course, or path + name for a folder, then "· 10 files",
  "Date modified" sort button and List / Grid toggle; grid of tiles (min 150 px, gap 12, padding
  14): 104 px thumbnail area on `color.surface.sunken`, then icon + name + tag dots.
- Drop target (not drawn): while files are dragged over the window, the preview shows a 2 px dashed
  `color.accent.default` outline and "Drop to add to MAT232" (the course code, or the name of a
  course without one).

## 6. Changes view (11, 21A, 22A)

Board: "工作区 · 平铺列表 + 标题和说明".

**Changes list** (`size.changes-panel`):

- Header: select-all checkbox (indeterminate when mixed), "Changes" + count pill, and a List /
  Tree toggle: flat (default, 21A) or grouped by course.
- Rows (`size.row`, 1 px `color.border.guide` separators): checkbox ("Include <name> in the
  commit"; 24 × 24 hit area), type icon, path prefix in `color.text.tertiary`, file name (600),
  status icon (section 10) at the right. Deleted files are struck through. The prefix starts with
  the course label (27B: the code, "MAT232/") and truncates before the file name: the code stays
  whole and the folders in between shrink first (a course name, used only when there is no code,
  shrinks with them). Selected row: `color.surface.selected` + indicator bar.
- Grouped mode: a `color.surface.sunken` header per course (badge, code in 600, name, count); rows then
  show only the folders below the course.

**Commit lane** (`size.commit-lane`, `color.surface.app` with the dot grid, padding 12, gap 10):

- Composer card (panel card, padding 12): one bordered field group (input border tokens, bottom
  edge `color.input.border-bottom`) with "Summary (optional)" (36 px, 600) and "Description
  (optional). Leave both empty and DeepSeek writes them." (3 rows), and a 38 px footer holding the
  split button "Generate" (sparkles icon) + options chevron. Below it the full-width commit button
  (34 px, `color.button.accent`, `color.text.on-button-accent`, 600): "Commit 4 changes" + "Ctrl+Enter"
  at 80 % opacity. With nothing checked it is disabled and reads "Nothing selected".
- "Not synced" card (GitButler's branch card): push icon in a 24 px sunken tile, "Not synced" +
  count pill, "Only on this computer so far. Sync to push them to iCloud." Then a lane: the first
  node is the "Your commit goes here" pill (`color.button.accent`), then each unsynced commit
  (message, "b7c1e20 · 5:05 PM"). Hovering a commit shows "Edit message" and "Undo commit" icon
  buttons (brief §5.4). Footer: outline button "Sync now".

**Right side**: text and Word changes show a diff: header with type icon, path + name, status
icon, segmented "Changes | This version"; a sunken line "Compared with the last commit (today at
5:05 PM) · 5 added, 2 removed"; lines in `font.family.mono` 12.5 px with old and new line numbers,
a sign column and `color.diff.*` backgrounds. Other types show the preview with a banner (status
icon + text), for example "Renamed from Exercise 14.3.jpg." or "Deleted: committing removes it from
the library. The file is in the Recycle Bin."

## 7. History view (10A, 19C, 20A)

Board: "历史 · 宽度可拖动".

- Width `size.history-panel` (440), draggable between `size.history-panel-min` and
  `size.history-panel-max` with an 8 px handle centred in the gap to the preview (grip 4 × 36 px
  `color.border.strong`, hover `color.overlay.rail-hover`, `cursor: col-resize`). The handle is a
  focusable `role="separator"` with `aria-valuenow/min/max`; Left/Right change the width by 16 px,
  double-click resets it to 440. The width is remembered on this computer.
- Header: "History" and an outline "All types" filter button.
- Day headers: 32 px, `color.surface.sunken`, 12 px `color.text.secondary`, text aligned with
  the icon column: "Today, Sep 27", "Yesterday, Sep 26", then "Sep 25".
- Entry grid: time column `size.history-time-column` (64, right-aligned, 11 px, 12-hour
  "5:05 PM"), 20 px icon column with 1 px `color.border.default` lines joining the entries, content.
- Content: title (wraps, never truncated), then inline "• b7c1e20" (12 px tertiary), the source
  (laptop icon + device name "G16", or cloud icon + "iCloud" for changes made on another device;
  brief §5.6), and a "Not synced" pill (`color.accent.soft` / `color.accent.default`, 11 px, 600)
  for commits not pushed yet.
- Operation icons (Lucide, 16 px, `color.text.primary`): commit `circle-check`, push
  `cloud-upload`, pull `cloud-download`, edit message `pencil`, undo commit `undo-2`, restore
  `rotate-ccw`, resolve conflict `git-merge`.
- File card: bordered (`radius.control`), rows 32 px as in the changes list but without checkbox;
  more than four files collapse behind "Show all 6 files". Selecting a row fills the preview: a
  diff with a "Restore" button for text and Word, the file with a banner otherwise ("This version
  added the file. Folio records changes to this type but keeps only the latest copy.").

## 8. Search (15A)

Board: "搜索 · 居中浮层".

- `Ctrl+K` or the toolbar field opens a 640 px dialog, 84 px from the top, over
  `color.overlay.scrim` (the scrim starts below the title bar). Radius 12, `shadow.overlay`.
- Input row 52 px: search icon, input at 16 px, "Esc" key cap.
- Results grouped "File names" and "Contents". Row: type icon, name with matched characters on
  `color.search.highlight` (600), a snippet for content matches (12 px, `color.text.secondary`),
  and the location on the right ("MAT232 / Problem sets", course label as in paths). The
  active row has the selected background and indicator bar.
- Footer (sunken): "↑ ↓ Select", "Enter Preview", "Esc Close", result count.
- Enter or click: closes the dialog, switches to Library, expands the file's course and folders,
  selects it and shows it in the preview. Esc or clicking the scrim closes it; focus returns to
  where it was.

## 9. Settings dialogs (25A)

Boards: "齿轮 → Library settings", "头像 → App settings" (every page is clickable on "组合预览").

**Frame**: `size.settings-dialog-width` × `size.settings-dialog-height` (820 × 640), centred,
`color.surface.modal`, 1 px border, `radius.dialog`, `shadow.overlay`, padding 8, gap 8. Scrim
`color.overlay.modal-scrim`, starting below the title bar so the caption buttons stay usable.

**Nav card** (`size.settings-nav`, panel card, padding 12/10/10): title ("Library settings" or
"App settings", 16 px, 600) with a close button (×, 26 px); items 36 px (16 px icon, 14 px text,
`color.text.secondary`); the active item has `color.surface.sunken`, `color.text.primary`, 600 and
a 3 px indicator bar at the card's inner left edge; footer link "User guide ↗".

**Content**: cards (panel, 1 px border, `radius.panel`, padding 16/18, gap 14 between cards):

- Card title `font.size.heading` (15 px) 600, description `font.size.label` (13 px) in
  `color.text.secondary`; a switch or button on the right.
- Fields: label `font.size.label` (13 px); input `size.dialog-control` (34 px) with `color.input.*`,
  read-only fields on `color.input.background-readonly`; optional trailing outline button; help text
  `font.size.small` (12 px) in `color.text.tertiary`.
- Split cards: rows with label (600) + description on the left and a select (32 px, min 200),
  switch, key caps or segmented control on the right, separated by 1 px lines.
- Switch: 36 × 20, off = transparent with `color.toggle.off` border and knob; on =
  `color.toggle.on` fill with `color.text.on-button-accent` knob. Switches apply immediately;
  fields with a Save button save on click.

| Dialog | Page | Content |
|---|---|---|
| Library settings | Library | Library folder (read-only, "Change…"), Semester (select, "New semester…"); Open files with; Deleted files; Rebuild search index |
| | Cloud sync | Cloud remote (read-only path, "Change…", note "2 commits on this computer haven't been synced yet."); Sync automatically; Sync when Folio closes; Free up space |
| | Courses | "Courses in Fall 2026": rows with grip, badge, code (600, 60 px column), name, file count, more menu; "New course"; Past semesters |
| | Tags | Tag rows with grip, dot, name, count, more menu; "New tag"; Untagged filter switch |
| | File types | "Full versions" and "Latest copy only" extension chips; note about text files over 10 MB |
| | Ignore rules | Patterns text area (mono), Save |
| App settings | General | Device name (avatar tile, input, "Shown in History next to changes made on this computer.", Save); Open Folio when Windows starts; Check for updates automatically; Privacy text |
| | Appearance | Theme (Light / Dark / System); Reduce motion (Use Windows setting / On / Off); course and tag colours |
| | AI | Write commit messages with AI; Service (DeepSeek or OpenAI-compatible); Send changed text; API key ("Stored in Windows Credential Manager, never in your library folder.") |
| | Keyboard | Search Ctrl K, Commit Ctrl Enter, Sync Ctrl Shift S, Library Ctrl 1, Changes Ctrl 2, History Ctrl 3, Settings Ctrl , |
| | About | Version and "Check for updates"; open-source licences |

Behaviour: modal (`aria-modal`, focus trapped), initial focus on the active nav item, Esc / ×
/ scrim click close it, focus returns to the gear or avatar.

## 10. Shared components

| Component | Spec |
|---|---|
| Course badge (12B, 23A) | `size.badge` square, `radius.badge`, 1.5 px border and fill `palette.<color>.tint`, text `palette.<color>.text`, three letters (`font.size.badge`, 700, letter spacing −0.1 px). Default text: the first three letters of the course name, first letter upper case ("Cal" for Calculus of Several Variables, "Sof" for Software Design); editable per course, for names where the first three letters say little ("The" for Theory of Computation). Below 20 px: a 58 % square in `palette.<color>.dot`, no text |
| Course label (26C, 27B) | In the tree, grouped change headers, course grid headers and Settings → Courses: the code (600, tabular figures) first, then the name (`color.text.secondary` in the tree and headers). In paths, search locations and commit titles: the code ("MAT232/", "MAT232: …"). A course without a code uses its name everywhere |
| Tag dot | 7 px circle, `palette.<color>.dot` |
| Tag chip | see section 5; in the preview header with a remove button |
| File-type icon (14B) | Lucide line icon 16 px in `palette.<color>.solid`; mapping in the tokens README |
| Change status icon (20A) | 16 px outlined square + glyph in `color.status.*`; `role="img"` with "Added", "Modified", "Deleted", "Renamed" and the same tooltip |
| Selection indicator | 3 px `color.selection.indicator` bar, 7 px inset top and bottom, on selected rows, the active rail item and the active settings nav item |
| Buttons | primary (Sync), accent (Commit, Save), outline (`color.border.control`, panel fill), icon (28 px, hover `color.surface.hover`), segmented (sunken track, pressed item on panel with a 1 px border) |
| Count pill | 18 px, `color.text.primary` fill, `color.surface.panel` text, 11 px 600 |
| Focus | `focus-ring.width` outline in `color.focus.ring`, offset 2 px (inset −2 px on rows and list items) |

Motion: hover and press changes use `motion.duration.fast`; dialogs, search and the narrow preview
fade in and rise 4 px over `motion.duration.base` with `motion.easing.standard`, and leave with
`motion.easing.exit`. Reduced motion sets all durations to 0.

## 11. Review notes

Critique and accessibility pass on the canvas, by hand (see "Skills" above).

Fixed on the canvas and in the tokens:

- `color.text.tertiary` was 4.4:1 on selected rows in both modes; darkened (light) and lightened
  (dark) to reach 4.75 and 4.83.
- The diff "+" colour was 4.49:1 on added lines; darkened to 4.85.
- A selected row was marked only by a 1.1:1 background tint. Selected rows, the active rail item
  and the active settings nav item now share a 3 px indicator bar (≥ 4.6:1 on the selected
  background, WCAG 1.4.11).
- Indicators use `color.accent.default`: `color.accent.fill` is only 2.7:1 on selected rows.
- History entries show their source again (device name or iCloud), which brief §5.6 requires.
- The AI page now has the service choice and the "Send changed text" switch from brief §5.7.

Known limitations, accepted:

- Tag dots in rows are colour only (8A). They carry a tooltip and an accessible label, the tag
  names show in the preview header and the filter chips, and the palette keeps neighbouring colours
  at ΔE2000 ≥ 10.4.
- With English labels the tag filter bar wraps to two rows at 340 px.
- Long course names can still truncate in the tree at 340 px; the code before them always shows,
  and the tooltip carries the full name.
- At 440 px the "Not synced" pill wraps under long commit titles.

Build requirements from the review:

- Everything is reachable by keyboard (tree pattern, rail, dialogs, the resize handle, search).
- Controls are at least 24 × 24 px; checkboxes get a 24 × 24 hit area around the 15 px box.
- Truncated text exposes the full text through a tooltip and the accessible name.
- Dialogs trap focus and return it; sync results go to a polite live region.
- Verify contrast again on the built screens (`design:accessibility-review` in Claude Code).

## 12. Open items

1. **Data model (engineering)**: courses need an optional `code` (for example "CSC207"). ADR-0002
   and [library-core](../../specs/library-core.md) currently store `course: {abbr, archived, color, order}`; adding
   `code` needs an ADR-0002 amendment and a catalog column. Suggested default: fill it from a
   course folder name that starts with a code (`^[A-Z]{3}\d{3}`), editable in Settings → Courses.
   The badge abbreviation (`abbr`) defaults to the first three letters of the course name.
2. **Not drawn yet**: Changes and History in the narrow window (default in section 2), the toolbar
   sync states (section 3), the drop target (section 5), context menus, an error state for failed
   window commands (today they only reach the console; coordinator notes, WP-02), first-run and
   join-remote flows (brief §7), conflict resolution. These get their own handoff specs.
