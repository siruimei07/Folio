// Hand-built diffs for the diff pane's tests: folded diffs of any size and their windows as the
// shell answers them (ipc-m2 §9.3), and the rows that targets name. They cover what the fake shell
// does not produce: approximate diffs, folds of any size, a header that changes between windows.
import type { DiffWindowAnswer } from '../../data/diff';
import { IpcFailure } from '../../data/errors';
import type {
  ChangeRow,
  Diff,
  DiffContent,
  DiffRow,
  DiffSide,
  DiffWindow,
  MetadataChange,
  MetadataSubject,
  TextDiff,
  WorkspaceItem,
} from '../../ipc';
import type { CommitRef } from '../model/target';

/** A content hash or commit id made of one repeated digit. */
export function hashOf(digit: string): string {
  return `b3:${digit.repeat(64)}`;
}

export const PARENT = hashOf('a');
export const COMMIT = hashOf('b');

/** The commit of History targets: Oct 13 2026, 9:30 PM here. */
export const COMMIT_REF: CommitRef = { id: COMMIT, timeMs: String(new Date(2026, 9, 13, 21, 30).getTime()) };

/** The parent version's time: Oct 10 2026, 3:10 PM here. */
export const PARENT_TIME = String(new Date(2026, 9, 10, 15, 10).getTime());

/** A committed side: the last commit's in Changes, the parent's in History. */
export function versionSide(fields: Partial<DiffSide> = {}): DiffSide {
  return { commit: PARENT, timeMs: PARENT_TIME, path: 'notes.md', size: '2048', hash: hashOf('c'), stored: true, pruned: false, ...fields };
}

/** The file on the disk. */
export function diskSide(fields: Partial<DiffSide> = {}): DiffSide {
  return { commit: null, timeMs: null, path: 'notes.md', size: '2100', hash: null, stored: true, pruned: false, ...fields };
}

/**
 * A folded diff of `blocks` changes, nine rows each: a fold of `foldLines(block)` hidden lines,
 * three rows of context, a removed and an added row (change `block`), three rows of context.
 */
export function foldedRows(blocks: number, foldLines: (block: number) => number = () => 20): DiffRow[] {
  const rows: DiffRow[] = [];
  let old = 1;
  let next = 1;
  const context = () => {
    rows.push({ kind: 'context', old, new: next, text: `line ${String(next)}` });
    old += 1;
    next += 1;
  };
  for (let block = 0; block < blocks; block++) {
    const lines = foldLines(block);
    rows.push({ kind: 'fold', old, new: next, lines });
    old += lines;
    next += lines;
    context();
    context();
    context();
    rows.push({ kind: 'removed', old, text: `old ${String(block)}`, marks: [], change: block });
    old += 1;
    rows.push({ kind: 'added', new: next, text: `new ${String(block)}`, marks: [], change: block });
    next += 1;
    context();
    context();
    context();
  }
  return rows;
}

/** The counts of a folded diff, as its header has them. */
export function countsOf(rows: readonly DiffRow[]): Pick<TextDiff, 'added' | 'removed' | 'changes' | 'rows'> {
  let added = 0;
  let removed = 0;
  let changes = 0;
  for (const row of rows) {
    if (row.kind === 'added') added += 1;
    if (row.kind === 'removed') removed += 1;
    if ((row.kind === 'added' || row.kind === 'removed') && row.change + 1 > changes) changes = row.change + 1;
  }
  return { added, removed, changes, rows: rows.length };
}

/** The rows a window of `rows` answers with: a slice, or the unchanged lines a fold hides. */
export function windowRows(rows: readonly DiffRow[], window: DiffWindow): DiffRow[] {
  if (window.kind === 'rows') return rows.slice(window.offset, window.offset + window.limit);
  const fold = rows.find((row) => row.kind === 'fold' && row.new <= window.line && window.line < row.new + row.lines);
  if (fold?.kind !== 'fold') throw new Error(`no fold hides line ${String(window.line)}`);
  return Array.from({ length: window.count }, (_, index) => {
    const line = window.line + index;
    return { kind: 'context', old: fold.old + line - fold.new, new: line, text: `line ${String(line)}` };
  });
}

/** A text diff of `rows` answering `window`. */
export function textDiff(
  rows: readonly DiffRow[],
  window: DiffWindow,
  fields: { text?: Partial<TextDiff>; before?: DiffSide | null; after?: DiffSide | null; word?: boolean } = {},
): Diff {
  const text: TextDiff = {
    ...countsOf(rows),
    approximate: false,
    lineEndings: null,
    encoding: null,
    window: windowRows(rows, window),
    ...fields.text,
  };
  return {
    revision: 7,
    before: fields.before === undefined ? versionSide() : fields.before,
    after: fields.after === undefined ? diskSide() : fields.after,
    content: fields.word === true ? { kind: 'word', text } : { kind: 'text', text },
    tags: null,
  };
}

/** A diff whose content is not lines. */
export function contentDiff(content: DiffContent, fields: Partial<Diff> = {}): Diff {
  return { revision: 7, before: versionSide(), after: diskSide(), content, tags: null, ...fields };
}

/** A window's answer as `useDiffWindows` gives it. */
export function answer(
  window: DiffWindow,
  diff: Diff | undefined,
  fields: { error?: IpcFailure | null; fetching?: boolean } = {},
): DiffWindowAnswer {
  return { window, diff, error: fields.error ?? null, fetching: fields.fetching ?? false, settled: '' };
}

/** A failed fetch, as the data layer reports it. */
export function failure(code: 'Internal' | 'NotFound' | 'HistoryDamaged' = 'Internal'): IpcFailure {
  return new IpcFailure({ code, detail: 'test' });
}

/** A modified text file in Changes. */
export function workspaceItem(fields: Partial<WorkspaceItem> = {}): WorkspaceItem {
  return {
    key: 'item:notes',
    change: 'modified',
    kind: 'file',
    path: 'Fall 2026/MAT232 Calculus of Several Variables/notes.md',
    fromPath: null,
    entry: { id: '42', path: 'Fall 2026/MAT232 Calculus of Several Variables/notes.md' },
    class: 'text',
    contentChanged: true,
    before: { size: '2048', stored: true },
    after: { size: '2100', stored: true },
    readiness: 'ready',
    files: 0,
    parts: [],
    required: false,
    tagsChanged: false,
    ...fields,
  };
}

/** A modified text file in a commit. */
export function changeRow(fields: Partial<ChangeRow> = {}): ChangeRow {
  return {
    key: 'row:notes',
    change: 'modified',
    kind: 'file',
    path: 'Fall 2026/MAT232 Calculus of Several Variables/notes.md',
    fromPath: null,
    class: 'text',
    before: { hash: hashOf('c'), size: '2048', stored: true, pruned: false },
    after: { hash: hashOf('d'), size: '2100', stored: true, pruned: false },
    ...fields,
  };
}

export function metadataChange(subject: MetadataSubject, change: MetadataChange['change'] = 'modified'): MetadataChange {
  return { key: `meta:${subject.kind}`, change, subject };
}
