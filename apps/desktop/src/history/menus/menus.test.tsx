// The actions on a card row's file (handoff workspace-history §7.3) on the fake shell: the row's
// context menu from a right-click and from Shift+F10, and the diff's "More", with the file found
// now, deleted since, deleted by the row itself, or a lookup that failed; folders and tag or
// settings changes.
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, onTestFinished, vi } from 'vitest';

import { installShortcuts } from '../../app/shortcuts';
import { refOf } from '../../test/files';
import { smallHistoryWith } from '../../test/history';
import { toastTexts } from '../../test/render';
import { findFeed, renderHistory, resetHistoryPreferences } from '../test/render';

resetHistoryPreferences();

const MAT = 'Fall 2026/MAT232 Calculus of Several Variables';
const LINEAR = 'Fall 2026/线性代数';
const REVIEW = `${MAT}/Exams/Midterm/Midterm review.md`;
const REVIEW_ROW = 'MAT232/Exams/Midterm/Midterm review.md, Modified';
const ROOT = 'E:\\University of Toronto';

async function rowIn(entryName: string, rowName: string | RegExp): Promise<HTMLElement> {
  await findFeed();
  const entry = await screen.findByRole('article', { name: entryName });
  return within(entry).getByRole('option', { name: rowName });
}

/** Right-clicks a row and waits for its menu. */
async function openMenu(row: HTMLElement, name: string): Promise<HTMLElement> {
  fireEvent.contextMenu(row, { clientX: 40, clientY: 20 });
  return screen.findByRole('menu', { name });
}

function item(menu: HTMLElement, name: string): HTMLElement {
  return within(menu).getByRole('menuitem', { name });
}

/** The items' labels, without their notes. */
function labels(menu: HTMLElement): (string | null | undefined)[] {
  return within(menu)
    .getAllByRole('menuitem')
    .map((element) => element.querySelector('.menu-item__label')?.textContent);
}

describe('a file row’s menu', () => {
  it('opens, shows in File Explorer and copies the path of the file the version belongs to now', async () => {
    const { shell, user } = renderHistory();
    const invoke = vi.spyOn(shell, 'invoke');
    const row = await rowIn('MAT232: rewrite the midterm review', REVIEW_ROW);
    let menu = await openMenu(row, 'Actions for Midterm review.md');

    expect(labels(menu)).toEqual(['Open with default app', 'Show in File Explorer', 'View history of this file', 'Copy path', 'Restore this version…']);
    // Disabled while the file is looked up, then not.
    expect(item(menu, 'Open with default app')).toHaveAccessibleDescription('Looking it up…');
    await waitFor(() => {
      expect(item(menu, 'Open with default app')).not.toHaveAttribute('aria-disabled');
    });
    expect(item(menu, 'Open with default app')).not.toHaveAccessibleDescription();
    expect(item(menu, 'Show in File Explorer')).not.toHaveAttribute('aria-disabled');
    await user.click(item(menu, 'Open with default app'));
    const entry = refOf(REVIEW);
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('open_entry', { request: { entry } });
    });
    await waitFor(() => {
      expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    });

    menu = await openMenu(row, 'Actions for Midterm review.md');
    await user.click(item(menu, 'Show in File Explorer'));
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('reveal_entry', { request: { entry } });
    });

    menu = await openMenu(row, 'Actions for Midterm review.md');
    await user.click(item(menu, 'Copy path'));
    await waitFor(() => {
      expect(toastTexts()).toContain('Copied the path');
    });
    expect(await navigator.clipboard.readText()).toBe(`${ROOT}\\${REVIEW.split('/').join('\\')}`);
  });

  it('shows the file’s own history', async () => {
    const { user } = renderHistory();
    await findFeed();
    const entry = await screen.findByRole('article', { name: 'MAT232: rewrite the midterm review' });
    const menu = await openMenu(within(entry).getByRole('option', { name: REVIEW_ROW }), 'Actions for Midterm review.md');
    await user.click(item(menu, 'View history of this file'));
    expect(await screen.findByRole('feed', { name: 'History of Midterm review.md, newest first' })).toBeInTheDocument();
  });

  it('keeps Open and Show listed, disabled with the reason, for a file deleted since', async () => {
    const { user } = renderHistory({ fixture: smallHistoryWith({ summary: 'Old notes', changes: [{ change: 'modified', path: 'Personal/Gone.md' }] }) });
    const row = await rowIn('Old notes', 'Personal/Gone.md, Modified');
    const menu = await openMenu(row, 'Actions for Gone.md');

    for (const name of ['Open with default app', 'Show in File Explorer']) {
      await waitFor(() => {
        expect(item(menu, name)).toHaveAccessibleDescription('Deleted since');
      });
      expect(item(menu, name)).toHaveAttribute('aria-disabled', 'true');
    }
    expect(item(menu, 'View history of this file')).not.toHaveAttribute('aria-disabled');
    // Disabled items are reached by the keyboard and do nothing.
    await user.keyboard('{Enter}');
    expect(screen.getByRole('menu', { name: 'Actions for Gone.md' })).toBeInTheDocument();
  });

  it('says when the file could not be looked up', async () => {
    const { shell } = renderHistory();
    shell.setFailure('locate_version', 'Internal');
    const row = await rowIn('MAT232: rewrite the midterm review', REVIEW_ROW);
    const menu = await openMenu(row, 'Actions for Midterm review.md');
    await waitFor(() => {
      expect(item(menu, 'Open with default app')).toHaveAccessibleDescription('Lookup failed');
    });
    expect(item(menu, 'Show in File Explorer')).toHaveAccessibleDescription('Lookup failed');
    expect(item(menu, 'Copy path')).not.toHaveAttribute('aria-disabled');
  });

  it('names no file to find or follow for a row that deletes it', async () => {
    const { shell } = renderHistory({ fixture: smallHistoryWith({ summary: 'Clean up', changes: [{ change: 'deleted', path: `${MAT}/Old slides L2.pdf` }] }) });
    const invoke = vi.spyOn(shell, 'invoke');
    const row = await rowIn('Clean up', 'MAT232/Old slides L2.pdf, Deleted');
    const menu = await openMenu(row, 'Actions for Old slides L2.pdf');
    for (const name of ['Open with default app', 'Show in File Explorer', 'View history of this file']) {
      expect(item(menu, name)).toHaveAttribute('aria-disabled', 'true');
      expect(item(menu, name)).toHaveAccessibleDescription('Deleted');
    }
    expect(item(menu, 'Copy path')).not.toHaveAttribute('aria-disabled');
    expect(invoke.mock.calls.some(([name]) => name === 'locate_version')).toBe(false);
  });

  it('opens under the row from Shift+F10 with its first item focused, and Esc returns to the row', async () => {
    const { user } = renderHistory();
    const row = await rowIn('MAT232: rewrite the midterm review', REVIEW_ROW);
    act(() => {
      row.focus();
    });
    await user.keyboard('{Shift>}{F10}{/Shift}');
    const menu = await screen.findByRole('menu', { name: 'Actions for Midterm review.md' });
    await waitFor(() => {
      expect(item(menu, 'Open with default app')).toHaveFocus();
    });
    // The browser's own contextmenu event after the keys is the same menu's echo.
    fireEvent.contextMenu(row);
    expect(screen.getAllByRole('menu')).toHaveLength(1);

    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    });
    await waitFor(() => {
      expect(row).toHaveFocus();
    });
  });

  it('has only Copy path for a folder and a file’s tags, and no menu for a settings change', async () => {
    const { user } = renderHistory({
      fixture: smallHistoryWith({
        summary: 'Rename exercises',
        changes: [{ change: 'moved', kind: 'folder', path: `${LINEAR}/习题`, fromPath: `${LINEAR}/Exercises` }],
        metadata: 4,
      }),
    });
    const folder = await rowIn('Rename exercises', /习题, Renamed/);
    let menu = await openMenu(folder, 'Actions for 习题');
    expect(labels(menu)).toEqual(['Copy path']);
    expect(item(menu, 'Copy path')).toHaveTextContent('Ctrl+Shift+C');
    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    });

    const entry = screen.getByRole('article', { name: 'Rename exercises' });
    await user.click(within(entry).getByRole('button', { name: 'Show all 5 changes' }));
    // A commit's tag rows name no version of the file: no Open, Show or history to follow.
    const tags = await within(entry).findByRole('option', { name: 'MAT232/Exams/Midterm/Midterm 2025.pdf, Tags, Modified' });
    menu = await openMenu(tags, 'Actions for Midterm 2025.pdf');
    expect(labels(menu)).toEqual(['Copy path']);
    await user.click(item(menu, 'Copy path'));
    expect(await navigator.clipboard.readText()).toBe(`${ROOT}\\${`${MAT}/Exams/Midterm/Midterm 2025.pdf`.split('/').join('\\')}`);
    await waitFor(() => {
      expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    });

    for (const name of ['Ignore rules, Modified', 'CSC148 course settings, Modified', 'Tag definitions, Added']) {
      fireEvent.contextMenu(within(entry).getByRole('option', { name }));
      expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    }
  });
});

describe('the diff’s More', () => {
  it('has the same actions for the row it shows', async () => {
    const { user } = renderHistory();
    const row = await rowIn('MAT232: rewrite the midterm review', REVIEW_ROW);
    await user.click(row);
    const diff = screen.getByRole('region', { name: 'Selected version' });
    await user.click(await within(diff).findByRole('button', { name: 'More' }));
    const menu = await screen.findByRole('menu');
    await waitFor(() => {
      expect(item(menu, 'Open with default app')).not.toHaveAttribute('aria-disabled');
    });
    expect(labels(menu)).toEqual(['Open with default app', 'Show in File Explorer', 'View history of this file', 'Copy path']);
  });
});

describe('Ctrl+Shift+C', () => {
  it('copies the path of the row the diff shows, and nothing while none is shown or it names no file', async () => {
    onTestFinished(installShortcuts());
    const { user } = renderHistory({ fixture: smallHistoryWith({ summary: 'Settings', changes: [{ change: 'modified', path: REVIEW }], metadata: 1 }) });
    await navigator.clipboard.writeText('before');
    const row = await rowIn('Settings', REVIEW_ROW);
    await user.keyboard('{Control>}{Shift>}C{/Shift}{/Control}');
    expect(await navigator.clipboard.readText()).toBe('before');

    await user.click(row);
    await user.keyboard('{Control>}{Shift>}C{/Shift}{/Control}');
    await waitFor(async () => {
      expect(await navigator.clipboard.readText()).toBe(`${ROOT}\\${REVIEW.split('/').join('\\')}`);
    });
    expect(toastTexts()).toContain('Copied the path');

    await navigator.clipboard.writeText('before');
    const entry = screen.getByRole('article', { name: 'Settings' });
    await user.click(within(entry).getByRole('button', { name: 'Show all 2 changes' }));
    await user.click(await within(entry).findByRole('option', { name: 'Ignore rules, Modified' }));
    await user.keyboard('{Control>}{Shift>}C{/Shift}{/Control}');
    expect(await navigator.clipboard.readText()).toBe('before');
  });
});
