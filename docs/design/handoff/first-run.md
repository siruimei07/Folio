# First run — design handoff

Build spec for what Folio shows before a library is open: the welcome screen, the two ways to
start (a new library, or a folder the user already has), the first semester and courses, and the
full-window states when the configured library cannot be opened at start-up or stops being
available while Folio runs. The optional cloud remote and AI steps of brief §7 item 1 belong to M3
and M2 and are not part of this spec.

- Status: ready to build. Decisions 28 and 29 are Sirui's (2026-09-28); the others in section 1
  are design defaults. Updated 2026-09-28 (lane `design/design-m1-flows`); section 7's
  `unfinishedMove` row and its discard dialog 2026-10-03 (lane `feat/ui-discard-move-action`).
- Source of truth for looks: the Cowork Design canvas "Folio 设计基础"
  (<https://claude.ai/artifact/F1eGkQ7kuFr3HYayxLtD2K>), row 3 "M1 流程 · 首次使用和启动", boards
  named in each section, and the tokens in [`design/tokens/`](../../../design/tokens/README.md)
  (round 4 added the feedback, progress and first-run tokens this spec names), also browsable in the
  Design System artifact "Folio Design System" (<https://claude.ai/artifact/QfXvWuzvoGdhUZCU4tsZyM>).
  The boards share one window component, "M1 窗口组件" (`M1Shell`); it is not a screen of its own.
- Inputs: [brief](../../product/brief.md) §4, §5.1, §7 item 1, §9, §13;
  [IPC contract](../../specs/ipc-m1.md) §4.2, §6, §7, §13, §15, §16;
  [ADR-0002](../../adr/ADR-0002-data-storage.md) §3 and §6 (library location guard);
  [library core](../../specs/library-core.md) §3 (name rules); [app shell](app-shell.md) (window,
  shared components); [UI architecture](../../specs/ui-architecture.md) §6, §7.1, §12, §13 and
  [library state](../../specs/library-state.md) (settings, choices, start-up), both written while
  this lane ran. Library actions, feedback patterns and the activity button are in
  [library-actions.md](library-actions.md).
- Language: English source copy. Strings go in the `first-run` namespace of the locale files (lane
  `feat/ui-i18n-english`); where a message repeats the generic one for an error code, reuse `errors`.
  Apostrophes are straight ('), as in `errors.json`; a name quoted inside a string uses “ ”. The
  boards may still show ’.
- Skills: this time the `design:*` skills were available in Cowork. `design:design-critique`,
  `design:accessibility-review` and `design:ux-copy` were applied by hand to the canvas boards
  (section 11), and this spec follows `design:design-handoff`.

## 1. Decisions

| # | Decision | Chosen |
|---|---|---|
| 28 | Welcome layout | B: split. Title and the two choices on the left, the desk illustration on a dot grid on the right, like GitButler's welcome. Below `size.narrow-breakpoint` (760 px) it becomes one centred column |
| — | Ways to start | Two equal choice cards, "Start a new library" and "Use a folder you already have", and a link "Open your library…". All three open the same folder dialog; what follows depends on the folder's content (section 4), not on which one was clicked |
| — | Steps | Two: 1. the folder and the library name, which creates the library; 2. the semester and courses. Step 2 has no Back: the library exists once step 1 is done |
| — | Library name | Asked in step 1, default the folder's name. M1 has no command to rename a library later |
| — | Semester name default | From today's date, University of Toronto terms: "Fall YYYY" (September–December), "Winter YYYY" (January–April), "Summer YYYY" (May–August). Editable |
| — | Course codes when taking over | Empty fields; never filled from folder names (IPC product decision 4) |
| — | Course colours | Each new course, and each course step 2 lists without a colour, gets the first palette colour (order red, orange, amber, green, teal, blue, indigo, violet, pink, stone) not yet used in its semester; after ten, the order starts again. Folio writes the colour it shows |
| — | Default colour of a course with `color: null` | The palette colour at FNV-1a 32-bit of the course folder name's UTF-8 bytes, mod 10, in the order above. Deterministic on every device; the tree, settings and badges all use this rule |

## 2. Flow

```text
start ──► library_status ──┬─ open ────────────────────────────────────────────────► Library view
                           ├─ none ──► Welcome ──► folder dialog ──► Step 1 ──┬─ create_library ──► Step 2 ──► Library view
                           │                                                  └─ open_library ─────────────► Library view
                           └─ unavailable ──► Full-window state (section 7)
```

- The shell opens the configured library before `library_status` answers, so the window shows only
  the title bar on `color.surface.app` until then. After 400 ms without an answer, a centred spinner
  and "Opening your library…" appear (`font.size.label`, `color.text.secondary`).
- `LibraryStateChanged` can arrive at any time; `open` leaves the first run for the Library view,
  `unavailable` shows section 7.

## 3. Welcome (28B)

Board: "首次使用 · 欢迎（28B 左右分栏）".

The title bar as in app-shell §3; no toolbar and no rail, since there is no library yet.

| Part | Spec |
|---|---|
| Body | `color.surface.app`, padding 40 px top and bottom, 96 px left, 48 px right; two columns 64 px apart |
| Left column | 500 px wide, content centred vertically, groups `space.32` apart |
| App icon | The stacked-cards app icon (17D) at 48 px, full colour |
| Title | "Welcome to Folio", `font.size.display` (24 px), 600, `font.line-height.heading` |
| Intro | `font.size.body`, `color.text.secondary`: "Your course files in one library: semesters and courses, tags, quick search and a preview for every file. It stays an ordinary folder on this computer." |
| Choice cards | `space.12` apart. Each is one button: `color.surface.panel`, 1 px `color.border.default`, `radius.panel`, padding 16, gap 14; tile `size.state-tile` (44) with `color.accent.soft` fill, 1 px `color.accent.soft` border, 10 px radius, and a `size.icon-large` (22) icon in `color.accent.default`; title `font.size.heading` (15) 600; description `font.size.label` (13) `color.text.secondary`; a 16 px chevron-right in `color.text.tertiary` |
| Card 1 | Icon `folder-plus`. "Start a new library" / "Choose an empty folder. Folio adds a folder for each semester and course as you create them." |
| Card 2 | Icon `folder-input`. "Use a folder you already have" / "Choose the folder that holds your semester folders. Nothing is moved or renamed." |
| Open link | `font.size.label`, `color.text.secondary`: "Used Folio on this computer before?" then a link button "Open your library…" (600, `color.accent.default`, 28 px tall, padding 0 6, hover `color.surface.hover`) |
| Footer line | `font.size.small`, `color.text.tertiary`: "Folio works offline. It doesn't collect usage data." |
| Right panel | Fills the rest: `color.surface.app` with the 14 px dot grid (`color.pattern.dots`), 1 px `color.border.default`, `radius.panel`; the desk illustration (9C) at 360 × 255, centred, `aria-hidden` |

States: card hover turns the border `color.border.strong`; pressed fills `color.surface.hover`;
focus shows the focus ring (2 px `color.focus.ring`, offset 2 px).

Narrow window (below 760 px, down to 500 × 320): the right panel is hidden; the left column is
centred, `min(560 px, window width − 32 px)` wide; the body scrolls vertically when it is taller than
the window, under a fixed title bar.

Behaviour:

- The cards and the link call `pick_library_folder` (the Windows folder dialog). `null` (cancelled)
  keeps the welcome screen and returns focus to the button that opened the dialog.
- The `FolderChoice` decides the next screen (section 4). When it does not match the card the user
  chose, one line above the folder card says so: after "Start a new library" with a folder that has
  content, "This folder isn't empty, so Folio can use it as it is."; after "Use a folder you already
  have" with an empty folder, "This folder is empty, so Folio starts a new library in it."
- "Open your library…" goes straight to `open_library` when the folder holds a library (no step 1
  page); any other folder shows state 6 of section 4.4.

## 4. Step 1: the folder

Boards: "第 1 步 · 新建资料库（空文件夹）", "第 1 步 · 接管已有文件夹", "第 1 步 · 选择文件夹后的各种情况".

### 4.1 Step layout (steps 1 and 2)

- A centred column, `size.first-run-content` (560) wide, 64 px below the title bar (40 px on the
  taller pages: take-over and step 2), sections `space.24` apart. Narrow windows: the column is
  `window width − 32 px` and the page scrolls.
- Header: "Step 1 of 2" (`font.size.small`, 600, `color.text.tertiary`), the title
  (`font.size.display`, 600), one line of intro (`font.size.body`, `color.text.secondary`).
- Footer row: the secondary button on the left, the primary on the right, both
  `size.dialog-control` (34) tall; the primary is `color.button.accent` (Commit and Save style).
- Folder card: panel card, padding 12 12 12 14, gap 12; tile 36 px (`color.surface.sunken`, 1 px
  `color.border.default`, 10 px radius, 18 px `folder` icon in `color.text.secondary`); the path
  (600, one line, truncated in the middle, full path in the tooltip and the accessible name); a
  meta line (`font.size.label`, `color.text.secondary`); "Change…" (outline button, 30 px) reopens
  the folder dialog.
- Field: label (`font.size.label`), input (`size.dialog-control`, `color.input.*`, bottom edge
  `color.input.border-bottom`), help (`font.size.small`, `color.text.tertiary`), as in app-shell §9.
- Note: `color.surface.sunken`, `radius.control`, padding 10 12, a 16 px `info` icon in
  `color.text.tertiary`, `font.size.label` `color.text.secondary`.

### 4.2 What each folder shows

| `FolderChoice.content` | Title | Meta line | Content | Footer | Command |
|---|---|---|---|---|---|
| `empty` | "Start a new library" | "Empty folder" | Library name; note "Folio adds a hidden .folio folder here for your tags and course settings. Everything else stays ordinary files that open without Folio." | Back · "Create library" | `create_library` |
| `folders` | "Use this folder as your library" | "4 folders and 2 files at the top level" (counts from `folders`, `files`; "1 folder", "no files" as needed) | "How Folio reads your folders · example" map; the top-level files line; library name; note "Folio adds a hidden .folio folder here for your tags and course settings. Nothing is moved or renamed." | Back · "Use this folder" | `create_library` |
| `library` | "Open your library" | "Folio library “University of Toronto”" (`name`) | Info banner "This folder is already a Folio library" / "Open it to pick up where you left off. Its tags, courses and settings are inside it." | "Choose another folder…" · "Open library" | `open_library` |
| `insideLibrary` | "Choose another folder" | "Inside a Folio library" | Danger banner "This folder is inside another library" / "E:\University of Toronto is a Folio library, and a library can't hold another one. Choose that folder to open it, or a folder outside it." (`root`) | Back · "Choose another folder…" | — |
| `incomplete` (added 2026-09-29, ipc-m1 §6) | "Finish setting up this library" | "Setup didn't finish · 4 folders and 2 files at the top level" (counts as for `folders`; "Setup didn't finish" alone when both are 0) | Information banner "Folio started a library here but didn't finish" / "Its hidden .folio folder has no library file, maybe because the disk was full or Folio closed. Folio can finish now and keep what's already there, like your tags."; then, when `folders` or `files` is not 0, the map and the top-level files line as for `folders`; the library name | Back · "Finish setup" | `create_library` |

The intro line under the titles: new library "Folio keeps your library in this folder. Semester and
course folders go inside it."; take-over "Folio works with the folders you already have."; the
other two have none.

The map (take-over only) is a panel card, padding 8 14, four 30 px rows indented 18 px per level,
each a 16 px folder icon, a name and, in a 250 px column, the role in `font.size.small`
`color.text.tertiary` with the role word in 600 `color.text.secondary`: the chosen folder's real
name "Library · the folder you chose"; then fixed examples "Fall 2026 — Semester · each folder at
the top", "Calculus of Several Variables — Course · each folder in a semester", "Problem sets —
Folder · anything deeper". The line below it appears only when `files > 0`: "The 2 files at the top
level stay where they are. Search finds them." ("The file at the top level stays where it is.
Search finds it.")

`syncRoot` is not null: a warning banner goes under the folder card, whatever the content:
"This folder is in iCloud Drive" (or OneDrive, Dropbox; "a cloud folder" for `other`) / "iCloud can
change or re-download files while Folio uses them, which leaves conflict copies. Keep your library
outside iCloud, OneDrive and Dropbox. A later version of Folio backs it up to iCloud for you."
The footer then reads Back · "Use it anyway" (outline) · "Choose another folder…" (accent), and
"Use it anyway" runs the step's command (ADR-0002 §6: warn, never refuse).

### 4.3 Library name

- Label "Library name", default the last name of `FolderChoice.path`, trimmed; help "Shown in
  Library settings. It doesn't change the folder's name."
- Checked as the user types for control characters, and on submit by the shell (IPC §16.3).
  Messages in section 8.

### 4.4 Commands and errors

- `create_library { folder, name, presetTags }` with the preset names "Notes", "Slides",
  "Homework", "Exams", "Reference". While it runs, the primary shows a 14 px spinner and
  "Creating…" and the page ignores input. The result `LibraryOpened { library, scan }` leads to
  step 2 and keeps the scan's job id for the progress strip.
- `open_library { folder }` leads straight to the Library view.
- Errors appear as a banner above the footer (board "第 1 步 · 选择文件夹后的各种情况"); the fields keep their
  values; focus moves to the banner's primary button:

| # | Error | Banner | Footer |
|---|---|---|---|
| 1 | `syncRoot` (warning, not an error) | See 4.2 | Back · "Use it anyway" · "Choose another folder…" |
| 2 | Content `library` (information) | See 4.2 | "Choose another folder…" · "Open library" |
| 3 | Content `insideLibrary`, or `AlreadyALibrary` from `create_library` | Danger, see 4.2 | "Choose another folder…" |
| 4 | `AccessDenied` | Danger: "Folio can't write to this folder" / "Windows didn't allow it. Choose a folder in your user folder, such as Documents, or on another drive." | "Try again" · "Choose another folder…" |
| 5 | `ChoiceExpired` | Warning: "Choose the folder again" / "A folder choice lasts 10 minutes, and this one ran out. Nothing was created." | "Choose folder…" |
| 6 | Content not `library` after "Open your library…", or `NotALibrary` | Danger: "This folder isn't a Folio library" / "It has no .folio folder. Choose the folder that has one, or go back and start a new library." | Back · "Choose another folder…" |
| 7 | `NewerFormat` | Danger: "This library needs a newer Folio" / "A newer version of Folio saved it. Update Folio, then open it again. Your files are fine." | "Choose another folder…" |
| 8 | `DiskFull` | Danger: "The disk is full" / "Free up some space on E:, then try again." | "Try again" |
| 9 | `FileSystem`, `Internal` | Danger: "Folio couldn't set up the library here" / "Something went wrong while writing to the folder. Try again, or choose another folder." | "Copy details" · "Try again" |

"Copy details" copies the error code and `detail` to the clipboard (they are also in the log).
"Try again" repeats the command with a new folder choice only when the token expired; otherwise with
the same token.

## 5. Step 2: semester and courses

### 5.1 New library

Board: "第 2 步 · 建学期和课程（新资料库）".

- Header: "Step 2 of 2", "Add your semester and courses", intro "Folio makes a folder for the
  semester and one inside it for each course."
- Semester field: label "Semester", input 240 px, default from section 1, help "For example Fall 2026
  or Winter 2027."
- Courses: label "Courses"; column headings "Code (optional)" and "Course name"
  (`font.size.caption`, 600, `color.text.tertiary`), aligned with the inputs (30 px indent for the
  badge column).
- Course rows (component **CourseRowsEditor**, reused by "New semester…" in the semester menu and by
  "Add courses" in library-actions.md §8), rows `space.8` apart, each `space.8` gap:

| Part | Spec |
|---|---|
| Badge preview | The course badge (app-shell §10) at 22 px from the name and colour; while the name is empty, a 22 px square with a 1.5 px dashed `color.border.strong` border. `aria-hidden` |
| Code | Input 104 px, placeholder "Code", `aria-label` "Course 3 code" |
| Name | Input filling the row, placeholder "Course name", `aria-label` "Course 3 name" |
| Colour | Button 46 × 34: a 12 px dot in `palette.<color>.dot` and a 12 px chevron; `aria-label` "Course 3 colour: orange"; opens the colour popover |
| Remove | 28 px icon button (`x`, 14 px), `aria-label` "Remove course 3" |

- Colour popover: `color.surface.panel`, 1 px `color.border.default`, `radius.panel`,
  `shadow.menu`, padding 10, `z-index.menu`; caption "Colour" (`font.size.caption`, 600,
  `color.text.tertiary`); a radio group of the ten palette colours, 5 × 2, 28 px buttons with 18 px
  dots in `palette.<name>.dot`, the selected one ringed (2 px `color.surface.panel` gap, then 2 px
  `color.text.primary`); a footer line "Orange · badge “Cal”" (`font.size.small`,
  `color.text.secondary`). Each swatch is named ("Orange") in its label and tooltip.
- "Add course" (outline, 30 px, `plus` icon) and help "Press Enter in a name to add another row. You
  can change colours and badge letters later in Library settings."
- The page starts with one empty row. Enter in a name that has text adds a row below and focuses its
  code; an empty last row is ignored.
- Footer: "Skip for now" (ghost button: transparent, `color.text.secondary`, hover
  `color.surface.hover`) on the left; the primary "Create 5 courses" (N = rows with a name;
  "Create 1 course"; "Create semester" with no courses) on the right.

Submitting:

1. Checks run first; if anything is invalid, focus moves to the first invalid field and nothing is
   sent. The primary is never disabled.
2. `create_semester { name }`, then `create_course { semester, name, abbr: null, code, color }` for
   each row in order (`code: null` when empty, `color` the key shown). The primary shows a spinner and
   "Creating 5 courses…".
3. A row that fails keeps its fields and shows its error under it; rows that were created turn
   read-only with a check in place of the remove button, and the primary becomes "Create 2 more
   courses". If `create_semester` fails, its error shows under the semester field and no course is
   sent.
4. When everything is created: the Library view, with the new semester current and the first course
   selected and expanded (library-actions.md §8, empty course).

"Skip for now" opens the Library view with no semester (library-actions.md §8, no semesters).

### 5.2 Taking over a folder

Board: "第 2 步 · 核对学期和课程（接管）".

- Header: "Step 2 of 2", "Check your semesters and courses", intro "Add course codes if you like:
  they go before course names and in paths."
- Scan strip (panel card, padding 12 14, gap 8, `role="status"`): a 16 px `loader-circle` in
  `color.accent.default` that turns (`motion.duration.spin`, `motion.easing.linear`), "Reading your
  library…" (600), and on the right "4,210 files so far" (`font.size.small`, tabular figures) from
  `JobChanged` for the scan job; when the total is known, "4,210 of 11,000 files" and a determinate
  bar. The bar is `size.progress-bar` (4) high, `color.progress.track` with `color.progress.fill`;
  without a total, a 34 % segment sweeps across it (`motion.duration.indeterminate`, linear). Help
  "You can finish now. Folio keeps reading in the background and shows its progress in the
  toolbar." When the scan is done: a `circle-check` in `color.feedback.success`, "Read 11,000 files",
  no bar and no help.
- "Semester to show first": a select, 240 px (app-shell §9 select), listing `list_semesters` in their
  order. Default: the semester holding the most recently modified file (`list_files` over the library
  sorted by `modified` descending, limit 1: its first path name); until the scan has found files, the
  last semester in the list. Help: "Each folder at the top level is a semester: Fall 2025, Winter
  2026, Fall 2026 and Personal." (more than four: "…, Fall 2026 and 3 more").
- "Courses in Fall 2026 · 5": rows as in 5.1 but the name is the folder name as read-only text
  (`font.size.body`), with no remove button and no "Add course" (courses come from folders; more can
  be added later in Library settings). Column headings "Code (optional)" and "Folder name".
- The lists follow the scan: on `CatalogChanged` with `groups`, refetch `list_semesters` and
  `list_courses`. A semester without courses yet reads "Folio hasn't found course folders in Fall 2026
  yet." (`font.size.label`, `color.text.secondary`).
- A folder with only files at the top level (`folders: 0`) shows 5.1 instead, with the intro "This
  folder has no semester folders yet."
- Footer: "You can change all of this later in Library settings." (`font.size.small`,
  `color.text.tertiary`) on the left, "Finish" on the right.
- Finish: `update_course { course, abbr, code, color, archived }` for every listed course whose code
  or colour differs from the catalog (send `abbr` and `archived` as `list_courses` gave them); the
  chosen semester becomes the current one on this computer; then the Library view. Failures show
  under their row, as in 5.1.

## 6. After the first run

- The Library view opens on the chosen semester. After a take-over, the scan and hashing continue:
  the activity button in the toolbar shows their progress (library-actions.md §10) and the tree fills
  in as `CatalogChanged` arrives.
- No tour or coach marks in M1 (brief §11 puts the first-use guide in M4, lane `feat/ui-onboarding`).

## 7. Library unavailable

Board: "启动 · 找不到资料库" (`missing`); the other reasons use the same layout.

The same screen replaces the Library view when `LibraryStateChanged` reports `unavailable` while
Folio runs: the folder was moved or its drive removed, or the watcher failed
([library state](../../specs/library-state.md), "State and threads"). Open dialogs and menus close
without saving, and the polite live region reads the title.

Layout: the title bar only; a column `size.first-run-content` wide, centred horizontally and
vertically (60 px extra space below), content left-aligned, `space.20` apart: the state tile
(`size.state-tile`, tone below), the title (`font.size.display`, 600), the text (`font.size.body`,
`color.text.secondary`), the library path in a read-only field (`color.input.background-readonly`,
34 px, `folder` icon), the buttons (34 px) and a link row.

| `reason` | Tile | Title | Text | Buttons | Link |
|---|---|---|---|---|---|
| `missing` | Warning, `folder-x` | Can't find your library | Folio keeps your library in the folder below, but it isn't there. If you moved or renamed it, show Folio where it is now. If it's on a drive that isn't connected, connect the drive and try again. | "Locate library…" (accent), "Try again" | Or "Start a new library" |
| `notALibrary` | Warning, `folder-x` | Your library's settings are missing | The folder below is still there, but its hidden .folio folder is missing or damaged, so Folio can't find your tags and course settings. If you have a copy of that folder, put it back and try again. | "Try again" (accent), "Locate library…" | Or "Start a new library" |
| `newerFormat` | Warning, `circle-alert` | This library needs a newer Folio | A newer version of Folio saved this library. Update Folio, then open it again. Your files are fine. | "Try again" | Or "Start a new library" |
| `accessDenied` | Danger, `lock` | Folio can't open your library | Windows denied access to the folder below. Check that you can open it in File Explorer, then try again. | "Try again" (accent), "Locate library…" | — |
| `catalogFailed` | Danger, `circle-x` | Folio can't open its search index | Your files are fine, but the index Folio keeps on this computer couldn't be opened. This happens when another copy of Folio is running or the disk is full. Close other copies of Folio, then try again. | "Try again" (accent), "Copy details" | — |
| `unfinishedMove` | Warning, `circle-alert` | A move didn't finish | Folio stopped partway through moving or renaming an item, and the library has changed since, so Folio can't finish or undo the move. Your files are fine. Discard the move to open your library with your files where they are now. | "Discard move…" (accent), "Try again" | — |

Tones: warning tile `color.feedback.warning-soft` with a 1 px `color.feedback.warning-border` and
the icon in `color.feedback.warning`; danger tile the same with `danger`.

- "Locate library…" is `pick_library_folder` then `open_library`; its errors show as a banner under
  the path field (section 4.4). "Start a new library" goes to the welcome screen's first card.
- "Try again" calls `library_status`, which reopens the configured library when it is unavailable
  (ipc-m1 §6, settled 2026-09-29; `feat/core-library-ops` implements it). The screen then follows
  the answer: the Library view for `open`, this screen with the new reason otherwise. Until that
  lane lands, the button is left out and the text ends with "Restart Folio to try again."
- "Discard move…" (`unfinishedMove`, lane `feat/ui-discard-move-action`, 2026-10-03) opens an alert
  dialog (`role="alertdialog"`, section 2.8 frame of library-actions, `size.dialog-small`): title
  "Discard the unfinished move?", description (`aria-describedby`, `color.text.primary`) "Folio
  forgets the move and reads your library again. Your files stay where they are now: nothing is
  moved, deleted or changed.", then a note in `color.text.secondary`: "If part of the move already
  happened, check the item's tags once your library opens." Footer: "Cancel" (focused) and
  "Discard move" (danger). Cancel, Esc and the close button change nothing; focus returns to
  "Discard move…". Only "Discard move" calls `discard_unfinished_move` (ipc-m1 §6); while it runs
  the button shows a spinner and "Discarding…", and Cancel and Esc wait. The dialog closes on the
  answer, which the screen follows as it follows "Try again": the Library view for `open`
  (`LibraryStateChanged` usually gets there first), this screen with the new reason otherwise
  (its title takes focus), and an unchanged status keeps the screen and reads its title again.
- A failed discard shows a danger banner under the path field, titled "Folio couldn't discard the
  move", and changes nothing; pressing again is safe. Texts (all end in the action to take):

  | Code | Text | "Copy details" |
  |---|---|---|
  | `InUse` | Another app, such as a sync or backup app, is using a file in the library folder. Close it, then discard the move again. | — |
  | `AccessDenied` | Windows denied access to a file in the library folder. Check that you can open the folder in File Explorer, then discard the move again. | — |
  | `DiskFull` | The disk is full. Free up some space on E:, then discard the move again. (Without a drive letter: "…some space, then…") | — |
  | `NewerFormat` | A newer version of Folio saved this library. Update Folio, then open it again. Your files are fine. | — |
  | `Busy` | Folio is still opening or closing the library. Wait a moment, then discard the move again. | — |
  | `Transport` | This window can't reach the rest of Folio. Restart Folio. | Yes |
  | `NotFound`, `FileSystem`, `Internal`, `DataDirUnavailable` | Your files weren't touched. Discard the move again. If this keeps happening, copy the details and send them to the developer. | Yes |

- Two failures before any library state exist use the same frame with a danger tile (`circle-x`):
  `DataDirUnavailable` — "Folio can't start" / "It can't find a place on this computer to keep its
  data. Restart Folio. If this keeps happening, copy the details and send them to the developer."; a
  `Transport` error from `library_status` — "Folio can't start" / "This window can't reach the rest
  of Folio. Restart Folio." Both have one button, "Copy details".
- A library that opens read-only or recovered shows a banner in the Library view instead
  (library-actions.md §9.1).

## 8. Field messages

Shown under the field (`font.size.small`, `color.feedback.danger`, a 14 px `circle-alert`), the
field's bottom edge turns `color.feedback.danger` and it gets `aria-invalid="true"` and
`aria-describedby` pointing at the message. Invalid characters are flagged while typing; the other
rules on blur and on submit; the shell's codes when it answers.

| Field | Code or check | Message |
|---|---|---|
| Library name | `NameEmpty` | Enter a name for the library. |
| | `NameTooLong` | Use 128 characters or fewer. |
| | `NameInvalidCharacter` | Remove line breaks and other control characters. |
| Semester, course name (folder names) | `NameEmpty` | Enter a semester name. / Enter a course name. |
| | `NameInvalidCharacter` | A semester name can't contain \ / : * ? " < > \| because it becomes a folder name. (course: "A course name …") |
| | `NameTrailingDotOrSpace` | A folder name can't end with a dot or a space. |
| | `NameReserved` | Windows reserves this name, like CON or NUL. Choose another. |
| | `NameTooLong` | This name is too long for a folder. Shorten it. |
| | `PathTooLong` | The folder's full path would be too long for Windows. Use a shorter name. |
| | `AlreadyExists` | There's already a semester called Fall 2026. / Another course in Fall 2026 already has this name. (Names that differ only in capitals count as the same.) |
| Course code | `NameTooLong` | Use 32 characters or fewer. |
| | `NameInvalidCharacter` | Remove line breaks and other control characters. |
| Any | `ReadOnly`, `DiskFull`, `AccessDenied`, `FileSystem`, `Internal` | The generic message from `errors`, as a banner above the footer |

The code field is optional: empty sends `null`, so it never shows `NameEmpty`.

## 9. Keyboard and screen readers

| Screen | Initial focus | Keys |
|---|---|---|
| Welcome | "Start a new library" | Tab: card 1, card 2, "Open your library…"; Enter or Space activates |
| Step 1 | The library name, text selected | Enter submits the step; Tab order: Change…, name, banner buttons, Back, primary |
| Step 2, new library | The semester field | Enter in a course name adds a row; Enter elsewhere submits; each row: code, name, colour, remove |
| Step 2, take-over | The first empty code field | Enter submits ("Finish") |
| Colour popover | The selected swatch | Arrow keys move and select; Enter, Space or a click closes it; Esc closes it; focus returns to the colour button |
| Unavailable | The title (`tabindex="-1"`) | Tab: the buttons, then the link |
| "Discard the unfinished move?" | Cancel | Tab stays in the dialog; Esc cancels (not while it runs); focus returns to "Discard move…" |

- Esc does nothing on the full-window pages; there is nothing to close.
- Each page sets the document title ("Welcome to Folio", "Start a new library — Folio", …) and moves
  focus as listed, so screen readers announce the new page.
- The choice cards are buttons named by their titles, with the descriptions attached through
  `aria-describedby`. The illustrations, the app icon and the badge previews are `aria-hidden`.
- Banners that appear after an action use `role="alert"`; the scan strip is `role="status"`, updated
  at most every 5 s.
- Targets are at least 24 × 24 px: the smallest are the remove buttons and swatches (28 px) and the
  link button (28 px tall).

## 10. Motion

| Element | Trigger | Animation | Duration, easing | Reduced motion |
|---|---|---|---|---|
| Step page | Next step | Fade in and rise 4 px | `motion.duration.base`, `motion.easing.standard` | Instant |
| Colour popover | Open, close | Fade | `motion.duration.fast` | Instant |
| Spinner (`loader-circle`) | Waiting | One turn per cycle, forever | `motion.duration.spin`, `motion.easing.linear` | Still |
| Indeterminate bar | Total unknown | A 34 % segment sweeps left to right, forever | `motion.duration.indeterminate`, `motion.easing.linear` | A still segment at the start |
| Determinate bar | Progress | Width follows the value | `motion.duration.fast` | Instant |

## 11. Review notes

Critique and accessibility pass on the canvas boards, by hand, with the `design:design-critique`,
`design:accessibility-review` and `design:ux-copy` checklists.

Fixed on the canvas:

- The welcome illustration had the caption "Every change is kept", wrong for "Latest copy only" files
  and for M1; removed.
- The iCloud warning read like a promise ("Folio will back up to iCloud"); now "A later version of
  Folio backs it up to iCloud for you."
- The take-over map showed example names as if they were read from the folder (nothing lists an
  outside folder before `create_library`); it is now labelled "example" and only the first row is
  real.
- "Starting over?" before "Start a new library" suggested the library would be lost; now "Or".

Checked and passing (values in `design/tokens/README.md`):

- Text on the new feedback backgrounds: danger 5.14:1 and 5.91:1 (light, dark), warning 5.28 and
  6.94, success 4.86 and 6.71; the danger text on the lowest surface is 5.05 and 5.88.
- Invalid field bottom edge (`color.feedback.danger`) 5.92:1 on panels; radio and checkbox borders
  (`color.input.border-bottom`) 3.33:1 on the warning background; progress fill on track 4.01 and
  6.29.
- Keyboard: every control is a real button, input or radio; focus is visible on all of them.

Accepted limitations:

- The lightest palette dots in the colour popover (amber) are 2.6:1 on the panel. Each swatch is
  named in its label and tooltip and the footer names the selection; the selected ring is 17:1. Same
  trade-off as tag dots (app-shell decision 8A).
- At 500 × 320 the step pages scroll; nothing else changes.

## 12. Open items

1. **Reopening the library** (`feat/core-library-state`): "Try again" on the unavailable screen needs
   the shell to retry opening the configured library. Suggested without a new command:
   `library_status` retries the open when the last state is `unavailable`. Until then section 7 hides
   "Try again". Settled as suggested (ipc-m1 §6, 2026-09-29); `feat/core-library-ops` implements it.
2. **Loose files**: files directly in the library folder or in a semester folder are in no course.
   Search and the quick views find them; where the tree shows them is for `feat/ui-library-view`
   (suggestion in library-actions.md §16).
3. **The current semester** (resolved while this lane ran): the UI's session store keeps it per
   library on this computer ([UI architecture](../../specs/ui-architecture.md) §6.1). First run sets
   it as in 5.1 step 4 and 5.2.
4. **Step 2 is several commands**; a failure in the middle is handled per row (5.1). No batch command
   is needed for M1.
5. **Later steps**: the optional cloud remote (M3, `design/design-sync`) and DeepSeek key (M2) steps
   of brief §7 item 1 come after step 2 and get their own boards.
