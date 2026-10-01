import { describe, expect, it, vi } from 'vitest';

import type { Course, EntryRow } from '../../ipc';
import { type FolderList, keyOf, type TreeInput, TreeLayout } from './layout';

function row(id: string, path: string, kind: 'file' | 'folder' = 'file'): EntryRow {
  return {
    id,
    path,
    name: path.slice(path.lastIndexOf('/') + 1),
    kind,
    class: 'other',
    size: '0',
    modifiedMs: null,
    addedMs: '0',
    tags: [],
    folderTags: [],
  };
}

/** A list of `rows`, of which only the indexes in `loaded` have arrived (all by default). */
function list(rows: EntryRow[], loaded?: (index: number) => boolean): FolderList {
  return {
    total: rows.length,
    rowAt: (index) => (loaded === undefined || loaded(index) ? rows[index] : undefined),
    status: 'success',
    failedAt: () => false,
    loadPage: (page) => Promise.resolve({ items: rows.slice(page * 200, page * 200 + 200), offset: page * 200, total: rows.length, revision: 1 }),
    retry: vi.fn(),
  };
}

function course(id: string, path: string, name: string): Course {
  return { folder: { id, path }, name, abbr: null, code: null, color: null, archived: false, files: 0 };
}

const MAT = course('10', 'Fall/MAT', 'MAT');
const CSC = course('20', 'Fall/CSC', 'CSC');

function input(overrides: Partial<TreeInput> = {}): TreeInput {
  return {
    quickViews: true,
    courses: [MAT, CSC],
    expanded: new Set(),
    lists: new Map(),
    semester: list([row('10', 'Fall/MAT', 'folder'), row('20', 'Fall/CSC', 'folder'), row('30', 'Fall/notes.md')]),
    newFolderIn: null,
    ...overrides,
  };
}

const keys = (layout: TreeLayout) => Array.from({ length: layout.count }, (_, index) => layout.rowAt(index).key);

describe('TreeLayout', () => {
  it('lists the quick views, the courses, then the loose files after a separator', () => {
    const layout = new TreeLayout(input());
    expect(keys(layout)).toEqual(['quick:recent', 'quick:untagged', 'separator:quick', '10', '20', 'separator:loose', '30']);
    // Quick views, courses and loose files are one set at level 1; separators are not in it.
    expect(layout.rowAt(3)).toMatchObject({ kind: 'course', level: 1, posinset: 3, setsize: 5, expanded: false });
    expect(layout.rowAt(6)).toMatchObject({ kind: 'entry', level: 1, posinset: 5, setsize: 5 });
  });

  it('shows the children of an expanded course, and of expanded folders inside it', () => {
    const lists = new Map([
      ['10', list([row('11', 'Fall/MAT/Lectures', 'folder'), row('12', 'Fall/MAT/ps1.pdf')])],
      ['11', list([row('13', 'Fall/MAT/Lectures/L1.pdf'), row('14', 'Fall/MAT/Lectures/L2.pdf')])],
    ]);
    const layout = new TreeLayout(input({ expanded: new Set(['Fall/MAT', 'Fall/MAT/Lectures']), lists }));
    expect(keys(layout)).toEqual([
      'quick:recent', 'quick:untagged', 'separator:quick',
      '10', '11', '13', '14', '12',
      '20', 'separator:loose', '30',
    ]);
    expect(layout.rowAt(4)).toMatchObject({ level: 2, posinset: 1, setsize: 2, expanded: true });
    expect(layout.rowAt(5)).toMatchObject({ level: 3, posinset: 1, setsize: 2 });
    expect(layout.rowAt(7)).toMatchObject({ level: 2, posinset: 2, setsize: 2, expanded: undefined });
    expect(layout.indexOfKey('14')).toBe(6);
    expect(layout.indexOfKey('12')).toBe(7);
    expect(layout.indexOfKey('20')).toBe(8);
    expect(layout.indexOfKey('30')).toBe(10);
    expect(layout.indexOfKey('quick:untagged')).toBe(1);
  });

  it('shows one loading row until a folder has its first page, and "Empty" for an empty folder', () => {
    const lists = new Map([['20', list([])]]);
    const layout = new TreeLayout(input({ expanded: new Set(['Fall/MAT', 'Fall/CSC']), lists }));
    expect(layout.rowAt(4)).toMatchObject({ kind: 'loading', level: 2 });
    expect(layout.rowAt(6)).toMatchObject({ kind: 'empty', key: keyOf.empty('20') });
  });

  it('keeps rows of pages not loaded as placeholders, and an expanded folder below them waits', () => {
    const rows = Array.from({ length: 450 }, (_, index) =>
      index === 300 ? row('500', 'Fall/MAT/deep', 'folder') : row(String(1000 + index), `Fall/MAT/f${String(index)}`),
    );
    // Only the first page has arrived.
    const lists = new Map([
      ['10', list(rows, (index) => index < 200)],
      ['500', list([row('501', 'Fall/MAT/deep/x')])],
    ]);
    const layout = new TreeLayout(input({ expanded: new Set(['Fall/MAT', 'Fall/MAT/deep']), lists }));
    expect(layout.rowAt(4 + 199)).toMatchObject({ kind: 'entry', key: '1199' });
    expect(layout.rowAt(4 + 200)).toMatchObject({ kind: 'placeholder', key: keyOf.placeholder('10', 200) });
    // The deep folder's page is not loaded, so its children do not show yet.
    expect(layout.count).toBe(3 + 1 + 450 + 1 + 2);

    const loaded = new TreeLayout(
      input({ expanded: new Set(['Fall/MAT', 'Fall/MAT/deep']), lists: new Map([...lists, ['10', list(rows)]]) }),
    );
    expect(loaded.count).toBe(3 + 1 + 451 + 1 + 2);
    expect(loaded.rowAt(4 + 301)).toMatchObject({ key: '501', level: 3 });
    expect(loaded.rowAt(4 + 302)).toMatchObject({ key: '1301', level: 2 });
    expect(loaded.indexOfKey('1301')).toBe(4 + 302);
  });

  it('loads the pages a range of rows needs, and caps it', async () => {
    const rows = Array.from({ length: 450 }, (_, index) => row(String(1000 + index), `Fall/MAT/f${String(index)}`));
    const lists = new Map([['10', list(rows, (index) => index < 200)]]);
    const layout = new TreeLayout(input({ expanded: new Set(['Fall/MAT']), lists }));
    // The course row, its 450 files (250 not loaded), the other course.
    const range = await layout.entriesBetween(3, 3 + 451, 10_000);
    expect(range.entries).toHaveLength(452);
    expect(range.entries.at(-2)).toMatchObject({ id: '1449', kind: 'file' });
    expect(range.capped).toBe(false);
    const capped = await layout.entriesBetween(3, 3 + 451, 300);
    expect(capped).toMatchObject({ capped: true });
    expect(capped.entries).toHaveLength(300);
  });

  it('puts the field of a new folder first in its parent', () => {
    const lists = new Map([['10', list([row('12', 'Fall/MAT/ps1.pdf')])]]);
    const layout = new TreeLayout(input({ expanded: new Set(['Fall/MAT']), lists, newFolderIn: MAT.folder }));
    expect(layout.rowAt(4)).toMatchObject({ kind: 'newFolder', posinset: 1, setsize: 2 });
    expect(layout.rowAt(5)).toMatchObject({ key: '12', posinset: 2, setsize: 2 });
    expect(layout.indexOfKey(keyOf.newFolder('10'))).toBe(4);
  });

  it('tells which list indexes the rows on screen read', () => {
    const lists = new Map([['10', list([row('11', 'Fall/MAT/a'), row('12', 'Fall/MAT/b')])]]);
    const layout = new TreeLayout(input({ expanded: new Set(['Fall/MAT']), lists }));
    expect(layout.sources(0, layout.count - 1)).toEqual(
      new Map([
        ['10', [0, 1]],
        ['semester', [2]],
      ]),
    );
  });

  it('shows a failed folder as a row that tries again', () => {
    const failed: FolderList = { ...list([]), total: undefined, status: 'error', failedAt: () => true };
    const layout = new TreeLayout(input({ expanded: new Set(['Fall/MAT']), lists: new Map([['10', failed]]) }));
    expect(layout.rowAt(4)).toMatchObject({ kind: 'failed', retry: failed.retry });
  });

  it('marks only the rows of a page that failed; pages still loading wait', () => {
    const rows = Array.from({ length: 450 }, (_, index) => row(String(1000 + index), `Fall/MAT/f${String(index)}`));
    // Page 0 arrived, page 1 failed, page 2 is still on its way.
    const lists = new Map([['10', { ...list(rows, (index) => index < 200), status: 'error' as const, failedAt: (index: number) => index >= 200 && index < 400 }]]);
    const layout = new TreeLayout(input({ expanded: new Set(['Fall/MAT']), lists }));
    expect(layout.rowAt(4 + 250)).toMatchObject({ kind: 'failed' });
    expect(layout.rowAt(4 + 420)).toMatchObject({ kind: 'placeholder' });
  });

  it('says the loose files failed instead of leaving them out', () => {
    const semester: FolderList = { ...list([]), total: undefined, status: 'error', failedAt: () => true };
    const layout = new TreeLayout(input({ semester }));
    expect(keys(layout).slice(-2)).toEqual(['separator:loose', 'failed:semester:2']);
    expect(layout.rowAt(layout.count - 1)).toMatchObject({ kind: 'failed', retry: semester.retry });
  });

  it('leaves the quick views out when asked', () => {
    const layout = new TreeLayout(input({ quickViews: false, semester: list([]), courses: [] }));
    expect(layout.count).toBe(0);
  });
});
