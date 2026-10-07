// The workspace's data against the fake shell (ipc-m2 §6, §7, §8.1, §12.4, §14): the summary and
// the pages keyed by `key`, which events refetch them, selection summaries per selection and
// workspace, stale keys, commits, the first commit, AI messages and the newest commits.
import { act, waitFor } from '@testing-library/react';
import { describe, expect, it, type MockInstance, vi } from 'vitest';

import { type GenerateCommitMessage, ipc, LIMITS, type Selection } from '../ipc';
import type { FakeShell } from '../ipc/mock/shell';
import { LARGE_WORKSPACE_ITEMS } from '../ipc/mock/versioning/workspaceLarge';
import { FIRST_ROWS, NOW } from '../test/data';
import { renderAppHook } from '../test/render';
import { IpcFailure, unwrap } from './errors';
import { keys } from './keys';
import type { RowRange } from './paged';
import { useSession } from './session';
import {
  cancelAiRequest,
  generateCommitMessage,
  newRequestId,
  pruneStaleKeys,
  useCommit,
  useMetadataChanges,
  useNotSynced,
  useSelectionSummary,
  useStartHistory,
  useWorkspace,
  useWorkspaceItems,
} from './workspace';

const MAT = 'Fall 2026/MAT232 Calculus of Several Variables';
const CSC = 'Fall 2026/CSC148 Introduction to Computer Science';
const REVIEW = `${MAT}/Exams/Midterm/Midterm review.md`;
const WEEK2 = `${MAT}/week 2 notes.md`;
const REPORT = `${CSC}/labs/lab1/report.docx`;
const TREE = `${CSC}/a1/starter/tree.py`;
/** Every includable item. */
const ALL: Selection = { kind: 'allExcept', keys: [] };

/** A selection hook's props: none until the test gives one. */
interface Picked {
  selection: Selection | null;
}
const NOTHING_PICKED: Picked = { selection: null };

type Invoke = MockInstance<FakeShell['invoke']>;

function calls(invoke: Invoke, command: string): number {
  return invoke.mock.calls.filter(([name]) => name === command).length;
}

/** The offsets of the item pages asked for. */
function itemOffsets(invoke: Invoke): number[] {
  return invoke.mock.calls
    .filter(([command]) => command === 'list_workspace_items')
    .map(([, payload]) => (payload as { request: { page: { offset: number } } }).request.page.offset)
    .sort((a, b) => a - b);
}

function libraryId(): string {
  return useSession.getState().libraryId ?? '';
}

/** The key of the small workspace's item at `path`, read from the shell. */
async function keyOf(path: string): Promise<string> {
  const page = await unwrap(ipc.listWorkspaceItems({ page: { offset: 0, limit: 50 } }));
  const found = page.items.find((item) => item.path === path);
  if (found === undefined) throw new Error(`no workspace item at ${path}`);
  return found.key;
}

/** Lets the shell's answers and events settle. */
async function settle(): Promise<void> {
  await act(() => new Promise((resolve) => setTimeout(resolve, 20)));
}

describe('the workspace summary and lists', () => {
  it('reads the summary, and pages of items and metadata changes keyed by their keys', async () => {
    const { result, client } = renderAppHook(
      () => ({ summary: useWorkspace().data, items: useWorkspaceItems(FIRST_ROWS), metadata: useMetadataChanges(FIRST_ROWS) }),
      { now: NOW },
    );
    await waitFor(() => {
      expect(result.current.summary).toBeDefined();
      expect(result.current.items.status).toBe('success');
      expect(result.current.metadata.status).toBe('success');
    });
    const { summary, items, metadata } = result.current;
    expect(summary).toMatchObject({
      historyState: 'ready',
      items: 12,
      metadata: 4,
      includable: 10,
      hashing: 1,
      notLocal: 1,
      unreadable: 1,
    });
    expect(summary?.fingerprint).toMatch(/^[0-9a-f]{32}$/);
    expect(items.total).toBe(12);
    expect(items.rowKey(0)).toBe(items.rowAt(0)?.key);
    expect(items.rowKey(11)).toBe(items.rowAt(11)?.key);
    expect(items.rowKey(12)).toBe('placeholder:12');
    expect(metadata.total).toBe(4);
    expect(metadata.rowKey(0)).toBe(metadata.rowAt(0)?.key);
    expect(client.getQueryData([...keys.workspace(libraryId(), { part: 'items' }), 0])).toMatchObject({ total: 12 });
  });

  it('refetches on WorkspaceChanged, and not on CatalogChanged alone, not even after a rebuild', async () => {
    const { result, shell } = renderAppHook(
      () => ({ summary: useWorkspace().data, items: useWorkspaceItems(FIRST_ROWS) }),
      { now: NOW },
    );
    await waitFor(() => {
      expect(result.current.items.status).toBe('success');
    });
    const invoke = vi.spyOn(shell, 'invoke');
    const week2 = shell.library.at(WEEK2);
    if (week2 === undefined) throw new Error('no week 2 notes');

    shell.changed([{ kind: 'modified', entry: shell.library.ref(week2) }]);
    await act(() => shell.flush());
    shell.changedEverything();
    await act(() => shell.flush());
    await settle();
    expect(calls(invoke, 'get_workspace') + calls(invoke, 'list_workspace_items')).toBe(0);

    // Saved in another program: a new item, which WorkspaceChanged brings.
    shell.editFile(WEEK2);
    await waitFor(() => {
      expect(result.current.summary?.items).toBe(13);
      expect(result.current.items.total).toBe(13);
    });
    expect(calls(invoke, 'get_workspace')).toBe(1);
  });

  it('is dropped with the library on LibraryStateChanged', async () => {
    const { result, client, shell } = renderAppHook(() => useWorkspace().data, { now: NOW });
    await waitFor(() => {
      expect(result.current).toBeDefined();
    });
    const library = libraryId();
    expect(client.getQueryCache().findAll({ queryKey: ['lib', library, 'workspace'] })).toHaveLength(1);

    shell.makeUnavailable('missing');

    await waitFor(() => {
      expect(useSession.getState().libraryId).toBeNull();
    });
    expect(client.getQueryCache().findAll({ queryKey: ['lib', library, 'workspace'] })).toHaveLength(0);
  });

  it('asks only for the pages near the rows shown in a workspace of 50,000 changes', async () => {
    const { result, rerender, shell } = renderAppHook(
      (range: RowRange) => {
        const list = useWorkspaceItems(range);
        return { summary: useWorkspace().data, total: list.total, row: list.rowAt(range.start), list };
      },
      { scenario: 'workspace-large', now: NOW, initialProps: { start: 0, end: 20 } },
    );
    await waitFor(() => {
      expect(result.current.row).toBeDefined();
      expect(result.current.summary).toBeDefined();
    });
    expect(result.current.total).toBe(LARGE_WORKSPACE_ITEMS);
    const summary = result.current.summary;
    expect(summary?.items).toBe(LARGE_WORKSPACE_ITEMS);
    expect(summary?.hashing).toBeGreaterThan(0);
    expect(summary?.notLocal).toBeGreaterThan(0);
    expect(summary?.unreadable).toBeGreaterThan(0);
    const invoke = vi.spyOn(shell, 'invoke');

    rerender({ start: 30_000, end: 30_020 });
    await waitFor(() => {
      expect(result.current.row).toBeDefined();
    });
    await waitFor(() => {
      expect(itemOffsets(invoke)).toEqual([29_800, 30_000]);
    });
    expect(result.current.list.rowKey(30_000)).toBe(result.current.row?.key);
  });
});

describe('selections', () => {
  it('summarizes per selection and workspace, asks nothing for none, and keeps the last answer meanwhile', async () => {
    const { result, rerender, shell } = renderAppHook(
      ({ selection }: Picked) => {
        const workspace = useWorkspace().data;
        const summary = useSelectionSummary(selection, workspace);
        return { workspace, summary: summary.data, placeholder: summary.isPlaceholderData };
      },
      { now: NOW, initialProps: NOTHING_PICKED },
    );
    await waitFor(() => {
      expect(result.current.workspace).toBeDefined();
    });
    const invoke = vi.spyOn(shell, 'invoke');
    await settle();
    expect(result.current.summary).toBeUndefined();
    expect(calls(invoke, 'summarize_selection')).toBe(0);

    rerender({ selection: ALL });
    await waitFor(() => {
      expect(result.current.summary?.summary.items).toBe(10);
    });
    expect(result.current.summary?.summary.metadata).toBe(4);
    expect(result.current.summary?.stale).toEqual([]);
    expect(calls(invoke, 'summarize_selection')).toBe(1);

    // The same selection, rendered again: nothing is asked.
    rerender({ selection: ALL });
    await settle();
    expect(calls(invoke, 'summarize_selection')).toBe(1);

    const review: Selection = { kind: 'only', keys: [await keyOf(REVIEW)] };
    rerender({ selection: review });
    expect(result.current.summary?.summary.items).toBe(10);
    await waitFor(() => {
      expect(result.current.summary?.summary.items).toBe(1);
    });
    expect(result.current.placeholder).toBe(false);
    expect(calls(invoke, 'summarize_selection')).toBe(2);

    // The workspace changed: asked again under its new fingerprint, never the old one.
    const before = result.current.workspace?.fingerprint;
    shell.addFile(`${MAT}/week 3 notes.md`);
    await waitFor(() => {
      expect(result.current.workspace?.fingerprint).not.toBe(before);
    });
    await waitFor(() => {
      expect(result.current.placeholder).toBe(false);
    });
    await settle();
    expect(result.current.summary?.summary.items).toBe(1);
    const fingerprints = invoke.mock.calls
      .filter(([command]) => command === 'summarize_selection')
      .map(([, payload]) => (payload as { request: { fingerprint: string } }).request.fingerprint);
    expect(fingerprints).toEqual([before, before, result.current.workspace?.fingerprint]);
  });

  it('reports the keys whose items went, and summarizes without them', async () => {
    const { result, rerender, shell } = renderAppHook(
      ({ selection }: Picked) => {
        const workspace = useWorkspace().data;
        return { workspace, summary: useSelectionSummary(selection, workspace).data };
      },
      { now: NOW, initialProps: NOTHING_PICKED },
    );
    await waitFor(() => {
      expect(result.current.workspace).toBeDefined();
    });
    const report = await keyOf(REPORT);
    const review = await keyOf(REVIEW);
    const tree = await keyOf(TREE);
    const leftOut: Selection = { kind: 'allExcept', keys: [report, review, tree] };
    rerender({ selection: leftOut });
    await waitFor(() => {
      expect(result.current.summary?.summary.items).toBe(7);
    });

    // Deleted in another program: its item has a new key, and the old one names nothing.
    shell.deleteFile(REVIEW);

    await waitFor(() => {
      expect(result.current.summary?.stale).toEqual([review]);
    });
    expect(result.current.summary?.selection).toEqual({ kind: 'allExcept', keys: [report, tree] });
    // The deleted review is included now: every includable item but the two left out.
    expect(result.current.summary?.summary.items).toBe(8);
  });

  it('prunes several stale keys among known ones, and rejects an old fingerprint', async () => {
    const { shell } = renderAppHook(() => null, { now: NOW });
    const [report = '', review = '', tree = ''] = await Promise.all([REPORT, REVIEW, TREE].map(keyOf));
    const old = await unwrap(ipc.getWorkspace());
    shell.deleteFile(REVIEW);
    shell.deleteFile(TREE);
    const workspace = await unwrap(ipc.getWorkspace());

    const pruned = await pruneStaleKeys({ kind: 'only', keys: [review, report, tree] }, workspace.fingerprint);

    expect(pruned.stale.sort()).toEqual([review, tree].sort());
    expect(pruned.selection).toEqual({ kind: 'only', keys: [report] });
    expect(pruned.summary.items).toBe(1);
    const failure = await pruneStaleKeys(ALL, old.fingerprint).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(IpcFailure);
    expect(failure).toMatchObject({ error: { code: 'WorkspaceChanged' } });
  });
});

describe('commits', () => {
  it('commits without the keys whose items went, and starts the commit job', async () => {
    const { result, shell } = renderAppHook(() => useCommit(), { now: NOW });
    const report = await keyOf(REPORT);
    const review = await keyOf(REVIEW);
    shell.deleteFile(REVIEW);
    const workspace = await unwrap(ipc.getWorkspace());

    const job = await act(() =>
      result.current.mutateAsync({
        selection: { kind: 'only', keys: [report, review] },
        fingerprint: workspace.fingerprint,
        base: workspace.head,
        summary: 'CSC148: update the lab report',
        body: null,
      }),
    );
    act(() => {
      shell.finishJobs();
    });

    // The report and the four metadata changes every commit records.
    expect(shell.jobs().find((candidate) => candidate.id === job)?.status).toMatchObject({
      state: 'done',
      result: { kind: 'commit', summary: 'CSC148: update the lab report', changes: 5 },
    });
  });

  it('keeps a refusal that is not about the keys, and rejects with its code', async () => {
    const { result, shell } = renderAppHook(() => useCommit(), { now: NOW });
    const workspace = await unwrap(ipc.getWorkspace());
    const failure = await act(() =>
      result.current
        .mutateAsync({ selection: ALL, fingerprint: workspace.fingerprint, base: workspace.head, summary: '   ', body: null })
        .catch((error: unknown) => error),
    );
    expect(failure).toMatchObject({ error: { code: 'SummaryEmpty' } });
    const report = await keyOf(REPORT);
    const invoke = vi.spyOn(shell, 'invoke');

    // `InvalidArgument` for the request id: the keys, asked alone, are all known.
    const refused = await generateCommitMessage({
      requestId: 'not an id!',
      selection: { kind: 'only', keys: [report] },
      fingerprint: workspace.fingerprint,
      description: '',
    }).catch((error: unknown) => error);

    expect(refused).toBeInstanceOf(IpcFailure);
    expect(refused).toMatchObject({ error: { code: 'InvalidArgument' } });
    expect(calls(invoke, 'summarize_selection')).toBe(1);
    expect(calls(invoke, 'generate_commit_message')).toBe(1);
  });

  it('starts the history once; a second start is HistoryExists', async () => {
    const { result, shell } = renderAppHook(
      () => ({ start: useStartHistory(), workspace: useWorkspace().data }),
      { scenario: 'history-none', now: NOW },
    );
    await waitFor(() => {
      expect(result.current.workspace).toMatchObject({ historyState: 'none', head: null, items: 0 });
    });

    const job = await act(() => result.current.start.mutateAsync('Start history'));
    await waitFor(() => {
      expect(result.current.workspace?.historyState).toBe('starting');
    });
    act(() => {
      shell.finishJobs();
    });

    await waitFor(() => {
      expect(result.current.workspace?.historyState).toBe('ready');
    });
    expect(result.current.workspace?.head).toMatch(/^b3:/);
    expect(shell.jobs().find((candidate) => candidate.id === job)).toMatchObject({ kind: 'firstCommit', status: { state: 'done' } });
    const again = await act(() => result.current.start.mutateAsync('Start history').catch((error: unknown) => error));
    expect(again).toMatchObject({ error: { code: 'HistoryExists' } });
  });

  it('lists the newest commits along HEAD: a commit asks again, a save does not', async () => {
    const { result, shell } = renderAppHook(
      () => {
        const workspace = useWorkspace().data;
        return { head: workspace?.head, notSynced: useNotSynced(workspace?.head).data, commit: useCommit() };
      },
      { now: NOW },
    );
    await waitFor(() => {
      expect(result.current.notSynced).toBeDefined();
    });
    const { notSynced } = result.current;
    expect(notSynced?.commits.map((commit) => commit.summary)).toEqual([
      'MAT232: rewrite the midterm review',
      'MAT232: add lecture 12; MAT223: update notes',
      'MAT223: update exercise 1; MAT232: update the midterm review',
    ]);
    expect(notSynced?.commits[0]?.id).toBe(result.current.head);
    const total = notSynced?.total ?? 0;
    expect(total).toBe(6);
    const invoke = vi.spyOn(shell, 'invoke');

    shell.editFile(WEEK2);
    await waitFor(() => {
      expect(calls(invoke, 'get_workspace')).toBe(1);
    });
    await settle();
    expect(calls(invoke, 'list_history')).toBe(0);

    const workspace = await unwrap(ipc.getWorkspace());
    await act(() =>
      result.current.commit.mutateAsync({ selection: ALL, fingerprint: workspace.fingerprint, base: workspace.head, summary: 'Commit it all', body: null }),
    );
    act(() => {
      shell.finishJobs();
    });

    await waitFor(() => {
      expect(result.current.notSynced?.commits[0]?.summary).toBe('Commit it all');
    });
    expect(result.current.notSynced?.total).toBe(total + 1);
    expect(result.current.notSynced?.commits[0]?.id).toBe(result.current.head);
    expect(calls(invoke, 'list_history')).toBe(1);
  });
});

describe('AI messages', () => {
  it('writes a message from the first descriptionChars of the description, made well-formed', async () => {
    const { shell } = renderAppHook(() => null, { now: NOW, aiDelayMs: 5 });
    const workspace = await unwrap(ipc.getWorkspace());
    const invoke = vi.spyOn(shell, 'invoke');

    const message = await generateCommitMessage({
      requestId: newRequestId(),
      selection: ALL,
      fingerprint: workspace.fingerprint,
      description: `é\uD800${'x'.repeat(LIMITS.descriptionChars)}`,
    });

    expect(message?.summary).toMatch(/: update 10 files and their notes$/);
    const sent = invoke.mock.calls.find(([command]) => command === 'generate_commit_message')?.[1] as {
      request: GenerateCommitMessage;
    };
    expect(sent.request.description.startsWith('é�x')).toBe(true);
    expect(Array.from(sent.request.description)).toHaveLength(LIMITS.descriptionChars);
    expect(sent.request.requestId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('stops a request, which then answers null; stopping one that ended changes nothing', async () => {
    const { shell } = renderAppHook(() => null, { now: NOW, aiMode: 'slow' });
    const workspace = await unwrap(ipc.getWorkspace());
    const invoke = vi.spyOn(shell, 'invoke');
    const requestId = newRequestId();

    const answer = generateCommitMessage({ requestId, selection: ALL, fingerprint: workspace.fingerprint, description: '' });
    await waitFor(() => {
      expect(calls(invoke, 'generate_commit_message')).toBe(1);
    });
    await settle();
    await cancelAiRequest(requestId);

    await expect(answer).resolves.toBeNull();
    await expect(cancelAiRequest(requestId)).resolves.toBeUndefined();
  });
});
