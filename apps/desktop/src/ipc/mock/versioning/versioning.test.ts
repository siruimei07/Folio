// The fake shell's M2 contract (docs/specs/ipc-m2.md), through the real generated bindings: the
// workspace, commits, history, diffs, restore and AI, as the M2 UI lanes see them.
import { mockIPC } from '@tauri-apps/api/mocks';
import { afterEach, describe, expect, it } from 'vitest';

import { unwrap } from '../../../data/errors';
import { charCount } from '../../../lib/text';
import {
  type AiSettingsChanged,
  type Diff,
  type HistoryChanged,
  type IpcError,
  ipc,
  type Job,
  type JobChanged,
  LIMITS,
  type Selection,
  type SelectionSummary,
  shellEvents,
  type SummaryGroup,
  shortId,
  versionUrl,
  type WorkspaceChanged,
  type WorkspaceItem,
} from '../..';
import { installFakeShell, scenarioFixture } from '..';
import type { FakeShell, FakeShellOptions } from '../shell';
import { blobVersion, item } from './model';

const NOW = Date.UTC(2026, 9, 4, 12);
const ALL: Selection = { kind: 'allExcept', keys: [] };
const PAGE = { offset: 0, limit: 500 };
const ROWS = { kind: 'rows', offset: 0, limit: 500 } as const;
const MAT = 'Fall 2026/MAT232 Calculus of Several Variables';
const REVIEW = `${MAT}/Exams/Midterm/Midterm review.md`;
const WEEK2 = `${MAT}/week 2 notes.md`;
/** The small library's file another program holds (`InUse`). */
const RECORDING = 'Fall 2026/ECO101 微观经济学/Lecture recording week 5.mp4';

let shell: FakeShell | undefined;

function install(scenario: Parameters<typeof scenarioFixture>[0] = 'small', options: Partial<FakeShellOptions> = {}) {
  shell = installFakeShell({
    fixture: scenarioFixture(scenario, NOW).fixture,
    now: () => NOW,
    jobStepMs: 1,
    aiDelayMs: 0,
    ...options,
  });
  return shell;
}

afterEach(() => {
  shell?.dispose();
  shell = undefined;
  mockIPC(() => undefined, { shouldMockEvents: true });
});

async function failure(call: Promise<{ status: string; error?: IpcError }>) {
  const result = await call;
  if (result.status !== 'error' || result.error === undefined) throw new Error('call succeeded');
  return result.error.code;
}

function collect<T>(subscribe: (onEvent: (payload: T) => void) => () => void) {
  const seen: T[] = [];
  const stop = subscribe((payload) => seen.push(payload));
  return { seen, stop };
}

const settle = async () => {
  await shell?.flush();
  await new Promise((resolve) => setTimeout(resolve, 5));
};

async function items(): Promise<WorkspaceItem[]> {
  return (await unwrap(ipc.listWorkspaceItems({ page: PAGE }))).items;
}

async function itemAt(path: string): Promise<WorkspaceItem> {
  const found = (await items()).find((entry) => entry.path === path);
  if (found === undefined) throw new Error(`no item at ${path}`);
  return found;
}

/** Runs the job to its end and returns how it ended. */
async function finish(id: string): Promise<Job> {
  shell?.finishJobs();
  const job = (await unwrap(ipc.listJobs())).find((candidate) => candidate.id === id);
  if (job === undefined) throw new Error(`no job ${id}`);
  return job;
}

async function commitAll(summary = 'MAT232: update 1 file') {
  const summaryNow = await unwrap(ipc.getWorkspace());
  const id = await unwrap(
    ipc.commit({ selection: ALL, fingerprint: summaryNow.fingerprint, base: summaryNow.head, summary, body: null }),
  );
  return finish(id);
}

async function commits() {
  const page = await unwrap(ipc.listHistory({ page: PAGE, types: ['commit'] }));
  return page.items.flatMap((entry) => (entry.kind === 'commit' ? [entry.commit] : []));
}

/** The version a commit stored for `path`. */
async function versionOf(path: string, nth = 0) {
  const file = await unwrap(
    ipc.listFileHistory({ file: { kind: 'entry', entry: entryRef(path) }, page: PAGE, types: ['commit'] }),
  );
  const found = file.items.filter((entry) => entry.kind === 'commit')[nth];
  if (found?.kind !== 'commit') throw new Error(`no version ${String(nth)} of ${path}`);
  return found;
}

function entryRef(path: string) {
  const ref = shell?.library.at(path);
  if (ref === undefined || shell === undefined) throw new Error(`no entry at ${path}`);
  return shell.library.ref(ref);
}

describe('workspace', () => {
  it('sums up the changes, with readiness and a fingerprint', async () => {
    install();
    const summary = await unwrap(ipc.getWorkspace());
    expect(summary).toMatchObject({ historyState: 'ready', notLocal: 1, unreadable: 1, hashing: 1 });
    expect(summary.fingerprint).toMatch(/^[0-9a-f]{32}$/);
    expect(summary.head).toMatch(/^b3:[0-9a-f]{64}$/);
    expect(summary.includable).toBe(summary.items - 2);
    const list = await items();
    expect(list).toHaveLength(summary.items);
    expect(list.find((entry) => entry.change === 'deleted')?.entry).toBeNull();
    expect((await itemAt(REVIEW)).entry?.path).toBe(REVIEW);
    expect((await itemAt(REVIEW)).tagsChanged).toBe(true);
    expect((await unwrap(ipc.listMetadataChanges({ page: PAGE }))).total).toBe(summary.metadata);
  });

  it('lists a bound item as one row with its parts', async () => {
    install();
    const bound = (await items()).find((entry) => entry.parts.length > 0);
    expect(bound).toMatchObject({ change: 'moved', parts: [{ kind: 'entry', change: 'deleted', entryKind: 'file' }] });
  });

  it('checks a selection: limits, then the fingerprint, then the keys', async () => {
    install();
    const { fingerprint } = await unwrap(ipc.getWorkspace());
    const tooMany: Selection = { kind: 'only', keys: Array.from({ length: LIMITS.batch + 1 }, (_, n) => String(n)) };
    expect(await failure(ipc.summarizeSelection({ selection: tooMany, fingerprint }))).toBe('InvalidArgument');
    expect(await failure(ipc.summarizeSelection({ selection: ALL, fingerprint: '0'.repeat(32) }))).toBe('WorkspaceChanged');
    expect(
      await failure(ipc.summarizeSelection({ selection: { kind: 'only', keys: ['made up'] }, fingerprint })),
    ).toBe('InvalidArgument');
  });

  it('summarizes "everything except" without the blocked items, per place', async () => {
    install();
    const summary = await unwrap(ipc.getWorkspace());
    const selected = await unwrap(ipc.summarizeSelection({ selection: ALL, fingerprint: summary.fingerprint }));
    expect(selected.items).toBe(summary.includable);
    expect(selected.metadata).toBe(summary.metadata);
    const mat = selected.groups.find((group) => group.place.kind === 'course' && group.place.code === 'MAT232');
    expect(mat).toMatchObject({ files: { modified: 1, deleted: 1, moved: 1 }, tags: 2 });
    expect(selected.ignoreRules).toBe(true);
    const review = await itemAt(REVIEW);
    const without = await unwrap(
      ipc.summarizeSelection({ selection: { kind: 'allExcept', keys: [review.key] }, fingerprint: summary.fingerprint }),
    );
    expect(without.items).toBe(selected.items - 1);
  });

  it('changes the fingerprint when an item becomes includable', async () => {
    const fake = install();
    const before = (await unwrap(ipc.getWorkspace())).fingerprint;
    fake.downloadFile('Personal/Photos/IMG_2031.HEIC');
    const after = await unwrap(ipc.getWorkspace());
    expect(after.fingerprint).not.toBe(before);
    expect(after.notLocal).toBe(0);
  });

  const NONE: Selection = { kind: 'only', keys: [] };

  const summarize = async (selection: Selection, fingerprint: string) =>
    unwrap(ipc.summarizeSelection({ selection, fingerprint }));

  /** The group of the semester or course at `path`. */
  function groupAt(summary: SelectionSummary, path: string): SummaryGroup {
    const found = summary.groups.find((group) => group.place.kind !== 'library' && group.place.path === path);
    if (found === undefined) throw new Error(`no group at ${path}`);
    return found;
  }

  const sumOf = (groups: readonly SummaryGroup[], count: (group: SummaryGroup) => number) =>
    groups.reduce((total, group) => total + count(group), 0);

  it('counts every item of each place, blocked ones too, whatever the selection', async () => {
    install();
    const summary = await unwrap(ipc.getWorkspace());
    const all = await summarize(ALL, summary.fingerprint);
    expect(sumOf(all.groups, (group) => group.items)).toBe(summary.items);
    // A ready png and an unreadable recording.
    expect(groupAt(all, 'Fall 2026/ECO101 微观经济学')).toMatchObject({ items: 2, available: 1, selected: 1 });
    // Only a photo that is not on this disk.
    expect(groupAt(all, 'Personal/Photos')).toMatchObject({ items: 1, available: 0, selected: 0 });
    const none = await summarize(NONE, summary.fingerprint);
    expect(none.groups.map((group) => group.items)).toEqual(all.groups.map((group) => group.items));
    expect(none.groups.every((group) => group.selected === 0)).toBe(true);
  });

  /** Two lectures the versioning rules now store (ipc-m2 §6.2): one ready, one unreadable. */
  function addRequired(fake: FakeShell) {
    fake.versioning.items = [
      ...fake.versioning.items,
      item({
        change: 'modified',
        kind: 'file',
        path: `${MAT}/Lectures/Lecture 01.pdf`,
        before: blobVersion(1_291_337, 'lecture 1'),
        after: blobVersion(1_302_115, 'lecture 1'),
        required: true,
        parts: [{ kind: 'versioningRules' }],
      }),
      item({
        change: 'modified',
        kind: 'file',
        path: `${MAT}/Lectures/Lecture 02.pdf`,
        before: blobVersion(1_382_674, 'lecture 2'),
        after: blobVersion(1_390_002, 'lecture 2'),
        readiness: 'unreadable',
        required: true,
        parts: [{ kind: 'versioningRules' }],
      }),
    ];
  }

  it('counts the required items of each place, blocked ones too, as available and selected', async () => {
    addRequired(install());
    const { fingerprint } = await unwrap(ipc.getWorkspace());
    const all = groupAt(await summarize(ALL, fingerprint), MAT);
    const none = groupAt(await summarize(NONE, fingerprint), MAT);
    // Three ready changes, and the two required lectures, which every selection includes.
    expect(all).toMatchObject({ items: 5, available: 5, selected: 5, required: 2 });
    expect(none).toMatchObject({ items: 5, available: 5, selected: 2, required: 2 });
    // The course header's box counts what the person can change (ipc-m2 §6.4): on, then off.
    expect(all.selected - all.required).toBe(all.available - all.required);
    expect(none.selected - none.required).toBe(0);
    expect(none.available - none.required).toBe(3);
  });

  it('keeps a required item in an allExcept that lists it, blocked or not (ipc-m2 §5.1, §6.2)', async () => {
    addRequired(install());
    const { fingerprint } = await unwrap(ipc.getWorkspace());
    const required = (await items()).filter((entry) => entry.required);
    expect(required.map((entry) => entry.readiness)).toEqual(['ready', 'unreadable']);
    const all = await summarize(ALL, fingerprint);
    const none = await summarize(NONE, fingerprint);
    for (const entry of required) {
      expect(await summarize({ kind: 'allExcept', keys: [entry.key] }, fingerprint), entry.path).toEqual(all);
      expect(await summarize({ kind: 'only', keys: [entry.key] }, fingerprint), entry.path).toEqual(none);
    }
  });

  it('counts the tag change of an item only when the commit records it (versioning §6.4)', async () => {
    const fake = install();
    const tags = fake.versioning.items.find((entry) => entry.tags !== null)?.tags ?? null;
    expect(tags).not.toBeNull();
    const lecture = blobVersion(1_400_000, 'lecture 3');
    const added = item({ change: 'added', kind: 'file', path: `${MAT}/Lectures/Lecture 03.pdf`, after: lecture, tags });
    const moved = item({
      change: 'moved',
      kind: 'file',
      path: `${MAT}/Lectures/Lecture 04.pdf`,
      fromPath: `${MAT}/Lecture 04.pdf`,
      before: lecture,
      after: lecture,
      tags,
    });
    fake.versioning.items = [...fake.versioning.items, added, moved];
    const { fingerprint } = await unwrap(ipc.getWorkspace());
    const tagsOfMat = async (selection: Selection) => groupAt(await summarize(selection, fingerprint), MAT).tags;
    // The review (modified), a tags row of its own, the addition and the move.
    expect(await tagsOfMat(ALL)).toBe(4);
    // Left out, the addition keeps its tags for the commit that adds it; the move writes its new
    // tags at its old path, and the review at its path.
    expect(await tagsOfMat({ kind: 'allExcept', keys: [added.key] })).toBe(3);
    expect(await tagsOfMat({ kind: 'allExcept', keys: [moved.key] })).toBe(4);
    expect(await tagsOfMat(NONE)).toBe(3);
    expect(await tagsOfMat({ kind: 'only', keys: [added.key] })).toBe(4);
  });

  it('gives the select-all what the person can change, summed over the groups (ipc-m2 §6.4)', async () => {
    addRequired(install());
    const workspace = await unwrap(ipc.getWorkspace());
    const ready = (await items()).find((entry) => !entry.required && entry.readiness === 'ready');
    if (ready === undefined) throw new Error('no ready item');
    const summary = await summarize({ kind: 'allExcept', keys: [ready.key] }, workspace.fingerprint);
    // In the totals the unreadable required lecture makes up for the item left out…
    expect(summary.items).toBe(workspace.includable);
    // …in the groups it does not: one item the person can include is left out, so the box is mixed.
    const changeable = sumOf(summary.groups, (group) => group.available - group.required);
    const included = sumOf(summary.groups, (group) => group.selected - group.required);
    expect(changeable).toBe(workspace.includable - 1);
    expect(included).toBe(changeable - 1);
  });

  it.each([
    { scenario: 'small', required: false },
    { scenario: 'diffs', required: false },
    { scenario: 'small', required: true },
  ] as const)(
    'keeps required ≤ selected ≤ available ≤ items in every place of $scenario (required items: $required)',
    async ({ scenario, required }) => {
      const fake = install(scenario);
      if (required) addRequired(fake);
      const summary = await unwrap(ipc.getWorkspace());
      const listed = await items();
      // An `only` that names a blocked item that is not required is the one exception (ipc-m2 §6.4).
      const includable = listed.filter(
        (entry) => entry.required || entry.readiness === 'ready' || entry.readiness === 'hashing',
      );
      const selections: Selection[] = [
        ALL,
        NONE,
        ...listed.map((entry): Selection => ({ kind: 'allExcept', keys: [entry.key] })),
        ...includable.map((entry): Selection => ({ kind: 'only', keys: [entry.key] })),
      ];
      const total = (counts: Record<string, number>) => Object.values(counts).reduce((sum, count) => sum + count, 0);
      for (const selection of selections) {
        const result = await summarize(selection, summary.fingerprint);
        const label = `${selection.kind} [${selection.keys.join(', ')}]`;
        expect(sumOf(result.groups, (group) => group.items), label).toBe(summary.items);
        expect(sumOf(result.groups, (group) => group.selected), label).toBe(result.items);
        for (const group of result.groups) {
          const where = `${label} in ${group.place.kind === 'library' ? 'the library' : group.place.path}`;
          expect(group.required, where).toBeLessThanOrEqual(group.selected);
          expect(group.selected, where).toBeLessThanOrEqual(group.available);
          expect(group.available, where).toBeLessThanOrEqual(group.items);
          expect(total(group.files) + total(group.folders), where).toBe(group.selected);
          if (!required) expect(group.required, where).toBe(0);
        }
      }
    },
  );
});

describe('commit', () => {
  it('commits as a job with byte progress, then sends HistoryChanged and WorkspaceChanged', async () => {
    install();
    const jobs = collect<JobChanged>(shellEvents.onJobChanged);
    const workspace = collect<WorkspaceChanged>(shellEvents.onWorkspaceChanged);
    const history = collect<HistoryChanged>(shellEvents.onHistoryChanged);
    const before = await commits();
    const job = await commitAll('MAT232: tidy the review');
    expect(job).toMatchObject({ kind: 'commit', status: { state: 'done', result: { kind: 'commit', summary: 'MAT232: tidy the review' } } });
    await settle();
    const progress = jobs.seen.find((event) => event.job.status.state === 'running' && event.job.status.progress.bytes !== null);
    expect(progress).toBeDefined();
    const after = await commits();
    expect(after).toHaveLength(before.length + 1);
    expect(after[0]).toMatchObject({ summary: 'MAT232: tidy the review', head: true, synced: false, device: { name: 'G16' } });
    const summary = await unwrap(ipc.getWorkspace());
    expect(summary).toMatchObject({ items: 2, metadata: 0, head: after[0]?.id });
    expect(history.seen.at(-1)?.head).toBe(after[0]?.id);
    expect(workspace.seen.at(-1)).toMatchObject({ total: 2, historyState: 'ready' });
  });

  it('applies the message rules before anything else', async () => {
    install();
    const { fingerprint, head } = await unwrap(ipc.getWorkspace());
    const commit = (summary: string, body: string | null = null) =>
      failure(ipc.commit({ selection: ALL, fingerprint, base: head, summary, body }));
    expect(await commit('   ')).toBe('SummaryEmpty');
    expect(await commit('x'.repeat(LIMITS.summaryChars + 1))).toBe('SummaryTooLong');
    expect(await commit('two\nlines')).toBe('SummaryInvalid');
    expect(await commit('ok', 'x'.repeat(LIMITS.bodyChars + 1))).toBe('BodyTooLong');
    expect(await commit('ok', 'bell \u0007')).toBe('BodyInvalid');
    expect(await failure(ipc.commit({ selection: ALL, fingerprint, base: null, summary: 'ok', body: null }))).toBe(
      'WorkspaceChanged',
    );
  });

  it('keeps the body as typed, with LF line breaks and nothing trailing', async () => {
    install();
    const { fingerprint, head } = await unwrap(ipc.getWorkspace());
    const id = await unwrap(ipc.commit({ selection: ALL, fingerprint, base: head, summary: '  Summary  ', body: '\n\nline 1\r\nline 2  \n\n' }));
    await finish(id);
    expect((await commits())[0]).toMatchObject({ summary: 'Summary', body: 'line 1\nline 2' });
  });

  it('fails a job on a blocked item it was asked for, naming the file', async () => {
    install();
    const { fingerprint, head } = await unwrap(ipc.getWorkspace());
    const blocked = (await items()).find((entry) => entry.readiness === 'notLocal');
    const id = await unwrap(
      ipc.commit({ selection: { kind: 'only', keys: [blocked?.key ?? ''] }, fingerprint, base: head, summary: 'x', body: null }),
    );
    expect((await finish(id)).status).toEqual({
      state: 'failed',
      error: expect.objectContaining({ code: 'NotLocal' }) as unknown,
      file: blocked?.path,
    });
    // Nothing was written, and the next commit may run.
    expect((await commitAll()).status.state).toBe('done');
  });

  it('fails the next commit as the URL asks, once', async () => {
    install('small', { commitFailure: { code: 'FileChanged', file: REVIEW } });
    expect((await commitAll()).status).toMatchObject({ state: 'failed', error: { code: 'FileChanged' }, file: REVIEW });
    expect((await commitAll()).status.state).toBe('done');
  });

  it('stops being cancellable when it reaches the switch', async () => {
    install();
    const { fingerprint, head } = await unwrap(ipc.getWorkspace());
    const id = await unwrap(ipc.commit({ selection: ALL, fingerprint, base: head, summary: 'x', body: null }));
    let job: Job | undefined;
    for (let step = 0; step < 50; step++) {
      shell?.stepJobs();
      job = (await unwrap(ipc.listJobs())).find((candidate) => candidate.id === id);
      if (job?.cancellable === false) break;
    }
    expect(job).toMatchObject({ cancellable: false, status: { state: 'running' } });
    expect(await failure(ipc.cancelJob({ job: id }))).toBe('InvalidArgument');
    expect((await finish(id)).status.state).toBe('done');
  });

  it('refuses a second commit while one runs', async () => {
    install();
    const { fingerprint, head } = await unwrap(ipc.getWorkspace());
    await unwrap(ipc.commit({ selection: ALL, fingerprint, base: head, summary: 'one', body: null }));
    expect(await failure(ipc.commit({ selection: ALL, fingerprint, base: head, summary: 'two', body: null }))).toBe('HistoryBusy');
  });

  it('keeps the history when "Try again" opens the library again', async () => {
    const fake = install();
    const before = await commits();
    fake.makeUnavailable('missing');
    fake.makeReachable();
    await unwrap(ipc.libraryStatus());
    expect((await commits()).map((commit) => commit.id)).toEqual(before.map((commit) => commit.id));
    expect((await unwrap(ipc.getWorkspace())).items).toBeGreaterThan(0);
  });

  it('commits nothing while the history is read-only or damaged', async () => {
    install('history-read-only');
    const { fingerprint, head } = await unwrap(ipc.getWorkspace());
    expect(await failure(ipc.commit({ selection: ALL, fingerprint, base: head, summary: 'x', body: null }))).toBe('HistoryReadOnly');
    shell?.dispose();
    install('history-damaged');
    expect((await unwrap(ipc.getWorkspace())).items).toBe(0);
    expect(await failure(ipc.listHistory({ page: PAGE, types: null }))).toBe('HistoryDamaged');
  });
});

describe('the first commit', () => {
  it('starts the history from an empty workspace and leaves the unreadable file in Changes', async () => {
    install('history-none');
    const empty = await unwrap(ipc.getWorkspace());
    expect(empty).toMatchObject({ historyState: 'none', head: null, items: 0, fingerprint: '0'.repeat(32) });
    expect(await failure(ipc.commit({ selection: ALL, fingerprint: empty.fingerprint, base: null, summary: 'x', body: null }))).toBe(
      'NothingToCommit',
    );
    const id = await unwrap(ipc.startHistory({ summary: 'Start history' }));
    expect((await unwrap(ipc.getWorkspace())).historyState).toBe('starting');
    const job = await finish(id);
    expect(job).toMatchObject({ kind: 'firstCommit', status: { state: 'done', result: { kind: 'firstCommit', left: 1 } } });
    const ready = await unwrap(ipc.getWorkspace());
    expect(ready).toMatchObject({ historyState: 'ready', items: 1, unreadable: 1 });
    const [first] = await commits();
    expect(first).toMatchObject({ summary: 'Start history', first: true, head: true });
    expect(first?.files).toBeGreaterThan(50);
    expect(await failure(ipc.startHistory({ summary: 'Start history' }))).toBe('HistoryExists');
  });

  it('waits for a running scan before the first commit starts', async () => {
    const fake = install('history-none');
    fake.startScan();
    const id = await unwrap(ipc.startHistory({ summary: 'Start history' }));
    fake.stepJobs();
    fake.stepJobs();
    const job = (await unwrap(ipc.listJobs())).find((candidate) => candidate.id === id);
    expect(job?.status.state).toBe('queued');
    expect((await finish(id)).status.state).toBe('done');
  });

  it('fails the first commit once as the URL asks', async () => {
    install('history-none', { commitFailure: { code: 'DiskFull', file: null } });
    expect((await finish(await unwrap(ipc.startHistory({ summary: 'Start history' })))).status).toMatchObject({
      state: 'failed',
      error: { code: 'DiskFull' },
      file: null,
    });
    expect((await finish(await unwrap(ipc.startHistory({ summary: 'Start history' })))).status.state).toBe('done');
  });

  it('returns to no history when the first commit is cancelled', async () => {
    install('history-none');
    const id = await unwrap(ipc.startHistory({ summary: 'Start history' }));
    await unwrap(ipc.cancelJob({ job: id }));
    shell?.finishJobs();
    expect((await unwrap(ipc.getWorkspace())).historyState).toBe('none');
  });
});

describe('a history too large to keep', () => {
  const PHOTOS = 'Personal/Photos';

  async function startHistory(): Promise<Job> {
    return finish(await unwrap(ipc.startHistory({ summary: 'Start history' })));
  }

  it('lists nothing and answers as before the first commit, then runs the first commit again', async () => {
    install('history-too-large');
    const summary = await unwrap(ipc.getWorkspace());
    expect(summary).toMatchObject({
      historyState: 'tooLarge',
      tooLargeFolder: PHOTOS,
      head: null,
      fingerprint: '0'.repeat(32),
      items: 0,
      metadata: 0,
      includable: 0,
    });
    expect((await unwrap(ipc.listWorkspaceItems({ page: PAGE }))).total).toBe(0);
    expect((await unwrap(ipc.listMetadataChanges({ page: PAGE }))).total).toBe(0);
    expect((await unwrap(ipc.listHistory({ page: PAGE, types: null }))).total).toBe(0);
    const review = { kind: 'entry', entry: entryRef(REVIEW) } as const;
    expect((await unwrap(ipc.listFileHistory({ file: review, page: PAGE, types: null }))).total).toBe(0);
    expect(await failure(ipc.getCommit({ commit: `b3:${'0'.repeat(64)}` }))).toBe('NotFound');
    expect(
      await failure(ipc.commit({ selection: ALL, fingerprint: summary.fingerprint, base: null, summary: 'x', body: null })),
    ).toBe('NothingToCommit');

    const id = await unwrap(ipc.startHistory({ summary: 'Start history' }));
    expect(await unwrap(ipc.getWorkspace())).toMatchObject({ historyState: 'starting', tooLargeFolder: null });
    expect((await finish(id)).status.state).toBe('done');
    expect(await unwrap(ipc.getWorkspace())).toMatchObject({ historyState: 'ready', tooLargeFolder: null });
  });

  it('turns the history off when the first commit fails for its size, naming the folder', async () => {
    install('history-none', { commitFailure: { code: 'HistoryTooLarge', file: PHOTOS } });
    const workspace = collect<WorkspaceChanged>(shellEvents.onWorkspaceChanged);
    expect(await startHistory()).toMatchObject({
      kind: 'firstCommit',
      status: { state: 'failed', error: { code: 'HistoryTooLarge' }, file: PHOTOS },
    });
    expect(await unwrap(ipc.getWorkspace())).toMatchObject({ historyState: 'tooLarge', tooLargeFolder: PHOTOS, head: null, items: 0 });
    await settle();
    expect(workspace.seen.at(-1)).toMatchObject({ historyState: 'tooLarge', head: null, total: 0 });
    workspace.stop();
  });

  it('fails before it reads a file, as the limits are checked first (ipc-m2 §7.1)', async () => {
    for (const scenario of ['history-none', 'small'] as const) {
      shell?.dispose();
      install(scenario, { commitFailure: { code: 'HistoryTooLarge', file: PHOTOS } });
      const jobs = collect<JobChanged>(shellEvents.onJobChanged);
      const job = scenario === 'small' ? await commitAll() : await startHistory();
      await settle();
      jobs.stop();
      expect(job.status).toMatchObject({ state: 'failed', error: { code: 'HistoryTooLarge' }, file: PHOTOS });
      const running = jobs.seen.flatMap(({ job: seen }) =>
        seen.id === job.id && seen.status.state === 'running' ? [seen.status.progress] : [],
      );
      expect(running.length).toBeGreaterThan(0);
      for (const progress of running) expect(progress).toMatchObject({ done: 0, current: null });
    }
  });

  it('names no folder when the library as a whole is too large', async () => {
    install('history-none', { commitFailure: { code: 'HistoryTooLarge', file: null } });
    expect((await startHistory()).status).toMatchObject({ state: 'failed', error: { code: 'HistoryTooLarge' }, file: null });
    expect(await unwrap(ipc.getWorkspace())).toMatchObject({ historyState: 'tooLarge', tooLargeFolder: null });
  });

  it("ends when the catalog's entries change, not their tags, and the first commit then starts the history", async () => {
    const fake = install('history-too-large');
    const workspace = collect<WorkspaceChanged>(shellEvents.onWorkspaceChanged);
    const tags = fake.library.at(REVIEW)?.tags ?? [];
    const tag = fake.library.tags.find((candidate) => !tags.includes(candidate.id));
    await unwrap(ipc.setEntryTags({ entries: [entryRef(REVIEW)], add: [tag?.id ?? ''], remove: [] }));
    await settle();
    expect((await unwrap(ipc.getWorkspace())).historyState).toBe('tooLarge');

    fake.editFile(WEEK2);
    await settle();
    expect(await unwrap(ipc.getWorkspace())).toMatchObject({ historyState: 'none', tooLargeFolder: null, items: 0 });
    expect(workspace.seen.at(-1)).toMatchObject({ historyState: 'none', head: null, total: 0 });
    workspace.stop();
    expect((await startHistory()).status.state).toBe('done');
    expect((await unwrap(ipc.getWorkspace())).historyState).toBe('ready');

    // An M1 command, and a rebuilt catalog, change the entries too, and only the WorkspaceChanged
    // that ends the state tells the UI to start the first commit again (they reach no item).
    shell?.dispose();
    install('history-too-large');
    const renamed = collect<WorkspaceChanged>(shellEvents.onWorkspaceChanged);
    await unwrap(ipc.renameEntry({ entry: entryRef(WEEK2), name: 'week 2 notes (old).md' }));
    await settle();
    expect(await unwrap(ipc.getWorkspace())).toMatchObject({ historyState: 'none', tooLargeFolder: null });
    expect(renamed.seen.at(-1)).toMatchObject({ historyState: 'none', head: null, total: 0 });
    renamed.stop();
    shell?.dispose();
    install('history-too-large');
    const rebuilt = collect<WorkspaceChanged>(shellEvents.onWorkspaceChanged);
    await finish(await unwrap(ipc.rebuildCatalog()));
    await settle();
    expect(await unwrap(ipc.getWorkspace())).toMatchObject({ historyState: 'none', tooLargeFolder: null });
    expect(rebuilt.seen.at(-1)).toMatchObject({ historyState: 'none', head: null, total: 0 });
    rebuilt.stop();
  });

  it('hides what changed before the history started, and commits none of it, while too large', async () => {
    const fake = install('history-none', { commitFailure: { code: 'HistoryTooLarge', file: PHOTOS } });
    fake.addFile('Personal/new.txt');
    const hidden = fake.versioning.items.find((entry) => entry.path === 'Personal/new.txt');
    expect(hidden).toMatchObject({ change: 'added', readiness: 'hashing' });
    expect((await startHistory()).status).toMatchObject({ state: 'failed', error: { code: 'HistoryTooLarge' } });
    const summary = await unwrap(ipc.getWorkspace());
    expect(summary).toMatchObject({ historyState: 'tooLarge', fingerprint: '0'.repeat(32), items: 0, hashing: 0 });
    expect((await unwrap(ipc.listWorkspaceItems({ page: PAGE }))).total).toBe(0);
    // Refused before the selection is checked: even the hidden item's key is NothingToCommit.
    const only: Selection = { kind: 'only', keys: [hidden?.key ?? ''] };
    expect(
      await failure(ipc.commit({ selection: only, fingerprint: summary.fingerprint, base: null, summary: 'x', body: null })),
    ).toBe('NothingToCommit');
  });

  it('commits the files as the console changed them, and leaves only what it left out', async () => {
    const fake = install('history-too-large');
    fake.editFile(WEEK2);
    fake.addFile('Personal/new.txt');
    // The file another program holds: the first commit leaves it out, as the console left it.
    fake.editFile(RECORDING);
    const [week2, recording] = [WEEK2, RECORDING].map((path) => fake.versioning.items.find((entry) => entry.path === path)?.after);
    expect((await startHistory()).status).toMatchObject({ state: 'done', result: { kind: 'firstCommit', left: 1 } });
    const listed = await items();
    expect(listed.map((entry) => [entry.change, entry.path, entry.readiness])).toEqual([['added', RECORDING, 'unreadable']]);
    expect(listed[0]?.after?.size).toBe(String(recording?.size));
    expect((await versionOf(WEEK2)).change.after?.hash).toBe(week2?.hash);
  });

  it('lists what changed while the first commit ran against the version it took', async () => {
    const fake = install('history-too-large');
    const NEW = 'Personal/new.txt';
    fake.editFile(WEEK2);
    fake.addFile(NEW);
    const id = await unwrap(ipc.startHistory({ summary: 'Start history' }));
    fake.stepJobs();
    fake.stepJobs();
    expect((await unwrap(ipc.listJobs())).find((job) => job.id === id)?.status.state).toBe('running');
    for (const path of [WEEK2, NEW, RECORDING]) fake.editFile(path);
    const recording = fake.versioning.items.find((entry) => entry.path === RECORDING)?.after;
    expect((await finish(id)).status.state).toBe('done');
    const { head } = await unwrap(ipc.getWorkspace());
    const listed = await items();
    expect(listed.map((entry) => [entry.change, entry.path]).sort()).toEqual(
      [['modified', WEEK2], ['modified', NEW], ['added', RECORDING]].sort(),
    );
    for (const path of [WEEK2, NEW]) {
      // Its history starts at the first commit, and the diff compares the disk with that version.
      const took = (await versionOf(path)).change.after?.hash;
      const diff = await unwrap(ipc.getWorkspaceDiff({ key: (await itemAt(path)).key, window: ROWS }));
      expect(diff.before).toMatchObject({ commit: head, hash: took });
      expect(diff.after?.hash).not.toBe(took);
    }
    expect((await itemAt(RECORDING)).after?.size).toBe(String(recording?.size));
  });

  it('keeps a ready history and its items when a commit would be too large', async () => {
    install('small', { commitFailure: { code: 'HistoryTooLarge', file: PHOTOS } });
    const before = await unwrap(ipc.getWorkspace());
    expect((await commitAll()).status).toMatchObject({ state: 'failed', error: { code: 'HistoryTooLarge' }, file: PHOTOS });
    expect(await unwrap(ipc.getWorkspace())).toEqual(before);
    expect(before).toMatchObject({ historyState: 'ready', tooLargeFolder: null });
    expect((await commitAll()).status.state).toBe('done');
  });

  it('opens the library again at no history, to try once more', async () => {
    const fake = install('history-too-large');
    fake.makeUnavailable('missing');
    fake.makeReachable();
    await unwrap(ipc.libraryStatus());
    expect(await unwrap(ipc.getWorkspace())).toMatchObject({ historyState: 'none', tooLargeFolder: null, head: null });
  });

  it('names no folder in any other state', async () => {
    const states = [
      ['small', 'ready'],
      ['history-none', 'none'],
      ['history-read-only', 'readOnly'],
      ['history-damaged', 'damaged'],
    ] as const;
    for (const [scenario, historyState] of states) {
      shell?.dispose();
      install(scenario);
      expect(await unwrap(ipc.getWorkspace())).toMatchObject({ historyState, tooLargeFolder: null });
    }
  });
});

describe('history', () => {
  it('lists commits and operations newest first, with effective times', async () => {
    install();
    const page = await unwrap(ipc.listHistory({ page: PAGE, types: null }));
    expect(page.items.map((entry) => entry.kind).slice(0, 3)).toEqual(['reword', 'uncommit', 'commit']);
    const times = page.items.map((entry) => Number(entry.kind === 'commit' ? entry.commit.effectiveMs : entry.effectiveMs));
    expect([...times].sort((a, b) => b - a)).toEqual(times);
    const uncommit = page.items.find((entry) => entry.kind === 'uncommit');
    expect(uncommit).toMatchObject({ summary: 'ECO101: add demand data' });
    const oldest = page.items.at(-1);
    expect(oldest?.kind === 'commit' && oldest.commit.first).toBe(true);
  });

  it('gives "Not synced" the newest three commits and their count', async () => {
    install('history-long');
    const page = await unwrap(ipc.listHistory({ page: { offset: 0, limit: 3 }, types: ['commit'] }));
    expect(page.items).toHaveLength(3);
    expect(page.total).toBe(1_200);
    const all = await unwrap(ipc.listHistory({ page: { offset: 0, limit: 0 }, types: null }));
    expect(all.total).toBeGreaterThan(1_200);
  });

  it('shows a prune commit and the versions it thinned out', async () => {
    install('history-long');
    let prune;
    for (let offset = 0; prune === undefined && offset < 1_200; offset += 500) {
      const page = await unwrap(ipc.listHistory({ page: { offset, limit: 500 }, types: ['commit'] }));
      prune = page.items.find((entry) => entry.kind === 'commit' && entry.commit.kind === 'prune');
    }
    expect(prune?.kind === 'commit' && prune.commit).toMatchObject({ summary: null, pruned: expect.any(Number) as unknown });
    if (prune?.kind !== 'commit') return;
    expect(await failure(ipc.rewordCommit({ commit: prune.commit.id, summary: 'x', body: null }))).toBe('CannotReword');
  });

  it("lists a commit's files and its tag and settings changes", async () => {
    install();
    await commitAll();
    const [latest] = await commits();
    const files = await unwrap(ipc.listCommitChanges({ commit: latest?.id ?? '', page: PAGE }));
    expect(files.total).toBe((latest?.files ?? 0) + (latest?.folders ?? 0));
    const metadata = await unwrap(ipc.listCommitMetadata({ commit: latest?.id ?? '', page: PAGE }));
    expect(metadata.total).toBe(4);
    expect(metadata.items.every((row) => !('entry' in row.subject) || row.subject.entry === null)).toBe(true);
    expect(await failure(ipc.getCommit({ commit: `b3:${'0'.repeat(64)}` }))).toBe('NotFound');
    expect(await failure(ipc.getCommit({ commit: 'nonsense' }))).toBe('InvalidArgument');
  });

  it("follows one file's history and marks the version the disk has", async () => {
    install();
    const review = await unwrap(
      ipc.listFileHistory({ file: { kind: 'entry', entry: entryRef(REVIEW) }, page: PAGE, types: null }),
    );
    expect(review.items.map((entry) => entry.kind === 'commit' && entry.change.change)).toEqual(['modified', 'modified', 'added']);
    // The review has uncommitted changes, so no version is current.
    expect(review.items.some((entry) => entry.kind === 'commit' && entry.current)).toBe(false);
    const week2 = await versionOf(WEEK2);
    expect(week2.current).toBe(true);
  });

  it('follows a file whose folder moved since the last commit', async () => {
    install();
    const exercise = await unwrap(
      ipc.listFileHistory({
        file: { kind: 'entry', entry: entryRef('Fall 2026/线性代数/习题/习题 1.docx') },
        page: PAGE,
        types: ['commit'],
      }),
    );
    expect(exercise.items.map((entry) => entry.kind === 'commit' && entry.change.path)).toEqual([
      'Fall 2026/线性代数/Exercises/习题 1.docx',
      'Fall 2026/线性代数/Exercises/习题 1.docx',
    ]);
    expect(exercise.items[0]?.kind === 'commit' && exercise.items[0].current).toBe(true);
  });

  it('rewords a commit, which gets a new id, and logs it', async () => {
    install();
    const [head] = await commits();
    const id = await unwrap(ipc.rewordCommit({ commit: head?.id ?? '', summary: 'MAT232: a better summary', body: 'Why.' }));
    expect(id).not.toBe(head?.id);
    expect(await unwrap(ipc.rewordCommit({ commit: id, summary: 'MAT232: a better summary', body: 'Why.' }))).toBe(id);
    const page = await unwrap(ipc.listHistory({ page: PAGE, types: ['reword'] }));
    expect(page.items[0]).toMatchObject({ kind: 'reword', commit: id, previous: head?.id });
    expect(await failure(ipc.getCommit({ commit: head?.id ?? '' }))).toBe('NotFound');
  });

  it('undoes only the newest commit, never the first, and its changes come back', async () => {
    install();
    const before = (await unwrap(ipc.getWorkspace())).items;
    const list = await commits();
    expect(await failure(ipc.uncommit({ commit: list[1]?.id ?? '' }))).toBe('NotHead');
    await unwrap(ipc.uncommit({ commit: list[0]?.id ?? '' }));
    expect((await unwrap(ipc.getWorkspace())).items).toBe(before);
    const fresh = install('history-none');
    await finish(await unwrap(ipc.startHistory({ summary: 'Start history' })));
    expect(fresh).toBeDefined();
    const [first] = await commits();
    expect(await failure(ipc.uncommit({ commit: first?.id ?? '' }))).toBe('CannotUncommit');
  });
});

describe('diffs', () => {
  it('shows a text change folded, with marks, and pages and unfolds it', async () => {
    install();
    const diff = await unwrap(ipc.getWorkspaceDiff({ key: (await itemAt(REVIEW)).key, window: ROWS }));
    expect(diff.before?.commit).toMatch(/^b3:/);
    expect(diff.after).toMatchObject({ commit: null, path: REVIEW });
    expect(diff.tags?.added.map((tag) => tag.id)).toEqual(['exam']);
    if (diff.content.kind !== 'text') throw new Error(diff.content.kind);
    expect(diff.content.text.changes).toBeGreaterThan(0);
    const marked = diff.content.text.window.find((row) => row.kind === 'added' && row.marks.length > 0);
    expect(marked).toBeDefined();
  });

  it('pages a large diff and unfolds hidden lines', async () => {
    install('diffs');
    const key = (await itemAt('Fall 2026/CSC148 Introduction to Computer Science/labs/lab2/data.csv')).key;
    const first = await unwrap(ipc.getWorkspaceDiff({ key, window: ROWS }));
    if (first.content.kind !== 'text') throw new Error(first.content.kind);
    const { text } = first.content;
    expect(text).toMatchObject({ added: 5_000, removed: 5_000, changes: 5_000 });
    expect(text.rows).toBeGreaterThan(500);
    expect(text.window).toHaveLength(500);
    const header = await unwrap(ipc.getWorkspaceDiff({ key, window: { kind: 'rows', offset: 0, limit: 0 } }));
    expect(header.content.kind === 'text' && header.content.text.window).toEqual([]);
    expect(await failure(ipc.getWorkspaceDiff({ key, window: { kind: 'rows', offset: 0, limit: 501 } }))).toBe('InvalidArgument');
    const unchanged = await unwrap(ipc.getWorkspaceDiff({ key, window: { kind: 'unchanged', line: 1, count: 3 } }));
    expect(unchanged.content.kind === 'text' && unchanged.content.text.window.map((row) => row.kind)).toEqual(['context', 'context', 'context']);
    expect(await failure(ipc.getWorkspaceDiff({ key, window: { kind: 'unchanged', line: 1, count: 5 } }))).toBe('InvalidArgument');
  });

  it('shows every empty and blocked state as content, not as an error', async () => {
    install('diffs');
    const contentAt = async (path: string): Promise<Diff['content']> =>
      (await unwrap(ipc.getWorkspaceDiff({ key: (await itemAt(path)).key, window: ROWS }))).content;
    const word = await contentAt('Fall 2026/线性代数/习题/习题 2.docx');
    expect(word.kind === 'word' && word.text.changes).toBe(0);
    const endings = await contentAt(WEEK2);
    expect(endings.kind === 'text' && endings.text.lineEndings).toEqual({ before: 'crlf', after: 'lf' });
    expect((await contentAt('Fall 2026/CSC148 Introduction to Computer Science/a1/starter/test_tree.py')).kind).toBe('binary');
    expect((await contentAt('Winter 2026/PHY131 Introduction to Physics I/Kinematics.md')).kind).toBe('tooLarge');
    expect((await contentAt('Personal/Todo.txt')).kind).toBe('notStored');
    expect((await contentAt('Fall 2026/CSC148 Introduction to Computer Science/README.md')).kind).toBe('notLocal');
    expect(await contentAt(`${MAT}/第3章 偏导数.md`)).toMatchObject({ kind: 'unreadable', error: { code: 'InUse' } });
    const deleted = await contentAt(`${MAT}/Old notes.md`);
    expect(deleted.kind === 'text' && deleted.text.window.every((row) => row.kind === 'removed')).toBe(true);
  });

  it('says a move without edits is the same content, and a folder has nothing to compare', async () => {
    install();
    const moved = await itemAt(`${MAT}/Problem sets/ps2 solutions.md`);
    expect((await unwrap(ipc.getWorkspaceDiff({ key: moved.key, window: ROWS }))).content).toEqual({ kind: 'same' });
    const folder = (await items()).find((entry) => entry.kind === 'folder');
    expect((await unwrap(ipc.getWorkspaceDiff({ key: folder?.key ?? '', window: ROWS }))).content).toEqual({ kind: 'folder' });
    const png = await itemAt('Fall 2026/ECO101 微观经济学/Supply and demand.png');
    expect((await unwrap(ipc.getWorkspaceDiff({ key: png.key, window: ROWS }))).content).toEqual({ kind: 'notStored' });
  });

  it("shows a commit's change against its parent, and metadata as data", async () => {
    install();
    const version = await versionOf(REVIEW);
    const diff = await unwrap(ipc.getVersionDiff({ commit: version.commit.id, key: version.change.key, window: ROWS }));
    expect(diff.after?.commit).toBe(version.commit.id);
    expect(diff.before?.commit).toBe(version.commit.parent);
    const tags = (await unwrap(ipc.listMetadataChanges({ page: PAGE }))).items.find((row) => row.subject.kind === 'tags');
    const meta = await unwrap(ipc.getWorkspaceDiff({ key: tags?.key ?? '', window: ROWS }));
    expect(meta.content).toMatchObject({ kind: 'metadata', detail: { kind: 'tags' } });
  });
});

describe('restore', () => {
  it('plans before it restores: replace, unchanged, and the Recycle Bin for uncommitted changes', async () => {
    install();
    const older = await versionOf(REVIEW, 1);
    const plan = await unwrap(ipc.planRestore({ commit: older.commit.id, path: older.change.path }));
    expect(plan).toMatchObject({ outcome: 'replace', target: REVIEW, recycle: true, current: { path: REVIEW } });
    const week2 = await versionOf(WEEK2);
    expect(await unwrap(ipc.planRestore({ commit: week2.commit.id, path: WEEK2 }))).toMatchObject({ outcome: 'unchanged' });
    expect(await failure(ipc.restoreVersion({ commit: week2.commit.id, path: WEEK2 }))).toBe('Unchanged');
    const first = await versionOf(WEEK2, 1);
    expect(await unwrap(ipc.planRestore({ commit: first.commit.id, path: WEEK2 }))).toMatchObject({ outcome: 'replace', recycle: false });
  });

  it('restores a version as a new change and logs it', async () => {
    install();
    const history = collect<HistoryChanged>(shellEvents.onHistoryChanged);
    const older = await versionOf(WEEK2, 1);
    expect(await unwrap(ipc.restoreVersion({ commit: older.commit.id, path: WEEK2 }))).toEqual({ target: WEEK2, recycled: false });
    expect((await itemAt(WEEK2)).change).toBe('modified');
    const page = await unwrap(ipc.listHistory({ page: PAGE, types: ['restore'] }));
    expect(page.items[0]).toMatchObject({ kind: 'restore', target: WEEK2, path: WEEK2 });
    await settle();
    expect(history.seen.length).toBeGreaterThan(0);
  });

  it("leaves no change when it restores HEAD's content over uncommitted edits", async () => {
    install();
    const head = await versionOf(REVIEW);
    expect(await unwrap(ipc.planRestore({ commit: head.commit.id, path: REVIEW }))).toMatchObject({ outcome: 'replace', recycle: true });
    await unwrap(ipc.restoreVersion({ commit: head.commit.id, path: REVIEW }));
    expect((await items()).some((entry) => entry.path === REVIEW)).toBe(false);
  });

  it('recreates a deleted file, and refuses versions that are not kept', async () => {
    const fake = install();
    const version = await versionOf(WEEK2);
    fake.deleteFile(WEEK2);
    expect(await unwrap(ipc.planRestore({ commit: version.commit.id, path: WEEK2 }))).toMatchObject({ outcome: 'recreate', target: WEEK2, current: null });
    await unwrap(ipc.restoreVersion({ commit: version.commit.id, path: WEEK2 }));
    expect(fake.library.at(WEEK2)?.kind).toBe('file');
    const lecture = (await commits()).find((commit) => commit.summary?.includes('lecture 12'));
    const pdf = `${MAT}/Lectures/Lecture 12.pdf`;
    expect(await failure(ipc.planRestore({ commit: lecture?.id ?? '', path: pdf }))).toBe('NotStored');
    expect(await failure(ipc.planRestore({ commit: lecture?.id ?? '', path: '.folio/tags.json' }))).toBe('InvalidArgument');
  });

  it('fails as the URL asks', async () => {
    install('small', { failures: [{ command: 'restore_version', code: 'NotRecyclable' }] });
    const older = await versionOf(WEEK2, 1);
    expect(await failure(ipc.restoreVersion({ commit: older.commit.id, path: WEEK2 }))).toBe('NotRecyclable');
  });

  it("finds a version's file after it moved", async () => {
    install();
    const page = await unwrap(ipc.listHistory({ page: PAGE, types: ['commit'] }));
    const first = page.items.at(-1);
    if (first?.kind !== 'commit') throw new Error('no first commit');
    const row = await unwrap(ipc.locateVersion({ commit: first.commit.id, path: `${MAT}/ps2 solutions.md` }));
    expect(row?.path).toBe(`${MAT}/Problem sets/ps2 solutions.md`);
    expect(await unwrap(ipc.locateVersion({ commit: first.commit.id, path: `${MAT}/Old slides L2.pdf` }))).toBeNull();
  });
});

describe('AI', () => {
  it('never sends the key back, and an endpoint on another origin deletes it', async () => {
    install();
    const seen: unknown[] = [];
    const events = collect<AiSettingsChanged>(shellEvents.onAiSettingsChanged);
    seen.push(await unwrap(ipc.setAiKey({ key: '  sk-secret-123  ' })));
    seen.push(await unwrap(ipc.getAiSettings()));
    const moved = await unwrap(ipc.updateAiSettings({ enabled: null, endpoint: 'https://example.com/v1/', model: null, sendContent: null }));
    seen.push(moved);
    expect(moved).toMatchObject({ endpoint: 'https://example.com/v1', hasKey: false });
    await settle();
    seen.push(...events.seen);
    expect(JSON.stringify(seen)).not.toContain('sk-secret');
  });

  it('asks before it stores a key for another service', async () => {
    install('small', { confirm: 'cancel' });
    await unwrap(ipc.updateAiSettings({ enabled: null, endpoint: 'https://example.com', model: null, sendContent: null }));
    expect(await unwrap(ipc.setAiKey({ key: 'sk-other' }))).toBeNull();
    expect((await unwrap(ipc.getAiSettings())).hasKey).toBe(false);
    shell?.dispose();
    install('small', { confirm: 'allow' });
    await unwrap(ipc.updateAiSettings({ enabled: null, endpoint: 'https://example.com', model: null, sendContent: null }));
    expect(await unwrap(ipc.setAiKey({ key: 'sk-other' }))).toMatchObject({ hasKey: true });
  });

  it('checks typed settings', async () => {
    install();
    const update = (endpoint: string | null, model: string | null) =>
      failure(ipc.updateAiSettings({ enabled: null, endpoint, model, sendContent: null }));
    expect(await update('http://api.deepseek.com', null)).toBe('AiEndpointInvalid');
    expect(await update('https://user@api.deepseek.com', null)).toBe('AiEndpointInvalid');
    expect(await update('https://api.deepseek.com?x=1', null)).toBe('AiEndpointInvalid');
    expect(await update(null, 'deepseek chat')).toBe('AiModelInvalid');
    expect(await failure(ipc.setAiKey({ key: 'sk\nsecret' }))).toBe('AiKeyInvalid');
    expect(await failure(ipc.setAiKey({ key: 'x'.repeat(LIMITS.aiKeyChars + 1) }))).toBe('AiKeyInvalid');
  });

  it('writes a valid message, stops on request, and runs one generation at a time', async () => {
    install('small', { aiDelayMs: 20 });
    const { fingerprint } = await unwrap(ipc.getWorkspace());
    const request = (requestId: string) => ipc.generateCommitMessage({ requestId, selection: ALL, fingerprint, description: '' });
    const message = await unwrap(request('a'));
    expect(message?.summary).toMatch(/^[A-Z]{3}\d{3}: update \d+ files/);
    expect(charCount(message?.summary ?? '')).toBeLessThanOrEqual(LIMITS.summaryChars);
    const stopped = request('b');
    await unwrap(ipc.cancelAiRequest({ requestId: 'b' }));
    expect(await unwrap(stopped)).toBeNull();
    const older = request('c');
    const newer = request('d');
    expect(await unwrap(older)).toBeNull();
    expect(await unwrap(newer)).not.toBeNull();
    await unwrap(ipc.cancelAiRequest({ requestId: 'never-started' }));
    expect(await failure(request('bad id!'))).toBe('InvalidArgument');
  });

  it('fails as the fake service is set to, and needs a key and AI on', async () => {
    install('small', { aiMode: 'rateLimited' });
    const { fingerprint } = await unwrap(ipc.getWorkspace());
    expect(await failure(ipc.generateCommitMessage({ requestId: 'r', selection: ALL, fingerprint, description: '' }))).toBe('AiRateLimited');
    expect(await failure(ipc.testAi())).toBe('AiRateLimited');
    shell?.dispose();
    install('ai-off');
    expect(await failure(ipc.generateCommitMessage({ requestId: 'r', selection: ALL, fingerprint, description: '' }))).toBe('AiNotConfigured');
    expect(await failure(ipc.testAi())).toBe('AiNotConfigured');
  });
});

describe('helpers', () => {
  it('builds version URLs and short ids', () => {
    const hash = `b3:${'ab'.repeat(32)}`;
    expect(versionUrl({ hash }, '第3章 偏导数.md')).toBe(
      `http://folio-file.localhost/version/${'ab'.repeat(32)}/${encodeURIComponent('第3章 偏导数.md')}`,
    );
    expect(shortId(hash)).toBe('abababa');
  });
});
