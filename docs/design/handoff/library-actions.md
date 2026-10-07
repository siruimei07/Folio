# Library actions — design handoff

Build spec for what the user does to files in the Library during M1, and for the feedback Folio
gives: dropping and adding files (the drop target, the import dialog, progress and results), context
menus, renaming, new folders, moving and deleting, the shared feedback components (field errors,
callouts, banners, toasts, state blocks, progress), the empty and error states, failed window
commands, and the progress of background jobs with the problems list.

- Status: ready to build. Decision 29 is Sirui's (2026-09-28); the others in section 1 are design
  defaults. Updated 2026-09-28 (lane `design/design-m1-flows`).
- Source of truth for looks: the Cowork Design canvas "Folio 设计基础"
  (<https://claude.ai/artifact/F1eGkQ7kuFr3HYayxLtD2K>), rows 4 "M1 流程 · 拖放、导入、右键菜单、重命名"
  and 5 "M1 流程 · 任务进度、问题列表、空状态、错误", boards named in each section; the tokens in
  [`design/tokens/`](../../../design/tokens/README.md) (round 4 added the feedback, drop, progress,
  menu and dialog tokens); the Design System artifact "Folio Design System"
  (<https://claude.ai/artifact/QfXvWuzvoGdhUZCU4tsZyM>). The boards share one window component
  ("M1 窗口组件", `M1Shell`), which is not a screen of its own. It draws the M1 window: the rail
  shows Library only (ADR-0005, product decision 3), the toolbar's sync area stays empty until M3
  (roadmap §5, `feat/ui-app-shell`), and the file header has no history button before M2.
- Inputs: [brief](../../product/brief.md) §5.1–§5.3, §9, §13; [IPC contract](../../specs/ipc-m1.md)
  §4, §5, §8, §9, §11–§16; [library scan](../../specs/library-scan.md) §4, §5, §9;
  [Windows adapter](../../specs/windows-adapter.md) §4; [app shell](app-shell.md) §2–§5, §8, §10,
  §11, §12; [UI architecture](../../specs/ui-architecture.md) §2, §5.6, §6.4, §7.1, §12, §13 and
  [library state](../../specs/library-state.md) (jobs, problems, rebuild), both written while this
  lane ran; the coordinator notes on window commands (WP-02). First run and the start-up states are
  in [first-run.md](first-run.md).
- Language: English source copy. Namespaces (lane `feat/ui-i18n-english`): `library` (tree, menus,
  empty states, rename, move, delete), `import` (drop target, dialog, results), `shell` (activity,
  problems, toasts, window commands), `preview`, `search`; the generic message of each error code
  stays in `errors`, and this spec only adds the wording that depends on the action. Apostrophes are
  straight ('), as in `errors.json`; a name quoted inside a string uses “ ”. The boards may still
  show ’.
- Skills: `design:design-critique`, `design:accessibility-review` and `design:ux-copy` applied by hand
  to the boards (section 15); written with `design:design-handoff`.

## 1. Decisions

| # | Decision | Chosen |
|---|---|---|
| 29 | Where background jobs show | A: an activity button in the toolbar, left of search. Hidden when nothing runs and there are no problems; opens the Activity popover |
| — | Drop target | The course or folder row under the pointer; anywhere else, the current folder, shown on the preview (app-shell §5) |
| — | Name clashes | One choice for all clashes (IPC product decision 1); "Keep both" is preselected, since it replaces and loses nothing |
| — | Tags in the import dialog | Preselected: the tags of the active tag filter |
| — | Import feedback | The dialog closes as soon as the import starts; a toast shows progress, then the result; the Activity popover keeps the result |
| — | Deleting | Files and folders go to the Recycle Bin without a question, as in File Explorer, and a toast confirms it; courses and semesters ask first |
| — | Toasts | Success and information close after 6 s, paused while hovered or focused; warnings and errors stay until dismissed. Every toast action is also available elsewhere, so a toast never has to be reached by keyboard |
| — | Menus | Context menus in the app's own look (not the native Windows menu): `shadow.menu`, `radius.panel`, 30 px items, shortcuts on the right, Delete in `color.feedback.danger` |
| — | Recently added | The last 7 days (`list_files` with `addedAfterMs`) |

## 2. Shared components

### 2.1 Field error

Under the field: a 14 px `circle-alert` and the message, `font.size.small`, `color.feedback.danger`,
6 px gap. The field keeps its borders and its bottom edge turns `color.feedback.danger` (5.92:1 on
panels). `aria-invalid="true"`, and `aria-describedby` points at the message. Invalid characters are
flagged while typing; other rules on blur or submit.

### 2.2 Callout

For fields inside rows (inline rename, new folder). Board: "重命名 · 名称不合法".

- Anchored under the field, 5 px below it, left edges aligned, width of the field (at most 300 px);
  an 8 px notch 14 px from the left.
- `color.feedback.danger-soft`, 1 px `color.feedback.danger-border`, `radius.control`,
  `shadow.menu`, padding 8 10, gap 8; a 14 px `circle-alert` in `color.feedback.danger`; text
  `font.size.small`, `color.text.primary`; `z-index.menu`.
- `role="alert"` when it first appears and when its text changes, not on every keystroke; the field's
  `aria-describedby` points at it. It follows the field when the tree scrolls and closes with the
  field.

### 2.3 Banner

Two sizes, one pattern: tone background, 1 px tone border, `radius.control`, a 16 px tone icon, text
in `color.text.primary` and `color.text.secondary` (never tertiary on tone backgrounds).

| Size | Where | Spec |
|---|---|---|
| Panel | Top of the Library panel, under its header | Margin 8 8 0, padding 9 10, gap 8, `font.size.label`: a lead-in sentence in 600, then the rest in `color.text.secondary` on the same line |
| Block | Dialogs, first-run pages | Padding 10 12, gap 10: title line (600) above the text (`color.text.secondary`), optional buttons below |

Tones and icons (tokens README "Feedback colours"): danger `circle-x`, warning `triangle-alert`,
success `circle-check`, information `info`; a lock (`lock`) for read-only. Banners that appear after
an action use `role="alert"` (danger) or `role="status"` (others); banners present when a view opens
are read in place.

### 2.4 Toast

Board: "导入 · 进度和结果通知".

| Part | Spec |
|---|---|
| Stack | Bottom right, `space.16` from the window's right and bottom edges, newest at the bottom, `space.8` apart, `z-index.toast`; in a region `section aria-label="Notifications"`. At most three; a fourth pushes out the oldest |
| Toast | `size.toast` (360) wide, `color.surface.panel`, 1 px `color.border.default`, `radius.panel`, `shadow.menu`, padding 12 8 12 14, gap 10 |
| Icon | 16 px, 2 px from the top: success `circle-check` `color.feedback.success`; warning `triangle-alert` `color.feedback.warning`; error `circle-x` `color.feedback.danger`; information `info` and progress `loader-circle` (turning) in `color.accent.default` |
| Text | Title `font.size.label` 600; body `font.size.small` `color.text.secondary`; optional progress bar 6 px below |
| Actions | Link buttons under the text, 24 px tall, padding 0 6, `font.size.small` 600 `color.accent.default`, hover `color.surface.hover`, `radius.row` |
| Close | 24 px icon button (`x`, 14 px), `color.text.tertiary`, "Dismiss" (progress toasts: "Hide", which keeps the job running) |

- Success and information close after 6 s (UI constant `TOAST_DISMISS_MS = 6000`, not a duration
  token: reduced motion sets every duration token to 0), paused while the pointer or focus is inside.
  Warnings, errors and progress stay until dismissed or finished.
- Success, information and progress are `role="status"`, errors `role="alert"`. A toast never takes
  focus. A repeat of the same message replaces the toast instead of stacking.
- Narrow window: `window width − 32 px` wide, centred at the bottom.

### 2.5 State block

Empty and error states inside a panel or dialog (boards in row 5).

- A centred column: the state tile (`size.state-tile`, 10 px radius, 1 px border, a
  `size.icon-large` icon), `space.12` below it the title and text (4 px apart), then the buttons
  (32 px, `space.8` apart) and an optional hint (`font.size.small`, `color.text.tertiary`).
- Tile tones: neutral `color.surface.sunken` / `color.border.default` / `color.text.secondary`;
  danger, warning, success with the feedback colours.
- In the tree: 96 px below the top of the tree area (below the quick views when they show), padding
  0 24; title `font.size.body` 600; text `font.size.label` `color.text.secondary`.
- In the preview: centred, 400 px wide; title `font.size.heading` 600; on the 14 px dot grid for empty
  states, on `color.surface.sunken` without dots for errors.

### 2.6 Progress

- Bar: `size.progress-bar` (4) high, 2 px radius, `color.progress.track` with a
  `color.progress.fill` part as wide as the value. Unknown total: a 34 % segment sweeps from left to
  right (`motion.duration.indeterminate`, `motion.easing.linear`, forever); under reduced motion it
  stands at the start. `role="progressbar"` with `aria-valuenow` when the value is known.
- Ring (the activity button): 14 px (`size.icon-small`), a circle of radius 5.5 with a 2 px stroke,
  the track in `color.progress.track`, the arc in `color.progress.fill` from 12 o'clock clockwise,
  round caps; unknown total: a quarter arc turning (`motion.duration.spin`, linear).
- Spinner: the `loader-circle` icon turning once per `motion.duration.spin`; still under reduced
  motion.

### 2.7 Menu

Boards: "右键菜单 · 文件（标签子菜单）", "右键菜单 · 课程".

| Part | Spec |
|---|---|
| Frame | `color.surface.panel`, 1 px `color.border.default`, `radius.panel`, `shadow.menu`, padding 4, `z-index.menu`; width from `size.menu-min-width` (200) to `size.menu-max-width` (320), growing with the longest label |
| Item | `size.menu-item` (30) tall, padding 0 8, gap 10, `radius.row`: a 16 px icon in `color.text.secondary`, the label (`font.size.body`, one line, truncated with a tooltip), the shortcut (`font.size.small`, `color.text.tertiary`) or a 14 px chevron-right for a submenu |
| Hover, open submenu | `color.surface.hover` |
| Keyboard focus | `color.surface.hover` and a 2 px inset `color.focus.ring` outline (the hover tint alone is too faint to show focus) |
| Destructive | Label and icon `color.feedback.danger` (5.92:1 on the panel, 5.30:1 on hover) |
| Disabled | Label `color.text.tertiary`, `aria-disabled="true"`, still focusable so it is announced |
| Checkable | A 16 px check column: `check` 14 px in `color.accent.default` when on, `minus` when mixed, empty when off; the item's icon is the tag dot (8 px); `role="menuitemcheckbox"` |
| Separator | 1 px `color.border.default`, margin 4 6 |

- Opening: right-click opens at the pointer (top-left corner 4 px below and right of it);
  Shift+F10 or the Menu key opens under the focused row's name. The menu flips to stay 8 px inside the
  window. Right-clicking a row that is not selected selects it first; right-clicking inside a
  multiple selection keeps it.
- Submenus open to the right on hover (after 200 ms) or Right arrow, overlapping the menu by 4 px,
  top aligned with their item; they flip left when there is no room.
- Keys: Up and Down move (wrapping), Home and End, typing a letter jumps to the next item starting
  with it, Enter or Space activates, Right opens a submenu and Left or Esc closes it, Esc closes the
  menu and returns focus to where it was, Tab closes it. `role="menu"`, `menuitem`, `aria-haspopup` and
  `aria-expanded` on submenu items.
- Checkable tag items toggle on click or Space and keep the menu open; Enter toggles and closes it.

### 2.8 Dialog frame

Boards: "导入对话框", "确认 · 删除课程", "问题列表".

- Scrim `color.overlay.modal-scrim` from below the title bar (so the caption buttons still work),
  `z-index.dialog`; the dialog one above.
- Frame: `color.surface.panel`, 1 px `color.border.default`, `radius.dialog`, `shadow.overlay`,
  centred horizontally; at most `window height − 81 px` tall, with the body scrolling.
- Header: padding 16 12 0 20; title `font.size.dialog-title` (16) 600; a 28 px close button ("Close
  (Esc)", 15 px `x`, `color.text.tertiary`).
- Body: padding 14 20 18, sections `space.16` apart.
- Footer: padding 12 20, 1 px `color.border.default` on top, `color.surface.sunken`; buttons
  (`size.dialog-control`, 34 px) on the right, `space.8` apart, the primary last.
- Modal (`aria-modal="true"`, `aria-labelledby` the title), focus trapped; Esc and the close button
  cancel; focus returns to the control that opened it.
- Sizes: the import dialog `size.import-dialog` (560); confirmations `size.dialog-small` (440); the
  problems list `size.problems-dialog-width` × `size.problems-dialog-height` (720 × 560).

### 2.9 Folder picker

Not drawn; built from the tree rows of app-shell §5. Used by "Add to" in the import dialog (as a
popover under the button) and by the Move dialog (in its body).

- A semester select at the top (`size.select`, current semester first), then the courses of that
  semester (badge, code, name) with their folders, tree pattern, rows `size.row`, 16 px indent,
  at most 320 px tall, scrolling.
- The chosen folder has the selected style (`color.surface.selected` and the indicator bar). Enter,
  a click or a double-click chooses; Esc closes the popover.
- In the Move dialog, the folder the items are in is shown in `color.text.tertiary` with "Already
  here", and a moved folder and everything below it cannot be chosen (`InvalidMove`).

## 3. Drop target

Boards: "拖放 · 拖到预览区 = 当前课程", "拖放 · 拖到树里的课程或文件夹".

The shell reports `DropHover { position }` while files are dragged over the window and
`FilesDropped { source, position }` when they are dropped (IPC §12). The UI finds the target at the
position:

| Under the pointer | Target | Shown |
|---|---|---|
| A course or folder row in the tree | That course or folder | The row |
| A file row in the tree | Its folder | The folder's row |
| Anything else: the rest of the Library panel, the preview, the toolbar, the rail, the Changes or History view | The current folder: the course or folder selected in the Library; for a selected file, its folder; after a quick view or with nothing selected, the course last selected | The preview panel |
| No course anywhere yet, or no current folder | None: the import dialog asks | The preview panel, without a name |

Row target: `color.drop.row` fill, a 2 px dashed `color.drop.outline` border 1 px inside the row
(5 px radius), and on the right "Add here" (`font.size.caption`, 600, `color.accent.default`, 4.59:1
on the fill) in place of the count or tag dots. The selection bar is hidden while the row is the
target. A collapsed course or folder that stays under the pointer for 700 ms expands.

Panel target (the preview, or the visible panel in a narrow window): a `color.drop.wash` layer over
the whole panel with 8 px padding, inside it a 2 px dashed `color.drop.outline` border, 8 px radius,
and centred on it a message card: `color.surface.panel`, 1 px `color.border.default`,
`radius.panel`, `shadow.menu`, padding 16 20 16 16, gap 14, max 440 px; a `size.state-tile` tile in
`color.accent.soft` with the 22 px `import` icon in `color.accent.default`; the title
(`font.size.heading`, 600) and the text (`font.size.label`, `color.text.secondary`):

| Target | Title | Text |
|---|---|---|
| A course | Drop to add to MAT232 | Files are copied into the course. The originals stay where they are. |
| A folder | Drop to add to MAT232 / Problem sets | Files are copied into the folder. The originals stay where they are. |
| None | Drop to add files | You'll choose where they go next. |

The course label is the code, or the name of a course without one (app-shell 27B). The wash sits at
`z-index.drop-target`, under search and dialogs.

Rules:

- The drag image and the "+ Copy" label next to the pointer are drawn by Windows; Folio does not
  change them. The tree does not scroll by itself while dragging in M1.
- `DropHover { position: null }` removes the target (fade out over `motion.duration.fast`).
- On `FilesDropped` the target comes from the drop position by the same rules, and the import dialog
  opens (section 4).
- No target shows, and a drop adds nothing, while a dialog, the search or a menu is open, on the
  first-run and start-up screens, and while the index is rebuilt. The source token then simply
  expires, and a toast explains, except on the first-run screens: "Close the dialog to add files." /
  "Folio is rebuilding its index. Add the files when it's done." (information).
- A read-only library accepts drops: the dialog adds files without tags (section 4).
- Pointer only by nature; the keyboard way is "Add files" (Ctrl+O, the "+" in the Library header, and
  the course and folder menus).

## 4. Adding files: the import dialog

Boards: "导入对话框", "导入对话框 · 同名文件一次选择 + 删除原文件", and "深色检查 · 导入对话框".

Opens after a drop, or after "Add files" (`pick_import_files`; `null` means cancelled and nothing
opens). `check_import { source, target }` runs as soon as it opens and again when the destination
changes; it does not use up the token, `import_files` does (IPC §12).

| Part | Spec |
|---|---|
| Frame | Section 2.8, `size.import-dialog` (560) wide, 96 px from the top (48 px when it is tall) |
| Title | "Add files to MAT232" (the course label; "Add files to MAT232 / Problem sets" for a folder; "Add files" while there is no target) |
| Items | A sunken box (`color.surface.sunken`, 1 px border, `radius.control`, padding 4 0): up to three 30 px rows (padding 0 10, gap 8: a 16 px type icon in its palette colour, or `folder` in `color.text.secondary`; the name, one line, truncated in the middle; "Folder" on the right in `font.size.small` `color.text.tertiary`), then a 26 px line "and Formula sheet.pdf" or "and 7 more" (`font.size.small`, `color.text.tertiary`). Names come from `ImportSource.names` (the first ten top-level items; `kind: "folder"` marks the folders) |
| Summary | `font.size.label`, `color.text.secondary`, tabular figures: "12 files in 1 folder · 48.2 MB" from `check_import` (`files`, `folders`, `bytes`: B, KB, MB, GB with one decimal above 10 KB); while checking, a 14 px spinner and "Checking…" |
| Left out | Only when `skipped > 0`, `font.size.small`, `color.text.tertiary`: "2 items are left out: your ignore rules skip them (like .git or node_modules), or they're shortcuts or special files." ("1 item is left out: …") |
| Add to | A 56 px label column "Add to", then a select-style button (`size.select` 32, min 240 px, `color.input.*` borders): course badge, code (600), course name (`color.text.secondary`), "/ Problem sets" for a folder, a 14 px chevron. Opens the folder picker (2.9) |
| Tags | Label "Tags" (56 px column), tag chips as toggle buttons (13A: idle, and pressed with `color.text.primary` fill), `aria-pressed`; help "Every file and folder you add gets these tags." Preselected: the active tag filter |
| Name clashes | Only when `conflictCount > 0`; section 4.1 |
| Originals | A checkbox (15 px box in a 24 px hit area; checked: `color.accent.default` fill with a 12 px `check` in `color.text.on-accent`; unchecked: 1 px `color.input.border-bottom`): "Move the originals to the Recycle Bin after copying", help "Only once everything is copied and checked. Otherwise the originals stay." Off by default (brief §13) |
| Footer | "Cancel" (outline) and the primary "Add 12 files" (accent; "Add 1 file"). While checking, the primary reads "Add files" and is disabled; with nothing to add (everything left out), "Nothing to add", disabled |

### 4.1 Name clashes

A warning block (`color.feedback.warning-soft`, 1 px `color.feedback.warning-border`,
`radius.control`, padding 12 14, gap 10) grouped as `role="group"`:

- Heading with a 16 px `triangle-alert` (`color.feedback.warning`): "3 names are already taken in
  MAT232. Choose once for all of them." (one: "A name is already taken in MAT232."), and under it the
  first three clashing paths relative to the target, joined as a sentence ("Lecture 7 notes.md,
  Formula sheet.pdf and Week 7 problems/Problem 2.pdf"; more than three: "…, Formula sheet.pdf and 9
  more"), `font.size.small`, `color.text.secondary`.
- A radio group, indented 24 px, rows padding 4 8 (hover `color.surface.hover`), a 16 px radio
  (checked: 1.5 px `color.accent.default` ring with an 8 px dot; unchecked: 1 px
  `color.input.border-bottom`, 3.33:1 on the warning fill), label 600 `font.size.label`, description
  `font.size.small` `color.text.secondary`:

| Choice | `onConflict` | Description (several) | Description (one) |
|---|---|---|---|
| Keep both (preselected) | `keepBoth` | The new files get a number, like Lecture 7 notes (2).md. | The new file gets a number: Lecture 7 notes (2).md. |
| Replace | `replace` | Files in MAT232 go to the Recycle Bin; their tags move to the new ones. | The file in MAT232 goes to the Recycle Bin; its tags move to the new one. |
| Skip | `skip` | Files in MAT232 stay; the new ones with those names aren't added. | The file in MAT232 stays; the new one isn't added. |

Clashes that appear after the check follow the same choice; a file never replaces a folder (IPC §12).

### 4.2 Behaviour

- Initial focus: the primary button, so Enter adds with the defaults (nothing replaced, nothing
  lost). Tab order: close, "Add to", tag chips, the radio group (one stop; arrow keys choose), the
  checkbox, Cancel, primary.
- "Add": `import_files { source, target, tags, onConflict, deleteOriginals }` returns a job id; the
  dialog closes at once and the progress toast appears (section 5).
- Errors keep the dialog open, with a block banner under the header and focus on its button:

| Error | Banner | Button |
|---|---|---|
| `ChoiceExpired` (check or import) | Warning: "Choose or drop the files again" / "A selection lasts 10 minutes, and this one ran out. Nothing was added." | "Choose files…" (`pick_import_files`) |
| `NotFound` (the target) | Warning: "MAT232 / Problem sets isn't there anymore" / "It may have been moved or deleted. Choose another place." | Opens the folder picker |
| `ReadOnly` (with tags) | Warning: "Tags can't be added right now" / "A newer version of Folio made this library's settings read-only. The files can still be added, without tags." | Clears the tags; "Add 12 files" |
| `Busy` | Information: "Folio is rebuilding its index" / "Add the files when it's done." | "Close" |
| `InvalidArgument`, `Internal`, `Transport` | Danger: "Folio couldn't check these files" / the generic message | "Copy details" |

- When the library is read-only (`LibraryInfo.readOnly`), the tag chips are disabled with the note
  "Tags can't be added until you update Folio." instead of the help line.

## 5. Import progress and results

Board: "导入 · 进度和结果通知".

While it runs (`JobChanged`, kind `import`): a progress toast, `role="status"`, announced once when
it starts. Title "Adding 12 files to MAT232"; body "7 of 12 · Lecture 7 Lagrange Examples.pptx"
(`progress.done` of `progress.total`, then `progress.current`, truncated in the middle); the bar
shows `permille` when present, else `done / total`. Actions: "Cancel" (`cancel_job`); close "Hide"
(the job continues in the Activity popover). Queued: body "Waiting for another import to finish",
no bar.

The same toast turns into the result when the job ends (the result is also listed in the Activity
popover). `ImportResult.imported` is taken to include replaced and renamed files (open item 2).

| End | Toast | Title | Body | Action |
|---|---|---|---|---|
| Done, no failures | Success | Added 12 files to MAT232 | The parts that apply, joined by " · ": "3 replaced", "1 kept as a copy" (`renamed`), "2 skipped", "originals moved to the Recycle Bin" (`originalsDeleted > 0`); none: no body | "Show" (selects the target in the tree) |
| Done, some failed | Warning | Added 10 of 12 files to CSC207 | "2 couldn't be copied. Their originals stay where they are." | "Details" |
| Failed | Error | Couldn't add files to MAT232 | The message for the job's error code; what was copied stays | "Details" |
| Cancelled | Information | Stopped adding files to MAT232 | "7 of 12 were added before you stopped." | — |

"Details" opens the result dialog: section 2.8 frame, 560 px, title "2 files weren't added", a
scrolling list with a row for every failed item, none dropped (UI architecture §13) (padding 10 12; the item's path below its source, 600, truncated in the middle; the reason,
`font.size.small` `color.text.secondary`), footer "Copy details" and "Close". Reasons by error code:
`InUse` "Another app is using it.", `AccessDenied` "Windows denied access.", `DiskFull` "The disk is
full.", `NameInvalidCharacter`, `NameTrailingDotOrSpace`, `NameReserved` "Its name isn't allowed on
Windows.", `PathTooLong` "Its path would be too long for Windows.", `FileSystem` "Something went wrong
while copying it.", others the generic message. The same dialog shows batch failures of section 7.

## 6. Context menus

Boards: "右键菜单 · 文件（标签子菜单）", "右键菜单 · 课程". Component: section 2.7.

| Target | Items |
|---|---|
| File | Open with default app · Show in File Explorer · ─ · Tags ▸ · Rename (F2) · Move to… · Copy path (Ctrl+Shift+C) · ─ · Delete (Del) |
| Folder in a course | Add files… (Ctrl+O) · New folder (Ctrl+Shift+N) · ─ · Open in File Explorer · ─ · Tags ▸ · Rename (F2) · Move to… · Copy path (Ctrl+Shift+C) · ─ · Delete (Del) |
| Course | Add files… (Ctrl+O) · New folder (Ctrl+Shift+N) · ─ · Open in File Explorer · ─ · Course settings… · Rename (F2) · ─ · Delete course… (Del) |
| Several files and folders | Tags ▸ (mixed checks) · Move 3 items to… · Copy paths · ─ · Delete 3 items (Del) |
| A selection with a course in it | Copy paths · ─ · Delete 3 items (Del) |
| Empty space in the tree | Add files… (Ctrl+O; to the current course, disabled without one) · New course… |
| "More" (…) in a file's preview header | Rename (F2) · Move to… · Copy path (Ctrl+Shift+C) · ─ · Delete (Del) |
| Tiles in the preview grid | As the tree row of the same entry |
| Quick views, separators, search results | No menu in M1 |

Icons: `external-link` open, `folder-search` show or open in File Explorer, `tag` tags, `pencil`
rename, `folder-output` move, `copy` copy path, `trash-2` delete, `plus` add files, `folder-plus` new
folder, `settings` course settings. M2 adds "View history" after "Show in File Explorer".

What they do:

| Item | Command or action |
|---|---|
| Open with default app | `open_entry`; `mode: "editor"` shows an information toast (section 9.3); double-clicking a file does the same. No shortcut: Enter previews (app-shell §5) |
| Show in File Explorer (file) | `reveal_entry` |
| Open in File Explorer (folder, course) | `open_entry` on the folder |
| Tags ▸ | A submenu of all tags in order (checkable, tag dot as icon), then "Edit tags…" (Library settings → Tags). Toggling calls `set_entry_tags { entries, add, remove }` at once. A tag a folder above gives (`folderTags`) shows checked and disabled with "From folder" on the right. Several selected: checked when all have it, mixed when some do; choosing a mixed or unchecked tag adds it to all, a checked one removes it from all. Read-only library: one disabled line "Tags can't change until you update Folio" |
| Rename | Inline rename, section 7.1 |
| Move to… | The Move dialog, section 7.3 |
| Copy path(s) | The absolute Windows path (library root + path with `\`), one per line, no quotes; an information toast "Copied the path" |
| Add files… | `pick_import_files`, then the import dialog with that folder as the target |
| New folder | Section 7.2 |
| Course settings… | Library settings → Courses with this course's row focused (app-shell §9) |
| Delete, Delete course… | Section 7.4 |
| New course… | Library settings → Courses, starting a new row |

Library shortcuts: Ctrl+O adds files anywhere in the Library view (the registry of
[UI architecture](../../specs/ui-architecture.md) §6.4). While the tree, list or grid has focus: F2
rename, Del delete, Ctrl+Shift+N new folder, Ctrl+Shift+C copy path, Shift+F10 and the Menu key open
the menu, Ctrl+A select all in the list and grid. None fires during IME composition or while a
dialog is open. Menu labels show them; tooltips on the header "+" too.

## 7. Rename, new folder, move, delete

### 7.1 Rename

Board: "重命名 · 名称不合法".

- F2, the menu or a slow second click on a selected row's name turns the name into a field in place:
  24 px tall, padding 0 6, 1 px `color.input.border`, bottom edge `color.input.border-bottom`, a 1 px
  `color.focus.ring` ring, `color.input.background`, 5 px radius. Files start with the name before
  the extension selected; folders and courses with the whole name.
- Enter or moving focus away commits (`rename_entry { entry, name }`); Esc cancels. An unchanged name
  sends nothing. The row keeps its place until the catalog reports the change.
- Invalid characters show the callout (2.2) while typing, and the field's bottom edge and ring turn
  `color.feedback.danger`; Enter then does nothing. The shell's errors show in the same callout and
  keep the field open:

| Code or check | Callout |
|---|---|
| Invalid character (typing) or `NameInvalidCharacter` | A name can't contain \ / : * ? " < > \| |
| `NameTrailingDotOrSpace` | A name can't end with a dot or a space. |
| `NameReserved` | Windows reserves this name, like CON or NUL. Choose another. |
| `NameTooLong` | This name is too long. Use 255 characters or fewer. |
| `PathTooLong` | The full path would be too long for Windows. Use a shorter name. |
| `NameEmpty` | Enter a name. |
| `AlreadyExists` | There's already an item called “ps3-solutions.docx” in Problem sets. |
| `InUse` | Another app is using this file. Close it there, then try again. |
| `ReadOnly` | A newer version of Folio made this library's settings read-only, and this item's tags would have to move. Update Folio to rename it. |
| `AccessDenied` | Windows didn't allow renaming it. |
| `NotFound` | This item isn't here anymore. (The field closes and the tree refreshes.) |

- Changing a file's extension asks first, in a `size.dialog-small` dialog: "Change the extension to
  .txt?" / "ps2.pdf might open in a different app, or not at all." Buttons "Keep .pdf" (focused) and
  "Change".
- A course's rename changes its folder name; its code and badge stay.

### 7.2 New folder

A new row appears under the target folder, in rename mode with "New folder" selected ("New folder
(2)" when the name is taken). Enter sends `create_folder { parent, name }`; Esc removes the row and
creates nothing. Errors as in 7.1. Courses and folders inside them only; semesters get courses
through "Add courses" (section 8).

### 7.3 Move

- Dragging selected rows onto a course or folder row in the tree moves them (`move_entries`), with the
  row target of section 3 but the label "Move here". Dragging onto the preview, or onto the folder
  that already holds them, shows no target and does nothing.
- The drag uses pointer events, because Tauri's native file drop turns off HTML5 drag and drop in
  the page ([UI architecture](../../specs/ui-architecture.md) §2). It starts once the pointer has
  moved 4 px with the button down. Folio draws the drag chip itself, 12 px right of and below the
  pointer: `color.surface.panel`, 1 px `color.border.default`, `radius.row`, `shadow.menu`,
  `z-index.menu`, `size.menu-item` tall, padding 0 8, the item's icon and name (or "3 items") in
  `font.size.body`, at most `size.menu-max-width` wide and truncated. Esc, or releasing away from a
  target, cancels and moves nothing. Keyboard users have "Move to…".
- "Move to…" opens a dialog (2.8, `size.dialog-small`): title "Move ps2.pdf" or "Move 3 items", the
  folder picker (2.9) as the body, footer "Cancel" and "Move here" (disabled until a place other than
  the current one is chosen).
- The result: a success toast "Moved 3 items to MAT232 / Problem sets"; with failures a warning toast
  "Moved 2 of 3 items" and "Details" (the result dialog of section 5). `InvalidMove`: "A folder can't
  go inside itself or one of its folders."
- Folders moved directly into a semester become courses (IPC §9.2): the dialog does not offer
  semesters as targets in M1.

### 7.4 Delete

- Files and folders: Del or the menu moves them to the Recycle Bin at once (`delete_entries`); an
  information toast "Moved ps2.pdf to the Recycle Bin" or "Moved 3 items to the Recycle Bin". Folio has
  no undo in M1; the Recycle Bin restores them, and tags come back with them (IPC §9.2).
- A course asks first (board "确认 · 删除课程"): `size.dialog-small`, 220 px from the top; title
  "Delete MAT232?"; text "The course folder “Calculus of Several Variables” and its 10 files go to the
  Recycle Bin. You can restore them from there." and, in `color.text.secondary`, "Its code, colour and
  tags stay in Folio, so they come back if you restore the folder."; footer "Cancel" (initial focus)
  and "Delete course" (`color.button.danger`, `color.text.on-button-danger`, hover
  `color.button.danger-hover`). A semester, from the semester menu, asks the same way ("Delete Fall
  2026?", "The semester folder and its 5 courses with 25 files go to the Recycle Bin…").
- Failures: a warning toast "Deleted 2 of 3 items" with "Details". Reasons: `InUse` "Another app is
  using it or something in it.", `NotFound` "It was already gone.", and `NotRecyclable` (a drive
  without a Recycle Bin, a path too long for it; its own code since 2026-09-29, open item 3): "Folio
  couldn't move it to the Recycle Bin. The drive may not have one, or the path is too long for it.
  Folio never deletes files for good."

## 8. Empty states

Boards: "空状态 · 学期里没有课程", "空状态 · 课程里没有文件", "空状态 · 标签筛选没有结果",
"空状态 · 搜索没有结果". All use the state block (2.5).

Each region that shows data is in exactly one state: loading, empty, error or ready
([UI architecture](../../specs/ui-architecture.md) §13). Loading is not drawn here: after 150 ms
without data the region shows skeleton rows. Empty states follow; error states are section 9.

| Where | When | Tile | Title | Text | Button |
|---|---|---|---|---|---|
| Tree | No semester at all (first run skipped) | `graduation-cap` | No semesters yet | Add a semester to hold your courses. Folio makes a folder for it in your library. | New semester (accent) |
| Tree | The semester has no courses; quick views and tag bar hidden | `graduation-cap` | No courses in Winter 2027 | Add the courses you're taking. Folio makes a folder for each one inside Winter 2027. | Add courses (accent); hint "Or switch semesters in the menu above." |
| Tree | A tag filter matches nothing; quick views stay | `funnel-x` | No files match | No file in Fall 2026 has both Slides and Exams. A filter with several tags shows files that have all of them. (One tag: "No file in Fall 2026 has the tag Slides.") | Clear filters (outline) |
| Tree | The first scan of a taken-over library has found no course yet | `loader-circle` (turning) | Reading your library… | Courses show up here as Folio finds them. | — |
| Tree | An expanded course or folder with nothing in it | — | One non-interactive child row "Empty" (`font.size.label`, `color.text.tertiary`, at the child indent, no icon) | — | — |
| Preview | No file selected | Desk illustration (app-shell §5) | Select a file to preview | Or drop files here to add them to the current course | — |
| Preview | The semester has no courses or there is no semester | Desk illustration | Add courses to get started | Then drop files here to add them to a course. | — |
| Preview | A course or folder with no files (the header still reads "· 0 files") | `folder-open` | MAT237 has no files yet (a folder: "Problem sets is empty") | Drop files here to add them, or choose Add files. They're copied into MAT237; the originals stay where they are. | Add files (accent, Ctrl+O) |
| Quick view | Recently added is empty | `clock` | Nothing added in the last 7 days | Files you add or save into the library show up here for a week. | — |
| Quick view | Untagged is empty | `circle-check` (success) | Every file has a tag | Files without tags show up here. | — |
| Search | No results | `search-x` | No results for “eigenvector proof” | Search looks at file names, courses and tags, and inside notes, code and Word files. The text inside PDFs and slides isn't searched yet. | — |

- Search without results keeps the footer ("0 results") and announces the title politely. Search
  text over `queryChars` shows a field error under the input, "Search can be up to 256 characters.",
  and sends nothing (`QueryTooLong`).
- "New semester" and "Add courses" open dialogs (not drawn) built from the course rows of
  first-run.md §5.1: "New semester" (560 px) has the semester name, the course rows and a checkbox
  "Archive Fall 2026" (brief §7 item 7), footer "Cancel" and "Create semester and 5 courses"; "Add
  courses to Winter 2027" has only the rows, footer "Cancel" and "Add 2 courses". The semester menu's
  "New semester…" opens the same dialog.
- The Library header's count pill reads "0" (app-shell §4).

## 9. Error states

Board: "错误 · 只读横幅、预览失败、窗口命令失败", and "深色检查 · 错误状态".

### 9.1 Library banners

Panel banners (2.3) at the top of the Library panel:

| When | Tone, icon | Lead-in | Text | Ends |
|---|---|---|---|---|
| `LibraryInfo.readOnly` | Warning, `lock` | Read-only for now. | A newer version of Folio changed this library's settings. You can browse and search; update Folio to change tags and courses. | While read-only. Controls that would write tags or settings are disabled and name this reason |
| A `rebuild` job runs | Information, `info` | Rebuilding the search index. | Some files may be missing from search until it finishes. Changes are paused. | When the job ends. Commands that write answer `Busy` meanwhile |
| `LibraryInfo.recovered` | Information, `info`, with a close button | Folio rebuilt its index for this library. | Your files and tags are safe. Search may miss some files until the scan finishes. | Closed, or when the scan ends |

### 9.2 Preview failures

The file header stays; the body shows a state block on `color.surface.sunken`: danger tile
`file-x`, "Can't show this file", "Folio couldn't read it. It may be open in another app, or not
downloaded from the cloud yet. Try again, or open it in its own app.", buttons "Try again" (`refresh-cw`)
and "Open with default app". For a file removed meanwhile, `CatalogChanged` closes the preview
instead (IPC §15.3). Since 2026-09-29 the scheme says why a request failed (IPC §11.2, open item
4): for `InUse`, `NotLocal`, `AccessDenied` and `NoThumbnail` the text is the code's message from
`errors` in place of the text above, which stays for the other codes.

### 9.3 Opening files

| Result | Feedback |
|---|---|
| `open_entry` `mode: "editor"` | Information toast: "Opened setup.bat in an editor" / "Folio doesn't run programs or scripts, so it opened this one for editing." |
| `Blocked` | Warning toast: "Folio doesn't open programs" / "To keep you safe, it won't run setup.exe. Show it in File Explorer if you want to open it yourself." Action "Show in File Explorer" |
| `NotFound`, `FileSystem` | Error toast: "Couldn't open ps2.pdf" / the generic message |
| `reveal_entry` fails | Error toast: "Couldn't show ps2.pdf in File Explorer" / the generic message |

### 9.4 Other command failures

A command with no place of its own for an error shows an error toast: the title says what failed
("Couldn't change the tags of ps2.pdf", "Couldn't create the folder", "Couldn't delete ps2.pdf") and
the body is the generic message for the code (`errors`). `Internal`, `FileSystem`, `InvalidArgument`
and `Transport` add "Copy details". A `NotFound` after a stale reference refetches the view and shows
an information toast with the `NotFound` message from `errors` ("This item isn't here anymore. It
may have just been moved, renamed or deleted."). Batch commands (`move_entries`, `delete_entries`,
`set_entry_tags`) use one warning toast for all failed items with "Details" (the result dialog of
section 5).

### 9.5 Failed window commands

The title bar's commands (`window.ts`) report failures to the console only today (coordinator notes,
WP-02). They fail with `Window` (IPC §16) or `Transport`. Each failure now shows an error toast
(`role="alert"`) with "Copy details", replacing an earlier toast for the same command, and still
goes to the log. A command missing from this table uses the `Window` message from `errors` as its
text, under the title "That window action didn't work":

| Command | Title | Text |
|---|---|---|
| Minimize | Couldn't minimize the window | Press Windows+Down to minimize it instead. If window buttons keep failing, restart Folio. |
| Maximize | Couldn't maximize the window | Press Windows+Up to maximize it instead. If window buttons keep failing, restart Folio. |
| Restore | Couldn't restore the window | Press Windows+Down to restore it instead. If window buttons keep failing, restart Folio. |
| Close | Couldn't close Folio | Press Alt+F4 to close it instead. |
| Drag the title bar | Couldn't move the window | Press Windows+Left or Windows+Right to snap it to a side instead. |
| Background: the maximized state, the snap layouts overlay | Window buttons may not work right | Restart Folio to fix this. Snap layouts may not appear on the maximize button until then. |

The background row shows once per session. The failing button keeps its normal look.

### 9.6 Regions that fail to load, and views that stop working

- **A region whose data fails to load** (the tree, a list or grid, the problems list, the activity
  popover's list): the state block (2.5) in the region, danger tile `circle-x`, a title naming what
  is missing ("Couldn't load your courses", "Couldn't load MAT232", "Couldn't load the problems"),
  the text `errors.<code>`, and "Try again" (outline, `refresh-cw`) that refetches; `Internal`,
  `FileSystem`, `InvalidArgument` and `Transport` add "Copy details". Reads keep working during a
  rebuild, so `Busy` does not reach this state ([library state](../../specs/library-state.md)).
- **A view that stops working**: each rail view, dialog and the preview sits in an error boundary
  ([UI architecture](../../specs/ui-architecture.md) §13). It shows the state block in place of the
  view (a dialog keeps its title bar): danger tile `triangle-alert`, "This view stopped working" (the
  preview: "The preview stopped working"), text "Reload it to carry on. If this keeps happening,
  copy the details and send them to the developer.", buttons "Reload this view" (accent) and "Copy
  details". This text replaces the `Internal` message there, because that one asks for a restart
  first.

### 9.7 Error messages in this spec

Where a table above names "the generic message", the UI uses `errors.<code>` from the locale files.
The action-specific wording is in sections 4, 5, 7 and 9.3; first-run wording is in first-run.md §4.4
and §8.

## 10. Jobs: the activity button and popover (29A)

Board: "任务 · 活动面板（29A 工具栏）".

### 10.1 Activity button

- In the toolbar's right group, left of the search button, `space.10` apart; `size.control` (30)
  tall, padding 0 10 0 8, gap 7, 1 px `color.border.control`, `radius.control`, transparent; hover
  `color.surface.panel`; while the popover is open, `color.surface.panel` with a
  `color.border.strong` border (like the active rail button).
- Shown while a job is queued or running, for 10 s after the last one finishes, and while the last
  scans left problems. Otherwise hidden, and the search button keeps its place.

| State | Content (`font.size.small`, tabular figures) |
|---|---|
| One job running, total known | Ring (2.6) and "Scanning 38%", "Checking files 12%", "Adding files 58%", "Rebuilding index 40%" |
| One job running, total unknown | Turning ring and "Scanning…", "Checking files…", "Adding files…", "Rebuilding index…" |
| Several jobs running | Turning ring and "3 tasks" |
| All finished, less than 10 s ago | `circle-check` (`color.feedback.success`) and "Done"; `triangle-alert` (`color.feedback.warning`) and "Done with problems" when a job failed or partly failed |
| Problems, nothing running | `triangle-alert` in `color.feedback.warning` and "7 problems" |
| Running with problems | The running label, then a 6 px `color.feedback.warning` dot |

- A button with `aria-haspopup="dialog"`, `aria-expanded`, and an `aria-label` with the whole status
  ("Activity: scanning the library, 38 percent. 7 problems."). Label changes are not announced;
  results are, through the toasts.
- Narrow window (the 40 px bar): a 28 px icon-only button (the ring or the warning icon) before the
  search button.

### 10.2 Activity popover

- `size.activity-popover` (380) wide, its right edge on the button's, 4 px below the toolbar;
  `color.surface.panel`, 1 px border, `radius.panel`, `shadow.menu`, `z-index.menu`; at most
  `window height − 120 px` tall, the lists scrolling.
- Header "Activity" (`font.size.heading`, 600), padding 12 12 6.
- Running and queued jobs (`list_jobs`, then `JobChanged`), rows padding 8 12, gap 10: a 16 px icon;
  the title (`font.size.label`, 600) with the percentage on the right (`font.size.small`,
  `color.text.tertiary`); the meta line (`font.size.small`, `color.text.secondary`); the bar; the
  current item (`font.size.caption`, `color.text.tertiary`, truncated in the middle); a 24 px cancel
  button (`x`) when `cancellable`, labelled "Cancel scan", "Cancel checking files", "Cancel adding
  files", "Cancel rebuild".
- "Earlier" (`font.size.caption`, 600, `color.text.tertiary`, a 1 px border above): the finished jobs
  `list_jobs` returns (up to 20), newest first, each with its result icon, title, meta, the time on the
  right ("5:12 PM"; before today "Sep 27") and "Details" where section 5 has it.
- Footer (`color.surface.sunken`, 1 px border above, padding 10 12): `triangle-alert` in
  `color.feedback.warning`, "7 problems in the last scan" and an outline button "View problems"
  (28 px); with none, `circle-check` in `color.feedback.success` and "No problems in the last scan";
  before the first scan has finished, no footer.

| Kind | Running title | Meta | Queued meta | Done | Failed | Cancelled |
|---|---|---|---|---|---|---|
| `scan` | Scanning the library | 4,210 of 11,000 files (4,210 files so far) | Waiting | Scanned the library · 12 changes, 3 problems ("No changes") | Scan stopped + message | Scan cancelled |
| `hash` | Checking files | So Folio can spot changes and moves, and search inside files (no count: its progress counts steps, IPC §13) | Starts when the scan finishes | Checked 1,240 files ("Checked files" when it hashed none) (· 20 were busy; Folio tries again later) | Couldn't check files + message | Checking cancelled |
| `import` | Adding 12 files to MAT232 | 7 of 12 files | Waiting for another import to finish | As in section 5 | As in section 5 | As in section 5 |
| `rebuild` | Rebuilding the search index | 8,400 entries so far | Waiting | Rebuilt the search index · 50,210 items | Couldn't rebuild the index + message | Rebuild cancelled |

Result icons: `circle-check` success, `triangle-alert` warning (partial), `circle-x` danger (failed),
`circle-x` in `color.text.tertiary` for cancelled.

- Opens and closes with the button (click, Enter, Space). Focus moves to its first control (a cancel
  button, else "View problems"); Esc or a click outside closes it and returns focus to the button;
  Tab past the last control closes it. `role="dialog"`, `aria-label="Activity"`, non-modal.

## 11. The problems list

Board: "问题列表".

- Opens from "View problems" (and, later, from Library settings → Library). Section 2.8 frame,
  720 × 560; header "Problems" with a count pill (18 px, `color.text.primary` fill); under it, padding
  6 20 14, `font.size.label` `color.text.secondary`: "Folio left these out of your library or couldn't
  finish something in the last scan. Your files are safe: Folio didn't change any of them."
- The list scrolls; groups in the order below, each with a 32 px header (`color.surface.sunken`, 1 px
  borders above and below, padding 0 16, a 14 px icon, the title in 600 and the count in
  `color.text.tertiary`, `font.size.small` `color.text.secondary`) and rows (padding 10 12 10 38, a
  1 px `color.border.guide` line below): the title (the path, `font.size.label` 600, truncated in the
  middle, full in the tooltip), the explanation (`font.size.small`, `color.text.secondary`), and on
  the right a 28 px icon button "Copy path" (`copy`), or an outline button when there is a fix.
- Footer: "From the scan at 5:03 PM. The list updates after every scan." (`font.size.small`,
  `color.text.tertiary`) and "Close".
- Data: `list_problems { page }` in pages of 100 as the list scrolls, grouped on the client; refetched
  on `ProblemsChanged`. Empty: a success state block, "No problems" / "Folio found nothing to fix in
  the last scan."
- Initial focus on the title (`tabindex="-1"`), so the description is read first; Tab moves through
  the row buttons; Esc closes; focus returns to the activity button.

| Kind | Group (icon) | Row title | Explanation | Action |
|---|---|---|---|---|
| `notUnicode` | Names Folio can't read (`type`) | folder/name, unreadable characters as � | Its name has characters Windows stores incorrectly. Rename it in File Explorer; until then Folio leaves it out. | Copy path |
| `invalidName` | Names Windows doesn't allow (`file-warning`) | folder/name | By `rule`: `invalidCharacter` "Has a colon ( : )." naming the characters found ("Has characters Windows doesn't allow: : and ?"); `trailingDotOrSpace` "Ends with a dot or a space."; `reservedName` "Uses a name Windows reserves, like CON or NUL."; `dotName` "Is named . or .., which Windows reserves."; `tooLong` "Its name is longer than Windows allows."; `pathTooLong` "Its full path is longer than Windows allows. Shorten the folders above it."; `empty` "Has no name."; `notNfc` as the next row. Each ends "Rename it on the device that made it; until then Folio leaves it out." | Copy path |
| `notNfc` | Names in a different Unicode form (`type`) | folder/name | Its name uses a Unicode form Windows treats differently, common for names typed on a Mac or iPad. Rename it in File Explorer, even to the same text, and Folio adds it. With `twin`: "Another item here has the same name in the standard form. Rename one of them." | Copy path |
| `caseTwins` | Names that differ only in capitals (`case-sensitive`) | "MAT232/Lecture 3.pdf and MAT232/lecture 3.pdf" (three or more: "3 items like MAT232/Lecture 3.pdf") | iCloud and your other devices can't keep both. Rename one of them. | Copy path |
| `unreadable` | Couldn't read (`lock`) | path | By `failure`: `denied` "Windows denied access. Folio keeps what it already knew about it."; `inUse` "Another app is using it. Folio tries again on the next scan."; `tooLarge` "It's too large for Folio to read."; `damaged` (a Word document whose text Folio can't read) "It may be damaged or protected with a password, so Folio can't search inside it. Folio tries again when the file changes."; `other` "Something went wrong reading it. Folio tries again on the next scan." | Copy path |
| `link` | Shortcuts Folio doesn't follow (`link`) | folder/name | It links to another place, so Folio skips it. | Copy path |
| `special` | Items that aren't files or folders (`file-question-mark`) | folder/name | Folio skips devices, pipes and other special items. | Copy path |
| `invalidIgnoreRule` | Ignore rules Folio can't use (`eye-off`) | "Line 4 of your ignore rules" (`file` null) or "Line 4 of MAT232/project/.gitignore" | It isn't a valid pattern, so Folio skips that line. The other lines still apply. | "Edit ignore rules" (Library settings → Ignore rules), or Copy path for a .gitignore |
| `metadata` | Settings Folio can't read (`file-cog`) | file | `newer` "A newer version of Folio saved it. Update Folio."; `invalid` "It's damaged. Folio uses your other settings and leaves this one alone."; `unreadable` as `unreadable` above | Copy path |
| `orphanedMetadata` | Settings for folders that are gone (`folder-x`) | folder | Folio has tags and settings for this folder, which isn't there anymore. They stay in case it comes back. | Copy path |
| `notRelocated` | Tags that didn't follow a move (`tag`) | "from → to" | By `cause`: `readOnly` "A newer version of Folio made your settings read-only. Update Folio, and the tags follow on the next scan."; `folderTags` "It became a semester or course folder, which can't have tags."; `tooLong` "Its new path is too long for Folio's settings."; `unreadable` "A settings file couldn't be read." | Copy path |

The paths are library-relative as the shell sends them (IPC §17 rule 8); "Copy path" joins them to
the library root. Reattaching or discarding settings, and renaming to NFC, come with a later contract
(IPC §1).

## 12. Keyboard summary

| Element | Tab | Enter, Space | Esc | Arrows and other keys |
|---|---|---|---|---|
| Tree, list, grid | One stop (roving) | Enter previews (app-shell §5) | — | F2, Del, Ctrl+O, Ctrl+Shift+N, Ctrl+Shift+C, Shift+F10, Menu key |
| Context menu | Closes it | Activates | Closes, focus back | Up, Down, Home, End, Right, Left, letters |
| Inline rename | Commits | Enter commits | Cancels | — |
| Import dialog | Cycles inside | Enter adds (primary focused) | Cancels | Arrows in the radio group; Space toggles chips and the checkbox |
| Confirm dialogs | Cycles inside | Activates the focused button (Cancel first) | Cancels | — |
| Activity button | In toolbar order | Opens the popover | Closes it | — |
| Problems dialog | Cycles inside | Activates | Closes | — |
| Toasts | Not in the tab order; every action is also in the Activity popover, the tree or the menus | — | — | — |

Targets are at least 24 × 24 px: toast buttons and cancel buttons 24 px, menu items 30 px, icon
buttons 28 px, checkboxes and radios with 24 px hit areas.

## 13. Motion

| Element | Trigger | Animation | Duration, easing | Reduced motion |
|---|---|---|---|---|
| Drop target (row and panel) | `DropHover` in and out | Fade | `motion.duration.fast` | Instant |
| Menus, popovers | Open, close | Fade | `motion.duration.fast` | Instant |
| Dialogs | Open, close | Fade and rise 4 px; leave with `motion.easing.exit` | `motion.duration.base`, `motion.easing.standard` | Instant |
| Toasts | Arrive, leave | Fade and rise 4 px; fade out | `motion.duration.base` in, `motion.duration.fast` out | Instant |
| Spinners, rings | Waiting | Turning | `motion.duration.spin`, `motion.easing.linear` | Still |
| Indeterminate bars | Total unknown | Sweeping segment | `motion.duration.indeterminate`, `motion.easing.linear` | Still |
| Determinate bars and rings | Progress | Follow the value | `motion.duration.fast` | Instant |

Waiting times that are not motion stay the same with reduced motion, so they are UI constants, not
duration tokens (which reduced motion sets to 0): `TOAST_DISMISS_MS = 6000` (2.4), the submenu's
200 ms (2.7), and `TOOLTIP_DELAY_MS = 500`, the Windows default, for every tooltip on hover
(keyboard focus shows it at once). That last one answers the tooltip delay that
[UI architecture](../../specs/ui-architecture.md) §7.1 expected as a `motion.*` token.

## 14. Narrow window

Below `size.narrow-breakpoint` (app-shell §2):

- The drop target is always the current folder, shown on whichever panel is visible (list or
  preview).
- Dialogs are `min(their width, window width − 16 px)` wide and at most `window height − 49 px` tall
  (below the 40 px bar), bodies scrolling. At 500 × 320 the import dialog's items list shows one row.
- Toasts are `window width − 32 px` wide, centred at the bottom; the activity button is icon-only
  (10.1); the popover is `min(380 px, window width − 16 px)` wide.
- Menus keep their size and flip to stay inside the window.

## 15. Review notes

Critique and accessibility pass on the boards, by hand, with the `design:design-critique`,
`design:accessibility-review` and `design:ux-copy` checklists.

Fixed on the canvas:

- The import dialog explained left-out items only in a tooltip on an icon, which keyboard users
  cannot reach (WCAG 1.4.13); now a visible sentence.
- The name-clash section did not fit a 800 px window next to the other fields; the item list is capped
  at three rows, the radio descriptions are one line each, and the "applies to all" line joined the
  heading.
- "Open with default app" showed Enter as its shortcut, which previews in the tree (app-shell §5);
  removed.
- The Activity popover showed an import waiting for a scan; jobs of different kinds run side by side
  (IPC §13), so the example is now hashing waiting for the scan.
- Seven identical "Copy path" outline buttons crowded the problems list; now 28 px icon buttons with
  labels ("Copy path of CSC207/lab2/notes:v2.md").
- The preview failure claimed to know the file was in use; the file scheme cannot tell (open item 4),
  so the text now names the likely causes.
- "Add here" covered the count on course rows; while a row is the drop target it replaces the count and
  tag dots.

Checked and passing: the new token pairs (tokens README contrast table: danger, warning and success
text on every surface and on their soft backgrounds, the danger button, the progress fill on its
track, the drop outline on the wash and on the drop row); menu keyboard focus has a 2 px ring (the
hover tint is only 1.03:1); radios and the checkbox are 3.33:1 or more on the warning fill; toasts
never take focus and every toast action exists elsewhere (WCAG 2.1.1, 2.2.1).

Accepted limitations:

- The drag ghost is Windows'; Folio cannot label the target in it.
- Tag dots in the Tags submenu are colour only, with the tag name as the label (app-shell 8A).

## 16. Open items

Contract and lane follow-ups; none blocks the M1 UI lanes.

1. **Folders in `ImportSource.names`** (`feat/core-import`): the names do not say which are folders,
   which the item list needs for its icons and "Folder". Suggested: `names: { name: string; folder:
   boolean }[]`, through a small contract fix lane (roadmap §4 rule 2). Settled 2026-09-29 as
   `names: { name: string; kind: "file" | "folder" }[]` (IPC §12).
2. **`ImportResult` counts**: the toasts assume `imported` includes `replaced` and `renamed`; the import
   lane confirms or the wording changes.
3. **Recycle Bin not available**: M1 maps `RecycleFailure::Unrecyclable` to `FileSystem`. A code of its
   own would let the UI explain it and, later, offer "Delete permanently" as its own confirmed action
   (Windows adapter §4). Settled 2026-09-29: `NotRecyclable` (IPC §9.2, §16).
4. **Why a preview failed**: the `folio-file` scheme answers 404 for every failure. Telling "in use"
   and "not downloaded" apart would allow specific copy. Settled 2026-09-29: the `X-Folio-Error`
   header names the code, with `NotLocal` and `NoThumbnail` new (IPC §11.2; section 9.2).
5. **Retrying the library at start-up**: first-run.md §12 item 1. Settled 2026-09-29 (IPC §6).
6. **Loose files**: files directly in a semester folder or at the library root are in no course.
   Suggestion for `feat/ui-library-view`: list a semester's loose files after its courses as file rows
   at depth 0, under a separator; files at the root appear only in search and the quick views.
7. **Scans that cannot be cancelled**: the cancel button follows `Job.cancellable`. The design of
   `feat/core-library-state` ([library state](../../specs/library-state.md)) checks cancellation
   between scanned entries, so scans should arrive cancellable; the button needs no change if not.
8. **The course colour rule for `color: null`** (first-run.md §1) also applies to the tree, grid
   headers and Settings → Courses.
