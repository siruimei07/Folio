// Diffs and located versions against the fake shell (ipc-m2 §8.3, §9, §14): one query per
// window, and which events refetch them.
import { act, waitFor } from '@testing-library/react';
import { describe, expect, it, type MockInstance, vi } from 'vitest';

import { type Diff, type DiffWindow, ipc, type VersionRef } from '../ipc';
import type { FakeShell } from '../ipc/mock/shell';
import { NOW } from '../test/data';
import { renderAppHook } from '../test/render';
import { PAGE_GC_TIME } from './client';
import {
  DIFF_WINDOW_ROWS,
  type DiffSource,
  type DiffWindows,
  FIRST_WINDOW,
  useDiffWindows,
  useLocatedVersion,
} from './diff';
import { unwrap } from './errors';
import { keys } from './keys';
import { useSession } from './session';

const MAT = 'Fall 2026/MAT232 Calculus of Several Variables';
const REVIEW = `${MAT}/Exams/Midterm/Midterm review.md`;
const WEEK2 = `${MAT}/week 2 notes.md`;
const DATA_CSV = 'Fall 2026/CSC148 Introduction to Computer Science/labs/lab2/data.csv';
const PAGE = { offset: 0, limit: 500 };
const NO_WINDOWS: readonly DiffWindow[] = [];
const SECOND_WINDOW: DiffWindow = { kind: 'rows', offset: DIFF_WINDOW_ROWS, limit: DIFF_WINDOW_ROWS };
/** A well-formed commit id that no commit has. */
const NO_COMMIT = `b3:${'0'.repeat(64)}`;

interface Props {
  source: DiffSource | null;
  windows: readonly DiffWindow[];
}

const NO_DIFF: Props = { source: null, windows: NO_WINDOWS };

function renderDiff(options: { scenario?: 'small' | 'diffs' } = {}) {
  return renderAppHook(({ source, windows }: Props) => useDiffWindows(source, windows), {
    now: NOW,
    scenario: options.scenario,
    initialProps: NO_DIFF,
  });
}

async function workspaceSource(path: string): Promise<DiffSource> {
  const page = await unwrap(ipc.listWorkspaceItems({ page: PAGE }));
  const found = page.items.find((item) => item.path === path);
  if (found === undefined) throw new Error(`no workspace item at ${path}`);
  return { source: 'workspace', key: found.key };
}

/** The newest version of the file at `path` that a commit stored. */
async function newestVersion(shell: FakeShell, path: string) {
  const node = shell.library.at(path);
  if (node === undefined) throw new Error(`no entry at ${path}`);
  const page = await unwrap(
    ipc.listFileHistory({ file: { kind: 'entry', entry: shell.library.ref(node) }, page: PAGE, types: ['commit'] }),
  );
  const found = page.items[0];
  if (found?.kind !== 'commit') throw new Error(`no version of ${path}`);
  return found;
}

async function versionSource(shell: FakeShell, path: string): Promise<DiffSource> {
  const version = await newestVersion(shell, path);
  return { source: 'version', commit: version.commit.id, key: version.change.key };
}

/** The commit that added the files of the small fixture. */
async function firstCommit(): Promise<string> {
  const page = await unwrap(ipc.listHistory({ page: PAGE, types: ['commit'] }));
  const first = page.items.at(-1);
  if (first?.kind !== 'commit') throw new Error('no first commit');
  return first.commit.id;
}

function rowsOf(diff: Diff | undefined) {
  const content = diff?.content;
  return content?.kind === 'text' || content?.kind === 'word' ? content.text.window : [];
}

function addedTexts(windows: DiffWindows): string[] {
  return rowsOf(windows.windows[0]?.diff).flatMap((row) => (row.kind === 'added' ? [row.text] : []));
}

function calls(invoke: MockInstance<FakeShell['invoke']>, command: string): number {
  return invoke.mock.calls.filter(([name]) => name === command).length;
}

function libraryId(): string {
  return useSession.getState().libraryId ?? '';
}

describe('useDiffWindows', () => {
  it('reads the first window and each window asked for, one query per window under its key', async () => {
    const { result, rerender, client } = renderDiff({ scenario: 'diffs' });
    const source = await workspaceSource(DATA_CSV);
    rerender({ source, windows: NO_WINDOWS });
    expect(result.current.windows[0]?.fetching).toBe(true);
    await waitFor(() => {
      expect(result.current.status).toBe('success');
    });
    expect(result.current.windows[0]?.fetching).toBe(false);
    const fold = rowsOf(result.current.windows[0]?.diff).find((row) => row.kind === 'fold');
    if (fold?.kind !== 'fold') throw new Error('no fold in the first window');
    const unfold: DiffWindow = { kind: 'unchanged', line: fold.new, count: Math.min(fold.lines, DIFF_WINDOW_ROWS) };

    // The first window is asked for once, and first.
    rerender({ source, windows: [unfold, FIRST_WINDOW, SECOND_WINDOW] });

    await waitFor(() => {
      expect(result.current.windows.every((answer) => answer.diff !== undefined)).toBe(true);
    });
    expect(result.current.windows.map((answer) => answer.window)).toEqual([FIRST_WINDOW, unfold, SECOND_WINDOW]);
    const unfolded = rowsOf(result.current.windows[1]?.diff);
    expect(unfolded).toHaveLength(unfold.count);
    expect(unfolded[0]).toMatchObject({ kind: 'context', new: fold.new });
    expect(rowsOf(result.current.windows[2]?.diff)).toHaveLength(DIFF_WINDOW_ROWS);
    const queries = client.getQueryCache().findAll({ queryKey: [...keys.library(libraryId()), 'diff'] });
    expect(queries.map((query) => query.queryKey)).toEqual(
      expect.arrayContaining([FIRST_WINDOW, unfold, SECOND_WINDOW].map((window) => keys.diff(libraryId(), source, window))),
    );
    expect(queries).toHaveLength(3);
    // Windows nobody shows go after a minute, like a list's pages.
    expect(queries.every((query) => query.options.gcTime === PAGE_GC_TIME)).toBe(true);
  });

  it("keys a commit's diff apart from the workspace's, and asks nothing without a source", async () => {
    const { result, rerender, client, shell } = renderDiff();
    expect(result.current.status).toBe('pending');
    const workspace = await workspaceSource(REVIEW);
    const stored = await newestVersion(shell, REVIEW);
    const version: DiffSource = { source: 'version', commit: stored.commit.id, key: stored.change.key };

    rerender({ source: version, windows: NO_WINDOWS });

    await waitFor(() => {
      expect(result.current.status).toBe('success');
    });
    expect(result.current.windows[0]?.diff?.after?.commit).toBe(stored.commit.id);
    expect(client.getQueryData(keys.diff(libraryId(), version, FIRST_WINDOW))).toBe(result.current.windows[0]?.diff);
    expect(client.getQueryData(keys.diff(libraryId(), workspace, FIRST_WINDOW))).toBeUndefined();
  });

  it('keeps its identity while nothing changes', async () => {
    const { result, rerender } = renderDiff();
    const props = { source: await workspaceSource(REVIEW), windows: NO_WINDOWS };
    rerender(props);
    await waitFor(() => {
      expect(result.current.status).toBe('success');
    });
    const before = result.current;

    // A source that is a new object with the same fields reads the same diff.
    rerender({ ...props, source: { ...props.source } });

    expect(result.current).toBe(before);
  });

  it('fails with NotFound for a change or a commit the shell does not have', async () => {
    const { result, rerender } = renderDiff();

    rerender({ source: { source: 'workspace', key: 'gone' }, windows: NO_WINDOWS });

    await waitFor(() => {
      expect(result.current.status).toBe('error');
    });
    expect(result.current.error?.error.code).toBe('NotFound');
    expect(result.current.windows[0]).toMatchObject({ diff: undefined, error: result.current.error });

    rerender({ source: { source: 'version', commit: NO_COMMIT, key: 'gone' }, windows: NO_WINDOWS });

    await waitFor(() => {
      expect(result.current.error?.error.code).toBe('NotFound');
    });
  });

  it('keeps the last answer when its change was committed and the refetch finds nothing', async () => {
    const { result, rerender, shell } = renderDiff();
    const source = await workspaceSource(REVIEW);
    rerender({ source, windows: NO_WINDOWS });
    await waitFor(() => {
      expect(result.current.status).toBe('success');
    });
    const shown = result.current.windows[0]?.diff;

    const workspace = await unwrap(ipc.getWorkspace());
    await unwrap(
      ipc.commit({
        selection: { kind: 'only', keys: [source.key] },
        fingerprint: workspace.fingerprint,
        base: workspace.head,
        summary: 'MAT232: review',
        body: null,
      }),
    );
    shell.finishJobs();

    await waitFor(() => {
      expect(result.current.error?.error.code).toBe('NotFound');
    });
    expect(result.current.status).toBe('error');
    expect(result.current.windows[0]?.diff).toBe(shown);
  });

  it('fetches failed windows again and reloads the whole diff', async () => {
    const { result, rerender, client, shell } = renderDiff({ scenario: 'diffs' });
    const source = await workspaceSource(DATA_CSV);
    shell.setFailure('get_workspace_diff', 'Internal');
    rerender({ source, windows: NO_WINDOWS });
    await waitFor(() => {
      expect(result.current.error?.error.code).toBe('Internal');
    });
    shell.setFailure('get_workspace_diff', null);

    act(() => {
      result.current.retry();
    });

    await waitFor(() => {
      expect(result.current.status).toBe('success');
    });
    // A window read once and no longer asked for stays cached.
    const third: DiffWindow = { kind: 'rows', offset: 2 * DIFF_WINDOW_ROWS, limit: DIFF_WINDOW_ROWS };
    rerender({ source, windows: [third] });
    await waitFor(() => {
      expect(rowsOf(result.current.windows[1]?.diff)).toHaveLength(DIFF_WINDOW_ROWS);
    });
    rerender({ source, windows: NO_WINDOWS });
    expect(client.getQueryData(keys.diff(libraryId(), source, third))).toBeDefined();
    const invoke = vi.spyOn(shell, 'invoke');

    act(() => {
      result.current.reload();
    });

    // The window on screen is read again; the one nobody shows goes, to be read when asked for.
    await waitFor(() => {
      expect(calls(invoke, 'get_workspace_diff')).toBe(1);
    });
    expect(client.getQueryData(keys.diff(libraryId(), source, third))).toBeUndefined();
  });

  it('asks again for a later window that failed only on Try again, not when the view comes back to it', async () => {
    const { result, rerender, shell } = renderDiff({ scenario: 'diffs' });
    const source = await workspaceSource(DATA_CSV);
    rerender({ source, windows: NO_WINDOWS });
    await waitFor(() => {
      expect(result.current.status).toBe('success');
    });
    shell.setFailure('get_workspace_diff', 'Internal');
    const second = [SECOND_WINDOW];
    rerender({ source, windows: second });
    await waitFor(() => {
      expect(result.current.windows[1]?.error?.error.code).toBe('Internal');
    });
    shell.setFailure('get_workspace_diff', null);
    const invoke = vi.spyOn(shell, 'invoke');

    // Scrolled away and back: the window is asked for again, and keeps its failure.
    rerender({ source, windows: NO_WINDOWS });
    rerender({ source, windows: second });
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
    expect(calls(invoke, 'get_workspace_diff')).toBe(0);
    expect(result.current.windows[1]?.error?.error.code).toBe('Internal');

    act(() => {
      result.current.retry();
    });
    await waitFor(() => {
      expect(rowsOf(result.current.windows[1]?.diff)).toHaveLength(DIFF_WINDOW_ROWS);
    });
    expect(calls(invoke, 'get_workspace_diff')).toBe(1);
  });
});

describe('diff events', () => {
  interface Sources {
    workspace: DiffSource | null;
    version: DiffSource | null;
    located: VersionRef | null;
  }
  const NOTHING: Sources = { workspace: null, version: null, located: null };

  it("refetches a workspace diff on the WorkspaceChanged that follows a save, and no commit's", async () => {
    const { result, rerender, shell } = renderAppHook(
      ({ workspace, version }: Sources) => ({
        workspace: useDiffWindows(workspace, NO_WINDOWS),
        version: useDiffWindows(version, NO_WINDOWS),
      }),
      { now: NOW, initialProps: NOTHING },
    );
    rerender({ ...NOTHING, workspace: await workspaceSource(REVIEW), version: await versionSource(shell, REVIEW) });
    await waitFor(() => {
      expect(result.current.workspace.status).toBe('success');
      expect(result.current.version.status).toBe('success');
    });
    expect(addedTexts(result.current.workspace).some((text) => text.startsWith('Edited at'))).toBe(false);
    const invoke = vi.spyOn(shell, 'invoke');

    shell.editFile(REVIEW);

    await waitFor(() => {
      expect(addedTexts(result.current.workspace).some((text) => text.startsWith('Edited at'))).toBe(true);
    });
    expect(calls(invoke, 'get_version_diff')).toBe(0);
  });

  it('refetches no diff on CatalogChanged alone, not even after a rebuild', async () => {
    const { result, rerender, shell } = renderAppHook(
      ({ workspace, version, located }: Sources) => ({
        workspace: useDiffWindows(workspace, NO_WINDOWS).status,
        version: useDiffWindows(version, NO_WINDOWS).status,
        located: useLocatedVersion(located).status,
      }),
      { now: NOW, initialProps: NOTHING },
    );
    rerender({
      workspace: await workspaceSource(REVIEW),
      version: await versionSource(shell, REVIEW),
      located: { commit: await firstCommit(), path: WEEK2 },
    });
    await waitFor(() => {
      expect(result.current).toEqual({ workspace: 'success', version: 'success', located: 'success' });
    });
    const invoke = vi.spyOn(shell, 'invoke');
    const review = shell.library.at(REVIEW);
    if (review === undefined) throw new Error('no review');

    shell.changed([{ kind: 'modified', entry: shell.library.ref(review) }]);
    await act(() => shell.flush());

    // Every located version is refetched: its file may have moved.
    await waitFor(() => {
      expect(calls(invoke, 'locate_version')).toBe(1);
    });

    shell.changedEverything();
    await act(() => shell.flush());

    await waitFor(() => {
      expect(calls(invoke, 'locate_version')).toBe(2);
    });
    expect(calls(invoke, 'get_workspace_diff') + calls(invoke, 'get_version_diff')).toBe(0);
  });
});

describe('useLocatedVersion', () => {
  it("finds a version's file after it moved, follows a deletion, and refetches on HistoryChanged", async () => {
    const { result, rerender, shell } = renderAppHook((version: VersionRef | null) => useLocatedVersion(version), {
      now: NOW,
      initialProps: null as VersionRef | null,
    });
    expect(result.current.fetchStatus).toBe('idle');
    const first = await firstCommit();

    rerender({ commit: first, path: `${MAT}/ps2 solutions.md` });

    await waitFor(() => {
      expect(result.current.data?.path).toBe(`${MAT}/Problem sets/ps2 solutions.md`);
    });

    rerender({ commit: first, path: WEEK2 });
    await waitFor(() => {
      expect(result.current.data?.path).toBe(WEEK2);
    });
    shell.deleteFile(WEEK2);

    // CatalogChanged reports the deletion: the version's file is gone.
    await waitFor(() => {
      expect(result.current.data).toBeNull();
    });
    const invoke = vi.spyOn(shell, 'invoke');

    shell.historyChanged();

    await waitFor(() => {
      expect(calls(invoke, 'locate_version')).toBe(1);
    });
    expect(result.current.data).toBeNull();
  });

  it('fails with NotFound for a commit the history does not have', async () => {
    const { result } = renderAppHook(() => useLocatedVersion({ commit: NO_COMMIT, path: WEEK2 }), { now: NOW });

    await waitFor(() => {
      expect(result.current.error?.error.code).toBe('NotFound');
    });
  });
});
