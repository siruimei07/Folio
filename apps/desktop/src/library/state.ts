// The Library view store (docs/specs/ui-architecture.md §6.1): what is expanded, selected, focused
// and shown in the third column, the tag filter, the inline editors and the view's dialogs. Server
// data stays in the query cache; this store holds references only, and they follow the catalog
// (§5.5): moves and renames update them, removals drop them, a rebuilt catalog rechecks them.
import { create } from 'zustand';

import { reportUiError } from '../app/log';
import type { FailureItem } from '../components/FailureList/FailureList';
import { followPath, followRef, followReferences, recheck } from '../data/references';
import { setCurrentSemester, useSession } from '../data/session';
import type { EntryChange, EntryRef } from '../ipc';
import { isBelow, isInside } from '../lib/paths';
import { setPanelMode } from './preferences';

export type QuickView = 'recent' | 'untagged';

/** What the third column shows. */
export type Active =
  | { kind: 'quick'; view: QuickView }
  /** A course or folder: its grid. */
  | { kind: 'folder'; entry: EntryRef }
  /** A file: its preview. */
  | { kind: 'file'; entry: EntryRef }
  | null;

/** The two collections with a selection of their own: the tree or list, and the third column. */
export type Region = 'panel' | 'pane';

/** A selected entry and what it is, which decides its menu. */
export interface Selected extends EntryRef {
  kind: 'file' | 'folder' | 'course';
}

export interface Selection {
  /** Selected entries by id. */
  entries: ReadonlyMap<string, Selected>;
  /**
   * The row a Shift range starts from: its key, and its index for when its page is no longer
   * loaded and the key cannot be found.
   */
  anchor: { key: string; index: number } | null;
  /** The focused row's key and index; the index keeps focus in place when its key goes away. */
  focus: { key: string; index: number } | null;
}

/** The dialogs the Library view opens itself. */
export type LibraryDialog =
  | { kind: 'move'; entries: readonly EntryRef[] }
  | { kind: 'deleteCourse'; course: EntryRef }
  | { kind: 'deleteItems'; entries: readonly EntryRef[] }
  | { kind: 'deleteSemester'; semester: EntryRef }
  | { kind: 'extension'; entry: EntryRef; name: string; region: Region }
  | { kind: 'failures'; title: string; items: readonly FailureItem[] };

/** An entry a menu acts on, with its tags for the Tags submenu. */
export interface MenuTarget extends Selected {
  tags: readonly string[];
  /** Tags it gets from the folders above it. */
  folderTags: readonly string[];
}

/** An open context menu: where, for which collection, on which entries or its empty space. */
export interface MenuRequest {
  anchor: { x: number; y: number };
  region: Region;
  /** Empty for the empty space of the tree. */
  targets: readonly MenuTarget[];
  /** Opened from the keyboard: focus goes to the first item (WAI-ARIA menu pattern). */
  keyboard: boolean;
}

interface LibraryViewState {
  /** Expanded courses and folders, by path (§5.5: search and reveal know ancestors by path). */
  expanded: ReadonlySet<string>;
  panel: Selection;
  pane: Selection;
  active: Active;
  /** Tag ids of the filter bar: files must have every one. */
  filter: readonly string[];
  /** Narrow window: the preview covers the list. */
  covered: boolean;
  /** The entry whose name is a field. */
  renaming: { id: string; region: Region } | null;
  /** A new folder being named, as the first child of `parent`. */
  newFolder: { parent: EntryRef } | null;
  /** An entry to expand to, select and scroll to (search results, "Show"). */
  reveal: EntryRef | null;
  dialog: LibraryDialog | null;
  menu: MenuRequest | null;
  /** Scroll offsets, restored when the view is shown again. */
  offsets: { panel: number; pane: number };
  /** The "rebuilt its index" banner was closed. */
  recoveredDismissed: boolean;
}

const EMPTY_SELECTION: Selection = { entries: new Map(), anchor: null, focus: null };

const INITIAL: LibraryViewState = {
  expanded: new Set(),
  panel: EMPTY_SELECTION,
  pane: EMPTY_SELECTION,
  active: null,
  filter: [],
  covered: false,
  renaming: null,
  newFolder: null,
  reveal: null,
  dialog: null,
  menu: null,
  offsets: { panel: 0, pane: 0 },
  recoveredDismissed: false,
};

export const useLibraryView = create<LibraryViewState>()(() => INITIAL);

/** Back to nothing expanded or selected: another library, or a test. */
export function resetLibraryView(): void {
  useLibraryView.setState(INITIAL);
}

// --- expansion -------------------------------------------------------------------------------

export function setExpanded(path: string, expanded: boolean): void {
  useLibraryView.setState(({ expanded: current, panel }) => {
    if (current.has(path) === expanded) return {};
    const next = new Set(current);
    if (expanded) {
      next.add(path);
      return { expanded: next };
    }
    // Collapsing a folder forgets what was open below it, as File Explorer does, and what was
    // selected there: an action never reaches rows nobody can see.
    for (const open of current) if (isInside(open, path)) next.delete(open);
    const hidden = [...panel.entries.values()].filter((entry) => isBelow(entry.path, path));
    if (hidden.length === 0) return { expanded: next };
    const entries = new Map(panel.entries);
    for (const entry of hidden) entries.delete(entry.id);
    return { expanded: next, panel: { ...panel, entries } };
  });
}

/** Expands every folder in `paths` (a reveal's ancestors). */
export function expandAll(paths: readonly string[]): void {
  useLibraryView.setState(({ expanded }) => {
    if (paths.every((path) => expanded.has(path))) return {};
    return { expanded: new Set([...expanded, ...paths]) };
  });
}

// --- selection and focus ---------------------------------------------------------------------

export function setSelection(region: Region, selection: Selection): void {
  useLibraryView.setState({ [region]: selection });
}

export function setFocus(region: Region, key: string, index: number): void {
  useLibraryView.setState((state) => ({ [region]: { ...state[region], focus: { key, index } } }));
}

/** Selects one entry (or nothing, for a quick view) and focuses its row. */
export function selectOnly(region: Region, key: string, index: number, entry: Selected | null): void {
  useLibraryView.setState({
    [region]: {
      entries: entry === null ? new Map() : new Map([[entry.id, entry]]),
      anchor: { key, index },
      focus: { key, index },
    },
  });
}


// --- semester --------------------------------------------------------------------------------

/**
 * Shows another semester. Nothing of the one before stays selected, shown in the third column or
 * being edited, so no key or menu acts on what is no longer on screen; expanded folders, the
 * filter and the reveal stay.
 */
export function showSemester(path: string): void {
  const { libraryId, semesters } = useSession.getState();
  if (libraryId !== null && semesters[libraryId] === path) return;
  setCurrentSemester(path);
  useLibraryView.setState({
    panel: EMPTY_SELECTION,
    pane: EMPTY_SELECTION,
    active: null,
    covered: false,
    renaming: null,
    newFolder: null,
    menu: null,
  });
}

// --- what the third column shows --------------------------------------------------------------

/** Shows `active` in the third column; in a narrow window it covers the list only once `setCovered` says so. */
export function setActive(active: Active): void {
  useLibraryView.setState({
    active,
    covered: false,
    pane: EMPTY_SELECTION,
    offsets: { ...useLibraryView.getState().offsets, pane: 0 },
  });
}

/** Narrow window: the preview covers the list (`true`), or "Back" (`false`). */
export function setCovered(covered: boolean): void {
  useLibraryView.setState({ covered });
}

// --- filter ----------------------------------------------------------------------------------

export function setFilter(filter: readonly string[]): void {
  useLibraryView.setState({ filter, panel: EMPTY_SELECTION });
}

// --- editors and dialogs -------------------------------------------------------------------

export function startRename(id: string, region: Region): void {
  useLibraryView.setState({ renaming: { id, region }, newFolder: null });
}

export function stopRename(): void {
  useLibraryView.setState({ renaming: null });
}

/**
 * The whole tree in the panel: no tag filter and the Tree mode. A reveal shows its entry there,
 * and a new folder's field shows only there (it holds no files, so no filter would show it).
 */
export function showWholeTree(): void {
  if (useLibraryView.getState().filter.length > 0) setFilter([]);
  setPanelMode('tree');
}

/** Starts naming a new folder in `parent`, first in it in the whole tree. */
export function startNewFolder(parent: EntryRef): void {
  showWholeTree();
  setExpanded(parent.path, true);
  useLibraryView.setState({ newFolder: { parent }, renaming: null });
}

export function stopNewFolder(): void {
  useLibraryView.setState({ newFolder: null });
}

export function openLibraryDialog(dialog: LibraryDialog): void {
  useLibraryView.setState({ dialog });
}

export function closeLibraryDialog(): void {
  useLibraryView.setState({ dialog: null });
}

export function openMenu(menu: MenuRequest): void {
  useLibraryView.setState({ menu });
}

export function closeMenu(): void {
  useLibraryView.setState({ menu: null });
}

export function setReveal(reveal: EntryRef | null): void {
  useLibraryView.setState({ reveal });
}

export function setOffset(region: Region, offset: number): void {
  const { offsets } = useLibraryView.getState();
  if (offsets[region] !== offset) useLibraryView.setState({ offsets: { ...offsets, [region]: offset } });
}

export function dismissRecovered(): void {
  useLibraryView.setState({ recoveredDismissed: true });
}

// --- following the catalog (§5.5) --------------------------------------------------------------

function followSelection(selection: Selection, changes: readonly EntryChange[]): Selection {
  let changed = false;
  const entries = new Map<string, Selected>();
  for (const [id, selected] of selection.entries) {
    const followed = followRef(selected, changes);
    if (followed !== selected) changed = true;
    if (followed !== null) entries.set(id, followed === selected ? selected : { ...followed, kind: selected.kind });
  }
  return changed ? { ...selection, entries } : selection;
}

function followActive(active: Active, changes: readonly EntryChange[]): Active {
  if (active === null || active.kind === 'quick') return active;
  const entry = followRef(active.entry, changes);
  if (entry === active.entry) return active;
  return entry === null ? null : { ...active, entry };
}

function followRefs(refs: readonly EntryRef[], changes: readonly EntryChange[]): EntryRef[] {
  return refs.flatMap((ref) => followRef(ref, changes) ?? []);
}

/** An open menu acts on where its targets are now; once they are all gone, it closes. */
function followMenu(menu: MenuRequest | null, changes: readonly EntryChange[]): MenuRequest | null {
  if (menu === null || menu.targets.length === 0) return menu;
  const targets = menu.targets.flatMap((target) => {
    const followed = followRef(target, changes);
    if (followed === target) return [target];
    return followed === null ? [] : [{ ...target, ...followed }];
  });
  if (targets.length === 0) return null;
  return targets.length === menu.targets.length && targets.every((target, index) => target === menu.targets[index])
    ? menu
    : { ...menu, targets };
}

function followDialog(dialog: LibraryDialog | null, changes: readonly EntryChange[]): LibraryDialog | null {
  if (dialog === null) return null;
  switch (dialog.kind) {
    case 'move':
    case 'deleteItems': {
      const entries = followRefs(dialog.entries, changes);
      return entries.length === 0 ? null : { ...dialog, entries };
    }
    case 'deleteCourse': {
      const course = followRef(dialog.course, changes);
      return course === null ? null : { ...dialog, course };
    }
    case 'deleteSemester': {
      const semester = followRef(dialog.semester, changes);
      return semester === null ? null : { ...dialog, semester };
    }
    case 'extension': {
      const entry = followRef(dialog.entry, changes);
      return entry === null ? null : { ...dialog, entry };
    }
    case 'failures':
      return dialog;
  }
}

/** Every reference the store holds, after `changes`. */
export function followChanges(changes: readonly EntryChange[]): void {
  const state = useLibraryView.getState();
  // The same set when no path moved, so the tree is not laid out again for nothing.
  let moved = false;
  const followedPaths = new Set<string>();
  for (const path of state.expanded) {
    const followed = followPath(path, changes);
    if (followed !== path) moved = true;
    if (followed !== null) followedPaths.add(followed);
  }
  const expanded = moved ? followedPaths : state.expanded;
  const removed = (id: string) => changes.some((change) => change.kind === 'removed' && change.entry.id === id);
  const parent = state.newFolder === null ? null : followRef(state.newFolder.parent, changes);
  const reveal = state.reveal === null ? null : followRef(state.reveal, changes);
  const active = followActive(state.active, changes);
  useLibraryView.setState({
    expanded,
    panel: followSelection(state.panel, changes),
    pane: followSelection(state.pane, changes),
    active,
    // What covered the list went away, and with it the "Back" that uncovers it.
    covered: active === null ? false : state.covered,
    renaming: state.renaming !== null && removed(state.renaming.id) ? null : state.renaming,
    newFolder: parent === null ? null : { parent },
    reveal,
    dialog: followDialog(state.dialog, changes),
    menu: followMenu(state.menu, changes),
  });
}

/**
 * After a rebuilt catalog: keep the references that still name an entry (§5.5). What was
 * selected or opened while the check ran was read from the new catalog, and stays.
 */
async function recheckAll(): Promise<void> {
  const state = useLibraryView.getState();
  const heldIds = new Set([...state.panel.entries.keys(), ...state.pane.entries.keys()]);
  const held = [
    ...state.panel.entries.values(),
    ...state.pane.entries.values(),
    ...(state.active !== null && state.active.kind !== 'quick' ? [state.active.entry] : []),
  ];
  const kept = new Map((await recheck(held)).map((ref) => [ref.id, ref]));
  const keep = (selection: Selection): Selection => ({
    ...selection,
    entries: new Map(
      [...selection.entries.values()].flatMap((selected) => {
        if (!heldIds.has(selected.id)) return [[selected.id, selected] as const];
        const ref = kept.get(selected.id);
        return ref === undefined ? [] : [[selected.id, { ...ref, kind: selected.kind }] as const];
      }),
    ),
  });
  const now = useLibraryView.getState();
  const active = now.active;
  const before = (value: unknown, then: unknown) => value !== null && value === then;
  useLibraryView.setState({
    panel: keep(now.panel),
    pane: keep(now.pane),
    active:
      active !== state.active || active === null || active.kind === 'quick'
        ? active
        : kept.has(active.entry.id)
          ? { ...active, entry: kept.get(active.entry.id) ?? active.entry }
          : null,
    // Editors, dialogs and menus opened before the rebuild may name what is gone.
    renaming: before(now.renaming, state.renaming) ? null : now.renaming,
    newFolder: before(now.newFolder, state.newFolder) ? null : now.newFolder,
    dialog: before(now.dialog, state.dialog) ? null : now.dialog,
    menu: before(now.menu, state.menu) ? null : now.menu,
  });
}

followReferences((update) => {
  if (update.kind === 'reset') resetLibraryView();
  else if (update.kind === 'changes') followChanges(update.changes);
  else {
    // A failed check keeps what the view holds; the next catalog event follows it again.
    recheckAll().catch((error: unknown) => {
      reportUiError('uncaught', 'library.recheck', error);
    });
  }
});
