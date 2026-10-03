// What the activity button and popover show for the library's jobs and the last scan's problems
// (library-actions handoff §10). Pure: the jobs come from `list_jobs` and `JobChanged`, wired by
// the data layer's hooks; `useActivityStatus` adds the 10 s after the last job ends.

import type { ImportResult, Job, JobKind } from '../../ipc';
import { percentOf } from '../../lib/format';
import { isActiveJob } from '../../lib/jobs';

/** A job as the popover shows it, with what the UI knows beyond the contract. */
export interface ActivityJob {
  job: Job;
  /**
   * An import's destination as a course label ("MAT232", "MAT232 / Problem sets"), when the UI
   * started it. `Job` does not carry it, so after a reload imports show without it.
   */
  target?: string;
  /** The files an import the UI started set out to add (`check_import`), for "7 of 12". */
  files?: number;
  /** When the UI saw the job end; `Job` has no time, so older jobs show none. */
  finishedAt?: number;
}

export type ActivityStatus =
  | { kind: 'hidden' }
  /** One job, still waiting for another to finish. */
  | { kind: 'waiting'; jobKind: JobKind; problems: number }
  /** One job running: its percentage, or `null` while the total is unknown. */
  | { kind: 'running'; jobKind: JobKind; percent: number | null; problems: number }
  | { kind: 'several'; count: number; problems: number }
  /** The last job ended less than 10 s ago. */
  | { kind: 'done'; withProblems: boolean }
  | { kind: 'problems'; count: number };

/** The import result a job carries: done, or cancelled after it started; `null` otherwise. */
export function importResultOf(job: Job): ImportResult | null {
  const { status } = job;
  if ((status.state === 'done' || status.state === 'cancelled') && status.result?.kind === 'import') return status.result;
  return null;
}

/** Failed, or an import that left some files out: "Done with problems". */
export function endedWithProblems(job: Job): boolean {
  return job.status.state === 'failed' || (importResultOf(job)?.failureCount ?? 0) > 0;
}

/** The share done, from `permille` when the job measures bytes, else files; `null` when unknown. */
export function jobPercent(job: Job): number | null {
  if (job.status.state !== 'running') return null;
  const { done, total, permille } = job.status.progress;
  if (permille !== null) return Math.min(Math.floor(permille / 10), 100);
  return total === null ? null : percentOf(done, total);
}

/**
 * The button's state. `lingering` holds the jobs that ended in the last 10 s, while none is
 * active; `problems` is the last scan's count, `null` before a scan has finished.
 */
export function activityStatus(
  jobs: readonly Job[],
  problems: number | null,
  lingering: readonly Job[] | null,
): ActivityStatus {
  const active = jobs.filter(isActiveJob);
  const problemCount = problems ?? 0;
  const [only] = active;
  if (only && active.length === 1) {
    return only.status.state === 'queued'
      ? { kind: 'waiting', jobKind: only.kind, problems: problemCount }
      : { kind: 'running', jobKind: only.kind, percent: jobPercent(only), problems: problemCount };
  }
  if (active.length > 1) return { kind: 'several', count: active.length, problems: problemCount };
  if (lingering !== null) return { kind: 'done', withProblems: lingering.some(endedWithProblems) };
  if (problemCount > 0) return { kind: 'problems', count: problemCount };
  return { kind: 'hidden' };
}
