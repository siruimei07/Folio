// "View history" in the Library (handoff workspace-history §7.4, §12.4) against the fake shell: the
// preview header's "View history of this file" and a file's context menu ask History for the file's
// own history; folders have none, and the narrow header leaves the button out like "Show in File
// Explorer".
import { act, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { takeHistoryTarget } from '../app/historyTarget';
import { useNavigation } from '../app/navigation';
import { refOf } from '../test/files';
import { SIZE } from '../tokens/tokens';
import { findRow, MAT, renderLibrary } from './test/render';

const WEEK2 = `${MAT}/week 2 notes.md`;

/** The items of the menu open last, as their text reads. */
function menuItems(): string[] {
  const menu = screen.getAllByRole('menu').at(-1);
  if (menu === undefined) throw new Error('no menu is open');
  return [...menu.querySelectorAll('[role^="menuitem"]')].map((item) => item.textContent);
}

afterEach(() => {
  takeHistoryTarget();
  useNavigation.setState({ view: 'library' });
});

describe('View history in the Library', () => {
  it('shows a file’s history from its preview header', async () => {
    const { user } = renderLibrary();
    await user.click(await findRow('MAT232'));
    await user.click(await findRow('week 2 notes.md'));
    const preview = await screen.findByRole('group', { name: 'Preview of week 2 notes.md' });
    // After "Show in File Explorer", before "More" (app-shell §5).
    const buttons = within(preview.querySelector<HTMLElement>('.preview-header__actions') ?? preview).getAllByRole('button');
    expect(buttons.map((button) => button.getAttribute('aria-label'))).toEqual([
      'Open with default app',
      'Show in File Explorer',
      'View history of this file',
      'More',
    ]);

    await user.click(within(preview).getByRole('button', { name: 'View history of this file' }));
    expect(useNavigation.getState().view).toBe('history');
    expect(takeHistoryTarget()).toEqual({ kind: 'entry', entry: refOf(WEEK2) });
  });

  it('offers “View history” after “Show in File Explorer” in a file’s menu, and none for a folder', async () => {
    const { user } = renderLibrary();
    await user.click(await findRow('MAT232'));
    await user.pointer({ keys: '[MouseRight]', target: await findRow('week 2 notes.md') });
    await screen.findByRole('menu');
    expect(menuItems().slice(0, 3)).toEqual(['Open with default app', 'Show in File Explorer', 'View history']);
    await user.click(screen.getByRole('menuitem', { name: 'View history' }));
    expect(useNavigation.getState().view).toBe('history');
    expect(takeHistoryTarget()).toEqual({ kind: 'entry', entry: refOf(WEEK2) });

    act(() => {
      useNavigation.setState({ view: 'library' });
    });
    await user.pointer({ keys: '[MouseRight]', target: await findRow('Exams') });
    await screen.findByRole('menu');
    expect(menuItems()).not.toContain('View history');
  });

  it('leaves the header’s button out of a narrow window', async () => {
    const width = window.innerWidth;
    act(() => {
      window.innerWidth = SIZE.narrowBreakpoint - 1;
      window.dispatchEvent(new Event('resize'));
    });
    try {
      const { user } = renderLibrary();
      await user.click(await findRow('Recently added'));
      const pane = screen.getByRole('region', { name: 'Preview' });
      const [file] = await within(pane).findAllByRole('gridcell');
      if (file === undefined) throw new Error('Recently added shows files');
      await user.click(file);
      await user.keyboard('{Enter}');
      const preview = await within(pane).findByRole('group', { name: /^Preview of / });
      expect(within(preview).getByRole('button', { name: 'Back' })).toBeInTheDocument();
      expect(within(preview).queryByRole('button', { name: 'View history of this file' })).toBeNull();
      expect(within(preview).queryByRole('button', { name: 'Show in File Explorer' })).toBeNull();
    } finally {
      act(() => {
        window.innerWidth = width;
        window.dispatchEvent(new Event('resize'));
      });
    }
  });

  it('offers neither while History is not on the rail', async () => {
    const { user } = renderLibrary({ views: [] });
    await user.click(await findRow('MAT232'));
    await user.click(await findRow('week 2 notes.md'));
    const preview = await screen.findByRole('group', { name: 'Preview of week 2 notes.md' });
    expect(within(preview).getByRole('button', { name: 'Show in File Explorer' })).toBeInTheDocument();
    expect(within(preview).queryByRole('button', { name: 'View history of this file' })).toBeNull();

    await user.pointer({ keys: '[MouseRight]', target: await findRow('week 2 notes.md') });
    await screen.findByRole('menu');
    expect(menuItems().slice(0, 2)).toEqual(['Open with default app', 'Show in File Explorer']);
    expect(menuItems()).not.toContain('View history');
  });
});
