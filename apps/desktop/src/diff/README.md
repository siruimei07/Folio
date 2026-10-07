# The diff pane

The diff of one change, shared by the Changes view (`feat/ui-changes-view`) and the History view
(`feat/ui-history-view`): handoff `docs/design/handoff/workspace-history.md` §6, contract
`docs/specs/ipc-m2.md` §9. It reads the diff itself, pages and virtualises its lines, moves between
changes with F7, shows the file at this version through the preview, and words every state that is
not lines. A host passes the selected row and its own actions; nothing else.

Hosts import it from `app/panes.ts`, never from this folder (features never import each other):

```ts
import { DIFF_PANE, type DiffPaneHandle, type DiffTarget } from '../app/panes';
```

## Props

| Prop | Type | |
|---|---|---|
| `target` | `DiffTarget` | The selected row (below). Required. |
| `actions` | `{ open(entry: EntryRef): void }` | "Open with default app", with the host's own toasts (library-actions §9.3). The pane passes the item's entry in Changes and, in History, the file the version belongs to now (`locate_version`); it offers the button only when there is one. Required. |
| `moreItems` | `ReactNode` | The host's `MenuItem`s for "More": Open with default app · Show in File Explorer · View history of this file · Copy path (§6.1). The pane wraps them in its own `Menu`. |
| `back` | `{ label, onBack }` | Narrow window (§2.2): "Back" first in the header, named by `label` ("Back to changes", "Back to history"). Esc and Alt+Left in the pane call `onBack` too, unless a menu or tooltip took the Esc. |
| `restore` | `{ onRestore, disabledReason? }` | History only (§8.1): "Restore". The host decides which rows offer it (stored text and Word versions; not event-only files, thinned-out versions or `.folio` paths) and runs the confirmation (§8.2). With `disabledReason` ("This is the version you have now.", a read-only history) the button stays, disabled, in the tab order, with the reason in its tooltip. |
| `ref` | `Ref<DiffPaneHandle>` | `ref.current.focus()` moves the focus into the diff: the lines' region, else the heading. Call it on Enter in the list (§3.6); selecting a row does not move the focus. `ref.current.focusRestore()` moves it to "Restore", enabled or disabled, or to "More" in a compact pane (the heading without Restore): for a confirmation that closes after the button it opened from was replaced (§8.3; React Aria gives the focus back to the element it came from only while that is in the page). |

## Targets

```ts
type DiffTarget =
  | { kind: 'workspace'; item: WorkspaceItem }                       // a Changes row
  | { kind: 'workspaceMetadata'; change: MetadataChange }            // a tag or settings change in Changes
  | { kind: 'version'; commit: CommitRef; row: ChangeRow }           // a file row of a commit
  | { kind: 'versionMetadata'; commit: CommitRef; change: MetadataChange }; // a commit's tag or settings change

type CommitRef = Pick<CommitInfo, 'id' | 'timeMs'>; // a CommitInfo, or a FileVersion's `commit`
```

One file's history (`list_file_history`) gives `FileVersion`s: pass
`{ kind: 'version', commit: version.commit, row: version.change }`.

A target is the same row when its kind, commit and key are the same (`targetId`). Another row starts
afresh: folds, the current change, "Changes | This version", the 150 ms skeleton. The same row
coming back as a new object after a refresh keeps all of that and its queries, so the host can pass
the rows of its latest page as they are. A row the pane showed earlier starts afresh too when it
comes back after another one.

## Examples

Changes (`feat/ui-changes-view`, as built in `changes/ChangesView.tsx`):

```tsx
const Diff = DIFF_PANE;
const diffRef = useRef<DiffPaneHandle>(null);
const files = useFileActions(); // app/fileActions.ts: open, show in File Explorer, copy path
const moreItems = useDiffMoreItems(shown); // changes/menus/ChangeMenu.tsx
// …the list's Enter: diffRef.current?.focus()
<Diff
  ref={diffRef}
  target={shown.kind === 'item' ? { kind: 'workspace', item: shown.item } : { kind: 'workspaceMetadata', change: shown.change }}
  actions={{ open: files.open }}
  moreItems={moreItems}
  back={narrow ? { label: t('changes:diff.back'), onBack: back } : undefined}
/>
```

How Changes hosts it:

- The target is the list's selected row, which follows the keyboard focus (§3.6); the rows of the
  latest page go in as they are. A course header takes the focus but is no change, so the column
  then shows nothing; so does a list that failed to load, and an empty workspace shows the desk.
  When the selected row's page scrolls out of the cache, the pane keeps the change it last showed.
- Wide, the pane sits in the third column; narrow, Enter or a click on a row puts it over the list
  (`back` given only then), and Back, Esc or Alt+Left hand the focus back to the row. The list
  stays laid out under it, hidden, so its scroll and measured rows stay.
- "More" holds the row menu's file items and Copy path (Ctrl+Shift+C copies from the list or the
  diff). "View history of this file" is `feat/ui-history-view`'s, which adds it in `fileItems`
  (changes/menus/ChangeMenu.tsx) for both menus.

History (`feat/ui-history-view`):

```tsx
<Diff
  ref={diffRef}
  target={{ kind: 'version', commit, row }}
  actions={{ open: commands.open }}
  moreItems={<HistoryFileMenuItems commit={commit} row={row} />}
  back={narrow ? { label: t('history:backToHistory'), onBack: closeDiff } : undefined}
  restore={
    restorable(row)
      ? { onRestore: () => openRestoreDialog(commit, row), disabledReason: isCurrent ? t('history:currentVersion') : undefined }
      : undefined
  }
/>
```

With nothing selected the host shows its own empty state (the desk illustration, §7.5); the pane
always has a target.

## What the pane does itself

- **Reads** `get_workspace_diff` / `get_version_diff` in windows of 500 rows through
  `data/diff.ts`, and `locate_version` for History's Open and previews. WorkspaceChanged refreshes
  workspace diffs. A refresh that fails keeps the last diff, under a banner "Couldn't update what
  changed." with Try again; a refresh that answers `NotFound` (the change was committed or undone)
  keeps it without a word, since the host drops the row. A window past the first that fails shows as
  one row with Try again and is asked again only then. Hosts call no diff command.
- **F7 / Shift+F7** are registered by the pane while text or Word lines show (`useShortcut`, also
  from text fields), so they work from the host's list too. Hosts register nothing. A view hidden in
  `<Activity>` has no effects, so only the visible view's pane answers.
- **"Changes | This version"** (§6.7) shows when the row offers it, from the row before the diff
  loads; the content can take it back (binary, not stored). It is offered for text files of types
  the preview shows: not for Word files while the preview shows them as a card (until their previews
  come), nor for event-only files in History. "This version" is the file on the disk in Changes and
  the stored version (the `folio-file` version route) in History. The diff stays mounted, hidden, so
  going back finds its folds and current change; F7 rests meanwhile.
- **The file's preview** under the banners of event-only files and moves without edits (§6.8): the
  file on the disk in Changes; in History the stored version when there is one, else the file the
  version belongs to now, or "It has been deleted since…" when there is none. It is `PREVIEW_FILE`
  (`app/previewFile.ts`); Esc in its frame puts the focus on the diff's heading. When that file
  cannot be looked up, the block says "Can't show this file" with the reason and Try again, as the
  preview's own failure does: the change above it did show.
- **Compact pane**: below `size.diff-compact-pane` (600 px) of the pane's own width (a
  `ResizeObserver`, not the window's), the toggle and Restore move into "More" after the host's
  items, as "Show this version" / "Show the changes" and "Restore…" (§6.1, §8.4). "More" shows
  whenever it has an item. A disabled "Restore…" has no tooltip: `restore.disabledReason` is the
  item's note on the right and its description, and the item stays in reach of the arrow keys and
  does nothing (the shared `Menu`, library-actions §2.7). Keep the reason a short sentence, such as
  "This is the version you have now."
- **States** (§6.8): loading after 150 ms, load failed with Try again and Open, and every block for
  content that is not lines; the banners for moves, bound parts and event-only files. The failed
  block and the refresh banner add "Copy details" for `Internal`, `FileSystem`, `InvalidArgument`
  and `Transport` (library-actions §9.6).
- **Focus**: a fold or a failed window's "Try again" that has the focus stays rendered, its window
  still asked, when it scrolls out of the virtualised range (Page Down, End, the wheel, F7). A
  control that goes leaves the focus in the diff, not the page (`useFocusKeeper`, which watches the
  DOM): a fold that opens, a failed row that loads again or whose window answered for other content
  leave it on the region; a block or banner whose "Try again" read succeeded or started over, and
  the lines when a refresh turns them into a state block (unreadable, binary, not local, too large),
  leave it on the lines, else the heading. In the header, a control that goes while it has the
  focus (Restore turning disabled as its version becomes the current one, the toggle and Restore
  moving into "More" as the pane narrows) leaves it on Restore, else "More". Focus the person puts
  elsewhere stays there. Each "Try
  again" keeps the focus while its read runs, and when the read settles with the failure still
  showing (a refresh banner, a file still in use, a lookup or window that fails again), the failure's
  title is read again (`useRetry`, WCAG 4.1.3): only as that count grows, so the diff shown again
  after "This version" reads nothing, and the refresh banner over an unreadable file reads it rather
  than the block under it (`useRetryAnnouncement`). The region's focus ring is drawn by its frame,
  above the rows; the current change's bar moves in past it.

## Layout

The pane fills its parent as a flex item (`flex: 1`, `min-width: 0`, `min-height: 0`): put it in a
column with a height, such as the host's panel. Its header is `size.panel-header` like the other
panes'.

## Files

| Path | |
|---|---|
| `DiffPane.tsx` | The pane: reading, the view, bodies, the focus handle, Back keys. |
| `DiffHeader.tsx` | Back, the path heading, the status, the toggle, Restore, More. |
| `DiffStrip.tsx` | What is compared, the counts, "Change 2 of 5" and its buttons. |
| `DiffStates.tsx`, `EventNote.tsx`, `MetadataDetail.tsx` | The blocks, banners and tag and settings lists. |
| `lines/` | The virtualised region, its lines, folds and scrolling. |
| `model/` | Pure: targets, the description of a row (`describe.ts`), the windows' layout, changes. |
| `useChangeNavigation.ts` | F7, Shift+F7 and the strip's buttons. |
| `useRetry.ts` | "Try again" that reads a failure again. The focus when what had it goes is `components/collections/useFocusKeeper.ts`, shared with the virtualised collections. |
| `types.ts` | The props, re-exported by `app/panes.ts`. |
| `test/` | Fixtures and helpers for the pane's tests. |

The dev gallery shows the pane on the fake shell: `/gallery.html?view=diff&scenario=small` (also
`diffs`, `history-long`; `&select=<text>`, `&theme=dark`, `&motion=on`, `&latency=<ms>`,
`&fail=get_workspace_diff:InUse`).

## For the host lanes

- The Playwright flow over the pane belongs to the hosts (this lane has no view to host it):
  selection → diff, F7, unfolding, "This version", narrow Back. It needs the real diff commands,
  which stay planned stubs until `feat/core-diff-restore` lands; `e2e/tests/changes.spec.ts`
  covers only the view's load failure until then, and says where the flow goes.
- When `locate_version` fails, History's blocks offer no "Open with default app", and a stored
  note's images show as missing, without saying why; `feat/ui-history-view`, whose entry actions
  (Open, Show in File Explorer) use the same lookup, should say so where it shows them.
- `feat/ui-changes-view` widens the WorkspaceChanged refresh predicate in `data/events.ts` for its
  own keys.

## Known limitations

- When every window past the first fails, the rows of more windows come into view as the failed
  ones shrink to a row each, and those are asked for in turn, once each, until the view shows only
  failed rows.
