// The data layer against the fake shell: CatalogChanged and revisions (ui-architecture §5.4),
// LibraryStateChanged, JobChanged and ProblemsChanged (§5.6).
import { act, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { type EntryRef, ipc } from '../ipc';
import { smallLibrary } from '../ipc/mock/fixtures/small';
import { renderAppHook } from '../test/render';
import { useChildren, useEntry } from './entries';
import { unwrap } from './errors';
import { revisionOf } from './events';
import { useCancelJob, useJob, useJobs, useRebuildCatalog } from './jobs';
import { keys } from './keys';
import { useCount } from './paged';
import { useLibrary } from './library';
import { useProblems, useProblemsTotal } from './problems';
import { followReferences, type ReferenceUpdate } from './references';
import {
  latestRevision,
  openSession,
  sawRevision,
  setCurrentSemester,
  useCurrentSemester,
  useSession,
} from './session';

const NOW = Date.UTC(2026, 8, 30, 12);
const NAME = { key: 'name', descending: false } as const;
const ALL = { start: 0, end: 50 };

/** The fake numbers the fixture's entries 1, 2, … in order, the root being 0. */
function refOf(path: string): EntryRef {
  const index = smallLibrary(NOW).entries.findIndex((entry) => entry.path === path);
  if (index === -1) throw new Error(`no ${path} in the small fixture`);
  return { id: String(index + 1), path };
}

const CSC = 'Fall 2026/CSC148 Introduction to Computer Science';
const csc = refOf(CSC);
const hw1 = refOf(`${CSC}/hw1.py`);
const labs = refOf(`${CSC}/labs`);
const personal = refOf('Personal');

function libraryKey() {
  return keys.library(useSession.getState().libraryId ?? '');
}

function childrenPage(folder: EntryRef) {
  return {
    queryKey: [...keys.children(useSession.getState().libraryId ?? '', { folder, sort: NAME }), 0],
    queryFn: () => unwrap(ipc.listChildren({ folder, sort: NAME, page: { offset: 0, limit: 200 } })),
  };
}

function follow() {
  const updates: ReferenceUpdate[] = [];
  const stop = followReferences((update) => updates.push(update));
  return { updates, stop };
}

let stopFollowing: (() => void) | undefined;
afterEach(() => {
  stopFollowing?.();
});

describe('CatalogChanged', () => {
  it('refetches a list a change touches, and records the revision', async () => {
    const { result } = renderAppHook(() => useChildren(csc, NAME, ALL), { now: NOW });
    await waitFor(() => {
      expect(result.current.rowAt(2)?.name).toBe('hw1.py');
    });

    await unwrap(ipc.renameEntry({ entry: hw1, name: 'hw01.py' }));

    await waitFor(() => {
      expect(result.current.rowAt(2)?.name).toBe('hw01.py');
    });
    expect(result.current.revision).toBe(1);
    expect(latestRevision()).toBe(1);
    // Row keys are ids, which a rename keeps.
    expect(result.current.rowKey(2)).toBe(hw1.id);
  });

  it('removes touched queries nobody shows, and leaves untouched ones alone', async () => {
    const { client, shell, result } = renderAppHook(() => useChildren(labs, NAME, ALL), {
      now: NOW,
    });
    await waitFor(() => {
      expect(result.current.total).toBe(2);
    });
    const touched = childrenPage(csc);
    const untouched = childrenPage(personal);
    await client.query(touched);
    await client.query(untouched);

    await unwrap(ipc.renameEntry({ entry: hw1, name: 'hw01.py' }));
    await shell.flush();

    expect(client.getQueryData(touched.queryKey)).toBeUndefined();
    expect(client.getQueryData(untouched.queryKey)).toBeDefined();
  });

  it('does not refetch data already read at the event’s revision', async () => {
    const { client, shell, result } = renderAppHook(() => useChildren(labs, NAME, ALL), {
      now: NOW,
      eventDelayMs: 1_000,
    });
    await waitFor(() => {
      expect(result.current.status).toBe('success');
    });
    // The change commits; the list is read again before its event arrives.
    await unwrap(ipc.createFolder({ parent: labs, name: 'lab3' }));
    await client.refetchQueries({ queryKey: libraryKey() });
    await waitFor(() => {
      expect(result.current.total).toBe(3);
    });
    const invoke = vi.spyOn(shell, 'invoke');

    await shell.flush();

    expect(latestRevision()).toBe(1);
    expect(invoke.mock.calls.filter(([command]) => command === 'list_children')).toHaveLength(0);
  });

  it('asks again when an event overtakes the answer of a first load, whatever the query', async () => {
    // Each answer travels 50 ms after it is read; events are faster. So the count below is read
    // with two folders, the change and its event arrive, and only then the stale answer.
    const { result } = renderAppHook(() => useCount({ of: 'children', folder: labs }).data, {
      now: NOW,
      latencyMs: 50,
    });

    await unwrap(ipc.createFolder({ parent: labs, name: 'lab3' }));

    await waitFor(() => {
      expect(result.current).toBe(3);
    });
  });

  it('passes moves to the reference followers before refetching', async () => {
    const { shell, result } = renderAppHook(
      () => {
        // Read during render, so the probe renders again when they change.
        const { data, error } = useEntry(hw1);
        return { data, error };
      },
      { now: NOW },
    );
    await waitFor(() => {
      expect(result.current.data?.name).toBe('hw1.py');
    });
    const followed = follow();
    stopFollowing = followed.stop;

    const renamed = await unwrap(ipc.renameEntry({ entry: hw1, name: 'hw01.py' }));
    await shell.flush();

    expect(followed.updates).toEqual([
      { kind: 'changes', changes: [{ kind: 'moved', entry: { id: hw1.id, path: renamed.path }, from: hw1.path }] },
    ]);
    // Whoever still holds the old reference sees that it moved or went away.
    await waitFor(() => {
      expect(result.current.error?.error.code).toBe('NotFound');
    });
  });

  it('refreshes everything after a rebuild, and asks followers to recheck', async () => {
    const fall = refOf('Fall 2026');
    const { shell, result } = renderAppHook(() => useChildren(null, NAME, ALL), { now: NOW });
    await waitFor(() => {
      expect(result.current.rowKey(1)).toBe(fall.id);
    });
    const followed = follow();
    stopFollowing = followed.stop;

    await unwrap(ipc.rebuildCatalog());
    shell.finishJobs();

    await waitFor(() => {
      expect(result.current.rowKey(1)).not.toBe(fall.id);
    });
    expect(result.current.rowAt(1)?.name).toBe('Fall 2026');
    expect(followed.updates).toContainEqual({ kind: 'rebuilt' });
  });
});

describe('LibraryStateChanged', () => {
  it('drops every query of the library, the session and every reference', async () => {
    const { client, shell, result } = renderAppHook(
      () => ({ library: useLibrary(), children: useChildren(csc, NAME, ALL) }),
      { now: NOW },
    );
    await waitFor(() => {
      expect(result.current.children.status).toBe('success');
    });
    sawRevision(3);
    const libraryId = useSession.getState().libraryId ?? '';
    const followed = follow();
    stopFollowing = followed.stop;

    shell.makeUnavailable('missing');

    await waitFor(() => {
      expect(result.current.library).toBeNull();
    });
    expect(useSession.getState().libraryId).toBeNull();
    expect(latestRevision()).toBeNull();
    expect(client.getQueryCache().findAll({ queryKey: keys.library(libraryId) })).toHaveLength(0);
    expect(client.getQueryData(keys.libraryStatus())).toMatchObject({ state: 'unavailable', reason: 'missing' });
    expect(followed.updates).toEqual([{ kind: 'reset' }]);
  });
});

describe('JobChanged and ProblemsChanged', () => {
  it('keeps the job list current without asking for it again', async () => {
    const { shell, result } = renderAppHook(() => useJobs(), { now: NOW });
    await waitFor(() => {
      expect(result.current.data).toEqual([]);
    });
    const invoke = vi.spyOn(shell, 'invoke');

    // A scan that finds nothing new, and then hashing: no catalog change refreshes the list.
    const id = shell.startScan();
    await waitFor(() => {
      expect(result.current.data?.map((job) => job.id)).toContain(id);
    });
    shell.finishJobs();
    await waitFor(() => {
      expect(result.current.data?.map((job) => [job.kind, job.status.state])).toEqual([
        ['hash', 'done'],
        ['scan', 'done'],
      ]);
    });
    expect(invoke.mock.calls.filter(([command]) => command === 'list_jobs')).toHaveLength(0);
  });

  it('starts, finds and cancels jobs through the job hooks', async () => {
    let id = '';
    const { result } = renderAppHook(
      () => ({ job: useJob(id), cancel: useCancelJob(), rebuild: useRebuildCatalog() }),
      // Slow steps, so the job is still queued when it is cancelled.
      { now: NOW, jobStepMs: 60_000 },
    );

    id = await result.current.rebuild.mutateAsync();
    await waitFor(() => {
      expect(result.current.job?.status).toEqual({ state: 'queued' });
    });
    await result.current.cancel.mutateAsync(id);

    await waitFor(() => {
      expect(result.current.job?.status).toEqual({ state: 'cancelled' });
    });
    await expect(result.current.cancel.mutateAsync(id)).rejects.toMatchObject({
      error: { code: 'NotFound' },
    });
  });

  it('takes the problem total from the event and refreshes the pages', async () => {
    const { shell, result } = renderAppHook(
      () => ({ total: useProblemsTotal(), pages: useProblems({ start: 0, end: 20 }) }),
      { now: NOW },
    );
    await waitFor(() => {
      expect(result.current.pages.total).toBe(6);
    });
    expect(result.current.total.data).toBe(6);

    shell.setProblems([{ kind: 'orphanedMetadata', folder: 'Fall 2023' }]);

    await waitFor(() => {
      expect(result.current.total.data).toBe(1);
    });
    await waitFor(() => {
      expect(result.current.pages.rowAt(0)?.problem).toEqual({ kind: 'orphanedMetadata', folder: 'Fall 2023' });
    });
  });
});

describe('the current semester', () => {
  it('is kept per library, and follows a rename of its folder', async () => {
    const { result } = renderAppHook(() => useCurrentSemester(), { now: NOW });
    expect(result.current).toBeNull();

    act(() => {
      setCurrentSemester('Fall 2026');
    });
    expect(result.current).toBe('Fall 2026');
    expect(localStorage.getItem('folio.session')).toContain('Fall 2026');

    await unwrap(ipc.renameEntry({ entry: refOf('Fall 2026'), name: 'Autumn 2026' }));
    await waitFor(() => {
      expect(result.current).toBe('Autumn 2026');
    });
  });
});

describe('revisions', () => {
  it('keeps the newest revision seen, across the wrap at 2³²', () => {
    openSession('library');
    sawRevision(0xffff_fffe);
    sawRevision(0xffff_ffff);
    sawRevision(0xffff_fffe); // an older event arriving late changes nothing
    expect(latestRevision()).toBe(0xffff_ffff);
    sawRevision(1); // after the wrap
    expect(latestRevision()).toBe(1);
    openSession('another');
    expect(latestRevision()).toBeNull();
  });

  it('reads the revision of a page, and the oldest of an infinite query', () => {
    expect(revisionOf({ items: [], offset: 0, total: 0, revision: 7 })).toBe(7);
    const pages = (...revisions: number[]) => ({
      pages: revisions.map((revision) => ({ items: [], offset: 0, more: false, revision })),
      pageParams: revisions,
    });
    expect(revisionOf(pages(4, 2, 9))).toBe(2);
    expect(revisionOf(pages(0xffff_ffff, 1))).toBe(0xffff_ffff);
    expect(revisionOf([{ id: 'job' }])).toBeUndefined();
    expect(revisionOf(3)).toBeUndefined();
  });
});
