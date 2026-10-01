// The entry mutations against the fake shell (ipc-m1 §9.2): their answers, the CatalogChanged that
// refreshes the lists and moves held references, batches that keep every failed item, and stale
// references, whose lists are refreshed at once.
import { waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { type EntryRef, ipc } from '../ipc';
import { BY_NAME, FIRST_ROWS, followUntilTestEnds, NOW, smallRef } from '../test/data';
import { renderAppHook } from '../test/render';
import {
  useChildren,
  useCreateFolder,
  useDeleteEntries,
  useEntry,
  useFolderChildren,
  useMoveEntries,
  useRenameEntry,
} from './entries';
import { unwrap } from './errors';
import { followRef } from './references';

const CSC = 'Fall 2026/CSC148 Introduction to Computer Science';
const ECO = 'Fall 2026/ECO101 微观经济学';
const csc = smallRef(CSC);
const labs = smallRef(`${CSC}/labs`);
const hw1 = smallRef(`${CSC}/hw1.py`);

/** Names of the first rows of a list. */
function names(list: { rowAt: (index: number) => { name: string } | undefined; total?: number }) {
  return Array.from({ length: list.total ?? 0 }, (_, index) => list.rowAt(index)?.name);
}

/** Holds `entry` as a store would, following the catalog until the test ends. */
function hold(entry: EntryRef) {
  const held = { current: entry as EntryRef | null };
  followUntilTestEnds((update) => {
    if (update.kind === 'changes' && held.current) held.current = followRef(held.current, update.changes);
  });
  return held;
}

describe('useFolderChildren', () => {
  it("keeps a folder's list while another folder's page arrives, and can load any page", async () => {
    const eco = smallRef(ECO);
    let folders = [{ folder: csc, pages: [0] }];
    const { result, rerender } = renderAppHook(() => useFolderChildren(folders, BY_NAME), { now: NOW });
    await waitFor(() => {
      expect(result.current[0]?.total).toBeGreaterThan(0);
    });
    const before = result.current[0];

    folders = [...folders, { folder: eco, pages: [0] }];
    rerender();
    await waitFor(() => {
      expect(result.current[1]?.total).toBeGreaterThan(0);
    });
    expect(result.current[0]).toBe(before);

    const page = await result.current[0]?.loadPage(0);
    expect(page?.items.map((row) => row.name)).toContain('hw1.py');
  });
});

describe('create_folder', () => {
  it('answers with the new row; the folder shows once its event arrives', async () => {
    const { result } = renderAppHook(
      () => ({ rows: useChildren(labs, BY_NAME, FIRST_ROWS), create: useCreateFolder() }),
      { now: NOW },
    );
    await waitFor(() => {
      expect(names(result.current.rows)).toEqual(['lab1', 'lab2']);
    });

    const row = await result.current.create.mutateAsync({ parent: labs, name: 'lab3' });

    expect(row).toMatchObject({ name: 'lab3', path: `${CSC}/labs/lab3`, kind: 'folder' });
    await waitFor(() => {
      expect(names(result.current.rows)).toEqual(['lab1', 'lab2', 'lab3']);
    });
    expect(result.current.rows.rowKey(2)).toBe(row.id);
  });

  it('keeps errors typed: outside a course, a taken name, an invalid name', async () => {
    const { result } = renderAppHook(() => useCreateFolder(), { now: NOW });
    const cases: [EntryRef, string, string][] = [
      [smallRef('Fall 2026'), 'Misc', 'InvalidArgument'],
      [labs, 'LAB1', 'AlreadyExists'],
      [labs, 'lab?', 'NameInvalidCharacter'],
      [labs, '   ', 'NameEmpty'],
    ];
    for (const [parent, name, code] of cases) {
      await expect(result.current.mutateAsync({ parent, name })).rejects.toMatchObject({ error: { code } });
    }
  });
});

describe('rename_entry', () => {
  it('answers with the row under the same id; the list and held references follow', async () => {
    const { result } = renderAppHook(
      () => ({ rows: useChildren(csc, BY_NAME, FIRST_ROWS), rename: useRenameEntry() }),
      { now: NOW },
    );
    await waitFor(() => {
      expect(result.current.rows.rowAt(2)?.name).toBe('hw1.py');
    });
    const held = hold(hw1);

    const row = await result.current.rename.mutateAsync({ entry: hw1, name: 'hw01.py' });

    expect(row).toMatchObject({ id: hw1.id, path: `${CSC}/hw01.py` });
    await waitFor(() => {
      expect(result.current.rows.rowAt(2)?.name).toBe('hw01.py');
    });
    expect(held.current).toEqual({ id: hw1.id, path: `${CSC}/hw01.py` });
  });

  it('renaming a folder moves what is held below it', async () => {
    const lab1 = smallRef(`${CSC}/labs/lab1/lab1.py`);
    const { result } = renderAppHook(() => useRenameEntry(), { now: NOW });
    const held = hold(lab1);

    await result.current.mutateAsync({ entry: labs, name: 'Labs' });

    await waitFor(() => {
      expect(held.current).toEqual({ id: lab1.id, path: `${CSC}/Labs/lab1/lab1.py` });
    });
  });

  it('keeps errors typed: a taken name, a file another program holds', async () => {
    const { result } = renderAppHook(() => useRenameEntry(), { now: NOW });
    await expect(result.current.mutateAsync({ entry: hw1, name: 'HW2.py' })).rejects.toMatchObject({
      error: { code: 'AlreadyExists' },
    });
    await expect(
      result.current.mutateAsync({ entry: smallRef(`${ECO}/Lecture recording week 5.mp4`), name: 'week 5.mp4' }),
    ).rejects.toMatchObject({ error: { code: 'InUse' } });
  });
});

describe('a stale reference', () => {
  it('answers NotFound and refreshes the lists that showed it at once, not what it keys', async () => {
    const { result, shell } = renderAppHook(
      () => {
        // Read during render, so the probe renders again when they change.
        const { data, error } = useEntry(hw1);
        return { rows: useChildren(csc, BY_NAME, FIRST_ROWS), entry: { data, error }, rename: useRenameEntry() };
      },
      // The first rename's CatalogChanged does not arrive during the test.
      { now: NOW, eventDelayMs: 60_000 },
    );
    await waitFor(() => {
      expect(result.current.entry.data?.name).toBe('hw1.py');
    });
    await waitFor(() => {
      expect(result.current.rows.rowAt(2)?.name).toBe('hw1.py');
    });
    await unwrap(ipc.renameEntry({ entry: hw1, name: 'hw01.py' }));
    const invoke = vi.spyOn(shell, 'invoke');

    await expect(result.current.rename.mutateAsync({ entry: hw1, name: 'first.py' })).rejects.toMatchObject({
      error: { code: 'NotFound' },
    });

    await waitFor(() => {
      expect(result.current.rows.rowAt(2)?.name).toBe('hw01.py');
    });
    // The entry query keyed by the stale reference waits for the followers; asked now, it would
    // only answer NotFound.
    expect(invoke.mock.calls.filter(([command]) => command === 'get_entry')).toHaveLength(0);
    expect(result.current.entry.error).toBeNull();
  });
});

describe('move_entries', () => {
  it('moves into a folder: both lists and held references follow', async () => {
    const report = smallRef(`${CSC}/labs/lab1/report.docx`);
    const lab2 = smallRef(`${CSC}/labs/lab2`);
    const { result } = renderAppHook(
      () => ({
        from: useChildren(smallRef(`${CSC}/labs/lab1`), BY_NAME, FIRST_ROWS),
        to: useChildren(lab2, BY_NAME, FIRST_ROWS),
        move: useMoveEntries(),
      }),
      { now: NOW },
    );
    await waitFor(() => {
      expect(names(result.current.from)).toEqual(['lab1.py', 'report.docx']);
    });
    await waitFor(() => {
      expect(names(result.current.to)).toEqual(['data.csv', 'lab2.py']);
    });
    const held = hold(report);

    await expect(result.current.move.mutateAsync({ entries: [report], to: lab2 })).resolves.toEqual({
      done: 1,
      failed: [],
    });

    await waitFor(() => {
      expect(names(result.current.from)).toEqual(['lab1.py']);
    });
    await waitFor(() => {
      expect(names(result.current.to)).toEqual(['data.csv', 'lab2.py', 'report.docx']);
    });
    expect(held.current).toEqual({ id: report.id, path: `${CSC}/labs/lab2/report.docx` });
  });

  it('resolves with every item that failed, each with its typed error, in order', async () => {
    const gone = smallRef(`${CSC}/hw2.py`);
    const { result } = renderAppHook(() => useMoveEntries(), { now: NOW });
    await unwrap(ipc.deleteEntries({ entries: [gone] }));

    const outcome = await result.current.mutateAsync({
      entries: [
        smallRef(`${CSC}/hw3.py`),
        labs, // into itself
        smallRef(`${CSC}/labs/lab1/lab1.py`), // already in the target
        gone,
        smallRef('Fall 2025'), // a semester
        smallRef(`${CSC}/a1/run.bat`),
      ],
      to: smallRef(`${CSC}/labs/lab1`),
    });

    expect(outcome.done).toBe(3);
    expect(outcome.failed.map(({ entry, error }) => [entry, error.code])).toEqual([
      [labs, 'InvalidMove'],
      [gone, 'NotFound'],
      [smallRef('Fall 2025'), 'InvalidMove'],
    ]);
  });

  it('a name taken in the target, ignoring case, fails that item only', async () => {
    const { result } = renderAppHook(() => useMoveEntries(), { now: NOW });
    const outcome = await result.current.mutateAsync({
      entries: [smallRef('Personal/Todo.txt'), smallRef('Personal/todo.txt')],
      to: smallRef('Personal/Photos'),
    });
    expect(outcome.done).toBe(1);
    expect(outcome.failed.map(({ entry, error }) => [entry, error.code])).toEqual([
      [smallRef('Personal/todo.txt'), 'AlreadyExists'],
    ]);
  });

  it('rejects as a whole, typed, when the target is gone', async () => {
    const { result } = renderAppHook(() => useMoveEntries(), { now: NOW });
    await unwrap(ipc.deleteEntries({ entries: [labs] }));
    await expect(result.current.mutateAsync({ entries: [hw1], to: labs })).rejects.toMatchObject({
      error: { code: 'NotFound' },
    });
  });
});

describe('delete_entries', () => {
  it('moves entries to the Recycle Bin; the list follows and held references are dropped', async () => {
    const { result } = renderAppHook(
      () => ({ rows: useChildren(labs, BY_NAME, FIRST_ROWS), remove: useDeleteEntries() }),
      { now: NOW },
    );
    await waitFor(() => {
      expect(names(result.current.rows)).toEqual(['lab1', 'lab2']);
    });
    const held = hold(smallRef(`${CSC}/labs/lab2/data.csv`));

    await expect(result.current.remove.mutateAsync({ entries: [smallRef(`${CSC}/labs/lab2`)] })).resolves.toEqual({
      done: 1,
      failed: [],
    });

    await waitFor(() => {
      expect(names(result.current.rows)).toEqual(['lab1']);
    });
    expect(held.current).toBeNull();
  });

  it('resolves with every item that failed, each with its typed error; those stay', async () => {
    const recording = smallRef(`${ECO}/Lecture recording week 5.mp4`);
    const scans = smallRef('Personal/Archive/2024/Scans/Receipts');
    const { result } = renderAppHook(
      () => ({ rows: useChildren(smallRef(ECO), BY_NAME, FIRST_ROWS), remove: useDeleteEntries() }),
      { now: NOW },
    );
    await waitFor(() => {
      expect(result.current.rows.total).toBe(4);
    });

    const outcome = await result.current.remove.mutateAsync({
      entries: [smallRef(`${ECO}/Problem set 1.docx`), recording, scans, smallRef(`${ECO}/Problem set 1.docx`)],
    });

    expect(outcome.done).toBe(1);
    expect(outcome.failed.map(({ entry, error }) => [entry, error.code])).toEqual([
      [recording, 'InUse'],
      [scans, 'NotRecyclable'],
      [smallRef(`${ECO}/Problem set 1.docx`), 'NotFound'],
    ]);
    await waitFor(() => {
      expect(result.current.rows.total).toBe(3);
    });
    expect(names(result.current.rows)).toContain('Lecture recording week 5.mp4');
  });
});
