// The Changes view in a narrow window (workspace-history handoff §2.2): the list takes the width;
// Enter or a click opens the selected change's diff over it, and Back, Esc and Alt+Left bring the
// list back with its scroll position, selection and focus, on the fake shell. The view is narrow
// below its own breakpoint, `size.changes-narrow-breakpoint` (§2.1 as built), also while the app
// is wide.
import { act, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, onTestFinished } from 'vitest';

import { currentLayout } from '../app/layout';
import { mockScrolling } from '../test/virtual';
import { SIZE } from '../tokens/tokens';
import { setListLayout } from './preferences';
import { useChangesView } from './state';
import {
  commitBox,
  commitButton,
  CSC,
  descriptionField,
  findRow,
  getRow,
  holdRequests,
  itemPageOffset,
  JOB_TEST,
  JOB_WAIT,
  renderChanges,
  resizeTo,
  settle,
  summaryField,
} from './test/render';

function covered(): boolean {
  return document.querySelector('.changes-view')?.hasAttribute('data-covered') === true;
}

/** Whether the view lays out narrow: its own attribute, which its stylesheets read. */
function narrowView(): boolean {
  return document.querySelector('.changes-view')?.hasAttribute('data-narrow') === true;
}

/** The diff over the list, by the name of its Back button. */
function backButton(): HTMLElement {
  return screen.getByRole('button', { name: 'Back to changes' });
}

describe('the narrow window', JOB_TEST, () => {
  beforeEach(() => {
    resizeTo(600);
  });
  afterEach(() => {
    resizeTo(1024);
  });

  it('shows the list alone until a change is opened', async () => {
    renderChanges();
    await findRow('CSC148/a1/run.bat');
    expect(screen.queryByRole('group', { name: /run\.bat$/ })).toBeNull();
    expect(document.querySelector('.changes-view__lane')).toBeNull();
    expect(covered()).toBe(false);
  });

  it('opens the change over the list on Enter, and Back brings the list back as it was, focus and scroll', async () => {
    mockScrolling();
    const { user } = renderChanges({ scenario: 'workspace-large' });
    const list = await screen.findByRole('listbox', { name: 'Changes' }, { timeout: 5000 });
    const [first] = await within(list).findAllByRole('option');
    if (first === undefined) throw new Error('no rows');
    act(() => {
      first.focus();
    });
    await user.keyboard('{PageDown}{PageDown}{PageDown}');
    const index = useChangesView.getState().focus?.index;
    expect(index).toBeGreaterThan(30);
    await waitFor(() => {
      expect(list.scrollTop).toBeGreaterThan(0);
    });
    const scrolled = list.scrollTop;
    const selected = list.querySelector<HTMLElement>(`[data-index="${String(index)}"]`);
    if (selected === null) throw new Error('the selected row is not rendered');
    await waitFor(() => {
      expect(selected).toHaveFocus();
    });

    await user.keyboard('{Enter}');
    expect(covered()).toBe(true);
    const pane = backButton().closest<HTMLElement>('[role="group"]');
    if (pane === null) throw new Error('no diff pane');
    await waitFor(() => {
      expect(pane.contains(document.activeElement)).toBe(true);
    });
    // The list stays as it was under the diff.
    expect(screen.getByRole('listbox', { name: 'Changes' })).toBe(list);
    expect(list.scrollTop).toBe(scrolled);

    await user.click(backButton());
    expect(covered()).toBe(false);
    expect(screen.queryByRole('button', { name: 'Back to changes' })).toBeNull();
    expect(list.scrollTop).toBe(scrolled);
    expect(useChangesView.getState().focus?.index).toBe(index);
    await waitFor(() => {
      expect(list.querySelector(`[data-index="${String(index)}"]`)).toHaveFocus();
    });
    // The list comes back with the fade and rise (ChangesView.css).
    expect(document.querySelector('.changes-view__main')).toHaveAttribute('data-returned');
  });

  it('opens the change on a click, and goes back with Esc and Alt+Left', async () => {
    const { user } = renderChanges();
    await user.click(await findRow('CSC148/labs/lab1/report.docx'));
    expect(covered()).toBe(true);
    const pane = await screen.findByRole('group', { name: /report\.docx$/ });
    await waitFor(() => {
      expect(pane.contains(document.activeElement)).toBe(true);
    });
    await user.keyboard('{Escape}');
    expect(covered()).toBe(false);
    await waitFor(() => {
      expect(getRow('CSC148/labs/lab1/report.docx')).toHaveFocus();
    });
    expect(getRow('CSC148/labs/lab1/report.docx')).toHaveAttribute('aria-selected', 'true');

    await user.keyboard('{Enter}');
    expect(covered()).toBe(true);
    await waitFor(() => {
      expect(screen.getByRole('group', { name: /report\.docx$/ }).contains(document.activeElement)).toBe(true);
    });
    await user.keyboard('{Alt>}{ArrowLeft}{/Alt}');
    expect(covered()).toBe(false);
    await waitFor(() => {
      expect(getRow('CSC148/labs/lab1/report.docx')).toHaveFocus();
    });
  });

  it('closes the diff when the list fails to load, and Try again brings back the list alone', async () => {
    const { user, shell } = renderChanges();
    await user.click(await findRow('CSC148/labs/lab1/report.docx'));
    expect(covered()).toBe(true);
    shell.setFailure('list_workspace_items', 'Internal');
    act(() => {
      shell.editFile(`${CSC}/a1/run.bat`);
    });
    expect(await screen.findByRole('heading', { name: "Couldn't load your changes" })).toBeInTheDocument();
    expect(covered()).toBe(false);
    expect(screen.queryByRole('button', { name: 'Back to changes' })).toBeNull();
    shell.setFailure('list_workspace_items', null);
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await findRow('CSC148/labs/lab1/report.docx')).toHaveAttribute('aria-selected', 'true');
    expect(covered()).toBe(false);
    expect(useChangesView.getState().diffOpen).toBe(false);
  });

  it('opens nothing from a click on a check box, which leaves the selection where it was', async () => {
    const { user } = renderChanges();
    const report = await findRow('CSC148/labs/lab1/report.docx');
    const box = report.querySelector<HTMLElement>('.checkbox');
    if (box === null) throw new Error('no check box');
    await user.click(box);
    expect(covered()).toBe(false);
    expect(report).toHaveAttribute('aria-checked', 'false');
  });

  it('opens nothing from a click on a course header, then or on the next key; a click on a change from there opens it', async () => {
    const { user } = renderChanges();
    await findRow('CSC148/a1/run.bat');
    act(() => {
      setListLayout('grouped');
    });
    const csc = await screen.findByRole('option', { name: /^CSC148 Introduction to Computer Science, / });
    await user.click(csc);
    expect(csc).toHaveFocus();
    expect(covered()).toBe(false);
    expect(useChangesView.getState().diffOpen).toBe(false);
    // An arrow key only moves the selection (§2.2: Enter or a click opens the diff).
    await user.keyboard('{ArrowDown}');
    expect(getRow('CSC148/a1/run.bat')).toHaveFocus();
    expect(covered()).toBe(false);
    // From the header, a click on a change opens that change at once.
    await user.keyboard('{ArrowUp}');
    expect(csc).toHaveFocus();
    await user.click(getRow('CSC148/labs/lab1/report.docx'));
    expect(covered()).toBe(true);
    expect(await screen.findByRole('group', { name: /report\.docx$/ })).toBeInTheDocument();
  });

  it('opens nothing from a click on a row whose page has not come, then or once it comes', async () => {
    mockScrolling();
    const { shell, user } = renderChanges({ scenario: 'workspace-large' });
    const list = await screen.findByRole('listbox', { name: 'Changes' }, { timeout: 5000 });
    await within(list).findAllByRole('option');
    // Every page past the first waits until the test lets it go.
    const { release } = holdRequests(shell, (command, request) => (itemPageOffset(command, request) ?? 0) > 0);
    act(() => {
      list.scrollTo({ top: 5000 * SIZE.row });
    });
    const placeholder = await waitFor(() => {
      const found = list.querySelector<HTMLElement>('[data-index="5003"]');
      if (found === null) throw new Error('row 5,003 is not rendered');
      expect(found).toHaveAttribute('aria-busy', 'true');
      return found;
    }, JOB_WAIT);
    await user.click(placeholder);
    expect(useChangesView.getState().diffOpen).toBe(false);
    expect(covered()).toBe(false);
    act(() => {
      release();
    });
    await waitFor(() => {
      expect(list.querySelector('[data-index="5003"]')).not.toHaveAttribute('aria-busy');
    }, JOB_WAIT);
    expect(useChangesView.getState().diffOpen).toBe(false);
    expect(covered()).toBe(false);
  });

  it('opens the selected change on Enter while its row waits for its page, from the change the diff kept', async () => {
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
      const option = list.querySelector<HTMLElement>('[data-index="49999"]');
      if (option === null) throw new Error('the last item is not rendered');
      expect(option).toHaveAttribute('aria-selected', 'true');
      expect(option).not.toHaveAttribute('aria-busy');
      return option;
    }, JOB_WAIT);
    const name = selected.querySelector('.path-heading__name')?.textContent ?? '';
    // Back at the top the last page is not asked for: the selected row, still focused, waits for it.
    act(() => {
      list.scrollTo({ top: 0 });
    });
    await waitFor(() => {
      expect(list.querySelector('[data-index="49999"]')).toHaveAttribute('aria-busy', 'true');
    });
    await waitFor(() => {
      expect(list.querySelector('[data-index="49999"]')).toHaveFocus();
    });
    await user.keyboard('{Enter}');
    expect(covered()).toBe(true);
    const pane = backButton().closest<HTMLElement>('[role="group"]');
    expect(within(pane ?? document.body).getByRole('heading', { level: 2 })).toHaveTextContent(name);
  });

  it('shows the diff beside the list again when the window widens, and covers the list again when it narrows with the focus in it', async () => {
    const { user } = renderChanges();
    await user.click(await findRow('CSC148/labs/lab1/report.docx'));
    expect(covered()).toBe(true);
    act(() => {
      resizeTo(1024);
    });
    expect(covered()).toBe(false);
    expect(screen.queryByRole('button', { name: 'Back to changes' })).toBeNull();
    const wide = await screen.findByRole('group', { name: /report\.docx$/ });
    await waitFor(() => {
      expect(wide.contains(document.activeElement)).toBe(true);
    });
    act(() => {
      resizeTo(600);
    });
    await waitFor(() => {
      expect(covered()).toBe(true);
    });
    expect(backButton()).toBeInTheDocument();
  });
});

describe("the view's own breakpoint", () => {
  afterEach(() => {
    resizeTo(1024);
  });

  it('lays out narrow at 900 px while the app stays wide: the list alone with the commit bar, the diff over it', async () => {
    resizeTo(900);
    const { user } = renderChanges();
    await findRow('CSC148/a1/run.bat');
    expect(currentLayout()).toBe('wide');
    expect(narrowView()).toBe(true);
    expect(document.querySelector('.changes-view__lane')).toBeNull();
    expect(document.querySelector('.changes-view__diff')).toBeNull();
    expect(commitBox()).toHaveClass('commit-bar');
    expect(screen.queryByRole('group', { name: /run\.bat$/ })).toBeNull();

    await user.click(getRow('CSC148/labs/lab1/report.docx'));
    expect(covered()).toBe(true);
    expect(backButton()).toBeInTheDocument();
    expect(await screen.findByRole('group', { name: /report\.docx$/ })).toBeInTheDocument();
  });

  it('shows the three columns at 1,100 px, and turns narrow just below the breakpoint', async () => {
    resizeTo(1100);
    renderChanges();
    await findRow('CSC148/a1/run.bat');
    expect(narrowView()).toBe(false);
    expect(document.querySelector('.changes-view__lane')).not.toBeNull();
    expect(commitBox()).toHaveClass('commit-box');
    expect(await screen.findByRole('group', { name: /run\.bat$/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Back to changes' })).toBeNull();

    act(() => {
      resizeTo(SIZE.changesNarrowBreakpoint);
    });
    expect(narrowView()).toBe(false);
    act(() => {
      resizeTo(SIZE.changesNarrowBreakpoint - 1);
    });
    expect(narrowView()).toBe(true);
    expect(currentLayout()).toBe('wide');
    expect(document.querySelector('.changes-view__lane')).toBeNull();
    expect(commitBox()).toHaveClass('commit-bar');
  });
});

// A window snapped to half a 1920 px screen (960 px) crosses the breakpoint: the commit box turns
// into the bar and the diff beside the list into the one over it, and the focus goes with them.
describe('the focus across the breakpoint', () => {
  afterEach(() => {
    resizeTo(1024);
  });

  it('stays on the same control when the commit box turns into the bar and back, the draft kept', async () => {
    resizeTo(1100);
    const { user } = renderChanges();
    await findRow('CSC148/a1/run.bat');
    await user.type(summaryField(), 'Half a thought');
    act(() => {
      resizeTo(960);
    });
    await waitFor(() => {
      expect(summaryField()).toHaveFocus();
    });
    expect(commitBox()).toHaveClass('commit-bar');
    expect(summaryField()).toHaveValue('Half a thought');
    act(() => {
      resizeTo(1100);
    });
    await waitFor(() => {
      expect(summaryField()).toHaveFocus();
    });
    expect(commitBox()).toHaveClass('commit-box');

    // A description typed in the box opens the bar's, where the focus goes.
    await user.type(descriptionField(), 'More');
    act(() => {
      resizeTo(960);
    });
    await waitFor(() => {
      expect(descriptionField()).toHaveFocus();
    });
    act(() => {
      commitButton().focus();
    });
    act(() => {
      resizeTo(1100);
    });
    await waitFor(() => {
      expect(commitButton()).toHaveFocus();
    });
  });

  it('moves the focus from the diff beside the list into the diff over it, and back', async () => {
    resizeTo(1100);
    const { user } = renderChanges();
    await user.click(await findRow('CSC148/labs/lab1/report.docx'));
    const wide = await screen.findByRole('group', { name: /report\.docx$/ });
    await user.keyboard('{Enter}');
    await waitFor(() => {
      expect(wide.contains(document.activeElement)).toBe(true);
    });
    act(() => {
      resizeTo(960);
    });
    // The person was reading the diff: it covers the list, with the focus in it.
    await waitFor(() => {
      expect(covered()).toBe(true);
    });
    await waitFor(() => {
      expect(backButton().closest('[role="group"]')?.contains(document.activeElement)).toBe(true);
    });
    act(() => {
      resizeTo(1100);
    });
    expect(covered()).toBe(false);
    await waitFor(() => {
      expect(screen.getByRole('group', { name: /report\.docx$/ }).contains(document.activeElement)).toBe(true);
    });
    expect(useChangesView.getState().diffOpen).toBe(false);
  });

  it('leaves the list uncovered, with its focus, after a diff opened in a narrow window was left in a wide one', async () => {
    resizeTo(900);
    const { user } = renderChanges();
    await user.click(await findRow('CSC148/labs/lab1/report.docx'));
    expect(covered()).toBe(true);
    act(() => {
      resizeTo(1100);
    });
    expect(useChangesView.getState().diffOpen).toBe(false);
    await user.click(getRow('CSC148/a1/run.bat'));
    expect(getRow('CSC148/a1/run.bat')).toHaveFocus();
    act(() => {
      resizeTo(960);
    });
    await settle();
    expect(covered()).toBe(false);
    expect(getRow('CSC148/a1/run.bat')).toHaveFocus();
    // Enter still opens the diff over it, with the focus, and Esc comes back.
    await user.keyboard('{Enter}');
    expect(covered()).toBe(true);
    await waitFor(() => {
      expect(screen.getByRole('group', { name: /run\.bat$/ }).contains(document.activeElement)).toBe(true);
    });
    await user.keyboard('{Escape}');
    expect(covered()).toBe(false);
    await waitFor(() => {
      expect(getRow('CSC148/a1/run.bat')).toHaveFocus();
    });
  });

  it("gives a closed description's focus to the summary, and the message button's to the bar's", async () => {
    resizeTo(1100);
    renderChanges();
    await findRow('CSC148/a1/run.bat');
    // The box's description is empty, so the bar's stays closed, hidden, and cannot take the focus.
    act(() => {
      descriptionField().focus();
    });
    act(() => {
      resizeTo(960);
    });
    await waitFor(() => {
      expect(summaryField()).toHaveFocus();
    });
    // The message button (Generate) and its options chevron: the bar's one message button.
    for (const name of ['Generate', 'Message options']) {
      act(() => {
        resizeTo(1100);
      });
      act(() => {
        within(commitBox()).getByRole('button', { name }).focus();
      });
      act(() => {
        resizeTo(960);
      });
      await waitFor(() => {
        expect(within(commitBox()).getByRole('button', { name: 'Generate a message' })).toHaveFocus();
      });
    }
  });

  it("keeps the bar's description off the focused row in a short window, opening it only with the focus that comes from the box", async () => {
    resizeTo(1100);
    const tall = window.innerHeight;
    onTestFinished(() => {
      window.innerHeight = tall;
      window.dispatchEvent(new Event('resize'));
    });
    act(() => {
      window.innerHeight = 320;
      window.dispatchEvent(new Event('resize'));
    });
    const { user } = renderChanges();
    await findRow('CSC148/a1/run.bat');
    await user.type(descriptionField(), 'Why');
    // The focus is on a row when the box turns into the bar: its description, over the list, stays closed.
    await user.click(getRow('CSC148/labs/lab1/report.docx'));
    act(() => {
      resizeTo(960);
    });
    await settle();
    const description = commitBox().querySelector('.commit-bar__description');
    expect(description).toHaveAttribute('data-over');
    expect(description).not.toHaveAttribute('data-open');
    expect(getRow('CSC148/labs/lab1/report.docx')).toHaveFocus();
    expect(within(commitBox()).getByRole('button', { name: 'Show the description' })).toBeInTheDocument();
    // From the box's description, the description opens with the focus in it.
    act(() => {
      resizeTo(1100);
    });
    act(() => {
      descriptionField().focus();
    });
    act(() => {
      resizeTo(960);
    });
    await waitFor(() => {
      expect(descriptionField()).toHaveFocus();
    });
    expect(commitBox().querySelector('.commit-bar__description')).toHaveAttribute('data-open');
  });

  it("moves the focus from the Not synced card's Try again to the selected row when the card goes", async () => {
    resizeTo(1100);
    renderChanges({ fail: [{ command: 'list_history', code: 'Internal' }] });
    const row = await findRow('CSC148/a1/run.bat');
    const notSynced = screen.getByRole('region', { name: 'Not synced' });
    act(() => {
      within(notSynced).getByRole('button', { name: 'Try again' }).focus();
    });
    act(() => {
      resizeTo(960);
    });
    expect(screen.queryByRole('region', { name: 'Not synced' })).toBeNull();
    await waitFor(() => {
      expect(row).toHaveFocus();
    });
  });

  it('keeps the focus in the view when the diff it was in goes with the list, which failed to load', async () => {
    resizeTo(1100);
    const { user, shell } = renderChanges();
    await user.click(await findRow('CSC148/labs/lab1/report.docx'));
    const wide = await screen.findByRole('group', { name: /report\.docx$/ });
    await user.keyboard('{Enter}');
    await waitFor(() => {
      expect(wide.contains(document.activeElement)).toBe(true);
    });
    shell.setFailure('list_workspace_items', 'Internal');
    act(() => {
      shell.editFile(`${CSC}/a1/run.bat`);
    });
    expect(await screen.findByRole('heading', { name: "Couldn't load your changes" })).toBeInTheDocument();
    // No row and no diff are left: the commit button keeps the focus in the view.
    await waitFor(() => {
      expect(commitButton()).toHaveFocus();
    });
  });
});
