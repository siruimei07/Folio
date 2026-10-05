import { describe, expect, it } from 'vitest';

import type { Job, JobStatus } from '../ipc';
import { applyJob } from './jobs';

function job(id: string, status: JobStatus, kind: Job['kind'] = 'scan'): Job {
  return { id, kind, cancellable: true, status };
}

const queued: JobStatus = { state: 'queued' };
const running = (done: number): JobStatus => ({
  state: 'running',
  progress: { done, total: 100, permille: null, bytes: null, current: null },
});
const done: JobStatus = { state: 'done', result: { kind: 'scan', changes: 0, problems: 0 } };

describe('applyJob', () => {
  it('adds a new active job after the active ones, and a finished one first among the finished', () => {
    const list = [job('a', running(1)), job('old', done)];
    expect(applyJob(list, job('b', queued)).map((item) => item.id)).toEqual(['a', 'b', 'old']);
    expect(applyJob(list, job('c', done)).map((item) => item.id)).toEqual(['a', 'c', 'old']);
  });

  it('replaces a job in place while it stays active', () => {
    const list = [job('a', queued), job('b', queued)];
    const next = applyJob(list, job('a', running(5)));
    expect(next.map((item) => [item.id, item.status.state])).toEqual([
      ['a', 'running'],
      ['b', 'queued'],
    ]);
  });

  it('moves a job that finished to the top of the finished ones', () => {
    const list = [job('a', running(5)), job('b', running(1)), job('old', done)];
    expect(applyJob(list, job('a', done)).map((item) => item.id)).toEqual(['b', 'a', 'old']);
  });

  it('never takes a job back: an older event that arrives late changes nothing', () => {
    const list = [job('a', done)];
    expect(applyJob(list, job('a', running(50)))).toEqual(list);
    expect(applyJob([job('b', running(40))], job('b', running(10)))).toEqual([job('b', running(40))]);
    expect(applyJob([job('b', running(40))], job('b', queued))).toEqual([job('b', running(40))]);
  });

  it('keeps the last 20 finished jobs', () => {
    const finished = Array.from({ length: 20 }, (_, index) => job(`f${String(index)}`, done));
    const next = applyJob([job('a', running(1)), ...finished], job('new', done));
    expect(next).toHaveLength(21);
    expect(next[1]?.id).toBe('new');
    expect(next.at(-1)?.id).toBe('f18');
  });
});
