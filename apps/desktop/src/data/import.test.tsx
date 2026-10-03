// Import against the fake shell (ipc-m1 §12; library-actions handoff §3–§5): the file dialog's
// token, the check that follows the target folder, the job that adds the files, and drops on the
// window.
import { act, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { type EntryRef, type FilesDropped, ipc } from '../ipc';
import { events } from '../ipc/bindings';
import { BY_NAME, NOW, smallRef } from '../test/data';
import { renderAppHook } from '../test/render';
import { useChildren } from './entries';
import { unwrap } from './errors';
import {
  useDropFailed,
  useDropHoverEvents,
  useFilesDropped,
  useImportCheck,
  useImportFiles,
  usePickImportFiles,
} from './import';
import { useJob } from './jobs';

const CSC = 'Fall 2026/CSC148 Introduction to Computer Science';
const csc = smallRef(CSC);

async function pick(result: { current: { pick: ReturnType<typeof usePickImportFiles> } }) {
  const source = await result.current.pick.mutateAsync();
  if (source === null) throw new Error('cancelled');
  return source;
}

describe('pick_import_files', () => {
  it('answers with a token and the first top-level items, or null when cancelled', async () => {
    const { result } = renderAppHook(() => ({ pick: usePickImportFiles() }), { now: NOW });
    await expect(pick(result)).resolves.toEqual({
      token: expect.stringMatching(/^[0-9a-f]{32}$/) as string,
      files: 2,
      folders: 1,
      names: [
        { name: 'Lecture 05 - Gradients.pdf', kind: 'file' },
        { name: 'hw3.py', kind: 'file' },
        { name: 'Lab 2', kind: 'folder' },
      ],
    });
  });
});

describe('useImportCheck', () => {
  it('reports what adding the files would do, and follows what the target holds', async () => {
    let source: string | null = null;
    const { result, rerender } = renderAppHook(
      (target: EntryRef | null) => ({ pick: usePickImportFiles(), check: useImportCheck(source, target) }),
      { initialProps: null as EntryRef | null, now: NOW },
    );
    expect(result.current.check.fetchStatus).toBe('idle');
    source = (await pick(result)).token;

    rerender(csc);

    await waitFor(() => {
      expect(result.current.check.data).toEqual({
        files: 4,
        folders: 1,
        bytes: String(3 * 1024 * 1024 + 2310 + 71000 + 4410),
        skipped: 2,
        conflicts: [{ path: `${CSC}/hw3.py` }],
        conflictCount: 1,
      });
    });

    // The clash goes away when the file in the target is renamed.
    await unwrap(ipc.renameEntry({ entry: smallRef(`${CSC}/hw3.py`), name: 'hw03.py' }));
    await waitFor(() => {
      expect(result.current.check.data?.conflictCount).toBe(0);
    });

    // Another target is another check.
    rerender(smallRef(`${CSC}/labs`));
    await waitFor(() => {
      expect(result.current.check.data).toMatchObject({ conflictCount: 0, files: 4 });
    });
  });

  it('keeps errors typed: an unknown token, a target that is a file', async () => {
    const { result, rerender } = renderAppHook(
      ({ source, target }: { source: string; target: EntryRef }) => useImportCheck(source, target),
      { initialProps: { source: '0'.repeat(32), target: csc }, now: NOW },
    );
    await waitFor(() => {
      expect(result.current.error?.error.code).toBe('ChoiceExpired');
    });

    const source = await unwrap(ipc.pickImportFiles());
    rerender({ source: source?.token ?? '', target: smallRef(`${CSC}/hw1.py`) });
    await waitFor(() => {
      expect(result.current.error?.error.code).toBe('InvalidArgument');
    });
  });
});

describe('import_files', () => {
  it('starts a job that adds the files; its result and the files arrive by events', async () => {
    let job = '';
    const { result } = renderAppHook(
      () => ({
        pick: usePickImportFiles(),
        run: useImportFiles(),
        job: useJob(job),
        rows: useChildren(csc, BY_NAME, { start: 0, end: 50 }),
      }),
      { now: NOW },
    );
    await waitFor(() => {
      expect(result.current.rows.total).toBe(9);
    });
    const source = await pick(result);

    job = await result.current.run.mutateAsync({
      source: source.token,
      target: csc,
      tags: ['homework'],
      onConflict: 'keepBoth',
      deleteOriginals: false,
    });

    await waitFor(() => {
      expect(result.current.job?.status).toMatchObject({
        state: 'done',
        // node_modules and what is in it are left out; hw3.py is kept as a copy.
        result: { kind: 'import', imported: 4, renamed: 1, skipped: 2, failureCount: 0 },
      });
    });
    await waitFor(() => {
      expect(result.current.rows.total).toBe(12);
    });

    // The token is used up.
    await expect(
      result.current.run.mutateAsync({
        source: source.token,
        target: csc,
        tags: [],
        onConflict: 'skip',
        deleteOriginals: false,
      }),
    ).rejects.toMatchObject({ error: { code: 'ChoiceExpired' } });
  });

  it('a target that is gone rejects, typed, and its list is asked again at once', async () => {
    const labs = smallRef(`${CSC}/labs`);
    const { result, shell } = renderAppHook(
      () => ({ pick: usePickImportFiles(), run: useImportFiles(), rows: useChildren(csc, BY_NAME, { start: 0, end: 50 }) }),
      { now: NOW, eventDelayMs: 60_000 },
    );
    await waitFor(() => {
      expect(result.current.rows.status).toBe('success');
    });
    const source = await pick(result);
    await unwrap(ipc.deleteEntries({ entries: [labs] }));
    const invoke = vi.spyOn(shell, 'invoke');

    await expect(
      result.current.run.mutateAsync({
        source: source.token,
        target: labs,
        tags: [],
        onConflict: 'keepBoth',
        deleteOriginals: false,
      }),
    ).rejects.toMatchObject({ error: { code: 'NotFound' } });
    await waitFor(() => {
      expect(invoke.mock.calls.some(([command]) => command === 'list_children')).toBe(true);
    });
  });
});

describe('drops', () => {
  it('reports every drop with its source', async () => {
    const dropped: FilesDropped[] = [];
    const { shell } = renderAppHook(
      () => {
        useFilesDropped((drop) => {
          dropped.push(drop);
        });
      },
      { now: NOW },
    );
    // Listeners register asynchronously; let them settle before the drop.
    await act(() => shell.flush());

    act(() => {
      shell.dropFiles(undefined, { x: 120, y: 80 });
    });

    await waitFor(() => {
      expect(dropped).toHaveLength(1);
    });
    expect(dropped[0]).toMatchObject({ position: { x: 120, y: 80 }, source: { files: 2, folders: 1 } });
  });

  it('reports where files are dragged over the window, when they leave, and drops the shell refused', async () => {
    const hovers: unknown[] = [];
    const failures: unknown[] = [];
    const { shell } = renderAppHook(
      () => {
        useDropHoverEvents((position) => hovers.push(position));
        useDropFailed((failure) => failures.push(failure));
      },
      { now: NOW },
    );
    await act(() => shell.flush());

    await act(() => events.dropHover.emit({ position: { x: 12, y: 34 } }));
    await act(() => events.dropHover.emit({ position: null }));
    await waitFor(() => {
      expect(hovers).toEqual([{ x: 12, y: 34 }, null]);
    });

    await act(() => events.dropFailed.emit({ error: { code: 'InvalidArgument', detail: 'too many' } }));
    await waitFor(() => {
      expect(failures).toEqual([{ error: { code: 'InvalidArgument', detail: 'too many' } }]);
    });
  });
});
