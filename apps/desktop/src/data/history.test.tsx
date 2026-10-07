// The history's hooks against the fake shell (ipc-m2 §8, §10, §14): pages and totals, the types
// filter, file histories, the first commit, restore plans, the commands, and which events refetch
// what.
import { act, waitFor } from '@testing-library/react';
import { describe, expect, it, type MockInstance, vi } from 'vitest';

import { type FileRef, type HistoryItem, type HistoryType, ipc, type PageRequest, type VersionRef } from '../ipc';
import type { FakeShell } from '../ipc/mock/shell';
import { NOW, smallRef } from '../test/data';
import { refOf } from '../test/files';
import { smallHistoryWith } from '../test/history';
import { renderAppHook, settle } from '../test/render';
import { unwrap } from './errors';
import { keys } from './keys';
import { useSession } from './session';
import {
  CHANGES_PAGE,
  fileVersionKey,
  HISTORY_PAGE,
  historyItemKey,
  type HistoryPages,
  useCommitChanges,
  useCommitMetadata,
  useFileHistory,
  useFirstCommit,
  useHistoryTimeline,
  useRestorePlan,
  useRestoreVersion,
  useRewordCommit,
  useUncommit,
  useVersionChange,
} from './history';

const MAT = 'Fall 2026/MAT232 Calculus of Several Variables';
const CSC = 'Fall 2026/CSC148 Introduction to Computer Science';
const REVIEW = `${MAT}/Exams/Midterm/Midterm review.md`;
const WEEK2 = `${MAT}/week 2 notes.md`;
const CHAPTER3 = `${MAT}/第3章 偏导数.md`;
const TREE = `${CSC}/a1/starter/tree.py`;
/** A well-formed commit id that no commit has. */
const NO_COMMIT = `b3:${'0'.repeat(64)}`;
/** Files in the test's bulk commit. */
const BULK_FILES = 450;

function calls(invoke: MockInstance<FakeShell['invoke']>, command: string): number {
  return invoke.mock.calls.filter(([name]) => name === command).length;
}

/** The page requests a command was sent, in order. */
function pagesAsked(invoke: MockInstance<FakeShell['invoke']>, command: string): PageRequest[] {
  return invoke.mock.calls
    .filter(([name]) => name === command)
    .map(([, payload]) => (payload as { request: { page: PageRequest } }).request.page);
}

function commitOf(item: HistoryItem | undefined) {
  if (item?.kind !== 'commit') throw new Error(`not a commit: ${String(item?.kind)}`);
  return item.commit;
}

/** The commit of the small history with this summary. */
async function commitNamed(summary: string): Promise<string> {
  const page = await unwrap(ipc.listHistory({ page: { offset: 0, limit: 500 }, types: ['commit'] }));
  const found = page.items.find((item) => item.kind === 'commit' && item.commit.summary === summary);
  return commitOf(found).id;
}

async function loadAll<T>(result: { current: HistoryPages<T> }): Promise<void> {
  while (result.current.hasMore) {
    const before = result.current.items.length;
    act(() => {
      result.current.loadMore();
    });
    await waitFor(() => {
      expect(result.current.items.length).toBeGreaterThan(before);
    });
  }
}

describe('useHistoryTimeline', () => {
  it('reads the timeline a page of 100 at a time, with its total', async () => {
    const { result, shell } = renderAppHook(() => useHistoryTimeline(null), {
      now: NOW,
      scenario: 'history-long',
      // Slow enough for `isLoadingMore` to be seen between two checks of `waitFor`.
      latencyMs: 100,
    });

    await waitFor(() => {
      expect(result.current.status).toBe('success');
    });
    const { total } = await unwrap(ipc.listHistory({ page: { offset: 0, limit: 0 }, types: null }));
    expect(total).toBeGreaterThan(1_200);
    expect(result.current.items).toHaveLength(HISTORY_PAGE);
    expect(result.current.total).toBe(total);
    expect(result.current.hasMore).toBe(true);
    const invoke = vi.spyOn(shell, 'invoke');

    act(() => {
      result.current.loadMore();
      // A second call joins the read under way.
      result.current.loadMore();
    });

    await waitFor(() => {
      expect(result.current.isLoadingMore).toBe(true);
    });
    await waitFor(() => {
      expect(result.current.items).toHaveLength(2 * HISTORY_PAGE);
    });
    expect(result.current.isLoadingMore).toBe(false);
    expect(pagesAsked(invoke, 'list_history')).toEqual([{ offset: HISTORY_PAGE, limit: HISTORY_PAGE }]);
  });

  it('lists every entry once, newest first, to the first commit', async () => {
    const { result } = renderAppHook(() => useHistoryTimeline(null), { now: NOW, scenario: 'history-long' });
    await waitFor(() => {
      expect(result.current.status).toBe('success');
    });

    await loadAll(result);

    const items = result.current.items;
    const total = result.current.total ?? 0;
    expect(items).toHaveLength(total);
    expect(result.current.hasMore).toBe(false);
    expect(new Set(items.map(historyItemKey)).size).toBe(total);
    const times = items.map((item) => Number(item.kind === 'commit' ? item.commit.effectiveMs : item.effectiveMs));
    expect(times.every((time, index) => index === 0 || time <= (times[index - 1] ?? 0))).toBe(true);
    expect(commitOf(items.at(-1)).first).toBe(true);
    expect(new Set(items.map((item) => item.kind))).toEqual(new Set(['commit', 'reword', 'uncommit', 'restore']));
  });

  it('filters by type, and equal filters share one query', async () => {
    interface Filters {
      a: HistoryType[] | null;
      b: HistoryType[] | null;
    }
    const everything: Filters = { a: null, b: null };
    const { result, rerender, shell } = renderAppHook(
      ({ a, b }: Filters) => ({ a: useHistoryTimeline(a), b: useHistoryTimeline(b) }),
      { now: NOW, scenario: 'history-long', initialProps: everything },
    );
    await waitFor(() => {
      expect(result.current.a.status).toBe('success');
    });
    const invoke = vi.spyOn(shell, 'invoke');

    rerender({ a: ['uncommit', 'reword'], b: ['reword', 'uncommit', 'reword'] });

    await waitFor(() => {
      expect(result.current.a.status).toBe('success');
      expect(result.current.b.status).toBe('success');
    });
    expect(calls(invoke, 'list_history')).toBe(1);
    expect(result.current.a.items).toEqual(result.current.b.items);
    expect(result.current.a.total).toBe(15); // 12 message edits and 3 undone commits
    expect(new Set(result.current.a.items.map((item) => item.kind))).toEqual(new Set(['reword', 'uncommit']));
  });

  it('refetches after a reword (HistoryChanged): the edit entry on top, the commit under its new id', async () => {
    const { result } = renderAppHook(() => ({ timeline: useHistoryTimeline(null), reword: useRewordCommit() }), {
      now: NOW,
    });
    await waitFor(() => {
      expect(result.current.timeline.status).toBe('success');
    });
    const head = result.current.timeline.items.map((item) => (item.kind === 'commit' ? item.commit : null)).find((commit) => commit?.head);
    if (!head) throw new Error('no head');
    const total = result.current.timeline.total ?? 0;

    let id = '';
    await act(async () => {
      id = await result.current.reword.mutateAsync({ commit: head.id, summary: 'MAT232: the review, rewritten', body: null });
    });

    expect(id).not.toBe(head.id);
    await waitFor(() => {
      expect(result.current.timeline.items[0]).toMatchObject({ kind: 'reword', commit: id, previous: head.id });
    });
    const items = result.current.timeline.items;
    expect(result.current.timeline.total).toBe(total + 1);
    expect(items.find((item) => item.kind === 'commit' && item.commit.id === id)).toMatchObject({
      commit: { summary: 'MAT232: the review, rewritten', head: true },
    });
    expect(items.some((item) => item.kind === 'commit' && item.commit.id === head.id)).toBe(false);
  });

  it('fails with HistoryDamaged, and Try again asks again', async () => {
    const { result, shell } = renderAppHook(() => useHistoryTimeline(null), { now: NOW, scenario: 'history-damaged' });

    await waitFor(() => {
      expect(result.current.error?.error.code).toBe('HistoryDamaged');
    });
    expect(result.current.status).toBe('error');
    expect(result.current.loadMoreFailed).toBe(false);
    const invoke = vi.spyOn(shell, 'invoke');

    act(() => {
      result.current.retry();
    });

    await waitFor(() => {
      expect(calls(invoke, 'list_history')).toBe(1);
    });
  });

  it('keeps the pages read when the next one fails, which waits for Try again', async () => {
    const { result, shell } = renderAppHook(() => useHistoryTimeline(null), { now: NOW, scenario: 'history-long' });
    await waitFor(() => {
      expect(result.current.status).toBe('success');
    });
    shell.setFailure('list_history', 'Internal');

    act(() => {
      result.current.loadMore();
    });

    await waitFor(() => {
      expect(result.current.error?.error.code).toBe('Internal');
    });
    expect(result.current.items).toHaveLength(HISTORY_PAGE);
    expect(result.current.loadMoreFailed).toBe(true);
    const invoke = vi.spyOn(shell, 'invoke');
    act(() => {
      result.current.loadMore();
    });
    expect(calls(invoke, 'list_history')).toBe(0);
    shell.setFailure('list_history', null);

    act(() => {
      result.current.retry();
    });

    await waitFor(() => {
      expect(result.current.items).toHaveLength(2 * HISTORY_PAGE);
    });
    expect(result.current.status).toBe('success');
    expect(result.current.loadMoreFailed).toBe(false);
    // Only the page that failed was asked again.
    expect(pagesAsked(invoke, 'list_history')).toEqual([{ offset: HISTORY_PAGE, limit: HISTORY_PAGE }]);
  });

  // TanStack drops the next page's mark from its error as a refetch starts, while the error stays
  // until a read succeeds: a refresh then must not read as a failed refresh.
  it('still says the next page failed while a refresh reads, and a refresh that fails says so', async () => {
    const { result, shell } = renderAppHook(() => useHistoryTimeline(null), { now: NOW, scenario: 'history-long', latencyMs: 100 });
    await waitFor(() => {
      expect(result.current.status).toBe('success');
    });
    shell.setFailure('list_history', 'Internal');
    act(() => {
      result.current.loadMore();
    });
    await waitFor(() => {
      expect(result.current.loadMoreFailed).toBe(true);
    });
    const failed = result.current.error;

    // A message edit, a restore or an undo meanwhile: HistoryChanged refreshes the pages read.
    act(() => {
      shell.historyChanged();
    });
    await waitFor(() => {
      expect(result.current.isFetching).toBe(true);
    });
    expect(result.current.error).toBe(failed);
    expect(result.current.loadMoreFailed).toBe(true);

    // That refresh fails too: now it is the refresh that failed.
    await waitFor(() => {
      expect(result.current.isFetching).toBe(false);
    });
    expect(result.current.error).not.toBe(failed);
    expect(result.current.loadMoreFailed).toBe(false);

    shell.setFailure('list_history', null);
    act(() => {
      result.current.retry();
    });
    await waitFor(() => {
      expect(result.current.error).toBeNull();
    });
    expect(result.current.loadMoreFailed).toBe(false);
    expect(result.current.items).toHaveLength(HISTORY_PAGE);
  });
});

describe('useCommitChanges and useCommitMetadata', () => {
  it('ask nothing until enabled, then read pages of 200', async () => {
    // A commit of 450 files and two tag or settings changes, on top: HEAD, known once the shell is.
    let bulk = '';
    const { result, rerender, shell } = renderAppHook(
      (enabled: boolean) => ({ changes: useCommitChanges(bulk, enabled), metadata: useCommitMetadata(bulk, enabled) }),
      { now: NOW, fixture: smallHistoryWith({ summary: 'Bulk import', bulk: BULK_FILES, metadata: 2 }), initialProps: false },
    );
    bulk = shell.versioning.head?.id ?? '';
    const invoke = vi.spyOn(shell, 'invoke');
    expect(result.current.changes.status).toBe('idle');
    expect(result.current.metadata.status).toBe('idle');
    expect(result.current.changes.hasMore).toBe(false);

    rerender(true);

    await waitFor(() => {
      expect(result.current.changes.items).toHaveLength(CHANGES_PAGE);
      expect(result.current.metadata.status).toBe('success');
    });
    expect(result.current.changes.total).toBe(BULK_FILES);
    expect(result.current.changes.hasMore).toBe(true);
    expect(result.current.metadata.items.map((row) => row.key)).toEqual(['meta:ignoreRules', `meta:course:${CSC}`]);
    expect(result.current.metadata.total).toBe(2);
    expect(result.current.metadata.hasMore).toBe(false);

    await loadAll({
      get current() {
        return result.current.changes;
      },
    });

    expect(result.current.changes.items).toHaveLength(BULK_FILES);
    expect(new Set(result.current.changes.items.map((row) => row.key)).size).toBe(BULK_FILES);
    expect(pagesAsked(invoke, 'list_commit_changes')).toEqual([
      { offset: 0, limit: CHANGES_PAGE },
      { offset: CHANGES_PAGE, limit: CHANGES_PAGE },
      { offset: 2 * CHANGES_PAGE, limit: CHANGES_PAGE },
    ]);
    expect(pagesAsked(invoke, 'list_commit_metadata')).toEqual([{ offset: 0, limit: CHANGES_PAGE }]);

    // The card shows its first rows again: nothing is shown, and the pages wait a while unasked.
    rerender(false);
    expect(result.current.changes).toMatchObject({ status: 'idle', items: [], total: undefined, hasMore: false });
    rerender(true);
    expect(result.current.changes.items).toHaveLength(BULK_FILES);
    expect(calls(invoke, 'list_commit_changes')).toBe(3);
  });

  it('fail with NotFound for a commit HEAD’s chain does not have', async () => {
    const { result } = renderAppHook(
      () => ({ changes: useCommitChanges(NO_COMMIT, true), metadata: useCommitMetadata(NO_COMMIT, true) }),
      { now: NOW },
    );

    await waitFor(() => {
      expect(result.current.changes.error?.error.code).toBe('NotFound');
      expect(result.current.metadata.error?.error.code).toBe('NotFound');
    });
  });
});

describe('useFileHistory', () => {
  it('reads a file’s commits from its entry or from a version, and the types filter applies', async () => {
    interface Asked {
      file: FileRef | null;
      types: HistoryType[] | null;
    }
    const nothing: Asked = { file: null, types: null };
    const { result, rerender } = renderAppHook(({ file, types }: Asked) => useFileHistory(file, types), {
      now: NOW,
      initialProps: nothing,
    });
    expect(result.current.status).toBe('idle');

    rerender({ file: { kind: 'entry', entry: refOf(REVIEW) }, types: null });

    await waitFor(() => {
      expect(result.current.status).toBe('success');
    });
    const summaries = result.current.items.map((version) => (version.kind === 'commit' ? version.commit.summary : null));
    expect(summaries).toEqual([
      'MAT232: rewrite the midterm review',
      'MAT223: update exercise 1; MAT232: update the midterm review',
      'Start history',
    ]);
    expect(result.current.total).toBe(3);
    expect(result.current.items[1]).toMatchObject({ kind: 'commit', change: { path: REVIEW, change: 'modified' }, others: 1 });
    // The file has uncommitted changes: no version is the current one.
    expect(result.current.items.some((version) => version.kind === 'commit' && version.current)).toBe(false);
    const keys = result.current.items.map(fileVersionKey);

    const older = await commitNamed('MAT223: update exercise 1; MAT232: update the midterm review');
    rerender({ file: { kind: 'version', commit: older, path: REVIEW }, types: null });

    await waitFor(() => {
      expect(result.current.items.map(fileVersionKey)).toEqual(keys);
    });

    rerender({ file: { kind: 'version', commit: older, path: REVIEW }, types: ['restore'] });

    await waitFor(() => {
      expect(result.current.total).toBe(0);
    });
    expect(result.current.items).toEqual([]);
    expect(result.current.status).toBe('success');
  });

  it('is empty for a file no commit holds yet', async () => {
    const { result } = renderAppHook(() => useFileHistory({ kind: 'entry', entry: smallRef(TREE) }, null), {
      now: NOW,
    });

    await waitFor(() => {
      expect(result.current.status).toBe('success');
    });
    expect(result.current.items).toEqual([]);
    expect(result.current.total).toBe(0);
  });

  it('fails with NotFound for an entry or a commit the shell does not have', async () => {
    const { result } = renderAppHook(
      () => ({
        entry: useFileHistory({ kind: 'entry', entry: { id: '99999', path: 'Gone.md' } }, null),
        version: useFileHistory({ kind: 'version', commit: NO_COMMIT, path: REVIEW }, null),
      }),
      { now: NOW },
    );

    await waitFor(() => {
      expect(result.current.entry.error?.error.code).toBe('NotFound');
      expect(result.current.version.error?.error.code).toBe('NotFound');
    });
  });

  it('follows its file: WorkspaceChanged and the file’s own changes refetch it, other files and tags do not', async () => {
    const { result, shell } = renderAppHook(
      () => ({ week2: useFileHistory({ kind: 'entry', entry: smallRef(WEEK2) }, null), timeline: useHistoryTimeline(null) }),
      { now: NOW },
    );
    await waitFor(() => {
      expect(result.current.week2.status).toBe('success');
      expect(result.current.timeline.status).toBe('success');
    });
    expect(result.current.week2.items[0]).toMatchObject({ kind: 'commit', commit: { summary: 'MAT232: update 1 file' }, current: true });
    const invoke = vi.spyOn(shell, 'invoke');
    const week2 = refOf(WEEK2);

    shell.changed([{ kind: 'modified', entry: refOf(CHAPTER3) }, { kind: 'tagged', entry: week2 }]);
    await act(() => shell.flush());
    shell.changed([{ kind: 'modified', entry: week2 }]);
    await act(() => shell.flush());

    await waitFor(() => {
      expect(calls(invoke, 'list_file_history')).toBe(1);
    });

    // Hashing finished, a commit or a restore: the file's content may have changed.
    shell.workspaceChanged();

    await waitFor(() => {
      expect(calls(invoke, 'list_file_history')).toBe(2);
    });

    // Saved in another program: CatalogChanged, then WorkspaceChanged with the new hash.
    shell.editFile(WEEK2);

    await waitFor(() => {
      expect(result.current.week2.items.some((version) => version.kind === 'commit' && version.current)).toBe(false);
    });
    expect(calls(invoke, 'list_file_history')).toBeGreaterThanOrEqual(2);
    expect(calls(invoke, 'list_history')).toBe(0);
  });
});

describe('useVersionChange', () => {
  it('finds a version’s own row in its file’s history, older versions too, and NotFound for a commit the shell does not have', async () => {
    const { result, rerender } = renderAppHook((version: VersionRef) => useVersionChange(version), {
      now: NOW,
      initialProps: { commit: NO_COMMIT, path: REVIEW },
    });
    await waitFor(() => {
      expect(result.current.error?.error.code).toBe('NotFound');
    });

    const newest = await commitNamed('MAT232: rewrite the midterm review');
    const older = await commitNamed('MAT223: update exercise 1; MAT232: update the midterm review');
    rerender({ commit: older, path: REVIEW });
    await waitFor(() => {
      expect(result.current.data).toMatchObject({ path: REVIEW, change: 'modified' });
    });
    const olderRow = result.current.data;
    rerender({ commit: newest, path: REVIEW });
    await waitFor(() => {
      expect(result.current.data).toMatchObject({ path: REVIEW, change: 'modified' });
    });
    // The newest commit's version of the file, not the older one's (the same change key, by path).
    expect(result.current.data?.after?.hash).not.toBe(olderRow?.after?.hash);
  });

  it('is refreshed by HistoryChanged only: the files’ events change no commit’s rows', async () => {
    const { result, rerender, shell } = renderAppHook((version: VersionRef) => useVersionChange(version), {
      now: NOW,
      initialProps: { commit: NO_COMMIT, path: REVIEW },
    });
    rerender({ commit: shell.versioning.head?.id ?? '', path: REVIEW });
    await waitFor(() => {
      expect(result.current.data).toMatchObject({ path: REVIEW });
    });
    const invoke = vi.spyOn(shell, 'invoke');

    shell.changed([{ kind: 'modified', entry: refOf(REVIEW) }]);
    await act(() => shell.flush());
    shell.workspaceChanged();
    await settle();
    expect(calls(invoke, 'list_file_history')).toBe(0);

    shell.historyChanged();
    await waitFor(() => {
      expect(calls(invoke, 'list_file_history')).toBe(1);
    });
  });
});

describe('useFirstCommit', () => {
  it('finds the oldest commit once enabled', async () => {
    const { result, rerender, shell } = renderAppHook((enabled: boolean) => useFirstCommit(enabled), {
      now: NOW,
      scenario: 'history-long',
      initialProps: false,
    });
    const invoke = vi.spyOn(shell, 'invoke');
    expect(result.current.fetchStatus).toBe('idle');
    expect(calls(invoke, 'list_history')).toBe(0);

    rerender(true);

    await waitFor(() => {
      expect(result.current.data).toMatchObject({ first: true, parent: null });
    });
    expect(calls(invoke, 'list_history')).toBe(2);
  });

  it('is null before the first commit', async () => {
    const { result } = renderAppHook(() => useFirstCommit(true), { now: NOW, scenario: 'history-none' });

    await waitFor(() => {
      expect(result.current.status).toBe('success');
    });
    expect(result.current.data).toBeNull();
  });
});

describe('restore', () => {
  async function olderReview(): Promise<VersionRef> {
    return { commit: await commitNamed('MAT223: update exercise 1; MAT232: update the midterm review'), path: REVIEW };
  }

  it('plans, restores, and the plan and the timeline follow the restore’s events', async () => {
    const { result, rerender } = renderAppHook(
      (version: VersionRef | null) => ({
        plan: useRestorePlan(version),
        restore: useRestoreVersion(),
        timeline: useHistoryTimeline(null),
      }),
      { now: NOW, initialProps: null as VersionRef | null },
    );
    expect(result.current.plan.fetchStatus).toBe('idle');
    const version = await olderReview();

    rerender(version);

    await waitFor(() => {
      expect(result.current.plan.data).toMatchObject({ outcome: 'replace', target: REVIEW, recycle: true });
    });
    expect(result.current.plan.data?.current?.path).toBe(REVIEW);

    let restored: unknown;
    await act(async () => {
      restored = await result.current.restore.mutateAsync(version);
    });

    expect(restored).toEqual({ target: REVIEW, recycled: true });
    await waitFor(() => {
      expect(result.current.timeline.items[0]).toMatchObject({ kind: 'restore', path: REVIEW, target: REVIEW, recycled: true });
      expect(result.current.plan.data?.outcome).toBe('unchanged');
    });
  });

  it('asks for a plan afresh each time: nothing keeps one nobody shows', async () => {
    const { result, rerender, shell, client } = renderAppHook((version: VersionRef | null) => useRestorePlan(version), {
      now: NOW,
      initialProps: null as VersionRef | null,
    });
    const version = await olderReview();
    const invoke = vi.spyOn(shell, 'invoke');
    rerender(version);
    await waitFor(() => {
      expect(result.current.status).toBe('success');
    });

    const key = keys.restorePlan(useSession.getState().libraryId ?? '', version);
    expect(client.getQueryCache().find({ queryKey: key, exact: true })).toBeDefined();

    rerender(null);

    await waitFor(() => {
      expect(client.getQueryCache().find({ queryKey: key, exact: true })).toBeUndefined();
    });
    rerender(version);
    await waitFor(() => {
      expect(result.current.status).toBe('success');
    });
    expect(calls(invoke, 'plan_restore')).toBe(2);
  });

  it('rejects with the reason when restoring fails, and refreshes nothing', async () => {
    const { result, shell } = renderAppHook(() => useRestoreVersion(), { now: NOW, fail: [{ command: 'restore_version', code: 'InUse' }] });
    const version = await olderReview();
    const invoke = vi.spyOn(shell, 'invoke');

    await act(async () => {
      await expect(result.current.mutateAsync(version)).rejects.toMatchObject({ error: { code: 'InUse' } });
    });
    expect(calls(invoke, 'list_history')).toBe(0);
  });
});

describe('useUncommit', () => {
  it('takes back the newest commit, and NotHead refreshes the history', async () => {
    const { result, shell } = renderAppHook(() => ({ timeline: useHistoryTimeline(null), uncommit: useUncommit() }), {
      now: NOW,
    });
    await waitFor(() => {
      expect(result.current.timeline.status).toBe('success');
    });
    const commits = result.current.timeline.items.flatMap((item) => (item.kind === 'commit' ? [item.commit] : []));
    const head = commits.find((commit) => commit.head);
    const older = commits.find((commit) => !commit.head && !commit.first);
    if (!head || !older) throw new Error('no head or older commit');
    const invoke = vi.spyOn(shell, 'invoke');

    await act(async () => {
      await expect(result.current.uncommit.mutateAsync({ commit: older.id })).rejects.toMatchObject({
        error: { code: 'NotHead' },
      });
    });

    await waitFor(() => {
      expect(calls(invoke, 'list_history')).toBe(1);
    });

    await act(async () => {
      await result.current.uncommit.mutateAsync({ commit: head.id });
    });

    await waitFor(() => {
      expect(result.current.timeline.items[0]).toMatchObject({ kind: 'uncommit', commit: head.id, summary: head.summary });
    });
  });
});
