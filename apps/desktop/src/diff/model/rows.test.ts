// The region's rows over windows of the folded diff (handoff §6.3, §6.5; ipc-m2 §9.3): skeleton
// rows until a window answers, opened folds of any size loading in windows of their own, failed
// windows as one row, and windows whose header disagrees with the first window's.
import { describe, expect, it } from 'vitest';

import { DIFF_WINDOW_ROWS, FIRST_WINDOW, windowId } from '../../data/diff';
import type { DiffRow, DiffWindow } from '../../ipc';
import { answer, diskSide, failure, foldedRows, hashOf, textDiff, versionSide, windowRows } from '../test/diffs';
import {
  buildLayout,
  checkWindows,
  type FoldRow,
  identityOf,
  NOTHING_UNFOLDED,
  openFold,
  rowsWindowOf,
  runsOf,
  runWindows,
  type UnfoldedRun,
  type WindowRows,
} from './rows';

/** 45,000 rows: 5,000 changes, folds of 1,234 lines at row 0 and of 600 lines every seventh block. */
const BIG = foldedRows(5000, (block) => (block === 0 ? 1234 : block % 7 === 0 ? 600 : 20));

/** Window `index` of the folded diff. */
function rowsWindow(index: number): DiffWindow {
  return rowsWindowOf(index * DIFF_WINDOW_ROWS);
}

function unchanged(line: number, count: number): DiffWindow {
  return { kind: 'unchanged', line, count };
}

/** Windows of `rows` that answered, and windows that failed. */
function loaded(rows: readonly DiffRow[], windows: readonly DiffWindow[], failed: readonly DiffWindow[] = []): WindowRows {
  return {
    rows: new Map(windows.map((window) => [windowId(window), windowRows(rows, window)])),
    failed: new Map(failed.map((window) => [windowId(window), failure()])),
  };
}

function foldAt(rows: readonly DiffRow[], index: number): FoldRow {
  const row = rows[index];
  if (row?.kind !== 'fold') throw new Error(`row ${String(index)} is not a fold`);
  return row;
}

function runAt(rows: readonly DiffRow[], index: number): UnfoldedRun {
  const fold = foldAt(rows, index);
  return { row: index, old: fold.old, new: fold.new, lines: fold.lines };
}

describe('the header of each window', () => {
  it('names the content its rows belong to, whatever the revision or a hash still to come', () => {
    const diff = textDiff(BIG, FIRST_WINDOW);
    expect(identityOf({ ...diff, revision: 99 })).toBe(identityOf(diff));
    expect(identityOf({ ...diff, after: diskSide({ hash: hashOf('e') }) })).toBe(identityOf(diff));
    expect(identityOf(textDiff(BIG, rowsWindow(3)))).toBe(identityOf(diff));

    expect(identityOf({ ...diff, before: versionSide({ hash: hashOf('e') }) })).not.toBe(identityOf(diff));
    expect(identityOf({ ...diff, after: diskSide({ size: '9999' }) })).not.toBe(identityOf(diff));
    expect(identityOf(textDiff(BIG, FIRST_WINDOW, { text: { changes: 4999 } }))).not.toBe(identityOf(diff));
  });

  it("keeps the windows that agree with the first window's header and records the failed ones", () => {
    const first = answer(FIRST_WINDOW, textDiff(BIG, FIRST_WINDOW));
    const second = answer(rowsWindow(1), { ...textDiff(BIG, rowsWindow(1)), revision: 8 });
    const broken = failure();
    const third = answer(rowsWindow(2), undefined, { error: broken });
    // A refetch that failed keeps its earlier answer, which still shows.
    const fourth = answer(rowsWindow(3), textDiff(BIG, rowsWindow(3)), { error: failure() });

    const checked = checkWindows([first, second, third, fourth]);

    expect(checked.header).toBe(first.diff);
    expect(checked.identity).toBe(identityOf(textDiff(BIG, FIRST_WINDOW)));
    expect(checked.rows.get(windowId(rowsWindow(1)))).toHaveLength(DIFF_WINDOW_ROWS);
    expect(checked.rows.get(windowId(rowsWindow(1)))?.[0]).toEqual(BIG[500]);
    expect(checked.rows.has(windowId(rowsWindow(3)))).toBe(true);
    expect([...checked.failed]).toEqual([[windowId(rowsWindow(2)), broken]]);
    expect(checked.mismatched).toEqual([]);
    expect(checked.reload).toBe(false);
    // What it shows may be out of date: the pane says so.
    expect(checked.refreshFailed).toBe(fourth.error);
  });

  it('says a refresh failed, the first window’s too, unless the change is gone', () => {
    const shown = textDiff(BIG, FIRST_WINDOW);
    const damaged = failure('HistoryDamaged');
    expect(checkWindows([answer(FIRST_WINDOW, shown)]).refreshFailed).toBeNull();
    expect(checkWindows([answer(FIRST_WINDOW, shown, { error: damaged })]).refreshFailed).toBe(damaged);
    // NotFound: committed or undone; the host drops the row.
    expect(checkWindows([answer(FIRST_WINDOW, shown, { error: failure('NotFound') })]).refreshFailed).toBeNull();
    // A first fetch that failed is the window's failed row, not a refresh.
    expect(checkWindows([answer(FIRST_WINDOW, shown), answer(rowsWindow(1), undefined, { error: damaged })]).refreshFailed).toBeNull();
  });

  it('counts a window as failed when its refresh failed and its last answer is of other content', () => {
    const first = answer(FIRST_WINDOW, textDiff(BIG, FIRST_WINDOW));
    const old = textDiff(BIG, rowsWindow(1), { after: diskSide({ size: '9999' }) });
    const broken = failure();

    const checked = checkWindows([first, answer(rowsWindow(1), old, { error: broken })]);

    expect(checked.rows.has(windowId(rowsWindow(1)))).toBe(false);
    expect([...checked.failed]).toEqual([[windowId(rowsWindow(1)), broken]]);
    // Reading the whole diff again would only fail again: it waits for Try again.
    expect(checked.mismatched).toEqual([]);
    expect(checked.reload).toBe(false);
  });

  it('treats a window of other content as not loaded, and asks for the whole diff once nothing is in flight', () => {
    const first = answer(FIRST_WINDOW, textDiff(BIG, FIRST_WINDOW));
    const changed = textDiff(BIG, rowsWindow(1), { after: diskSide({ size: '9999' }) });

    const settled = checkWindows([first, answer(rowsWindow(1), changed)]);
    expect(settled.rows.has(windowId(rowsWindow(1)))).toBe(false);
    expect(settled.mismatched).toEqual([rowsWindow(1)]);
    expect(settled.reload).toBe(true);

    // A refresh still under way may bring them back in line: wait for it.
    expect(checkWindows([first, answer(rowsWindow(1), changed, { fetching: true })]).reload).toBe(false);
    expect(checkWindows([{ ...first, fetching: true }, answer(rowsWindow(1), changed)]).reload).toBe(false);
  });

  it('cannot check anything before the first window answers', () => {
    const checked = checkWindows([answer(FIRST_WINDOW, undefined), answer(rowsWindow(1), textDiff(BIG, rowsWindow(1)))]);
    expect(checked.header).toBeUndefined();
    expect(checked.identity).toBeNull();
    expect(checked.rows.size).toBe(0);
    expect(checked.mismatched).toEqual([]);
    expect(checked.reload).toBe(false);
  });
});

describe('the layout of a 45,000-row diff', () => {
  it('shows loaded rows, skeleton rows for windows still to come, and asks for the windows a range needs', () => {
    expect(BIG).toHaveLength(45_000);
    const layout = buildLayout(BIG.length, [], loaded(BIG, [FIRST_WINDOW, rowsWindow(89)]));

    expect(layout.count).toBe(45_000);
    expect(layout.rowAt(0)).toEqual({ kind: 'row', key: 'row 0', row: BIG[0], index: 0 });
    expect(layout.rowAt(500)).toEqual({ kind: 'pending', key: 'row 500', window: rowsWindow(1) });
    expect(layout.rowAt(44_999)).toEqual({ kind: 'row', key: 'row 44999', row: BIG[44_999], index: 44_999 });
    expect(layout.indexOf(30_000)).toBe(30_000);

    expect(layout.windowsFor({ start: 30_000, end: 30_040 }, 100)).toEqual([rowsWindow(59), rowsWindow(60)]);
    expect(layout.windowsFor({ start: 0, end: 30 })).toEqual([FIRST_WINDOW]);
    expect(layout.windowsFor({ start: 44_990, end: 45_100 }, 50)).toEqual([rowsWindow(89)]);
  });

  it('keeps a row its key while its window loads', () => {
    const before = buildLayout(BIG.length, [], loaded(BIG, [FIRST_WINDOW]));
    const after = buildLayout(BIG.length, [], loaded(BIG, [FIRST_WINDOW, rowsWindow(40)]));
    expect(before.rowAt(20_123).kind).toBe('pending');
    expect(after.rowAt(20_123)).toMatchObject({ kind: 'row', row: BIG[20_123], index: 20_123 });
    expect(after.rowAt(20_123).key).toBe(before.rowAt(20_123).key);
  });

  it('turns an opened fold of 1,234 lines into its lines, loaded in windows of 500 as they show', () => {
    const run = runAt(BIG, 0);
    expect(run.lines).toBe(1234);
    expect(runWindows(run)).toEqual([unchanged(1, 500), unchanged(501, 500), unchanged(1001, 234)]);
    const layout = buildLayout(BIG.length, [run], loaded(BIG, [FIRST_WINDOW, unchanged(1, 500)]));

    expect(layout.count).toBe(45_000 + 1233);
    expect(layout.rowAt(0)).toEqual({ kind: 'row', key: 'line 0 0', row: { kind: 'context', old: 1, new: 1, text: 'line 1' }, index: null });
    expect(layout.rowAt(499)).toMatchObject({ kind: 'row', row: { new: 500 } });
    expect(layout.rowAt(500)).toEqual({ kind: 'pending', key: 'line 0 500', window: unchanged(501, 500) });
    expect(layout.rowAt(1233)).toEqual({ kind: 'pending', key: 'line 0 1233', window: unchanged(1001, 234) });
    expect(layout.rowAt(1234)).toEqual({ kind: 'row', key: 'row 1', row: BIG[1], index: 1 });

    expect(layout.indexOf(0)).toBe(0);
    expect(layout.indexOf(1)).toBe(1234);
    expect(layout.indexOf(44_999)).toBe(44_999 + 1233);
    expect([0, 700, 1233, 1234, 1300].map(layout.rowOf)).toEqual([0, 0, 0, 1, 67]);
    expect(layout.windowsFor({ start: 400, end: 1300 })).toEqual([
      unchanged(1, 500),
      unchanged(501, 500),
      unchanged(1001, 234),
      FIRST_WINDOW,
    ]);

    const more = buildLayout(BIG.length, [run], loaded(BIG, [FIRST_WINDOW, unchanged(1, 500), unchanged(501, 500)]));
    expect(more.rowAt(500)).toMatchObject({ kind: 'row', key: 'line 0 500', row: { new: 501, old: 501 } });
  });

  it('places rows after several opened folds by the lines each one adds', () => {
    // Folds at rows 0 (1,234 lines) and 63 (600) in the first window, and 504 (600) in the second.
    const runs = [runAt(BIG, 504), runAt(BIG, 0), runAt(BIG, 63)];
    expect(runs.map((run) => run.lines)).toEqual([600, 1234, 600]);
    const layout = buildLayout(BIG.length, runs, loaded(BIG, [FIRST_WINDOW]));

    expect(layout.count).toBe(45_000 + 1233 + 599 + 599);
    expect(layout.indexOf(63)).toBe(63 + 1233);
    expect(layout.indexOf(64)).toBe(64 + 1233 + 599);
    expect(layout.indexOf(504)).toBe(504 + 1233 + 599);
    expect(layout.indexOf(505)).toBe(505 + 1233 + 599 + 599);
    expect(layout.rowAt(504 + 1233 + 599)).toMatchObject({ kind: 'pending', key: 'line 504 0' });
    expect(layout.rowAt(505 + 1233 + 599 + 599)).toEqual({ kind: 'pending', key: 'row 505', window: rowsWindow(1) });
  });

  it('leaves shut a fold that the loaded rows do not have', () => {
    const stale: UnfoldedRun = { row: 1, old: 1, new: 1, lines: 900 };
    const outside: UnfoldedRun = { row: 45_000, old: 1, new: 1, lines: 900 };
    expect(buildLayout(BIG.length, [stale, outside], loaded(BIG, [FIRST_WINDOW])).count).toBe(45_000);
  });

  it('collapses a window whose first fetch failed into one row and keeps asking for it', () => {
    const layout = buildLayout(BIG.length, [], loaded(BIG, [FIRST_WINDOW], [rowsWindow(1)]));

    expect(layout.count).toBe(45_000 - 499);
    expect(layout.rowAt(500)).toMatchObject({ kind: 'failed', key: `failed ${windowId(rowsWindow(1))}`, window: rowsWindow(1) });
    expect(layout.rowAt(501)).toEqual({ kind: 'pending', key: 'row 1000', window: rowsWindow(2) });
    expect(layout.indexOf(700)).toBe(500);
    expect(layout.indexOf(1000)).toBe(501);
    expect([499, 500, 501, 502].map(layout.rowOf)).toEqual([499, 500, 1000, 1001]);
    expect(layout.windowsFor({ start: 495, end: 505 })).toEqual([FIRST_WINDOW, rowsWindow(1), rowsWindow(2)]);
  });

  it('asks for the same windows around a window that failed as around one that loaded', () => {
    // Rows 1,200 to 1,230 are in window 2; 500 rows each way reach windows 1 and 3.
    const shown = buildLayout(BIG.length, [], loaded(BIG, [FIRST_WINDOW, rowsWindow(1), rowsWindow(2), rowsWindow(3)]));
    expect(shown.windowsFor({ start: 1_200, end: 1_230 }, 500)).toEqual([rowsWindow(1), rowsWindow(2), rowsWindow(3)]);

    // All three failed: one row each, and the margin still counts the 500 rows each stands for.
    const failed = buildLayout(BIG.length, [], loaded(BIG, [FIRST_WINDOW], [rowsWindow(1), rowsWindow(2), rowsWindow(3)]));
    const row = failed.indexOf(1_200);
    expect(failed.rowAt(row)).toMatchObject({ kind: 'failed', window: rowsWindow(2) });
    expect(failed.windowsFor({ start: row, end: row }, 500)).toEqual([rowsWindow(1), rowsWindow(2), rowsWindow(3)]);
    // Rows that load after a failed window count as themselves.
    expect(failed.windowsFor({ start: row + 2, end: row + 30 }, 500)).toEqual([rowsWindow(3), rowsWindow(4), rowsWindow(5)]);
  });

  it('finds a row by its key in any layout, without walking along an opened fold', () => {
    const run = runAt(BIG, 0);
    const layouts = [
      buildLayout(BIG.length, [], loaded(BIG, [FIRST_WINDOW])),
      buildLayout(BIG.length, [run], loaded(BIG, [FIRST_WINDOW, unchanged(1, 500)], [unchanged(501, 500), rowsWindow(3)])),
    ];
    for (const layout of layouts) {
      for (const index of [0, 1, 499, 500, 501, 735, 1233, 1234, 1500, 2000, layout.count - 1]) {
        expect(layout.indexOfKey(layout.rowAt(index).key)).toBe(index);
      }
    }
    const [shut, opened] = layouts;
    if (shut === undefined || opened === undefined) throw new Error('no layouts');
    // The fold's row is gone once it opens, and its lines are not there while it is shut.
    expect(shut.indexOfKey('row 0')).toBe(0);
    expect(opened.indexOfKey('row 0')).toBeNull();
    expect(shut.indexOfKey('line 0 400')).toBeNull();
    expect(opened.indexOfKey('line 0 400')).toBe(400);
    // Line 700 is in the failed window (lines 500 to 999), which shows as one row of its own.
    expect(opened.rowAt(500)).toMatchObject({ kind: 'failed', window: unchanged(501, 500) });
    expect(opened.indexOfKey('line 0 700')).toBeNull();
    expect(opened.indexOfKey(`failed ${windowId(unchanged(501, 500))}`)).toBe(500);
    expect(opened.indexOfKey('line 0 1100')).toBe(601);
    expect(opened.indexOfKey(`failed ${windowId(rowsWindow(3))}`)).toBe(opened.indexOf(1_500));
    expect(opened.indexOfKey('row 1600')).toBeNull();
    for (const key of ['row 45000', 'row -1', 'row x', 'line 1 0', 'line 0 1234', 'lead', `failed ${windowId(rowsWindow(4))}`]) {
      expect(opened.indexOfKey(key)).toBeNull();
    }
  });

  it('collapses a failed window of an opened fold into one row', () => {
    const run = runAt(BIG, 0);
    const layout = buildLayout(BIG.length, [run], loaded(BIG, [FIRST_WINDOW, unchanged(1, 500)], [unchanged(501, 500)]));

    expect(layout.count).toBe(45_000 - 1 + 500 + 1 + 234);
    expect(layout.rowAt(500)).toMatchObject({ kind: 'failed', window: unchanged(501, 500) });
    expect(layout.rowAt(501)).toEqual({ kind: 'pending', key: 'line 0 1000', window: unchanged(1001, 234) });
    expect(layout.indexOf(1)).toBe(735);
  });

  it('has no rows for an empty diff and refuses rows it does not have', () => {
    const empty = buildLayout(0, [], loaded([], []));
    expect(empty.count).toBe(0);
    expect(empty.windowsFor({ start: 0, end: 20 })).toEqual([]);
    expect(empty.indexOf(5)).toBe(0);
    expect(() => buildLayout(BIG.length, [], loaded(BIG, [])).rowAt(45_000)).toThrow(RangeError);
    expect(() => buildLayout(BIG.length, [], loaded(BIG, [])).rowOf(-1)).toThrow(RangeError);
  });
});

describe('opened folds', () => {
  it('opens each fold once, in order, for the content they were opened in', () => {
    const first = openFold(NOTHING_UNFOLDED, 'A', 63, foldAt(BIG, 63));
    expect(first).toEqual({ identity: 'A', runs: [runAt(BIG, 63)] });
    expect(openFold(first, 'A', 63, foldAt(BIG, 63))).toBe(first);
    const both = openFold(first, 'A', 0, foldAt(BIG, 0));
    expect(both.runs.map((run) => run.row)).toEqual([0, 63]);

    expect(runsOf(both, 'A')).toBe(both.runs);
    expect(runsOf(both, 'B')).toEqual([]);
    expect(runsOf(both, null)).toEqual([]);
    expect(openFold(both, 'B', 9, foldAt(BIG, 9))).toEqual({ identity: 'B', runs: [runAt(BIG, 9)] });
  });

  it('close when the content changes: the rows go back to the folded diff and stale windows wait', () => {
    const first = answer(FIRST_WINDOW, textDiff(BIG, FIRST_WINDOW));
    const opened = openFold(NOTHING_UNFOLDED, checkWindows([first]).identity ?? '', 0, foldAt(BIG, 0));

    // The file was saved: the first window answers for the new content, the second still for the old.
    const saved = { after: diskSide({ size: '2200' }) };
    const checked = checkWindows([
      answer(FIRST_WINDOW, textDiff(BIG, FIRST_WINDOW, saved)),
      answer(rowsWindow(1), textDiff(BIG, rowsWindow(1))),
    ]);
    const runs = runsOf(opened, checked.identity);
    const layout = buildLayout(BIG.length, runs, checked);

    expect(runs).toEqual([]);
    expect(layout.count).toBe(45_000);
    expect(layout.rowAt(0)).toMatchObject({ kind: 'row', key: 'row 0', row: BIG[0] });
    expect(layout.rowAt(600)).toMatchObject({ kind: 'pending', window: rowsWindow(1) });
    expect(checked.reload).toBe(true);
  });
});
