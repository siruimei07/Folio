import { describe, expect, it } from 'vitest';

import type { Course, EntryRow } from '../../ipc';
import { FilteredLayout } from './filtered';

function file(id: string, path: string, tags: string[] = []): EntryRow {
  return {
    id,
    path,
    name: path.slice(path.lastIndexOf('/') + 1),
    kind: 'file',
    class: 'other',
    size: '1',
    modifiedMs: null,
    addedMs: '0',
    tags,
    folderTags: [],
  };
}

function course(id: string, path: string): Course {
  return { folder: { id, path }, name: path.split('/')[1] ?? '', abbr: null, code: null, color: null, archived: false, files: 9 };
}

const compare = new Intl.Collator('en', { numeric: true, sensitivity: 'base' }).compare;

describe('FilteredLayout', () => {
  it('builds courses in their order, folders before files, then loose files', () => {
    const layout = new FilteredLayout({
      quickViews: true,
      courses: [course('20', 'Fall/Zoology'), course('10', 'Fall/Algebra')],
      semesterPath: 'Fall',
      compare,
      rows: [
        file('1', 'Fall/Algebra/hw10.pdf'),
        file('2', 'Fall/Algebra/hw2.pdf'),
        file('3', 'Fall/Algebra/Labs/lab1.py'),
        file('4', 'Fall/Zoology/notes.md'),
        file('5', 'Fall/syllabus.pdf'),
      ],
    });
    const rows = Array.from({ length: layout.count }, (_, index) => layout.rowAt(index));
    expect(rows.map((row) => row.key)).toEqual([
      'quick:recent',
      'quick:untagged',
      'separator:quick',
      '20',
      '4',
      '10',
      'path:Fall/Algebra/Labs',
      '3',
      '2',
      '1',
      'separator:loose',
      '5',
    ]);
    expect(rows[5]).toMatchObject({ kind: 'course', count: 3, expanded: true });
    expect(rows[6]).toMatchObject({ kind: 'pathFolder', level: 2, posinset: 1, setsize: 3 });
    expect(rows[7]).toMatchObject({ level: 3 });
    expect(layout.indexOfKey('2')).toBe(8);
    // A new folder from a file goes into its course, never into a folder known by path only.
    expect(layout.folderAt(8)).toEqual({ id: '10', path: 'Fall/Algebra' });
    expect(layout.folderAt(7)).toBeNull();
  });

  it('shows only the quick views when nothing matches', () => {
    const layout = new FilteredLayout({ quickViews: true, courses: [], semesterPath: 'Fall', compare, rows: [] });
    expect(Array.from({ length: layout.count }, (_, index) => layout.rowAt(index).key)).toEqual([
      'quick:recent',
      'quick:untagged',
    ]);
  });
});
