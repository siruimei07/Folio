import i18n from 'i18next';
import { useEffect, useMemo, useRef } from 'react';

import { useCancelJob, useJobs } from '../../data/jobs';
import { useProblemsTotal } from '../../data/problems';
import { useLibraryId } from '../../data/session';
import type { Job } from '../../ipc';
import { isActiveJob } from '../../lib/jobs';
import { showFailure, whenSettled } from '../feedback';
import { openDialog, useCanOpenDialog } from '../navigation';
import type { ToolbarControlProps } from '../registry';
import { Activity } from './Activity';
import { ImportToasts } from './ImportToasts';
import { noteFinished, noteScanned, useJobNotes } from './notes';
import type { ActivityJob } from './status';

/** Notes when each job that was active ends, for the popover's times. */
function useFinishTimes(jobs: readonly Job[]): void {
  const active = useRef<ReadonlySet<string>>(new Set());
  useEffect(() => {
    const ended = jobs.filter((job) => !isActiveJob(job) && active.current.has(job.id)).map((job) => job.id);
    if (ended.length > 0) noteFinished(ended, Date.now());
    active.current = new Set(jobs.filter(isActiveJob).map((job) => job.id));
  }, [jobs]);
}

/** Cancels a job; a job that ended meanwhile (`NotFound`) needs no word. */
export function cancelWithFeedback(mutate: (id: string) => Promise<unknown>, job: Job): void {
  whenSettled(mutate(job.id), 'activity.cancel', () => undefined, (failure) => {
    if (failure.error.code === 'NotFound') return;
    const task = i18n.t(`shell:activity.task.${job.kind}`);
    showFailure(i18n.t('shell:activity.cancelFailed', { task }), failure.error, 'activity.cancel');
  });
}

/**
 * The activity button wired to the library's jobs and problems (library-actions handoff §10):
 * `list_jobs` and JobChanged through the data layer, the problem count once a scan has finished,
 * the destinations of the imports and the changes of the commits the UI started, and "Details"
 * for an import's result.
 */
export function ActivityControl({ compact }: ToolbarControlProps) {
  const jobs = useJobs().data;
  const problemsTotal = useProblemsTotal().data;
  const libraryId = useLibraryId();
  const imports = useJobNotes((state) => state.imports);
  const commits = useJobNotes((state) => state.commits);
  const finishedAt = useJobNotes((state) => state.finishedAt);
  const seenScan = useJobNotes((state) => libraryId !== null && state.scanned.has(libraryId));
  const cancelJob = useCancelJob();
  const canViewProblems = useCanOpenDialog('problems');
  const list = useMemo(() => jobs ?? [], [jobs]);
  useFinishTimes(list);

  const items = useMemo(
    () =>
      list.map((job): ActivityJob => {
        const note = imports[job.id];
        return { job, target: note?.label, files: note?.files, changes: commits[job.id], finishedAt: finishedAt[job.id] };
      }),
    [list, imports, commits, finishedAt],
  );
  // The problems of the last scan: none to show before a scan has finished. A finished scan is
  // remembered, since `list_jobs` keeps only the last 20 finished jobs.
  const scanDone = list.some((job) => job.kind === 'scan' && job.status.state === 'done');
  useEffect(() => {
    if (scanDone && libraryId !== null) noteScanned(libraryId);
  }, [scanDone, libraryId]);
  const scanned = scanDone || seenScan;

  return (
    <>
      <ImportToasts />
      <Activity
        jobs={items}
        problems={scanned ? (problemsTotal ?? null) : null}
        compact={compact}
        onCancel={(job) => {
          cancelWithFeedback((id) => cancelJob.mutateAsync(id), job);
        }}
        onDetails={(job) => {
          openDialog('importResult', { job, target: imports[job.id]?.label });
        }}
        onViewProblems={
          canViewProblems
            ? () => {
                openDialog('problems');
              }
            : undefined
        }
      />
    </>
  );
}
