import { act, render, renderHook, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import i18n from 'i18next';
import { describe, expect, it, vi } from 'vitest';

import errors from '../../i18n/locales/en/errors.json';
import type { Job } from '../../ipc';
import { ACTIVITY_LINGER_MS } from '../../lib/timing';
import { sampleJobs } from '../gallery/samples';
import { Activity } from './Activity';
import { describeJob, describeStatus, type ShellT } from './describe';
import { activityStatus, type ActivityJob, jobPercent } from './status';
import { useActivityStatus } from './useActivityStatus';

// The same function `useTranslation(['shell', 'errors'])` gives, typed as the components see it.
const t = i18n.getFixedT(null, ['shell', 'errors']) as unknown as ShellT;

const running = (kind: Job['kind'], done: number, total: number | null, permille: number | null = null): Job => ({
  id: `${kind}-running`,
  kind,
  cancellable: true,
  status: { state: 'running', progress: { done, total, permille, bytes: null, current: null } },
});
const queued = (kind: Job['kind']): Job => ({ id: `${kind}-queued`, kind, cancellable: true, status: { state: 'queued' } });
const failed = (kind: Job['kind']): Job => ({
  id: `${kind}-failed`,
  kind,
  cancellable: false,
  status: { state: 'failed', error: { code: 'AccessDenied', detail: 'denied' }, file: null },
});
const cancelled = (kind: Job['kind']): Job => ({ id: `${kind}-cancelled`, kind, cancellable: false, status: { state: 'cancelled', result: null } });

describe('activity status', () => {
  it('follows the jobs: one running, several, recently done, problems, hidden', () => {
    expect(activityStatus([running('scan', 38, 100)], 7, null)).toEqual({
      kind: 'running',
      jobKind: 'scan',
      percent: 38,
      problems: 7,
    });
    expect(activityStatus([running('scan', 1, 2), queued('hash')], null, null)).toEqual({
      kind: 'several',
      count: 2,
      problems: 0,
    });
    expect(activityStatus([failed('rebuild')], 0, [failed('rebuild')])).toEqual({ kind: 'done', withProblems: true });
    expect(activityStatus([], 3, null)).toEqual({ kind: 'problems', count: 3 });
    expect(activityStatus([], 0, null)).toEqual({ kind: 'hidden' });
    expect(activityStatus([], null, null)).toEqual({ kind: 'hidden' });
    expect(activityStatus([queued('import')], 2, null)).toEqual({ kind: 'waiting', jobKind: 'import', problems: 2 });
  });

  it('takes the percentage from bytes when the job measures them, else from files', () => {
    expect(jobPercent(running('import', 7, 12, 580))).toBe(58);
    expect(jobPercent(running('scan', 4210, 11000))).toBe(38);
    expect(jobPercent(running('rebuild', 8400, null))).toBeNull();
    expect(jobPercent(queued('hash'))).toBeNull();
  });

  it('stays on Done for 10 s after the last active job ends', () => {
    vi.useFakeTimers();
    try {
      const done: Job = { ...running('import', 12, 12), status: { state: 'failed', error: { code: 'DiskFull', detail: '' }, file: null } };
      const { result, rerender } = renderHook(({ jobs }) => useActivityStatus(jobs, 0), {
        initialProps: { jobs: [running('import', 7, 12)] },
      });
      expect(result.current.kind).toBe('running');
      rerender({ jobs: [done] });
      expect(result.current).toEqual({ kind: 'done', withProblems: true });
      act(() => {
        vi.advanceTimersByTime(ACTIVITY_LINGER_MS);
      });
      expect(result.current).toEqual({ kind: 'hidden' });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('activity words', () => {
  it('labels the button and gives the whole status to screen readers', () => {
    expect(describeStatus(t, { kind: 'running', jobKind: 'scan', percent: 38, problems: 7 })).toEqual({
      label: 'Scanning 38%',
      aria: 'Activity: scanning the library, 38 percent. 7 problems.',
    });
    expect(describeStatus(t, { kind: 'running', jobKind: 'rebuild', percent: null, problems: 0 })).toEqual({
      label: 'Rebuilding index…',
      aria: 'Activity: rebuilding the search index.',
    });
    expect(describeStatus(t, { kind: 'several', count: 3, problems: 0 })?.label).toBe('3 tasks');
    expect(describeStatus(t, { kind: 'done', withProblems: true })?.label).toBe('Done with problems');
    expect(describeStatus(t, { kind: 'problems', count: 1 })).toEqual({
      label: '1 problem',
      aria: 'Activity: 1 problem found in the last scan.',
    });
    expect(describeStatus(t, { kind: 'waiting', jobKind: 'import', problems: 0 })).toEqual({
      label: 'Waiting',
      aria: 'Activity: waiting to start adding files.',
    });
    expect(describeStatus(t, { kind: 'hidden' })).toBeNull();
  });

  it('describes each kind of job while it waits, runs and ends', () => {
    const now = new Date(2026, 8, 30, 17, 30).getTime();
    const row = (item: ActivityJob) => describeJob(t, item, now, 'en');

    expect(row({ job: queued('hash') })).toMatchObject({ look: 'queued', title: 'Checking files', meta: 'Starts when the scan finishes' });
    expect(row({ job: running('scan', 4210, 11000) })).toMatchObject({
      look: 'running',
      title: 'Scanning the library',
      meta: '4,210 of 11,000 files',
      percent: 38,
      cancelLabel: 'Cancel scan',
    });
    expect(row({ job: running('scan', 4210, null) }).meta).toBe('4,210 files so far');
    expect(row({ job: running('import', 7, 12), target: 'MAT232' }).title).toBe('Adding 12 files to MAT232');
    expect(row({ job: running('import', 7, null) }).title).toBe('Adding files');
    expect(row({ job: running('rebuild', 8400, null) }).meta).toBe('8,400 entries so far');
    // Hashing counts steps, not files (ipc-m1 §13): its row says why it runs, with no count.
    expect(row({ job: running('hash', 6, 8) })).toMatchObject({
      look: 'running',
      title: 'Checking files',
      meta: 'So Folio can spot changes and moves, and search inside files',
      percent: 75,
      cancelLabel: 'Cancel checking files',
    });
    expect(row({ job: running('hash', 0, null) })).toMatchObject({
      meta: 'So Folio can spot changes and moves, and search inside files',
      percent: null,
    });

    const scanDone: Job = { ...queued('scan'), status: { state: 'done', result: { kind: 'scan', changes: 12, problems: 3 } } };
    expect(row({ job: scanDone, finishedAt: new Date(2026, 8, 30, 17, 12).getTime() })).toMatchObject({
      look: 'success',
      title: 'Scanned the library',
      meta: '12 changes, 3 problems',
      time: '5:12 PM',
    });
    const quiet: Job = { ...scanDone, status: { state: 'done', result: { kind: 'scan', changes: 0, problems: 0 } } };
    expect(row({ job: quiet }).meta).toBe('No changes');

    const hashDone: Job = { ...queued('hash'), status: { state: 'done', result: { kind: 'hash', hashed: 1240, deferred: 20 } } };
    expect(row({ job: hashDone, finishedAt: new Date(2026, 8, 27).getTime() })).toMatchObject({
      title: 'Checked 1,240 files',
      meta: '20 were busy; Folio tries again later',
      time: 'Sep 27',
    });
    // A job that hashed nothing may still have read text: no "Checked 0 files".
    const hashedNone: Job = { ...queued('hash'), status: { state: 'done', result: { kind: 'hash', hashed: 0, deferred: 0 } } };
    expect(row({ job: hashedNone })).toMatchObject({ look: 'success', title: 'Checked files', meta: 'So Folio can spot changes and moves' });
    const hashedOne: Job = { ...queued('hash'), status: { state: 'done', result: { kind: 'hash', hashed: 1, deferred: 0 } } };
    expect(row({ job: hashedOne }).title).toBe('Checked 1 file');

    const rebuildDone: Job = { ...queued('rebuild'), status: { state: 'done', result: { kind: 'rebuild', entries: 50210 } } };
    expect(row({ job: rebuildDone })).toMatchObject({ title: 'Rebuilt the search index', meta: '50,210 items' });
  });

  it('describes imports that ended fully, partly, failed or cancelled', () => {
    const now = Date.now();
    const [, , fully, partly] = sampleJobs(now);
    if (!fully || !partly) throw new Error('samples changed');
    expect(describeJob(t, fully, now, 'en')).toMatchObject({
      look: 'success',
      title: 'Added 12 files to MAT232',
      meta: '3 replaced · 1 kept as a copy',
      hasDetails: false,
    });
    expect(describeJob(t, partly, now, 'en')).toMatchObject({
      look: 'warning',
      title: 'Added 10 of 12 files to CSC207',
      meta: "2 couldn't be copied. Their originals stay where they are.",
      hasDetails: true,
    });
    expect(describeJob(t, { job: failed('import'), target: 'MAT232' }, now, 'en')).toMatchObject({
      look: 'danger',
      title: "Couldn't add files to MAT232",
      meta: errors.AccessDenied,
      hasDetails: true,
    });
    expect(describeJob(t, { job: cancelled('import'), target: 'MAT232' }, now, 'en')).toMatchObject({
      look: 'cancelled',
      title: 'Stopped adding files to MAT232',
    });
    const stopped = (failureCount: number): Job => ({
      ...cancelled('import'),
      status: {
        state: 'cancelled',
        result: { kind: 'import', imported: 7, replaced: 0, renamed: 0, skipped: 0, originalsDeleted: 0, failures: [], failureCount },
      },
    });
    expect(describeJob(t, { job: stopped(0), target: 'MAT232', files: 12 }, now, 'en')).toMatchObject({
      look: 'cancelled',
      meta: '7 of 12 were added before you stopped.',
      hasDetails: false,
    });
    expect(describeJob(t, { job: stopped(1) }, now, 'en')).toMatchObject({
      meta: '7 files were added before you stopped.',
      hasDetails: true,
    });
    expect(describeJob(t, { job: cancelled('scan') }, now, 'en').title).toBe('Scan cancelled');
    expect(describeJob(t, { job: failed('hash') }, now, 'en').title).toBe("Couldn't check files");
  });

  it('words commits by their changes and the bytes they have read (handoff §4.4, §10)', () => {
    const now = Date.now();
    const row = (item: ActivityJob) => describeJob(t, item, now, 'en');
    const MB = 1024 * 1024;
    /** A commit 3 files of 8 in, `done` of `total` bytes read. */
    const reading = (kind: 'commit' | 'firstCommit', done: number, total: number): Job => ({
      id: `${kind}-reading`,
      kind,
      cancellable: true,
      status: {
        state: 'running',
        progress: {
          done: 3,
          total: 8,
          permille: Math.floor((done / total) * 1000),
          bytes: { done: String(Math.round(done)), total: String(Math.round(total)) },
          current: 'MAT232/Midterm review.md',
        },
      },
    });

    expect(row({ job: reading('commit', 12.4 * MB, 48 * MB), changes: 9 })).toMatchObject({
      look: 'running',
      title: 'Committing 9 changes',
      meta: '12.4 of 48.0 MB',
      percent: 25,
      current: 'MAT232/Midterm review.md',
      cancelLabel: 'Cancel commit',
    });
    expect(row({ job: reading('commit', 300, 900), changes: 1 })).toMatchObject({ title: 'Committing 1 change', meta: '300 of 900 B' });
    expect(row({ job: queued('commit'), changes: 9 })).toMatchObject({ look: 'queued', title: 'Committing 9 changes', meta: 'Waiting' });
    // A commit started before a reload: the UI did not note its changes.
    expect(row({ job: reading('commit', 2 * MB, 4 * MB) }).title).toBe('Committing changes');
    // No bytes yet: the files it has read.
    expect(row({ job: running('commit', 3, 8), changes: 9 }).meta).toBe('3 of 8 files');

    expect(row({ job: reading('firstCommit', 1.2 * 1024 * MB, 3.4 * 1024 * MB) })).toMatchObject({
      title: 'Starting history',
      meta: '1.2 of 3.4 GB',
      percent: 35,
      cancelLabel: 'Cancel starting history',
    });

    const committed: Job = {
      ...queued('commit'),
      cancellable: false,
      status: { state: 'done', result: { kind: 'commit', commit: `b3:${'a'.repeat(64)}`, summary: 'MAT232: add lecture 6', changes: 9 } },
    };
    expect(row({ job: committed, changes: 9 })).toMatchObject({ look: 'success', title: 'Committed 9 changes', meta: 'MAT232: add lecture 6' });
    expect(row({ job: failed('commit') })).toMatchObject({ look: 'danger', title: "Couldn't commit", meta: errors.AccessDenied });
    expect(row({ job: cancelled('commit'), changes: 9 })).toMatchObject({ look: 'cancelled', title: 'Commit cancelled', meta: null });
  });
});

describe('Activity', () => {
  const callbacks = () => ({ onCancel: vi.fn(), onDetails: vi.fn(), onViewProblems: vi.fn() });
  /** A running scan and three finished jobs (the samples also queue a hash). */
  const scanAndFinished = () => sampleJobs(Date.now()).filter(({ job }) => job.status.state !== 'queued');

  it('stays hidden while nothing runs and the last scan left no problems', () => {
    render(<Activity jobs={[]} problems={0} {...callbacks()} />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('opens the popover from its button, with focus on the first cancel button', async () => {
    const actions = callbacks();
    render(<Activity jobs={scanAndFinished()} problems={7} {...actions} />);
    const button = screen.getByRole('button', { name: 'Activity: scanning the library, 38 percent. 7 problems.' });
    expect(button).toHaveTextContent('Scanning 38%');
    expect(button).toHaveAttribute('aria-haspopup', 'dialog');
    await userEvent.click(button);

    const popover = screen.getByRole('dialog', { name: 'Activity' });
    expect(popover).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel scan' })).toHaveFocus();
    expect(screen.getByRole('list', { name: 'Running' })).toBeInTheDocument();
    expect(screen.getByRole('list', { name: 'Earlier' })).toBeInTheDocument();
    expect(screen.getByText('7 problems in the last scan')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Cancel scan' }));
    expect(actions.onCancel).toHaveBeenCalledWith(expect.objectContaining({ id: 'scan-1' }));
    await userEvent.click(screen.getByRole('button', { name: 'Details' }));
    expect(actions.onDetails).toHaveBeenCalledWith(expect.objectContaining({ id: 'import-2' }));
    await userEvent.click(screen.getByRole('button', { name: 'View problems' }));
    expect(actions.onViewProblems).toHaveBeenCalledOnce();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('starts on "View problems" when nothing can be cancelled, and Tab past it closes the popover', async () => {
    const finished = sampleJobs(Date.now()).slice(2);
    render(<Activity jobs={finished} problems={7} {...callbacks()} />);
    const button = screen.getByRole('button', { name: 'Activity: 7 problems found in the last scan.' });
    await userEvent.click(button);
    expect(screen.getByRole('button', { name: 'View problems' })).toHaveFocus();
    await userEvent.tab();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('counts several jobs, closes on Esc and returns focus to its button', async () => {
    render(<Activity jobs={sampleJobs(Date.now())} problems={0} {...callbacks()} />);
    const button = screen.getByRole('button', { name: 'Activity: 2 tasks running.' });
    expect(button).toHaveTextContent('2 tasks');
    await userEvent.click(button);
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await vi.waitFor(() => {
      expect(button).toHaveFocus();
    });
  });

  it('says "No problems in the last scan", and nothing before the first scan', async () => {
    const jobs = [{ job: running('rebuild', 10, null) }];
    const { rerender } = render(<Activity jobs={jobs} problems={0} {...callbacks()} />);
    await userEvent.click(screen.getByRole('button', { name: 'Activity: rebuilding the search index.' }));
    expect(screen.getByText('No problems in the last scan')).toBeInTheDocument();
    rerender(<Activity jobs={jobs} problems={null} {...callbacks()} />);
    expect(screen.queryByText('No problems in the last scan')).not.toBeInTheDocument();
  });

  it('closes its popover when the button hides, so it never opens by itself later', async () => {
    const jobs = [{ job: running('scan', 1, 10) }];
    const { rerender } = render(<Activity jobs={jobs} problems={0} {...callbacks()} />);
    await userEvent.click(screen.getByRole('button', { name: /^Activity:/ }));
    expect(screen.getByRole('dialog', { name: 'Activity' })).toBeInTheDocument();

    rerender(<Activity jobs={[]} problems={0} {...callbacks()} />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    rerender(<Activity jobs={jobs} problems={0} {...callbacks()} />);
    expect(screen.getByRole('button', { name: /^Activity:/ })).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('is an icon-only button with the status in its name when compact', () => {
    render(<Activity jobs={scanAndFinished()} problems={7} compact {...callbacks()} />);
    const button = screen.getByRole('button', { name: 'Activity: scanning the library, 38 percent. 7 problems.' });
    expect(button).not.toHaveTextContent('Scanning');
  });
});
