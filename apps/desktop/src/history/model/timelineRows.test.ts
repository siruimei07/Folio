// One file's history in rows (handoff workspace-history §7.4): commits with the file's own row and
// the other files counted, restores as they are, the first commit after a file that came later,
// the current version, their estimated heights, and which versions offer Restore.
import { describe, expect, it } from 'vitest';

import type { ChangeRow, CommitInfo, FileVersion, RestoreEntry } from '../../ipc';
import { SIZE, SPACE } from '../../tokens/tokens';
import { restorable } from '../restore/restorable';
import { estimateEntry, estimateRow } from './estimate';
import { cameLater, currentVersionOf, fileHistoryRows, wholeHistoryRows } from './timelineRows';

const NOTES = 'Fall 2026/MAT232 Calculus of Several Variables/notes.md';
const G16 = { id: '8c1e0d2b4a6f43e19d7c5b3a2f1e0d9c', name: 'G16' };
const SIDE = { hash: `b3:${'c'.repeat(64)}`, size: '120', stored: true, pruned: false };
/** One line of small text, as the estimates count it. */
const SMALL_LINE = 18;

function id(digit: string): string {
  return `b3:${digit.repeat(64)}`;
}

function changeRow(fields: Partial<ChangeRow> = {}): ChangeRow {
  return { key: `change:${NOTES}`, change: 'modified', kind: 'file', path: NOTES, fromPath: null, class: 'text', before: SIDE, after: SIDE, ...fields };
}

function commitInfo(digit: string, timeMs: number, fields: Partial<CommitInfo> = {}): CommitInfo {
  return {
    id: id(digit),
    parent: null,
    kind: 'commit',
    first: false,
    head: false,
    synced: false,
    timeMs: String(timeMs),
    effectiveMs: String(timeMs),
    summary: 'MAT232: update notes',
    body: null,
    device: G16,
    files: 3,
    folders: 0,
    metadata: 0,
    pruned: 0,
    ...fields,
  };
}

function version(digit: string, timeMs: number, fields: { change?: Partial<ChangeRow>; others?: number; current?: boolean; commit?: Partial<CommitInfo> } = {}): FileVersion {
  return {
    kind: 'commit',
    commit: commitInfo(digit, timeMs, fields.commit),
    change: changeRow({ key: `change:${digit}`, ...fields.change }),
    others: fields.others ?? 2,
    current: fields.current ?? false,
  };
}

const RESTORE: RestoreEntry = {
  id: '0123456789abcdef',
  timeMs: '5000',
  effectiveMs: '5000',
  commit: id('b'),
  path: NOTES,
  versionMs: '2000',
  target: NOTES,
  recycled: false,
};

const FIRST_FIELDS = { first: true, summary: 'Start history', files: 4210 };
const FIRST = commitInfo('f', 1000, FIRST_FIELDS);

/** The file's version in the first commit: it was there from the start. */
function firstVersion(): FileVersion {
  return version('f', 1000, { commit: FIRST_FIELDS, change: { change: 'added', before: null } });
}

describe('one file’s history in rows', () => {
  it('gives each commit the file’s own row with the others counted, and keeps restores as they are', () => {
    const versions: FileVersion[] = [{ kind: 'restore', ...RESTORE }, version('b', 3000, { current: true }), version('a', 2000, { others: 0, change: { change: 'added', before: null } })];
    const rows = fileHistoryRows(versions, { complete: false, first: null, name: 'notes.md' });
    expect(rows.map((row) => row.kind)).toEqual(['entry', 'version', 'version']);
    const [restore, newer] = rows;
    expect(restore).toEqual({ kind: 'entry', item: { kind: 'restore', ...RESTORE } });
    if (newer?.kind !== 'version') throw new Error('a version');
    expect(newer.item.files).toEqual([changeRow({ key: 'change:b' })]);
    expect(newer).toMatchObject({ others: 2, current: true });
    expect(currentVersionOf(versions)).toEqual({ commit: id('b'), key: 'change:b' });
    expect(currentVersionOf(versions.slice(2))).toBeNull();
    expect(wholeHistoryRows([newer.item])).toEqual([{ kind: 'entry', item: newer.item }]);
  });

  it('ends with the first commit, naming the file, when the file came later and every entry is read', () => {
    const versions = [version('b', 3000), version('a', 2000, { change: { change: 'added', before: null } })];
    expect(cameLater(versions, false)).toBe(false);
    expect(cameLater(versions, true)).toBe(true);
    // Not yet read to the end, or the first commit not known yet: nothing after.
    expect(fileHistoryRows(versions, { complete: false, first: FIRST, name: 'notes.md' })).toHaveLength(2);
    expect(fileHistoryRows(versions, { complete: true, first: null, name: 'notes.md' })).toHaveLength(2);
    const rows = fileHistoryRows(versions, { complete: true, first: FIRST, name: 'notes.md' });
    expect(rows.at(-1)).toEqual({ kind: 'before', item: { kind: 'commit', commit: FIRST, files: [] }, name: 'notes.md' });
  });

  it('adds nothing after a file the first commit holds, or a history of restores only', () => {
    const fromStart = [version('b', 3000), firstVersion()];
    expect(cameLater(fromStart, true)).toBe(false);
    expect(fileHistoryRows(fromStart, { complete: true, first: FIRST, name: 'notes.md' })).toHaveLength(2);
    const restores: FileVersion[] = [{ kind: 'restore', ...RESTORE }];
    expect(cameLater(restores, true)).toBe(false);
    expect(fileHistoryRows(restores, { complete: true, first: FIRST, name: 'notes.md' })).toHaveLength(1);
  });

  it('estimates a one-row card with “and N other files”, and the first commit’s without', () => {
    const [newer, alone, first] = fileHistoryRows(
      [version('b', 3000), version('a', 2000, { others: 0 }), firstVersion()],
      { complete: true, first: FIRST, name: 'notes.md' },
    );
    if (newer === undefined || alone === undefined || first === undefined) throw new Error('three rows');
    expect(estimateRow(newer, false) - estimateRow(alone, false)).toBeGreaterThan(0);
    // The whole history's card of the same commit would show "Show all 3 files" instead.
    expect(estimateRow(alone, false)).toBeLessThan(estimateEntry(newer.item, false));
    // The first commit: its note instead of "and N other files", and a day header when it starts one.
    expect(estimateRow(first, false)).toBe(estimateRow(alone, false) + SPACE[2] + SMALL_LINE);
    expect(estimateRow(first, true)).toBe(estimateRow(first, false) + SIZE.row);
    const before = fileHistoryRows([version('a', 2000, { change: { change: 'added', before: null } })], { complete: true, first: FIRST, name: 'notes.md' }).at(-1);
    if (before === undefined) throw new Error('the first commit after the file');
    expect(estimateRow(before, false)).toBe(estimateEntry(before.item, false));
  });
});

describe('which versions offer Restore', () => {
  it('offers stored, unpruned versions of text and Word files that the commit did not delete', () => {
    expect(restorable({ kind: 'file', row: changeRow() })).toBe(true);
    expect(restorable({ kind: 'file', row: changeRow({ class: 'word' }) })).toBe(true);
    expect(restorable({ kind: 'file', row: changeRow({ class: 'other' }) })).toBe(false);
    expect(restorable({ kind: 'file', row: changeRow({ change: 'deleted', after: null }) })).toBe(false);
    expect(restorable({ kind: 'file', row: changeRow({ after: { ...SIDE, stored: false } }) })).toBe(false);
    expect(restorable({ kind: 'file', row: changeRow({ after: { ...SIDE, pruned: true } }) })).toBe(false);
    expect(restorable({ kind: 'file', row: changeRow({ kind: 'folder', class: 'other', before: null, after: null }) })).toBe(false);
    expect(restorable({ kind: 'file', row: changeRow({ path: '.folio/ignore' }) })).toBe(false);
  });
});
