// The History view store (docs/specs/ui-architecture.md §6.1): where each timeline was (its focused
// entry, scroll offset and measured entries), the file whose history shows instead of the whole
// history, the file row shown in the diff, the cards showing all their changes and whether the diff
// covers the list in a narrow window, kept while the view is hidden behind another rail view and
// while the filter or a file's history replaces the whole history for a while. Server data stays in
// the query cache; another library starts afresh.
import type { VirtualItem } from '@tanstack/react-virtual';
import { create } from 'zustand';

import { reportUiError } from '../app/log';
import { followRef, followReferences, recheck, type ReferenceUpdate } from '../data/references';
import type { FileRef, HistoryType } from '../ipc';
import { filterKey, filterOf } from './model/filter';
import type { HistorySelection } from './model/selection';
import { setHistoryTypes, useHistoryPreferences } from './preferences';

/** An entry by its key, and its index for when its key goes (a reword gives later commits new ids). */
export interface EntryFocus {
  key: string;
  index: number;
}

/** The timelines the view keeps a place for: the whole history, and one file's (handoff §7.4). */
export type TimelineName = 'whole' | 'file';

/** Where a timeline was, for when it shows again: its tab stop, scroll offset and measured entries. */
export interface TimelinePlace {
  /** The entry with the tab stop, which Page Up and Page Down move from. */
  focus: EntryFocus | null;
  /** The scroll offset. */
  offset: number;
  /** The entries' measured heights (the virtualiser's snapshot), so the offset lands where it was. */
  measured: readonly VirtualItem[];
}

const TOP: TimelinePlace = { focus: null, offset: 0, measured: [] };

interface HistoryViewState {
  places: Readonly<Record<TimelineName, TimelinePlace>>;
  /**
   * One file's history shows instead of the whole history (§7.4): a file of the library, or a
   * version, which the view replaces with the file it belongs to now once it is looked up.
   */
  file: FileRef | null;
  /** The timeline that shows next takes the focus (its tab stop), unless the diff has it. */
  focusNext: boolean;
  /** The file row the diff shows; `null` shows the desk illustration (§7.5). */
  selection: HistorySelection | null;
  /** Cards that show all their changes, by `commitAnchorKey`, so a message edit keeps them open. */
  expanded: ReadonlySet<string>;
  /** Narrow window: the diff covers the list (§2.2) until "Back". */
  covered: boolean;
}

const INITIAL: HistoryViewState = {
  places: { whole: TOP, file: TOP },
  file: null,
  focusNext: false,
  selection: null,
  expanded: new Set(),
  covered: false,
};

export const useHistoryView = create<HistoryViewState>()(() => INITIAL);

/** Back to the top of the whole history: another library, or a test. */
export function resetHistoryView(): void {
  useHistoryView.setState(INITIAL);
}

function setPlace(name: TimelineName, change: Partial<TimelinePlace>): void {
  const { places } = useHistoryView.getState();
  useHistoryView.setState({ places: { ...places, [name]: { ...places[name], ...change } } });
}

export function setEntryFocus(name: TimelineName, focus: EntryFocus): void {
  const now = useHistoryView.getState().places[name].focus;
  if (now?.key !== focus.key || now.index !== focus.index) setPlace(name, { focus });
}

export function setTimelineOffset(name: TimelineName, offset: number): void {
  if (useHistoryView.getState().places[name].offset !== offset) setPlace(name, { offset });
}

/** The entries a timeline measured, as it goes: they place it where it was when it shows again. */
export function keepMeasurements(name: TimelineName, measured: readonly VirtualItem[]): void {
  setPlace(name, { measured });
}

/** The same file: an entry by its id, a version by its commit and path. */
export function fileKey(file: FileRef): string {
  return file.kind === 'entry' ? `entry ${file.entry.id}` : `version ${file.commit} ${file.path}`;
}

/**
 * "View history of this file" (§7.4): its history shows from its newest entry, which takes the
 * focus unless `focus` is false (asked from the diff, which keeps it). The file whose history
 * already shows stays as it is.
 */
export function showFileHistory(file: FileRef, focus = true): void {
  const now = useHistoryView.getState().file;
  if (now !== null && fileKey(now) === fileKey(file)) return;
  const { places } = useHistoryView.getState();
  useHistoryView.setState({ file, places: { ...places, file: TOP }, focusNext: focus });
}

/**
 * "View history of this file" asked from another view (`app/historyTarget.ts`), which hid the
 * control that had the focus: as `showFileHistory`, and the timeline takes the focus even when that
 * file's history already shows (its place kept), so the focus never stays in the hidden view. The
 * list shows: a narrow window's diff over it goes (the row it showed stays selected), since entries
 * under it cannot take the focus.
 */
export function focusFileHistory(file: FileRef): void {
  showFileHistory(file);
  useHistoryView.setState({ focusNext: true, covered: false });
}

/**
 * The chip's "Show the whole history", or Esc (§7.4): the whole history again where it was, its tab
 * stop with the focus.
 */
export function showWholeHistory(): void {
  if (useHistoryView.getState().file !== null) useHistoryView.setState({ file: null, focusNext: true });
}

/**
 * The whole history, its tab stop with the focus: asked from another view ("N more in History"),
 * which hid the control that had the focus. The timeline showing takes it, or the one that shows
 * next; a narrow window's diff over the list goes, as for `focusFileHistory`.
 */
export function focusWholeHistory(): void {
  useHistoryView.setState({ file: null, focusNext: true, covered: false });
}

/**
 * The timeline showing, its tab stop with the focus, where it is: asked when the element that had
 * the focus has gone from outside the view (a dialog closed after its commit went). While a narrow
 * window's diff covers the list, the diff takes it instead and stays (`HistoryView`).
 */
export function focusTimeline(): void {
  useHistoryView.setState({ focusNext: true });
}

/** The file a version belongs to now, found (decision 12): its history follows the file from here. */
export function placeFile(version: FileRef, file: FileRef): void {
  if (useHistoryView.getState().file === version) useHistoryView.setState({ file });
}

/** Whether a timeline that just showed takes the focus; asked once per showing. */
export function takeTimelineFocus(): boolean {
  if (!useHistoryView.getState().focusNext) return false;
  useHistoryView.setState({ focusNext: false });
  return true;
}

/** Shows the row's version in the diff; in a narrow window the diff then covers the list. */
export function selectRow(selection: HistorySelection, cover: boolean): void {
  useHistoryView.setState({ selection, covered: cover });
}

/** The selection found again after the entries changed (`reanchor`), or gone. */
export function setSelection(selection: HistorySelection | null): void {
  useHistoryView.setState(selection === null ? { selection, covered: false } : { selection });
}

/** Enter on the row shown, in a narrow window: its diff covers the list again. */
export function cover(): void {
  if (useHistoryView.getState().selection !== null) useHistoryView.setState({ covered: true });
}

/** "Back to history" in a narrow window: the list again, with its selection. */
export function uncover(): void {
  useHistoryView.setState({ covered: false });
}

/** "Show all N files": the card of the commit with this `commitAnchorKey` shows all its changes. */
export function expandCard(key: string): void {
  const { expanded } = useHistoryView.getState();
  if (!expanded.has(key)) useHistoryView.setState({ expanded: new Set([...expanded, key]) });
}

/** Shows other kinds of entry (the type filter): other lists, the whole history's and a file's, read from their tops. */
export function showTypes(types: HistoryType[] | null): void {
  const filter = types === null ? null : filterOf(types);
  if (filterKey(filter) === filterKey(useHistoryPreferences.getState().types)) return;
  setHistoryTypes(filter);
  useHistoryView.setState({ places: { whole: TOP, file: TOP } });
}

/**
 * A file of the library whose history shows follows the catalog: a move keeps its history with
 * the new path; once it or a folder above it goes, the whole history shows again, as the Library's
 * preview closes. After a rebuilt catalog it is checked again.
 */
function followFile(update: Exclude<ReferenceUpdate, { kind: 'reset' }>): void {
  const { file } = useHistoryView.getState();
  if (file?.kind !== 'entry') return;
  const still = () => useHistoryView.getState().file === file;
  if (update.kind === 'changes') {
    const entry = followRef(file.entry, update.changes);
    if (entry === null) showWholeHistory();
    else if (entry !== file.entry) useHistoryView.setState({ file: { kind: 'entry', entry } });
    return;
  }
  recheck([file.entry]).then(
    ([entry]) => {
      if (!still()) return;
      if (entry === undefined) showWholeHistory();
      else if (entry.path !== file.entry.path || entry.id !== file.entry.id) useHistoryView.setState({ file: { kind: 'entry', entry } });
    },
    (error: unknown) => {
      // A failed check keeps the file; the next catalog event follows it again.
      reportUiError('uncaught', 'history.recheck', error);
    },
  );
}

followReferences((update) => {
  if (update.kind === 'reset') resetHistoryView();
  else followFile(update);
});
