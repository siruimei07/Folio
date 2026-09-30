// Library jobs (ipc-m1 §13): shared by the data layer's job cache and the activity button.

import type { Job } from '../ipc';

/** Queued or running: not yet done, failed or cancelled. */
export function isActiveJob(job: Pick<Job, 'status'>): boolean {
  return job.status.state === 'queued' || job.status.state === 'running';
}
