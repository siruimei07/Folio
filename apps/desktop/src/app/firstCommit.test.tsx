// The first commit (workspace-history handoff §10) and the Changes rail badge (§2.1), on the fake
// shell: the shell with the Changes view and its badge as app/registry.ts hosts them (History too,
// where a test says so), without the toolbar and dialogs. The badge is mounted with the shell and starts the history by itself, once per library
// session; the view shows the first commit's block in every state until the history has started,
// and while it is too large to keep (ipc-m2 §6.1).
import { act, screen, waitFor, within } from '@testing-library/react';
import { FileDiff, History, LibraryBig } from 'lucide-react';
import { StrictMode } from 'react';
import { beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';

import { ChangesView } from '../changes';
import { ChangesRailBadge } from '../changes/RailBadge';
import { findRow, MAT, politeText, settle, summaryField } from '../changes/test/render';
import { useWorkspace } from '../data/workspace';
import { HistoryView } from '../history';
import { ipc, type Job, type JobStatus } from '../ipc';
import { type FakeShell, scenarioFixture } from '../ipc/mock';
import { NOW, smallRef } from '../test/data';
import { smallWorkspace } from '../test/fixtures';
import { renderApp, type RenderAppOptions } from '../test/render';
import { Announcer, clearAnnouncements } from './announcer';
import { showChange } from './changeTarget';
import { type FirstCommitSummary, firstCommitOf, historyListsNothing } from './firstCommit';
import { showHistory } from './historyTarget';
import { useNavigation } from './navigation';
import type { ShellRegistry } from './registry';
import { Shell } from './Shell';
import { installShortcuts } from './shortcuts';

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

/** The shell with History too, which shows the first commit's block as well (handoff §10). */
const WITH_HISTORY: ShellRegistry = {
  ...REGISTRY,
  views: [...REGISTRY.views, { id: 'history', icon: History, label: 'rail.history', key: '3', component: HistoryView }],
};

/**
 * The shell on the Changes view, with the app's live regions, in StrictMode with `strict`; `invoke`
 * records the commands.
 */
function renderShell({ registry = REGISTRY, strict = false, ...options }: RenderAppOptions & { registry?: ShellRegistry; strict?: boolean } = {}) {
  const ui = (
    <>
      <Shell registry={registry} />
      <Announcer />
    </>
  );
  const rendered = renderApp(strict ? <StrictMode>{ui}</StrictMode> : ui, { now: NOW, ...options });
  const invoke = vi.spyOn(rendered.shell, 'invoke');
  return { ...rendered, invoke };
}

/** Every message the app's polite live region says from now on, in order (one element each). */
function listenPolite(): () => string[] {
  const region = document.querySelector('[data-live-announcer] > [aria-live="polite"][aria-atomic="true"]');
  if (region === null) throw new Error('the app’s polite live region is in the page');
  const said: string[] = [];
  const note = (records: MutationRecord[]) => {
    for (const record of records) for (const node of record.addedNodes) said.push(node.textContent ?? '');
  };
  const observer = new MutationObserver(note);
  observer.observe(region, { childList: true });
  onTestFinished(() => {
    observer.disconnect();
  });
  return () => {
    note(observer.takeRecords());
    return [...said];
  };
}

/** Whether the page has shown `text` since the call, also between two checks (a heading that came and went). */
function watchPage(): (text: string) => boolean {
  const shown = [document.body.textContent];
  const note = (records: MutationRecord[]) => {
    for (const record of records) {
      if (record.type === 'characterData') shown.push(record.oldValue ?? '', record.target.textContent ?? '');
      for (const node of [...record.addedNodes, ...record.removedNodes]) shown.push(node.textContent ?? '');
    }
  };
  const observer = new MutationObserver(note);
  observer.observe(document.body, { subtree: true, childList: true, characterData: true, characterDataOldValue: true });
  onTestFinished(() => {
    observer.disconnect();
  });
  return (text) => {
    note(observer.takeRecords());
    return shown.some((words) => words.includes(text));
  };
}

type Invoke = ReturnType<typeof renderShell>['invoke'];

function starts(invoke: Invoke): unknown[] {
  return invoke.mock.calls.filter(([command]) => command === 'start_history').map(([, payload]) => payload);
}

function railButton(): HTMLElement {
  return within(screen.getByRole('navigation', { name: 'Views' })).getByRole('button', { name: /^Changes/ });
}

/**
 * A window that opens with the workspace's state at hand (a reload): the summary is read before the
 * shell mounts, in StrictMode with `strict`. `invoke` records the commands from the shell's mount on.
 */
async function renderReloaded(scenario: NonNullable<RenderAppOptions['scenario']>, state: string, { strict = false } = {}) {
  function HistoryState() {
    return <p>{useWorkspace().data?.historyState ?? 'loading'}</p>;
  }
  const rendered = renderApp(<HistoryState />, { now: NOW, scenario, jobStepMs: 60_000 });
  expect(await screen.findByText(state)).toBeInTheDocument();
  const invoke = vi.spyOn(rendered.shell, 'invoke');
  const ui = (
    <>
      <HistoryState />
      <Shell registry={REGISTRY} />
      <Announcer />
    </>
  );
  rendered.rerender(strict ? <StrictMode>{ui}</StrictMode> : ui);
  return { shell: rendered.shell, invoke };
}

/** Ends the running first commit and waits for the block that says how it went. */
async function finishFirstCommit(shell: FakeShell, heading: string): Promise<void> {
  act(() => {
    shell.finishJobs();
  });
  expect(await screen.findByRole('heading', { name: heading })).toBeInTheDocument();
  await settle();
}

/** A change to the library (an edit of Personal/Todo.txt by default), then the `count`th start. */
async function changeLibrary(
  shell: FakeShell,
  invoke: Invoke,
  count: number,
  change: (shell: FakeShell) => void = (fake) => {
    fake.editFile('Personal/Todo.txt');
  },
): Promise<void> {
  act(() => {
    change(shell);
  });
  await waitFor(() => {
    expect(starts(invoke)).toHaveLength(count);
  });
  await settle();
}

/**
 * Holds the answer to the next start_history until the returned function is called: the shell acts
 * on it at once and its events go out, as they overtake answers in the app (ui-architecture §5.4).
 */
function holdNextStartAnswer(shell: FakeShell, invoke: Invoke): () => void {
  // The spy has replaced the shell's own `invoke`; its class's still answers.
  const through = (Object.getPrototypeOf(shell) as FakeShell).invoke.bind(shell);
  let release: (() => void) | undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let holding = true;
  invoke.mockImplementation(async (command, payload) => {
    const answer = through(command, payload);
    if (command === 'start_history' && holding) {
      holding = false;
      await held;
    }
    return answer;
  });
  return () => {
    release?.();
  };
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
    const { invoke } = await renderReloaded('history-none', 'none', { strict: true });
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

  it('hands the focus from History’s block to its timeline once the history has started', async () => {
    useNavigation.setState({ view: 'history' });
    const { shell, user } = renderShell({ scenario: 'history-none', jobStepMs: 60_000, registry: WITH_HISTORY });
    await screen.findByRole('heading', { name: STARTING });
    await waitFor(() => {
      expect(shell.jobs().some((job) => job.kind === 'firstCommit')).toBe(true);
    });
    const job = shell.jobs().find((candidate) => candidate.kind === 'firstCommit');
    act(() => {
      if (job !== undefined) shell.cancelJob(job.id);
    });
    await user.click(await screen.findByRole('button', { name: 'Start history' }));
    expect(await screen.findByRole('heading', { name: STARTING })).toBeInTheDocument();
    expect(document.activeElement).toHaveClass('first-commit');

    act(() => {
      shell.finishJobs();
    });

    // The block that had the focus went: the timeline's tab stop takes it, not the page.
    const feed = await screen.findByRole('feed', { name: 'History, newest first' });
    await waitFor(() => {
      expect(feed.querySelector('article[tabindex="0"]')).toHaveFocus();
    });
  });
});

describe('firstCommitOf', () => {
  const IDLE = { pending: false, error: null };
  const PHOTOS = 'Personal/Photos';
  const TOO_LARGE_JOB: JobStatus = {
    state: 'failed',
    error: { code: 'HistoryTooLarge', detail: 'a folder over 64 MiB' },
    file: PHOTOS,
  };
  const RUNNING: JobStatus = {
    state: 'running',
    progress: { done: 1, total: 4, permille: 250, bytes: { done: '10', total: '40' }, current: null },
  };

  function summary(
    historyState: FirstCommitSummary['historyState'],
    tooLargeFolder: string | null = null,
    head: string | null = null,
  ): FirstCommitSummary {
    return { historyState, tooLargeFolder, head };
  }

  function job(status: JobStatus): Job {
    return { id: 'job', kind: 'firstCommit', cancellable: true, status };
  }

  it('names the folder too large, and promises a retry only without a HEAD', () => {
    expect(firstCommitOf(summary('tooLarge', PHOTOS), undefined, IDLE)).toEqual({ kind: 'tooLarge', folder: PHOTOS, retries: true });
    expect(firstCommitOf(summary('tooLarge'), undefined, IDLE)).toEqual({ kind: 'tooLarge', folder: null, retries: true });
    expect(firstCommitOf(summary('tooLarge', null, 'c0ffee'), undefined, IDLE)).toEqual({ kind: 'tooLarge', folder: null, retries: false });
    expect(firstCommitOf(summary('tooLarge', PHOTOS, 'c0ffee'), undefined, IDLE)).toEqual({ kind: 'tooLarge', folder: PHOTOS, retries: false });
    // The root is the library as a whole.
    expect(firstCommitOf(summary('tooLarge', ''), undefined, IDLE)).toEqual({ kind: 'tooLarge', folder: null, retries: true });
  });

  it('shows tooLarge over the session’s job, its failure and a start on its way', () => {
    const tooLarge = { kind: 'tooLarge', folder: PHOTOS, retries: true };
    expect(firstCommitOf(summary('tooLarge', PHOTOS), job(TOO_LARGE_JOB), IDLE)).toEqual(tooLarge);
    expect(firstCommitOf(summary('tooLarge', PHOTOS), job(RUNNING), IDLE)).toEqual(tooLarge);
    const failed: JobStatus = { state: 'failed', error: { code: 'DiskFull', detail: 'full' }, file: null };
    expect(firstCommitOf(summary('tooLarge', PHOTOS), job(failed), IDLE)).toEqual(tooLarge);
    expect(firstCommitOf(summary('tooLarge', PHOTOS), undefined, { pending: true, error: null })).toEqual(tooLarge);
    expect(firstCommitOf(summary('tooLarge', PHOTOS), undefined, { pending: false, error: { code: 'Internal', detail: 'x' } })).toEqual(
      tooLarge,
    );
  });

  it('shows a job that failed for its size as waiting while the state is not tooLarge', () => {
    // Its failure can come before the summary that says tooLarge, and it stays the session's job
    // once a change has ended the state.
    expect(firstCommitOf(summary('starting'), job(TOO_LARGE_JOB), IDLE)).toEqual({ kind: 'waiting' });
    expect(firstCommitOf(summary('none'), job(TOO_LARGE_JOB), IDLE)).toEqual({ kind: 'waiting' });
    // Any other failure says so, with Try again.
    const failed: JobStatus = { state: 'failed', error: { code: 'DiskFull', detail: 'full' }, file: null };
    expect(firstCommitOf(summary('none'), job(failed), IDLE)).toEqual({ kind: 'failed', error: failed.error });
  });

  it('goes with the states in which the workspace lists nothing', () => {
    const states = ['none', 'starting', 'tooLarge', 'ready', 'readOnly', 'damaged', undefined] as const;
    expect(states.map((state) => historyListsNothing(state))).toEqual([true, true, true, false, false, false, false]);
  });

  it('shows nothing once the history lists its changes, whatever the folder', () => {
    expect(firstCommitOf(summary('ready', null, 'c0ffee'), job(TOO_LARGE_JOB), IDLE)).toBeNull();
    expect(firstCommitOf(summary('damaged', null, 'c0ffee'), undefined, IDLE)).toBeNull();
    expect(firstCommitOf(undefined, undefined, IDLE)).toBeNull();
  });
});

describe('a history too large to keep', () => {
  const TITLE = 'History is off for this library';
  // Personal is a semester in the small library, so Personal/Photos is a course without a code.
  const PHOTOS_TEXT =
    "The folder Photos holds more files than Folio's history can keep. Your files are fine. Folio tries again when the library changes, for example after you move some files out of the folder.";
  const LIBRARY_TEXT =
    "This library holds more files than Folio's history can keep. Your files are fine. Folio tries again when the library changes, for example after you move some files out of it.";

  /** The small library with its history, whose `HEAD` is too large to show (ipc-m2 §6.1). */
  function tooLargeHead(folder: string | null) {
    const fixture = smallWorkspace([{ change: 'added', path: 'Fall 2026/notes.md' }]);
    const library = fixture.library;
    const history = library?.history;
    if (library == null || history === undefined) throw new Error('the small fixture has a library and a history');
    library.history = (opened, now) => ({ ...history(opened, now), state: 'tooLarge', tooLargeFolder: folder });
    return fixture;
  }

  /** What the views must not show while the history is off: they list nothing and start nothing. */
  function expectNothingListedOrStarted(): void {
    for (const name of ['Try again', 'Start history', 'Copy details']) {
      expect(screen.queryByRole('button', { name })).toBeNull();
    }
    expect(screen.queryByRole('progressbar')).toBeNull();
    expect(screen.queryByRole('heading', { name: STARTING })).toBeNull();
    expect(screen.queryByRole('heading', { name: "Couldn't start your history" })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'No changes' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'No history yet' })).toBeNull();
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(screen.queryByRole('feed')).toBeNull();
    expect(screen.queryByRole('region', { name: 'Commit' })).toBeNull();
    expect(railButton()).toHaveAccessibleName('Changes');
    expect(railButton().querySelector('.rail__badge')).toBeNull();
  }

  it('shows the Changes view as one panel with the block, which names the folder and shows it in File Explorer', async () => {
    const { invoke, user } = renderShell({ scenario: 'history-too-large' });
    // The window's key listener, as App installs it: Ctrl+Enter reaches the view's shortcut.
    onTestFinished(installShortcuts());
    const heading = await screen.findByRole('heading', { name: TITLE });
    const panel = screen.getByRole('region', { name: 'Changes' });
    expect(panel).toContainElement(heading);
    expect(within(panel).getByRole('heading', { level: 2, name: 'Changes' })).toBeInTheDocument();
    expect(heading.tagName).toBe('H3');
    expect(within(panel).getByText(PHOTOS_TEXT)).toBeInTheDocument();
    expect(panel.querySelector('.state-block')).toHaveAttribute('data-tone', 'warning');
    expectNothingListedOrStarted();

    // Ctrl+Enter commits nothing, from the page or from the block.
    await user.keyboard('{Control>}{Enter}{/Control}');
    act(() => {
      panel.querySelector<HTMLElement>('.first-commit')?.focus();
    });
    await user.keyboard('{Control>}{Enter}{/Control}');
    await settle();
    expect(invoke.mock.calls.filter(([command]) => command === 'commit' || command === 'generate_commit_message')).toEqual([]);
    expect(starts(invoke)).toEqual([]);

    await user.click(within(panel).getByRole('button', { name: 'Show in File Explorer' }));
    await waitFor(() => {
      expect(invoke.mock.calls.filter(([command]) => command === 'reveal_entry').map(([, payload]) => payload)).toEqual([
        { request: { entry: smallRef('Personal/Photos') } },
      ]);
    });
  });

  it('shows History as one panel with the same block', async () => {
    useNavigation.setState({ view: 'history' });
    const { invoke } = renderShell({ scenario: 'history-too-large', registry: WITH_HISTORY });
    const heading = await screen.findByRole('heading', { name: TITLE });
    const panel = screen.getByRole('region', { name: 'History' });
    expect(panel).toContainElement(heading);
    expect(within(panel).getByRole('heading', { level: 2, name: 'History' })).toBeInTheDocument();
    expect(within(panel).getByText(PHOTOS_TEXT)).toBeInTheDocument();
    expect(within(panel).getByRole('button', { name: 'Show in File Explorer' })).toBeInTheDocument();
    expectNothingListedOrStarted();
    await settle();
    expect(starts(invoke)).toEqual([]);
  });

  it('names the library as a whole, without a button, when a first commit fails for its size naming no folder', async () => {
    const { invoke } = renderShell({ scenario: 'history-none', commitFailure: { code: 'HistoryTooLarge', file: null } });
    expect(await screen.findByRole('heading', { name: TITLE })).toBeInTheDocument();
    expect(screen.getByText(LIBRARY_TEXT)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Show in File Explorer' })).toBeNull();
    expectNothingListedOrStarted();
    expect(starts(invoke)).toHaveLength(1);
  });

  it('promises no retry for a HEAD too large to show', async () => {
    useNavigation.setState({ view: 'history' });
    renderShell({ fixture: tooLargeHead(null), registry: WITH_HISTORY });
    expect(await screen.findByRole('heading', { name: TITLE })).toBeInTheDocument();
    expect(screen.getByText("This library's history is larger than Folio can show. Your files are fine.")).toBeInTheDocument();
    expect(screen.queryByText(/tries again/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Show in File Explorer' })).toBeNull();
    expectNothingListedOrStarted();
  });

  it('names a folder of such a HEAD by its course label, with Show in File Explorer', async () => {
    const { invoke, user } = renderShell({ fixture: tooLargeHead(`${MAT}/Problem sets`) });
    expect(await screen.findByRole('heading', { name: TITLE })).toBeInTheDocument();
    expect(
      screen.getByText("In this library's history, the folder MAT232 / Problem sets holds more files than Folio can show. Your files are fine."),
    ).toBeInTheDocument();
    expect(screen.queryByText(/tries again/)).toBeNull();
    expectNothingListedOrStarted();

    await user.click(screen.getByRole('button', { name: 'Show in File Explorer' }));
    await waitFor(() => {
      expect(invoke.mock.calls.filter(([command]) => command === 'reveal_entry').map(([, payload]) => payload)).toEqual([
        { request: { entry: smallRef(`${MAT}/Problem sets`) } },
      ]);
    });
  });

  it('gives the block the focus that "Go to Changes" asks of the view', async () => {
    useNavigation.setState({ view: 'history' });
    renderShell({ scenario: 'history-too-large', registry: WITH_HISTORY });
    await screen.findByRole('heading', { name: TITLE });

    act(() => {
      showChange();
    });

    expect(useNavigation.getState().view).toBe('changes');
    await waitFor(() => {
      expect(document.activeElement).toHaveClass('first-commit');
    });
    expect(screen.getByRole('region', { name: 'Changes' })).toContainElement(document.activeElement as HTMLElement);
  });

  it('gives the block the focus another view asks of History’s timeline', async () => {
    renderShell({ scenario: 'history-too-large', registry: WITH_HISTORY });
    await screen.findByRole('heading', { name: TITLE });

    act(() => {
      showHistory({ kind: 'entry', entry: smallRef('Personal/Todo.txt') });
    });

    expect(useNavigation.getState().view).toBe('history');
    await waitFor(() => {
      expect(document.activeElement).toHaveClass('first-commit');
    });
    expect(screen.getByRole('region', { name: 'History' })).toContainElement(document.activeElement as HTMLElement);
  });

  // A HEAD found too large to show while Changes lists its changes (ipc-m2 §6.1: a store changed
  // elsewhere) turns the view into one panel: the block takes the focus, not the page (WCAG 2.4.3).
  it.each<[string, (user: ReturnType<typeof renderShell>['user']) => Promise<void>]>([
    [
      'a change row',
      async () => {
        const row = await findRow('CSC148/a1/run.bat');
        act(() => {
          row.focus();
        });
      },
    ],
    [
      'the diff',
      async (user) => {
        const row = await findRow('CSC148/a1/run.bat');
        const pane = await screen.findByRole('group', { name: /run\.bat$/ });
        act(() => {
          row.focus();
        });
        await user.keyboard('{Enter}');
        await waitFor(() => {
          expect(pane.contains(document.activeElement)).toBe(true);
        });
      },
    ],
    [
      'the commit box',
      async () => {
        await findRow('CSC148/a1/run.bat');
        act(() => {
          summaryField().focus();
        });
      },
    ],
    [
      'the list’s header',
      async () => {
        await findRow('CSC148/a1/run.bat');
        act(() => {
          screen.getByRole('checkbox', { name: 'Include all changes' }).focus();
        });
      },
    ],
  ])('gives the block the focus %s had when the history turns too large in Changes', async (_, focusPart) => {
    const { shell, user } = renderShell();
    await focusPart(user);
    const before = document.activeElement;
    expect(before).not.toBe(document.body);

    act(() => {
      shell.versioning.state = 'tooLarge';
      shell.versioning.tooLargeFolder = null;
      shell.workspaceChanged();
    });

    expect(await screen.findByRole('heading', { name: TITLE })).toBeInTheDocument();
    expect(screen.getByText("This library's history is larger than Folio can show. Your files are fine.")).toBeInTheDocument();
    expect(before).not.toBeInTheDocument();
    await waitFor(() => {
      expect(document.activeElement).toHaveClass('first-commit');
    });
    expect(screen.getByRole('region', { name: 'Changes' })).toContainElement(document.activeElement as HTMLElement);
  });

  // Folio tries again by itself (ipc-m2 §6.1): a change to the library's entries ends a first
  // commit's tooLarge (the fake shell's `libraryChanged`), and the first commit starts once more.
  describe('when the library changes', () => {
    const SAID = `${TITLE}. ${PHOTOS_TEXT}`;
    const STARTED = 'Your history has started.';

    /** How many times `message` was said. */
    function times(said: readonly string[], message: string): number {
      return said.filter((each) => each === message).length;
    }

    it.each([
      ['', false],
      [' under StrictMode', true],
    ])('says once that a first commit was too large, starts it once more after a change, and never says it failed%s', async (_, strict) => {
      const { shell, invoke } = renderShell({
        scenario: 'history-none',
        jobStepMs: 60_000,
        commitFailure: { code: 'HistoryTooLarge', file: 'Personal/Photos' },
        strict,
      });
      const shown = watchPage();
      const heard = listenPolite();
      await screen.findByRole('heading', { name: STARTING });
      await waitFor(() => {
        expect(starts(invoke)).toHaveLength(1);
      });
      await settle();
      await finishFirstCommit(shell, TITLE);
      expect(screen.getByText(PHOTOS_TEXT)).toBeInTheDocument();
      expect(heard()).toEqual([SAID]);
      expect(starts(invoke)).toHaveLength(1);

      await changeLibrary(shell, invoke, 2, (fake) => {
        fake.addFile('Personal/Plan.md');
      });
      expect(screen.getByRole('heading', { name: STARTING })).toBeInTheDocument();
      expect(starts(invoke)).toHaveLength(2);
      // No block offered to try again by hand (the history's first diff may, once it has started).
      expect(shown('Try again')).toBe(false);
      act(() => {
        shell.finishJobs();
      });
      expect(await screen.findByRole('region', { name: 'Commit' })).toBeInTheDocument();
      await waitFor(() => {
        expect(heard()).toContain(STARTED);
      });
      await settle();
      expect(starts(invoke)).toHaveLength(2);
      expect(times(heard(), SAID)).toBe(1);
      expect(times(heard(), STARTED)).toBe(1);
      expect(heard()[0]).toBe(SAID);
      expect(shown("Couldn't start your history")).toBe(false);
    });

    it('starts the first commit once when a change ends the tooLarge a library opened with, and says nothing on opening', async () => {
      const { shell, invoke } = renderShell({ scenario: 'history-too-large', jobStepMs: 60_000 });
      const heard = listenPolite();
      expect(await screen.findByRole('heading', { name: TITLE })).toBeInTheDocument();
      await settle();
      expect(heard()).toEqual([]);
      expect(starts(invoke)).toEqual([]);

      await changeLibrary(shell, invoke, 1);
      expect(screen.getByRole('heading', { name: STARTING })).toBeInTheDocument();
      expect(starts(invoke)).toEqual([{ request: { summary: 'Start history' } }]);
      act(() => {
        shell.finishJobs();
      });
      expect(await screen.findByRole('region', { name: 'Commit' })).toBeInTheDocument();
      await waitFor(() => {
        expect(heard()).toContain(STARTED);
      });
      await settle();
      expect(starts(invoke)).toHaveLength(1);
      expect(heard()[0]).toBe(STARTED);
      expect(times(heard(), STARTED)).toBe(1);
    });

    it('starts it once under StrictMode in a window that opens with tooLarge at hand (a reload)', async () => {
      const { shell, invoke } = await renderReloaded('history-too-large', 'tooLarge', { strict: true });
      expect(await screen.findByRole('heading', { name: TITLE })).toBeInTheDocument();
      const heard = listenPolite();
      await settle();
      expect(starts(invoke)).toEqual([]);

      await changeLibrary(shell, invoke, 1, (fake) => {
        fake.deleteFile('Personal/Todo.txt');
      });
      expect(screen.getByRole('heading', { name: STARTING })).toBeInTheDocument();
      expect(starts(invoke)).toHaveLength(1);
      act(() => {
        shell.finishJobs();
      });
      expect(await screen.findByRole('region', { name: 'Commit' })).toBeInTheDocument();
      await settle();
      expect(starts(invoke)).toHaveLength(1);
      expect(times(heard(), STARTED)).toBe(1);
    });

    it('neither ends tooLarge nor starts anything after a change of tags only', async () => {
      const { shell, invoke } = renderShell({ scenario: 'history-too-large', jobStepMs: 60_000 });
      expect(await screen.findByRole('heading', { name: TITLE })).toBeInTheDocument();

      let tagged: Awaited<ReturnType<typeof ipc.setEntryTags>> | undefined;
      await act(async () => {
        tagged = await ipc.setEntryTags({ entries: [smallRef('Personal/Todo.txt')], add: ['notes'], remove: [] });
      });
      expect(tagged).toEqual({ status: 'ok', data: { done: 1, failed: [] } });
      await settle();
      await settle();
      expect(screen.getByRole('heading', { name: TITLE })).toBeInTheDocument();
      expect(screen.getByText(PHOTOS_TEXT)).toBeInTheDocument();
      expect(starts(invoke)).toEqual([]);

      // A change to the file itself does end it.
      act(() => {
        shell.editFile('Personal/Todo.txt');
      });
      expect(await screen.findByRole('heading', { name: STARTING })).toBeInTheDocument();
      await waitFor(() => {
        expect(starts(invoke)).toHaveLength(1);
      });
    });

    it.each(['changes', 'history'] as const)(
      'hands the focus from Show in File Explorer to the block when a change ends tooLarge (%s)',
      async (view) => {
        useNavigation.setState({ view });
        const { shell, invoke } = renderShell({ scenario: 'history-too-large', registry: WITH_HISTORY, jobStepMs: 60_000 });
        const button = await screen.findByRole('button', { name: 'Show in File Explorer' });
        act(() => {
          button.focus();
        });
        expect(button).toHaveFocus();

        act(() => {
          shell.editFile('Personal/Todo.txt');
        });
        expect(await screen.findByRole('heading', { name: STARTING })).toBeInTheDocument();
        expect(button).not.toBeInTheDocument();
        await waitFor(() => {
          expect(document.activeElement).toHaveClass('first-commit');
        });
        expect(screen.getByRole('region', { name: view === 'changes' ? 'Changes' : 'History' })).toContainElement(
          document.activeElement as HTMLElement,
        );
        // It stays there while the first commit starts.
        await waitFor(() => {
          expect(starts(invoke)).toHaveLength(1);
        });
        await settle();
        expect(document.activeElement).toHaveClass('first-commit');
      },
    );

    it('counts no tooLarge of another library: one that opens next starts its own first commit once, and says nothing', async () => {
      const { shell, invoke } = renderShell({
        scenario: 'history-none',
        jobStepMs: 60_000,
        commitFailure: { code: 'HistoryTooLarge', file: 'Personal/Photos' },
      });
      await waitFor(() => {
        expect(starts(invoke)).toHaveLength(1);
      });
      await settle();
      await finishFirstCommit(shell, TITLE);
      const heard = listenPolite();

      const next = scenarioFixture('history-none', NOW).fixture.library;
      if (next == null) throw new Error('the history-none scenario has a library');
      act(() => {
        shell.openLibrary(next);
      });
      expect(await screen.findByRole('heading', { name: STARTING })).toBeInTheDocument();
      await waitFor(() => {
        expect(starts(invoke)).toHaveLength(2);
      });
      await settle();
      expect(starts(invoke)).toHaveLength(2);
      expect(screen.queryByRole('heading', { name: TITLE })).toBeNull();
      expect(heard()).toEqual([]);
    });

    it('starts it once more when the job fails and a change ends tooLarge before the UI has read it', async () => {
      const { shell, invoke } = renderShell({
        scenario: 'history-none',
        jobStepMs: 60_000,
        commitFailure: { code: 'HistoryTooLarge', file: 'Personal/Photos' },
      });
      const shown = watchPage();
      await waitFor(() => {
        expect(starts(invoke)).toHaveLength(1);
      });
      await settle();
      // starting → tooLarge → none in one go: each WorkspaceChanged cancels the summary's fetch under
      // way, so the UI reads starting → none and never the tooLarge between them.
      act(() => {
        shell.finishJobs();
        shell.addFile('Personal/Plan.md');
      });
      await waitFor(() => {
        expect(starts(invoke)).toHaveLength(2);
      });
      await settle();
      expect(starts(invoke)).toHaveLength(2);
      expect(shown(TITLE)).toBe(false);

      act(() => {
        shell.finishJobs();
      });
      expect(await screen.findByRole('region', { name: 'Commit' })).toBeInTheDocument();
      await settle();
      expect(starts(invoke)).toHaveLength(2);
      expect(shown("Couldn't start your history")).toBe(false);
    });

    it('does not take the summary it started from for the end of tooLarge when the job fails before the WorkspaceChanged', async () => {
      // WorkspaceChanged comes late, so the job's failure (JobChanged) arrives while the summary
      // still says the `none` the first commit started from.
      const { invoke } = renderShell({
        scenario: 'history-none',
        eventDelayMs: 300,
        commitFailure: { code: 'HistoryTooLarge', file: 'Personal/Photos' },
      });
      expect(await screen.findByRole('heading', { name: TITLE }, { timeout: 3000 })).toBeInTheDocument();
      await settle();
      expect(starts(invoke)).toHaveLength(1);
    });

    it('starts it once more after a change when the failed first commit has left the job list', async () => {
      const { shell, invoke } = renderShell({
        scenario: 'history-none',
        jobStepMs: 60_000,
        commitFailure: { code: 'HistoryTooLarge', file: 'Personal/Photos' },
      });
      await waitFor(() => {
        expect(starts(invoke)).toHaveLength(1);
      });
      await settle();
      await finishFirstCommit(shell, TITLE);
      const failed = shell.jobs().find((job) => job.kind === 'firstCommit');
      expect(failed?.status.state).toBe('failed');

      // list_jobs keeps the last 20 finished jobs (ipc-m1 §13), and so does the UI's list: only the
      // tooLarge → none the UI reads is left to say that the change ended it.
      for (let scan = 0; scan < 20; scan++) {
        act(() => {
          shell.startJob('scan', { cancellable: true, total: 1, finish: () => ({ kind: 'scan', changes: 0, problems: 0 }) });
          shell.finishJobs();
        });
      }
      await settle();
      expect(shell.jobs().some((job) => job.id === failed?.id)).toBe(false);
      expect(screen.getByRole('heading', { name: TITLE })).toBeInTheDocument();
      expect(starts(invoke)).toHaveLength(1);

      await changeLibrary(shell, invoke, 2);
      expect(screen.getByRole('heading', { name: STARTING })).toBeInTheDocument();
      act(() => {
        shell.finishJobs();
      });
      expect(await screen.findByRole('region', { name: 'Commit' })).toBeInTheDocument();
      await settle();
      expect(starts(invoke)).toHaveLength(2);
    });

    describe('when Folio’s own retry is too large again', () => {
      const TOO_LARGE = { code: 'HistoryTooLarge', file: 'Personal/Photos' } as const;

      it('says nothing more when it ends with the same folder', async () => {
        const { shell, invoke } = renderShell({ scenario: 'history-none', jobStepMs: 60_000 });
        vi.spyOn(shell, 'takeCommitFailure').mockReturnValue(TOO_LARGE);
        const heard = listenPolite();
        await waitFor(() => {
          expect(starts(invoke)).toHaveLength(1);
        });
        await finishFirstCommit(shell, TITLE);
        expect(heard()).toEqual([SAID]);

        await changeLibrary(shell, invoke, 2);
        await finishFirstCommit(shell, TITLE);
        await changeLibrary(shell, invoke, 3);
        await finishFirstCommit(shell, TITLE);
        expect(screen.getByText(PHOTOS_TEXT)).toBeInTheDocument();
        expect(heard()).toEqual([SAID]);
      });

      it('says the new block when it ends with another folder', async () => {
        const { shell, invoke } = renderShell({ scenario: 'history-none', jobStepMs: 60_000 });
        const failure = vi.spyOn(shell, 'takeCommitFailure').mockReturnValue(TOO_LARGE);
        const heard = listenPolite();
        await waitFor(() => {
          expect(starts(invoke)).toHaveLength(1);
        });
        await finishFirstCommit(shell, TITLE);

        failure.mockReturnValue({ code: 'HistoryTooLarge', file: `${MAT}/Problem sets` });
        await changeLibrary(shell, invoke, 2);
        await finishFirstCommit(shell, TITLE);
        const text =
          "The folder MAT232 / Problem sets holds more files than Folio's history can keep. Your files are fine. Folio tries again when the library changes, for example after you move some files out of the folder.";
        expect(screen.getByText(text)).toBeInTheDocument();
        expect(heard()).toEqual([SAID, `${TITLE}. ${text}`]);
      });

      it('says nothing for a library that opened too large', async () => {
        const { shell, invoke } = renderShell({ scenario: 'history-too-large', jobStepMs: 60_000 });
        vi.spyOn(shell, 'takeCommitFailure').mockReturnValue(TOO_LARGE);
        const heard = listenPolite();
        expect(await screen.findByRole('heading', { name: TITLE })).toBeInTheDocument();
        await settle();

        await changeLibrary(shell, invoke, 1);
        await finishFirstCommit(shell, TITLE);
        expect(heard()).toEqual([]);
      });

      it('says nothing in a window that opens with tooLarge at hand (a reload)', async () => {
        const { shell, invoke } = await renderReloaded('history-too-large', 'tooLarge');
        vi.spyOn(shell, 'takeCommitFailure').mockReturnValue(TOO_LARGE);
        expect(await screen.findByRole('heading', { name: TITLE })).toBeInTheDocument();
        const heard = listenPolite();
        await settle();

        await changeLibrary(shell, invoke, 1);
        await finishFirstCommit(shell, TITLE);
        expect(heard()).toEqual([]);
      });

      it('says it again after the person tries again', async () => {
        const { shell, invoke, user } = renderShell({ scenario: 'history-none', jobStepMs: 60_000 });
        vi.spyOn(shell, 'takeCommitFailure')
          .mockReturnValueOnce(TOO_LARGE)
          .mockReturnValueOnce({ code: 'DiskFull', file: null })
          .mockReturnValue(TOO_LARGE);
        const heard = listenPolite();
        await waitFor(() => {
          expect(starts(invoke)).toHaveLength(1);
        });
        await finishFirstCommit(shell, TITLE);

        await changeLibrary(shell, invoke, 2);
        await finishFirstCommit(shell, "Couldn't start your history");
        await user.click(screen.getByRole('button', { name: 'Try again' }));
        await waitFor(() => {
          expect(starts(invoke)).toHaveLength(3);
        });
        await settle();
        await finishFirstCommit(shell, TITLE);
        expect(heard()).toEqual([SAID, SAID]);
      });

      it('starts it once more when the retry’s answer comes after its job failed and a change ended that', async () => {
        const { shell, invoke } = renderShell({ scenario: 'history-none', jobStepMs: 60_000 });
        const failure = vi.spyOn(shell, 'takeCommitFailure').mockReturnValue(TOO_LARGE);
        await waitFor(() => {
          expect(starts(invoke)).toHaveLength(1);
        });
        await finishFirstCommit(shell, TITLE);

        const release = holdNextStartAnswer(shell, invoke);
        await changeLibrary(shell, invoke, 2);
        // The retry's job fails too large and a change ends that, all before its answer arrives.
        act(() => {
          shell.finishJobs();
          shell.addFile('Personal/Plan.md');
        });
        await settle();
        expect(shell.versioning.summary().historyState).toBe('none');
        expect(starts(invoke)).toHaveLength(2);

        failure.mockReturnValue(null);
        act(() => {
          release();
        });
        await waitFor(() => {
          expect(starts(invoke)).toHaveLength(3);
        });
        await settle();
        act(() => {
          shell.finishJobs();
        });
        expect(await screen.findByRole('region', { name: 'Commit' })).toBeInTheDocument();
        await settle();
        expect(starts(invoke)).toHaveLength(3);
      });

      it('keeps a later start’s result when an earlier start’s answer comes last', async () => {
        const { shell, invoke } = renderShell({ scenario: 'history-none', jobStepMs: 60_000 });
        const failure = vi.spyOn(shell, 'takeCommitFailure').mockReturnValue(TOO_LARGE);
        await waitFor(() => {
          expect(starts(invoke)).toHaveLength(1);
        });
        await finishFirstCommit(shell, TITLE);

        // Folio's retry, whose answer is held, fails too large again; the next change starts
        // another retry while that answer is still on its way, and it fails for the disk.
        const release = holdNextStartAnswer(shell, invoke);
        await changeLibrary(shell, invoke, 2);
        await finishFirstCommit(shell, TITLE);
        failure.mockReturnValue({ code: 'DiskFull', file: null });
        await changeLibrary(shell, invoke, 3);
        await finishFirstCommit(shell, "Couldn't start your history");

        act(() => {
          release();
        });
        await settle();
        await settle();
        expect(screen.getByRole('heading', { name: "Couldn't start your history" })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
        expect(screen.queryByRole('heading', { name: STARTING })).toBeNull();
        expect(starts(invoke)).toHaveLength(3);
      });
    });
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
