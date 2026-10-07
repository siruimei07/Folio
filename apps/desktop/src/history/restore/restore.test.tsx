// Restoring a version from History (handoff workspace-history §8, §7.2, §11, §14) on the fake shell:
// the confirmation's words for each planned outcome, the warning block, the plan that loads, fails
// or finds nothing to do, the restore that is done, changes nothing or fails with each code, where
// the focus goes, the toasts, "Restore this version…" in a row's menu, and the new restore entry's
// highlight.
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, type MockInstance, onTestFinished, vi } from 'vitest';

import { showHistory } from '../../app/historyTarget';
import { useToasts } from '../../app/toasts';
import type { AppError } from '../../ipc';
import { refOf } from '../../test/files';
import { smallHistoryWith } from '../../test/history';
import { settle, toastTexts } from '../../test/render';
import { findFeed, holdAnswers, renderHistory, resetHistoryPreferences } from '../test/render';

resetHistoryPreferences();

// The toast queue outlives a test; each starts with none.
beforeEach(() => {
  useToasts.setState({ toasts: [] });
});

const MAT = 'Fall 2026/MAT232 Calculus of Several Variables';
const REVIEW = `${MAT}/Exams/Midterm/Midterm review.md`;
const WEEK2 = `${MAT}/week 2 notes.md`;
const REVIEW_ROW = 'MAT232/Exams/Midterm/Midterm review.md, Modified';
const WEEK2_ROW = 'MAT232/week 2 notes.md, Modified';

type Shell = ReturnType<typeof renderHistory>['shell'];
type User = ReturnType<typeof renderHistory>['user'];

/** A row of an entry of the shown timeline. */
async function rowIn(entryName: string, rowName: string | RegExp): Promise<HTMLElement> {
  const entry = await screen.findByRole('article', { name: entryName });
  return within(entry).getByRole('option', { name: rowName });
}

function diffColumn(): HTMLElement {
  return screen.getByRole('region', { name: 'Selected version' });
}

/** Selects a row and presses the diff's Restore. */
async function restoreFromDiff(user: User, row: HTMLElement): Promise<HTMLElement> {
  await user.click(row);
  const restore = await within(diffColumn()).findByRole('button', { name: 'Restore' });
  await waitFor(() => {
    expect(restore).not.toHaveAttribute('aria-disabled');
  });
  await user.click(restore);
  return restore;
}

function findDialog(): Promise<HTMLElement> {
  return screen.findByRole('alertdialog');
}

function button(dialog: HTMLElement, name: string): HTMLElement {
  return within(dialog).getByRole('button', { name });
}

/** One file's history of week 2 notes.md: its newest version is the file's content now. */
async function week2History(): Promise<HTMLElement> {
  await findFeed();
  act(() => {
    showHistory({ kind: 'entry', entry: refOf(WEEK2) });
  });
  return screen.findByRole('feed', { name: 'History of week 2 notes.md, newest first' });
}

/** The restore_version requests sent. */
function restoresAsked(invoke: MockInstance<Shell['invoke']>): unknown[] {
  return invoke.mock.calls.filter(([command]) => command === 'restore_version').map(([, args]) => (args as { request: unknown }).request);
}

describe('the confirmation', () => {
  it('says where an older version goes, restores it, and gives the focus back to Restore, now disabled', async () => {
    const { shell, user } = renderHistory();
    const invoke = vi.spyOn(shell, 'invoke');
    const feed = await week2History();
    const [, first] = within(feed).getAllByRole('article');
    if (first === undefined) throw new Error('two entries');
    const restore = await restoreFromDiff(user, within(first).getByRole('option'));

    const dialog = await findDialog();
    expect(dialog).toHaveAccessibleName(/^Restore week 2 notes\.md to [A-Z][a-z]{2} \d{1,2}\?$/);
    expect(dialog).toHaveAccessibleDescription(
      /^Folio puts the version from .+ back in MAT232\. It shows up in Changes, so you can check it before you commit\. The version you have now stays in History, so nothing is lost\.$/,
    );
    await waitFor(() => {
      expect(button(dialog, 'Restore version')).toHaveFocus();
    });

    await user.click(button(dialog, 'Restore version'));
    await waitFor(() => {
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    });
    expect(restoresAsked(invoke)).toHaveLength(1);
    expect(toastTexts()).toContainEqual(
      expect.stringMatching(/^Restored week 2 notes\.md — The version from [A-Z][a-z]{2} \d{1,2} is back\. Check it in Changes, then commit it\.$/),
    );
    // The restored version is the file's content now: its Restore turns disabled, and keeps the focus.
    await waitFor(() => {
      expect(within(diffColumn()).getByRole('button', { name: 'Restore' })).toHaveAttribute('aria-disabled', 'true');
    });
    await waitFor(() => {
      expect(within(diffColumn()).getByRole('button', { name: 'Restore' })).toHaveFocus();
    });
    expect(restore.isConnected).toBe(false);
  });

  // The file's history refreshed after the dialog gave the focus back: the timeline changes in the
  // same render as Restore, and the view's keeper, which hears of it first, leaves it to the diff.
  it('keeps the focus on Restore as it turns disabled when the file’s history answers late', async () => {
    const { shell, user } = renderHistory();
    const feed = await week2History();
    const [, first] = within(feed).getAllByRole('article');
    if (first === undefined) throw new Error('two entries');
    await restoreFromDiff(user, within(first).getByRole('option'));
    const dialog = await findDialog();
    await waitFor(() => {
      expect(button(dialog, 'Restore version')).toHaveFocus();
    });
    const refresh = holdAnswers(shell, 'list_file_history');

    await user.click(button(dialog, 'Restore version'));
    await waitFor(() => {
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    });
    const enabled = within(diffColumn()).getByRole('button', { name: 'Restore' });
    await waitFor(() => {
      expect(enabled).toHaveFocus();
    });
    expect(enabled).not.toHaveAttribute('aria-disabled');
    refresh.release();

    await waitFor(() => {
      expect(within(diffColumn()).getByRole('button', { name: 'Restore' })).toHaveAttribute('aria-disabled', 'true');
    });
    await settle();
    expect(within(diffColumn()).getByRole('button', { name: 'Restore' })).toHaveFocus();
  });

  it('warns that the file as it is now goes to the Recycle Bin, with the focus on Cancel', async () => {
    const { shell, user } = renderHistory();
    const invoke = vi.spyOn(shell, 'invoke');
    await findFeed();
    const restore = await restoreFromDiff(user, await rowIn('MAT232: rewrite the midterm review', REVIEW_ROW));

    const dialog = await findDialog();
    expect(dialog).toHaveTextContent("This file has changes you haven't committed");
    expect(dialog).toHaveTextContent('Folio moves the file as it is now to the Recycle Bin first, so you can still get those changes back.');
    expect(dialog).not.toHaveTextContent('stays in History');
    await waitFor(() => {
      expect(button(dialog, 'Cancel')).toHaveFocus();
    });

    // Esc cancels: nothing restored, the focus back on Restore.
    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    });
    expect(restoresAsked(invoke)).toEqual([]);
    await waitFor(() => {
      expect(restore).toHaveFocus();
    });

    // Restored anyway: the version replaces the file; the whole history keeps Restore as it was.
    await user.click(restore);
    await user.click(button(await findDialog(), 'Restore version'));
    await waitFor(() => {
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    });
    expect(restoresAsked(invoke)).toEqual([{ commit: expect.any(String) as string, path: REVIEW }]);
    await waitFor(() => {
      expect(restore).toHaveFocus();
    });
  });

  it('says that a file deleted since comes back where it was', async () => {
    const { user } = renderHistory({ fixture: smallHistoryWith({ summary: 'Old notes', changes: [{ change: 'modified', path: 'Personal/Gone.md' }] }) });
    await findFeed();
    await restoreFromDiff(user, await rowIn('Old notes', 'Personal/Gone.md, Modified'));
    const dialog = await findDialog();
    expect(dialog).toHaveAccessibleName(/^Restore Gone\.md to /);
    expect(dialog).toHaveAccessibleDescription(
      /^Gone\.md isn't in the library anymore\. Folio puts the version from .+ back in Personal\. It shows up in Changes, so you can check it before you commit\.$/,
    );
  });

  it('says that the version goes beside the file that took its name, under the keep-both name', async () => {
    const { user } = renderHistory({
      fixture: smallHistoryWith(
        { summary: 'Remove the notes', changes: [{ change: 'deleted', path: WEEK2 }] },
        { summary: 'New notes', changes: [{ change: 'added', path: WEEK2 }] },
      ),
    });
    await findFeed();
    await restoreFromDiff(user, await rowIn('MAT232: update 1 file', WEEK2_ROW));
    const dialog = await findDialog();
    expect(dialog).toHaveAccessibleDescription(
      /^Another file now has this name, so Folio puts the version from .+ beside it as “week 2 notes \(2\)\.md”\. It shows up in Changes, so you can check it before you commit\.$/,
    );
  });

  it('says there is nothing to restore without showing the dialog', async () => {
    const { shell, user } = renderHistory();
    const invoke = vi.spyOn(shell, 'invoke');
    await findFeed();
    const row = await rowIn('MAT232: update 1 file', WEEK2_ROW);
    // Any dialog that appears, even for a moment.
    let dialogs = 0;
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (node instanceof Element && (node.matches('[role="alertdialog"]') || node.querySelector('[role="alertdialog"]') !== null)) dialogs += 1;
        }
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    onTestFinished(() => {
      observer.disconnect();
    });
    const restore = await restoreFromDiff(user, row);
    await waitFor(() => {
      expect(toastTexts()).toContain('Nothing to restore — week 2 notes.md already has the content of this version.');
    });
    expect(dialogs).toBe(0);
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(invoke.mock.calls.some(([command]) => command === 'plan_restore')).toBe(true);
    expect(restoresAsked(invoke)).toEqual([]);
    expect(restore).toHaveFocus();
  });

  it('shows after 150 ms with a skeleton and "Restore version" pending while the plan loads', async () => {
    const { user } = renderHistory({ latencyMs: 400 });
    const feed = await week2History();
    const first = (await within(feed).findAllByRole('article'))[1];
    if (first === undefined) throw new Error('two entries');
    await user.click(within(first).getByRole('option'));
    const restore = await within(diffColumn()).findByRole('button', { name: 'Restore' }, { timeout: 2000 });
    await waitFor(() => {
      expect(restore).not.toHaveAttribute('aria-disabled');
    });
    await user.click(restore);
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();

    const dialog = await findDialog();
    expect(within(dialog).getByRole('status', { name: 'Loading…' })).toBeInTheDocument();
    expect(button(dialog, 'Restore version')).toHaveAttribute('aria-disabled', 'true');
    await waitFor(() => {
      expect(button(dialog, 'Restore version')).toHaveFocus();
    });
    await waitFor(() => {
      expect(dialog).toHaveTextContent('Folio puts the version from');
    });
    expect(button(dialog, 'Restore version')).not.toHaveAttribute('aria-disabled');
    expect(within(dialog).queryByRole('status', { name: 'Loading…' })).toBeNull();
  });

  it('moves the focus to Cancel when a plan that arrives late warns', async () => {
    const { user } = renderHistory({ latencyMs: 400 });
    await findFeed();
    const row = await rowIn('MAT232: rewrite the midterm review', REVIEW_ROW);
    await user.click(row);
    const restore = await within(diffColumn()).findByRole('button', { name: 'Restore' });
    await user.click(restore);
    const dialog = await findDialog();
    await waitFor(() => {
      expect(button(dialog, 'Restore version')).toHaveFocus();
    });
    expect(dialog).not.toHaveTextContent("This file has changes you haven't committed");
    await waitFor(() => {
      expect(dialog).toHaveTextContent("This file has changes you haven't committed");
    });
    await waitFor(() => {
      expect(button(dialog, 'Cancel')).toHaveFocus();
    });
  });

  it('turns "Restore version" pending while it restores', async () => {
    const { shell, user } = renderHistory();
    const feed = await week2History();
    const first = within(feed).getAllByRole('article')[1];
    if (first === undefined) throw new Error('two entries');
    await restoreFromDiff(user, within(first).getByRole('option'));
    const dialog = await findDialog();
    await waitFor(() => {
      expect(button(dialog, 'Restore version')).not.toHaveAttribute('aria-disabled');
    });
    // The answer waits for the test from here on.
    let answer: (value?: unknown) => void = () => undefined;
    const answered = new Promise((resolve) => {
      answer = resolve;
    });
    const invoke = shell.invoke.bind(shell);
    vi.spyOn(shell, 'invoke').mockImplementation(async (command, payload) => {
      if (command === 'restore_version') await answered;
      return invoke(command, payload);
    });
    await user.click(button(dialog, 'Restore version'));
    const pending = button(dialog, 'Restoring…');
    expect(pending).toHaveAttribute('aria-disabled', 'true');
    expect(pending).toHaveFocus();
    expect(button(dialog, 'Cancel')).toBeDisabled();
    // Esc waits for the answer too.
    await user.keyboard('{Escape}');
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    answer();
    await waitFor(() => {
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    });
  });

  it('keeps the plan it confirmed while the restore’s own events make the plan say "unchanged"', async () => {
    const { shell, user } = renderHistory();
    const feed = await week2History();
    const first = within(feed).getAllByRole('article')[1];
    if (first === undefined) throw new Error('two entries');
    await restoreFromDiff(user, within(first).getByRole('option'));
    const dialog = await findDialog();
    await waitFor(() => {
      expect(dialog).toHaveTextContent('Folio puts the version from');
    });
    // The restore is done at once (its events go out), and answers a while later.
    const invoke = shell.invoke.bind(shell);
    const spy = vi.spyOn(shell, 'invoke').mockImplementation(async (command, payload) => {
      const answer = await invoke(command, payload);
      if (command === 'restore_version') {
        await new Promise((resolve) => {
          setTimeout(resolve, 300);
        });
      }
      return answer;
    });
    await user.click(button(dialog, 'Restore version'));
    await waitFor(() => {
      expect(spy.mock.calls.filter(([command]) => command === 'plan_restore').length).toBeGreaterThan(0);
    });
    expect(screen.getByRole('alertdialog')).toHaveTextContent('Folio puts the version from');
    expect(button(dialog, 'Restoring…')).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    });
    expect(toastTexts().filter((text) => text.startsWith('Nothing to restore'))).toEqual([]);
    expect(toastTexts()).toContainEqual(expect.stringMatching(/^Restored week 2 notes\.md — /));
  });

  it('closes with the information toast when the restore finds nothing to change', async () => {
    const { user } = renderHistory({ fail: [{ command: 'restore_version', code: 'Unchanged' }] });
    const feed = await week2History();
    const first = within(feed).getAllByRole('article')[1];
    if (first === undefined) throw new Error('two entries');
    const restore = await restoreFromDiff(user, within(first).getByRole('option'));
    await user.click(button(await findDialog(), 'Restore version'));
    await waitFor(() => {
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    });
    expect(toastTexts()).toContain('Nothing to restore — week 2 notes.md already has the content of this version.');
    await waitFor(() => {
      expect(restore).toHaveFocus();
    });
  });
});

/** Each code `restore_version` can fail with, and what the block says (§8.3). */
const FAILURES: readonly [AppError['code'], string, boolean][] = [
  ['InUse', 'Another app is using it. Close it there, then try again.', false],
  ['NotLocal', "It isn't downloaded yet. Open it so it downloads, then try again.", false],
  ['NotRecyclable', "Folio couldn't move the current file to the Recycle Bin, so it didn't replace it.", false],
  ['AccessDenied', "Windows didn't allow it.", false],
  ['DiskFull', 'The disk is full.', false],
  ['NotStored', "Folio doesn't keep this version any more.", false],
  ['Pruned', "Folio doesn't keep this version any more.", false],
  ['FileChanged', 'It was saved again just now, so Folio left it as it is. Check it, then try again.', false],
  ['HistoryBusy', 'Folio is still finishing another commit, message edit, undo or restore. Try again in a moment.', false],
  ['HistoryDamaged', '', true],
  ['Internal', '', true],
];

describe('a restore that fails', () => {
  it.each(FAILURES)('says why for %s, with Try again, and leaves History as it was', async (code, reason, details) => {
    const { shell, user } = renderHistory({ fail: [{ command: 'restore_version', code }] });
    const invoke = vi.spyOn(shell, 'invoke');
    const feed = await week2History();
    const first = within(feed).getAllByRole('article')[1];
    if (first === undefined) throw new Error('two entries');
    const row = within(first).getByRole('option');
    const scroller = document.querySelector<HTMLElement>('.timeline');
    if (scroller === null) throw new Error('no timeline');
    act(() => {
      scroller.scrollTop = 24;
      fireEvent.scroll(scroller);
    });
    await restoreFromDiff(user, row);
    const dialog = await findDialog();
    await user.click(button(dialog, 'Restore version'));

    const alert = await within(dialog).findByRole('alert');
    expect(alert).toHaveTextContent("Couldn't restore week 2 notes.md");
    expect(alert).toHaveTextContent(reason === '' ? 'Nothing was changed.' : `${reason} Nothing was changed.`);
    expect(within(alert).queryByRole('button', { name: 'Copy details' }) !== null).toBe(details);
    const again = button(dialog, 'Try again');
    await waitFor(() => {
      expect(again).toHaveFocus();
    });
    // A failed restore leaves the person where they were: the row shown, the timeline where it was.
    expect(row).toHaveAttribute('aria-selected', 'true');
    expect(document.querySelector('.timeline')).toBe(scroller);
    expect(scroller.scrollTop).toBe(24);
    // No restore entry: the page behind the dialog is hidden from the accessibility tree meanwhile.
    expect(within(feed).getAllByRole('article', { hidden: true })).toHaveLength(2);

    // Try again, now that it works.
    shell.setFailure('restore_version', null);
    await user.click(again);
    await waitFor(() => {
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    });
    expect(restoresAsked(invoke)).toHaveLength(2);
    expect(toastTexts()).toContainEqual(expect.stringMatching(/^Restored week 2 notes\.md — /));
  });
});

describe('a plan that fails', () => {
  it('shows the failure block, and Try again asks for the plan again', async () => {
    const { shell, user } = renderHistory();
    const invoke = vi.spyOn(shell, 'invoke');
    shell.setFailure('plan_restore', 'NotLocal');
    const feed = await week2History();
    const first = within(feed).getAllByRole('article')[1];
    if (first === undefined) throw new Error('two entries');
    await restoreFromDiff(user, within(first).getByRole('option'));

    const dialog = await findDialog();
    expect(dialog).toHaveAccessibleDescription(
      "Couldn't restore week 2 notes.md It isn't downloaded yet. Open it so it downloads, then try again. Nothing was changed.",
    );
    expect(dialog).not.toHaveTextContent('Folio puts the version');
    const again = button(dialog, 'Try again');
    await waitFor(() => {
      expect(again).toHaveFocus();
    });

    shell.setFailure('plan_restore', null);
    await user.click(again);
    await waitFor(() => {
      expect(dialog).toHaveTextContent('Folio puts the version from');
    });
    expect(within(dialog).queryByText("Couldn't restore week 2 notes.md")).toBeNull();
    expect(button(dialog, 'Restore version')).toHaveFocus();
    expect(invoke.mock.calls.filter(([command]) => command === 'plan_restore')).toHaveLength(2);
  });

  it('offers Copy details for a code that points at a bug', async () => {
    const { shell, user } = renderHistory();
    shell.setFailure('plan_restore', 'Internal');
    const feed = await week2History();
    const first = within(feed).getAllByRole('article')[1];
    if (first === undefined) throw new Error('two entries');
    await restoreFromDiff(user, within(first).getByRole('option'));
    const dialog = await findDialog();
    expect(button(dialog, 'Copy details')).toBeInTheDocument();
  });
});

describe('"Restore this version…" in a row’s menu', () => {
  it('opens the confirmation, and the focus goes back to the row', async () => {
    const { shell, user } = renderHistory();
    const invoke = vi.spyOn(shell, 'invoke');
    await findFeed();
    const row = await rowIn('MAT232: rewrite the midterm review', REVIEW_ROW);
    act(() => {
      row.focus();
    });
    await user.keyboard('{Shift>}{F10}{/Shift}');
    const menu = await screen.findByRole('menu', { name: 'Actions for Midterm review.md' });
    await user.click(within(menu).getByRole('menuitem', { name: 'Restore this version…' }));
    const dialog = await findDialog();
    await user.click(button(dialog, 'Restore version'));
    await waitFor(() => {
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    });
    expect(restoresAsked(invoke)).toEqual([{ commit: expect.any(String) as string, path: REVIEW }]);
    await waitFor(() => {
      expect(row).toHaveFocus();
    });
  });

  it('is disabled for the current version, and not listed for a version History does not restore', async () => {
    const { user } = renderHistory({ fixture: smallHistoryWith({ summary: 'Clean up', changes: [{ change: 'deleted', path: `${MAT}/Old slides L2.pdf` }] }) });
    await findFeed();
    const deleted = await rowIn('Clean up', 'MAT232/Old slides L2.pdf, Deleted');
    act(() => {
      deleted.focus();
    });
    await user.keyboard('{Shift>}{F10}{/Shift}');
    let menu = await screen.findByRole('menu', { name: 'Actions for Old slides L2.pdf' });
    expect(within(menu).queryByRole('menuitem', { name: 'Restore this version…' })).toBeNull();
    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    });

    const feed = await week2History();
    const current = within(feed).getAllByRole('article')[0];
    if (current === undefined) throw new Error('two entries');
    const row = within(current).getByRole('option');
    act(() => {
      row.focus();
    });
    await user.keyboard('{Shift>}{F10}{/Shift}');
    menu = await screen.findByRole('menu', { name: 'Actions for week 2 notes.md' });
    const restore = within(menu).getByRole('menuitem', { name: 'Restore this version…' });
    expect(restore).toHaveAttribute('aria-disabled', 'true');
    expect(restore).toHaveAccessibleDescription('Current version');
  });
});

describe('a narrow window', () => {
  it('restores from "More" over the list, and the focus goes back to "More"', async () => {
    const { user } = renderHistory({ layout: { width: 560, height: 720 } });
    const feed = await week2History();
    const first = within(feed).getAllByRole('article')[1];
    if (first === undefined) throw new Error('two entries');
    await user.click(within(first).getByRole('option'));
    const diff = await screen.findByRole('region', { name: 'Selected version' });
    const more = await within(diff).findByRole('button', { name: 'More' });
    await user.click(more);
    await user.click(await screen.findByRole('menuitem', { name: 'Restore…' }));
    const dialog = await findDialog();
    await user.click(button(dialog, 'Cancel'));
    await waitFor(() => {
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    });
    await waitFor(() => {
      expect(more).toHaveFocus();
    });
  });
});

describe('the new restore entry', () => {
  it('arrives at the top, highlighted, and the highlight clears', async () => {
    const { user } = renderHistory();
    const feed = await week2History();
    const first = within(feed).getAllByRole('article')[1];
    if (first === undefined) throw new Error('two entries');
    await restoreFromDiff(user, within(first).getByRole('option'));
    await user.click(button(await findDialog(), 'Restore version'));
    const entry = await within(feed).findByRole('article', { name: /^Restored week 2 notes\.md to the version from / });
    expect(within(feed).getAllByRole('article')[0]).toBe(entry);
    expect(entry).toHaveAttribute('data-fresh');
    await waitFor(
      () => {
        expect(entry).not.toHaveAttribute('data-fresh');
      },
      { timeout: 3000 },
    );
  });
});
