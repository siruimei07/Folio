// Jobs (docs/specs/ipc-m1.md §13; ui-architecture §5.6): `list_jobs` fills the cache once, then
// each JobChanged replaces its job there. JobChanged carries the whole job, so nothing refetches.
import { type QueryClient, useMutation, useQuery } from '@tanstack/react-query';

import { ipc, type Job } from '../ipc';
import { isActiveJob } from '../lib/jobs';
import { unwrap } from './errors';
import { keys, libraryQuery } from './keys';
import { useLibraryId } from './session';

/** Finished jobs `list_jobs` keeps after the active ones. */
const FINISHED_KEPT = 20;

/** How far a job has come: a later event never takes it back (queued < running < finished). */
function stage(job: Job): number {
  switch (job.status.state) {
    case 'queued':
      return 0;
    case 'running':
      return 1;
    default:
      return 2;
  }
}

/**
 * The job list after one JobChanged, in `list_jobs` order: active jobs, then the last finished
 * ones, newest first. An event older than what the list holds (it overtook `list_jobs`, or
 * progress arrived out of order) changes nothing.
 */
export function applyJob(jobs: readonly Job[], job: Job): Job[] {
  const index = jobs.findIndex((known) => known.id === job.id);
  const previous = jobs[index];
  if (previous !== undefined) {
    const behind =
      stage(job) < stage(previous) ||
      (job.status.state === 'running' &&
        previous.status.state === 'running' &&
        job.status.progress.done < previous.status.progress.done);
    if (behind) return [...jobs];
    if (isActiveJob(job) === isActiveJob(previous)) return jobs.with(index, job);
  }
  const others = jobs.filter((known) => known.id !== job.id);
  const active = others.filter(isActiveJob);
  const finished = others.filter((known) => !isActiveJob(known));
  return isActiveJob(job)
    ? [...active, job, ...finished]
    : [...active, job, ...finished].slice(0, active.length + FINISHED_KEPT);
}

/** Events that arrive while `list_jobs` runs, replayed on its answer. */
const listing = new Set<Job[]>();

/** Keeps the cached job list current with one JobChanged. */
export function receiveJob(client: QueryClient, libraryId: string, job: Job): void {
  for (const buffer of listing) buffer.push(job);
  client.setQueryData<Job[]>(keys.jobs(libraryId), (jobs) =>
    jobs === undefined ? jobs : applyJob(jobs, job),
  );
}

async function listJobs(): Promise<Job[]> {
  const buffer: Job[] = [];
  listing.add(buffer);
  try {
    const jobs = await unwrap(ipc.listJobs());
    return buffer.reduce(applyJob, jobs);
  } finally {
    listing.delete(buffer);
  }
}

function jobsQuery(libraryId: string | null) {
  return libraryQuery(libraryId, keys.jobs, listJobs);
}

/** The open library's jobs: active ones first, then the last 20 finished. */
export function useJobs() {
  return useQuery(jobsQuery(useLibraryId()));
}

/** One job, while the list holds it. */
export function useJob(id: string | null): Job | undefined {
  const { data } = useQuery({
    ...jobsQuery(useLibraryId()),
    select: (jobs) => jobs.find((job) => job.id === id),
  });
  return data;
}

/** Cancels a queued or running job; its JobChanged updates the list. */
export function useCancelJob() {
  return useMutation({
    mutationFn: (job: string) => unwrap(ipc.cancelJob({ job })),
  });
}

/** "Rebuild search index": starts the rebuild job and resolves to its id. */
export function useRebuildCatalog() {
  return useMutation({
    mutationFn: () => unwrap(ipc.rebuildCatalog()),
  });
}
