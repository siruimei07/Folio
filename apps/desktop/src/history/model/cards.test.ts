// A file card's pure parts: what a row shows and says, which entries have a card and how big it
// starts, and how the selection follows the entries through a message edit, an undone commit and
// a filter.
import i18n from 'i18next';
import { describe, expect, it } from 'vitest';

import type { ChangeRow, CommitInfo, Course, HistoryItem, MetadataChange } from '../../ipc';
import { type CardRow, cardRowId, cardRowPath, cardShape, copyablePath, describeChangeRow, describeMetadataRow } from './rows';
import {
  commitAnchor,
  commitAnchorKey,
  type HistorySelection,
  reanchor,
  refindRow,
  selectedRowIn,
  selectionTarget,
} from './selection';

const t = i18n.getFixedT<['history', 'common']>('en', ['history', 'common']);
const MAT = 'Fall 2026/MAT232 Calculus of Several Variables';
const COURSES: Course[] = [
  { folder: { id: 'mat', path: MAT }, name: 'Calculus of Several Variables', abbr: null, code: 'MAT232', color: null, archived: false, files: 9 },
];
const CONTEXT = { t, language: 'en', courses: COURSES };
const G16 = { id: '8c1e0d2b4a6f43e19d7c5b3a2f1e0d9c', name: 'G16' };

function id(digit: string): string {
  return `b3:${digit.repeat(64)}`;
}

function changeRow(path: string, fields: Partial<ChangeRow> = {}): ChangeRow {
  const side = { hash: id('c'), size: '120', stored: true, pruned: false };
  return { key: `change:${path}`, change: 'modified', kind: 'file', path, fromPath: null, class: 'text', before: side, after: side, ...fields };
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
    summary: 'MAT232: update the midterm review',
    body: null,
    device: G16,
    files: 1,
    folders: 0,
    metadata: 0,
    pruned: 0,
    ...fields,
  };
}

function commitItem(commit: CommitInfo, files: ChangeRow[] = [changeRow(`${MAT}/notes.md`)]): HistoryItem {
  return { kind: 'commit', commit, files };
}

function restoreItem(digit: string, commit: string, timeMs: number): HistoryItem {
  return {
    kind: 'restore',
    id: digit.repeat(16),
    timeMs: String(timeMs),
    effectiveMs: String(timeMs),
    commit,
    path: `${MAT}/notes.md`,
    versionMs: '1000',
    target: `${MAT}/notes.md`,
    recycled: false,
  };
}

describe('a card row', () => {
  it('shows a file’s path with the course code kept apart, its status, and names it with both', () => {
    const text = describeChangeRow(changeRow(`${MAT}/Exams/Midterm review.md`), CONTEXT);
    expect(text.icon).toEqual({ kind: 'file', name: 'Midterm review.md' });
    expect(text.path).toEqual({ label: 'MAT232/', prefix: 'Exams/', name: 'Midterm review.md' });
    expect(text.status).toBe('modified');
    expect(text.deleted).toBe(false);
    expect(text.tooltip).toBe('MAT232/Exams/Midterm review.md');
    expect(text.label).toBe('MAT232/Exams/Midterm review.md, Modified');
  });

  it('strikes a deleted file through and words a move with its old path in the tooltip and name', () => {
    expect(describeChangeRow(changeRow(`${MAT}/old.md`, { change: 'deleted', after: null }), CONTEXT).deleted).toBe(true);
    const moved = describeChangeRow(
      changeRow(`${MAT}/Problem sets/ps2 solutions.md`, { change: 'moved', fromPath: `${MAT}/ps2 solutions.md` }),
      CONTEXT,
    );
    expect(moved.status).toBe('renamed');
    expect(moved.tooltip).toBe('MAT232/Problem sets/ps2 solutions.md\nMoved from MAT232/ps2 solutions.md');
    expect(moved.label).toBe('MAT232/Problem sets/ps2 solutions.md, Renamed, Moved from MAT232/ps2 solutions.md');
  });

  it('gives a moved folder an open folder and any other folder a closed one', () => {
    const folder = (change: ChangeRow['change']) =>
      describeChangeRow(changeRow(`${MAT}/习题`, { kind: 'folder', change, class: 'other', before: null, after: null }), CONTEXT).icon;
    expect(folder('moved')).toEqual({ kind: 'folderOpen' });
    expect(folder('deleted')).toEqual({ kind: 'folder' });
    expect(folder('added')).toEqual({ kind: 'folder' });
  });

  it('shows tag and settings changes as the Changes list does', () => {
    const tags: MetadataChange = {
      key: 'meta:tags',
      change: 'modified',
      subject: { kind: 'tags', path: `${MAT}/Midterm 2025.pdf`, entryKind: 'file', entry: null },
    };
    const tagText = describeMetadataRow(tags, CONTEXT);
    expect(tagText.icon).toEqual({ kind: 'tag' });
    expect(tagText.tagsTag).toBe(true);
    expect(tagText.label).toBe('MAT232/Midterm 2025.pdf, Tags, Modified');

    const course = describeMetadataRow({ key: 'meta:course', change: 'modified', subject: { kind: 'course', path: MAT, folder: null } }, CONTEXT);
    expect(course.icon).toEqual({ kind: 'settings' });
    expect(course.path).toEqual({ label: '', prefix: '', name: 'MAT232 course settings' });
    expect(course.label).toBe('MAT232 course settings, Modified');

    const rules = describeMetadataRow({ key: 'meta:ignoreRules', change: 'added', subject: { kind: 'ignoreRules' } }, CONTEXT);
    expect(rules.icon).toEqual({ kind: 'fileCog' });
    expect(rules.label).toBe('Ignore rules, Added');
    expect(describeMetadataRow({ key: 'm', change: 'deleted', subject: { kind: 'semester', path: 'Fall 2026', folder: null } }, CONTEXT).path.name).toBe(
      'Fall 2026 semester settings',
    );
  });

  it('has an id per kind and the path it names, if any', () => {
    const file: CardRow = { kind: 'file', row: changeRow('a.md') };
    const rules: CardRow = { kind: 'metadata', change: { key: 'meta:ignoreRules', change: 'modified', subject: { kind: 'ignoreRules' } } };
    const course: CardRow = { kind: 'metadata', change: { key: 'meta:c', change: 'modified', subject: { kind: 'course', path: MAT, folder: null } } };
    expect(cardRowId(file)).toBe('file change:a.md');
    expect(cardRowId(rules)).toBe('meta meta:ignoreRules');
    expect(cardRowPath(file)).toBe('a.md');
    expect(cardRowPath(course)).toBe(MAT);
    expect(cardRowPath(rules)).toBeNull();
  });

  it('copies the path of a file, a folder or what a tag change is about, as the Changes view does', () => {
    const tags: CardRow = {
      kind: 'metadata',
      change: { key: 'meta:t', change: 'modified', subject: { kind: 'tags', path: `${MAT}/x.pdf`, entryKind: 'file', entry: null } },
    };
    const course: CardRow = { kind: 'metadata', change: { key: 'meta:c', change: 'modified', subject: { kind: 'course', path: MAT, folder: null } } };
    const deleted: CardRow = { kind: 'file', row: changeRow('gone.md', { change: 'deleted', after: null }) };
    expect(copyablePath(deleted)).toBe('gone.md');
    expect(copyablePath({ kind: 'file', row: changeRow(MAT, { kind: 'folder', class: 'other', before: null, after: null }) })).toBe(MAT);
    expect(copyablePath(tags)).toBe(`${MAT}/x.pdf`);
    expect(copyablePath(course)).toBeNull();
    expect(copyablePath({ kind: 'metadata', change: { key: 'meta:l', change: 'modified', subject: { kind: 'library' } } })).toBeNull();
  });
});

describe('which entries have a card', () => {
  it('leaves out the first commit, prune commits, commits without changes and the other operations', () => {
    expect(cardShape(commitItem(commitInfo('1', 1, { first: true, files: 4210 })))).toBeNull();
    expect(cardShape(commitItem(commitInfo('1', 1, { kind: 'prune', files: 0, pruned: 3 }), []))).toBeNull();
    expect(cardShape(commitItem(commitInfo('1', 1, { files: 0 }), []))).toBeNull();
    expect(cardShape({ kind: 'reword', id: 'a'.repeat(16), timeMs: '1', effectiveMs: '1', commit: id('1'), previous: id('2') })).toBeNull();
    expect(cardShape(restoreItem('a', id('1'), 1))).toEqual({ rows: 1, total: 1 });
    expect(cardShape(commitItem(commitInfo('1', 1, { files: 5, folders: 1, metadata: 2 }), [1, 2, 3, 4].map((n) => changeRow(`${String(n)}.md`))))).toEqual({
      rows: 4,
      total: 8,
    });
    expect(cardShape(commitItem(commitInfo('1', 1, { files: 0, metadata: 6 }), []))).toEqual({ rows: 4, total: 6 });
  });
});

describe('the selection', () => {
  const commit = commitInfo('1', 5_000, { effectiveMs: '5000' });
  const row: CardRow = { kind: 'file', row: changeRow(`${MAT}/notes.md`) };
  const selection: HistorySelection = { card: commitAnchor(commit), commit: { id: commit.id, timeMs: commit.timeMs }, row };
  const older = commitInfo('0', 1_000);

  it('is its card’s, and shows that version or tag change', () => {
    expect(selectedRowIn(selection, commitItem(commit))).toBe(`file change:${MAT}/notes.md`);
    expect(selectedRowIn(selection, commitItem(older))).toBeNull();
    expect(selectedRowIn(null, commitItem(commit))).toBeNull();
    expect(selectionTarget(selection)).toEqual({ kind: 'version', commit: { id: commit.id, timeMs: '5000' }, row: row.row });
    const change: MetadataChange = { key: 'meta:ignoreRules', change: 'modified', subject: { kind: 'ignoreRules' } };
    expect(selectionTarget({ ...selection, row: { kind: 'metadata', change } })).toEqual({
      kind: 'versionMetadata',
      commit: { id: commit.id, timeMs: '5000' },
      change,
    });
    expect(commitAnchorKey(commit)).toBe(`5000 ${G16.id}`);
  });

  it('stays while its commit is listed, and follows it to its new id after a message edit', () => {
    expect(reanchor(selection, [commitItem(commit), commitItem(older)], true)).toBeUndefined();
    const edited = { ...commit, id: id('9'), summary: 'Reworded' };
    expect(reanchor(selection, [commitItem(edited), commitItem(older)], true)).toEqual({
      card: { ...selection.card, id: id('9') },
      commit: { id: id('9'), timeMs: '5000' },
      row,
    });
    // Another device's commit at the same time is another commit.
    const elsewhere = { ...edited, device: { id: 'other', name: 'iPad' } };
    expect(reanchor(selection, [commitItem(elsewhere), commitItem(older)], true)).toBeNull();
  });

  it('goes when its commit is gone from entries read past it, and waits for pages not read yet', () => {
    expect(reanchor(selection, [commitItem(older)], true)).toBeNull();
    expect(reanchor(selection, [commitItem(older)], false)).toBeNull();
    const newer = commitInfo('2', 9_000);
    expect(reanchor(selection, [commitItem(newer)], false)).toBeUndefined();
    expect(reanchor(selection, [], false)).toBeUndefined();
    expect(reanchor(selection, [], true)).toBeNull();
    // A list read to its end without it (a filter that leaves it out), however new its entries.
    expect(reanchor(selection, [commitItem(newer)], true)).toBeNull();
  });

  it('follows a restore card’s version to its commit’s new id', () => {
    const restore = restoreItem('a', id('1'), 7_000);
    const restored: HistorySelection = {
      card: { kind: 'restore', key: `restore ${'a'.repeat(16)}`, effectiveMs: 7_000 },
      commit: { id: id('1'), timeMs: '1000' },
      row,
    };
    expect(selectedRowIn(restored, restore)).toBe(`file change:${MAT}/notes.md`);
    expect(reanchor(restored, [restore], true)).toBeUndefined();
    expect(reanchor(restored, [restoreItem('a', id('8'), 7_000)], true)).toEqual({ ...restored, commit: { id: id('8'), timeMs: '1000' } });
    expect(reanchor(restored, [commitItem(older)], true)).toBeNull();
  });

  it('finds its row again by path when the row’s key changed, and only then', () => {
    expect(refindRow(selection, [row])).toBeUndefined();
    const rekeyed: CardRow = { kind: 'file', row: changeRow(`${MAT}/notes.md`, { key: 'new key' }) };
    expect(refindRow(selection, [{ kind: 'file', row: changeRow('other.md') }, rekeyed])).toBe(rekeyed);
    expect(refindRow(selection, [{ kind: 'file', row: changeRow('other.md') }])).toBeUndefined();
  });
});
