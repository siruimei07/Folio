# Workspace and history — design handoff

Build spec for M2's screens: the Changes view (changes list, check boxes, commit box with its AI
message states, the "Not synced" card), the History view (timeline, file cards, one file's
history), the diff view in every state, restoring a version, editing a message and undoing a
commit, the first commit, all of them at the wide and narrow window sizes; and the three Library
follow-ups the M1 gate left (docs/specs/m1-acceptance.md §1).

- Status: ready to build. Decisions 30–35 (2026-10-03) and 36–37 (2026-10-04) are Sirui's; the rest
  of section 1 are design defaults. Lane `design/design-m2-details`, 2026-10-03, revised 2026-10-04
  after a second review (section 17).
- Lanes: `feat/ui-diff-viewer` (section 6), `feat/ui-changes-view` (sections 3–5, 10, the Changes
  half of 2 and 11), `feat/ui-history-view` (sections 7–9, the History half of 2 and 11, and the
  dialog look of 8.5). Section 12 (Library follow-ups) has no lane yet: open item 1.
- Source of truth for looks: the Cowork Design canvas "Folio 设计基础"
  (<https://claude.ai/artifact/F1eGkQ7kuFr3HYayxLtD2K>, Sirui's private artifact), rows 6–10 ("M2 ·
  …"), boards named in each section as `m2-NN`. They share the window component `M2Window` and the
  parts `ChangesList`, `CommitLane`, `HistoryPanel` and `DiffPane` (row 10, right), which are not
  screens of their own. The boards draw M2: the rail shows Library, Changes and History; the
  toolbar's sync area stays empty until M3; Office files still preview as "Open with default app"
  (Office previews are M4). Tokens: [`design/tokens/`](../../../design/tokens/README.md) (round 10
  adds the diff emphasis colours and the sizes of this spec). Where a value has a token the spec
  names it; component-internal measurements without one are in pixels and become `size.*` tokens
  when built (app-shell §0 rule). Where the canvas and this spec differ, the spec wins: the canvas
  still draws disabled buttons at 50 % opacity, check boxes in the accent colour and the link "Use
  template instead" (section 17). The Design System artifact "Folio Design System" draws the M2
  components with the shared looks.
- Inputs: [brief](../../product/brief.md) §4, §5.4–§5.7, §6.2, §9;
  [versioning](../../specs/versioning.md) (the data; its §17 is the contract outline this spec maps
  to, section 15); [ADR-0003](../../adr/ADR-0003-versioning-and-sync.md); [app shell](app-shell.md)
  §2–§7, §10, §11; [library actions](library-actions.md) §2 (shared feedback components), §6,
  §8–§10, §12–§14; [UI architecture](../../specs/ui-architecture.md) §6–§8, §12, §13; [M1
  acceptance](../../specs/m1-acceptance.md) §1 and §4 (loose ends).
- Language: English source copy (brief §3). Namespaces: `changes` (list, commit box, Not synced,
  first commit), `history` (timeline, one file's history, restore, edit message, undo), `diff` (the
  diff component), `library` (section 12), `shell` (activity rows of the commit job); generic
  messages stay in `errors`. Straight apostrophes in the locale files; a quoted name or message uses
  “ ”. The boards may show ’.
- Skills: `design:design-system` (round 10 tokens), `design:design-critique`,
  `design:accessibility-review` and `design:ux-copy` on the rendered boards (section 17), then
  `design:design-handoff`.

## 1. Decisions

| # | Decision | Chosen |
|---|---|---|
| 30 | Changes in a narrow window | B: the commit bar is pinned to the bottom; the list takes the rest (board `m2-11`) |
| 31 | "Not synced" before cloud sync exists (M2) | A: the card lists the newest three commits with Edit message and Undo commit, and "N more in History" (`m2-01`) |
| 32 | Where history starts | A: Folio records a first commit by itself ("Start history"); the workspace starts empty (versioning §7.7, Sirui's decision 6 there) |
| 33 | Tag filter with many tags (M1 gate note) | B: at most two rows of chips; the rest behind a "+N" chip with a menu (`m2-40`) |
| 34 | What the quick views count (M1 gate note) | A: "Recently added" and "Untagged" follow the current semester, like the tree and the panel's count (`m2-41`) |
| 35 | Folders in a course or folder grid (M1 gate note) | A: folders are 48 px cards in a "Folders" group above the file tiles (`m2-42`) |
| 36 | The shortcut on the commit button | C: "Ctrl+Enter" keeps its 80 % opacity: 4.12:1 on the light accent fill, an accepted exception to the 4.5:1 floor (section 17) |
| 37 | The link while a commit waits for DeepSeek | A: "Use template", as everywhere else, so the status and the link fit the 320 px lane (4.2) |
| — | Tag and settings changes | Listed without a check box in their own "Tags and settings" group at the end of the list (versioning §6.4, decision 4 there) |
| — | Selecting a change | Selection follows the keyboard focus; the diff loads at once and shows its skeleton only after 150 ms |
| — | Changes inside a line | Changed words (characters for CJK text) get the emphasis background and a 1 px underline, so they show without colour and in Windows' contrast themes |
| — | Moving between changes | F7 and Shift+F7, plus two buttons in the diff's summary strip; "Change 2 of 5" |
| — | Empty fields and AI on | Commit waits for DeepSeek (at most 30 s, versioning §8.2) and offers "Use template" (37); any failure commits with the template and says so |
| — | Undo commit | Only the newest commit, never the first (versioning §8.4); no confirmation, the toast and History say what happened |
| — | Restore | Always asks first; the dialog says where the version goes and whether the current file goes to the Recycle Bin |
| — | One file's history | The History view filtered to that file, with a removable filter chip in the header; not a separate dialog |
| — | Dialog placement (M1 loose end) | Dialogs anchor their top edge: form dialogs 96 px, confirmations 220 px from the window's top, pulled up in short windows (8.5) |
| — | Pending buttons (M1 loose end) | The shared `PendingButton` with React Aria's `isPending`: the shared disabled look, a 14 px spinner and the pending label; the import dialog's own rule moves into the shared Button (8.5) |

## 2. Window and layout

### 2.1 Wide (window ≥ `size.narrow-breakpoint`, 760 px)

Boards `m2-01` (Changes), `m2-20` (History). The title bar, toolbar, rail and panel rules are
app-shell §2–§4.

| View | Columns, left to right |
|---|---|
| Changes | Changes list `size.changes-panel` (290) · commit lane `size.commit-lane` (320) · diff (flex) |
| History | History panel `size.history-panel` (440, draggable 360–640, app-shell §7) · resize handle · diff (flex) |

- Panels are `space.panel-gap` (8) apart and from the window's right and bottom edges; no gap above
  them.
- The commit lane is the dotted lane of app-shell §6: `color.surface.app` with the 14 px dot grid
  (`color.pattern.dots`), 1 px `color.border.default`, `radius.panel`, padding 12, gap 10; its cards
  are panels.
- Toolbar in M2: the left (sync) area stays empty until M3; the semester button stays centred; the
  activity button (library-actions §10) shows commit jobs (section 4.4) and the first commit
  (section 10).
- Rail: Library, Changes (`Ctrl+2`), History (`Ctrl+3`). The Changes badge (app-shell §4) counts
  the workspace's items plus its tag and settings changes, formatted "1"…"999", then "999+"; hidden
  at zero and while the first commit runs. Its accessible name is "Changes, 10 changes".

### 2.2 Narrow (window < 760 px)

Boards `m2-11`–`m2-17` (680 × 720 and the 500 × 320 minimum). The 40 px bar and the 48 px rail are
app-shell §2; panels start 6 px below the bar.

- **Changes (30B):** the changes list takes the full width; under it, `space.panel-gap` apart, the
  commit bar (section 4.7) is pinned to the bottom edge. The "Not synced" card is not shown; its
  commits and their actions are in History.
- **Opening a change or a version:** the diff covers the list (app-shell 16A) with "Back" first in
  its header ("Back to changes" / "Back to history" as the accessible name). Esc and Alt+Left also go
  back. The list keeps its scroll position and selection.
- **History:** the panel takes the full width; the resize handle is hidden.
- **Diff header below 600 px of pane width:** the "Changes | This version" toggle and "Restore"
  move into the "More" menu (as "Show this version" / "Show the changes", and "Restore…").
- **500 × 320:** the commit bar keeps one row of 32 px controls plus the commit button; the list shows
  about three rows and scrolls.

## 3. The changes list

Boards `m2-01`, `m2-07` (states and special rows), component `ChangesList`.

### 3.1 Header

`size.panel-header` (44), padding 0 8 0 6, gap 6:

- Select-all check box (15 px box in a 24 px hit area, library-actions §4): on when every
  includable item is included, mixed when some are, off when none. Items that cannot be committed
  yet (3.4) are not counted. Accessible name "Include all changes"; disabled (and 55 % opacity) while
  there is nothing to include or a commit runs.
- "Changes" (`font.size.heading`, 600) and the count pill (app-shell §10): items plus tag and
  settings changes, tabular figures with thousands separators ("50,000"); "…" while loading, "–"
  while unknown (error, first commit).
- List / grouped toggle (segmented, app-shell §6): "Flat list" (default, 21A) and "Group by course".
  Remembered per machine in UI preferences.

### 3.2 Rows

`size.row` (32), padding 0 10 0 6, gap 6, 1 px `color.border.guide` below:

| Part | Spec |
|---|---|
| Check box | The shared `Checkbox` (library-actions §12): a `size.checkbox` (15 px) box in a `size.target-min` (24 px) hit area. On: `color.toggle.on` fill with a 12 px `check` in `color.text.on-button-accent`; off: a 1 px `color.toggle.off` border (3.19:1 on the selected row) |
| Icon | 16 px file-type icon (14B); `folder-open` for a moved folder, `folder` for a deleted one, in `color.text.secondary` |
| Path | Course label (27B: "MAT232/") and the folders in `color.text.tertiary`, then the name (600). The label stays whole, the folders shrink first, the name last (app-shell §6). In grouped mode the course label is left out |
| After the name | Optional, in this order: a "Tags" tag (metadata rows, 3.3); a count in `font.size.caption` `color.text.tertiary` ("4 files" for a folder item, "Empty folder", "2 changes" for a bound item); 14 px marks with tooltips (3.4) |
| Status | Change status icon (20A) at the right; deleted files and folders are struck through |

- Hover `color.surface.hover`; selected `color.surface.selected` plus the selection indicator (the
  shared `SelectionIndicator`, 8.6).
- Item kinds and how they read (versioning §6.3): file added, deleted, modified, moved (Renamed
  status; the diff's banner names the old path), folder moved (Renamed status, "N files"), folder
  deleted (Deleted, "N files"), empty folder added (Added, "Empty folder").
- A truncated row shows its full path in the shared row tooltip; the accessible name always has it.

### 3.3 Tag and settings changes

Tag and settings changes have no check box: every commit records them (versioning §6.4).

- A file or folder that has an item and also changed tags shows a 14 px `tag` mark after its name
  ("Its tags changed too"); the diff shows the tag change under the content diff (6.8).
- Other tag and settings changes are rows of their own in a group at the end of the list: a 28 px
  header on `color.surface.sunken` with "Tags and settings" (`font.size.small`, 600,
  `color.text.secondary`) and on the right an `info` icon with "Always in the commit"
  (`color.text.tertiary`) and the tooltip "Tag and settings changes go into every commit. A change
  that belongs to a file you leave out waits for that file."
- Rows: the check box column stays empty (alignment); icon `tag` for a file's or folder's tags (path
  as in 3.2, then a "Tags" tag: 18 px, 1 px border, `radius.row` 4 px, 11 px `color.text.secondary`),
  `settings` for course or semester settings ("CSC236 course settings", "Fall 2026 semester
  settings"), `tags` for tag definitions ("Tag definitions"), `settings` for the library's settings
  ("Library settings"), `file-cog` for the ignore rules ("Ignore rules"). Status: Modified, Added for
  a new tag, Deleted for a removed one.
- These rows can be selected and show their diff (6.8); Space does nothing on them.

### 3.4 Readiness and bound items

From `WorkspaceItem.readiness` (versioning §6.2):

| Readiness | Row | Check box |
|---|---|---|
| Hashing | Normal; the commit hashes it | Normal |
| Not local (a cloud placeholder) | Name in `color.text.secondary`, a 14 px `cloud-off` mark: "Not downloaded yet. Folio can commit it once the file is on this computer." | Off and disabled (45 % opacity) |
| Unreadable | Name in `color.text.secondary`, a 14 px `lock` mark in `color.feedback.warning`: "Folio couldn't read it. Close it in other apps, then try again." | Off and disabled |

When the readiness changes, an item that was blocked becomes includable and stays off until the user
checks it. A **bound item** (changes that can only be committed together, versioning §6.3: a file
replaced by a moved file, a swap of two names, a folder deleted after a file was moved out of it, a
change of the versioning rules with a held-back file it now stores) is one row with the status of
its main change and the number of its changes ("2 changes"); its diff lists every part (6.8).

### 3.5 Grouped by course

Course headers (`m2-07`, bottom left): 32 px, `color.surface.sunken`, check box (on, mixed, off for
the course's items), 20 px badge, code (600), name (`color.text.secondary`), count on the right.
Rows then show only the folders below the course. Files outside courses group under their
semester's name, or "Library" at the root. The "Tags and settings" group stays last.

### 3.6 Selection, inclusion and keyboard

The list is a `VirtualList` (UI architecture §7.2) with `role="listbox"`: `aria-selected` is the
change shown in the diff, `aria-checked` whether it is included (an `option` may carry both); the
visual check box is not a separate tab stop.

| Key | Does |
|---|---|
| Up, Down, Home, End, Page Up, Page Down | Move the focus; the selection and the diff follow |
| Space | Include or leave out the focused item (not on metadata rows or blocked items) |
| Ctrl+A | Includes every includable item; again: leaves them all out |
| Enter | Moves the focus into the diff (narrow: opens it over the list) |
| Shift+F10, Menu key | The row's context menu |
| Type-ahead | By file name (UI architecture §7.2) |
| Ctrl+Enter | Commit, from anywhere in the Changes view (UI architecture §6.4) |

- A click on the check box toggles it without changing the selection; a click elsewhere on the row
  selects it. Shift+click on check boxes toggles the range to the same state.
- Inclusion is kept per item key (versioning §6.3) while the item exists: a file saved again keeps
  its check box. New items arrive included (brief §5.4.2). A selection that no longer exists moves to
  the next row.

### 3.7 Context menu

Menu component of library-actions §2.7 (`m2-07`, top right):

| Row | Items |
|---|---|
| File (added, modified, moved) | Open with default app · Show in File Explorer · View history of this file · ─ · Leave out of this commit / Include in this commit (Space) · ─ · Copy path (Ctrl+Shift+C) |
| Deleted file or folder | View history of this file (folder: no) · ─ · Leave out / Include · ─ · Copy path |
| Folder moved or added | Open in File Explorer · ─ · Leave out / Include · ─ · Copy path |
| Tag or settings row | View history of this file (for a file's tags) · Copy path (for a file) |
| Several rows | — (no multi-selection in M2; the check boxes are the multi-selection) |

"View history of this file" is disabled for an added file that no commit holds yet.

### 3.8 States

Each state replaces the list body (library-actions §2.5 state block, in the list's coordinates:
96 px from the top, padding 0 24) or adds a panel banner (library-actions §2.3) under the header.

| State | Shown | Commit box |
|---|---|---|
| Loading (no data after 150 ms) | Skeleton rows | Enabled once loaded |
| Ready | Rows | 4.2 |
| Empty | Success tile `circle-check`, "No changes", "Everything is committed. When you add, edit, move or delete files, the changes show up here." The diff shows the desk illustration with "Nothing has changed since your last commit" / "Changes to the files in your library show up in the list." | "Nothing to commit", disabled |
| Load failed | Danger tile `circle-x`, "Couldn't load your changes", `errors.<code>`, "Try again" (plus "Copy details" for `Internal`, `FileSystem`, `InvalidArgument`, `Transport`) | Disabled |
| First scan not finished | Information banner: "Still checking your library." "More changes may show up." | Normal |
| Index rebuilding (`Busy`) | Information banner: "Rebuilding the search index." "You can commit when it's done." | Disabled, with the line of 4.2 |
| History read-only (`historyState: readOnly`) | Warning banner, `lock`: "History is read-only." "A newer version of Folio changed it. Update Folio to commit." | Disabled |
| History damaged (`historyState: damaged`) | Danger banner: "Folio can't read this library's history." "Your files are fine, but you can't commit until it's fixed." | Disabled |
| First commit running or failed | Section 10 | Hidden |
| Committing | Rows and the header check box at 55 % opacity, inert; the selection still moves and the diff still shows | 4.4 |

### 3.9 Long lists

The list pages (`list_workspace_items`, versioning §17.1) and virtualises: 50,000 rows scroll at
60 fps (UI architecture §8). The header and the commit box use the workspace summary's totals,
never a count of loaded rows. Select-all and Ctrl+A send "every item except" selections
(versioning §7.1), so they never load every page.

## 4. The commit box

Boards `m2-01`, `m2-04` (every state), `m2-05`, `m2-06`; component `CommitLane`.

### 4.1 Layout

A panel card (padding 12, gap 10) at the top of the commit lane:

- A field group with input borders (`color.input.border`, bottom edge `color.input.border-bottom`,
  `radius.control`, `color.input.background`):
  - Summary: `size.composer-summary` (36), padding 0 10, `font.size.body` 600, placeholder "Summary
    (optional)", 1 px `color.border.default` below. At most 256 characters (versioning §17.4).
  - Description: 3 rows (grows to 6, then scrolls), padding 8 10, `font.size.label`, line height
    1.5. Placeholder with AI: "Description (optional). Leave both empty and DeepSeek writes them.";
    without AI: "Description (optional). Leave both empty and Folio writes a short summary." At most
    16,384 characters.
  - Footer, 38 px, 1 px `color.border.guide` above: on the left the status of 4.2; on the right the
    message button (split button, 26 px): "Generate" with `sparkles` when AI is on, "Use template"
    with `layout-template` when it is off, and an options chevron ("Message options": "Write with
    DeepSeek", "Use the template", ─, "AI settings…").
- Optional notes (4.2), then the commit button: 34 px, full width, `color.button.accent`,
  `color.text.on-button-accent`, 600, `font.size.small`: "Commit 9 changes" + "Ctrl+Enter" at 80 %
  opacity. The count is the included items plus the tag and settings changes ("Commit 1 change").

### 4.2 Message states

| State | Fields | Footer left | Message button | Note under the group | Commit button |
|---|---|---|---|---|---|
| Idle | Editable | — | Generate / Use template | — | "Commit 9 changes" |
| Nothing included, but tag or settings changes | Editable | — | Enabled | — | "Commit 2 changes" |
| Nothing included, nothing else | Editable | — | Disabled | — | "Nothing selected", disabled |
| Workspace empty | Editable | — | Disabled | — | "Nothing to commit", disabled |
| Generating (Generate pressed) | Read-only; a 10 px skeleton bar in the summary, three in the description | 14 px spinner, "DeepSeek is writing…" (`role="status"`) | "Stop" (outline, 12 px `square`); Esc does the same | — | Disabled |
| Written by AI | Filled | — | Generate (writes again, replacing the text; Ctrl+Z restores it) | `sparkles` + "Written by DeepSeek. Change anything you like." (`font.size.small`, `color.text.secondary`), until the user edits a field | Enabled |
| Generate failed | Unchanged | — | Generate | Warning note (4.3) | Enabled |
| Commit with both fields empty, AI on | Read-only | Spinner, "DeepSeek is writing…", then the link "Use template" (37) | Hidden | — | Spinner, "Writing the message…", disabled |
| Committing | Read-only | — | Disabled | — | Spinner, "Committing…", disabled |
| Commit failed | Kept | — | Enabled | Danger note above the group (4.5) | Enabled ("Commit 9 changes" tries again) |
| Busy, read-only or damaged history | Editable | — | Enabled | `info` (or `lock`) + the reason, `font.size.small` `color.text.secondary`, under the button: "Folio is rebuilding its search index. You can commit when it's done." | Disabled |

- Disabled buttons use the shared `Button`'s disabled look (`color.surface.sunken`, a
  `color.border.default` border, `color.text.tertiary`; app-shell §10), not focusable by click,
  `aria-disabled`, still in the tab order so their label is announced.
- With AI off (`NotConfigured`), nothing mentions DeepSeek: the placeholder, the button and the
  commit flow use the template.

### 4.3 AI failures

The warning note (library-actions §2.3 block size, tone warning, `font.size.small`; links as toast
actions) appears after Generate fails; the fields are not touched:

| Code (versioning §12.5) | Title | Text | Links |
|---|---|---|---|
| `AiNetwork` | DeepSeek didn't answer | Check your connection and try again. You can still commit: Folio writes a template message. | Try again · Use template |
| `AiTimeout` | DeepSeek took too long | Try again in a moment. You can still commit: Folio writes a template message. | Try again · Use template |
| `AiRejected` | DeepSeek turned down the API key | Check the key in App settings → AI. You can still commit: Folio writes a template message. | AI settings · Use template |
| `AiRateLimited` | DeepSeek is busy right now | Try again in a minute. You can still commit: Folio writes a template message. | Try again · Use template |
| `AiUnavailable` | DeepSeek isn't working right now | Try again later. You can still commit: Folio writes a template message. | Try again · Use template |
| `AiBadResponse` | DeepSeek's answer couldn't be used | Try again, or write the message yourself. | Try again · Use template |
| `AiCredential` | Folio couldn't read the API key | Windows Credential Manager didn't answer. Set the key again in App settings → AI. | AI settings · Use template |

"Use template" fills both fields with the template (4.6). "AI settings" opens App settings on its AI
page. The service's name comes from the AI settings: "DeepSeek" for the default endpoint, "the AI
service" for any other.

When a commit with empty fields falls back, it commits with the template and shows the information
toast "Committed with a template message" / "DeepSeek didn't answer, so the message is “MAT232: add
1 file, update 2 files”. You can edit it until you sync." with "Edit message" (opens 9.1). The same
toast uses the reason of the table ("DeepSeek turned down the API key, so the message is …").

### 4.4 Committing

- Ctrl+Enter or the button: `commit { selection, fingerprint, base, summary, body }`
  (versioning §7.1); with both fields empty the summary is the AI's (after waiting) or the template.
- The commit is a job (kind `commit`, progress in bytes). The activity button shows "Committing 40%"
  (library-actions §10.1 ring); its popover row: title "Committing 9 changes", meta "12.4 of 48.0
  MB", a "Cancel commit" button while the job is cancellable; done "Committed 9 changes" with the
  summary as meta; failed "Couldn't commit" with the message; cancelled "Commit cancelled".
- Small commits finish before anything renders: the button shows "Committing…" only after 150 ms,
  like loading.
- **Success:** the committed rows leave the list; the new commit appears at the top of "Not synced"
  with a `color.accent.soft` background that fades after 2 s (UI constant `FRESH_COMMIT_MS = 2000`);
  the fields clear; the polite live region says "Committed 9 changes: MAT232: add lecture 6, fix
  review notes". No toast. Focus stays on the commit button (now disabled if nothing is left) or
  returns to the list.

### 4.5 Commit errors

The danger note (block banner, `role="alert"`) appears above the field group; selection and message
stay. Title "Couldn't commit"; text by code:

| Code | Text |
|---|---|
| `WorkspaceChanged` | The changes changed while you were committing. Check the list, then commit again. (The list refetches.) |
| `NothingToCommit` | There's nothing to commit any more. Another change may have undone it. |
| `FileChanged` | Midterm review.md kept changing while Folio read it. Save it and close it, then commit again. |
| `NotLocal` | Midterm review.md isn't downloaded yet. Open it so it downloads, then commit again. |
| `InUse` | Another app is using Midterm review.md. Close it there, then commit again. Your message and choices are kept. |
| `AccessDenied` | Windows didn't let Folio read Midterm review.md. |
| `DiskFull` | The disk is full. Free up some space, then commit again. |
| `ReadOnly`, `HistoryReadOnly` | A newer version of Folio changed this library. Update Folio to commit. |
| `HistoryDamaged` | Folio can't read this library's history. Your files are fine. (Plus "Copy details") |
| `Busy` | Folio is rebuilding its search index. Commit again when it's done. (Rare: the commit box is disabled while a rebuild runs, 4.2) |
| `Cancelled` | No note: the commit box returns to idle; the activity popover lists "Commit cancelled" |
| `Internal`, `Transport` | `errors.<code>` and "Copy details" |

### 4.6 The template

The UI writes it from `summarize_selection` (versioning §6.6, §8.1) with strings in `changes`:
one clause per course, by code (or name), verbs in the order add, update, move, delete, tag, joined
by ", " inside a clause and "; " between clauses: "MAT232: add 2 files, update 1 file; CSC207:
delete 1 file". Files outside courses use the semester's name, or "Library". Tag-only: "MAT232: tag
3 files"; settings only: "Update course settings", "Update library settings", "Update tags". After
three courses: "and 2 more". Cut to 256 characters at a clause boundary. The first commit's summary
is "Start history" (section 10).

### 4.7 The narrow commit bar (30B)

Board `m2-11`, `m2-12`: a panel card pinned to the bottom (padding 10, gap 8, full panel width):

- Row 1: the summary field (`size.commit-bar-field`, 32, flex, input styles, 600), the message
  button as a 32 px icon button ("Generate a message", `sparkles` or `layout-template`) and a 32 px
  icon button that opens the description ("Add a description", `chevron-up`; open: "Hide the
  description", `chevron-down`, `aria-expanded`).
- Open: the description (3 rows) appears under the summary; the list above shrinks.
- Row 2: the commit button as in 4.1.
- States and notes are those of 4.2–4.5; notes appear between the rows. At 500 × 320 the description
  opens over the list's lower half rather than squeezing it below two rows.

## 5. "Not synced" (31A)

Board `m2-01` (card under the commit box); M3's look (app-shell §6) with M2's content:

- Header: 24 px sunken tile with `cloud-upload`, "Not synced" (`font.size.heading`, 600) and a count
  pill with the number of commits not synced (in M2: every commit).
- Text (`font.size.small`, `color.text.tertiary`, padding-left 44): "Cloud sync comes in a later
  version. Until then, commits stay on this computer."
- The lane: "Your commit goes here" pill, then the newest three commits: summary (13 px, one line,
  truncated) and "b7c1e20 · Today 5:05 PM" (`font.size.caption`, `color.text.tertiary`, tabular).
- Hovering or focusing a commit shows 26 px outline icon buttons: "Edit message" (`pencil`, every
  listed commit) and "Undo commit" (`undo-2`, the newest commit only, and never the first commit).
  They are also in the commit's context menu.
- Footer: a link button "9 more in History" with `chevron-right` (opens History; hidden when there
  are three or fewer). No "Sync now" in M2.
- Empty (no commits yet, which the first commit makes rare): the card shows only its text.
- M3 replaces the text with "Only on this computer so far. Sync to push them to iCloud.", lists only
  unsynced commits, and adds "Sync now".

Data: the newest three commits and the count come from `list_history` (filter: commits) until M3's
sync state exists; see open item 2 (versioning §9.1 assumed an empty list).

## 6. The diff view

The shared component of `feat/ui-diff-viewer`, in the Changes and History views. Boards `m2-01`,
`m2-03`, `m2-20`, `m2-30`–`m2-37`; component `DiffPane`.

### 6.1 Header

`size.panel-header` (44), `color.surface.panel`, padding 0 8 0 12, gap 8:

- Narrow: "Back" (28 px, `arrow-left`, `font.size.small` `color.text.secondary`).
- File-type icon (16), the path in `color.text.tertiary` and the name (600) as one heading
  (`h2`, truncated from the left of the folders, tooltip with the full path); for a tag row the
  name is followed by " · Tags" in `color.text.secondary`.
- Change status icon (20A).
- Right: the segmented "Changes | This version" (only when a version can be shown, 6.7), "Restore"
  (History only, 28 px outline button with `rotate-ccw`, section 8), "More" (28 px, `ellipsis`):
  Open with default app · Show in File Explorer · View history of this file · Copy path (and, in
  narrow panes, the toggle and Restore…).

### 6.2 Summary strip

`size.diff-summary` (32), `color.surface.sunken`, 1 px `color.border.default` below, padding 0 6 0
12, `font.size.caption` `color.text.tertiary`, tabular figures:

- What is compared and the counts, truncated with a tooltip:
  - Changes: "Compared with the last commit (Oct 13, 9:30 PM) · 4 lines added, 3 removed".
  - History: "This version: Oct 13, 9:30 PM · compared with Oct 10, 3:10 PM · 4 lines added, 3
    removed"; a file's first version: "First version: Oct 10, 3:10 PM · 24 lines".
  - Word: "… · 2 paragraphs added, 1 removed".
- Right: "Change 2 of 5" (`color.text.secondary`, `aria-live="polite"`) and two 24 px icon buttons,
  "Previous change (Shift+F7)" (`chevron-up`) and "Next change (F7)" (`chevron-down`), disabled at the
  ends. A "change" is a run of consecutive added and removed lines.

### 6.3 Lines

The body is a focusable region (`role="region"`, `aria-label="Changes in Midterm review.md"`,
`tabindex="0"`) on `color.surface.panel`, padding 4 0 8:

| Column | Width | Spec |
|---|---|---|
| Old line number | `size.diff-line-number` (40) | Right-aligned, padding-right 6, `font.family.mono` 12 px, `color.text.tertiary`, tabular |
| New line number | 40 | The same, padding-right 8 |
| Sign | `size.diff-sign` (16) | "+" in `color.diff.added-text`, "−" in `color.diff.removed-text`; `aria-hidden`, with a visually hidden "Added line" / "Removed line" before the text |
| Text | flex | `font.family.mono`, `font.size.diff` (12.5), `font.line-height.diff` (22 px), `color.text.primary`, padding-right 16, wraps (`white-space: pre-wrap`, `overflow-wrap: anywhere`) |

- Added lines `color.diff.added-background`; removed lines `color.diff.removed-background`; unchanged
  lines transparent.
- The **current change** (the one F7 last reached, or the first) has a 3 px `color.accent.default`
  bar at the left edge of its lines (4.79:1 or more on the line colours).
- Long lines wrap instead of scrolling sideways: notes, Markdown and Chinese paragraphs are often
  one long line, and the narrow window has no room. The virtualiser measures wrapped rows (TanStack
  Virtual `measureElement`), unlike the fixed-height lists.

### 6.4 Changes inside a line

From the diff's inline ranges (versioning §10.2: words, or characters for CJK text): the changed
part of an added line gets `color.diff.added-emphasis`, of a removed line
`color.diff.removed-emphasis`, `radius.row-inset`-free (2 px corners), plus a 1 px underline in the
line's sign colour, 3 px below the baseline. Ranges are trimmed of the spaces around them. Screen
readers read the whole line; the emphasis is for sighted comparison, and the underline keeps it
visible in Windows' contrast themes (forced colours drop backgrounds).

### 6.5 Unchanged lines, pages, long diffs

- Each change shows 3 lines of context (versioning §10.2). The lines between are a fold row:
  `size.diff-fold` (28), `color.surface.sunken`, 1 px `color.border.guide` above and below, margin 2
  0; a button with `unfold-vertical` 14 px and "Show 7 unchanged lines" (`font.size.small`
  `color.text.secondary`), which expands that run in place. Word: "Show 2 unchanged paragraphs".
- Pages of 500 lines (versioning §17.4) load as the region scrolls; F7 past the loaded pages loads
  the next. While a page loads, its rows are skeleton lines.
- Approximate diffs (over the one-second deadline): a note above the first change, information tone
  as the event banner of 6.8: "This file is too big to compare word by word, so only whole lines are
  marked."

### 6.6 Word text

As text, with these differences (`m2-03`): the text column uses `font.family.sans` at
`font.size.label` (13) and 22 px lines; the numbers count paragraphs; after the last line a note in
`font.size.small` `color.text.tertiary` with `info`: "Folio compares the text of Word files.
Changes to formatting, images or comments don't show here."

### 6.7 This version

"This version" shows the file through the preview (ui-architecture §10): the current file in
Changes, the version's bytes through the `folio-file` version route in History (versioning §9.4).
It is offered for every file the preview can show at that version; for event-only files in History
it is not offered (only the current file exists).

### 6.8 States

| Case | Header | Strip | Body |
|---|---|---|---|
| Loading (after 150 ms) | Real (known from the row) | Skeleton bar | 14 skeleton lines (two number stubs and a bar), `aria-busy` |
| Load failed | Real | — | State block on `color.surface.sunken`, danger tile `circle-x`: "Couldn't show what changed", `errors.<code>` (e.g. "Another app is using this file. Close it there, then try again."), "Try again" and "Open with default app" |
| Text, Word | Real | Counts, navigation | 6.3–6.6 |
| Added or deleted text file | Real | "… · 24 lines added" | Every line added (or removed) |
| Event only, added | No toggle | — | Banner (1 below), then the file's preview: "Added. Folio records changes to slides but keeps only the latest copy." |
| Event only, modified | No toggle | — | "Modified: 184 KB → 212 KB. Folio keeps only the latest copy of spreadsheets, so there's no older version to compare." + preview |
| Deleted (any file) | — | — | "Deleted: committing removes it from the library. The file is in the Recycle Bin." + a centred block: `trash-2` tile, "Old slides L2.pdf is in the Recycle Bin", "Restore it from the Recycle Bin before you commit if you still need it. After the commit, History keeps the record that it was deleted." |
| Moved or renamed | As the content | — | "Renamed from Exercise 14.3.jpg." / "Moved from MAT232/Problem sets/." before the diff or preview |
| Text over `text_max_size` (10 MiB) | No toggle | — | "Modified: 14.2 MB → 14.6 MB. Text files over 10 MB keep only the latest copy, so there's no older version to compare." + block "No preview for files this large" / "Open it in its own app to read it." |
| Too big to diff (over the limits) | Real | Counts | Neutral block: "This change is too big to show here" / "It changes 24,382 lines. Open the file in its own app to read it, or look at this version." + "Open with default app", "Show this version" |
| Only formatting (Word) | Real | "… · No text changed" | Information block: "No text changed" / "Folio compares the text of Word files, so changes to formatting, images or comments don't show here." + "Show this version" |
| Only line endings | Real | "… · Only the line endings changed" | Information block: "Only the line endings changed" / "The text is the same. The file now ends its lines with LF instead of CRLF, which some editors do when they save." |
| Binary content in a text file | No toggle | — | Information block: "This file isn't text" / "Folio found binary data in it, so it can't compare it line by line." |
| Not local | No toggle | — | Neutral block, `cloud-off`: "Not downloaded yet" / "This file is only in your cloud folder so far. Folio compares it once it's on this computer. Opening it downloads it." + "Open with default app" |
| Unreadable | Real | — | As "Load failed" with `errors.<code>` |
| Pruned (M3: old Word versions thinned) | Real | — | Neutral block: "Folio no longer keeps this version" / "Old Word versions are thinned out over time. The record of the change stays." |
| Tags of a file | " · Tags", no toggle | — | Padding 20 24, `font.size.label`: "Only the tags changed. The file itself is the same as in the last commit." then a 76 px label column: "Added" with chips on `color.diff.added-background` and a "+"; "Removed" with chips on `color.diff.removed-background`, "−" and struck-through name; "Now" with the current chips (13A) |
| Content and tags | As the content | — | The content diff, then the tags block under it |
| Course or semester settings | "CSC236 course settings" | — | A two-column list "Colour: Violet → Blue", "Code: CSC236 → CSC 236", "Badge: CSC → ToC" (old in `color.text.tertiary` struck through, new in `color.text.primary`) |
| Tag definitions, library settings | As settings | — | The same list ("Tag “Exams”: colour Red → Pink", "New tag: Labs") |
| Ignore rules | "Ignore rules" | Counts | A text diff (6.3) |
| Bound item | The main path | — | One banner per part ("Renamed from Exercise 14.3.jpg.", "Replaces a file that was deleted.", "hw2.pdf was moved out of this folder first.", "Library settings now keep this file's versions, so it goes into the same commit.") then the content |
| History: event-only file | No toggle | — | "This version added the file. Folio keeps only the latest copy of images, so the preview shows the file as it is now." (+ the current preview; if the file is gone: "It has been deleted since, so there's nothing to show.") |

The event banner: `color.surface.sunken`, 1 px `color.border.default` below, padding 8 12, gap 8,
the 16 px change status icon (`aria-hidden`; the sentence says it), text `font.size.small`
`color.text.primary`, `role="note"`.

### 6.9 Keyboard and screen readers

- Tab order in the diff: header buttons, the toggle, Restore, More, the strip's buttons, the region,
  then fold buttons in the region in order.
- F7 / Shift+F7 move to the next / previous change from anywhere in the view (also from the list),
  scroll it to the top third, put the bar on it and announce "Change 2 of 5, lines 12 to 14" in the
  polite region. In the region, Up/Down scroll by a line, Page Up/Down by a page, Home/End to the
  ends.
- Selecting a row in the list does not move the focus; Enter does (3.6).
- The skeleton is `aria-busy`; a failed load announces its title through the error state block.

## 7. History

Boards `m2-20` (wide), `m2-21` (dark), `m2-22` (one file), `m2-27` (states), `m2-14` (narrow);
component `HistoryPanel`. The layout of app-shell §7 (10A, 19C) stays; this section adds M2's
content and states.

### 7.1 Header

"History" (`h2`, `font.size.heading` 600); in one file's history, a filter chip after it (7.4);
right: the type filter, an outline button (28 px, `font.size.caption`) with `filter`, its label and
`chevron-down`: "All types", or "2 types" with `color.surface.selected` fill and `color.accent.default`
border while filtering. Its menu (library-actions §2.7, checkable): Commits · Message edits · Undone
commits · Restores · ─ · Show all types. M3 adds Syncs, Changes from iCloud, Resolved conflicts. The
choice is remembered per machine.

### 7.2 Entries

| Kind | Icon (16 px Lucide) | Title |
|---|---|---|
| Commit | `circle-check` | Its summary; the body under it (`font.size.small`, `color.text.secondary`, line breaks kept, at most three lines with an ellipsis; the full body in the tooltip and accessible description) |
| First commit | `flag` | "Start history"; under it "4,210 files were in your library when Folio started keeping history." (`font.size.small` `color.text.secondary`), no file card; one file's history: "Midterm review.md wasn't in the library yet." when the file came later |
| Edit message (`reword`) | `pencil` | "Edited commit message", with the new short id |
| Undo commit (`uncommit`) | `undo-2` | "Undid commit “ECO101: add demand data”", with that commit's short id |
| Restore | `rotate-ccw` | "Restored Midterm review.md to the version from Oct 10", with a file card of that file |
| M3 | `cloud-upload`, `cloud-download`, `git-merge` | Sync, import and conflict entries (app-shell §7) |

- Each entry: time column (`size.history-time-column`, 12-hour, 11 px tertiary), icon column with
  the joining line, content: title (wraps), "• b7c1e20" (12 px tertiary, commits and operations that
  name one), the source (`laptop` + device name) and, in M3, the "Not synced" pill. In M2 the pill is
  not shown: every commit is unsynced until a cloud remote exists, and the pill would be on every
  row.
- "Current version" (`m2-22`): a neutral pill (18 px, 1 px `color.border.default`,
  `color.surface.sunken`, 11 px 600 `color.text.secondary`) on the entry whose version of the file
  is the file's current content (one file's history only).
- File cards as app-shell §7: up to four rows (32 px), "Show all 6 files" below more (loads
  `list_commit_changes` pages); a selected row has the selected background and indicator; deleted
  files are struck through; moved files show their new path and, in the tooltip, the old one.
- Day headers stay: "Today, Oct 14", "Yesterday, Oct 13", "Oct 10" (with the year when it isn't
  this year). Entries come in `list_history`'s order and are grouped by their effective time
  (versioning §5.4, §9.1), so a device with a wrong clock never breaks the order; the time shown is
  the commit's own, with its date ("Oct 12, 4:31 PM") when that falls on another day than its
  group.
- A restore entry is highlighted with `color.accent.soft` for `FRESH_COMMIT_MS` after it appears
  (`m2-26`).

### 7.3 Actions on entries

- Hovering or focusing a commit entry shows, at the right of its title, 26 px outline icon buttons:
  "Edit message" (commits and imports, the first commit included; never a prune commit, and in M3
  never a synced commit, versioning §8.3) and "Undo commit" (the newest commit only, never the first
  commit, and in M3 only an unsynced one, versioning §8.4).
- The entry's context menu (Shift+F10, Menu key, right-click): Edit message · Undo commit · ─ · Copy
  commit ID. Disabled items stay listed with the reason in their tooltip ("Only the newest commit can
  be undone.", "The first commit can't be undone.").
- A file row's context menu: Open with default app (the current file) · Show in File Explorer ·
  View history of this file · Copy path · ─ · Restore this version… (stored versions only).
- History read-only or damaged: the actions are disabled with the reason.

### 7.4 One file's history

Board `m2-22`. Opened from: the Library preview header's "View history of this file" (app-shell §5),
the Library context menus' "View history" (after "Show in File Explorer", library-actions §6), the
Changes and History context menus, and the diff's "More".

- The History view opens (`Ctrl+3`'s view) filtered to the file (`list_file_history`, versioning
  §9.3): the header shows a chip after "History": 26 px, 1 px `color.border.control`,
  `color.surface.sunken`, `radius.chip`, the file's icon, path (tertiary) and name (600), and a 20 px
  remove button "Show the whole history" (`x`). Removing it, or Esc in the timeline, returns to the
  whole history at the scroll position it had.
- Entries are the commits and restores that touched the file, following it through moves; each card
  holds only that file's row (with the path it had then), and "and 2 other files in this commit"
  (`font.size.caption` tertiary) when there were more. The type filter still applies.
- The newest entry that matches the current content has "Current version"; selecting it shows the
  diff with Restore disabled ("This is the version you have now.").
- The oldest entry is where the file was added, or the first commit ("Start history"). A file never
  committed shows the state block "Midterm review.md has no history yet" / "Commit it from Changes
  to start its history." with "Go to Changes".

### 7.5 States

| State | Shown |
|---|---|
| Loading | Skeleton entries (time stub, icon dot, title bar, card outline) after 150 ms |
| Loading earlier entries | A 40 px row at the end: spinner, "Loading earlier entries…" (`role="status"`) |
| The start | After the first commit: "That's the start of your history." (`font.size.small` tertiary, aligned with the content column) |
| No history (`historyState: none` before the first commit) | Section 10 |
| Empty (no entries, e.g. the first commit was undone by a damaged store) | Neutral tile `history`: "No history yet" / "Commit your changes and each commit shows up here, newest first." + "Go to Changes" (accent) |
| Filter matches nothing | Neutral tile `funnel-x`: "Nothing of these types yet" / "No restores or undone commits so far." + "Show all types" |
| Load failed | Danger tile: "Couldn't load the history" / `errors.<code>` + "Try again", "Copy details" |
| Damaged | Danger tile: "Folio can't read this library's history" / "Your files are fine. Copy the details and send them to the developer." + "Copy details" |
| Read-only | Warning banner under the header: "History is read-only." "A newer version of Folio changed it. Update Folio to edit messages or restore versions." |

The diff side shows the desk illustration with "Select a file to see this version and what changed"
until a file row is selected (app-shell §5).

### 7.6 Keyboard and screen readers

- The timeline is a `role="feed"` of `article`s (`aria-labelledby` the title, `aria-describedby` the
  time and source); Page Down / Page Up move between entries (WAI-ARIA feed pattern). Each file card
  is a single-select listbox with roving focus: one tab stop per card, Up/Down inside it, Enter or
  Space shows that version (`aria-selected`). "Show all N files" follows the card.
- A feed owns only `article`s, so the day headers are visual (`aria-hidden="true"`), and each entry's
  description carries its day with the time: "Today, Oct 14, 5:05 PM".
- The hover buttons of 7.3 appear when the entry has focus within, so Tab reaches them; the context
  menu offers the same commands.
- The resize handle stays as app-shell §7 (Left/Right by 16 px, double-click resets).

## 8. Restore

Boards `m2-23`–`m2-26`.

### 8.1 Where

"Restore" in the diff header of a stored text or Word version in History, and "Restore this version…"
in a file row's menu. Not offered for event-only files, pruned versions, `.folio` paths or the
current version.

### 8.2 The confirmation

Dialog frame of library-actions §2.8, `size.dialog-small` (440), placed by 8.5. Title "Restore
Midterm review.md to Oct 13?" (the file's name and the version's date). Body (`font.size.label`):

1. Where it goes, by the planned outcome (open item 3):
   - Replace: "Folio puts the version from Oct 13, 9:30 PM back in MAT232. It shows up in Changes,
     so you can check it before you commit."
   - Deleted since: "Midterm review.md isn't in the library anymore. Folio puts the version from Oct
     13, 9:30 PM back in MAT232. It shows up in Changes, so you can check it before you commit."
   - Name taken by another file: "Another file now has this name, so Folio puts the version from Oct
     13, 9:30 PM beside it as “Midterm review (2).md”. It shows up in Changes, so you can check it
     before you commit."
2. In `color.text.secondary`: "The version you have now stays in History, so nothing is lost."
   When the current file has uncommitted changes, this line is replaced by a warning block: "This
   file has changes you haven't committed" / "Folio moves the file as it is now to the Recycle Bin
   first, so you can still get those changes back."

Footer: "Cancel" (outline) and "Restore version" (accent). Initial focus: "Restore version"; with the
warning block, "Cancel". Esc and the close button cancel.

### 8.3 Doing it

- "Restore version" → `restore_version { commit, path }`; the button turns pending (8.5) with the
  label "Restoring…"; the dialog stays until the answer.
- **Done:** the dialog closes; success toast "Restored Midterm review.md" / "The version from Oct 13
  is back. Check it in Changes, then commit it." with "Show in Changes" (selects that row). History
  gets the restore entry at the top; the Changes badge grows by one. Focus returns to the Restore
  button.
- **Unchanged** (`Unchanged`): the dialog closes; information toast "Nothing to restore" /
  "Midterm review.md already has the content of this version."
- **Failed:** the dialog stays; a danger block under the header: "Couldn't restore Midterm
  review.md" and the reason, ending "Nothing was changed."; the primary reads "Try again" and takes
  focus. Reasons: `InUse` "Another app is using it. Close it there, then try again."; `NotLocal` "It
  isn't downloaded yet. Open it so it downloads, then try again."; `NotRecyclable` "Folio couldn't
  move the current file to the Recycle Bin, so it didn't replace it."; `AccessDenied` "Windows
  didn't allow it."; `DiskFull` "The disk is full."; `NotStored`, `Pruned` "Folio doesn't keep this
  version any more."; `FileChanged` "It was saved again just now, so Folio left it as it is. Check
  it, then try again."; others `errors.<code>` and "Copy details". "A failed restore leaves the user
  where they were": the History selection and scroll stay.

### 8.4 Restoring from a narrow window

The diff covers the list; "Restore…" is in "More" below 600 px; the dialog follows library-actions
§14 (width `min(440, window − 16)`).

### 8.5 Dialog look (M1 loose end)

For `feat/ui-history-view`, which owns the shared fix:

- **Placement:** dialogs are centred horizontally and anchored by their top edge, so they don't jump
  when their content grows (the import dialog's clash section, a banner appearing): form dialogs
  (import, edit message, move) at 96 px from the window's top, confirmations (`size.dialog-small`) at
  220 px. In windows too short for that, `top = max(49, (window height − dialog height) / 2)`; a
  dialog taller than the window minus 81 px scrolls its body (library-actions §2.8).
- **Pending button:** the shared `PendingButton` with React Aria's `isPending`, as the import dialog
  uses it: the pending label ("Restoring…") after a 14 px spinner (still under reduced motion), the
  shared `Button`'s disabled look (`color.surface.sunken`, `color.border.default`,
  `color.text.tertiary`), no hover, focus kept and the pending state announced. The import dialog's
  own `.button[data-pending]` rule moves into the shared `Button.css`.

### 8.6 Shared selection indicator (M1 loose end)

For `feat/ui-changes-view`, before the changes list adds a fifth copy: one `SelectionIndicator`
component (3 px × row height − 2 × `size.selection-bar-inset`, `color.selection.indicator`,
`radius.indicator` on the right corners) used by the tree, the search results, the settings nav,
the rail, the changes list and the history file rows.

## 9. Edit message and undo commit

### 9.1 Edit message

Board `m2-28`. From "Edit message" (5, 7.3) or the fallback toast:

- Dialog frame, `size.import-dialog` (560), at 96 px. Title "Edit message".
- Body: the field group of 4.1 without the footer (summary 36 px, description 4 rows), initial
  focus in the summary with its text selected; under it, `font.size.label` `color.text.secondary`:
  "b7c1e20 · Today 5:05 PM · 3 files. You can edit a message until the commit is synced."
- Footer: "Cancel" and "Save message" (accent, disabled while the text equals the old one).
  Ctrl+Enter saves.
- An empty summary shows the field error of library-actions §2.1, "Enter a summary.", on save. Too
  long: "A summary can be up to 256 characters." Invalid characters (`SummaryInvalid`): "A summary
  can't contain line breaks or control characters."
- Saving: `reword_commit { commit, summary, body }`, pending button "Saving…"; done: the dialog
  closes, the entry and the Not synced card show the new summary and a success toast "Saved the new
  message" / "b7c1e20 is now “MAT232: add lecture 6 slides”." (the new short id). Failure keeps the
  dialog with a danger block: "Couldn't save the message" + reason (`CannotReword`: "This commit's
  message can't be changed."; `HistoryReadOnly`: "A newer version of Folio changed this library.").

### 9.2 Undo commit

- No confirmation: undoing loses nothing, the changes return to the workspace.
- `uncommit { commit }`; done: information toast "Undid “MAT232: add lecture 5 slides”" / "Its 3
  changes are back in Changes." with "Show in Changes"; History adds the entry of 7.2; the card and
  the badge update. Failure: error toast "Couldn't undo the commit" + reason (`NotHead`: "Only the
  newest commit can be undone. Something changed; the list is refreshed."; `CannotUncommit`: "This
  commit can't be undone.").

## 10. The first commit (32A)

Boards `m2-18`, `m2-19`, `m2-07` (failure).

- When the library has no history (`historyState: none`) Folio waits for the first full scan and
  hashing, then calls `start_history { summary: "Start history" }` (versioning §7.7). The UI never
  shows the whole library as added changes.
- While `historyState` is `none` or `starting`, the Changes view is one panel (the three columns'
  space) with a state block: information tile `history`, "Starting your history", "Folio is saving
  the first version of your library: every text and Word file, and a record of everything else. You
  can keep working; changes show up here when it's done.", and a progress bar (library-actions §2.6,
  260 px) with "1.2 GB of 3.4 GB" under it (before the job starts: indeterminate, "Waiting for the
  scan to finish"). History shows the same block with "Your first entry shows up here when Folio has
  saved the first version of your library." The activity button shows "Starting history 35%"; the
  popover row "Starting history" / "1.2 of 3.4 GB" with "Cancel".
- Done: the views load normally; History's only entry is "Start history". Items that were not local
  or unreadable stay in Changes (3.4).
- Cancelled: the block reads "Your history hasn't started" / "Folio starts it the next time you open
  the library." with "Start history" (accent).
- Failed: danger tile "Couldn't start your history" with the reason ("The disk is full. Free up some
  space, then try again.") and "Folio also tries again the next time you open the library." +
  "Try again".

## 11. Announcements and toasts

Toasts follow library-actions §2.4 (`m2-09`).

| Event | Toast | Live region |
|---|---|---|
| Commit done | — | "Committed 9 changes: <summary>" (polite) |
| Commit with template after an AI failure | Information: "Committed with a template message" (4.3), "Edit message" | — |
| Commit failed | — (note in the commit box, `role="alert"`) | — |
| Generate failed | — (note, `role="status"`) | — |
| Restore done / unchanged / failed | Success / information / — (8.3) | — |
| Message saved | Success: "Saved the new message" | — |
| Undo commit done / failed | Information / error (9.2) | — |
| First commit done | — | "Your history has started." (polite) |
| Change navigation | — | "Change 2 of 5, lines 12 to 14" (polite) |

## 12. Library follow-ups (M1 gate notes)

### 12.1 Tag filter with many tags (33B)

Board `m2-40`. The filter bar (app-shell §5, 13A) shows at most two rows of chips at the panel's
width:

- Chips go in the tags' order; when the next chip would start a third row, the remaining tags move
  behind a final "+N" chip (same height and padding, 1 px dashed `color.border.strong`, `chevron-down`
  12 px). The "+N" chip itself always fits on the second row: the last visible tag moves into the menu
  when it would not.
- Its menu (library-actions §2.7): the hidden tags as checkable items with their dots, ─, "Edit
  tags…". Toggling keeps the menu open (like the Tags submenu); Esc closes it.
- When a hidden tag is selected the chip takes the selected look (`color.text.primary` fill,
  `color.surface.panel` text, solid border) and reads "+4 · 1 on"; accessible name "4 more tags, 1
  selected", `aria-haspopup="menu"`.
- Layout is measured on resize; the narrow window still hides the bar (app-shell §2).

### 12.2 Quick views follow the semester (34A)

Board `m2-41`. "Recently added" and "Untagged" use `list_files` with `scope` = the current semester
(ipc-m1 §9.1), for both their lists and their counts, so they agree with the tree and the panel's
count pill. Switching semesters refreshes them. Archived semesters are left out as everywhere else in
the tree. Empty states keep library-actions §8's text, with the semester in it: "Nothing added to
Fall 2026 in the last 7 days", "Every file in Fall 2026 has a tag".

### 12.3 Folders in a grid (35A)

Board `m2-42`. In the grid of a selected course or folder (app-shell §5):

- Folders come first as cards in a "Folders" group: a label row "Folders" (`font.size.small` 600
  `color.text.secondary`) and the count (`color.text.tertiary`), then a grid `repeat(auto-fill,
  minmax(size.folder-card-min, 1fr))`, gap `space.8`. Card: `size.folder-card` (48) tall, 1 px
  `color.border.default`, `radius.control`, `color.surface.panel`, padding 0 12, gap 10: an 18 px
  `folder` in `color.text.secondary`, then the name (13 px, 600, one line, truncated) over the count
  ("5 files", `font.size.caption` `color.text.tertiary`).
- Then a "Files" label row and the file tiles as today (min 150, gap 12).
- Without folders, or without files, the group labels are left out.
- Hover, selection, focus, the context menu, double-click (opens the folder in the tree) and the drop
  target behave as the tiles (library-actions §3, §6). Keyboard: the grid's 2-D arrow keys treat the
  folder cards and the tiles as one grid in reading order.

### 12.4 "View history" in the Library

The preview header's "View history of this file" (app-shell §5) and the context menus' "View
history" (library-actions §6, after "Show in File Explorer") open 7.4. Folders and courses have no
history entry in M2.

## 13. Keyboard summary

| Where | Keys |
|---|---|
| Anywhere in Changes | Ctrl+Enter commits; F7 / Shift+F7 next / previous change |
| Changes list | Arrows, Home, End, Page Up/Down; Space includes or leaves out; Ctrl+A; Enter into the diff; Shift+F10 |
| Commit box | Tab through summary, description, message button, options, commit; Esc stops generating |
| Diff region | Arrows and Page Up/Down scroll; F7 / Shift+F7; Tab to fold buttons |
| History feed | Page Up/Down between entries; Tab into a card; arrows inside a card; Shift+F10 on an entry or row |
| One file's history | Esc in the timeline removes the file filter |
| Narrow | Esc or Alt+Left goes back from the diff |
| Dialogs | Library-actions §12 rules; Ctrl+Enter saves the edit message dialog |

Targets: check boxes and their hit areas 24 px, icon buttons 24–32 px, rows 32 px (CLAUDE.md
baseline; WCAG 2.1 has no target size at AA).

## 14. Motion

| Element | Trigger | Animation | Duration, easing | Reduced motion |
|---|---|---|---|---|
| Diff contents | Selection changes | None (content swaps; skeleton after 150 ms) | — | — |
| Fold row | Expand | Rows appear in place, no height animation | — | — |
| Current-change bar | F7 | Scrolls smoothly to the change | `motion.duration.base`, `motion.easing.standard` | Jumps |
| New commit in "Not synced", new restore entry | Arrives | Fade and rise 4 px; the soft background fades after `FRESH_COMMIT_MS` | `motion.duration.base` | Instant; the background still clears |
| Narrow diff over the list | Open, Back | As app-shell §10 (fade and rise 4 px) | `motion.duration.base` | Instant |
| Commit bar description | Open, close | Height follows, fade | `motion.duration.fast` | Instant |
| Spinners, skeleton | Waiting | As library-actions §2.6 | — | Still |
| Dialogs, toasts, menus | As library-actions §13 | | | |

`FRESH_COMMIT_MS = 2000` is a UI constant, not a duration token: reduced motion must not shorten how
long the highlight stays.

## 15. IPC data each state needs

From versioning §17 (the contract lane writes ipc-m2.md):

| Screen part | Data |
|---|---|
| Changes header, badge, commit button | `get_workspace` (`WorkspaceSummary`: totals, metadata count, fingerprint, `head`, `historyState`), refreshed on `WorkspaceChanged` |
| Rows | `list_workspace_items { page }`: key, kind (file or folder, item kind), path, `fromPath`, class, sizes, stored before and after, readiness, folder count, bound parts, `tagsChanged`, the catalog entry (for open, reveal, history) |
| Tag and settings rows | `list_metadata_changes { page }`: key, kind (tags, semester, course, tag definitions, library, ignore rules), the entry or name, the change |
| Commit box | `summarize_selection` (template, counts), `generate_commit_message` (AI), `get_ai_settings` (`enabled`, `hasKey`, endpoint for the service's name), `commit` → job |
| Activity | `JobChanged` kind `commit` (progress in bytes, cancellable, result: commit id and summary) |
| First commit | `historyState`, `start_history`, its job |
| Diff | `get_workspace_diff { key, page }`, `get_version_diff { commit, path, page }`: kind (text, word, metadata, none), the reason when none, sizes, compared commit and time, counts (lines or paragraphs), approximate, pages of lines with inline ranges, line-ending change, metadata details |
| This version | `folio-file` version route (versioning §9.4) |
| Not synced card | `list_history { filter: commits }` first page of three, and its total |
| History | `list_history { page, filter }`, `list_commit_changes`, `get_commit`, `HistoryChanged` |
| One file | `list_file_history { entry }` or `{ commit, path }` |
| Actions | `reword_commit`, `uncommit`, `restore_version` → `{ target, recycled }` |

## 16. Strings

Every string in this spec is the English source copy; keys follow the namespaces above. Plurals use
i18next `count` ("Commit {{count}} change(s)", "Show {{count}} unchanged line(s)", "{{count}} more in
History", "+{{count}}", "{{count}} files"). Dates and times through `lib/format.ts` ("Oct 13, 9:30
PM", "Today 5:05 PM"). The service's name is a variable. The template's verbs and phrases (4.6) are
strings too; the summary they make is stored in history and synced, so it stays English in every UI
language (versioning §8.1).

## 17. Review notes

Critique, accessibility review and copy review on the rendered boards (local render of every board in
light and dark, then the canvas).

Fixed on the canvas:

- Changed words were highlighted from a leading space ("␣along a unit vector u"); ranges are now
  trimmed to words (6.4).
- The emphasis was colour only (WCAG 1.4.1) and disappears in Windows' contrast themes; it gained a
  1 px underline in the sign colour.
- The loading diff dropped its header; the header is known from the row, so only the body loads.
- Office files previewed as rendered slides and tables, which M2 cannot do; they show the M1 file card
  with "Open with default app".
- "Writing the message…" squeezed the AI status between the split button and the link; the message
  button hides while a commit waits for the AI.
- The tag-change row had a check box; tag and settings changes are always committed (versioning
  §6.4), so they moved to their own group without check boxes, and the count, badge and commit button
  include them.
- The counts in the strip said "4 added": now "4 lines added", "2 paragraphs added".
- The restore title asked "Restore Midterm review.md?" without saying which version; it now names the
  date, and the button says "Restore version".
- The Not synced card in M2 showed the "Not synced" pill on every History entry; the pill waits for M3.

Checked and passing (tokens README contrast table, round 10 rows): text on the emphasis colours
(6.84:1 or more), the underlines (3.54:1 or more), line numbers on changed lines (4.87:1 or more), the
current-change bar (4.79:1 or more), the unchecked check box on a selected row (3.19:1), notes on the
warning and danger soft backgrounds (6.54:1 or more). Every control has a name; disabled controls keep
`aria-disabled` and a reason; no toast is the only place of an action ("Edit message" is also in the
card and History; "Show in Changes" is the rail).

Accepted limitations:

- The diff's emphasis is not announced by screen readers; they read the whole changed line with
  "Added line" or "Removed line".
- The rail badge stops at "999+".
- Bound items show one row; the parts are listed only in the diff.
- The shortcut hint "Ctrl+Enter" on the commit button stays at 80 % opacity (decision 36): 4.12:1 on
  the light accent fill and 4.50:1 on the dark one, under the 4.5:1 floor for its 11 px text.

Second review, 2026-10-04, while the Design System artifact was brought up to rounds 5–10 (local
render of its previews in light and dark, axe-core, a contrast pass on every text run):

- The timeline's day headers sat inside the `role="feed"`, which may own only articles (axe:
  aria-required-children). They are visual now, and each entry's description carries its day (7.6).
- "DeepSeek is writing…" and "Use template instead" did not fit the commit box's footer in the
  320 px lane, so the status was cut off; the link reads "Use template" (decision 37).
- The spec described its own disabled look (50 % opacity), pending look and check box colours; it now
  names the shared `Button`, `PendingButton` and `Checkbox` (3.2, 4.2, 8.5). The canvas still draws
  the older looks.

## 18. Open items

1. **A lane for section 12.** The Library follow-ups touch `library/` (filter bar, quick views, grid);
   none of the M2 UI lanes owns it. Suggested: a small `feat/ui-library-m1-notes` lane, or fold them
   into `feat/ui-history-view`, which already adds "View history" to the Library.
2. **Not synced in M2 (decision 31A) vs versioning §9.1.** versioning.md says the not-synced list is
   empty until M3; Sirui chose to show the newest three commits. The card can read them from
   `list_history`; the spec lane or the contract lane should update §9.1.
3. **Planning a restore.** The dialog must know before the call whether the version replaces the
   file, recreates it, goes beside another file, changes nothing, and whether the current file goes to
   the Recycle Bin (versioning §11.2–§11.3). Suggested: a read-only `plan_restore { commit, path }` →
   `{ outcome, target, recycle }`, with `restore_version` taking the same arguments.
4. **History items need a little more:** an `uncommit` entry needs the undone commit's summary, a
   `restore` entry the version's commit time and the file name, a `reword` entry the new short id,
   every entry its effective time for the day headers (7.2), and `FileVersion` whether it equals the
   current file ("Current version", disabled Restore).
5. **Cancelling Generate.** `generate_commit_message` should be cancellable (Stop, Esc, "Use
   template"), for example with a request id and `cancel_ai_request`, or as a short job.
6. **Commit progress text.** Bytes are assumed ("12.4 of 48.0 MB"); the first commit of a large
   library may want files as well.
7. **Design System artifact.** Done (2026-10-04): "Folio Design System" (version 7) has token
   rounds 5–10 and the previews DiffPane, CommitBox, NotSyncedCard and RestoreDialog; HistoryEntry,
   ChangeRow, Button (pending state) and CourseBadge (code letters, 9 px) are updated. The token
   files stay the source of truth.
