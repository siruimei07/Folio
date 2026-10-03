// Files dropped from File Explorer on the Library (library-actions handoff §3) against the fake
// shell: the row and panel targets, the import dialog a drop opens, when a drop adds nothing, and
// a drop the shell refused.
import { act, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { closeDialog, openDialog, useNavigation } from '../app/navigation';
import { setFilter } from './state';
import { CSC, findRow, getRow, renderLibrary, toastTexts } from './test/render';

/** jsdom has no layout, so the element under the pointer is the one a test names. */
function pointAt(element: () => Element) {
  Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: vi.fn(element) });
}

const AT = { x: 10, y: 10 };

/** The panel target's card, when it shows. */
function panelTarget(): string | null {
  return document.querySelector('.drop-panel[data-visible]')?.textContent ?? null;
}

afterEach(() => {
  Reflect.deleteProperty(document, 'elementFromPoint');
  closeDialog();
});

describe('dropping files on the Library', () => {
  it('shows "Add here" on the course or folder row under the pointer, and on a file row\'s folder', async () => {
    const { user, shell } = renderLibrary({ dialogs: ['import'] });
    await user.click(await findRow('MAT232'));
    pointAt(() => getRow('MAT223'));
    act(() => {
      shell.dragOver(AT);
    });
    expect(await within(getRow('MAT223')).findByText('Add here')).toBeInTheDocument();
    expect(panelTarget()).toBeNull();

    pointAt(() => getRow('week 2 notes.md'));
    act(() => {
      shell.dragOver({ x: 12, y: 12 });
    });
    expect(await within(getRow('MAT232')).findByText('Add here')).toBeInTheDocument();
    expect(within(getRow('MAT223')).queryByText('Add here')).toBeNull();

    act(() => {
      shell.dragOver(null);
    });
    await waitFor(() => {
      expect(screen.queryByText('Add here')).toBeNull();
    });
  });

  it('opens a collapsed course that stays under the pointer, while drag-over events keep coming', async () => {
    const { shell } = renderLibrary({ dialogs: ['import'] });
    const course = await findRow('MAT232');
    expect(course).toHaveAttribute('aria-expanded', 'false');
    pointAt(() => getRow('MAT232'));
    // Windows repeats DragOver while the pointer rests or moves within the row.
    for (let step = 0; step < 9; step++) {
      act(() => {
        shell.dragOver({ x: 10 + step, y: 10 });
      });
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    await waitFor(
      () => {
        expect(getRow('MAT232')).toHaveAttribute('aria-expanded', 'true');
      },
      { timeout: 2000 },
    );
  });

  it('shows the current course on the preview elsewhere, and a drop there opens the import dialog', async () => {
    const { user, shell } = renderLibrary({ dialogs: ['import'] });
    await user.click(await findRow('CSC148'));
    act(() => {
      setFilter(['notes']);
    });
    pointAt(() => document.body);
    act(() => {
      shell.dragOver(AT);
    });
    await waitFor(() => {
      expect(panelTarget()).toBe('Drop to add to CSC148Files are copied into the course. The originals stay where they are.');
    });

    act(() => {
      shell.dropFiles(undefined, AT);
    });
    await waitFor(() => {
      expect(useNavigation.getState().dialog?.kind).toBe('import');
    });
    const opened = useNavigation.getState().dialog;
    if (opened?.kind !== 'import') throw new Error('No import dialog');
    expect(opened.params.target?.path).toBe(CSC);
    expect(opened.params.tags).toEqual(['notes']);
    expect(opened.params.source.names.map((item) => item.name)).toEqual(['Lecture 05 - Gradients.pdf', 'hw3.py', 'Lab 2']);
    expect(panelTarget()).toBeNull();
  });

  it('asks where the files go when nothing is selected yet', async () => {
    const { shell } = renderLibrary({ dialogs: ['import'] });
    await findRow('MAT232');
    pointAt(() => document.body);
    act(() => {
      shell.dragOver(AT);
    });
    await waitFor(() => {
      expect(panelTarget()).toBe("Drop to add filesYou'll choose where they go next.");
    });
    act(() => {
      shell.dropFiles(undefined, AT);
    });
    await waitFor(() => {
      expect(useNavigation.getState().dialog).toMatchObject({ kind: 'import', params: { target: null } });
    });
  });

  it('adds nothing while a dialog is open, and says so', async () => {
    const { shell } = renderLibrary({ dialogs: ['import'] });
    await findRow('MAT232');
    act(() => {
      openDialog('search');
    });
    pointAt(() => getRow('MAT232'));
    act(() => {
      shell.dragOver(AT);
    });
    act(() => {
      shell.dropFiles(undefined, AT);
    });
    await waitFor(() => {
      expect(toastTexts()).toEqual(['Close the dialog to add files.']);
    });
    expect(screen.queryByText('Add here')).toBeNull();
    expect(useNavigation.getState().dialog?.kind).toBe('search');
  });

  it('adds nothing while a menu is open, and says so', async () => {
    const { shell } = renderLibrary({ dialogs: ['import'] });
    await findRow('MAT232');
    const menu = document.createElement('div');
    menu.setAttribute('data-popover', '');
    document.body.append(menu);
    act(() => {
      shell.dropFiles(undefined, AT);
    });
    await waitFor(() => {
      expect(toastTexts()).toEqual(['Close the menu to add files.']);
    });
    menu.remove();
    expect(useNavigation.getState().dialog).toBeNull();
  });

  it('says why the shell refused a drop', async () => {
    const { shell } = renderLibrary({ dialogs: ['import'] });
    await findRow('MAT232');
    act(() => {
      shell.dropFails({ code: 'InvalidArgument', detail: 'invalid import selection size' });
    });
    await waitFor(() => {
      expect(toastTexts()).toEqual([
        "Couldn't add the dropped files — Folio can take up to 10,000 items at a time, and not a folder together with something inside it. Drop fewer items, or add them in parts.",
      ]);
    });
    act(() => {
      shell.dropFails({ code: 'Busy', detail: 'rebuilding' });
    });
    await waitFor(() => {
      expect(toastTexts()).toContain("Folio is rebuilding its index. Add the files when it's done.");
    });
  });
});
