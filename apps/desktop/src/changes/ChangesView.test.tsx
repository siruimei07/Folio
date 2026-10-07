// The diff beside the changes list (workspace-history handoff §2.1, §3.6, §6.1): it follows the
// selection, refreshes with the workspace, takes the focus on Enter, offers the file actions in
// "More", and Ctrl+Shift+C copies the selected change's path, on the fake shell.
import { act, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, onTestFinished, vi } from 'vitest';

import { installShortcuts } from '../app/shortcuts';
import { toastTexts } from '../test/render';
import { mockScrolling } from '../test/virtual';
import { CSC, entryPaths, findRow, getRow, MAT, menuItems, renderChanges } from './test/render';

const ROOT = 'E:\\University of Toronto';
const FIRST_PAGE = { offset: 0, limit: 500 };

/** The diff pane, named by its heading. */
function diffPane(name: RegExp): Promise<HTMLElement> {
  return screen.findByRole('group', { name });
}

/** The workspace key of the item at `path`. */
function keyOf(shell: ReturnType<typeof renderChanges>['shell'], path: string): string {
  const found = shell.versioning.itemPage(FIRST_PAGE).items.find((item) => item.path === path);
  if (found === undefined) throw new Error(`no workspace item at ${path}`);
  return found.key;
}

/** The keys `get_workspace_diff` was asked for, oldest first. */
function diffKeys(invoke: { mock: { calls: readonly (readonly unknown[])[] } }): string[] {
  return invoke.mock.calls
    .filter(([command]) => command === 'get_workspace_diff')
    .map(([, payload]) => (payload as { request: { key: string } }).request.key);
}

describe('the diff beside the list', () => {
  it("shows the selected change's diff, and follows the selection by keys and clicks", async () => {
    const { user, shell } = renderChanges();
    const invoke = vi.spyOn(shell, 'invoke');
    const first = await findRow('CSC148/a1/run.bat');
    const pane = await diffPane(/run\.bat$/);
    expect(within(pane).getByRole('heading', { level: 2 })).toHaveTextContent('run.bat');
    await waitFor(() => {
      expect(diffKeys(invoke).at(-1)).toBe(keyOf(shell, `${CSC}/a1/run.bat`));
    });
    act(() => {
      first.focus();
    });
    await user.keyboard('{ArrowDown}');
    expect(await diffPane(/test_tree\.py$/)).toBeInTheDocument();
    await waitFor(() => {
      expect(diffKeys(invoke).at(-1)).toBe(keyOf(shell, `${CSC}/a1/starter/test_tree.py`));
    });
    // Selecting does not move the focus.
    expect(getRow('CSC148/a1/starter/test_tree.py')).toHaveFocus();

    await user.click(getRow('MAT232/Old slides L2.pdf'));
    expect(await diffPane(/Old slides L2\.pdf$/)).toBeInTheDocument();
    // A tag or settings change shows its own diff.
    await user.click(getRow('Ignore rules'));
    expect(await diffPane(/Ignore rules/)).toBeInTheDocument();
  });

  it("asks for the selected change's diff again when the workspace changes", async () => {
    const { shell } = renderChanges();
    const invoke = vi.spyOn(shell, 'invoke');
    await diffPane(/run\.bat$/);
    const key = keyOf(shell, `${CSC}/a1/run.bat`);
    await waitFor(() => {
      expect(diffKeys(invoke)).toContain(key);
    });
    const asked = diffKeys(invoke).filter((asking) => asking === key).length;
    act(() => {
      shell.editFile(`${CSC}/a1/run.bat`);
    });
    await waitFor(() => {
      expect(diffKeys(invoke).filter((asking) => asking === key).length).toBeGreaterThan(asked);
    });
  });

  it('moves the focus into the diff on Enter', async () => {
    const { user } = renderChanges();
    const first = await findRow('CSC148/a1/run.bat');
    const pane = await diffPane(/run\.bat$/);
    act(() => {
      first.focus();
    });
    await user.keyboard('{Enter}');
    await waitFor(() => {
      expect(pane.contains(document.activeElement)).toBe(true);
    });
  });

  it('keeps showing the selected change while the list scrolls its page away', async () => {
    mockScrolling();
    const { user } = renderChanges({ scenario: 'workspace-large' });
    const list = await screen.findByRole('listbox', { name: 'Changes' }, { timeout: 5000 });
    const [first] = await within(list).findAllByRole('option');
    if (first === undefined) throw new Error('no rows');
    act(() => {
      first.focus();
    });
    // The last item, past the two tag and settings changes at the end.
    await user.keyboard('{End}{ArrowUp}{ArrowUp}');
    const selected = await waitFor(() => {
      const option = within(list)
        .getAllByRole('option')
        .find((row) => row.getAttribute('aria-selected') === 'true');
      if (option === undefined || option.getAttribute('aria-busy') === 'true') throw new Error('the last item has not loaded');
      return option;
    }, { timeout: 5000 });
    const name = selected.querySelector('.path-heading__name')?.textContent ?? '';
    const pane = await diffPane(new RegExp(`${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`));
    expect(selected).toHaveAttribute('data-index', '49999');
    // Back at the top, the last page is not asked for: the selected row is a placeholder.
    act(() => {
      list.scrollTo({ top: 0 });
    });
    await waitFor(() => {
      expect(within(list).getAllByRole('option').find((row) => row.getAttribute('aria-selected') === 'true')).toHaveAttribute('aria-busy', 'true');
    });
    expect(pane).toBeInTheDocument();
    expect(within(pane).getByRole('heading', { level: 2 })).toHaveTextContent(name);
  });

  it('shows no diff over a list that failed to load', async () => {
    renderChanges({ fail: [{ command: 'list_workspace_items', code: 'Internal' }] });
    expect(await screen.findByRole('heading', { name: "Couldn't load your changes" })).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: /\./ })).toBeNull();
  });
});

describe("the diff's More", () => {
  it('offers the file actions of a file, a folder and a deleted file, and none for a settings change', async () => {
    const { user, shell } = renderChanges();
    const invoke = vi.spyOn(shell, 'invoke');
    const pane = await diffPane(/run\.bat$/);
    await user.click(within(pane).getByRole('button', { name: 'More' }));
    expect(menuItems()).toEqual(['Open with default app', 'Show in File Explorer', 'Copy pathCtrl+Shift+C']);
    await user.click(screen.getByRole('menuitem', { name: 'Open with default app' }));
    await waitFor(() => {
      expect(entryPaths(invoke, 'open_entry')).toEqual([`${CSC}/a1/run.bat`]);
    });

    await user.click(getRow('MAT223/习题'));
    await user.click(within(await diffPane(/习题$/)).getByRole('button', { name: 'More' }));
    expect(menuItems()).toEqual(['Open in File Explorer', 'Copy pathCtrl+Shift+C']);
    await user.keyboard('{Escape}');

    await user.click(getRow('MAT232/Old slides L2.pdf'));
    await user.click(within(await diffPane(/Old slides L2\.pdf$/)).getByRole('button', { name: 'More' }));
    expect(menuItems()).toEqual(['Copy pathCtrl+Shift+C']);
    await user.click(screen.getByRole('menuitem', { name: /^Copy path/ }));
    await waitFor(() => {
      expect(toastTexts()).toContain('Copied the path');
    });
    expect(await navigator.clipboard.readText()).toBe(`${ROOT}\\Fall 2026\\MAT232 Calculus of Several Variables\\Old slides L2.pdf`);

    await user.click(getRow('CSC148 course settings'));
    const settings = await diffPane(/CSC148/);
    expect(within(settings).queryByRole('button', { name: 'More' })).toBeNull();
  });
});

describe('Ctrl+Shift+C', () => {
  it('copies the selected change\'s path from the list and from the diff, and nothing for a settings change', async () => {
    onTestFinished(installShortcuts());
    const { user } = renderChanges();
    const first = await findRow('CSC148/a1/run.bat');
    const pane = await diffPane(/run\.bat$/);
    act(() => {
      first.focus();
    });
    await user.keyboard('{Control>}{Shift>}c{/Shift}{/Control}');
    await waitFor(() => {
      expect(toastTexts()).toEqual(['Copied the path']);
    });
    expect(await navigator.clipboard.readText()).toBe(`${ROOT}\\Fall 2026\\CSC148 Introduction to Computer Science\\a1\\run.bat`);

    await user.keyboard('{Enter}');
    await waitFor(() => {
      expect(pane.contains(document.activeElement)).toBe(true);
    });
    await navigator.clipboard.writeText('nothing');
    await user.keyboard('{Control>}{Shift>}c{/Shift}{/Control}');
    await waitFor(async () => {
      expect(await navigator.clipboard.readText()).toContain('run.bat');
    });

    await user.click(getRow('CSC148 course settings'));
    await navigator.clipboard.writeText('nothing');
    await user.keyboard('{Control>}{Shift>}c{/Shift}{/Control}');
    expect(await navigator.clipboard.readText()).toBe('nothing');
    // A file's tags name the file.
    await user.click(getRow(`MAT232/Exams/Midterm/Midterm 2025.pdf`));
    await user.keyboard('{Control>}{Shift>}c{/Shift}{/Control}');
    await waitFor(async () => {
      expect(await navigator.clipboard.readText()).toBe(`${ROOT}\\${MAT.split('/').join('\\')}\\Exams\\Midterm\\Midterm 2025.pdf`);
    });
  });
});
