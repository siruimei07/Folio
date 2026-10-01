import { describe, expect, it, vi } from 'vitest';

import { type EntryChange, type EntryRef, ipc } from '../ipc';
import {
  followPath,
  followReferences,
  followRef,
  publishReferences,
  recheck,
} from './references';

vi.mock('../ipc', { spy: true });

const ref = (id: string, path: string): EntryRef => ({ id, path });
const moved = (target: EntryRef, from: string): EntryChange => ({ kind: 'moved', entry: target, from });
const removed = (target: EntryRef): EntryChange => ({ kind: 'removed', entry: target });

describe('followRef', () => {
  const note = ref('7', 'Fall 2026/MAT232/Notes/week 2.md');

  it('takes the new path of the entry itself', () => {
    const change = moved(ref('7', 'Fall 2026/MAT232/week 2.md'), note.path);
    expect(followRef(note, [change])).toEqual(ref('7', 'Fall 2026/MAT232/week 2.md'));
  });

  it('takes the new prefix when a folder above it moves', () => {
    const change = moved(ref('3', 'Winter 2026/MAT232'), 'Fall 2026/MAT232');
    expect(followRef(note, [change])).toEqual(ref('7', 'Winter 2026/MAT232/Notes/week 2.md'));
  });

  it('follows moves one after another', () => {
    const changes = [
      moved(ref('5', 'Fall 2026/MAT232/Lecture notes'), 'Fall 2026/MAT232/Notes'),
      moved(ref('7', 'Fall 2026/MAT232/Lecture notes/Week 2.md'), 'Fall 2026/MAT232/Lecture notes/week 2.md'),
    ];
    expect(followRef(note, changes)).toEqual(ref('7', 'Fall 2026/MAT232/Lecture notes/Week 2.md'));
  });

  it('keeps the same object when nothing moved it', () => {
    const changes: EntryChange[] = [
      moved(ref('8', 'Fall 2026/MAT232/Notes/other.md'), 'Fall 2026/MAT232/other.md'),
      // A sibling whose name starts like the note's folder.
      moved(ref('9', 'Personal/Notes2'), 'Fall 2026/MAT232/Notes2'),
      { kind: 'modified', entry: note },
    ];
    expect(followRef(note, changes)).toBe(note);
  });

  it('is `null` once the entry or a folder above it went away', () => {
    expect(followRef(note, [removed(note)])).toBeNull();
    expect(followRef(note, [removed(ref('5', 'Fall 2026/MAT232/Notes'))])).toBeNull();
    // Moved first, then removed at its new path.
    const change = moved(ref('7', 'Personal/week 2.md'), note.path);
    expect(followRef(note, [change, removed(ref('7', 'Personal/week 2.md'))])).toBeNull();
  });

  it('keeps a reference whose path another, removed entry had', () => {
    expect(followRef(note, [removed(ref('99', note.path))])).toBe(note);
  });
});

describe('followPath', () => {
  it('follows an expanded folder that moved, or one above it', () => {
    const change = moved(ref('3', 'Winter 2026/MAT232'), 'Fall 2026/MAT232');
    expect(followPath('Fall 2026/MAT232', [change])).toBe('Winter 2026/MAT232');
    expect(followPath('Fall 2026/MAT232/Labs/Lab 1', [change])).toBe('Winter 2026/MAT232/Labs/Lab 1');
    expect(followPath('Fall 2026/MAT2320', [change])).toBe('Fall 2026/MAT2320');
  });

  it('is `null` once the folder or one above it went away', () => {
    expect(followPath('Fall 2026/MAT232', [removed(ref('3', 'Fall 2026/MAT232'))])).toBeNull();
    expect(followPath('Fall 2026/MAT232/Labs', [removed(ref('3', 'Fall 2026'))])).toBeNull();
    expect(followPath('Fall 2026/MAT232', [removed(ref('4', 'Fall 2026/MAT23'))])).toBe(
      'Fall 2026/MAT232',
    );
  });
});

describe('publishReferences', () => {
  it('hands each update to every follower until it stops following', () => {
    const first = vi.fn();
    const second = vi.fn();
    const stopFirst = followReferences(first);
    const stopSecond = followReferences(second);

    publishReferences({ kind: 'rebuilt' });
    stopFirst();
    publishReferences({ kind: 'reset' });
    stopSecond();

    expect(first.mock.calls).toEqual([[{ kind: 'rebuilt' }]]);
    expect(second.mock.calls).toEqual([[{ kind: 'rebuilt' }], [{ kind: 'reset' }]]);
  });

  it('still reaches the other followers when one throws, and reports its error', () => {
    const report = vi.fn();
    const original = globalThis.reportError;
    // Not `vi.stubGlobal`: undoing it would also undo the setup's ResizeObserver.
    globalThis.reportError = report;
    const thrown = new Error('bug in a store');
    const after = vi.fn();
    const stops = [
      followReferences(() => {
        throw thrown;
      }),
      followReferences(after),
    ];

    publishReferences({ kind: 'reset' });
    for (const stop of stops) stop();
    globalThis.reportError = original;

    expect(after).toHaveBeenCalledOnce();
    expect(report.mock.calls).toEqual([[thrown]]);
  });
});

describe('recheck', () => {
  it('keeps what still names an entry, at its current path, and drops only `NotFound`', async () => {
    vi.mocked(ipc.getEntry).mockImplementation(({ entry }) => {
      if (entry.id === '1') {
        return Promise.resolve({
          status: 'ok',
          data: {
            id: '1',
            path: 'a.md',
            name: 'a.md',
            kind: 'file',
            class: 'text',
            size: '1',
            modifiedMs: null,
            addedMs: '0',
            tags: [],
            folderTags: [],
          },
        });
      }
      const code = entry.id === '2' ? 'NotFound' : 'Busy';
      return Promise.resolve({ status: 'error', error: { code, detail: '' } });
    });

    await expect(recheck([ref('1', 'a.md'), ref('2', 'b.md'), ref('3', 'c.md')])).resolves.toEqual([
      ref('1', 'a.md'),
      ref('3', 'c.md'),
    ]);
  });
});
