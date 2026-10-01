// Opening files and resolving the paths a note names, against the fake shell (ipc-m1 §9.1, §11.1).
import { waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { type EntryRef, ipc, LIMITS } from '../ipc';
import { BY_NAME, NOW, smallRef } from '../test/data';
import { renderAppHook } from '../test/render';
import { useChildren } from './entries';
import { unwrap } from './errors';
import { useOpenEntry, useResolvedPaths, useRevealEntry } from './files';

const MAT = 'Fall 2026/MAT232 Calculus of Several Variables';
const CSC = 'Fall 2026/CSC148 Introduction to Computer Science';
const SETS = `${MAT}/Problem sets`;
const note = smallRef(`${SETS}/ps2 solutions.md`);

describe('open_entry and reveal_entry', () => {
  it('opens files and folders, a script in its editor, and never a program', async () => {
    const { result } = renderAppHook(() => ({ open: useOpenEntry() }), { now: NOW });
    await expect(result.current.open.mutateAsync({ entry: smallRef(`${SETS}/PS1.pdf`) })).resolves.toEqual({
      mode: 'default',
    });
    await expect(result.current.open.mutateAsync({ entry: smallRef(MAT) })).resolves.toEqual({ mode: 'default' });
    await expect(result.current.open.mutateAsync({ entry: smallRef(`${CSC}/a1/run.bat`) })).resolves.toEqual({
      mode: 'editor',
    });

    const setup = await unwrap(ipc.renameEntry({ entry: smallRef('README.txt'), name: 'setup.exe' }));
    await expect(result.current.open.mutateAsync({ entry: setup })).rejects.toMatchObject({
      error: { code: 'Blocked' },
    });
  });

  it('reveals an entry; a stale one is NotFound, and the list that showed it is asked again', async () => {
    const stale = smallRef(`${SETS}/PS1.pdf`);
    const { result, shell } = renderAppHook(
      () => ({ rows: useChildren(smallRef(SETS), BY_NAME, { start: 0, end: 20 }), reveal: useRevealEntry() }),
      { now: NOW, eventDelayMs: 60_000 },
    );
    await expect(result.current.reveal.mutateAsync({ entry: stale })).resolves.toBeNull();
    await waitFor(() => {
      expect(result.current.rows.status).toBe('success');
    });
    await unwrap(ipc.deleteEntries({ entries: [stale] }));
    const invoke = vi.spyOn(shell, 'invoke');

    await expect(result.current.reveal.mutateAsync({ entry: stale })).rejects.toMatchObject({
      error: { code: 'NotFound' },
    });

    await waitFor(() => {
      expect(invoke.mock.calls.some(([command]) => command === 'list_children')).toBe(true);
    });
  });
});

describe('useResolvedPaths', () => {
  it('answers one row or null per path, in order, duplicates included', async () => {
    const paths = [
      'PS1.pdf',
      '../Lectures/Lecture 01.pdf',
      './ps1.PDF', // a case-only difference resolves as Windows would
      'PS1.pdf',
      'missing.png',
      '/Lectures/Lecture 01.pdf', // absolute
      'https://example.com/a.png',
      '../Lectures', // a folder
      '../../../../outside.png', // above the root
    ];
    const { result } = renderAppHook(() => useResolvedPaths(note, paths), { now: NOW });
    await waitFor(() => {
      expect(result.current.status).toBe('success');
    });
    expect(result.current.data?.map((row) => row?.path ?? null)).toEqual([
      `${SETS}/PS1.pdf`,
      `${MAT}/Lectures/Lecture 01.pdf`,
      `${SETS}/PS1.pdf`,
      `${SETS}/PS1.pdf`,
      null,
      null,
      null,
      null,
      null,
    ]);
  });

  it('answers null for paths the shell would refuse, without failing the others', async () => {
    const paths = ['bad \uD800 name.png', 'x'.repeat(LIMITS.relativePathChars + 1), 'PS2.pdf'];
    const { result, shell } = renderAppHook(() => useResolvedPaths(note, paths), { now: NOW });
    const invoke = vi.spyOn(shell, 'invoke');
    await waitFor(() => {
      expect(result.current.data).toEqual([null, null, expect.objectContaining({ name: 'PS2.pdf' })]);
    });
    // Asked again by the test only, to see the request: the refused paths never leave the window.
    await result.current.refetch();
    expect(invoke).toHaveBeenCalledWith('resolve_paths', { request: { base: note, paths: ['PS2.pdf'] } });
  });

  it('asks in groups of at most LIMITS.resolvePaths', async () => {
    const paths = Array.from({ length: LIMITS.resolvePaths + 6 }, (_, index) => `PS${String((index % 10) + 1)}.pdf`);
    const { result, shell } = renderAppHook(() => useResolvedPaths(note, paths), { now: NOW });
    await waitFor(() => {
      expect(result.current.data).toHaveLength(paths.length);
    });
    expect(result.current.data?.every((row) => row !== null)).toBe(true);
    const invoke = vi.spyOn(shell, 'invoke');
    await result.current.refetch();
    expect(invoke.mock.calls.map(([, payload]) => (payload as { request: { paths: string[] } }).request.paths.length)).toEqual([
      LIMITS.resolvePaths,
      6,
    ]);
  });

  it('asks again when the catalog changes: a file the note names may appear', async () => {
    const { result } = renderAppHook(() => useResolvedPaths(note, ['figure.png']), { now: NOW });
    await waitFor(() => {
      expect(result.current.data).toEqual([null]);
    });

    await unwrap(ipc.renameEntry({ entry: smallRef(`${SETS}/PS10.pdf`), name: 'figure.png' }));

    await waitFor(() => {
      expect(result.current.data?.[0]?.path).toBe(`${SETS}/figure.png`);
    });
  });

  it('asks nothing without a note or without paths; a stale note is NotFound', async () => {
    const { result, rerender, shell } = renderAppHook(
      ({ base, paths }: { base: EntryRef | null; paths: string[] }) => useResolvedPaths(base, paths),
      { initialProps: { base: null as EntryRef | null, paths: ['PS1.pdf'] }, now: NOW },
    );
    const invoke = vi.spyOn(shell, 'invoke');
    expect(result.current.fetchStatus).toBe('idle');

    rerender({ base: note, paths: [] });
    await waitFor(() => {
      expect(result.current.data).toEqual([]);
    });
    expect(invoke).not.toHaveBeenCalled();

    await unwrap(ipc.deleteEntries({ entries: [note] }));
    rerender({ base: note, paths: ['PS1.pdf'] });
    await waitFor(() => {
      expect(result.current.error?.error.code).toBe('NotFound');
    });
  });
});
