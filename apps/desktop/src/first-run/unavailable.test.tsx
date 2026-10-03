// The full-window states (first-run handoff §2, §7): a library that cannot be opened, at start-up
// or while Folio runs, and the failures before any library state; also the wait for the status.
import { act, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { openDialog, useNavigation } from '../app/navigation';
import { keys } from '../data/keys';
import errors from '../i18n/locales/en/errors.json';
import copy from '../i18n/locales/en/first-run.json';
import shellCopy from '../i18n/locales/en/shell.json';
import type { Unavailable } from '../ipc';
import { folderChoice, startFixture } from '../test/fixtures';
import { OPENING_DELAY_MS } from '../lib/timing';
import { LIBRARY_VIEW, pageHeading, renderStart } from './test/render';

const ROOT = 'E:\\University of Toronto';

function actions(): string[] {
  return Array.from(document.querySelectorAll('.state-page__actions button'), (button) => button.textContent);
}

function accent(): string | null | undefined {
  return document.querySelector('.state-page__actions [data-variant="accent"]')?.textContent;
}

const REASONS: [Unavailable, string[], string, boolean][] = [
  ['missing', [copy.unavailable.locate, copy.unavailable.tryAgain], copy.unavailable.locate, true],
  ['notALibrary', [copy.unavailable.tryAgain, copy.unavailable.locate], copy.unavailable.tryAgain, true],
  ['newerFormat', [copy.unavailable.tryAgain], copy.unavailable.tryAgain, true],
  ['accessDenied', [copy.unavailable.tryAgain, copy.unavailable.locate], copy.unavailable.tryAgain, false],
  ['catalogFailed', [copy.unavailable.tryAgain, shellCopy.copyDetails.action], copy.unavailable.tryAgain, false],
  ['unfinishedMove', [copy.unavailable.discard.action, copy.unavailable.tryAgain], copy.unavailable.discard.action, false],
];

describe('library unavailable', () => {
  it.each(REASONS)('says why for %s, with the folder and what to do', async (reason, buttons, main, startNew) => {
    renderStart({ fixture: startFixture('unavailable', { reason }) });

    const title = copy.unavailable[reason].title;
    expect(pageHeading()).toHaveTextContent(title);
    expect(screen.getByText(copy.unavailable[reason].text)).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: copy.unavailable.pathLabel })).toHaveValue(ROOT);
    expect(screen.getByRole('textbox', { name: copy.unavailable.pathLabel })).toHaveAttribute('readonly');
    expect(actions()).toEqual(buttons);
    expect(accent()).toBe(main);
    expect(screen.queryByRole('button', { name: copy.unavailable.startNew }) !== null).toBe(startNew);
    // The title takes focus and the polite live region reads it (§7, §9).
    await waitFor(() => {
      expect(pageHeading()).toHaveFocus();
    });
    expect(document.querySelector('[aria-live="polite"]')).toHaveTextContent(title);
    expect(document.title).toBe(`${title} — Folio`);
  });

  it('"Try again" stays when the library is still unavailable, and reads the title again', async () => {
    const { user } = renderStart({ fixture: startFixture('unavailable', { reason: 'missing' }) });
    await user.click(screen.getByRole('button', { name: copy.unavailable.tryAgain }));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: copy.unavailable.tryAgain })).toBeInTheDocument();
    });
    expect(pageHeading()).toHaveTextContent(copy.unavailable.missing.title);
  });

  it('"Try again" opens the library once it can be reached', async () => {
    const { user, shell } = renderStart({ fixture: startFixture('unavailable', { reason: 'missing' }) });
    shell.makeReachable();
    await user.click(screen.getByRole('button', { name: copy.unavailable.tryAgain }));

    expect(await screen.findByText(LIBRARY_VIEW)).toBeInTheDocument();
  });

  it('shows a failed "Try again" under the folder', async () => {
    const { user, shell } = renderStart({ fixture: startFixture('unavailable', { reason: 'catalogFailed' }) });
    shell.setFailure('library_status', 'Internal');
    await user.click(screen.getByRole('button', { name: copy.unavailable.tryAgain }));

    expect(await screen.findByRole('alert')).toHaveTextContent(copy.errors.failed.title);
    expect(pageHeading()).toHaveTextContent(copy.unavailable.catalogFailed.title);
  });

  it('"Locate library…" opens the library where it is now', async () => {
    const { user } = renderStart({
      fixture: startFixture('unavailable', { reason: 'missing', choices: [folderChoice('library')] }),
    });
    await user.click(screen.getByRole('button', { name: copy.unavailable.locate }));

    expect(await screen.findByText(LIBRARY_VIEW)).toBeInTheDocument();
  });

  it('"Locate library…" on a folder without a library says so under the folder', async () => {
    const { user } = renderStart({
      fixture: startFixture('unavailable', { reason: 'missing', choices: [folderChoice('empty')] }),
    });
    await user.click(screen.getByRole('button', { name: copy.unavailable.locate }));

    const banner = await screen.findByRole('alert');
    expect(banner).toHaveTextContent(copy.errors.notALibrary.title);
    expect(banner).toHaveTextContent(copy.errors.notALibrary.text);
  });

  it('"Locate library…" shows what keeps the library from opening', async () => {
    const { user } = renderStart({
      fixture: startFixture('unavailable', { reason: 'notALibrary', choices: [folderChoice('library')] }),
      fail: [{ command: 'open_library', code: 'NewerFormat' }],
    });
    await user.click(screen.getByRole('button', { name: copy.unavailable.locate }));

    expect(await screen.findByRole('alert')).toHaveTextContent(copy.errors.newerFormat.title);
  });

  it('copies the reason and the folder for a failed index', async () => {
    const { user } = renderStart({ fixture: startFixture('unavailable', { reason: 'catalogFailed' }) });
    await user.click(screen.getByRole('button', { name: shellCopy.copyDetails.action }));

    await waitFor(async () => {
      expect(await navigator.clipboard.readText()).toBe(`${copy.unavailable.catalogFailed.title}\ncatalogFailed: ${ROOT}`);
    });
  });

  it('"Start a new library" goes to step 1, whose Back returns here', async () => {
    const { user } = renderStart({
      fixture: startFixture('unavailable', { reason: 'missing', choices: [folderChoice('empty')] }),
    });
    await user.click(screen.getByRole('button', { name: copy.unavailable.startNew }));

    expect(await screen.findByRole('heading', { level: 1, name: copy.folder.empty.title })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: copy.step.back }));
    expect(pageHeading()).toHaveTextContent(copy.unavailable.missing.title);
  });

  it('replaces the Library when the library becomes unavailable, closing its dialog', async () => {
    const { shell } = renderStart({ scenario: 'small' });
    expect(screen.getByText(LIBRARY_VIEW)).toBeInTheDocument();
    act(() => {
      openDialog('problems');
    });

    act(() => {
      shell.makeUnavailable('missing');
    });
    expect(await screen.findByRole('heading', { level: 1, name: copy.unavailable.missing.title })).toBeInTheDocument();
    expect(useNavigation.getState().dialog).toBeNull();
    expect(document.querySelector('[aria-live="polite"]')).toHaveTextContent(copy.unavailable.missing.title);
  });
});

describe('before a library state', () => {
  it('shows only the title bar, then "Opening your library…" when the status is slow', async () => {
    const { client } = renderStart({ fixture: startFixture('first-run'), latencyMs: OPENING_DELAY_MS * 3 });
    // As at start-up: no status yet.
    act(() => {
      void client.resetQueries({ queryKey: keys.libraryStatus() });
    });

    await waitFor(() => {
      expect(screen.queryByRole('heading', { level: 1 })).toBeNull();
    });
    expect(screen.queryByText(copy.opening)).toBeNull();
    expect(await screen.findByRole('status')).toHaveTextContent(copy.opening);
    expect(await screen.findByRole('heading', { level: 1, name: copy.welcome.title }, { timeout: 3000 })).toBeInTheDocument();
  });

  it.each([
    ['DataDirUnavailable', copy.cantStart.dataDir],
    ['Transport', copy.cantStart.transport],
    ['Internal', errors.Internal],
  ] as const)('says Folio cannot start when the status fails with %s', async (code, text) => {
    const { client, shell, user } = renderStart({ fixture: startFixture('first-run') });
    if (code === 'Transport') {
      // A call that does not reach the shell rejects with a plain string.
      shell.invoke = () => Promise.reject(new Error('library_status not allowed'));
    } else {
      shell.setFailure('library_status', code);
    }
    act(() => {
      void client.resetQueries({ queryKey: keys.libraryStatus() });
    });

    expect(await screen.findByRole('heading', { level: 1, name: copy.cantStart.title })).toBeInTheDocument();
    expect(screen.getByText(text)).toBeInTheDocument();
    expect(actions()).toEqual([shellCopy.copyDetails.action]);
    await user.click(screen.getByRole('button', { name: shellCopy.copyDetails.action }));
    await waitFor(async () => {
      expect(await navigator.clipboard.readText()).toContain(code);
    });
  });
});
