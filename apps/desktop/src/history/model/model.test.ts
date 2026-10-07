// The History view's pure parts: the type filter, days and times, what each kind of entry says,
// how entries fall into days, and their estimated heights. Times are built in the local time zone,
// as the timeline shows them.
import { describe, expect, it } from 'vitest';

import type { ChangeRow, CommitInfo, HistoryItem } from '../../ipc';
import { SIZE, SPACE } from '../../tokens/tokens';
import { dayKeyOf, dayLabel, timeParts, whenLabel } from './days';
import { effectiveMsOf, entryKind, entryText, timelineLayout } from './entries';
import { estimateEntry } from './estimate';
import { filterKey, filterOf, HISTORY_TYPES, isHistoryType, shownTypes } from './filter';

const EN = 'en';

/** Sep 30 2026, 3:05 PM here: "today" in these tests. */
const NOW = new Date(2026, 8, 30, 15, 5).getTime();

function at(month: number, day: number, hour = 12, minute = 0, year = 2026): number {
  return new Date(year, month - 1, day, hour, minute).getTime();
}

function id(digit: string): string {
  return `b3:${digit.repeat(64)}`;
}

function commitInfo(fields: Partial<CommitInfo> = {}): CommitInfo {
  return {
    id: id('b'),
    parent: id('a'),
    kind: 'commit',
    first: false,
    head: false,
    synced: false,
    timeMs: String(at(9, 30, 9, 30)),
    effectiveMs: String(at(9, 30, 9, 30)),
    summary: 'MAT232: update the midterm review',
    body: null,
    device: { id: '8c1e0d2b4a6f43e19d7c5b3a2f1e0d9c', name: 'G16' },
    files: 1,
    folders: 0,
    metadata: 0,
    pruned: 0,
    ...fields,
  };
}

function commitItem(fields: Partial<CommitInfo> = {}): HistoryItem {
  return { kind: 'commit', commit: commitInfo(fields), files: [] };
}

function changeRow(path: string): ChangeRow {
  const side = { hash: id('c'), size: '120', stored: true, pruned: false };
  return { key: `change:${path}`, change: 'modified', kind: 'file', path, fromPath: null, class: 'text', before: side, after: side };
}

function op(kind: 'reword' | 'uncommit' | 'restore', ms: number, digit: string): HistoryItem {
  const base = { id: digit.repeat(16), timeMs: String(ms), effectiveMs: String(ms), commit: id(digit) };
  if (kind === 'reword') return { kind, ...base, previous: id('f') };
  if (kind === 'uncommit') return { kind, ...base, summary: 'ECO101: add demand data' };
  return {
    kind,
    ...base,
    path: 'Fall 2026/MAT232/Exams/Midterm review.md',
    versionMs: String(at(9, 10)),
    target: 'Fall 2026/MAT232/Exams/Midterm review.md',
    recycled: false,
  };
}

describe('the type filter', () => {
  it('offers the kinds in the menu’s order and reads back only those', () => {
    expect(HISTORY_TYPES).toEqual(['commit', 'reword', 'uncommit', 'restore']);
    expect(isHistoryType('restore')).toBe(true);
    expect(isHistoryType('sync')).toBe(false);
    expect(isHistoryType(3)).toBe(false);
  });

  it('keeps the kinds in the menu’s order, each once, and every kind or none is no filter', () => {
    expect(filterOf(['restore', 'uncommit', 'restore'])).toEqual(['uncommit', 'restore']);
    expect(filterOf(['commit', 'sync', 7])).toEqual(['commit']);
    expect(filterOf([])).toBeNull();
    expect(filterOf(['restore', 'commit', 'uncommit', 'reword'])).toBeNull();
  });

  it('shows every kind without a filter, and keys equal filters alike', () => {
    expect(shownTypes(null)).toEqual(HISTORY_TYPES);
    expect(shownTypes(['reword'])).toEqual(['reword']);
    expect(filterKey(null)).toBe('all');
    expect(filterKey(['reword', 'restore'])).toBe(filterKey(filterOf(['restore', 'reword'])));
    expect(filterKey(['reword'])).not.toBe(filterKey(['restore']));
  });
});

describe('days and times', () => {
  it('names today and yesterday with their date, other days by date, with the year when it is not this year', () => {
    expect(dayLabel(at(9, 30, 8), NOW, EN)).toBe('Today, Sep 30');
    expect(dayLabel(at(9, 29, 23, 59), NOW, EN)).toBe('Yesterday, Sep 29');
    expect(dayLabel(at(9, 28, 23, 59), NOW, EN)).toBe('Sep 28');
    expect(dayLabel(at(12, 31, 18, 0, 2025), NOW, EN)).toBe('Dec 31, 2025');
    // The first day of a month: yesterday is the last day of the one before.
    expect(dayLabel(at(9, 30, 22), at(10, 1, 7), EN)).toBe('Yesterday, Sep 30');
  });

  it('groups by calendar day here', () => {
    expect(dayKeyOf(at(9, 30, 0, 1))).toBe(dayKeyOf(at(9, 30, 23, 59)));
    expect(dayKeyOf(at(9, 30, 0, 1))).not.toBe(dayKeyOf(at(9, 29, 23, 59)));
  });

  it('shows an entry’s own time, with its date when that is another day than its group’s', () => {
    expect(timeParts(at(9, 30, 17, 5), at(9, 30, 17, 5), NOW, EN)).toEqual({ time: '5:05 PM', date: null });
    // A device whose clock ran behind: grouped under its parent's day, its own time dated.
    expect(timeParts(at(9, 28, 16, 31), at(9, 29, 9), NOW, EN)).toEqual({ time: '4:31 PM', date: 'Sep 28' });
    expect(timeParts(at(12, 31, 16, 31, 2025), at(1, 2, 9), NOW, EN)).toEqual({ time: '4:31 PM', date: 'Dec 31, 2025' });
  });

  it('describes an entry’s own day and time', () => {
    expect(whenLabel(at(9, 30, 17, 5), NOW, EN)).toBe('Today, Sep 30, 5:05 PM');
    expect(whenLabel(at(9, 12, 16, 31), NOW, EN)).toBe('Sep 12, 4:31 PM');
  });
});

describe('what an entry says', () => {
  it('words a commit: its summary, short id, device and body', () => {
    const item = commitItem({ body: 'Rewrote the examples.\nAdded the proofs.' });
    expect(entryKind(item)).toBe('commit');
    expect(entryText(item, NOW, EN)).toEqual({
      kind: 'commit',
      title: 'MAT232: update the midterm review',
      shortId: 'bbbbbbb',
      source: { kind: 'device', name: 'G16' },
      body: 'Rewrote the examples.\nAdded the proofs.',
      note: null,
      timeMs: at(9, 30, 9, 30),
      effectiveMs: at(9, 30, 9, 30),
    });
    // A body of white space is none.
    expect(entryText(commitItem({ body: ' \n ' }), NOW, EN).body).toBeNull();
  });

  it('words the first commit with how many files the library held', () => {
    const item = commitItem({ first: true, parent: null, summary: 'Start history', files: 4_210 });
    expect(entryKind(item)).toBe('first');
    expect(entryText(item, NOW, EN)).toMatchObject({
      kind: 'first',
      title: 'Start history',
      note: '4,210 files were in your library when Folio started keeping history.',
    });
    expect(entryText(commitItem({ first: true, files: 1 }), NOW, EN).note).toBe(
      '1 file was in your library when Folio started keeping history.',
    );
    // Its message edited: the new summary.
    expect(entryText(commitItem({ first: true, summary: 'The library on day one' }), NOW, EN).title).toBe('The library on day one');
  });

  it('words an import as from iCloud, and a prune commit by the versions it thinned out (B3)', () => {
    const imported = commitItem({ kind: 'import', summary: 'Changes from iCloud', device: { id: 'x', name: 'iPad' } });
    expect(entryKind(imported)).toBe('import');
    expect(entryText(imported, NOW, EN)).toMatchObject({ kind: 'import', title: 'Changes from iCloud', source: { kind: 'icloud' } });

    const prune = commitItem({ kind: 'prune', summary: null, body: 'ignored', pruned: 12 });
    expect(entryKind(prune)).toBe('prune');
    expect(entryText(prune, NOW, EN)).toMatchObject({
      kind: 'prune',
      title: 'Thinned out 12 old Word versions',
      shortId: 'bbbbbbb',
      source: { kind: 'device', name: 'G16' },
      body: null,
    });
    expect(entryText(commitItem({ kind: 'prune', summary: null, pruned: 1 }), NOW, EN).title).toBe('Thinned out 1 old Word version');
    // A commit without a message (not one Folio makes) still has a title.
    expect(entryText(commitItem({ summary: null }), NOW, EN).title).toBe('No message');
  });

  it('words the operations with the commit each one names, and no source', () => {
    expect(entryText(op('reword', at(9, 29), 'c'), NOW, EN)).toEqual({
      kind: 'reword',
      title: 'Edited commit message',
      shortId: 'ccccccc',
      source: null,
      body: null,
      note: null,
      timeMs: at(9, 29),
      effectiveMs: at(9, 29),
    });
    expect(entryText(op('uncommit', at(9, 29), 'd'), NOW, EN)).toMatchObject({
      kind: 'uncommit',
      title: 'Undid commit “ECO101: add demand data”',
      shortId: 'ddddddd',
    });
    expect(entryText(op('restore', at(9, 29), 'e'), NOW, EN)).toMatchObject({
      kind: 'restore',
      title: 'Restored Midterm review.md to the version from Sep 10',
      shortId: 'eeeeeee',
    });
    const lastYear = { ...op('restore', at(9, 29), 'e'), versionMs: String(at(10, 3, 12, 0, 2025)) } as HistoryItem;
    expect(entryText(lastYear, NOW, EN).title).toBe('Restored Midterm review.md to the version from Oct 3, 2025');
  });
});

describe('days of the timeline', () => {
  it('starts a day where the effective day changes, and joins the entries of a day', () => {
    const items = [
      op('reword', at(9, 30, 10), '1'),
      commitItem({ id: id('2'), timeMs: String(at(9, 30, 9)), effectiveMs: String(at(9, 30, 9)) }),
      commitItem({ id: id('3'), timeMs: String(at(9, 28, 23)), effectiveMs: String(at(9, 29, 8)) }),
      commitItem({ id: id('4'), first: true, timeMs: String(at(9, 20)), effectiveMs: String(at(9, 20)) }),
    ];
    const layout = timelineLayout(items);

    expect(layout.places).toEqual([
      { key: `reword ${'1'.repeat(16)}`, startsDay: true, lineAbove: false, lineBelow: true },
      { key: `commit ${id('2')}`, startsDay: false, lineAbove: true, lineBelow: false },
      { key: `commit ${id('3')}`, startsDay: true, lineAbove: false, lineBelow: false },
      { key: `commit ${id('4')}`, startsDay: true, lineAbove: false, lineBelow: false },
    ]);
    expect(layout.indexOf(`commit ${id('3')}`)).toBe(2);
    expect(layout.indexOf('commit nothing')).toBeUndefined();
    expect(items.map(effectiveMsOf)[2]).toBe(at(9, 29, 8));
    expect(timelineLayout([]).places).toEqual([]);
  });
});

describe('estimated heights', () => {
  const entry = 2 * SPACE[12] + SIZE.historyIconColumn;
  /** A commit without changes, so without a file card. */
  const bare = (fields: Partial<CommitInfo> = {}) => commitItem({ files: 0, ...fields });
  it('adds a body of up to three lines, the first commit’s note and a day header', () => {
    expect(estimateEntry(bare(), false)).toBe(entry);
    expect(estimateEntry(bare(), true)).toBe(entry + SIZE.row);
    expect(estimateEntry(bare({ body: 'one\ntwo' }), false)).toBe(entry + SPACE[2] + 36);
    expect(estimateEntry(bare({ body: 'a\nb\nc\nd\ne' }), false)).toBe(entry + SPACE[2] + 54);
    expect(estimateEntry(commitItem({ first: true, files: 4210 }), false)).toBe(entry + SPACE[2] + 18);
    expect(estimateEntry(bare({ kind: 'prune', body: 'x', pruned: 3 }), false)).toBe(entry);
    expect(estimateEntry(op('uncommit', NOW, '1'), false)).toBe(entry);
  });

  it('adds the file card: its rows, and "Show all N files" when it has more', () => {
    const card = (rows: number) => SPACE[8] + rows * SIZE.row + 2;
    const showAll = SPACE[4] + SIZE.targetMin;
    const withRows = (count: number, fields: Partial<CommitInfo>): HistoryItem => ({
      kind: 'commit',
      commit: commitInfo(fields),
      files: Array.from({ length: count }, (_, n) => changeRow(`Notes/file ${String(n)}.md`)),
    });
    expect(estimateEntry(withRows(1, { files: 1 }), false)).toBe(entry + card(1));
    expect(estimateEntry(withRows(4, { files: 4 }), false)).toBe(entry + card(4));
    expect(estimateEntry(withRows(4, { files: 6 }), false)).toBe(entry + card(4) + showAll);
    expect(estimateEntry(withRows(2, { files: 2, metadata: 1 }), false)).toBe(entry + card(2) + showAll);
    // Only tag and settings changes: up to four of them.
    expect(estimateEntry(withRows(0, { files: 0, metadata: 3 }), false)).toBe(entry + card(3));
    expect(estimateEntry(withRows(0, { files: 0, metadata: 9 }), false)).toBe(entry + card(4) + showAll);
    // A restore's card is its file.
    expect(estimateEntry(op('restore', NOW, '1'), false)).toBe(entry + card(1));
  });
});
