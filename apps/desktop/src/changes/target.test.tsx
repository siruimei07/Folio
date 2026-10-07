// "Show in Changes" in the Changes view (app/changeTarget.ts): the view finds the change at a path,
// on whatever page it is, then selects, scrolls to and focuses its row; or says why it cannot, on
// the fake shell. Asked for without a path, the view takes the focus.
import { act, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { showChange } from '../app/changeTarget';
import { useNavigation } from '../app/navigation';
import { useToasts } from '../app/toasts';
import { toastTexts } from '../test/render';
import { captureResizeObservers, mockScrolling } from '../test/virtual';
import { setDiffOpen, useChangesView } from './state';
import { commitButton, findRow, holdRequests, itemPageOffset, renderChanges, resizeTo, settle, smallWorkspace } from './test/render';

/** The offsets of the pages of items the fake shell was asked for, oldest first. */
function itemPages(invoke: { mock: { calls: readonly (readonly unknown[])[] } }): number[] {
  return invoke.mock.calls
    .filter(([command]) => command === 'list_workspace_items')
    .map(([, payload]) => (payload as { request: { page: { offset: number } } }).request.page.offset);
}

async function longList() {
  mockScrolling();
  const app = renderChanges({ scenario: 'workspace-large' });
  const list = await screen.findByRole('listbox', { name: 'Changes' }, { timeout: 5000 });
  await within(list).findAllByRole('option');
  return { ...app, list };
}

afterEach(() => {
  resizeTo(1024);
});

describe('Show in Changes', () => {
  it('finds a change on a later page of a long list, then selects, scrolls to and focuses it', async () => {
    const { shell, list } = await longList();
    const invoke = vi.spyOn(shell, 'invoke');
    const [target] = shell.versioning.itemPage({ offset: 30_123, limit: 1 }).items;
    if (target === undefined) throw new Error('no item 30,123');
    useNavigation.setState({ view: 'history' });
    act(() => {
      showChange(target.path);
    });
    expect(useNavigation.getState().view).toBe('changes');
    await waitFor(
      () => {
        expect(useChangesView.getState().focus).toEqual({ key: `item:${target.key}`, index: 30_123 });
      },
      { timeout: 5000 },
    );
    await waitFor(() => {
      const row = list.querySelector('[data-index="30123"]');
      expect(row).toHaveAttribute('aria-selected', 'true');
      expect(row).not.toHaveAttribute('aria-busy');
      expect(row).toHaveFocus();
    });
    expect(list.scrollTop).toBeGreaterThan(0);
    // The pages were read from the top up to the one that holds it, and not beyond.
    expect(itemPages(invoke)).toContain(30_000);
    expect(Math.max(...itemPages(invoke))).toBeLessThan(31_000);
    expect(screen.getByRole('group', { name: new RegExp(`${target.path.split('/').at(-1) ?? ''}$`) })).toBeInTheDocument();
  });

  it('closes the diff over the list in a narrow window to show the change', async () => {
    resizeTo(600);
    renderChanges();
    await findRow('CSC148/a1/run.bat');
    act(() => {
      setDiffOpen(true);
    });
    expect(screen.getByRole('button', { name: 'Back to changes' })).toBeInTheDocument();
    act(() => {
      showChange('Fall 2026/MAT232 Calculus of Several Variables/Old slides L2.pdf');
    });
    const row = await findRow('MAT232/Old slides L2.pdf');
    await waitFor(() => {
      expect(row).toHaveFocus();
    });
    expect(row).toHaveAttribute('aria-selected', 'true');
    expect(screen.queryByRole('button', { name: 'Back to changes' })).toBeNull();
  });

  it('says when no change has that path any more', async () => {
    renderChanges();
    const first = await findRow('CSC148/a1/run.bat');
    act(() => {
      showChange('Fall 2026/Nowhere.md');
    });
    await waitFor(() => {
      expect(toastTexts()).toEqual(["That change isn't in the list anymore"]);
    });
    expect(first).toHaveAttribute('aria-selected', 'true');
  });

  it('drops a search under way when the view goes: nothing is selected or said later', async () => {
    const { shell, unmount } = await longList();
    useToasts.setState({ toasts: [] });
    // The pages after the first wait until the view has gone.
    const { invoke, release } = holdRequests(shell, (command, request) => (itemPageOffset(command, request) ?? 0) > 0);
    act(() => {
      showChange('Not in the list.md');
    });
    await waitFor(() => {
      expect(itemPages(invoke).some((offset) => offset > 0)).toBe(true);
    });
    const asked = itemPages(invoke).length;
    unmount();
    act(() => {
      release();
    });
    await act(() => new Promise((resolve) => setTimeout(resolve, 200)));
    expect(toastTexts()).toEqual([]);
    // It read no further than the pages it had asked for.
    expect(itemPages(invoke)).toHaveLength(asked);
  });

  it('says when a page fails while it looks, with Copy details', async () => {
    const { shell } = await longList();
    useToasts.setState({ toasts: [] });
    shell.setFailure('list_workspace_items', 'Internal');
    act(() => {
      showChange('Not in the list.md');
    });
    await waitFor(() => {
      expect(toastTexts()).toEqual([expect.stringMatching(/^Couldn't find that change — /)]);
    });
    expect(useToasts.getState().toasts[0]?.actions?.map((action) => action.label)).toEqual(['Copy details']);
  });
});

describe('Changes asked for without a path ("Go to Changes")', () => {
  it('gives the focus to the list’s focused row', async () => {
    renderChanges();
    const list = await screen.findByRole('listbox', { name: 'Changes' });
    await within(list).findAllByRole('option');
    useNavigation.setState({ view: 'history' });

    act(() => {
      showChange();
    });

    expect(useNavigation.getState().view).toBe('changes');
    await waitFor(() => {
      expect(list.contains(document.activeElement)).toBe(true);
    });
    expect(document.activeElement).toHaveAttribute('role', 'option');
  });

  it('waits for the rows of a list whose scroller has no size yet, as when Changes first shows', async () => {
    // The scroller measures 0 × 0 until the test resizes it, as a view shown for the first time
    // does before its first layout: the virtualiser renders no rows until then.
    const size = { width: 0, height: 0 };
    const resized = captureResizeObservers();
    renderChanges({ layout: size });
    const list = await screen.findByRole('listbox', { name: 'Changes' });
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /^Commit \d+ changes$/ })).toBeInTheDocument();
    });

    act(() => {
      showChange();
    });
    await settle();
    expect(within(list).queryAllByRole('option')).toHaveLength(0);

    act(() => {
      size.width = 800;
      size.height = 600;
      resized();
    });
    await waitFor(() => {
      expect(document.activeElement).toHaveAttribute('role', 'option');
    });
    expect(list.contains(document.activeElement)).toBe(true);
  });

  it('gives it to the diff over the list in a narrow window, where the list is hidden under it', async () => {
    resizeTo(600);
    renderChanges();
    await findRow('CSC148/a1/run.bat');
    act(() => {
      setDiffOpen(true);
    });
    expect(screen.getByRole('button', { name: 'Back to changes' })).toBeInTheDocument();

    act(() => {
      showChange();
    });

    await waitFor(() => {
      expect(document.activeElement?.closest('.changes-view__cover')).not.toBeNull();
    });
    expect(useChangesView.getState().diffOpen).toBe(true);
  });

  it('gives it to the commit button when there is nothing to list', async () => {
    renderChanges({ fixture: smallWorkspace([], { metadata: false }) });
    expect(await screen.findByRole('heading', { name: 'No changes' })).toBeInTheDocument();

    act(() => {
      showChange();
    });

    await waitFor(() => {
      expect(commitButton()).toHaveFocus();
    });
  });
});
