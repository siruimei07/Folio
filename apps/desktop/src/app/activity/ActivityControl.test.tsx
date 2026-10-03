// The activity button wired to the library's jobs (library-actions handoff §10) against the fake
// shell: the scan a library runs when it opens, problems only once a scan has finished, the
// destination the import dialog noted, "Details", cancelling, and "View problems" only while a
// problems list exists.
import { act, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { keys } from '../../data/keys';
import type { Job } from '../../ipc';
import { NOW } from '../../test/data';
import { renderApp } from '../../test/render';
import { closeDialog, HostedDialogs, useNavigation } from '../navigation';
import { ActivityControl } from './ActivityControl';
import { noteImport, resetJobNotes } from './notes';

function renderActivity(hosted: readonly ('problems' | 'importResult')[] = ['importResult'], jobStepMs = 40) {
  closeDialog();
  resetJobNotes();
  return renderApp(
    <HostedDialogs value={new Set(hosted)}>
      <ActivityControl compact={false} />
    </HostedDialogs>,
    { now: NOW, jobStepMs },
  );
}

describe('ActivityControl', () => {
  it('follows the opening scan, then says how many problems it left, without "View problems" yet', async () => {
    const { user, shell } = renderActivity();
    act(() => {
      shell.startScan();
    });
    expect(await screen.findByRole('button', { name: /^Activity: scanning the library/ })).toBeInTheDocument();
    const done = await screen.findByRole('button', { name: /^Activity: (all tasks done|tasks done)/ }, { timeout: 3000 });
    await user.click(done);
    const panel = await screen.findByRole('dialog', { name: 'Activity' });
    expect(within(panel).getByText(/in the last scan$/)).toBeInTheDocument();
    expect(within(panel).queryByRole('button', { name: 'View problems' })).toBeNull();
  });

  it('names an import by the destination the dialog noted, and opens its Details', async () => {
    const { user, client, shell } = renderActivity();
    const libraryId = shell.status().state === 'open' ? (shell.status() as { library: { id: string } }).library.id : '';
    const target = { id: '7', path: 'Fall 2026/CSC148 Introduction to Computer Science' };
    const running: Job = {
      id: 'import-1',
      kind: 'import',
      cancellable: true,
      status: { state: 'running', progress: { done: 1, total: 4, permille: null, current: null } },
    };
    const job: Job = {
      id: 'import-1',
      kind: 'import',
      cancellable: false,
      status: { state: 'failed', error: { code: 'DiskFull', detail: 'full' } },
    };
    act(() => {
      noteImport(job.id, { libraryId, target, label: 'CSC148', files: 4 });
      client.setQueryData(keys.jobs(libraryId), [running]);
    });
    expect(await screen.findByRole('button', { name: /^Activity: adding files, 25 percent/ })).toBeInTheDocument();
    // It fails: the button says so for a while.
    act(() => {
      client.setQueryData(keys.jobs(libraryId), [job]);
    });
    await user.click(await screen.findByRole('button', { name: /^Activity/ }));
    const panel = await screen.findByRole('dialog', { name: 'Activity' });
    expect(within(panel).getByText("Couldn't add files to CSC148")).toBeInTheDocument();
    await user.click(within(panel).getByRole('button', { name: 'Details' }));
    await waitFor(() => {
      expect(useNavigation.getState().dialog).toEqual({ kind: 'importResult', params: { job, target: 'CSC148' } });
    });
  });

  it('cancels a running job from the popover', async () => {
    const { user, shell } = renderActivity(['importResult', 'problems'], 1000);
    act(() => {
      shell.startScan();
    });
    await user.click(await screen.findByRole('button', { name: /^Activity: (waiting to start )?scanning the library/ }));
    const panel = await screen.findByRole('dialog', { name: 'Activity' });
    await user.click(within(panel).getByRole('button', { name: 'Cancel scan' }));
    await waitFor(() => {
      expect(shell.jobs().find((job) => job.kind === 'scan')?.status.state).toBe('cancelled');
    });
  });
});
