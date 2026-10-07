// The first commit (workspace-history handoff §10) and the Changes rail badge (§2.1), on the fake
// shell: the shell with the Changes view and its badge as app/registry.ts hosts them, without the
// toolbar and dialogs. The badge is mounted with the shell and starts the history by itself, once per library
// session; the view shows the first commit's block in every state until the history has started.
import { act, screen, waitFor, within } from '@testing-library/react';
import { FileDiff, LibraryBig } from 'lucide-react';
import { StrictMode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ChangesView } from '../changes';
import { ChangesRailBadge } from '../changes/RailBadge';
import { politeText, settle } from '../changes/test/render';
import { useWorkspace } from '../data/workspace';
import { NOW } from '../test/data';
import { smallWorkspace } from '../test/fixtures';
import { renderApp, type RenderAppOptions } from '../test/render';
import { Announcer, clearAnnouncements } from './announcer';
import { useNavigation } from './navigation';
import type { ShellRegistry } from './registry';
import { Shell } from './Shell';

const REGISTRY: ShellRegistry = {
  views: [
    { id: 'library', icon: LibraryBig, label: 'rail.library', key: '1', component: () => null },
    { id: 'changes', icon: FileDiff, label: 'rail.changes', key: '2', component: ChangesView },
  ],
  dialogs: {},
  toolbar: {},
  badges: { changes: ChangesRailBadge },
};

const STARTING = 'Starting your history';
const SENTENCE =
  "Folio is saving the first version of your library: every text and Word file, and a record of everything else. You can keep working; changes show up here when it's done.";

beforeEach(() => {
  useNavigation.setState({ view: 'changes', dialog: null, revealTarget: null });
  clearAnnouncements();
});

/** The shell on the Changes view, with the app's live regions; `invoke` records the commands. */
function renderShell(options: RenderAppOptions = {}) {
  const rendered = renderApp(
    <>
      <Shell registry={REGISTRY} />
      <Announcer />
    </>,
    { now: NOW, ...options },
  );
  const invoke = vi.spyOn(rendered.shell, 'invoke');
  return { ...rendered, invoke };
}

type Invoke = ReturnType<typeof renderShell>['invoke'];

function starts(invoke: Invoke): unknown[] {
  return invoke.mock.calls.filter(([command]) => command === 'start_history').map(([, payload]) => payload);
}

function railButton(): HTMLElement {
  return within(screen.getByRole('navigation', { name: 'Views' })).getByRole('button', { name: /^Changes/ });
}

describe('the first commit', () => {
  it('starts by itself, waits for the scan, reads the files in bytes and says when the history has started', async () => {
    const { shell, invoke } = renderShell({ scenario: 'history-none', jobStepMs: 60_000 });
    expect(await screen.findByRole('heading', { name: STARTING })).toBeInTheDocument();
    expect(screen.getByText(SENTENCE)).toBeInTheDocument();
    expect(screen.getByText('Waiting for the scan to finish')).toBeInTheDocument();
    const bar = screen.getByRole('progressbar', { name: STARTING });
    expect(bar).not.toHaveAttribute('aria-valuenow');
    await waitFor(() => {
      expect(starts(invoke)).toEqual([{ request: { summary: 'Start history' } }]);
    });
    // One panel: no list and no commit box, and no badge on the rail.
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(screen.queryByRole('region', { name: 'Commit' })).toBeNull();
    expect(railButton()).toHaveAccessibleName('Changes');
    expect(railButton().querySelector('.rail__badge')).toBeNull();

    act(() => {
      shell.stepJobs();
      shell.stepJobs();
    });
    expect(await screen.findByText(/^\d+(\.\d)? (B|KB|MB) of \d+(\.\d)? (B|KB|MB)$/)).toBeInTheDocument();
    expect(Number(screen.getByRole('progressbar', { name: STARTING }).getAttribute('aria-valuenow'))).toBeGreaterThan(0);
    expect(screen.queryByText('Waiting for the scan to finish')).toBeNull();

    act(() => {
      shell.finishJobs();
    });
    expect(await screen.findByRole('region', { name: 'Commit' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: STARTING })).toBeNull();
    await waitFor(() => {
      expect(politeText()).toBe('Your history has started.');
    });
    // The first row is selected and its diff fails at once (an unreadable file): the message is
    // still heard, the failure after it.
    await screen.findByRole('heading', { name: "Couldn't show what changed" });
    expect(politeText()).toBe('Your history has started.');
    expect(starts(invoke)).toHaveLength(1);
  });

  it('names its panel "Changes", with a heading above the block\'s', async () => {
    renderShell({ scenario: 'history-none', jobStepMs: 60_000 });
    const heading = await screen.findByRole('heading', { name: STARTING });
    const panel = screen.getByRole('region', { name: 'Changes' });
    expect(panel).toContainElement(heading);
    expect(within(panel).getByRole('heading', { level: 2, name: 'Changes' })).toBeInTheDocument();
    expect(heading.tagName).toBe('H3');
  });

  it('after a cancel says the history has not started, does not start it again by itself, and Start history does', async () => {
    const { shell, invoke, user } = renderShell({ scenario: 'history-none', jobStepMs: 60_000 });
    await screen.findByRole('heading', { name: STARTING });
    await waitFor(() => {
      expect(shell.jobs().some((job) => job.kind === 'firstCommit')).toBe(true);
    });
    const job = shell.jobs().find((candidate) => candidate.kind === 'firstCommit');
    act(() => {
      if (job !== undefined) shell.cancelJob(job.id);
    });

    expect(await screen.findByRole('heading', { name: "Your history hasn't started" })).toBeInTheDocument();
    expect(screen.getByText('Folio starts it the next time you open the library.')).toBeInTheDocument();
    await settle();
    expect(starts(invoke)).toHaveLength(1);
    expect(politeText()).toBe('');

    await user.click(screen.getByRole('button', { name: 'Start history' }));
    expect(await screen.findByRole('heading', { name: STARTING })).toBeInTheDocument();
    expect(document.activeElement).toHaveClass('first-commit');
    expect(starts(invoke)).toHaveLength(2);
    act(() => {
      shell.finishJobs();
    });
    expect(await screen.findByRole('region', { name: 'Commit' })).toBeInTheDocument();
    // The block that had the focus went: the view hands it to the list's selected row, not the page.
    await waitFor(() => {
      expect(screen.getByRole('listbox', { name: 'Changes' }).contains(document.activeElement)).toBe(true);
    });
    expect(document.activeElement).toHaveAttribute('aria-selected', 'true');
  });

  it('follows the running job after a reload, and a cancel then does not start it again', async () => {
    const { shell, invoke } = renderShell({ scenario: 'history-none', jobStepMs: 60_000 });
    await waitFor(() => {
      expect(starts(invoke)).toHaveLength(1);
    });
    act(() => {
      shell.stepJobs();
      shell.stepJobs();
    });
    expect(await screen.findByText(/^\d+(\.\d)? (B|KB|MB) of \d+(\.\d)? (B|KB|MB)$/)).toBeInTheDocument();
    // A reload: the window's stores start afresh, the shell's job runs on.
    const { publishReferences } = await import('../data/references');
    act(() => {
      publishReferences({ kind: 'reset' });
    });
    act(() => {
      shell.stepJobs();
    });
    expect(await screen.findByText(/^\d+(\.\d)? (B|KB|MB) of \d+(\.\d)? (B|KB|MB)$/)).toBeInTheDocument();
    expect(screen.queryByText('Waiting for the scan to finish')).toBeNull();
    const job = shell.jobs().find((candidate) => candidate.kind === 'firstCommit');
    act(() => {
      if (job !== undefined) shell.cancelJob(job.id);
      // A running job stops at its next step.
      shell.stepJobs();
    });
    expect(await screen.findByRole('heading', { name: "Your history hasn't started" })).toBeInTheDocument();
    await settle();
    expect(starts(invoke)).toHaveLength(1);
  });

  it('names the reason a first commit failed, and Try again starts it again', async () => {
    const { shell, invoke, user } = renderShell({
      scenario: 'history-none',
      jobStepMs: 60_000,
      commitFailure: { code: 'DiskFull', file: null },
    });
    await screen.findByRole('heading', { name: STARTING });
    await waitFor(() => {
      expect(starts(invoke)).toHaveLength(1);
    });
    await settle();
    act(() => {
      shell.finishJobs();
    });
    expect(await screen.findByRole('heading', { name: "Couldn't start your history" })).toBeInTheDocument();
    expect(
      screen.getByText('The disk is full. Free up some space, then try again. Folio also tries again the next time you open the library.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Copy details' })).toBeNull();
    await settle();
    expect(starts(invoke)).toHaveLength(1);

    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('heading', { name: STARTING })).toBeInTheDocument();
    expect(starts(invoke)).toHaveLength(2);
    act(() => {
      shell.finishJobs();
    });
    expect(await screen.findByRole('region', { name: 'Commit' })).toBeInTheDocument();
  });

  it('shows a refused start with Copy details where due, and is quiet when the history exists already', async () => {
    const { shell, user } = renderShell({ scenario: 'history-none', fail: [{ command: 'start_history', code: 'Internal' }] });
    expect(await screen.findByRole('heading', { name: "Couldn't start your history" })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy details' })).toBeInTheDocument();

    shell.setFailure('start_history', 'HistoryExists');
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    await settle();
    expect(screen.getByRole('heading', { name: STARTING })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: "Couldn't start your history" })).toBeNull();
  });

  it('asks once, also when StrictMode runs the effect twice with the history state at hand', async () => {
    function HistoryState() {
      return <p>{useWorkspace().data?.historyState ?? 'loading'}</p>;
    }
    const rendered = renderApp(<HistoryState />, { now: NOW, scenario: 'history-none', jobStepMs: 60_000 });
    expect(await screen.findByText('none')).toBeInTheDocument();
    const invoke = vi.spyOn(rendered.shell, 'invoke');
    rendered.rerender(
      <StrictMode>
        <HistoryState />
        <Shell registry={REGISTRY} />
      </StrictMode>,
    );
    await screen.findByRole('heading', { name: STARTING });
    await waitFor(() => {
      expect(starts(invoke)).toHaveLength(1);
    });
    await settle();
    expect(starts(invoke)).toHaveLength(1);
  });

  it('starts nothing when the history exists', async () => {
    const { invoke } = renderShell();
    expect(await screen.findByRole('region', { name: 'Commit' })).toBeInTheDocument();
    await settle();
    expect(starts(invoke)).toHaveLength(0);
    expect(screen.queryByRole('heading', { name: STARTING })).toBeNull();
  });
});

describe('the Changes rail badge', () => {
  it('counts the items and the tag and settings changes, in the button name too', async () => {
    const { shell } = renderShell();
    const { items, metadata } = shell.versioning.summary();
    await waitFor(() => {
      expect(railButton()).toHaveAccessibleName(`Changes, ${String(items + metadata)} changes`);
    });
    expect(railButton().querySelector('.rail__badge')).toHaveTextContent(String(items + metadata));
    expect(railButton().querySelector('.rail__badge')).toHaveAttribute('aria-hidden', 'true');
  });

  it('says one change in the singular', async () => {
    renderShell({ fixture: smallWorkspace([{ change: 'added', path: 'Fall 2026/notes.md' }], { metadata: false }) });
    await waitFor(() => {
      expect(railButton()).toHaveAccessibleName('Changes, 1 change');
    });
    expect(railButton().querySelector('.rail__badge')).toHaveTextContent('1');
  });

  it('shows 999+ past 999', async () => {
    renderShell({ scenario: 'workspace-large' });
    await waitFor(
      () => {
        expect(railButton()).toHaveAccessibleName(/^Changes, 50,0\d\d changes$/);
      },
      { timeout: 5000 },
    );
    expect(railButton().querySelector('.rail__badge')).toHaveTextContent('999+');
  });

  it('is hidden with nothing to commit', async () => {
    renderShell({ fixture: smallWorkspace([], { metadata: false }) });
    expect(await screen.findByRole('heading', { name: 'No changes' })).toBeInTheDocument();
    expect(railButton()).toHaveAccessibleName('Changes');
    expect(railButton().querySelector('.rail__badge')).toBeNull();
  });
});
