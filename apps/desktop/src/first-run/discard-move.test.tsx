// "Discard move" on the unavailable screen for an unfinished move (first-run handoff §7, ipc-m1
// §6): the alert dialog that asks first, the answer the page follows, and each failure, which
// shows under the folder and changes nothing.
import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import errors from '../i18n/locales/en/errors.json';
import copy from '../i18n/locales/en/first-run.json';
import shellCopy from '../i18n/locales/en/shell.json';
import { startFixture } from '../test/fixtures';
import { LIBRARY_VIEW, pageHeading, renderStart } from './test/render';

const discard = copy.unavailable.discard;
const title = copy.unavailable.unfinishedMove.title;

function renderMove(options: Parameters<typeof renderStart>[0] = {}) {
  return renderStart({ fixture: startFixture('unavailable', { reason: 'unfinishedMove' }), ...options });
}

function discardButton(): HTMLElement {
  return screen.getByRole('button', { name: discard.action });
}

function dialog(): HTMLElement {
  return screen.getByRole('alertdialog', { name: discard.title });
}

/**
 * Holds the shell's answer to `command` until `release()`: the shell acts at once, and its
 * events arrive, but the call waits.
 */
function holdAnswers(shell: ReturnType<typeof renderStart>['shell'], command: string): { release: () => void } {
  const invoke = shell.invoke.bind(shell);
  const held: (() => void)[] = [];
  shell.invoke = (name, payload) => {
    const answer = invoke(name, payload);
    if (name !== command) return answer;
    // A failure is passed on at release; until then it is not unhandled.
    answer.catch(() => undefined);
    return new Promise((resolve) => {
      held.push(() => {
        resolve(answer);
      });
    });
  };
  return {
    release: () => {
      for (const answer of held.splice(0)) answer();
    },
  };
}

/** How often the page asked the shell to discard the move. */
function discardCalls(shell: ReturnType<typeof renderStart>['shell']): () => number {
  const invoke = vi.spyOn(shell, 'invoke');
  return () => invoke.mock.calls.filter(([command]) => command === 'discard_unfinished_move').length;
}

describe('discard an unfinished move', () => {
  it('offers "Discard move…" first, then "Try again"', () => {
    renderMove();

    expect(pageHeading()).toHaveTextContent(title);
    expect(screen.getByText(copy.unavailable.unfinishedMove.text)).toBeInTheDocument();
    expect(discardButton()).toHaveAttribute('data-variant', 'accent');
    expect(screen.getByRole('button', { name: copy.unavailable.tryAgain })).toHaveAttribute('data-variant', 'outline');
    expect(screen.queryByRole('button', { name: shellCopy.copyDetails.action })).toBeNull();
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('asks first in an alert dialog that says what goes and what stays, Cancel focused', async () => {
    const { user, shell } = renderMove();
    const calls = discardCalls(shell);
    await user.click(discardButton());

    expect(dialog()).toHaveAccessibleDescription(discard.text);
    expect(within(dialog()).getByText(discard.check)).toBeInTheDocument();
    await waitFor(() => {
      expect(within(dialog()).getByRole('button', { name: discard.cancel })).toHaveFocus();
    });
    expect(within(dialog()).getByRole('button', { name: discard.confirm })).toHaveAttribute('data-variant', 'danger');
    expect(calls()).toBe(0);
  });

  it.each([
    ['Cancel', 'button'],
    ['Esc', 'key'],
  ] as const)('%s closes the dialog, changes nothing and returns focus to the button', async (_name, how) => {
    const { user, shell } = renderMove();
    const calls = discardCalls(shell);
    await user.click(discardButton());
    await waitFor(() => {
      expect(within(dialog()).getByRole('button', { name: discard.cancel })).toHaveFocus();
    });

    if (how === 'button') await user.click(within(dialog()).getByRole('button', { name: discard.cancel }));
    else await user.keyboard('{Escape}');

    await waitFor(() => {
      expect(screen.queryByRole('alertdialog')).toBeNull();
    });
    await waitFor(() => {
      expect(discardButton()).toHaveFocus();
    });
    expect(pageHeading()).toHaveTextContent(title);
    expect(calls()).toBe(0);
  });

  it('discards the move after confirming, and the library opens', async () => {
    const { user, shell } = renderMove();
    const calls = discardCalls(shell);
    await user.click(discardButton());
    await user.click(within(dialog()).getByRole('button', { name: discard.confirm }));

    expect(await screen.findByText(LIBRARY_VIEW)).toBeInTheDocument();
    expect(calls()).toBe(1);
    expect(shell.status()).toMatchObject({ state: 'open' });
  });

  // A discard that works opens the library by LibraryStateChanged, which overtakes the answer; a
  // failure has no event, so the wait shows until the answer.
  it('keeps the dialog while the command runs: the button spins, Cancel and Esc wait', async () => {
    const { user, shell } = renderMove({ fail: [{ command: 'discard_unfinished_move', code: 'InUse' }] });
    const answers = holdAnswers(shell, 'discard_unfinished_move');
    await user.click(discardButton());
    await user.click(within(dialog()).getByRole('button', { name: discard.confirm }));

    expect(within(dialog()).getByRole('button', { name: discard.discarding })).toBeInTheDocument();
    expect(within(dialog()).getByRole('button', { name: discard.cancel })).toBeDisabled();
    await user.keyboard('{Escape}');
    expect(dialog()).toBeInTheDocument();

    answers.release();
    expect(await screen.findByRole('alert')).toHaveTextContent(discard.errors.InUse);
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('follows a new reason: its page shows, its title focused', async () => {
    const { user, shell } = renderMove();
    // Discarding worked, but the library could not be opened again.
    const discardMove = shell.discardUnfinishedMove.bind(shell);
    vi.spyOn(shell, 'discardUnfinishedMove').mockImplementation(() => {
      discardMove();
      shell.makeUnavailable('missing');
    });
    await user.click(discardButton());
    await user.click(within(dialog()).getByRole('button', { name: discard.confirm }));

    const missing = await screen.findByRole('heading', { level: 1, name: copy.unavailable.missing.title });
    await waitFor(() => {
      expect(missing).toHaveFocus();
    });
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(document.querySelector('[aria-live="polite"][aria-atomic="true"]')).toHaveTextContent(copy.unavailable.missing.title);
  });

  it('stays when the shell answers the same status, a stale screen or a second press', async () => {
    const { user, shell } = renderMove();
    vi.spyOn(shell, 'discardUnfinishedMove').mockImplementation(() => undefined);
    const announced = document.querySelector('[aria-live="polite"][aria-atomic="true"] span');
    await user.click(discardButton());
    await user.click(within(dialog()).getByRole('button', { name: discard.confirm }));

    await waitFor(() => {
      expect(screen.queryByRole('alertdialog')).toBeNull();
    });
    await waitFor(() => {
      expect(discardButton()).toHaveFocus();
    });
    expect(pageHeading()).toHaveTextContent(title);
    expect(screen.queryByRole('alert')).toBeNull();
    // The title is read again: a new announcement, not the page's first one.
    const again = document.querySelector('[aria-live="polite"][aria-atomic="true"] span');
    expect(again).toHaveTextContent(title);
    expect(again).not.toBe(announced);
  });
});

describe('a discard that fails', () => {
  const ROOT = 'E:\\University of Toronto';

  it.each([
    ['InUse', discard.errors.InUse, false],
    ['AccessDenied', discard.errors.AccessDenied, false],
    ['DiskFull', discard.errors.DiskFull.replace('{{drive}}', 'E:'), false],
    ['NewerFormat', discard.errors.NewerFormat, false],
    ['Busy', discard.errors.Busy, false],
    ['NotFound', discard.errors.other, true],
    ['FileSystem', discard.errors.other, true],
    ['Internal', discard.errors.other, true],
    ['DataDirUnavailable', discard.errors.other, true],
  ] as const)('%s shows under the folder and changes nothing', async (code, text, details) => {
    const { user, shell } = renderMove({ fail: [{ command: 'discard_unfinished_move', code }] });
    await user.click(discardButton());
    await user.click(within(dialog()).getByRole('button', { name: discard.confirm }));

    const banner = await screen.findByRole('alert');
    expect(banner).toHaveTextContent(discard.failed);
    expect(banner).toHaveTextContent(text);
    expect(within(banner).queryByRole('button', { name: shellCopy.copyDetails.action }) !== null).toBe(details);
    expect(screen.queryByRole('alertdialog')).toBeNull();
    await waitFor(() => {
      expect(discardButton()).toHaveFocus();
    });
    expect(pageHeading()).toHaveTextContent(title);
    expect(shell.status()).toMatchObject({ state: 'unavailable', reason: 'unfinishedMove', root: ROOT });
  });

  it('says when the window cannot reach the shell, with the details to copy', async () => {
    const { user, shell } = renderMove();
    const invoke = shell.invoke.bind(shell);
    shell.invoke = (command, payload) =>
      command === 'discard_unfinished_move' ? Promise.reject(new Error('not allowed')) : invoke(command, payload);
    await user.click(discardButton());
    await user.click(within(dialog()).getByRole('button', { name: discard.confirm }));

    const banner = await screen.findByRole('alert');
    expect(banner).toHaveTextContent(errors.Transport);
    await user.click(within(banner).getByRole('button', { name: shellCopy.copyDetails.action }));
    await waitFor(async () => {
      expect(await navigator.clipboard.readText()).toContain('Transport');
    });
  });

  it('keeps the record, so a new attempt clears the failure and discards it', async () => {
    const { user, shell } = renderMove({ fail: [{ command: 'discard_unfinished_move', code: 'InUse' }] });
    await user.click(discardButton());
    await user.click(within(dialog()).getByRole('button', { name: discard.confirm }));
    expect(await screen.findByRole('alert')).toHaveTextContent(discard.errors.InUse);

    shell.setFailure('discard_unfinished_move', null);
    await user.click(discardButton());
    await user.click(within(dialog()).getByRole('button', { name: discard.confirm }));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(await screen.findByText(LIBRARY_VIEW)).toBeInTheDocument();
  });
});
