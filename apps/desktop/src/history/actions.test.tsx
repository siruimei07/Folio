// The actions on History's commit entries on the fake shell (handoff workspace-history §7.3, §9.2,
// §7.5, §10, §11): which entries show Edit message and Undo commit, the entry's context menu with
// its disabled reasons, Copy commit ID, Undo commit with its toasts and failures, and the states
// the history's own state brings: read-only, damaged, and not started yet. "Go to Changes" and
// "Show in Changes" lead to the Changes view.
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';

import commitActionsSheet from '../app/CommitActions.css?raw';
import { takeChangesFocus, takeChangeTarget } from '../app/changeTarget';
import { showHistory } from '../app/historyTarget';
import { useNavigation } from '../app/navigation';
import { useToasts } from '../app/toasts';
import { refOf } from '../test/files';
import { emptyHistory } from '../test/history';
import { toastTexts } from '../test/render';
import { showTypes } from './state';
import { findFeed, holdAnswers, renderHistory, renderHostedHistory, resetHistoryPreferences } from './test/render';

resetHistoryPreferences();

beforeEach(() => {
  useToasts.setState({ toasts: [] });
  useNavigation.setState({ view: 'history', dialog: null });
});

const MAT = 'Fall 2026/MAT232 Calculus of Several Variables';
const HEAD = 'MAT232: rewrite the midterm review';
const OLDER = 'MAT232: add 1 file';
const FIRST = 'Start history';

function entry(name: string): HTMLElement {
  return screen.getByRole('article', { name });
}

function buttonsOf(article: HTMLElement): string[] {
  return within(article)
    .queryAllByRole('button')
    .filter((button) => button.closest('.commit-actions') !== null)
    .map((button) => button.getAttribute('aria-label') ?? '');
}

/** The items of the menu open last, with their notes, as they read. */
function menuItems(): string[] {
  const menu = screen.getAllByRole('menu').at(-1);
  if (menu === undefined) throw new Error('no menu is open');
  return [...menu.querySelectorAll('[role^="menuitem"]')].map((item) => item.textContent);
}

/** The toast's action named `label`, pressed. */
function pressToastAction(label: string): void {
  const action = useToasts
    .getState()
    .toasts.flatMap((toast) => toast.actions ?? [])
    .find((candidate) => candidate.label === label);
  if (action === undefined) throw new Error(`no toast action ${label}`);
  act(() => {
    action.onPress();
  });
}

describe('the hover actions', () => {
  it('shows Edit message on commits and Undo commit only on the newest, none on operations', async () => {
    renderHostedHistory();
    await findFeed();

    expect(buttonsOf(entry(HEAD))).toEqual(['Edit message', 'Undo commit']);
    expect(buttonsOf(entry(OLDER))).toEqual(['Edit message']);
    expect(buttonsOf(entry(FIRST))).toEqual(['Edit message']);
    expect(buttonsOf(entry('Edited commit message'))).toEqual([]);
    expect(buttonsOf(entry('Undid commit “ECO101: add demand data”'))).toEqual([]);
    // The entry shows them while the pointer is over it or the focus is in it (CSS).
    expect(entry(HEAD)).toHaveClass('commit-actions-host');
    expect(entry('Edited commit message')).not.toHaveClass('commit-actions-host');
  });

  // Tab reaches them in their place, and a dialog they opened gives the focus back to them (§7.6,
  // decision 57): unseen, never hidden from the focus (no `visibility: hidden`, no `display: none`).
  it('keeps them in the tab order while unseen, and shows them when the focus is in the entry', async () => {
    const style = document.createElement('style');
    style.textContent = commitActionsSheet;
    document.head.append(style);
    onTestFinished(() => {
      style.remove();
    });
    renderHostedHistory();
    await findFeed();
    const head = entry(HEAD);
    const actions = head.querySelector('.commit-actions');
    if (actions === null) throw new Error('no actions');

    for (const element of [actions, ...actions.querySelectorAll('button')]) {
      expect(getComputedStyle(element).visibility).not.toBe('hidden');
      expect(getComputedStyle(element).display).not.toBe('none');
    }
    expect(getComputedStyle(actions).opacity).toBe('0');
    expect(getComputedStyle(actions).pointerEvents).toBe('none');

    const [edit] = within(head).getAllByRole('button', { name: 'Edit message' });
    act(() => {
      edit?.focus();
    });
    expect(getComputedStyle(actions).opacity).toBe('1');
    expect(getComputedStyle(actions).pointerEvents).toBe('auto');
  });

  it('leaves Edit message out while its dialog is not registered', async () => {
    renderHistory();
    await findFeed();
    expect(buttonsOf(entry(HEAD))).toEqual(['Undo commit']);
    fireEvent.contextMenu(entry(HEAD));
    await screen.findByRole('menu');
    expect(menuItems()).toEqual(['Undo commit', 'Copy commit ID']);
  });
});

describe('the entry menu', () => {
  it('opens from Shift+F10 with the commands, the reasons of those refused, and Copy commit ID', async () => {
    const { user } = renderHostedHistory();
    await findFeed();
    act(() => {
      entry(OLDER).focus();
    });

    await user.keyboard('{Shift>}{F10}{/Shift}');
    const menu = await screen.findByRole('menu', { name: `Actions for “${OLDER}”` });
    expect(menuItems()).toEqual(['Edit message', 'Undo commitNot the newest', 'Copy commit ID']);
    await waitFor(() => {
      expect(within(menu).getByRole('menuitem', { name: 'Edit message' })).toHaveFocus();
    });
    const undo = within(menu).getByRole('menuitem', { name: 'Undo commit' });
    expect(undo).toHaveAttribute('aria-disabled', 'true');
    expect(undo).toHaveAccessibleDescription('Not the newest');

    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(entry(OLDER)).toHaveFocus();
    });
  });

  it("says the first commit can't be undone, and copies a commit's whole id", async () => {
    const { shell, user } = renderHostedHistory();
    await findFeed();
    fireEvent.contextMenu(entry(FIRST));
    await screen.findByRole('menu');
    expect(menuItems()).toEqual(['Edit message', 'Undo commitFirst commit', 'Copy commit ID']);

    await user.click(screen.getByRole('menuitem', { name: 'Copy commit ID' }));
    const first = shell.versioning.snapshot().commits[0];
    if (first === undefined) throw new Error('a first commit');
    await waitFor(async () => {
      expect(await navigator.clipboard.readText()).toBe(first.id);
    });
    expect(toastTexts()).toEqual([expect.stringMatching(/^Copied the commit ID [0-9a-f]{7}$/)]);
  });

  it('opens Edit message from the menu', async () => {
    const { user } = renderHostedHistory();
    await findFeed();
    fireEvent.contextMenu(entry(HEAD));
    await user.click(await screen.findByRole('menuitem', { name: 'Edit message' }));
    expect(await screen.findByRole('dialog', { name: 'Edit message' })).toBeInTheDocument();
  });

  it('leaves a file row its own menu', async () => {
    renderHostedHistory();
    await findFeed();
    const [row] = within(entry(HEAD)).getAllByRole('option');
    if (row === undefined) throw new Error('a card row');
    fireEvent.contextMenu(row);
    await screen.findByRole('menu');
    expect(menuItems()).toContain('Restore this version…');
    expect(menuItems()).not.toContain('Copy commit ID');
  });
});

describe('Undo commit', () => {
  it('takes the newest commit back without asking, says so, and offers Show in Changes', async () => {
    const { user } = renderHostedHistory();
    const feed = await findFeed();

    await user.click(within(entry(HEAD)).getByRole('button', { name: 'Undo commit' }));

    await waitFor(() => {
      expect(toastTexts()).toEqual([`Undid “${HEAD}” — Its 1 change is back in Changes.`]);
    });
    expect(await within(feed).findByRole('article', { name: `Undid commit “${HEAD}”` })).toBeInTheDocument();
    expect(within(feed).queryByRole('article', { name: HEAD })).not.toBeInTheDocument();
    // The button went with its entry: the focus stays in the timeline, on the entry now at its place.
    await waitFor(() => {
      expect(document.activeElement?.getAttribute('role') ?? document.activeElement?.tagName.toLowerCase()).toBe('article');
    });
    expect(feed).toContainElement(document.activeElement as HTMLElement);
    // The commit before it is the newest now: it takes Undo commit.
    await waitFor(() => {
      expect(buttonsOf(entry('MAT232: add lecture 12; MAT223: update notes'))).toEqual(['Edit message', 'Undo commit']);
    });

    pressToastAction('Show in Changes');
    expect(useNavigation.getState().view).toBe('changes');
  });

  it('says why when the commit is no longer the newest, and refreshes the history', async () => {
    const { shell, user } = renderHostedHistory();
    await findFeed();
    const invoke = vi.spyOn(shell, 'invoke');
    shell.setFailure('uncommit', 'NotHead');

    await user.click(within(entry(HEAD)).getByRole('button', { name: 'Undo commit' }));

    await waitFor(() => {
      expect(toastTexts()).toEqual([
        "Couldn't undo the commit — Only the newest commit can be undone. Something changed; the list is refreshed.",
      ]);
    });
    await waitFor(() => {
      expect(invoke.mock.calls.filter(([command]) => command === 'list_history').length).toBeGreaterThan(0);
    });
    expect(entry(HEAD)).toBeInTheDocument();
  });

  it("says a commit that can't be undone can't, and sends one request for a double press", async () => {
    const { shell, user } = renderHostedHistory({ latencyMs: 200 });
    await findFeed();
    const invoke = vi.spyOn(shell, 'invoke');
    shell.setFailure('uncommit', 'CannotUncommit');
    const undo = within(entry(HEAD)).getByRole('button', { name: 'Undo commit' });

    await user.dblClick(undo);

    await waitFor(() => {
      expect(toastTexts()).toEqual(["Couldn't undo the commit — This commit can't be undone."]);
    });
    expect(invoke.mock.calls.filter(([command]) => command === 'uncommit')).toHaveLength(1);
  });
});

describe('the history’s state', () => {
  it('says a read-only history is, and disables its actions with the reason', async () => {
    const { user } = renderHostedHistory({ scenario: 'history-read-only' });
    const feed = await findFeed();

    expect(screen.getByText('History is read-only.')).toBeInTheDocument();
    // The read-only lock (library-actions §2.3), not the warning triangle.
    const banner = screen.getByText('History is read-only.').closest('.banner');
    expect(banner?.querySelector('svg.lucide-lock')).not.toBeNull();
    expect(banner?.querySelector('svg.lucide-triangle-alert')).toBeNull();
    expect(
      screen.getByText('A newer version of Folio changed it. Update Folio to edit messages or restore versions.'),
    ).toBeInTheDocument();
    const [edit, undo] = within(entry(HEAD)).getAllByRole('button').filter((button) => button.closest('.commit-actions') !== null);
    expect(edit).toHaveAttribute('aria-disabled', 'true');
    expect(undo).toHaveAttribute('aria-disabled', 'true');

    // Pressing a disabled button opens nothing; focusing it shows why.
    if (edit === undefined) throw new Error('Edit message');
    await user.click(edit);
    expect(screen.queryByRole('dialog', { name: 'Edit message' })).not.toBeInTheDocument();
    act(() => {
      entry(HEAD).focus();
    });
    await user.tab();
    expect(edit).toHaveFocus();
    expect(await screen.findByRole('tooltip')).toHaveTextContent('Edit messageHistory is read-only.');
    expect(edit).toHaveAccessibleDescription('Edit messageHistory is read-only.');

    fireEvent.contextMenu(entry(HEAD));
    await screen.findByRole('menu');
    expect(menuItems()).toEqual(['Edit messageRead-only', 'Undo commitRead-only', 'Copy commit ID']);
    await user.keyboard('{Escape}');

    // Restore: the diff's button and the row's menu item, disabled with the reason.
    const [row] = within(entry(OLDER)).getAllByRole('option');
    if (row === undefined) throw new Error('a card row');
    await user.click(row);
    const diff = screen.getByRole('region', { name: 'Selected version' });
    await waitFor(() => {
      expect(within(diff).getByRole('button', { name: 'Restore' })).toHaveAttribute('aria-disabled', 'true');
    });
    fireEvent.contextMenu(row);
    const restore = await screen.findByRole('menuitem', { name: 'Restore this version…' });
    expect(restore).toHaveAttribute('aria-disabled', 'true');
    expect(restore).toHaveAccessibleDescription('Read-only');
    expect(feed).toBeInTheDocument();
  });

  // §7.5: the banner sits under the header on its own row, whatever the body shows.
  it('keeps the read-only banner while the skeleton or a state takes the timeline’s place', async () => {
    const { shell } = renderHostedHistory({ scenario: 'history-read-only' });
    await findFeed();
    expect(screen.getByText('History is read-only.')).toBeInTheDocument();

    // A file's history loading: the skeleton.
    const answers = holdAnswers(shell, 'list_file_history');
    act(() => {
      showHistory({ kind: 'entry', entry: refOf('Fall 2026/MAT232 Calculus of Several Variables/week 2 notes.md') });
    });
    expect(await screen.findByRole('status', { name: 'Loading the history' })).toBeInTheDocument();
    expect(screen.getByText('History is read-only.')).toBeInTheDocument();
    answers.release();
    await screen.findByRole('feed', { name: 'History of week 2 notes.md, newest first' });

    // A filter that matches nothing: its state.
    act(() => {
      showTypes(['restore']);
    });
    expect(await screen.findByRole('heading', { name: 'Nothing of these types yet' })).toBeInTheDocument();
    expect(screen.getByText('History is read-only.')).toBeInTheDocument();
  });

  it("says Folio can't read a damaged history, and copies the details", async () => {
    const { user } = renderHostedHistory({ scenario: 'history-damaged' });

    expect(await screen.findByRole('heading', { name: "Folio can't read this library's history" })).toBeInTheDocument();
    expect(screen.getByText('Your files are fine. Copy the details and send them to the developer.')).toBeInTheDocument();
    expect(screen.queryByRole('feed')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Copy details' }));
    await waitFor(async () => {
      expect(await navigator.clipboard.readText()).toMatch(/^Folio can't read this library's history\n[\s\S]*HistoryDamaged/);
    });
  });

  it('disables Restore with the reason in a diff kept open when the history turns damaged', async () => {
    const { user, shell } = renderHostedHistory();
    await findFeed();
    const [row] = within(entry(OLDER)).getAllByRole('option');
    if (row === undefined) throw new Error('a card row');
    await user.click(row);
    const diff = screen.getByRole('region', { name: 'Selected version' });
    await waitFor(() => {
      expect(within(diff).getByRole('button', { name: 'Restore' })).not.toHaveAttribute('aria-disabled');
    });

    act(() => {
      shell.versioning.state = 'damaged';
      shell.workspaceChanged();
    });

    expect(await screen.findByRole('heading', { name: "Folio can't read this library's history" })).toBeInTheDocument();
    await waitFor(() => {
      expect(within(diff).getByRole('button', { name: 'Restore' })).toHaveAttribute('aria-disabled', 'true');
    });
    // In the tab order, the reason in its tooltip (read before any key closes it).
    act(() => {
      within(diff).getByRole('radio', { name: 'Changes' }).focus();
    });
    await user.tab();
    const restore = within(diff).getByRole('button', { name: 'Restore' });
    expect(restore).toHaveFocus();
    expect(await screen.findByRole('tooltip')).toHaveTextContent("Folio can't read the history.");
    expect(restore).toHaveAccessibleDescription("Folio can't read the history.");
  });

  it('shows the first commit’s block before the history has started', async () => {
    renderHostedHistory({ scenario: 'history-none' });

    expect(await screen.findByRole('heading', { name: 'Starting your history' })).toBeInTheDocument();
    expect(
      screen.getByText('Your first entry shows up here when Folio has saved the first version of your library.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 2, name: 'History' })).toBeInTheDocument();
    expect(screen.queryByRole('feed')).not.toBeInTheDocument();
  });
});

describe('Go to Changes and Show in Changes', () => {
  it('goes to Changes from an empty history and from a file without history', async () => {
    const { user } = renderHostedHistory({ fixture: emptyHistory() });
    await user.click(await screen.findByRole('button', { name: 'Go to Changes' }));
    expect(useNavigation.getState().view).toBe('changes');
    // Changes takes the focus the hidden button had.
    expect(takeChangesFocus()).toBe(true);

    act(() => {
      showHistory({ kind: 'entry', entry: refOf(`${MAT}/week 2 notes.md`) });
    });
    expect(await screen.findByRole('heading', { name: 'week 2 notes.md has no history yet' })).toBeInTheDocument();
    act(() => {
      useNavigation.setState({ view: 'history' });
    });
    await user.click(screen.getByRole('button', { name: 'Go to Changes' }));
    expect(useNavigation.getState().view).toBe('changes');
    expect(takeChangesFocus()).toBe(true);
  });

  // renderHistory hosts no other view: not registered means hidden (ADR-0005, decision 48).
  it('offers no Go to Changes while Changes is not on the rail', async () => {
    renderHistory({ fixture: emptyHistory() });
    expect(await screen.findByRole('heading', { name: 'No history yet' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Go to Changes' })).not.toBeInTheDocument();

    act(() => {
      showHistory({ kind: 'entry', entry: refOf(`${MAT}/week 2 notes.md`) });
    });
    expect(await screen.findByRole('heading', { name: 'week 2 notes.md has no history yet' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Go to Changes' })).not.toBeInTheDocument();
  });

  it('offers no Show in Changes on the restore’s and the undo’s toasts while Changes is not on the rail', async () => {
    const { user } = renderHistory();
    await findFeed();
    const row = within(entry(HEAD)).getByRole('option', { name: 'MAT232/Exams/Midterm/Midterm review.md, Modified' });
    fireEvent.contextMenu(row);
    await user.click(await screen.findByRole('menuitem', { name: 'Restore this version…' }));
    const dialog = await screen.findByRole('alertdialog');
    const confirm = within(dialog).getByRole('button', { name: 'Restore version' });
    await waitFor(() => {
      expect(confirm).not.toHaveAttribute('aria-disabled');
    });
    await user.click(confirm);
    await waitFor(() => {
      expect(toastTexts()).toContainEqual(expect.stringMatching(/^Restored Midterm review\.md — /));
    });

    await user.click(within(entry(HEAD)).getByRole('button', { name: 'Undo commit' }));
    await waitFor(() => {
      expect(toastTexts()).toContainEqual(expect.stringMatching(/^Undid “/));
    });
    expect(useToasts.getState().toasts.flatMap((toast) => toast.actions ?? []).map((action) => action.label)).not.toContain(
      'Show in Changes',
    );
  });

  it('shows the restored file in Changes from the restore’s toast', async () => {
    const { user } = renderHostedHistory();
    await findFeed();
    const row = within(entry(HEAD)).getByRole('option', { name: 'MAT232/Exams/Midterm/Midterm review.md, Modified' });
    fireEvent.contextMenu(row);
    await user.click(await screen.findByRole('menuitem', { name: 'Restore this version…' }));
    const dialog = await screen.findByRole('alertdialog');
    const confirm = within(dialog).getByRole('button', { name: 'Restore version' });
    await waitFor(() => {
      expect(confirm).not.toHaveAttribute('aria-disabled');
    });
    await user.click(confirm);
    await waitFor(() => {
      expect(toastTexts()).toContainEqual(expect.stringMatching(/^Restored Midterm review\.md — /));
    });

    pressToastAction('Show in Changes');
    expect(useNavigation.getState().view).toBe('changes');
    expect(takeChangeTarget()).toBe(`${MAT}/Exams/Midterm/Midterm review.md`);
  });
});
