// Finding change k among loaded windows, the window to load when it lies beyond them, and the
// lines it covers for "Change 2 of 5, lines 12 to 14" (handoff §6.2, §6.9).
import { describe, expect, it } from 'vitest';

import { DIFF_WINDOW_ROWS, windowId } from '../../data/diff';
import type { DiffRow, DiffWindow } from '../../ipc';
import { failure, foldedRows, windowRows } from '../test/diffs';
import { changeLines, clampChange, findChange, type LoadedRows, loadedRows } from './changes';
import { rowsWindowOf } from './rows';

/** 45,000 rows, nine a change: change b's removed row is 9b + 4, its added row 9b + 5. */
const BIG = foldedRows(5000);

function rowsWindow(index: number): DiffWindow {
  return rowsWindowOf(index * DIFF_WINDOW_ROWS);
}

/** `rows` with the windows `indices` loaded. */
function loaded(rows: readonly DiffRow[], indices: readonly number[]): LoadedRows {
  const windows = indices.map(rowsWindow);
  return loadedRows(rows.length, {
    rows: new Map(windows.map((window) => [windowId(window), windowRows(rows, window)])),
    failed: new Map(),
  });
}

function newLine(rows: readonly DiffRow[], index: number): number {
  const row = rows[index];
  if (row?.kind !== 'added' && row?.kind !== 'context') throw new Error(`row ${String(index)} has no new line`);
  return row.new;
}

const context = (old: number, line: number): DiffRow => ({ kind: 'context', old, new: line, text: '' });
const removed = (old: number, change: number): DiffRow => ({ kind: 'removed', old, text: '', marks: [], change });
const added = (line: number, change: number): DiffRow => ({ kind: 'added', new: line, text: '', marks: [], change });

/** `count` rows made by `row(i)` for i from 0. */
function run(count: number, row: (index: number) => DiffRow): DiffRow[] {
  return Array.from({ length: count }, (_, index) => row(index));
}

describe('the loaded windows', () => {
  it('are the rows windows that answered, by index', () => {
    const unchanged: DiffWindow = { kind: 'unchanged', line: 1, count: 20 };
    const rows = loadedRows(BIG.length, {
      rows: new Map([
        [windowId(rowsWindow(3)), windowRows(BIG, rowsWindow(3))],
        [windowId(rowsWindow(0)), windowRows(BIG, rowsWindow(0))],
        [windowId(unchanged), windowRows(BIG, unchanged)],
      ]),
      failed: new Map([[windowId(rowsWindow(1)), failure()]]),
    });
    expect(rows.total).toBe(45_000);
    expect(rows.windows).toEqual([0, 3]);
    expect(rows.window(3)?.[0]).toEqual(BIG[1500]);
    expect(rows.window(1)).toBeUndefined();
  });
});

describe('finding change k', () => {
  it('finds a change in the loaded rows, and nothing outside the diff', () => {
    const rows = loaded(BIG, [0]);
    expect(findChange(rows, 5000, 0)).toEqual({ kind: 'found', row: 4 });
    expect(findChange(rows, 5000, 3)).toEqual({ kind: 'found', row: 31 });
    expect(findChange(rows, 5000, 5000)).toEqual({ kind: 'none' });
    expect(findChange(rows, 5000, -1)).toEqual({ kind: 'none' });
  });

  it('finds a change that a window boundary cuts in two from its first row', () => {
    // Change 55: removed at row 499, the last of the first window; added at row 500.
    expect(findChange(loaded(BIG, [0]), 5000, 55)).toEqual({ kind: 'found', row: 499 });
    expect(findChange(loaded(BIG, [0, 1]), 5000, 55)).toEqual({ kind: 'found', row: 499 });
    // Seen only from its second row, it may have begun in the window before.
    expect(findChange(loaded(BIG, [1]), 5000, 55)).toEqual({ kind: 'load', window: rowsWindow(0) });
  });

  it('loads the window after the change before it: F7 past the loaded rows', () => {
    const first = loaded(BIG, [0]);
    expect(findChange(first, 5000, 56)).toEqual({ kind: 'load', window: rowsWindow(1) });
    expect(findChange(loaded(BIG, [0, 1]), 5000, 56)).toEqual({ kind: 'found', row: 508 });
  });

  it('picks the window next to the change it comes from when change k falls between loaded windows', () => {
    // Windows 0 and 5 (rows 2,500 to 2,999) loaded, 1 to 4 not.
    const rows = loaded(BIG, [0, 5]);
    // Change 60 (row 544): only the changes before it are near, so the window after them.
    expect(findChange(rows, 5000, 60)).toEqual({ kind: 'load', window: rowsWindow(1) });
    // Change 277 (row 2,497), back from change 278 (row 2,506): the window before that one.
    expect(findChange(rows, 5000, 277)).toEqual({ kind: 'load', window: rowsWindow(4) });
    // Change 276: neither neighbour is loaded, so forward from what is known.
    expect(findChange(rows, 5000, 276)).toEqual({ kind: 'load', window: rowsWindow(1) });
    expect(findChange(loaded(BIG, [0, 4, 5]), 5000, 277)).toEqual({ kind: 'found', row: 2497 });
  });

  it('finds the last change of 45,000 rows from the last window', () => {
    expect(findChange(loaded(BIG, [0, 89]), 5000, 4999)).toEqual({ kind: 'found', row: 44_995 });
  });

  it('finds nothing when the loaded rows leave no room for the change', () => {
    // Rows of changes 0 and 1 only, all loaded, but the header says there are three.
    const rows = foldedRows(2);
    expect(findChange(loaded(rows, [0]), 3, 2)).toEqual({ kind: 'none' });
  });
});

describe('the lines of change k', () => {
  it('reads new-side numbers when the change adds lines', () => {
    const rows = loaded(BIG, [0]);
    const line = newLine(BIG, 32);
    expect(changeLines(rows, 5000, 3, 31)).toEqual({ kind: 'found', lines: { side: 'new', from: line, to: line } });
  });

  it('reads old-side numbers for a change that only removes lines', () => {
    const rows: DiffRow[] = [context(1, 1), removed(2, 0), removed(3, 0), context(4, 2), context(5, 3), added(4, 1), added(5, 1), context(6, 6)];
    const all = loaded(rows, [0]);
    expect(changeLines(all, 2, 0, 1)).toEqual({ kind: 'found', lines: { side: 'old', from: 2, to: 3 } });
    expect(changeLines(all, 2, 1, 5)).toEqual({ kind: 'found', lines: { side: 'new', from: 4, to: 5 } });
  });

  it('reads changes at the very start and the very end of the diff', () => {
    const rows: DiffRow[] = [
      removed(1, 0),
      added(1, 0),
      ...run(7, (index) => context(index + 2, index + 2)),
      { kind: 'fold', old: 9, new: 9, lines: 30 },
      ...run(3, (index) => context(index + 39, index + 39)),
      removed(42, 1),
    ];
    const all = loaded(rows, [0]);
    expect(changeLines(all, 2, 0, 0)).toEqual({ kind: 'found', lines: { side: 'new', from: 1, to: 1 } });
    expect(changeLines(all, 2, 1, 13)).toEqual({ kind: 'found', lines: { side: 'old', from: 42, to: 42 } });
  });

  it('reads a change that a window boundary cuts, once both windows have loaded', () => {
    const line = newLine(BIG, 500);
    expect(changeLines(loaded(BIG, [0]), 5000, 55, 499)).toEqual({ kind: 'load', window: rowsWindow(1) });
    expect(changeLines(loaded(BIG, [0, 1]), 5000, 55, 499)).toEqual({ kind: 'found', lines: { side: 'new', from: line, to: line } });
  });

  it('reads the last change of a long added file from the last window, not every window between', () => {
    // A context line, 1,200 added lines (one change), three context lines: windows 0, 1 and 2.
    const rows: DiffRow[] = [context(1, 1), ...run(1200, (index) => added(index + 2, 0)), ...run(3, (index) => context(index + 2, index + 1202))];
    expect(findChange(loaded(rows, [0]), 1, 0)).toEqual({ kind: 'found', row: 1 });
    expect(changeLines(loaded(rows, [0]), 1, 0, 1)).toEqual({ kind: 'load', window: rowsWindow(2) });
    expect(changeLines(loaded(rows, [0, 2]), 1, 0, 1)).toEqual({ kind: 'found', lines: { side: 'new', from: 2, to: 1201 } });
  });

  it('reads a long change before another from the window next to that one, else window by window', () => {
    // Change 0 adds 1,490 lines (rows 1 to 1,490); change 1 removes rows 1,498 to 1,502, across
    // the boundary of window 3 (row 1,500).
    const rows: DiffRow[] = [
      context(1, 1),
      ...run(1490, (index) => added(index + 2, 0)),
      ...run(3, (index) => context(index + 2, index + 1492)),
      { kind: 'fold', old: 5, new: 1495, lines: 10 },
      ...run(3, (index) => context(index + 15, index + 1505)),
      ...run(5, (index) => removed(index + 18, 1)),
      ...run(3, (index) => context(index + 23, index + 1508)),
    ];
    expect(rows).toHaveLength(1506);
    expect(changeLines(loaded(rows, [0, 3]), 2, 0, 1)).toEqual({ kind: 'load', window: rowsWindow(2) });
    expect(changeLines(loaded(rows, [0]), 2, 0, 1)).toEqual({ kind: 'load', window: rowsWindow(1) });
    expect(changeLines(loaded(rows, [0, 2, 3]), 2, 0, 1)).toEqual({ kind: 'found', lines: { side: 'new', from: 2, to: 1491 } });

    expect(findChange(loaded(rows, [0, 3]), 2, 1)).toEqual({ kind: 'load', window: rowsWindow(2) });
    expect(findChange(loaded(rows, [0, 2, 3]), 2, 1)).toEqual({ kind: 'found', row: 1498 });
    expect(changeLines(loaded(rows, [0, 2, 3]), 2, 1, 1498)).toEqual({ kind: 'found', lines: { side: 'old', from: 18, to: 22 } });
  });

  it('loads the rows around a change before reading it, and refuses a row that does not start it', () => {
    expect(changeLines(loaded(BIG, [1]), 5000, 56, 508)).toEqual({ kind: 'found', lines: { side: 'new', from: newLine(BIG, 509), to: newLine(BIG, 509) } });
    expect(changeLines(loaded(BIG, [0]), 5000, 56, 508)).toEqual({ kind: 'load', window: rowsWindow(1) });
    expect(changeLines(loaded(BIG, [1]), 5000, 55, 500)).toEqual({ kind: 'load', window: rowsWindow(0) });
    expect(changeLines(loaded(BIG, [0]), 5000, 3, 32)).toEqual({ kind: 'none' });
    expect(changeLines(loaded(BIG, [0]), 5000, 4, 31)).toEqual({ kind: 'none' });
  });
});

describe('the current change', () => {
  it('stays within the changes a new answer has', () => {
    expect(clampChange(3, 5)).toBe(3);
    expect(clampChange(7, 5)).toBe(4);
    expect(clampChange(-1, 5)).toBe(0);
    expect(clampChange(2, 0)).toBe(0);
  });
});
