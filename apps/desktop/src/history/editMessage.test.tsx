// Edit message (handoff workspace-history §9.1, §11) on the fake shell: the dialog's fields and
// details line, Save message waiting while nothing changed, the message rules checked before
// anything is sent and when the shell answers them, Ctrl+Enter, saving, the toast with the new
// short id, the failure block, a commit gone meanwhile, and each opening starting afresh.
import { act, screen, waitFor, within } from '@testing-library/react';
import { announce as ariaAnnounce } from 'react-aria/private/live-announcer/LiveAnnouncer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { editMessageOf } from '../app/historyCommands';
import { useNavigation } from '../app/navigation';
import { useToasts } from '../app/toasts';
import { shortId } from '../ipc';
import { settle, toastTexts } from '../test/render';
import { useHistoryPreferences } from './preferences';
import {
  findFeed,
  holdAnswers,
  NARROW,
  narrowWindow,
  politeText,
  refuseFocusWhenHidden,
  renderHostedHistory,
  resetHistoryPreferences,
} from './test/render';

resetHistoryPreferences();

beforeEach(() => {
  useToasts.setState({ toasts: [] });
  useNavigation.setState({ view: 'history', dialog: null });
});

const HEAD = 'MAT232: rewrite the midterm review';
const REWORDED = 'MAT223: update exercise 1; MAT232: update the midterm review';
const BODY = 'Exercise 1 gets a third question.\nThe review covers directional derivatives now.';
/** What a commit replaced meanwhile says (`NotFound`), as everywhere. */
const GONE = "This item isn't here anymore. It may have just been moved, renamed or deleted.";

type User = ReturnType<typeof renderHostedHistory>['user'];
type Shell = ReturnType<typeof renderHostedHistory>['shell'];

/**
 * Opens Edit message from an entry's button, once its summary has the focus with its text selected
 * (a frame after it opens): typing then adds to the summary instead of racing that selection.
 */
async function openDialog(user: User, entryName: string): Promise<HTMLElement> {
  await findFeed();
  const entry = screen.getByRole('article', { name: entryName });
  await user.click(within(entry).getByRole('button', { name: 'Edit message' }));
  const dialog = await screen.findByRole('dialog', { name: 'Edit message' });
  await waitFor(() => {
    expect(summary(dialog)).toHaveFocus();
  });
  return dialog;
}

function summary(dialog: HTMLElement): HTMLInputElement {
  return within(dialog).getByRole<HTMLInputElement>('textbox', { name: 'Summary' });
}

function description(dialog: HTMLElement): HTMLTextAreaElement {
  return within(dialog).getByRole<HTMLTextAreaElement>('textbox', { name: 'Description' });
}

function save(dialog: HTMLElement): HTMLElement {
  return within(dialog).getByRole('button', { name: /^(Save message|Saving…)$/ });
}

function rewordsAsked(invoke: { mock: { calls: unknown[][] } }): unknown[] {
  return invoke.mock.calls.filter(([command]) => command === 'reword_commit').map(([, args]) => (args as { request: unknown }).request);
}

function commitId(shell: Shell, summaryText: string): string {
  const found = shell.versioning.snapshot().commits.find((commit) => commit.summary === summaryText);
  if (found === undefined) throw new Error(`no commit ${summaryText}`);
  return found.id;
}

describe('Edit message', () => {
  it('opens on the commit with its summary selected, its description and its details, and waits while nothing changed', async () => {
    const { shell, user } = renderHostedHistory();
    const invoke = vi.spyOn(shell, 'invoke');
    const dialog = await openDialog(user, REWORDED);

    await waitFor(() => {
      expect(summary(dialog)).toHaveFocus();
    });
    expect(summary(dialog).value).toBe(REWORDED);
    expect(summary(dialog).selectionStart).toBe(0);
    expect(summary(dialog).selectionEnd).toBe(REWORDED.length);
    expect(description(dialog).value).toBe(BODY);
    expect(dialog).toHaveTextContent(
      /[0-9a-f]{7} · (Today \d{1,2}:\d{2} [AP]M|[A-Z][a-z]{2} \d{1,2}, \d{1,2}:\d{2} [AP]M) · 2 files\. You can edit a message until the commit is synced\./,
    );
    expect(summary(dialog)).toHaveAccessibleDescription(/You can edit a message until the commit is synced\.$/);
    // Save message is in the tab order but waits: neither a press nor Ctrl+Enter sends anything.
    expect(save(dialog)).toHaveAttribute('aria-disabled', 'true');
    await user.click(save(dialog));
    await user.keyboard('{Control>}{Enter}{/Control}');
    // Spaces at the ends change nothing the shell would store.
    await user.type(summary(dialog), '  ');
    expect(save(dialog)).toHaveAttribute('aria-disabled', 'true');
    expect(rewordsAsked(invoke)).toEqual([]);
    expect(screen.getByRole('dialog', { name: 'Edit message' })).toBeInTheDocument();
  });

  it('saves with Ctrl+Enter: Saving…, ignoring Esc and Ctrl+Enter, then the toast with the new short id and the entry with the new summary', async () => {
    const { shell, user } = renderHostedHistory();
    const answers = holdAnswers(shell, 'reword_commit');
    const id = commitId(shell, HEAD);
    const dialog = await openDialog(user, HEAD);
    await waitFor(() => {
      expect(summary(dialog)).toHaveFocus();
    });

    // Pasted, not typed: user-event types one key at a time, each a few events and a render of the
    // dialog (about 16 ms in jsdom), which a loaded run makes many times longer.
    await user.paste('MAT232: rewrite the review for the midterm');
    await user.click(description(dialog));
    await user.paste('Shorter, with worked examples.');
    expect(save(dialog)).not.toHaveAttribute('aria-disabled');
    await user.keyboard('{Control>}{Enter}{/Control}');

    expect(await within(dialog).findByRole('button', { name: 'Saving…' })).toHaveAttribute('aria-disabled', 'true');
    expect(summary(dialog)).toHaveAttribute('readonly');
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toBeDisabled();
    // While the answer waits: Esc keeps the dialog, and Ctrl+Enter sends nothing more.
    await user.keyboard('{Escape}');
    expect(screen.getByRole('dialog', { name: 'Edit message' })).toBeInTheDocument();
    await user.click(description(dialog));
    await user.keyboard('{Control>}{Enter}{/Control}');
    expect(rewordsAsked(answers.invoke)).toEqual([
      { commit: id, summary: 'MAT232: rewrite the review for the midterm', body: 'Shorter, with worked examples.' },
    ]);
    // The shell has done it: its HistoryChanged has brought the entry with the new id already
    // (hidden from the accessibility tree behind the modal dialog).
    await screen.findByRole('article', { name: 'MAT232: rewrite the review for the midterm', hidden: true });

    answers.release();
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Edit message' })).not.toBeInTheDocument();
    });
    const newId = commitId(shell, 'MAT232: rewrite the review for the midterm');
    expect(toastTexts()).toEqual([
      `Saved the new message — ${shortId(newId)} is now “MAT232: rewrite the review for the midterm”.`,
    ]);
    // The entry it came from has the new id now: that entry takes the focus back.
    await waitFor(() => {
      expect(screen.getByRole('article', { name: 'MAT232: rewrite the review for the midterm' })).toHaveFocus();
    });
  });

  it('gives the focus to the reworded entry when the answer comes before the history’s refresh', async () => {
    const { shell, user } = renderHostedHistory();
    await findFeed();
    const button = within(screen.getByRole('article', { name: HEAD })).getByRole('button', { name: 'Edit message' });
    await user.click(button);
    const dialog = await screen.findByRole('dialog', { name: 'Edit message' });
    await waitFor(() => {
      expect(summary(dialog)).toHaveFocus();
    });
    await user.paste('MAT232: rewrite the review for the midterm');
    const refresh = holdAnswers(shell, 'list_history');

    await user.keyboard('{Control>}{Enter}{/Control}');
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Edit message' })).not.toBeInTheDocument();
    });
    // React Aria gave the focus back to the button the dialog came from, whose entry still shows.
    await waitFor(() => {
      expect(button).toHaveFocus();
    });

    refresh.release();
    await waitFor(() => {
      expect(screen.getByRole('article', { name: 'MAT232: rewrite the review for the midterm' })).toHaveFocus();
    });
  });

  it('leaves the focus where the person put it while the history’s refresh was on its way', async () => {
    const { shell, user } = renderHostedHistory();
    const dialog = await openDialog(user, HEAD);
    // Behind the modal dialog, out of the accessibility tree until it closes.
    const entry = screen.getByRole('article', { name: HEAD, hidden: true });
    const button = within(entry).getByRole('button', { name: 'Edit message', hidden: true });
    await user.paste('MAT232: rewrite the review for the midterm');
    const refresh = holdAnswers(shell, 'list_history');
    await user.keyboard('{Control>}{Enter}{/Control}');
    await waitFor(() => {
      expect(dialog).not.toBeInTheDocument();
    });
    await waitFor(() => {
      expect(button).toHaveFocus();
    });

    // The person moves on before the reworded entry arrives: it does not take the focus back.
    const filter = screen.getByRole('button', { name: /^Filter by type: / });
    act(() => {
      filter.focus();
    });
    refresh.release();

    await screen.findByRole('article', { name: 'MAT232: rewrite the review for the midterm' });
    await settle();
    expect(filter).toHaveFocus();
  });

  it('gives the focus back to the button it came from when nothing changed', async () => {
    const { user } = renderHostedHistory();
    await findFeed();
    const button = within(screen.getByRole('article', { name: HEAD })).getByRole('button', { name: 'Edit message' });
    await user.click(button);
    const dialog = await screen.findByRole('dialog', { name: 'Edit message' });
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => {
      expect(button).toHaveFocus();
    });
  });

  // The menu item it came from has gone with its menu: React Aria leaves the focus on the page.
  it('gives the focus to the commit’s entry when it came from the entry’s menu and closes unsaved', async () => {
    const { user } = renderHostedHistory();
    await findFeed();
    const entry = screen.getByRole('article', { name: HEAD });
    act(() => {
      entry.focus();
    });
    await user.keyboard('{Shift>}{F10}{/Shift}');
    const menu = await screen.findByRole('menu', { name: `Actions for “${HEAD}”` });
    await waitFor(() => {
      expect(within(menu).getByRole('menuitem', { name: 'Edit message' })).toHaveFocus();
    });
    await user.keyboard('{Enter}');
    const dialog = await screen.findByRole('dialog', { name: 'Edit message' });
    await waitFor(() => {
      expect(summary(dialog)).toHaveFocus();
    });

    await user.keyboard('{Escape}');

    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Edit message' })).not.toBeInTheDocument();
    });
    await waitFor(() => {
      expect(screen.getByRole('article', { name: HEAD })).toHaveFocus();
    });
  });

  // Undone behind the dialog: neither the opener nor the commit's entry is left to take the focus.
  it('gives the focus to the timeline when its commit went meanwhile, closed or saved', async () => {
    const { shell, user } = renderHostedHistory();
    const tabStop = () => document.querySelector('.timeline__feed article[tabindex="0"]');
    let dialog = await openDialog(user, HEAD);
    const head = commitId(shell, HEAD);
    await act(async () => {
      await shell.invoke('uncommit', { request: { commit: head } });
    });
    await waitFor(() => {
      expect(screen.queryByRole('article', { name: HEAD, hidden: true })).not.toBeInTheDocument();
    });

    await user.keyboard('{Escape}');

    await waitFor(() => {
      expect(dialog).not.toBeInTheDocument();
    });
    await waitFor(() => {
      expect(tabStop()).toHaveFocus();
    });

    // Saved: the shell answers NotFound, the dialog closes saying so, and the timeline has the focus.
    const next = 'MAT232: add lecture 12; MAT223: update notes';
    dialog = await openDialog(user, next);
    const nextId = commitId(shell, next);
    await act(async () => {
      await shell.invoke('uncommit', { request: { commit: nextId } });
    });
    await waitFor(() => {
      expect(screen.queryByRole('article', { name: next, hidden: true })).not.toBeInTheDocument();
    });
    await user.paste('!');
    await user.keyboard('{Control>}{Enter}{/Control}');

    await waitFor(() => {
      expect(dialog).not.toBeInTheDocument();
    });
    expect(toastTexts()).toEqual([GONE]);
    await waitFor(() => {
      expect(tabStop()).toHaveFocus();
    });
  });

  // Opened from the toast after a template commit while a narrow window's diff covers the list: the
  // commit's entry is under the cover, which the browser refuses the focus to (as Chromium does).
  it('gives the focus to the diff over the list when the commit’s entry under it cannot take it', async () => {
    refuseFocusWhenHidden();
    narrowWindow();
    const { shell, user } = renderHostedHistory({ layout: NARROW });
    await findFeed();
    const [row] = await screen.findAllByRole('option', { name: 'MAT232/Exams/Midterm/Midterm review.md, Modified' });
    if (row === undefined) throw new Error('no row');
    act(() => {
      row.focus();
    });
    await user.keyboard('{Enter}');
    const diff = screen.getByRole('region', { name: 'Selected version' });
    act(() => {
      (document.activeElement as HTMLElement | null)?.blur();
    });
    act(() => {
      editMessageOf(commitId(shell, HEAD));
    });
    const dialog = await screen.findByRole('dialog', { name: 'Edit message' });
    await waitFor(() => {
      expect(summary(dialog)).toHaveFocus();
    });

    await user.keyboard('{Escape}');

    await waitFor(() => {
      expect(dialog).not.toBeInTheDocument();
    });
    await waitFor(() => {
      expect(diff).toContainElement(document.activeElement as HTMLElement | null);
    });
  });

  // The type filter leaves the reworded commit out, so its entry never shows: after the wait for it
  // (3 s), the view takes the focus. The test's budget covers that wait.
  it('gives the focus to the view when the reworded commit never shows there', { timeout: 10_000 }, async () => {
    useHistoryPreferences.setState({ types: ['restore'] });
    const { shell, user } = renderHostedHistory();
    const showAll = await screen.findByRole('button', { name: 'Show all types' });
    act(() => {
      editMessageOf(commitId(shell, HEAD));
    });
    const dialog = await screen.findByRole('dialog', { name: 'Edit message' });
    await waitFor(() => {
      expect(summary(dialog)).toHaveFocus();
    });

    await user.paste('MAT232: rewrite the review');
    await user.keyboard('{Control>}{Enter}{/Control}');

    await waitFor(() => {
      expect(dialog).not.toBeInTheDocument();
    });
    expect(showAll).not.toHaveFocus();
    await waitFor(
      () => {
        expect(showAll).toHaveFocus();
      },
      { timeout: 5000 },
    );
  });

  it('says what is wrong with a message under its field, before anything is sent', async () => {
    const { shell, user } = renderHostedHistory();
    const invoke = vi.spyOn(shell, 'invoke');
    const dialog = await openDialog(user, HEAD);

    await user.clear(summary(dialog));
    await user.click(save(dialog));
    expect(within(dialog).getByText('Enter a summary.')).toBeInTheDocument();
    expect(summary(dialog)).toHaveAttribute('aria-invalid', 'true');
    expect(summary(dialog)).toHaveAccessibleDescription(/^Enter a summary\. /);
    expect(summary(dialog)).toHaveFocus();
    // Typing clears it.
    await user.type(summary(dialog), 'x');
    expect(within(dialog).queryByText('Enter a summary.')).not.toBeInTheDocument();

    await user.clear(summary(dialog));
    await user.paste('a'.repeat(257));
    await user.click(save(dialog));
    expect(within(dialog).getByText('A summary can be up to 256 characters.')).toBeInTheDocument();

    await user.clear(summary(dialog));
    await user.click(summary(dialog));
    await user.paste('Tab\there');
    await user.click(save(dialog));
    expect(within(dialog).getByText("A summary can't contain line breaks or control characters.")).toBeInTheDocument();

    await user.clear(summary(dialog));
    await user.type(summary(dialog), 'Fine');
    await user.click(description(dialog));
    await user.paste('Bell \u0007 here');
    await user.click(save(dialog));
    expect(within(dialog).getByText("A description can't contain control characters other than tabs and line breaks.")).toBeInTheDocument();
    expect(description(dialog)).toHaveAttribute('aria-invalid', 'true');
    expect(description(dialog)).toHaveFocus();
    expect(rewordsAsked(invoke)).toEqual([]);
  });

  it('announces the error of the field Ctrl+Enter came from, which has the focus already', async () => {
    const { shell, user } = renderHostedHistory();
    const invoke = vi.spyOn(shell, 'invoke');
    const dialog = await openDialog(user, HEAD);
    // React Aria's own live region, first in the page once it has announced anything (a pending
    // button), says something else: the app's region is the one read.
    ariaAnnounce('Something React Aria says', 'polite');

    await user.clear(summary(dialog));
    await user.keyboard('{Control>}{Enter}{/Control}');
    expect(within(dialog).getByText('Enter a summary.')).toBeInTheDocument();
    expect(summary(dialog)).toHaveFocus();
    await waitFor(() => {
      expect(politeText()).toBe('Enter a summary.');
    });

    await user.paste('Fine');
    await user.click(description(dialog));
    await user.paste('Bell \u0007 here');
    await user.keyboard('{Control>}{Enter}{/Control}');
    expect(description(dialog)).toHaveFocus();
    await waitFor(() => {
      expect(politeText()).toBe("A description can't contain control characters other than tabs and line breaks.");
    });
    expect(rewordsAsked(invoke)).toEqual([]);

    // A rule the shell answers, in the field that still has the focus.
    await user.clear(description(dialog));
    shell.setFailure('reword_commit', 'SummaryInvalid');
    await user.click(summary(dialog));
    await user.keyboard('{Control>}{Enter}{/Control}');
    await waitFor(() => {
      expect(politeText()).toBe("A summary can't contain line breaks or control characters.");
    });
    expect(summary(dialog)).toHaveFocus();
  });

  it('shows a rule the shell answers under its field', async () => {
    const { shell, user } = renderHostedHistory();
    const dialog = await openDialog(user, HEAD);
    shell.setFailure('reword_commit', 'SummaryInvalid');
    await user.type(summary(dialog), '!');
    await user.click(save(dialog));
    expect(await within(dialog).findByText("A summary can't contain line breaks or control characters.")).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'Edit message' })).toBeInTheDocument();
  });

  it.each([
    ['CannotReword', "This commit's message can't be changed.", false],
    ['HistoryReadOnly', 'A newer version of Folio changed this library.', false],
    ['HistoryBusy', null, false],
    ['Internal', null, true],
  ] as const)('keeps the dialog with the danger block when it fails with %s', async (code, reason, details) => {
    const { shell, user } = renderHostedHistory();
    const dialog = await openDialog(user, HEAD);
    shell.setFailure('reword_commit', code);
    await user.type(summary(dialog), '!');
    await user.click(save(dialog));

    const alert = await within(dialog).findByRole('alert');
    expect(alert).toHaveTextContent("Couldn't save the message");
    if (reason !== null) expect(alert).toHaveTextContent(reason);
    expect(within(alert).queryByRole('button', { name: 'Copy details' }) !== null).toBe(details);
    expect(summary(dialog).value).toBe(`${HEAD}!`);
    expect(save(dialog)).toHaveTextContent('Save message');

    // Fixed meanwhile: saving again works.
    shell.setFailure('reword_commit', null);
    await user.click(save(dialog));
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Edit message' })).not.toBeInTheDocument();
    });
  });

  it('closes, saying so, when the commit was replaced meanwhile', async () => {
    const { shell, user } = renderHostedHistory();
    const dialog = await openDialog(user, HEAD);
    shell.setFailure('reword_commit', 'NotFound');
    await user.type(summary(dialog), '!');
    await user.click(save(dialog));
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Edit message' })).not.toBeInTheDocument();
    });
    expect(toastTexts()).toEqual([GONE]);
  });

  it('starts afresh each time it opens, and Cancel changes nothing', async () => {
    const { shell, user } = renderHostedHistory();
    const invoke = vi.spyOn(shell, 'invoke');
    let dialog = await openDialog(user, HEAD);
    await user.type(summary(dialog), ' draft');
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Edit message' })).not.toBeInTheDocument();
    });

    dialog = await openDialog(user, HEAD);
    expect(summary(dialog).value).toBe(HEAD);
    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Edit message' })).not.toBeInTheDocument();
    });
    expect(rewordsAsked(invoke)).toEqual([]);
  });

  it('opens on a commit known by its id, as the toast after a template commit does', async () => {
    const { shell } = renderHostedHistory();
    await findFeed();
    act(() => {
      editMessageOf(commitId(shell, HEAD));
    });
    const dialog = await screen.findByRole('dialog', { name: 'Edit message' });
    expect(summary(dialog).value).toBe(HEAD);

    // A commit replaced meanwhile says it is gone instead.
    act(() => {
      useNavigation.setState({ dialog: null });
    });
    act(() => {
      editMessageOf(`b3:${'0'.repeat(64)}`);
    });
    await waitFor(() => {
      expect(toastTexts()).toEqual([GONE]);
    });

    // Any other failure says the message could not be opened, and why.
    act(() => {
      useToasts.setState({ toasts: [] });
    });
    shell.setFailure('get_commit', 'Internal');
    act(() => {
      editMessageOf(commitId(shell, HEAD));
    });
    await waitFor(() => {
      expect(toastTexts()).toEqual([
        "Couldn't open the commit's message — Something went wrong inside Folio. Restart Folio. If this keeps happening, send the error details to the developer.",
      ]);
    });
    expect(screen.queryByRole('dialog', { name: 'Edit message' })).not.toBeInTheDocument();
  });
});
