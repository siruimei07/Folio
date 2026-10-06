// Moving between changes (handoff workspace-history §6.2, §6.9): finding change k among the
// windows of the folded diff that have loaded, the window to load when it lies beyond them, and
// the lines it covers for "Change 2 of 5, lines 12 to 14". Pure, in rows of the folded diff; the
// layout (`rows.ts`) turns a row into a display index.
//
// A change is a run of consecutive added and removed rows with one `change` index (ipc-m2 §9.3),
// so its rows are contiguous and indices only grow down the diff. Between two changes the folded
// diff has at most 3 rows of context, a fold and 3 more, so the next change after a known one is
// at most one window load away; a change longer than a window may need one load per window it
// spans, and the last change of a long added or deleted file is found from the last window.
import { DIFF_WINDOW_ROWS, windowId } from '../../data/diff';
import type { DiffRow, DiffWindow } from '../../ipc';
import { rowsWindowOf, type WindowRows } from './rows';

/** The windows of the folded diff that have loaded, by their index (offset / `DIFF_WINDOW_ROWS`). */
export interface LoadedRows {
  /** Rows of the folded diff (`TextDiff.rows`). */
  total: number;
  /** Indices of the loaded windows, in order. */
  windows: readonly number[];
  /** The rows of window `index`, when it has loaded. */
  window: (index: number) => readonly DiffRow[] | undefined;
}

/** The `rows` windows of `windows` (`checkWindows`) as `LoadedRows`. */
export function loadedRows(total: number, windows: WindowRows): LoadedRows {
  const byIndex = new Map<number, readonly DiffRow[]>();
  for (let offset = 0; offset < total; offset += DIFF_WINDOW_ROWS) {
    const rows = windows.rows.get(windowId(rowsWindowOf(offset)));
    if (rows !== undefined) byIndex.set(offset / DIFF_WINDOW_ROWS, rows);
  }
  return { total, windows: [...byIndex.keys()], window: (index) => byIndex.get(index) };
}

/** The lines a change covers: new-side numbers, old-side ones when it only removes lines. */
export interface LineRange {
  side: 'new' | 'old';
  from: number;
  to: number;
}

/** Where change k starts; `load`: read this window, then look again; `none`: no such change. */
export type ChangeStart = { kind: 'found'; row: number } | { kind: 'load'; window: DiffWindow } | { kind: 'none' };

/** The lines of change k; `load`: read this window, then look again; `none`: not this change. */
export type ChangeLines = { kind: 'found'; lines: LineRange } | { kind: 'load'; window: DiffWindow } | { kind: 'none' };

const NONE = { kind: 'none' } as const;

function load(row: number) {
  return { kind: 'load', window: rowsWindowOf(row) } as const;
}

/** The change a row belongs to; `null` for context and fold rows. */
export function changeOf(row: DiffRow | undefined): number | null {
  return row?.kind === 'added' || row?.kind === 'removed' ? row.change : null;
}

/** The row at `index` of the folded diff, when its window has loaded. */
function rowAt(loaded: LoadedRows, index: number): DiffRow | undefined {
  if (index < 0 || index >= loaded.total) return undefined;
  return loaded.window(Math.floor(index / DIFF_WINDOW_ROWS))?.[index % DIFF_WINDOW_ROWS];
}

/** The first row from `from` to `to` (exclusive) whose window has not loaded; -1 when none. */
function firstUnloaded(loaded: LoadedRows, from: number, to: number): number {
  for (let index = Math.floor(from / DIFF_WINDOW_ROWS); index * DIFF_WINDOW_ROWS < to; index++) {
    if (loaded.window(index) === undefined) return Math.max(from, index * DIFF_WINDOW_ROWS);
  }
  return -1;
}

/** The last row from `from` to `to` (exclusive) whose window has not loaded; -1 when none. */
function lastUnloaded(loaded: LoadedRows, from: number, to: number): number {
  for (let index = Math.floor((to - 1) / DIFF_WINDOW_ROWS); index >= 0 && (index + 1) * DIFF_WINDOW_ROWS > from; index--) {
    if (loaded.window(index) === undefined) return Math.min(to - 1, (index + 1) * DIFF_WINDOW_ROWS - 1);
  }
  return -1;
}

/** The loaded rows of `loaded` from row `from`, in order: their row and their change. */
function* rowChanges(loaded: LoadedRows, from = 0): Generator<{ position: number; change: number | null }> {
  for (const index of loaded.windows) {
    if ((index + 1) * DIFF_WINDOW_ROWS <= from) continue;
    const rows = loaded.window(index) ?? [];
    for (const [at, row] of rows.entries()) {
      const position = index * DIFF_WINDOW_ROWS + at;
      if (position >= from) yield { position, change: changeOf(row) };
    }
  }
}

/** Around change k: the last loaded row of an earlier change, its first, and the first of a later one. */
function bracket(loaded: LoadedRows, k: number) {
  let before = -1;
  let beforeChange = -1;
  let first = -1;
  for (const { position, change } of rowChanges(loaded)) {
    if (change === null) continue;
    if (change < k) {
      before = position;
      beforeChange = change;
    } else if (change === k) {
      if (first < 0) first = position;
    } else {
      return { before, beforeChange, first, after: position, afterChange: change };
    }
  }
  return { before, beforeChange, first, after: loaded.total, afterChange: -1 };
}

/**
 * The first row of change `k` (0 to `changes - 1`). When its rows have not loaded, the window to
 * read: next to the change before it, or, coming back from the change after it, next to that one.
 */
export function findChange(loaded: LoadedRows, changes: number, k: number): ChangeStart {
  if (!Number.isInteger(k) || k < 0 || k >= changes) return NONE;
  const { before, beforeChange, first, after, afterChange } = bracket(loaded, k);
  if (first >= 0) {
    // Change k may have begun in the window before, which has not loaded.
    return first === 0 || rowAt(loaded, first - 1) !== undefined ? { kind: 'found', row: first } : load(first - 1);
  }
  const forward = firstUnloaded(loaded, before + 1, after);
  if (forward < 0) return NONE;
  if (beforeChange !== k - 1 && afterChange === k + 1) return load(lastUnloaded(loaded, before + 1, after));
  return load(forward);
}

/**
 * A row's line on a side of the folded diff, or the last one it hides; `null` for a row without
 * that side (a removed row's new side, an added row's old side). 0 before the first row.
 */
function lastLine(row: DiffRow | null, side: 'new' | 'old'): number | null {
  if (row === null) return 0;
  switch (row.kind) {
    case 'context':
      return row[side];
    case 'fold':
      return row[side] + row.lines - 1;
    case 'added':
      return side === 'new' ? row.new : null;
    case 'removed':
      return side === 'old' ? row.old : null;
  }
}

/** The first line of a context or fold row on a side; `null` for a changed row. */
function firstLine(row: DiffRow, side: 'new' | 'old'): number | null {
  return row.kind === 'context' || row.kind === 'fold' ? row[side] : null;
}

/**
 * The lines change `k` covers, from its first row `start` (`findChange`), for the announcement.
 * New-side numbers when it adds lines, else old-side ones. It reads the rows around the change's
 * first and last row; when the last is not loaded, the window to read: next to the change after
 * it when that is known, the last window for the last change, else the next window of the change.
 *
 * A change at the very end of the diff that ends in a removed row is taken to add only the lines
 * among its loaded rows: the fake shell, like `similar`, puts a change's removed rows first.
 */
export function changeLines(loaded: LoadedRows, changes: number, k: number, start: number): ChangeLines {
  const first = rowAt(loaded, start);
  if (first === undefined) return load(start);
  const previous = start === 0 ? null : rowAt(loaded, start - 1);
  if (previous === undefined) return load(start - 1);
  if (changeOf(first) !== k || (previous !== null && changeOf(previous) === k)) return NONE;

  // The last loaded row of change k, and the first loaded row after it, which is not change k.
  let last = start;
  let beyond = loaded.total;
  for (const { position, change } of rowChanges(loaded, start + 1)) {
    if (change !== k) {
      beyond = position;
      break;
    }
    last = position;
  }
  if (last + 1 < beyond) {
    // The change goes on into rows that have not loaded.
    const next = rowAt(loaded, beyond);
    const nearBeyond = (next !== undefined && changeOf(next) === k + 1) || k === changes - 1;
    return load(nearBeyond ? beyond - 1 : last + 1);
  }

  const end = rowAt(loaded, last);
  const next = last + 1 < loaded.total ? rowAt(loaded, last + 1) ?? null : null;
  const beforeNew = lastLine(previous, 'new');
  const beforeOld = lastLine(previous, 'old');
  if (end === undefined || beforeNew === null || beforeOld === null) return NONE;

  const newFrom = first.kind === 'added' ? first.new : beforeNew + 1;
  let newTo = newFrom - 1;
  if (end.kind === 'added') newTo = end.new;
  else if (next !== null) newTo = (firstLine(next, 'new') ?? newFrom) - 1;
  else {
    for (let index = start; index <= last; index++) {
      const row = rowAt(loaded, index);
      if (row?.kind === 'added') newTo = row.new;
    }
  }
  if (newTo >= newFrom) return { kind: 'found', lines: { side: 'new', from: newFrom, to: newTo } };

  const oldFrom = first.kind === 'removed' ? first.old : beforeOld + 1;
  let oldTo = oldFrom;
  if (end.kind === 'removed') oldTo = end.old;
  else if (next !== null) oldTo = (firstLine(next, 'old') ?? oldFrom + 1) - 1;
  return { kind: 'found', lines: { side: 'old', from: oldFrom, to: Math.max(oldFrom, oldTo) } };
}

/** The current change kept within a diff of `changes` changes: the last when it has fewer now. */
export function clampChange(current: number, changes: number): number {
  return changes <= 0 ? 0 : Math.min(Math.max(current, 0), changes - 1);
}
