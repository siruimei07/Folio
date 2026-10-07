// The context menu of a change (workspace-history handoff §3.7): its items by the kind of row,
// the check box item, disabled with its reason where the box cannot change, opened by a right-click,
// Shift+F10 or the Menu key, and what its items do, on the fake shell.
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { takeHistoryTarget } from '../../app/historyTarget';
import { useNavigation } from '../../app/navigation';
import { toastTexts } from '../../test/render';
import { useChangesView } from '../state';
import { CSC, entryPaths, findRow, getRow, MAT, menuItems, renderChanges, smallWorkspace } from '../test/render';

const ROOT = 'E:\\University of Toronto';
const IMG = 'Personal/Photos/IMG_2031.HEIC';

type User = ReturnType<typeof renderChanges>['user'];

async function openMenuOn(user: User, row: HTMLElement): Promise<HTMLElement> {
  await user.pointer({ keys: '[MouseRight]', target: row });
  return screen.findByRole('menu');
}

/** The selected row's key, as the view's store holds it. */
function selectedKey(): string | undefined {
  return useChangesView.getState().focus?.key;
}

describe('the context menu', () => {
  it('offers a file the file actions, its check box and Copy path, and selects it first', async () => {
    const { user } = renderChanges();
    const report = await findRow('CSC148/labs/lab1/report.docx');
    const menu = await openMenuOn(user, report);
    expect(menu).toHaveAccessibleName('Actions for report.docx');
    expect(menuItems()).toEqual(['Open with default app', 'Show in File Explorer', 'Leave out of this commitSpace', 'Copy pathCtrl+Shift+C']);
    // Separators between the groups.
    expect(within(menu).getAllByRole('separator')).toHaveLength(2);
    expect(report).toHaveAttribute('aria-selected', 'true');
  });

  it('offers a deleted file its check box and Copy path, and a folder Open in File Explorer', async () => {
    const { user } = renderChanges();
    await openMenuOn(user, await findRow('MAT232/Old slides L2.pdf'));
    expect(menuItems()).toEqual(['Leave out of this commitSpace', 'Copy pathCtrl+Shift+C']);
    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByRole('menu')).toBeNull();
    });
    await openMenuOn(user, getRow('MAT223/习题'));
    expect(menuItems()).toEqual(['Open in File Explorer', 'Leave out of this commitSpace', 'Copy pathCtrl+Shift+C']);
  });

  it("offers a file's tag change Copy path, and a settings change no menu", async () => {
    const { user } = renderChanges();
    const tags = await findRow('MAT232/Exams/Midterm/Midterm 2025.pdf');
    await openMenuOn(user, tags);
    expect(menuItems()).toEqual(['Copy pathCtrl+Shift+C']);
    await user.click(screen.getByRole('menuitem', { name: /^Copy path/ }));
    await waitFor(() => {
      expect(toastTexts()).toContain('Copied the path');
    });
    expect(await navigator.clipboard.readText()).toBe(`${ROOT}\\${MAT.split('/').join('\\')}\\Exams\\Midterm\\Midterm 2025.pdf`);

    await user.pointer({ keys: '[MouseRight]', target: getRow('CSC148 course settings') });
    expect(screen.queryByRole('menu')).toBeNull();
    // The right-click still selects the row.
    expect(getRow('CSC148 course settings')).toHaveAttribute('aria-selected', 'true');
  });

  it('includes and leaves out the row, as Space does', async () => {
    const { user } = renderChanges();
    const report = await findRow('CSC148/labs/lab1/report.docx');
    await openMenuOn(user, report);
    await user.click(screen.getByRole('menuitem', { name: /^Leave out of this commit/ }));
    expect(report).toHaveAttribute('aria-checked', 'false');
    await openMenuOn(user, report);
    expect(menuItems()).toContain('Include in this commitSpace');
    await user.click(screen.getByRole('menuitem', { name: /^Include in this commit/ }));
    expect(report).toHaveAttribute('aria-checked', 'true');
  });

  it("keeps the check box item of a blocked or required row, disabled, with the reason, and it does nothing", async () => {
    const { user } = renderChanges({
      fixture: smallWorkspace([
        { change: 'added', path: IMG, readiness: 'notLocal' },
        { change: 'modified', path: `${MAT}/week 2 notes.md`, required: true, parts: 1 },
        { change: 'added', path: `${CSC}/notes.md`, readiness: 'unreadable' },
      ]),
    });
    const img = await findRow('Photos/IMG_2031.HEIC');
    await openMenuOn(user, img);
    const include = screen.getByRole('menuitem', { name: 'Include in this commit' });
    expect(include).toHaveAttribute('aria-disabled', 'true');
    // The reason is the item's note (the shared Menu also makes it the item's description).
    expect(include).toHaveTextContent('Not downloaded yet');
    await user.click(include);
    expect(img).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByRole('menu')).toBeInTheDocument();
    await user.keyboard('{Escape}');

    await openMenuOn(user, getRow('MAT232/week 2 notes.md'));
    const leaveOut = screen.getByRole('menuitem', { name: 'Leave out of this commit' });
    expect(leaveOut).toHaveAttribute('aria-disabled', 'true');
    expect(leaveOut).toHaveTextContent('Always in the commit');
    await user.keyboard('{Escape}');

    await openMenuOn(user, getRow('CSC148/notes.md'));
    expect(screen.getByRole('menuitem', { name: 'Include in this commit' })).toHaveTextContent("Couldn't read it");
  });

  it('opens from the keyboard under the focused row, with focus on the first item, and gives the focus back', async () => {
    const { user } = renderChanges();
    const report = await findRow('CSC148/labs/lab1/report.docx');
    await user.click(report);
    await user.keyboard('{Shift>}{F10}{/Shift}');
    const menu = await screen.findByRole('menu');
    const anchor = document.querySelector<HTMLElement>('.context-menu-anchor');
    const under = anchor?.style.left;
    // The browser's own `contextmenu` that follows the key changes nothing: the menu stays under the row.
    fireEvent.contextMenu(report, { clientX: 40, clientY: 20 });
    expect(anchor?.style.left).toBe(under);
    await waitFor(() => {
      expect(within(menu).getByRole('menuitem', { name: 'Open with default app' })).toHaveFocus();
    });
    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(getRow('CSC148/labs/lab1/report.docx')).toHaveFocus();
    });
    await user.keyboard('{ContextMenu}');
    expect(await screen.findByRole('menu')).toHaveAccessibleName('Actions for report.docx');
    expect(selectedKey()).toMatch(/^item:/);
  });

  it('opens the file, shows it in File Explorer, or opens a folder in File Explorer', async () => {
    const { user, shell } = renderChanges();
    const invoke = vi.spyOn(shell, 'invoke');
    await openMenuOn(user, await findRow('CSC148/labs/lab1/report.docx'));
    await user.click(screen.getByRole('menuitem', { name: 'Show in File Explorer' }));
    await waitFor(() => {
      expect(entryPaths(invoke, 'reveal_entry')).toContain(`${CSC}/labs/lab1/report.docx`);
    });
    await openMenuOn(user, getRow('CSC148/labs/lab1/report.docx'));
    await user.click(screen.getByRole('menuitem', { name: 'Open with default app' }));
    await waitFor(() => {
      expect(entryPaths(invoke, 'open_entry')).toContain(`${CSC}/labs/lab1/report.docx`);
    });
    await openMenuOn(user, getRow('MAT223/习题'));
    await user.click(screen.getByRole('menuitem', { name: 'Open in File Explorer' }));
    await waitFor(() => {
      expect(entryPaths(invoke, 'open_entry')).toContain('Fall 2026/线性代数/习题');
    });
  });
});

describe('View history of this file, with History on the rail', () => {
  it('follows Show in File Explorer for a file and shows its history', async () => {
    const { user, shell } = renderChanges({ withHistory: true });
    await openMenuOn(user, await findRow('CSC148/labs/lab1/report.docx'));
    expect(menuItems()).toEqual([
      'Open with default app',
      'Show in File Explorer',
      'View history of this file',
      'Leave out of this commitSpace',
      'Copy pathCtrl+Shift+C',
    ]);
    await user.click(screen.getByRole('menuitem', { name: 'View history of this file' }));
    expect(useNavigation.getState().view).toBe('history');
    const node = shell.library.at(`${CSC}/labs/lab1/report.docx`);
    if (node === undefined) throw new Error('no report.docx');
    expect(takeHistoryTarget()).toEqual({ kind: 'entry', entry: shell.library.ref(node) });
  });

  it("comes first for a deleted file, as HEAD's version, and for a file's tags; never for a folder", async () => {
    const { user, shell } = renderChanges({ withHistory: true });
    await openMenuOn(user, await findRow('MAT232/Old slides L2.pdf'));
    expect(menuItems()).toEqual(['View history of this file', 'Leave out of this commitSpace', 'Copy pathCtrl+Shift+C']);
    await user.click(screen.getByRole('menuitem', { name: 'View history of this file' }));
    const head = shell.versioning.summary().head;
    expect(takeHistoryTarget()).toEqual({ kind: 'version', commit: head, path: `${MAT}/Old slides L2.pdf` });

    useNavigation.setState({ view: 'changes' });
    await openMenuOn(user, await findRow('MAT232/Exams/Midterm/Midterm 2025.pdf'));
    expect(menuItems()).toEqual(['View history of this file', 'Copy pathCtrl+Shift+C']);
    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByRole('menu')).toBeNull();
    });

    await openMenuOn(user, getRow('MAT223/习题'));
    expect(menuItems()).not.toContain('View history of this file');
  });

  it('is disabled with the reason for an added file, and in the diff’s More too', async () => {
    const { user } = renderChanges({ withHistory: true });
    await openMenuOn(user, await findRow('CSC148/a1/starter/tree.py'));
    const item = screen.getByRole('menuitem', { name: 'View history of this file' });
    expect(item).toHaveAttribute('aria-disabled', 'true');
    expect(item).toHaveAccessibleDescription('Not committed yet');
    await user.click(item);
    expect(screen.getByRole('menu')).toBeInTheDocument();
    expect(takeHistoryTarget()).toBeNull();
    await user.keyboard('{Escape}');

    await user.click(getRow('CSC148/labs/lab1/report.docx'));
    const pane = await screen.findByRole('group', { name: /report\.docx$/ });
    await user.click(within(pane).getByRole('button', { name: 'More' }));
    expect(menuItems()).toEqual(['Open with default app', 'Show in File Explorer', 'View history of this file', 'Copy pathCtrl+Shift+C']);
  });
});
