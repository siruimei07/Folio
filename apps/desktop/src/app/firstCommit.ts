// The library's first commit (workspace-history handoff §10; ipc-m2 §6.1, §7.1; versioning §7.7):
// what the Changes and History views show while the history has not started, and the start
// itself. Folio starts it by itself once per library session: the always-on control that calls
// `useAutoStartFirstCommit` (the Changes rail badge, mounted while the shell is) asks for it as
// soon as the workspace says `none`, and the shell queues the job until the first scan and hashing
// have finished, so the activity popover lists it, with Cancel, at once. After a cancel or a
// failure it waits for the person ("Start history", "Try again") or the next opening of the
// library. A start that `HistoryExists` answers is quiet: the history runs or ran already. A
// history too large to keep (`tooLarge`, ipc-m2 §6.1) shows in the same block, in place of all
// of that: Folio itself tries again when the library changes, once per change that ends it.
import i18n from 'i18next';
import { useCallback, useEffect, useEffectEvent, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { create } from 'zustand';

import { useCourses } from '../data/groups';
import { useJobs } from '../data/jobs';
import { followReferences } from '../data/references';
import { useLibraryId } from '../data/session';
import { useStartHistory, useWorkspace } from '../data/workspace';
import type { Course, HistoryState, IpcError, Job, Progress, WorkspaceSummary } from '../ipc';
import { isActiveJob } from '../lib/jobs';
import { placeOf } from '../lib/places';
import { isOlderRevision } from '../lib/revision';
import type { ShellT } from './activity/describe';
import { jobPercent } from './activity/status';
import { announce } from './announcer';
import { whenSettled } from './feedback';

/** What the first commit's block shows (§10). */
export type FirstCommitState =
  /** Before the job runs: asked for, or queued until the scan and hashing finish. */
  | { kind: 'waiting' }
  /**
   * The job reads the files. `percent` and `bytes` are `null` while unknown; `progress` is `null`
   * once the job is done and the workspace has not said so yet (keep showing the last).
   */
  | { kind: 'running'; progress: { percent: number | null; bytes: Progress['bytes'] } | null }
  /** The person cancelled it: "Start history" starts it again. */
  | { kind: 'cancelled' }
  /** The start or the job failed: "Try again". */
  | { kind: 'failed'; error: IpcError }
  /**
   * The history is off: it would be, or is, larger than Folio keeps (`tooLarge`, ipc-m2 §6.1).
   * `folder` is the library path of the folder that holds too many files, `null` for the library
   * as a whole. `retries`: a first commit that was too large, which Folio starts again when the
   * library changes; not for a `HEAD` too large to show, which only another `HEAD` ends.
   */
  | { kind: 'tooLarge'; folder: string | null; retries: boolean };

type TooLarge = Extract<FirstCommitState, { kind: 'tooLarge' }>;

/**
 * The words of the too-large block (ipc-m2 §19 item 5), which Folio also says when a first commit
 * turns out too large: the folder as a place ("MAT232 / Problem sets", app-shell 27B), or the
 * library as a whole; a retry promised only for a first commit.
 */
export function tooLargeText({ folder, retries }: TooLarge, courses: readonly Course[], t: ShellT): string {
  if (folder === null) return t(retries ? 'firstCommit.tooLarge.library' : 'firstCommit.tooLarge.head');
  return t(retries ? 'firstCommit.tooLarge.folder' : 'firstCommit.tooLarge.headFolder', { folder: placeOf(folder, courses) });
}

/**
 * The folder too large for history, from the summary's `tooLargeFolder` or a failed job's `file`:
 * `null` (and the root, `''`) is the library as a whole, and the UI never names `.folio`'s
 * metadata (ipc-m2 §6.1, §13).
 */
export function tooLargeFolderOf(path: string | null): string | null {
  return path === '' ? null : path;
}

/** Whether two too-large blocks say the same: the same folder, and the same promise. */
function sameTooLarge(a: TooLarge | null, b: TooLarge): boolean {
  return a !== null && a.folder === b.folder && a.retries === b.retries;
}

/** The first commit in this library session; another library starts afresh. */
interface FirstCommitSession {
  /** Folio has asked for it by itself: not again until the library opens again (§10). */
  autoStarted: boolean;
  /** The latest start is on its way to the shell. */
  pending: boolean;
  /**
   * The job of the latest start in this session, once the shell has answered, or the first commit
   * the shell was running when the session began.
   */
  job: string | null;
  /** The latest start was refused (any code but `HistoryExists`). */
  error: IpcError | null;
  /**
   * The catalog revision the workspace's summary was read at when that job began (its start, or
   * finding it running); `null` while unknown. `tooLargeEnded` reads it.
   */
  from: number | null;
  /**
   * The too-large block this session showed last. A first commit that ends the same way again
   * (Folio's own retry) has nothing new to say; a start by the person forgets it.
   */
  shown: TooLarge | null;
}

const INITIAL: FirstCommitSession = { autoStarted: false, pending: false, job: null, error: null, from: null, shown: null };

const useFirstCommitSession = create<FirstCommitSession>()(() => INITIAL);

/**
 * The number of the latest start, also counted up by each new library session: only that start's
 * answer is taken. Folio's own retry can go out while an earlier start's answer is on its way (the
 * earlier job failed too large first), and that answer must not take the later start's place.
 */
let latest = 0;

followReferences((update) => {
  if (update.kind !== 'reset') return;
  latest += 1;
  useFirstCommitSession.setState(INITIAL);
});

/**
 * Before the first commit and while it runs. "Your history has started." reads it, not
 * `historyListsNothing`: a history too large to show that turns readable did not start then.
 */
function isHistoryStarting(state: HistoryState | undefined): boolean {
  return state === 'none' || state === 'starting';
}

/**
 * The workspace lists nothing (ipc-m2 §6.1): before the first commit, while it runs, and while the
 * history is too large to keep. The Changes and History views then show the first commit's block
 * in one panel, with no list and no commit box, and the Changes rail button no badge.
 */
export function historyListsNothing(state: HistoryState | undefined): boolean {
  return isHistoryStarting(state) || state === 'tooLarge';
}

/**
 * The first commit's job: the latest start's, or the one the shell was running when the session
 * found it (the window was reloaded while it ran, `useAutoStartFirstCommit`).
 */
function firstCommitJob(jobs: readonly Job[] | undefined, id: string | null): Job | undefined {
  return id === null ? undefined : jobs?.find((job) => job.id === id);
}

/**
 * Whether a change has ended the `tooLarge` of the session's first commit (ipc-m2 §6.1), read from
 * what holds now rather than from a move of the state the UI may never see: each WorkspaceChanged
 * cancels the summary's fetch under way (`data/events.ts`), so a job's failure and a change that
 * ends its `tooLarge` at once can reach the UI as `starting` → `none`. Its job failed with
 * `HistoryTooLarge`, no start is on its way (`useAutoStartFirstCommit` asks again when its answer
 * arrives), and the workspace says `none` at a later catalog revision than when the job began: a
 * summary the UI held from before is not taken for one.
 */
function tooLargeEnded(
  { pending, job: id, from }: FirstCommitSession,
  jobs: readonly Job[] | undefined,
  summary: WorkspaceSummary | undefined,
): boolean {
  const job = firstCommitJob(jobs, id);
  if (pending || job?.status.state !== 'failed' || job.status.error.code !== 'HistoryTooLarge') return false;
  return summary?.historyState === 'none' && (from === null || isOlderRevision(from, summary.revision));
}

/** What `firstCommitOf` reads of the workspace's summary. */
export type FirstCommitSummary = Pick<WorkspaceSummary, 'historyState' | 'tooLargeFolder' | 'head'>;

/**
 * The block's state from the workspace's summary (`undefined` until it is known), the job and this
 * session's start. `tooLarge` comes first: the job and the start that led to it are over. A job
 * that failed with `HistoryTooLarge` while the state is not `tooLarge` shows as waiting, never as
 * "Couldn't start your history" with "Try again": its failure can arrive before the summary that
 * says `tooLarge`, and stays the session's job once a change has ended that state.
 */
export function firstCommitOf(
  summary: FirstCommitSummary | undefined,
  job: Job | undefined,
  { pending, error }: Pick<FirstCommitSession, 'pending' | 'error'>,
): FirstCommitState | null {
  if (summary?.historyState === 'tooLarge') {
    return { kind: 'tooLarge', folder: tooLargeFolderOf(summary.tooLargeFolder), retries: summary.head === null };
  }
  if (!isHistoryStarting(summary?.historyState)) return null;
  if (pending) return { kind: 'waiting' };
  if (error !== null) return { kind: 'failed', error };
  switch (job?.status.state) {
    case undefined:
    case 'queued':
      return { kind: 'waiting' };
    case 'running':
      return { kind: 'running', progress: { percent: jobPercent(job), bytes: job.status.progress.bytes } };
    case 'done':
      return { kind: 'running', progress: null };
    case 'failed':
      return job.status.error.code === 'HistoryTooLarge' ? { kind: 'waiting' } : { kind: 'failed', error: job.status.error };
    case 'cancelled':
      return { kind: 'cancelled' };
  }
}

/**
 * What the first commit's block shows, or `null` once the history has started (or while the
 * workspace has not said). Re-renders with the job's progress: for the block only.
 */
export function useFirstCommit(): FirstCommitState | null {
  const summary = useWorkspace().data;
  const { pending, error, job: id } = useFirstCommitSession();
  const job = firstCommitJob(useJobs().data, id);
  return firstCommitOf(summary, job, { pending, error });
}

/**
 * Starts the first commit (`start_history` with "Start history", read in English: the summary is
 * stored in the history and synced, versioning §8.1), by the person or by Folio itself. The block
 * shows how it goes. A start by the person is one they watch, so what it ends in is said even when
 * the block showed the same before (`shown`).
 */
function useStart(): (by: 'person' | 'folio') => void {
  const { mutateAsync } = useStartHistory();
  const revision = useWorkspace().data?.revision ?? null;
  return useCallback(
    (by: 'person' | 'folio') => {
      latest += 1;
      const sent = latest;
      useFirstCommitSession.setState(({ shown }) => ({
        pending: true,
        job: null,
        error: null,
        from: revision,
        shown: by === 'person' ? null : shown,
      }));
      whenSettled(
        mutateAsync(i18n.getFixedT('en', 'shell')('firstCommit.summary')),
        'firstCommit.start',
        (job) => {
          if (sent === latest) useFirstCommitSession.setState({ pending: false, job });
        },
        (failure) => {
          if (sent !== latest) return;
          const { error } = failure;
          useFirstCommitSession.setState({ pending: false, error: error.code === 'HistoryExists' ? null : error });
        },
      );
    },
    [mutateAsync, revision],
  );
}

/** The person's start of the first commit: "Start history" and "Try again" in the block. */
export function useStartFirstCommit(): () => void {
  const start = useStart();
  return useCallback(() => {
    start('person');
  }, [start]);
}

/** A session with no start on its way and none refused: what a state of the workspace alone shows. */
const IDLE = { pending: false, error: null } as const;

/**
 * Folio's own start of the first commit (§10), for the always-on control: once per library
 * session, as soon as the workspace says the history has none, and once more each time a change
 * to the library ends a first commit's `tooLarge` (ipc-m2 §6.1). What became of a first commit
 * is said once, politely (WCAG 4.1.3): "Your history has started." once the workspace says it has,
 * after it said it had none; the too-large block's title and words once it says the history is too
 * large, unless the block showed the same in this session before: Folio's own retry that ends as
 * the last one did has nothing new to say, wherever the person is. A library that opens too large
 * says nothing: the block shows it.
 */
export function useAutoStartFirstCommit(): void {
  const { t } = useTranslation(['shell', 'errors']);
  const libraryId = useLibraryId();
  const summary = useWorkspace().data;
  const historyState = summary?.historyState;
  const autoStarted = useFirstCommitSession((state) => state.autoStarted);
  // An answer can come after the start's job failed too large and a change ended that (events
  // overtake answers, ui-architecture §5.4): `tooLargeEnded` waits for it, so its arrival runs the
  // effect again.
  const pending = useFirstCommitSession((state) => state.pending);
  const start = useStart();
  const jobs = useJobs().data;
  const courses = useCourses().data;
  const revisionNow = useEffectEvent(() => summary?.revision ?? null);
  // A session that finds the shell running a first commit it did not start (the window was
  // reloaded while it ran) takes it as its own: a cancel then shows as one, and Folio does not
  // start it again by itself until the library opens again.
  useEffect(() => {
    if (jobs === undefined || useFirstCommitSession.getState().job !== null) return;
    const running = jobs.find((job) => job.kind === 'firstCommit' && isActiveJob(job));
    if (running !== undefined) useFirstCommitSession.setState({ job: running.id, autoStarted: true, from: revisionNow() });
  }, [jobs]);

  // What became of a first commit, said with the words the block shows now, which name the folder
  // as the courses do. A too-large block is noted as shown in any case, also when nothing is said.
  const tell = useEffectEvent((before: HistoryState | undefined) => {
    if (historyState === 'ready') {
      // Held: the first row's diff, selected as the list shows, must not take its place.
      if (isHistoryStarting(before)) announce(t('firstCommit.started'), 'polite', { hold: true });
      return;
    }
    const block = firstCommitOf(summary, undefined, IDLE);
    if (block?.kind !== 'tooLarge' || sameTooLarge(useFirstCommitSession.getState().shown, block)) return;
    useFirstCommitSession.setState({ shown: block });
    if (isHistoryStarting(before)) {
      const text = tooLargeText(block, courses ?? [], t);
      announce(t('firstCommit.tooLarge.said', { title: t('firstCommit.tooLarge.title'), text }));
    }
  });

  // The history's state when the effect last ran, in the library it belonged to. One effect starts
  // and says, so a run that sees no change of state (StrictMode's second run, a new `start`, a job's
  // progress, `autoStarted` turning true) neither starts again nor says anything new; a new session
  // (`autoStarted` back to false, a reload) starts at `none` as an opening library does.
  const last = useRef({ libraryId, state: historyState });
  useEffect(() => {
    const before = last.current;
    last.current = { libraryId, state: historyState };
    const sameLibrary = before.libraryId === libraryId;
    // Read from the store, not the render: StrictMode runs a new effect twice with one render's values.
    const now = useFirstCommitSession.getState();
    // A change ended a first commit too large to keep: Folio tries again (ipc-m2 §6.1), whether or
    // not the UI read the `tooLarge` before the `none`.
    const retry = (sameLibrary && before.state === 'tooLarge') || tooLargeEnded(now, jobs, summary);
    if (historyState === 'none' && (retry || !now.autoStarted)) {
      useFirstCommitSession.setState({ autoStarted: true });
      start('folio');
    }
    tell(sameLibrary ? before.state : undefined);
  }, [libraryId, historyState, summary, jobs, autoStarted, pending, start]);
}
