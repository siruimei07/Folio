import { useEffect, useState } from 'react';

import type { Job } from '../../ipc';
import { isActiveJob } from '../../lib/jobs';
import { ACTIVITY_LINGER_MS } from '../../lib/timing';
import { activityStatus, type ActivityStatus } from './status';

/**
 * The activity button's state, which stays on "Done" for 10 s after the last active job ended
 * (library-actions handoff §10.1).
 */
export function useActivityStatus(jobs: readonly Job[], problems: number | null): ActivityStatus {
  const activeIds = jobs
    .filter(isActiveJob)
    .map((job) => job.id)
    .join('\n');
  const [previousIds, setPreviousIds] = useState(activeIds);
  const [endedIds, setEndedIds] = useState<readonly string[] | null>(null);

  // Adjusting state while rendering (React's pattern for reacting to a changed prop): the moment
  // the last active job ends, remember which jobs just ended.
  if (activeIds !== previousIds) {
    setPreviousIds(activeIds);
    setEndedIds(activeIds === '' && previousIds !== '' ? previousIds.split('\n') : null);
  }

  useEffect(() => {
    if (endedIds === null) return undefined;
    const timer = window.setTimeout(() => {
      setEndedIds(null);
    }, ACTIVITY_LINGER_MS);
    return () => {
      window.clearTimeout(timer);
    };
  }, [endedIds]);

  const lingering = endedIds === null ? null : jobs.filter((job) => endedIds.includes(job.id));
  return activityStatus(jobs, problems, lingering);
}
