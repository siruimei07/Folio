// The rows the diff region shows (handoff workspace-history §6.3, §6.5; ipc-m2 §9.3), from the
// windows of the folded diff that have loaded. Pure: the pane reads windows through
// `useDiffWindows` (data/diff.ts) and builds a layout from them on every answer.
//
// - The folded diff has `TextDiff.rows` rows, read in windows of `DIFF_WINDOW_ROWS` aligned on
//   multiples of it. A window that has not answered shows its rows as skeleton lines; one whose
//   first fetch failed collapses into one row that offers to try again.
// - Opening a fold turns its row into all of its hidden lines at once ("expands that run in
//   place", §6.5). Their text loads in `unchanged` windows of up to `DIFF_WINDOW_ROWS` lines as
//   they scroll into view. Display indices map to rows of the folded diff and lines of opened
//   folds through prefix sums over the segments below (`DiffLayout`).
// - Every window answers with the whole header. A window whose header names other content than
//   the first window's (the file changed between the two answers) counts as not loaded, and once
//   nothing is in flight the pane reads the whole diff again (`CheckedWindows.reload`). Opened
//   folds belong to the content they were opened in (`Unfolded`), so they close when it changes.
// - A refresh that fails keeps the window's last answer. It still shows when it is of the header's
//   content, and the pane says it may be out of date (`CheckedWindows.refreshFailed`); else the
//   window counts as failed.
import { DIFF_WINDOW_ROWS, type DiffWindowAnswer, FIRST_WINDOW, uniqueWindows, windowId } from '../../data/diff';
import type { IpcFailure } from '../../data/errors';
import type { RowRange } from '../../data/paged';
import type { Diff, DiffRow, DiffSide, DiffWindow, TextDiff } from '../../ipc';

/** A fold row of the folded diff: `lines` hidden unchanged lines from these numbers. */
export type FoldRow = Extract<DiffRow, { kind: 'fold' }>;

/** A fold the user opened: its row in the folded diff and what it hides. */
export interface UnfoldedRun {
  /** The fold's row in the folded diff. */
  row: number;
  /** The first hidden line on each side. */
  old: number;
  new: number;
  lines: number;
}

/** The lines of a text or Word diff; `null` for every other content. */
export function textOf(diff: Diff | undefined): TextDiff | null {
  const content = diff?.content;
  return content?.kind === 'text' || content?.kind === 'word' ? content.text : null;
}

/** The window of the folded diff that holds row `row`. */
export function rowsWindowOf(row: number): DiffWindow {
  return { kind: 'rows', offset: Math.floor(row / DIFF_WINDOW_ROWS) * DIFF_WINDOW_ROWS, limit: DIFF_WINDOW_ROWS };
}

/** The `unchanged` windows that read an opened fold's lines, in order. */
export function runWindows(run: UnfoldedRun): Extract<DiffWindow, { kind: 'unchanged' }>[] {
  const windows: Extract<DiffWindow, { kind: 'unchanged' }>[] = [];
  for (let from = 0; from < run.lines; from += DIFF_WINDOW_ROWS) {
    windows.push({ kind: 'unchanged', line: run.new + from, count: Math.min(DIFF_WINDOW_ROWS, run.lines - from) });
  }
  return windows;
}

// ---- header identity

/**
 * A side as far as it decides the rows. A version is named by its hash; the file on the disk only
 * by its size, since its hash is `null` until it is hashed and arrives later for the same content.
 * A save that keeps the size and the counts between two answers goes unnoticed here, but sends
 * WorkspaceChanged, which reads every shown window again.
 */
function sideId(side: DiffSide | null) {
  if (side === null) return null;
  return side.commit === null ? ['disk', side.size] : [side.commit, side.hash, side.size];
}

/**
 * What a diff's rows depend on, as text: two answers with equal identities number their rows the
 * same. Not the catalog revision, which changes with any file of the library.
 */
export function identityOf(diff: Diff): string {
  const text = textOf(diff);
  return JSON.stringify([
    diff.content.kind,
    sideId(diff.before),
    sideId(diff.after),
    text && [text.rows, text.changes, text.added, text.removed, text.approximate, text.lineEndings, text.encoding],
  ]);
}

/** The rows of the windows that loaded, and the windows that failed. */
export interface WindowRows {
  /** By `windowId`: the rows of each window that answered for the first window's content. */
  rows: ReadonlyMap<string, readonly DiffRow[]>;
  /**
   * By `windowId`: why a window with nothing to show failed: its first fetch, or a refresh of an
   * answer for other content than the header's.
   */
  failed: ReadonlyMap<string, IpcFailure>;
}

export interface CheckedWindows extends WindowRows {
  /** The first window's answer: the header and the content kind. */
  header: Diff | undefined;
  /** `identityOf(header)`; `null` until it arrives. */
  identity: string | null;
  /** Windows whose answer is of other content than the header's: not loaded. */
  mismatched: readonly DiffWindow[];
  /** Some window disagrees with the header and nothing is in flight: read the whole diff again. */
  reload: boolean;
  /**
   * Why the refresh of a window that still shows its last answer failed, the first window's
   * included: what the pane shows may be out of date. `null` when none failed, and for
   * `NotFound`, which means the change is gone (committed, or undone) and its host drops the row.
   */
  refreshFailed: IpcFailure | null;
}

/** Checks each window's header against the first window's (`useDiffWindows().windows`). */
export function checkWindows(answers: readonly DiffWindowAnswer[]): CheckedWindows {
  const firstId = windowId(FIRST_WINDOW);
  const header = answers.find((answer) => windowId(answer.window) === firstId)?.diff;
  const identity = header === undefined ? null : identityOf(header);
  const rows = new Map<string, readonly DiffRow[]>();
  const failed = new Map<string, IpcFailure>();
  const mismatched: DiffWindow[] = [];
  let refreshFailed: IpcFailure | null = null;
  for (const { window, diff, error } of answers) {
    const id = windowId(window);
    if (diff === undefined) {
      if (error !== null) failed.set(id, error);
    } else if (identity !== null && identityOf(diff) === identity) {
      rows.set(id, textOf(diff)?.window ?? []);
      if (error !== null && error.error.code !== 'NotFound') refreshFailed ??= error;
    } else if (identity !== null) {
      // An answer for other content whose refresh failed has nothing to show and nothing to wait
      // for: reading the diff again would only fail again.
      if (error === null) mismatched.push(window);
      else failed.set(id, error);
    }
  }
  const reload = mismatched.length > 0 && answers.every((answer) => !answer.fetching);
  return { header, identity, rows, failed, mismatched, reload, refreshFailed };
}

// ---- opened folds

/** The folds the user opened, with the content they were opened in. */
export interface Unfolded {
  identity: string | null;
  runs: readonly UnfoldedRun[];
}

export const NOTHING_UNFOLDED: Unfolded = { identity: null, runs: [] };

/** The folds open in the content `identity` names: none once the content changed. */
export function runsOf(state: Unfolded, identity: string | null): readonly UnfoldedRun[] {
  return identity !== null && state.identity === identity ? state.runs : [];
}

/** `state` with the fold at row `row` of the content `identity` names opened. */
export function openFold(state: Unfolded, identity: string, row: number, fold: FoldRow): Unfolded {
  const runs = runsOf(state, identity);
  if (runs.some((run) => run.row === row)) return state;
  const run: UnfoldedRun = { row, old: fold.old, new: fold.new, lines: fold.lines };
  return { identity, runs: [...runs, run].sort((a, b) => a.row - b.row) };
}

// ---- layout

/** A row of the region. `key` stays the same while a row loads, so the virtualiser keeps it. */
export type DisplayRow =
  /** `index`: its row in the folded diff; `null` for a line of an opened fold. */
  | { kind: 'row'; key: string; row: DiffRow; index: number | null }
  /** Its window has not answered yet: a skeleton line. */
  | { kind: 'pending'; key: string; window: DiffWindow }
  /** The window's first fetch failed: one row for the whole window, with "Try again". */
  | { kind: 'failed'; key: string; window: DiffWindow; error: IpcFailure };

export interface DiffLayout {
  /** Rows in the region. */
  count: number;
  /** The row at a display index from 0 to `count - 1`. */
  rowAt: (index: number) => DisplayRow;
  /** The display index of a row of the folded diff; an opened fold's first line for its row. */
  indexOf: (row: number) => number;
  /**
   * The row of the folded diff a display row stands for: its own, the fold's for the lines of an
   * opened fold, the window's first row for a failed window. `indexOf` of it is that display row,
   * or the first of the fold's lines or failed rows it belongs to.
   */
  rowOf: (index: number) => number;
  /**
   * The display index of the row with this `DisplayRow.key`, `null` when no row has it (its fold
   * closed or opened, its window failed or was tried again). It finds a row again in another
   * layout, without a walk along the lines of an opened fold.
   */
  indexOfKey: (key: string) => number | null;
  /**
   * The windows the display rows `range` shows need, widened by `margin` rows each way, in display
   * order: those loaded stay asked for, the others load. A failed window's row counts as the rows
   * it stands for, so a window that fails asks for no other window.
   */
  windowsFor: (range: RowRange, margin?: number) => DiffWindow[];
}

/** What a run of display rows shows; one window answers for all of it. */
type SegmentContent =
  /** Rows of the folded diff from row `from`; the window's `rows` count from row `base`. */
  | { kind: 'rows'; from: number; base: number; rows: readonly DiffRow[] | undefined }
  /** One `unchanged` window of an opened fold: its lines from the fold's line `from`. */
  | { kind: 'lines'; run: UnfoldedRun; from: number; rows: readonly DiffRow[] | undefined }
  /** A window whose first fetch failed, as one row. */
  | { kind: 'failed'; error: IpcFailure };

type Segment = SegmentContent & {
  /** Display index of its first row: the prefix sum of the segments before it. */
  start: number;
  length: number;
  /** Its rows once its window answers: `length`, or all of a failed window's rows. */
  size: number;
  /** The rows of the folded diff it stands for, `serverTo` exclusive. */
  serverFrom: number;
  serverTo: number;
  window: DiffWindow;
};

/** The opened folds that can apply: within the diff, at most once each, in order. */
function usableRuns(runs: readonly UnfoldedRun[], total: number): UnfoldedRun[] {
  const seen = new Set<number>();
  return [...runs]
    .filter((run) => {
      if (run.row < 0 || run.row >= total || run.lines < 1 || seen.has(run.row)) return false;
      seen.add(run.row);
      return true;
    })
    .sort((a, b) => a.row - b.row);
}

/**
 * The region's rows: the `total` rows of the folded diff, each opened fold of `runs` replaced by its
 * lines, as `windows` has them (`checkWindows`).
 */
export function buildLayout(total: number, runs: readonly UnfoldedRun[], windows: WindowRows): DiffLayout {
  const segments: Segment[] = [];
  let display = 0;
  const add = (segment: Segment) => {
    segments.push(segment);
    display += segment.length;
  };
  const opened = usableRuns(runs, total);
  let next = 0;
  for (let offset = 0; offset < total; offset += DIFF_WINDOW_ROWS) {
    const window = rowsWindowOf(offset);
    const id = windowId(window);
    const end = Math.min(total, offset + DIFF_WINDOW_ROWS);
    const rows = windows.rows.get(id);
    const inWindow: UnfoldedRun[] = [];
    for (let run = opened[next]; run !== undefined && run.row < end; run = opened[++next]) {
      // A loaded window without a fold there says the fold is not this content's: it stays shut.
      if (rows === undefined || rows[run.row - offset]?.kind === 'fold') inWindow.push(run);
    }
    const error = rows === undefined ? windows.failed.get(id) : undefined;
    if (error !== undefined) {
      add({ kind: 'failed', error, start: display, length: 1, size: end - offset, serverFrom: offset, serverTo: end, window });
      continue;
    }
    const addRows = (from: number, to: number) => {
      const length = to - from;
      add({ kind: 'rows', from, base: offset, rows, start: display, length, size: length, serverFrom: from, serverTo: to, window });
    };
    let cursor = offset;
    for (const run of inWindow) {
      if (run.row > cursor) addRows(cursor, run.row);
      runWindows(run).forEach((lines, index) => {
        const linesId = windowId(lines);
        const answer = windows.rows.get(linesId);
        const failure = answer === undefined ? windows.failed.get(linesId) : undefined;
        const place = { start: display, size: lines.count, serverFrom: run.row, serverTo: run.row + 1, window: lines };
        if (failure === undefined) {
          add({ kind: 'lines', run, from: index * DIFF_WINDOW_ROWS, rows: answer, length: lines.count, ...place });
        } else {
          add({ kind: 'failed', error: failure, length: 1, ...place });
        }
      });
      cursor = run.row + 1;
    }
    if (cursor < end) addRows(cursor, end);
  }
  return layoutOf(segments, display, total);
}

/** The last segment whose first display row is at or before `index`. */
function segmentAt(segments: readonly Segment[], index: number): number {
  let low = 0;
  let high = segments.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if ((segments[middle]?.start ?? Infinity) <= index) low = middle;
    else high = middle - 1;
  }
  return low;
}

/** The first segment that stands for a row of the folded diff at or after `row`. */
function segmentOfRow(segments: readonly Segment[], row: number): number {
  let low = 0;
  let high = segments.length - 1;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if ((segments[middle]?.serverTo ?? Infinity) > row) high = middle;
    else low = middle + 1;
  }
  return low;
}

// Display row keys: `row <row>` for a row of the folded diff, `line <fold's row> <line>` for line
// `line` (from 0) of an opened fold, `failed <windowId>` for a failed window.
const ROW_KEY = 'row';
const LINE_KEY = 'line';
const FAILED_KEY = 'failed ';

function displayRow(segment: Segment, index: number): DisplayRow {
  const { window } = segment;
  const offset = index - segment.start;
  switch (segment.kind) {
    case 'failed':
      return { kind: 'failed', key: `${FAILED_KEY}${windowId(window)}`, window, error: segment.error };
    case 'rows': {
      const at = segment.from + offset;
      const key = `${ROW_KEY} ${String(at)}`;
      const row = segment.rows?.[at - segment.base];
      return row === undefined ? { kind: 'pending', key, window } : { kind: 'row', key, row, index: at };
    }
    case 'lines': {
      const key = `${LINE_KEY} ${String(segment.run.row)} ${String(segment.from + offset)}`;
      const row = segment.rows?.[offset];
      return row === undefined ? { kind: 'pending', key, window } : { kind: 'row', key, row, index: null };
    }
  }
}

function layoutOf(segments: readonly Segment[], count: number, total: number): DiffLayout {
  const segmentOf = (index: number): Segment => {
    const segment = segments[segmentAt(segments, index)];
    if (segment === undefined || !Number.isInteger(index) || index < 0 || index >= count) {
      throw new RangeError(`no display row ${String(index)} of ${String(count)}`);
    }
    return segment;
  };
  // The failed windows' rows by window, built when a key first asks.
  let failedRows: Map<string, number> | null = null;
  const failedRow = (window: string): number | null => {
    failedRows ??= new Map(segments.flatMap((segment) => (segment.kind === 'failed' ? [[windowId(segment.window), segment.start]] : [])));
    return failedRows.get(window) ?? null;
  };
  return {
    count,
    rowAt: (index) => displayRow(segmentOf(index), index),
    rowOf: (index) => {
      const segment = segmentOf(index);
      return segment.kind === 'rows' ? segment.from + index - segment.start : segment.serverFrom;
    },
    indexOf: (row) => {
      const at = Math.min(Math.max(row, 0), total - 1);
      const segment = segments[segmentOfRow(segments, at)];
      if (segment === undefined) return 0;
      return segment.kind === 'rows' ? segment.start + at - segment.serverFrom : segment.start;
    },
    indexOfKey: (key) => {
      if (key.startsWith(FAILED_KEY)) return failedRow(key.slice(FAILED_KEY.length));
      const [kind, first, second] = key.split(' ');
      const row = Number(first);
      if (!Number.isInteger(row) || row < 0 || row >= total) return null;
      if (kind === ROW_KEY && second === undefined) {
        const segment = segments[segmentOfRow(segments, row)];
        if (segment?.kind !== 'rows' || row < segment.from) return null;
        return segment.start + row - segment.from;
      }
      if (kind !== LINE_KEY || second === undefined) return null;
      const line = Number(second);
      // The windows of the fold's lines follow one another, one segment each.
      for (let index = segmentOfRow(segments, row); index < segments.length; index++) {
        const segment = segments[index];
        if (segment === undefined || segment.kind === 'rows' || segment.serverFrom !== row) break;
        if (segment.kind === 'lines' && line >= segment.from && line < segment.from + segment.length) {
          return segment.start + line - segment.from;
        }
      }
      return null;
    },
    windowsFor: (range, margin = 0) => {
      const from = Math.max(0, range.start);
      const to = Math.min(count - 1, range.end);
      if (to < from) return [];
      let low = segmentAt(segments, from);
      let high = segmentAt(segments, to);
      const first = segments[low];
      const last = segments[high];
      if (first === undefined || last === undefined) return [];
      // The rows before the range in its first segment and after it in its last; a failed window's
      // row shows none of its rows.
      let before = first.kind === 'failed' ? 0 : from - first.start;
      while (before < margin && low > 0) {
        low -= 1;
        before += segments[low]?.size ?? 0;
      }
      let after = last.kind === 'failed' ? 0 : last.start + last.length - 1 - to;
      while (after < margin && high < segments.length - 1) {
        high += 1;
        after += segments[high]?.size ?? 0;
      }
      return uniqueWindows(segments.slice(low, high + 1).map((segment) => segment.window));
    },
  };
}
