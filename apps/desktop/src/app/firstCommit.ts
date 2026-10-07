// The library's first commit (workspace-history handoff §10; ipc-m2 §6.1, §7.1; versioning §7.7):
// what the Changes and History views show while the history has not started, and the start
// itself. Folio starts it by itself once per library session: the always-on control that calls
// `useAutoStartFirstCommit` (the Changes rail badge, mounted while the shell is) asks for it as
// soon as the workspace says `none`, and the shell queues the job until the first scan and hashing
// have finished, so the activity popover lists it, with Cancel, at once. After a cancel or a
// failure it waits for the person ("Start history", "Try again") or the next opening of the
// library. A start that `HistoryExists` answers is quiet: the history runs or ran already.
import i18n from 'i18next';
import { useCallback, useEffect, useRef } from 'react';
import { create } from 'zustand';

import { useJobs } from '../data/jobs';
import { followReferences } from '../data/references';
import { useLibraryId } from '../data/session';
import { useStartHistory, useWorkspace } from '../data/workspace';
import type { HistoryState, IpcError, Job, Progress } from '../ipc';
import { isActiveJob } from '../lib/jobs';
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
  | { kind: 'failed'; error: IpcError };

/** The first commit in this library session; another library starts afresh. */
interface FirstCommitSession {
  /** Folio has asked for it by itself: not again until the library opens again (§10). */
  autoStarted: boolean;
  /** A start is on its way to the shell. */
  pending: boolean;
  /**
   * The job of the latest start in this session, once the shell has answered, or the first commit
   * the shell was running when the session began.
   */
  job: string | null;
  /** The latest start was refused (any code but `HistoryExists`). */
  error: IpcError | null;
}

const INITIAL: FirstCommitSession = { autoStarted: false, pending: false, job: null, error: null };

const useFirstCommitSession = create<FirstCommitSession>()(() => INITIAL);

/** Each library session's number: an answer that arrives in a later one is dropped. */
let session = 0;

followReferences((update) => {
  if (update.kind !== 'reset') return;
  session += 1;
  useFirstCommitSession.setState(INITIAL);
});

/** The workspace lists nothing before the first commit and while it runs (ipc-m2 §6.1). */
export function isHistoryStarting(state: HistoryState | undefined): boolean {
  return state === 'none' || state === 'starting';
}

/**
 * The first commit's job: the latest start's, or the one the shell was running when the session
 * found it (the window was reloaded while it ran, `useAutoStartFirstCommit`).
 */
function firstCommitJob(jobs: readonly Job[] | undefined, id: string | null): Job | undefined {
  return id === null ? undefined : jobs?.find((job) => job.id === id);
}

/** The block's state from the history's state, the job and this session's start. */
export function firstCommitOf(
  historyState: HistoryState | undefined,
  job: Job | undefined,
  { pending, error }: Pick<FirstCommitSession, 'pending' | 'error'>,
): FirstCommitState | null {
  if (!isHistoryStarting(historyState)) return null;
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
      return { kind: 'failed', error: job.status.error };
    case 'cancelled':
      return { kind: 'cancelled' };
  }
}

/**
 * What the first commit's block shows, or `null` once the history has started (or while the
 * workspace has not said). Re-renders with the job's progress: for the block only.
 */
export function useFirstCommit(): FirstCommitState | null {
  const historyState = useWorkspace().data?.historyState;
  const { pending, error, job: id } = useFirstCommitSession();
  const job = firstCommitJob(useJobs().data, id);
  return firstCommitOf(historyState, job, { pending, error });
}

/**
 * Starts the first commit (`start_history` with "Start history", read in English: the summary is
 * stored in the history and synced, versioning §8.1). The block shows how it goes.
 */
export function useStartFirstCommit(): () => void {
  const { mutateAsync } = useStartHistory();
  return useCallback(() => {
    const sent = session;
    useFirstCommitSession.setState({ pending: true, job: null, error: null });
    whenSettled(
      mutateAsync(i18n.getFixedT('en', 'shell')('firstCommit.summary')),
      'firstCommit.start',
      (job) => {
        if (sent === session) useFirstCommitSession.setState({ pending: false, job });
      },
      (failure) => {
        if (sent !== session) return;
        const { error } = failure;
        useFirstCommitSession.setState({ pending: false, error: error.code === 'HistoryExists' ? null : error });
      },
    );
  }, [mutateAsync]);
}

/**
 * Folio's own start of the first commit (§10), for the always-on control: once per library
 * session, as soon as the workspace says the history has none; and "Your history has started."
 * once the workspace says it has, after it said it had none.
 */
export function useAutoStartFirstCommit(): void {
  const libraryId = useLibraryId();
  const historyState = useWorkspace().data?.historyState;
  const autoStarted = useFirstCommitSession((state) => state.autoStarted);
  const start = useStartFirstCommit();
  const jobs = useJobs().data;
  // A session that finds the shell running a first commit it did not start (the window was
  // reloaded while it ran) takes it as its own: a cancel then shows as one, and Folio does not
  // start it again by itself until the library opens again.
  useEffect(() => {
    if (jobs === undefined || useFirstCommitSession.getState().job !== null) return;
    const running = jobs.find((job) => job.kind === 'firstCommit' && isActiveJob(job));
    if (running !== undefined) useFirstCommitSession.setState({ job: running.id, autoStarted: true });
  }, [jobs]);
  useEffect(() => {
    // Read from the store, not the render: StrictMode runs a new effect twice with one render's values.
    if (historyState !== 'none' || useFirstCommitSession.getState().autoStarted) return;
    useFirstCommitSession.setState({ autoStarted: true });
    start();
  }, [historyState, autoStarted, start]);

  // The history's state the last time it changed, in the library it belonged to.
  const last = useRef({ libraryId, state: historyState });
  useEffect(() => {
    const before = last.current;
    last.current = { libraryId, state: historyState };
    if (before.libraryId === libraryId && isHistoryStarting(before.state) && historyState === 'ready') {
      // Held: the first row's diff, selected as the list shows, must not take its place.
      announce(i18n.t('shell:firstCommit.started'), 'polite', { hold: true });
    }
  }, [libraryId, historyState]);
}
