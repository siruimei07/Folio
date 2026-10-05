// Line diffs for the fake shell, folded and windowed like the shell's (docs/specs/ipc-m2.md §9.3).
// Not the shell's algorithm (Patience, versioning §10.2): a longest common subsequence for short
// texts, and a line-by-line comparison for long ones, which the fixtures write so that it finds
// the changes they mean. Good enough to page, fold, unfold and step through changes.
import type { DiffRow, DiffWindow, TextDiff, TextRange } from '../../bindings';
import { LIMITS } from '../../bindings';
import { fail } from '../failure';
import { checkPage, isCount } from '../library';

/** Context rows on each side of a change (versioning §10.2). */
const CONTEXT = 3;
/** Above this many cells, the line-by-line comparison replaces the LCS table. */
const LCS_CELLS = 4_000_000;

/** One line of the unfolded diff. */
type Line =
  | { kind: 'equal'; old: number; new: number; text: string }
  | { kind: 'removed'; old: number; text: string }
  | { kind: 'added'; new: number; text: string };

function diffLines(before: readonly string[], after: readonly string[]): Line[] {
  return before.length * after.length <= LCS_CELLS ? lcs(before, after) : byPosition(before, after);
}

function lcs(before: readonly string[], after: readonly string[]): Line[] {
  const n = before.length;
  const m = after.length;
  // lengths[i * (m + 1) + j]: the LCS of before[i..] and after[j..].
  const lengths = new Uint32Array((n + 1) * (m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lengths[i * (m + 1) + j] =
        before[i] === after[j]
          ? (lengths[(i + 1) * (m + 1) + j + 1] ?? 0) + 1
          : Math.max(lengths[(i + 1) * (m + 1) + j] ?? 0, lengths[i * (m + 1) + j + 1] ?? 0);
    }
  }
  const lines: Line[] = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && before[i] === after[j]) {
      lines.push({ kind: 'equal', old: i + 1, new: j + 1, text: before[i] ?? '' });
      i++;
      j++;
    } else if (j < m && (i === n || (lengths[i * (m + 1) + j + 1] ?? 0) >= (lengths[(i + 1) * (m + 1) + j] ?? 0))) {
      lines.push({ kind: 'added', new: j + 1, text: after[j] ?? '' });
      j++;
    } else {
      lines.push({ kind: 'removed', old: i + 1, text: before[i] ?? '' });
      i++;
    }
  }
  return pairRemovedFirst(lines);
}

/** Long texts: line i against line i, then what is left over on either side. */
function byPosition(before: readonly string[], after: readonly string[]): Line[] {
  const lines: Line[] = [];
  const common = Math.min(before.length, after.length);
  for (let index = 0; index < common; index++) {
    const old = before[index] ?? '';
    const next = after[index] ?? '';
    if (old === next) lines.push({ kind: 'equal', old: index + 1, new: index + 1, text: old });
    else {
      lines.push({ kind: 'removed', old: index + 1, text: old });
      lines.push({ kind: 'added', new: index + 1, text: next });
    }
  }
  for (let index = common; index < before.length; index++) {
    lines.push({ kind: 'removed', old: index + 1, text: before[index] ?? '' });
  }
  for (let index = common; index < after.length; index++) {
    lines.push({ kind: 'added', new: index + 1, text: after[index] ?? '' });
  }
  return pairRemovedFirst(lines);
}

/** Within each run of changed lines, the removed lines come before the added ones. */
function pairRemovedFirst(lines: Line[]): Line[] {
  const out: Line[] = [];
  let removed: Line[] = [];
  let added: Line[] = [];
  const flush = () => {
    out.push(...removed, ...added);
    removed = [];
    added = [];
  };
  for (const line of lines) {
    if (line.kind === 'removed') removed.push(line);
    else if (line.kind === 'added') added.push(line);
    else {
      flush();
      out.push(line);
    }
  }
  flush();
  return out;
}

/** A diff folded once: its lines, its rows without marks, and its counts. */
export interface FoldedDiff {
  lines: Line[];
  rows: DiffRow[];
  added: number;
  removed: number;
  changes: number;
}

/** The folded rows of a diff, without the marks, which only the window needs, and its counts. */
function fold(lines: Line[]): FoldedDiff {
  // Distance to the nearest changed line on either side: a line within CONTEXT of one is shown.
  const near = new Array<number>(lines.length);
  let last = -Infinity;
  for (const [index, line] of lines.entries()) {
    if (line.kind !== 'equal') last = index;
    near[index] = index - last;
  }
  last = Infinity;
  for (let index = lines.length - 1; index >= 0; index--) {
    if (lines[index]?.kind !== 'equal') last = index;
    near[index] = Math.min(near[index] ?? Infinity, last - index);
  }
  const rows: DiffRow[] = [];
  let added = 0;
  let removed = 0;
  let change = -1;
  let previousChanged = false;
  let hidden: { old: number; new: number; lines: number } | null = null;
  for (const [index, line] of lines.entries()) {
    if (line.kind === 'equal' && (near[index] ?? Infinity) > CONTEXT) {
      hidden ??= { old: line.old, new: line.new, lines: 0 };
      hidden.lines += 1;
      previousChanged = false;
      continue;
    }
    if (hidden !== null) {
      rows.push({ kind: 'fold', ...hidden });
      hidden = null;
    }
    if (line.kind === 'equal') {
      rows.push({ kind: 'context', old: line.old, new: line.new, text: line.text });
      previousChanged = false;
      continue;
    }
    if (!previousChanged) change += 1;
    previousChanged = true;
    if (line.kind === 'removed') {
      removed++;
      rows.push({ kind: 'removed', old: line.old, text: line.text, marks: [], change });
    } else {
      added++;
      rows.push({ kind: 'added', new: line.new, text: line.text, marks: [], change });
    }
  }
  if (hidden !== null) rows.push({ kind: 'fold', ...hidden });
  return { lines, rows, added, removed, changes: change + 1 };
}

/** The changed words between a removed and an added line: one range on each, trimmed of spaces. */
function wordMarks(old: string, next: string): [TextRange[], TextRange[]] {
  let start = 0;
  while (start < old.length && start < next.length && old[start] === next[start]) start++;
  let end = 0;
  while (
    end < old.length - start &&
    end < next.length - start &&
    old[old.length - 1 - end] === next[next.length - 1 - end]
  ) {
    end++;
  }
  const range = (text: string): TextRange[] => {
    let from = start;
    let to = text.length - end;
    while (from < to && text[from] === ' ') from++;
    while (to > from && text[to - 1] === ' ') to--;
    return from < to ? [{ start: from, end: to }] : [];
  };
  return [range(old), range(next)];
}

/** Marks for the removed and added rows of `rows` that pair up within a change. */
function withMarks(rows: DiffRow[]): DiffRow[] {
  const byChange = new Map<number, { removed: number[]; added: number[] }>();
  rows.forEach((row, index) => {
    if (row.kind !== 'removed' && row.kind !== 'added') return;
    const entry = byChange.get(row.change) ?? { removed: [], added: [] };
    entry[row.kind].push(index);
    byChange.set(row.change, entry);
  });
  const out = [...rows];
  for (const { removed, added } of byChange.values()) {
    removed.forEach((removedIndex, pair) => {
      const addedIndex = added[pair];
      const old = out[removedIndex];
      const next = addedIndex === undefined ? undefined : out[addedIndex];
      if (old?.kind !== 'removed' || next?.kind !== 'added' || addedIndex === undefined) return;
      const [oldMarks, newMarks] = wordMarks(old.text, next.text);
      out[removedIndex] = { ...old, marks: oldMarks };
      out[addedIndex] = { ...next, marks: newMarks };
    });
  }
  return out;
}

/** Diffs kept by their two versions, the most recently used last, at most `kept`. */
interface DiffCache {
  diffs: Map<string, FoldedDiff>;
  key: string;
  kept: number;
}

function folded(before: readonly string[], after: readonly string[], cache: DiffCache | undefined): FoldedDiff {
  const cached = cache?.diffs.get(cache.key);
  if (cache !== undefined && cached !== undefined) {
    cache.diffs.delete(cache.key);
    cache.diffs.set(cache.key, cached);
    return cached;
  }
  const result = fold(diffLines(before, after));
  if (cache !== undefined) {
    cache.diffs.set(cache.key, result);
    for (const key of cache.diffs.keys()) {
      if (cache.diffs.size <= cache.kept) break;
      cache.diffs.delete(key);
    }
  }
  return result;
}

/** A text diff with the rows `window` asks for (ipc-m2 §9.3). */
export function textDiff(
  before: readonly string[],
  after: readonly string[],
  window: DiffWindow,
  options: { lineEndings?: TextDiff['lineEndings']; encoding?: TextDiff['encoding']; cache?: DiffCache } = {},
): TextDiff {
  const diff = folded(before, after, options.cache);
  return {
    added: diff.added,
    removed: diff.removed,
    changes: diff.changes,
    rows: diff.rows.length,
    approximate: false,
    lineEndings: options.lineEndings ?? null,
    encoding: options.encoding ?? null,
    window: windowOf(diff, window),
  };
}

function windowOf({ lines, rows }: FoldedDiff, window: DiffWindow): DiffRow[] {
  if (window.kind === 'rows') {
    checkPage(window, LIMITS.diffRows);
    // Marks for whole changes, so a change cut by the window still pairs its lines.
    const from = startOfChange(rows, window.offset);
    const to = Math.min(rows.length, endOfChange(rows, window.offset + window.limit));
    return withMarks(rows.slice(from, to)).slice(window.offset - from, window.offset - from + window.limit);
  }
  const { line, count } = window;
  if (!isCount(line) || line < 1 || !isCount(count) || count < 1 || count > LIMITS.diffRows) {
    fail('InvalidArgument', 'an unchanged window needs a line from 1 and 1 to LIMITS.diffRows lines');
  }
  const found: DiffRow[] = [];
  for (const entry of lines) {
    if (entry.kind === 'removed' || entry.new < line) continue;
    // New line numbers only grow: past the window, nothing more can be in it.
    if (entry.new >= line + count) break;
    if (entry.kind !== 'equal') fail('InvalidArgument', `line ${String(entry.new)} is not unchanged`);
    found.push({ kind: 'context', old: entry.old, new: entry.new, text: entry.text });
  }
  if (found.length !== count) fail('InvalidArgument', 'the unchanged lines run past the end');
  return found;
}

function changeOf(row: DiffRow | undefined): number | null {
  return row?.kind === 'removed' || row?.kind === 'added' ? row.change : null;
}

function startOfChange(rows: readonly DiffRow[], index: number): number {
  const change = changeOf(rows[index]);
  let start = Math.min(index, rows.length);
  while (change !== null && start > 0 && changeOf(rows[start - 1]) === change) start--;
  return start;
}

function endOfChange(rows: readonly DiffRow[], index: number): number {
  const change = changeOf(rows[index - 1]);
  let end = index;
  while (change !== null && end < rows.length && changeOf(rows[end]) === change) end++;
  return end;
}
