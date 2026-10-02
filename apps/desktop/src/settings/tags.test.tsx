// Library settings → Tags (app-shell handoff §9; ipc-m1 §8) against the fake shell: the list, new
// and edited tags with their checks, deleting with a confirmation, moving, and failures.
import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { toastTexts } from '../test/render';
import { announced, renderSettings } from './test/render';

async function openTags(options: Parameters<typeof renderSettings>[2] = {}) {
  const rendered = renderSettings('librarySettings', { page: 'tags' }, options);
  await screen.findByRole('list', { name: 'Tags' });
  return rendered;
}

function listedTags(): string[] {
  return within(screen.getByRole('list', { name: 'Tags' }))
    .getAllByRole('listitem')
    .map((row) => row.querySelector('.settings-list__name')?.textContent ?? '');
}

describe('Library settings → Tags', () => {
  it('lists every tag in order with how many items carry it', async () => {
    await openTags();
    expect(listedTags().slice(0, 3)).toEqual(['Notes', 'Slides', 'Homework']);
    expect(screen.getByText('5 items')).toBeInTheDocument();
  });

  it('creates a tag with a name and colour, and flags a name that is taken', async () => {
    const { user, shell } = await openTags();
    await user.click(screen.getByRole('button', { name: 'New tag' }));
    const dialog = await screen.findByRole('dialog', { name: 'New tag' });
    const name = within(dialog).getByRole('textbox', { name: 'Name' });
    await waitFor(() => {
      expect(name).toHaveFocus();
    });
    await user.type(name, 'notes');
    await user.click(within(dialog).getByRole('button', { name: 'Create tag' }));
    expect(name).toHaveAccessibleDescription("There's already a tag called notes.");
    await user.clear(name);
    await user.type(name, 'Lab reports');
    await user.click(within(dialog).getByRole('button', { name: /^Tag colour:/ }));
    await user.click(await screen.findByRole('radio', { name: 'Violet' }));
    await user.click(within(dialog).getByRole('button', { name: 'Create tag' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'New tag' })).toBeNull();
    });
    expect(shell.library.tagList().at(-1)).toMatchObject({ name: 'Lab reports', color: 'violet' });
    expect(announced()).toBe('Created the tag Lab reports');
    expect(await screen.findByText('Lab reports')).toBeInTheDocument();
  });

  it('flags an empty name before sending anything', async () => {
    const { user, shell } = await openTags();
    await user.click(screen.getByRole('button', { name: 'More options for Notes' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Edit…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Edit the tag “Notes”' });
    const name = within(dialog).getByRole('textbox', { name: 'Name' });
    await user.clear(name);
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(name).toHaveAccessibleDescription('Enter a tag name.');
    expect(shell.library.tagList()[0]?.name).toBe('Notes');
  });

  it('renames a tag', async () => {
    const { user, shell } = await openTags();
    await user.click(screen.getByRole('button', { name: 'More options for Notes' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Edit…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Edit the tag “Notes”' });
    const name = within(dialog).getByRole('textbox', { name: 'Name' });
    await user.clear(name);
    await user.type(name, 'Lecture notes{Enter}');
    await waitFor(() => {
      expect(shell.library.tagList()[0]?.name).toBe('Lecture notes');
    });
  });

  it('says why a save failed, in the dialog', async () => {
    const { user, shell } = await openTags();
    shell.setFailure('create_tag', 'ReadOnly');
    await user.click(screen.getByRole('button', { name: 'New tag' }));
    const dialog = await screen.findByRole('dialog', { name: 'New tag' });
    await user.type(within(dialog).getByRole('textbox', { name: 'Name' }), 'Labs{Enter}');
    expect(await within(dialog).findByRole('alert')).toHaveTextContent("Couldn't create the tag");
  });

  it('asks before deleting a tag, with Cancel first, then says how many items lost it', async () => {
    const { user, shell } = await openTags();
    await user.click(screen.getByRole('button', { name: 'More options for Notes' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Delete…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Delete the tag “Notes”?' });
    expect(within(dialog).getByText(/It comes off the 5 files and folders that have it/)).toBeInTheDocument();
    await waitFor(() => {
      expect(within(dialog).getByRole('button', { name: 'Cancel' })).toHaveFocus();
    });
    await user.click(within(dialog).getByRole('button', { name: 'Delete tag' }));
    await waitFor(() => {
      expect(shell.library.tagList().some((tag) => tag.name === 'Notes')).toBe(false);
    });
    expect(toastTexts()).toContain('Deleted the tag “Notes” from 5 items');
  });

  it('moves a tag down from its menu', async () => {
    const { user, shell } = await openTags();
    await user.click(screen.getByRole('button', { name: 'More options for Notes' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Move down' }));
    expect(listedTags().slice(0, 2)).toEqual(['Slides', 'Notes']);
    await waitFor(() => {
      expect(shell.library.tagList()[1]?.name).toBe('Notes');
    });
  });

  it('shows the state block when the tags cannot be read', async () => {
    renderSettings('librarySettings', { page: 'tags' }, { fail: [{ command: 'list_tags', code: 'Internal' }] });
    expect(await screen.findByRole('heading', { name: "Couldn't load your tags" })).toBeInTheDocument();
  });

  it('turns editing off in a read-only library', async () => {
    const { user } = await openTags({ scenario: 'read-only' });
    expect(screen.getByRole('button', { name: 'New tag' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'More options for Notes' }));
    expect(await screen.findByRole('menuitem', { name: 'Edit…' })).toHaveAttribute('aria-disabled', 'true');
  });
});
