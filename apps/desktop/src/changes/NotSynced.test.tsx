// "Not synced" (workspace-history handoff §5, §14) on the fake shell: the newest three commits and
// how many there are, the commit that has just arrived on its soft background for
// FRESH_COMMIT_MS, the card with no commits, and none of it in a narrow window.
import { act, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';

import { formatDateTime, formatTime } from '../lib/format';
import { FRESH_COMMIT_MS } from '../lib/timing';
import { NOW } from '../test/data';
import { renderApp } from '../test/render';
import { NotSynced } from './NotSynced';
import { findRow, holdRequests, politeText, renderChanges, resizeTo } from './test/render';

const DAY_MS = 24 * 60 * 60 * 1000;

type FakeShell = ReturnType<typeof renderChanges>['shell'];

function card(): HTMLElement {
  return screen.getByRole('region', { name: 'Not synced' });
}

async function newestCommits(): Promise<HTMLElement> {
  return screen.findByRole('list', { name: 'Newest commits' });
}

/** The newest commit of HEAD's chain, as the fake shell has it. */
function newest(shell: FakeShell) {
  const [item] = shell.versioning.historyPage({ offset: 0, limit: 1 }, ['commit']).items;
  if (item?.kind !== 'commit') throw new Error('no commit');
  return item.commit;
}

/** Commits every change of the fake workspace at once, as a commit job would when it ends. */
function commitEverything(shell: FakeShell, summary: string): void {
  const versioning = shell.versioning;
  act(() => {
    const plan = versioning.beginCommit({
      selection: { kind: 'allExcept', keys: [] },
      fingerprint: versioning.fingerprint(),
      base: versioning.summary().head,
      summary,
      body: null,
    });
    versioning.recordCommit(plan);
  });
}

afterEach(() => {
  delete document.documentElement.dataset.reduceMotion;
});

describe('Not synced', () => {
  it('lists the newest three commits with their short ids and times, and counts every commit', async () => {
    const { shell } = renderChanges();
    const list = await newestCommits();
    expect(within(card()).getByRole('img', { name: '6 commits not synced' })).toHaveTextContent('6');
    expect(within(card()).getByText('Cloud sync comes in a later version. Until then, commits stay on this computer.')).toBeInTheDocument();
    expect(within(card()).getByText('Your commit goes here')).toBeInTheDocument();

    const items = within(list).getAllByRole('listitem');
    expect(items.map((item) => item.querySelector('.not-synced__summary')?.textContent)).toEqual([
      'MAT232: rewrite the midterm review',
      'MAT232: add lecture 12; MAT223: update notes',
      'MAT223: update exercise 1; MAT232: update the midterm review',
    ]);
    const top = newest(shell);
    expect(items[0]).toHaveTextContent(`${top.id.slice(3, 10)} · ${formatDateTime(Number(top.timeMs), 'en', NOW)}`);
    expect(Number(top.timeMs)).toBeLessThan(NOW - DAY_MS);
    expect(items.some((item) => item.hasAttribute('data-fresh'))).toBe(false);
  });

  it('puts a commit that has just arrived on top, fresh for FRESH_COMMIT_MS also with reduced motion, timed today', async () => {
    vi.useFakeTimers({ now: NOW, shouldAdvanceTime: true });
    onTestFinished(() => {
      vi.useRealTimers();
    });
    document.documentElement.dataset.reduceMotion = 'on';
    const { shell } = renderChanges();
    const list = await newestCommits();

    commitEverything(shell, 'Add the week 5 notes');
    const summary = await within(list).findByText('Add the week 5 notes');
    const item = summary.closest('li');
    if (item === null) throw new Error('no commit row');
    expect(item).toHaveAttribute('data-fresh');
    expect(item).toHaveTextContent(`${newest(shell).id.slice(3, 10)} · Today ${formatTime(NOW, 'en')}`);
    expect(within(list).getAllByRole('listitem')).toHaveLength(3);
    expect(within(card()).getByRole('img', { name: '7 commits not synced' })).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(FRESH_COMMIT_MS - 400);
    });
    expect(item).toHaveAttribute('data-fresh');
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(item).not.toHaveAttribute('data-fresh');
  });

  it('stops calling a commit "Today" once midnight has passed, though the view stays mounted', async () => {
    vi.useFakeTimers({ now: NOW, shouldAdvanceTime: true });
    onTestFinished(() => {
      vi.useRealTimers();
    });
    const { shell } = renderChanges();
    const list = await newestCommits();
    commitEverything(shell, 'Add the week 5 notes');
    const item = (await within(list).findByText('Add the week 5 notes')).closest('li');
    if (item === null) throw new Error('no commit row');
    const committedAt = Number(newest(shell).timeMs);
    expect(item).toHaveTextContent(`Today ${formatTime(committedAt, 'en')}`);
    const midnight = new Date(Date.now());
    midnight.setHours(24, 0, 0, 0);
    act(() => {
      vi.advanceTimersByTime(midnight.getTime() - Date.now() + 1000);
    });
    expect(item).not.toHaveTextContent('Today');
    expect(item).toHaveTextContent(formatDateTime(committedAt, 'en', Date.now()));
  });

  it('does not count an edited message or an undone commit as new', async () => {
    const { shell } = renderChanges();
    const list = await newestCommits();

    act(() => {
      shell.versioning.reword(newest(shell).id, 'MAT232: rewrite the review', null);
    });
    const reworded = await within(list).findByText('MAT232: rewrite the review');
    expect(reworded.closest('li')).not.toHaveAttribute('data-fresh');

    act(() => {
      shell.versioning.uncommit(newest(shell).id);
    });
    await waitFor(() => {
      expect(within(list).queryByText('MAT232: rewrite the review')).toBeNull();
    });
    expect(within(card()).getByRole('img', { name: '5 commits not synced' })).toBeInTheDocument();
    expect(within(list).getAllByRole('listitem').some((item) => item.hasAttribute('data-fresh'))).toBe(false);
  });

  it('shows only its sentence before the first commit', async () => {
    renderApp(<NotSynced />, { scenario: 'history-none', now: NOW });
    expect(await screen.findByRole('img', { name: '0 commits not synced' })).toBeInTheDocument();
    expect(within(card()).getByText('Cloud sync comes in a later version. Until then, commits stay on this computer.')).toBeInTheDocument();
    expect(screen.queryByRole('list')).toBeNull();
    expect(screen.queryByText('Your commit goes here')).toBeNull();
  });

  it('says when the commits could not be loaded, and loads them again', async () => {
    const { shell, user } = renderApp(<NotSynced />, { now: NOW, fail: [{ command: 'list_history', code: 'Internal' }] });
    expect(await screen.findByText("Couldn't load your commits.")).toBeInTheDocument();
    expect(within(card()).getByRole('img', { name: 'Number of commits unknown' })).toHaveTextContent('–');
    shell.setFailure('list_history', null);
    await user.click(within(card()).getByRole('button', { name: 'Try again' }));
    expect(await newestCommits()).toBeInTheDocument();
  });

  it('keeps the focus on Try again while the commits load again, says when they fail again, then gives it to its heading', async () => {
    const { shell, user } = renderChanges({ fail: [{ command: 'list_history', code: 'Internal' }] });
    const notSynced = await screen.findByRole('region', { name: 'Not synced' });
    const tryAgain = await within(notSynced).findByRole('button', { name: 'Try again' });
    act(() => {
      tryAgain.focus();
    });
    // The read waits: the failure and its button stay, with the focus.
    const { release } = holdRequests(shell, (command) => command === 'list_history');
    await user.keyboard('{Enter}');
    await act(() => new Promise((resolve) => setTimeout(resolve, 300)));
    expect(tryAgain).toHaveFocus();
    // It fails again: nothing on screen changes, so the failure is read out again.
    act(() => {
      release();
    });
    await waitFor(() => {
      expect(politeText()).toBe("Couldn't load your commits.");
    });
    expect(tryAgain).toHaveFocus();
    // Then it works: the commits come, and the card's heading takes the focus the button had.
    shell.setFailure('list_history', null);
    await user.keyboard('{Enter}');
    expect(await within(notSynced).findByRole('list', { name: 'Newest commits' })).toBeInTheDocument();
    await waitFor(() => {
      expect(within(notSynced).getByRole('heading', { name: 'Not synced' })).toHaveFocus();
    });
  });

  it('is not shown in a narrow window', async () => {
    resizeTo(600);
    onTestFinished(() => {
      resizeTo(1024);
    });
    renderChanges();
    await findRow('CSC148/a1/run.bat');
    expect(screen.queryByRole('region', { name: 'Not synced' })).toBeNull();
  });
});
