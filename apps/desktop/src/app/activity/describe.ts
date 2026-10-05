// The words for each job and for the activity button (library-actions handoff §10.1, §10.2, §5).

import type { TFunction } from 'i18next';

import type { JobResult } from '../../ipc';
import { formatMoment } from '../../lib/format';
import { type ActivityJob, type ActivityStatus, endedWithProblems, importResultOf, jobPercent } from './status';

/** `t` of `useTranslation(['shell', 'errors'])`. */
export type ShellT = TFunction<['shell', 'errors']>;

/** How a job's row looks: its icon and colour, and the texts. */
export type JobLook = 'running' | 'queued' | 'success' | 'warning' | 'danger' | 'cancelled';

export interface JobRow {
  look: JobLook;
  title: string;
  meta: string | null;
  /** Running only: the bar's value, `null` while unknown. */
  percent: number | null;
  /** Running only: the file or entry in progress. */
  current: string | null;
  /** Finished only, when known: "5:12 PM" today, "Sep 27" before. */
  time: string | null;
  /** The cancel button's label, when the job can be cancelled. */
  cancelLabel: string | null;
  /** Whether "Details" opens the result dialog (imports that left files out or failed). */
  hasDetails: boolean;
}

function importTitle(t: ShellT, total: number | null, target: string | undefined): string {
  if (total === null) {
    return target === undefined ? t('activity.runningTitle.import') : t('activity.runningTitle.importTo', { target });
  }
  return target === undefined
    ? t('activity.runningTitle.importCount', { count: total })
    : t('activity.runningTitle.importCountTo', { count: total, target });
}

function doneTexts(t: ShellT, result: JobResult, target: string | undefined): { title: string; meta: string | null } {
  switch (result.kind) {
    case 'scan':
      return {
        title: t('activity.doneTitle.scan'),
        meta:
          result.changes === 0 && result.problems === 0
            ? t('activity.doneMeta.scanNoChanges')
            : t('activity.doneMeta.scan', {
                changes: t('activity.doneMeta.scanChanges', { count: result.changes }),
                problems: t('activity.doneMeta.scanProblems', { count: result.problems }),
              }),
      };
    case 'hash':
      return {
        title: t('activity.doneTitle.hash', { count: result.hashed }),
        meta:
          result.deferred > 0
            ? t('activity.doneMeta.hashDeferred', { count: result.deferred })
            : t('activity.doneMeta.hash'),
      };
    case 'import': {
      // `imported` includes replaced and renamed files (library-actions open item 2).
      if (result.failureCount > 0) {
        const values = { count: result.imported, total: result.imported + result.failureCount };
        return {
          title:
            target === undefined
              ? t('activity.doneTitle.importPartial', values)
              : t('activity.doneTitle.importPartialTo', { ...values, target }),
          meta: t('activity.doneMeta.importFailed', { count: result.failureCount }),
        };
      }
      const parts = [
        ...(result.replaced > 0 ? [t('activity.doneMeta.importReplaced', { count: result.replaced })] : []),
        ...(result.renamed > 0 ? [t('activity.doneMeta.importRenamed', { count: result.renamed })] : []),
        ...(result.skipped > 0 ? [t('activity.doneMeta.importSkipped', { count: result.skipped })] : []),
        ...(result.originalsDeleted > 0 ? [t('activity.doneMeta.importOriginalsDeleted')] : []),
      ];
      return {
        title:
          target === undefined
            ? t('activity.doneTitle.import', { count: result.imported })
            : t('activity.doneTitle.importTo', { count: result.imported, target }),
        meta: parts.length === 0 ? null : parts.join(' · '),
      };
    }
    case 'rebuild':
      return {
        title: t('activity.doneTitle.rebuild'),
        meta: t('activity.doneMeta.rebuild', { count: result.entries }),
      };
    // The commit jobs (ipc-m2 §13; workspace-history handoff §4.4, §10).
    case 'commit':
      return { title: t('activity.doneTitle.commit', { count: result.changes }), meta: result.summary };
    case 'firstCommit':
      return { title: t('activity.doneTitle.firstCommit'), meta: t('activity.doneMeta.firstCommit', { count: result.files }) };
  }
}

/** One row of the Activity popover. `now` and `language` place the finish time. */
export function describeJob(t: ShellT, { job, target, files, finishedAt }: ActivityJob, now: number, language: string): JobRow {
  const { kind, status } = job;
  const time = finishedAt === undefined ? null : formatMoment(finishedAt, now, language);
  const cancelLabel = job.cancellable ? t(`activity.cancel.${kind}`) : null;
  const base = { percent: null, current: null, time: null, cancelLabel: null, hasDetails: false };
  switch (status.state) {
    case 'queued':
      return {
        ...base,
        look: 'queued',
        title: kind === 'import' ? importTitle(t, null, target) : t(`activity.runningTitle.${kind}`),
        meta: t(`activity.queued.${kind}`),
        cancelLabel,
      };
    case 'running': {
      const { done, total, current } = status.progress;
      const title = kind === 'import' ? importTitle(t, total, target) : t(`activity.runningTitle.${kind}`);
      const meta =
        kind === 'rebuild'
          ? t('activity.runningMeta.rebuild', { done })
          : total === null
            ? t(`activity.runningMeta.${kind}SoFar`, { done })
            : t(`activity.runningMeta.${kind}`, { done, total });
      return { ...base, look: 'running', title, meta, percent: jobPercent(job), current, cancelLabel };
    }
    case 'done': {
      const texts = doneTexts(t, status.result, target);
      return { ...base, ...texts, look: endedWithProblems(job) ? 'warning' : 'success', time, hasDetails: endedWithProblems(job) };
    }
    case 'failed':
      return {
        ...base,
        look: 'danger',
        title:
          kind === 'import' && target !== undefined
            ? t('activity.failedTitle.importTo', { target })
            : t(`activity.failedTitle.${kind}`),
        meta: t(`errors:${status.error.code}`),
        time,
        hasDetails: kind === 'import',
      };
    case 'cancelled': {
      // An import that had started says how far it got (ipc-m1 §13).
      const result = importResultOf(job);
      return {
        ...base,
        look: 'cancelled',
        title:
          kind === 'import' && target !== undefined
            ? t('activity.cancelledTitle.importTo', { target })
            : t(`activity.cancelledTitle.${kind}`),
        meta:
          result === null
            ? null
            : files === undefined
              ? t('activity.cancelledMeta.importSoFar', { count: result.imported })
              : t('activity.cancelledMeta.import', { count: result.imported, total: files }),
        time,
        hasDetails: endedWithProblems(job),
      };
    }
  }
}

/** The activity button's visible label and its accessible name with the whole status. */
export function describeStatus(t: ShellT, status: ActivityStatus): { label: string; aria: string } | null {
  /** The accessible name for one job, with the problem count when there are problems. */
  const oneJob = (
    key: 'waiting' | 'running' | 'runningUnknown',
    values: { task: string; percent?: number },
    problems: number,
  ) =>
    problems > 0
      ? t(`activity.aria.${key}WithProblems`, { ...values, count: problems })
      : t(`activity.aria.${key}`, values);
  switch (status.kind) {
    case 'hidden':
      return null;
    case 'waiting':
      return {
        label: t('activity.waiting'),
        aria: oneJob('waiting', { task: t(`activity.task.${status.jobKind}`) }, status.problems),
      };
    case 'running': {
      const task = t(`activity.task.${status.jobKind}`);
      const { percent } = status;
      return percent === null
        ? {
            label: t(`activity.runningUnknown.${status.jobKind}`),
            aria: oneJob('runningUnknown', { task }, status.problems),
          }
        : {
            label: t(`activity.running.${status.jobKind}`, { percent }),
            aria: oneJob('running', { task, percent }, status.problems),
          };
    }
    case 'several':
      return {
        label: t('activity.several', { count: status.count }),
        aria:
          status.problems > 0
            ? t('activity.aria.severalWithProblems', { tasks: status.count, count: status.problems })
            : t('activity.aria.several', { count: status.count }),
      };
    case 'done':
      return status.withProblems
        ? { label: t('activity.doneWithProblems'), aria: t('activity.aria.doneWithProblems') }
        : { label: t('activity.done'), aria: t('activity.aria.done') };
    case 'problems':
      return {
        label: t('activity.problems', { count: status.count }),
        aria: t('activity.aria.problems', { count: status.count }),
      };
  }
}
