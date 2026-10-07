// What the Library does to entries (library-actions handoff §6, §7, §9.3, §9.4) against the fake
// shell: context menus for each kind of target, Tags ▸ with mixed states, inline rename with its
// callouts, new folders, delete with its toasts and confirmations, Move to… and Copy path.
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { useNavigation } from '../app/navigation';
import { closeMenu, useLibraryView } from './state';
import { CSC, findRow, getRow, MAT, queryRow, renderLibrary, smallLibraryWith, toastTexts } from './test/render';

const ECO = 'ECO101';

/** The items of the menu open last, as their text reads. */
function menuItems(): string[] {
  const menu = screen.getAllByRole('menu').at(-1);
  if (menu === undefined) throw new Error('no menu is open');
  return [...menu.querySelectorAll('[role^="menuitem"]')].map((item) => item.textContent);
}

/** Whether the entry at `path` is selected in the tree (the tree is inert while a menu is open). */
function selected(path: string): boolean {
  return [...useLibraryView.getState().panel.entries.values()].some((entry) => entry.path === path);
}

async function openMenuOn(user: ReturnType<typeof renderLibrary>['user'], row: HTMLElement) {
  await user.pointer({ keys: '[MouseRight]', target: row });
  return screen.findByRole('menu');
}

describe('context menus', () => {
  it('offers the file actions on a file, and selects the file first', async () => {
    const { user } = renderLibrary();
    await user.click(await findRow('MAT232'));
    await openMenuOn(user, await findRow('week 2 notes.md'));
    expect(selected(`${MAT}/week 2 notes.md`)).toBe(true);
    expect(menuItems()).toEqual([
      'Open with default app',
      'Show in File Explorer',
      'View history',
      'Tags',
      'RenameF2',
      'Move to…',
      'Copy pathCtrl+Shift+C',
      'DeleteDel',
    ]);
  });

  it('offers new folders on a folder, and adding files once the import dialog is registered', async () => {
    const { user } = renderLibrary({ dialogs: ['import'] });
    await user.click(await findRow('MAT232'));
    await openMenuOn(user, await findRow('Exams'));
    expect(menuItems()).toEqual([
      'Add files…Ctrl+O',
      'New folderCtrl+Shift+N',
      'Open in File Explorer',
      'Tags',
      'RenameF2',
      'Move to…',
      'Copy pathCtrl+Shift+C',
      'DeleteDel',
    ]);
  });

  it('offers the course actions on a course, Course settings… once Library settings is registered', async () => {
    const { user } = renderLibrary({ dialogs: ['librarySettings'] });
    await openMenuOn(user, await findRow('MAT232'));
    expect(menuItems()).toEqual([
      'New folderCtrl+Shift+N',
      'Open in File Explorer',
      'Course settings…',
      'RenameF2',
      'Delete course…Del',
    ]);
    await user.click(screen.getByRole('menuitem', { name: 'Course settings…' }));
    expect(useNavigation.getState().dialog).toEqual({ kind: 'librarySettings', params: { page: 'courses' } });
  });

  it('offers the batch actions on several entries, fewer with a course among them', async () => {
    const { user } = renderLibrary();
    await user.click(await findRow('MAT232'));
    await user.click(await findRow('Exams'));
    await user.keyboard('{Control>}');
    await user.click(getRow('Lectures'));
    await user.keyboard('{/Control}');
    await openMenuOn(user, getRow('Lectures'));
    expect(menuItems()).toEqual(['Tags', 'Move 2 items to…', 'Copy paths', 'Delete 2 itemsDel']);
    closeMenu();

    await user.keyboard('{Control>}');
    await user.click(getRow('MAT232'));
    await user.keyboard('{/Control}');
    await openMenuOn(user, getRow('Exams'));
    expect(menuItems()).toEqual(['Copy paths', 'Delete 3 itemsDel']);
  });

  it('has no menu on quick views, and on the empty space only what can open', async () => {
    const { user } = renderLibrary();
    await user.pointer({ keys: '[MouseRight]', target: await findRow('Recently added') });
    expect(screen.queryByRole('menu')).toBeNull();
    // Nothing the empty space offers is registered yet.
    await user.pointer({ keys: '[MouseRight]', target: screen.getByRole('tree') });
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('opens from the keyboard under the focused row, with focus on the first item', async () => {
    const { user } = renderLibrary();
    await user.click(await findRow('MAT232'));
    const row = await findRow('week 2 notes.md');
    await user.click(row);
    await user.keyboard('{Shift>}{F10}{/Shift}');
    // The browser's own `contextmenu` that follows the key changes nothing.
    fireEvent.contextMenu(row);
    const menu = await screen.findByRole('menu');
    expect(useLibraryView.getState().menu?.keyboard).toBe(true);
    await waitFor(() => {
      expect(within(menu).getByRole('menuitem', { name: 'Open with default app' })).toHaveFocus();
    });
    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(getRow('week 2 notes.md')).toHaveFocus();
    });
    // A right-click right after opens a menu again, however soon.
    fireEvent.contextMenu(getRow('week 2 notes.md'), { clientX: 40, clientY: 20 });
    expect(useLibraryView.getState().menu).toMatchObject({ keyboard: false });
  });
});

describe('Tags ▸', () => {
  it('closes the whole menu when Enter toggles a tag', async () => {
    const { user } = renderLibrary();
    await user.click(await findRow('MAT232'));
    await user.click(await findRow('week 2 notes.md'));
    await user.keyboard('{Shift>}{F10}{/Shift}');
    await screen.findByRole('menu');
    await user.keyboard('{ArrowDown}{ArrowDown}{ArrowDown}{Enter}');
    await screen.findByRole('menuitemcheckbox', { name: 'Notes' });
    await user.keyboard('{ArrowDown}{Enter}');
    await waitFor(() => {
      expect(screen.queryByRole('menu')).toBeNull();
    });
  });

  it('toggles a tag on a file at once, and keeps the menu open', async () => {
    const { user, shell } = renderLibrary();
    await user.click(await findRow('MAT232'));
    await openMenuOn(user, await findRow('week 2 notes.md'));
    await user.click(screen.getByRole('menuitem', { name: 'Tags' }));
    const exams = await screen.findByRole('menuitemcheckbox', { name: 'Exams' });
    expect(screen.getByRole('menuitemcheckbox', { name: 'Notes' })).toHaveAttribute('aria-checked', 'true');
    expect(exams).toHaveAttribute('aria-checked', 'false');

    await user.click(exams);
    expect(screen.getByRole('menuitemcheckbox', { name: 'Exams' })).toHaveAttribute('aria-checked', 'true');
    await waitFor(() => {
      const node = shell.library.root.children.get('Fall 2026')?.children.get('MAT232 Calculus of Several Variables');
      expect(node?.children.get('week 2 notes.md')?.tags).toEqual(['notes', 'exam']);
    });
    await user.keyboard('{Escape}{Escape}');
    await waitFor(() => {
      expect(getRow('week 2 notes.md')).toHaveAccessibleName('week 2 notes.md, tags Notes, Exams');
    });
  });

  it('shows a tag from a folder above as checked and disabled', async () => {
    const { user } = renderLibrary();
    await user.click(await findRow('MAT232'));
    await user.click(await findRow('Lectures'));
    await openMenuOn(user, await findRow('Lecture 01.pdf'));
    await user.click(screen.getByRole('menuitem', { name: 'Tags' }));
    const slides = await screen.findByRole('menuitemcheckbox', { name: /^Slides/ });
    expect(slides).toHaveAttribute('aria-checked', 'true');
    expect(slides).toHaveAttribute('aria-disabled', 'true');
    expect(slides).toHaveTextContent('From folder');
  });

  it('shows a tag every one of several entries gets from their folder as checked and disabled too', async () => {
    const { user } = renderLibrary();
    await user.click(await findRow('MAT232'));
    await user.click(await findRow('Lectures'));
    await user.click(await findRow('Lecture 01.pdf'));
    await user.keyboard('{Control>}');
    await user.click(getRow('Lecture 02.pdf'));
    await user.keyboard('{/Control}');
    await openMenuOn(user, getRow('Lecture 02.pdf'));
    await user.click(screen.getByRole('menuitem', { name: 'Tags' }));
    const slides = await screen.findByRole('menuitemcheckbox', { name: /^Slides/ });
    expect(slides).toHaveAttribute('aria-checked', 'true');
    expect(slides).toHaveAttribute('aria-disabled', 'true');
  });

  it('marks a tag some of several entries have as mixed, and adds it to all', async () => {
    const { user, shell } = renderLibrary();
    await user.click(await findRow('MAT232'));
    await user.click(await findRow('week 2 notes.md'));
    await user.keyboard('{Control>}');
    await user.click(getRow('Exams'));
    await user.keyboard('{/Control}');
    await openMenuOn(user, getRow('Exams'));
    await user.click(screen.getByRole('menuitem', { name: 'Tags' }));
    const notes = await screen.findByRole('menuitemcheckbox', { name: 'Notes' });
    expect(notes).toHaveAttribute('aria-checked', 'false');
    expect(notes.querySelector('.lucide-minus')).not.toBeNull();

    await user.click(notes);
    await waitFor(() => {
      const exams = shell.library.root.children
        .get('Fall 2026')
        ?.children.get('MAT232 Calculus of Several Variables')
        ?.children.get('Exams');
      expect(exams?.tags).toEqual(['notes']);
    });
  });

  it('says tags cannot change in a read-only library', async () => {
    const { user } = renderLibrary({ scenario: 'read-only' });
    await user.click(await findRow('MAT232'));
    await openMenuOn(user, await findRow('week 2 notes.md'));
    expect(screen.getByRole('menuitem', { name: "Tags can't change until you update Folio" })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
  });
});

describe('rename', () => {
  it('turns the name into a field with the name before the extension selected; Enter renames', async () => {
    const { user } = renderLibrary();
    await user.click(await findRow('MAT232'));
    await user.click(await findRow('week 2 notes.md'));
    await user.keyboard('{F2}');
    const field = screen.getByRole('textbox', { name: 'New name for week 2 notes.md' });
    expect(field).toHaveFocus();
    expect([(field as HTMLInputElement).selectionStart, (field as HTMLInputElement).selectionEnd]).toEqual([0, 12]);

    await user.keyboard('week 3 notes{Enter}');
    expect(await findRow('week 3 notes.md')).toBeInTheDocument();
    await waitFor(() => {
      expect(getRow('week 3 notes.md')).toHaveFocus();
    });
  });

  it('flags characters Windows refuses while typing, and Enter then does nothing', async () => {
    const { user, shell } = renderLibrary();
    await user.click(await findRow('MAT232'));
    await user.click(await findRow('week 2 notes.md'));
    await user.keyboard('{F2}week: 2{Enter}');
    const field = screen.getByRole('textbox');
    expect(field).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByRole('alert')).toHaveTextContent('A name can\'t contain \\ / : * ? " < > |');
    expect(field).toHaveAccessibleDescription('A name can\'t contain \\ / : * ? " < > |');
    expect(shell.library.root.children.get('Fall 2026')?.children.get('MAT232 Calculus of Several Variables')?.children.has('week 2 notes.md')).toBe(true);

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(getRow('week 2 notes.md')).toHaveFocus();
  });

  it('keeps the field open with the shell\'s reason, such as a taken name', async () => {
    const { user } = renderLibrary();
    await user.click(await findRow('MAT232'));
    await user.click(await findRow('week 2 notes.md'));
    await user.keyboard('{F2}');
    await user.clear(screen.getByRole('textbox'));
    await user.keyboard('第3章 偏导数.md{Enter}');
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'There\'s already an item called “第3章 偏导数.md” in MAT232.',
    );
    expect(screen.getByRole('textbox')).toBeInTheDocument();
  });

  it('asks before changing the extension; "Keep" keeps the old one', async () => {
    const { user } = renderLibrary();
    await user.click(await findRow('MAT232'));
    await user.click(await findRow('week 2 notes.md'));
    await user.keyboard('{F2}');
    await user.clear(screen.getByRole('textbox'));
    await user.keyboard('week 2.txt{Enter}');
    const dialog = await screen.findByRole('dialog', { name: 'Change the extension to .txt?' });
    expect(within(dialog).getByText('week 2 notes.md might open in a different app, or not at all.')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Keep .md' })).toHaveFocus();
    await user.click(within(dialog).getByRole('button', { name: 'Keep .md' }));
    expect(await findRow('week 2.md')).toBeInTheDocument();
  });

  it('keeps the old extension as written, also for a name that ends in a dot', async () => {
    const { user } = renderLibrary({ fixture: smallLibraryWith({ path: `${MAT}/Report.PDF` }) });
    await user.click(await findRow('MAT232'));
    await user.click(await findRow('Report.PDF'));
    await user.keyboard('{F2}');
    await user.clear(screen.getByRole('textbox'));
    await user.keyboard('Final.docx{Enter}');
    let dialog = await screen.findByRole('dialog', { name: 'Change the extension to .docx?' });
    await user.click(within(dialog).getByRole('button', { name: 'Keep .PDF' }));
    await user.click(await findRow('Final.PDF'));

    await user.keyboard('{F2}');
    await user.clear(screen.getByRole('textbox'));
    await user.keyboard('Summary.{Enter}');
    dialog = await screen.findByRole('dialog', { name: 'Remove the extension .PDF?' });
    await user.click(within(dialog).getByRole('button', { name: 'Keep .PDF' }));
    expect(await findRow('Summary.PDF')).toBeInTheDocument();
  });

  it('renames a file on a slow second click on its name', async () => {
    const { user } = renderLibrary();
    await user.click(await findRow('MAT232'));
    const row = await findRow('week 2 notes.md');
    await user.click(row);
    await new Promise((resolve) => setTimeout(resolve, 600));
    await user.click(within(row).getByText('week 2 notes.md'));
    expect(
      await screen.findByRole('textbox', { name: 'New name for week 2 notes.md' }, { timeout: 2000 }),
    ).toBeInTheDocument();
  });

  it('renames a course\'s folder in place; its code stays', async () => {
    const { user } = renderLibrary();
    await user.click(await findRow('CSC148'));
    await user.keyboard('{F2}');
    expect(screen.getByRole('textbox', { name: 'New name for CSC148 Introduction to Computer Science' })).toBeInTheDocument();
    await user.keyboard('{Escape}');
  });
});

describe('new folder', () => {
  it('adds a field first in the course, named "New folder"; Enter creates and selects it', async () => {
    const { user } = renderLibrary();
    await user.click(await findRow('MAT232'));
    await user.keyboard('{Control>}{Shift>}n{/Shift}{/Control}');
    const field = await screen.findByRole('textbox', { name: 'Name of the new folder' });
    expect(field).toHaveValue('New folder');
    await user.keyboard('{Enter}');
    const created = await findRow('New folder');
    await waitFor(() => {
      expect(created).toHaveAttribute('aria-selected', 'true');
    });
  });

  it('numbers the name when "New folder" is taken, and Esc creates nothing', async () => {
    const { user, shell } = renderLibrary();
    await user.click(await findRow('MAT232'));
    await user.keyboard('{Control>}{Shift>}n{/Shift}{/Control}');
    await user.keyboard('{Enter}');
    await findRow('New folder');
    await user.click(getRow('MAT232'));
    await user.keyboard('{Control>}{Shift>}n{/Shift}{/Control}');
    expect(await screen.findByRole('textbox', { name: 'Name of the new folder' })).toHaveValue('New folder (2)');
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('textbox')).toBeNull();
    const course = shell.library.root.children.get('Fall 2026')?.children.get('MAT232 Calculus of Several Variables');
    expect(course?.children.has('New folder (2)')).toBe(false);
  });
});

describe('delete', () => {
  it('moves a file to the Recycle Bin at once and says so', async () => {
    const { user } = renderLibrary();
    await user.click(await findRow('MAT232'));
    await user.click(await findRow('week 2 notes.md'));
    await user.keyboard('{Delete}');
    await waitFor(() => {
      expect(queryRow('week 2 notes.md')).toBeNull();
    });
    expect(toastTexts()).toContain('Moved week 2 notes.md to the Recycle Bin');
  });

  it('says so after Delete in the menu, which has closed by then', async () => {
    const { user } = renderLibrary();
    await user.click(await findRow('MAT232'));
    await openMenuOn(user, await findRow('week 2 notes.md'));
    await user.click(screen.getByRole('menuitem', { name: 'Delete' }));
    await waitFor(() => {
      expect(toastTexts()).toContain('Moved week 2 notes.md to the Recycle Bin');
    });
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('deletes once when Del is held down', async () => {
    const { user } = renderLibrary();
    await user.click(await findRow('MAT232'));
    await user.click(await findRow('week 2 notes.md'));
    await user.keyboard('{Delete>3/}');
    await waitFor(() => {
      expect(toastTexts()).toContain('Moved week 2 notes.md to the Recycle Bin');
    });
    // A second request would find the file gone and say so.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(toastTexts()).toEqual(['Moved week 2 notes.md to the Recycle Bin']);
  });

  it('says why a file could not go, and lists every failed item of several', async () => {
    const { user } = renderLibrary();
    await user.click(await findRow(ECO));
    await user.click(await findRow('Lecture recording week 5.mp4'));
    await user.keyboard('{Delete}');
    await waitFor(() => {
      expect(toastTexts()).toContain(
        "Couldn't delete Lecture recording week 5.mp4 — Another app is using it or something in it.",
      );
    });

    await user.keyboard('{Control>}');
    await user.click(getRow('Problem set 1.docx'));
    await user.keyboard('{/Control}');
    await user.keyboard('{Delete}');
    const details = await screen.findByRole('button', { name: 'Details' });
    expect(toastTexts()).toContain('Deleted 1 of 2 items');
    await user.click(details);
    const dialog = await screen.findByRole('dialog', { name: '1 item wasn\'t changed' });
    expect(within(dialog).getByRole('list', { name: 'Items that failed' })).toHaveTextContent(
      'ECO101 微观经济学 / Lecture recording week 5.mp4Another app is using it or something in it.',
    );
  });

  it('asks before deleting a course, with Cancel focused', async () => {
    const { user, shell } = renderLibrary();
    await user.click(await findRow('CSC148'));
    await user.keyboard('{Delete}');
    const dialog = await screen.findByRole('dialog', { name: 'Delete CSC148?' });
    expect(
      within(dialog).getByText(
        'The course folder “CSC148 Introduction to Computer Science” and its 14 files go to the Recycle Bin. You can restore them from there.',
      ),
    ).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toHaveFocus();

    await user.click(within(dialog).getByRole('button', { name: 'Delete course' }));
    await waitFor(() => {
      expect(shell.library.root.children.get('Fall 2026')?.children.has('CSC148 Introduction to Computer Science')).toBe(false);
    });
    expect(toastTexts()).toContain('Moved CSC148 to the Recycle Bin');
  });
});

describe('delete with a course among the items', () => {
  it('asks first, as for a course', async () => {
    const { user } = renderLibrary();
    await user.click(await findRow('MAT232'));
    await user.click(await findRow('week 2 notes.md'));
    await user.keyboard('{Control>}');
    await user.click(getRow('CSC148'));
    await user.keyboard('{/Control}');
    await user.keyboard('{Delete}');
    const dialog = await screen.findByRole('dialog', { name: 'Delete 2 items?' });
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toHaveFocus();
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(getRow('CSC148')).toBeInTheDocument();
  });
});

describe('move and copy path', () => {
  it('moves through the folder picker: where the items are reads "Already here"', async () => {
    const { user, shell } = renderLibrary();
    await user.click(await findRow('MAT232'));
    await openMenuOn(user, await findRow('week 2 notes.md'));
    await user.click(screen.getByRole('menuitem', { name: 'Move to…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Move week 2 notes.md' });
    // Choosing the item closed the menu, so nothing of it stays modal behind the dialog.
    await waitFor(() => {
      expect(useLibraryView.getState().menu).toBeNull();
    });
    const picker = within(dialog).getByRole('tree', { name: 'Folders in Fall 2026' });
    const here = within(picker).getByRole('treeitem', { name: /Already here/ });
    expect(here).toHaveAttribute('aria-disabled', 'true');
    const move = within(dialog).getByRole('button', { name: 'Move here' });
    expect(move).toBeDisabled();

    await user.click(here);
    expect(move).toBeDisabled();
    await user.click(await within(picker).findByRole('treeitem', { name: 'Problem sets' }));
    expect(move).toBeEnabled();
    await user.click(move);
    await waitFor(() => {
      const course = shell.library.root.children.get('Fall 2026')?.children.get('MAT232 Calculus of Several Variables');
      expect(course?.children.get('Problem sets')?.children.has('week 2 notes.md')).toBe(true);
    });
    expect(toastTexts()).toContain('Moved week 2 notes.md to MAT232 / Problem sets');
    // The window is usable again: nothing is left hidden behind the closed dialog.
    await waitFor(() => {
      expect(document.querySelector('.library-view[aria-hidden="true"], .library-view[inert]')).toBeNull();
    });
  });

  it('copies the absolute Windows path', async () => {
    const { user } = renderLibrary();
    await user.click(await findRow('CSC148'));
    await user.click(await findRow('hw1.py'));
    await user.keyboard('{Control>}{Shift>}c{/Shift}{/Control}');
    await waitFor(() => {
      expect(toastTexts()).toContain('Copied the path');
    });
    expect(await navigator.clipboard.readText()).toBe(`E:\\University of Toronto\\${CSC.split('/').join('\\')}\\hw1.py`);
  });
});
