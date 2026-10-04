// The tag filter bar with more tags than two rows hold (workspace-history handoff §12.1, 33B):
// the "+N" chip, its menu and its selected look. jsdom has no layout, so the chips' widths and the
// bar's are given: 60 px chips in a 164 px bar make rows of two.
import { screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useNavigation } from '../../app/navigation';
import { LIMITS } from '../../ipc';
import { setFilter, useLibraryView } from '../state';
import { findRow, libraryFixture, renderLibrary } from '../test/render';

const CHIP = 60;
const BAR = 164;
/** "+N · k on": wider than the other chips, so it may push a tag into the menu. */
const MORE_ON = 130;

beforeEach(() => {
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    if (this.parentElement?.classList.contains('tag-filter__probe') !== true) return new DOMRect();
    return new DOMRect(0, 0, this.matches('.tag-filter__more[data-selected]') ? MORE_ON : CHIP, 26);
  });
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function (this: HTMLElement) {
    return this.classList.contains('tag-filter') ? BAR : 0;
  });
  return () => {
    vi.restoreAllMocks();
  };
});

function bar() {
  return screen.getByRole('group', { name: 'Filter by tag' });
}

describe('the tag filter bar with many tags', () => {
  it('shows two rows of chips and the rest behind "+N"', async () => {
    renderLibrary();
    await findRow('MAT232');
    // All, Notes | Slides, "+N": the small library's seven tags leave five for the menu.
    const buttons = within(bar()).getAllByRole('button');
    expect(buttons.map((button) => button.getAttribute('aria-label') ?? button.textContent)).toEqual([
      'All',
      'Notes',
      'Slides',
      '5 more tags',
    ]);
    const more = within(bar()).getByRole('button', { name: '5 more tags' });
    expect(more).toHaveTextContent('+5');
    expect(more).toHaveAttribute('aria-haspopup', 'true');
    expect(more).not.toHaveAttribute('data-selected');
  });

  it('toggles hidden tags from the menu, which stays open, and shows how many are on', async () => {
    const { user } = renderLibrary({ dialogs: ['librarySettings'] });
    await findRow('MAT232');
    await user.click(within(bar()).getByRole('button', { name: '5 more tags' }));
    const menu = await screen.findByRole('menu');
    expect(within(menu).getAllByRole('menuitemcheckbox').map((item) => item.textContent)).toEqual([
      'Homework',
      'Exams',
      'Reference',
      '重要',
      'To review',
    ]);
    expect(within(menu).getByRole('menuitem', { name: 'Edit tags…' })).toBeInTheDocument();

    await user.click(within(menu).getByRole('menuitemcheckbox', { name: 'Exams' }));
    expect(useLibraryView.getState().filter).toEqual(['exam']);
    expect(within(menu).getByRole('menuitemcheckbox', { name: 'Exams' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('menu')).toBeInTheDocument();

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).toBeNull();
    const more = within(bar()).getByRole('button', { name: '6 more tags, 1 selected' });
    expect(more).toHaveTextContent('+6 · 1 on');
    expect(more).toHaveAttribute('data-selected', 'true');
    await waitFor(() => {
      expect(more).toHaveFocus();
    });

    // "All" clears the hidden tag too.
    await user.click(within(bar()).getByRole('button', { name: 'All' }));
    expect(useLibraryView.getState().filter).toEqual([]);
    expect(within(bar()).getByRole('button', { name: '5 more tags' })).toBeInTheDocument();
  });

  it('opens the tags page of Library settings from "Edit tags…"', async () => {
    const { user } = renderLibrary({ dialogs: ['librarySettings'] });
    await findRow('MAT232');
    await user.click(within(bar()).getByRole('button', { name: '5 more tags' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Edit tags…' }));
    expect(useNavigation.getState().dialog).toMatchObject({ kind: 'librarySettings', params: { page: 'tags' } });
  });

  it('leaves "Edit tags…" out until Library settings is registered', async () => {
    const { user } = renderLibrary();
    await findRow('MAT232');
    await user.click(within(bar()).getByRole('button', { name: '5 more tags' }));
    const menu = await screen.findByRole('menu');
    expect(within(menu).queryByRole('menuitem', { name: 'Edit tags…' })).toBeNull();
    expect(within(menu).queryByRole('separator')).toBeNull();
  });

  it('disables the hidden tags that are off once the filter is full', async () => {
    const tags = Array.from({ length: LIMITS.filterTags + 1 }, (_, index) => ({
      id: `tag${String(index)}`,
      name: `Tag ${String(index)}`,
      color: 'blue',
    }));
    const fixture = libraryFixture(
      (builder) => {
        builder.folder('Fall 2026/CSC148', { group: { order: 1 } });
        builder.file('Fall 2026/CSC148/hw1.py');
      },
      { tags },
    );
    const { user } = renderLibrary({ fixture });
    await findRow('CSC148');
    setFilter(tags.slice(0, LIMITS.filterTags).map((tag) => tag.id));
    const more = await within(bar()).findByRole('button', { name: '16 more tags, 15 selected' });
    expect(within(bar()).getByRole('status')).toHaveTextContent('A filter can have up to 16 tags.');
    await user.click(more);
    const menu = await screen.findByRole('menu');
    const last = within(menu).getByRole('menuitemcheckbox', { name: `Tag ${String(LIMITS.filterTags)}` });
    expect(last).toHaveAttribute('aria-disabled', 'true');
    expect(within(menu).getByRole('menuitemcheckbox', { name: 'Tag 1' })).not.toHaveAttribute('aria-disabled');
  });

  it('makes room for "· 1 on" only when a tag behind "+N" is on', async () => {
    const { user } = renderLibrary();
    await findRow('MAT232');
    // A tag the bar shows moves nothing into the menu.
    await user.click(within(bar()).getByRole('button', { name: 'Notes' }));
    expect(within(bar()).getByRole('button', { name: 'Slides' })).toBeInTheDocument();
    expect(within(bar()).getByRole('button', { name: '5 more tags' })).toBeInTheDocument();

    // A hidden one does: the wider chip takes Slides' place.
    await user.click(within(bar()).getByRole('button', { name: '5 more tags' }));
    await user.click(within(await screen.findByRole('menu')).getByRole('menuitemcheckbox', { name: 'Reference' }));
    await user.keyboard('{Escape}');
    expect(within(bar()).queryByRole('button', { name: 'Slides' })).toBeNull();
    expect(within(bar()).getByRole('button', { name: '6 more tags, 1 selected' })).toBeInTheDocument();
  });
});
