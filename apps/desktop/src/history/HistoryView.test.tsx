// The History view on the fake shell (handoff workspace-history §7.1, §7.5, §2; app-shell §7): its
// states, the type filter and its memory, the resize handle, and the narrow window.
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { showHistory, showHistoryTimeline } from '../app/historyTarget';
import { NOW } from '../test/data';
import { refOf } from '../test/files';
import { emptyHistory, smallHistoryWith, withoutWorkspaceChange } from '../test/history';
import { renderApp, settle } from '../test/render';
import { SIZE } from '../tokens/tokens';
import { captureResizeObservers, mockScrolling } from '../test/virtual';
import { HistoryView } from './HistoryView';
import { setPanelWidth, useHistoryPreferences } from './preferences';
import { focusTimeline, showTypes, useHistoryView } from './state';
import {
  findFeed,
  NARROW,
  narrowWindow,
  politeText,
  refuseFocusWhenHidden,
  renderAnnounced,
  renderHistory,
  renderHostedHistory,
  resetHistoryPreferences,
  resizeWindow,
  scrollTimelineTo,
  timelineScroller,
  WIDE,
} from './test/render';

resetHistoryPreferences();

const STORAGE_KEY = 'folio.history.preferences';

// jsdom has no pointer capture, which the handle holds while it is dragged.
const pointerCapture = { set: vi.fn(), has: vi.fn(() => true), release: vi.fn() };
const element = HTMLElement.prototype as Partial<HTMLElement>;
beforeAll(() => {
  element.setPointerCapture = pointerCapture.set;
  element.hasPointerCapture = pointerCapture.has;
  element.releasePointerCapture = pointerCapture.release;
});
afterAll(() => {
  delete element.setPointerCapture;
  delete element.hasPointerCapture;
  delete element.releasePointerCapture;
});

/** The filter's button; the rest of the window is hidden from screen readers while its menu is open. */
function filterButton(): HTMLElement {
  return screen.getByRole('button', { name: /^Filter by type: /, hidden: true });
}

function separator(): HTMLElement {
  return screen.getByRole('separator', { name: 'Resize the history panel' });
}

/** The element whose width the handle sets: the one it controls. */
function panelFrame(): HTMLElement {
  const id = separator().getAttribute('aria-controls');
  const frame = id === null ? null : document.getElementById(id);
  if (frame === null) throw new Error('no panel frame');
  return frame;
}

describe('the History view', () => {
  it('shows the panel with its filter and timeline, and the diff column with the desk', async () => {
    renderHistory();

    expect(screen.getByRole('heading', { level: 2, name: 'History' })).toBeInTheDocument();
    expect(filterButton()).toHaveTextContent('All types');
    expect(filterButton()).not.toHaveAttribute('data-filtering');
    const feed = await findFeed();
    expect(within(feed).getAllByRole('article')).toHaveLength(8);
    const diff = screen.getByRole('region', { name: 'Selected version' });
    expect(diff).toHaveTextContent('Select a file to see this version and what changed');
    expect(diff.querySelector('svg.desk-illustration')).not.toBeNull();
  });

  it('shows skeleton entries only after 150 ms while the first page loads', async () => {
    renderHistory({ latencyMs: 600 });

    expect(screen.queryByRole('status', { name: 'Loading the history' })).not.toBeInTheDocument();
    expect(await screen.findByRole('status', { name: 'Loading the history' })).toBeInTheDocument();
    await findFeed();
    expect(screen.queryByRole('status', { name: 'Loading the history' })).not.toBeInTheDocument();
  });

  it('says there is no history yet when the timeline is empty', async () => {
    renderHistory({ fixture: emptyHistory() });

    expect(await screen.findByRole('heading', { name: 'No history yet' })).toBeInTheDocument();
    expect(screen.getByText('Commit your changes and each commit shows up here, newest first.')).toBeInTheDocument();
    expect(screen.queryByRole('feed')).not.toBeInTheDocument();
  });

  it('says when the filter matches nothing, and "Show all types" shows everything again', async () => {
    useHistoryPreferences.setState({ types: ['uncommit', 'restore'] });
    const { user } = renderHistory({ fixture: emptyHistory() });

    expect(await screen.findByRole('heading', { name: 'Nothing of these types yet' })).toBeInTheDocument();
    expect(screen.getByText('No undone commits or restores so far.')).toBeInTheDocument();
    expect(filterButton()).toHaveTextContent('2 types');

    await user.click(screen.getByRole('button', { name: 'Show all types' }));

    expect(await screen.findByRole('heading', { name: 'No history yet' })).toBeInTheDocument();
    expect(filterButton()).toHaveTextContent('All types');
    expect(useHistoryPreferences.getState().types).toBeNull();
  });

  it('names the one kind it looks for', async () => {
    useHistoryPreferences.setState({ types: ['restore'] });
    renderHistory();

    expect(await screen.findByText('No restores so far.')).toBeInTheDocument();
    expect(filterButton()).toHaveTextContent('1 type');
  });

  it('says when the history cannot be read, with Try again and Copy details', async () => {
    const { user, shell } = renderHistory({ fail: [{ command: 'list_history', code: 'Internal' }] });

    expect(await screen.findByRole('heading', { name: "Couldn't load the history" })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy details' })).toBeInTheDocument();
    shell.setFailure('list_history', null);

    await user.click(screen.getByRole('button', { name: 'Try again' }));

    expect(await findFeed()).toBeInTheDocument();
  });

  // TimelineArea is keyed by its list: a failure kept while its retry reads stays with its list.
  it('shows no failure of the whole history in a file’s history opened while its Try again reads', async () => {
    const { shell, user } = renderHistory({ latencyMs: 400, fail: [{ command: 'list_history', code: 'Internal' }] });
    const tryAgain = await screen.findByRole('button', { name: 'Try again' }, { timeout: 3000 });
    await user.click(tryAgain);
    expect(screen.getByRole('heading', { name: "Couldn't load the history" })).toBeInTheDocument();
    shell.setFailure('list_history', null);

    act(() => {
      showHistory({ kind: 'entry', entry: refOf('Fall 2026/MAT232 Calculus of Several Variables/第3章 偏导数.md') });
    });

    await screen.findByRole('button', { name: 'Show the whole history' });
    expect(screen.queryByRole('heading', { name: "Couldn't load the history" })).not.toBeInTheDocument();
    expect(await screen.findByRole('feed', { name: 'History of 第3章 偏导数.md, newest first' }, { timeout: 3000 })).toBeInTheDocument();
  });

  it('offers no Copy details for a reason the person can act on', async () => {
    renderHistory({ fail: [{ command: 'list_history', code: 'HistoryDamaged' }] });

    expect(await screen.findByRole('heading', { name: "Couldn't load the history" })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Copy details' })).not.toBeInTheDocument();
  });
});

describe('the focus, when the part that had it goes', () => {
  const REVIEW_ROW = 'MAT232/Exams/Midterm/Midterm review.md, Modified';
  const RUN_BAT = 'Fall 2026/CSC148 Introduction to Computer Science/a1/run.bat';

  function diffColumn(): HTMLElement {
    return screen.getByRole('region', { name: 'Selected version' });
  }

  async function findTabStop(): Promise<HTMLElement> {
    const feed = await findFeed();
    return waitFor(() => {
      const entry = feed.querySelector<HTMLElement>('article[tabindex="0"]');
      if (entry === null) throw new Error('no tab stop');
      return entry;
    });
  }

  it('stays on the load failure’s Try again while it reads, which says the failure again when it fails again, and goes to the timeline when it works', async () => {
    const { user, shell } = renderAnnounced({ fail: [{ command: 'list_history', code: 'Internal' }], latencyMs: 300 });
    const tryAgain = await screen.findByRole('button', { name: 'Try again' });
    act(() => {
      tryAgain.focus();
    });

    await user.keyboard('{Enter}');
    expect(tryAgain).toHaveFocus();
    await waitFor(() => {
      expect(politeText()).toBe("Couldn't load the history");
    });
    expect(tryAgain).toHaveFocus();

    shell.setFailure('list_history', null);
    await user.keyboard('{Enter}');
    expect(tryAgain).toHaveFocus();
    const entry = await findTabStop();
    await waitFor(() => {
      expect(entry).toHaveFocus();
    });
  });

  it('goes from the refresh banner’s Try again to the timeline once the refresh works', async () => {
    const { user, shell } = renderAnnounced();
    await findFeed();
    shell.setFailure('list_history', 'Internal');
    const head = shell.versioning.head?.id ?? '';
    await act(async () => {
      await shell.invoke('reword_commit', { request: { commit: head, summary: 'MAT232: reworded', body: null } });
    });
    const banner = await screen.findByRole('alert');
    const tryAgain = within(banner).getByRole('button', { name: 'Try again' });
    act(() => {
      tryAgain.focus();
    });

    // Failing again: the banner stays with the focus, and says so.
    await user.keyboard('{Enter}');
    await waitFor(() => {
      expect(politeText()).toBe("Couldn't update the history.");
    });
    expect(tryAgain).toHaveFocus();

    shell.setFailure('list_history', null);
    await user.keyboard('{Enter}');
    await waitFor(() => {
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });
    expect(await findTabStop()).toHaveFocus();
  });

  it('goes from "Show all types" to the timeline that shows every type', async () => {
    useHistoryPreferences.setState({ types: ['restore'] });
    const { user } = renderAnnounced();
    const showAll = await screen.findByRole('button', { name: 'Show all types' });
    act(() => {
      showAll.focus();
    });

    await user.keyboard('{Enter}');

    const entry = await findTabStop();
    await waitFor(() => {
      expect(entry).toHaveFocus();
    });
  });

  it('goes to the whole history’s timeline when another view asks for it', async () => {
    renderAnnounced();
    await findFeed();
    act(() => {
      showHistory({ kind: 'entry', entry: refOf('Fall 2026/MAT232 Calculus of Several Variables/week 2 notes.md') });
    });
    await screen.findByRole('feed', { name: 'History of week 2 notes.md, newest first' });
    act(() => {
      (document.activeElement as HTMLElement | null)?.blur();
    });

    act(() => {
      showHistoryTimeline();
    });

    const entry = await findTabStop();
    expect(screen.getByRole('feed', { name: 'History, newest first' })).toContainElement(entry);
    await waitFor(() => {
      expect(entry).toHaveFocus();
    });

    // While it shows already: its tab stop takes the focus again.
    act(() => {
      entry.blur();
    });
    act(() => {
      showHistoryTimeline();
    });
    await waitFor(() => {
      expect(entry).toHaveFocus();
    });
  });

  // The diff pane keeps its own focus while it stays (diff/README.md): the view's keeper, which
  // hears of a removal first, leaves it to the pane.
  it('stays in the diff when the diff’s Try again gives way to its lines', async () => {
    const { user, shell } = renderAnnounced({ fail: [{ command: 'get_version_diff', code: 'Internal' }] });
    await findFeed();
    const [row] = await screen.findAllByRole('option', { name: REVIEW_ROW });
    if (row === undefined) throw new Error('no row');
    await user.click(row);
    const tryAgain = await within(diffColumn()).findByRole('button', { name: 'Try again' });
    act(() => {
      tryAgain.focus();
    });
    shell.setFailure('get_version_diff', null);

    await user.keyboard('{Enter}');

    await waitFor(() => {
      expect(within(diffColumn()).queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
    });
    await settle();
    expect(diffColumn()).toContainElement(document.activeElement as HTMLElement | null);
  });

  it('stays in the diff when the pane turns compact and Restore moves into More', async () => {
    const size = { ...WIDE };
    const resized = captureResizeObservers();
    const { user } = renderAnnounced({ layout: size });
    await findFeed();
    const [row] = await screen.findAllByRole('option', { name: REVIEW_ROW });
    if (row === undefined) throw new Error('no row');
    await user.click(row);
    const restore = await within(diffColumn()).findByRole('button', { name: 'Restore' });
    act(() => {
      restore.focus();
    });

    // The pane narrower than `size.diff-compact-pane` in a window still wide enough for the panel.
    act(() => {
      size.width = SIZE.diffCompactPane - 40;
      resized();
    });

    await waitFor(() => {
      expect(within(diffColumn()).queryByRole('button', { name: 'Restore' })).not.toBeInTheDocument();
    });
    await settle();
    expect(within(diffColumn()).getByRole('button', { name: 'More' })).toHaveFocus();
  });

  it('goes to the state of a file with no history when the Library shows it', async () => {
    renderHostedHistory();
    await findFeed();
    act(() => {
      showHistory({ kind: 'entry', entry: refOf(RUN_BAT) });
    });
    expect(await screen.findByRole('heading', { name: 'run.bat has no history yet' })).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Go to Changes' })).toHaveFocus();
    });
    expect(useHistoryView.getState().focusNext).toBe(false);
  });

  it('goes to the chip’s button when that state has none (Changes not on the rail)', async () => {
    renderAnnounced();
    await findFeed();
    act(() => {
      showHistory({ kind: 'entry', entry: refOf(RUN_BAT) });
    });
    expect(await screen.findByRole('heading', { name: 'run.bat has no history yet' })).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Show the whole history' })).toHaveFocus();
    });
    expect(useHistoryView.getState().focusNext).toBe(false);
  });

  it('goes to the state that takes the timeline’s place when the file’s only commit is undone', async () => {
    const { user } = renderHostedHistory({
      fixture: withoutWorkspaceChange(smallHistoryWith({ summary: 'CSC148: add run.bat', changes: [{ change: 'added', path: RUN_BAT }] }), RUN_BAT),
    });
    await findFeed();
    act(() => {
      showHistory({ kind: 'entry', entry: refOf(RUN_BAT) });
    });
    const feed = await screen.findByRole('feed', { name: 'History of run.bat, newest first' });
    const undo = await within(feed).findByRole('button', { name: 'Undo commit' });
    act(() => {
      undo.focus();
    });

    await user.keyboard('{Enter}');

    expect(await screen.findByRole('heading', { name: 'run.bat has no history yet' })).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Go to Changes' })).toHaveFocus();
    });
  });

  it('takes it once asked, also when strict mode runs the timeline’s effects twice', async () => {
    renderApp(
      <StrictMode>
        <HistoryView />
      </StrictMode>,
      { now: NOW, layout: WIDE },
    );

    act(() => {
      showHistoryTimeline();
    });

    const entry = await findTabStop();
    await waitFor(() => {
      expect(entry).toHaveFocus();
    });
  });

  // The diff goes from beside the list to over it, or back, as the window crosses the breakpoint.
  function view(): Element | null {
    return document.querySelector('.history-view');
  }

  describe('across the narrow breakpoint', () => {
    const width = window.innerWidth;
    afterEach(() => {
      resizeWindow(width);
    });

    it('goes from the diff to the row it showed when the window narrows', async () => {
      const { user } = renderAnnounced();
      await findFeed();
      const [row] = await screen.findAllByRole('option', { name: REVIEW_ROW });
      if (row === undefined) throw new Error('no row');
      await user.click(row);
      const restore = await within(diffColumn()).findByRole('button', { name: 'Restore' });
      act(() => {
        restore.focus();
      });

      resizeWindow(SIZE.narrowBreakpoint - 80);

      await waitFor(() => {
        expect(screen.queryByRole('region', { name: 'Selected version' })).not.toBeInTheDocument();
      });
      await settle();
      expect(view()).not.toHaveAttribute('data-covered');
      expect(document.activeElement).toHaveAttribute('aria-selected', 'true');
      expect(document.activeElement).toHaveAccessibleName(REVIEW_ROW);
    });

    it('goes from the diff over the list to the diff beside it when the window widens', async () => {
      resizeWindow(SIZE.narrowBreakpoint - 80);
      const { user } = renderAnnounced({ layout: NARROW });
      await findFeed();
      const [row] = await screen.findAllByRole('option', { name: REVIEW_ROW });
      if (row === undefined) throw new Error('no row');
      act(() => {
        row.focus();
      });
      await user.keyboard('{Enter}');
      expect(view()).toHaveAttribute('data-covered');
      expect(diffColumn()).toContainElement(document.activeElement as HTMLElement | null);

      resizeWindow(WIDE.width);

      await waitFor(() => {
        expect(screen.queryByRole('button', { name: 'Back to history' })).not.toBeInTheDocument();
      });
      await settle();
      expect(view()).not.toHaveAttribute('data-covered');
      expect(diffColumn()).toContainElement(document.activeElement as HTMLElement | null);
    });

    it('never covers the list again by itself: a diff left over the list goes when the window widens', async () => {
      resizeWindow(SIZE.narrowBreakpoint - 80);
      const { user } = renderAnnounced({ layout: NARROW });
      await findFeed();
      const [row] = await screen.findAllByRole('option', { name: REVIEW_ROW });
      if (row === undefined) throw new Error('no row');
      act(() => {
        row.focus();
      });
      await user.keyboard('{Enter}');
      expect(view()).toHaveAttribute('data-covered');
      resizeWindow(WIDE.width);
      await waitFor(() => {
        expect(view()).not.toHaveAttribute('data-covered');
      });
      const entry = await findTabStop();
      act(() => {
        entry.focus();
      });

      resizeWindow(SIZE.narrowBreakpoint - 80);

      await settle();
      expect(view()).not.toHaveAttribute('data-covered');
      expect(useHistoryView.getState().covered).toBe(false);
      expect(entry).toHaveFocus();
      // The row it showed stays selected: Enter on it covers the list again, the focus in the diff.
      expect(row).toHaveAttribute('aria-selected', 'true');
      act(() => {
        row.focus();
      });
      await user.keyboard('{Enter}');
      expect(view()).toHaveAttribute('data-covered');
      expect(diffColumn()).toContainElement(document.activeElement as HTMLElement | null);
    });
  });

  // The list under a narrow window's diff is `visibility: hidden`, and the browser refuses the focus
  // to its entries (`refuseFocusWhenHidden` does as Chromium does).
  describe('asked for while the diff covers the list', () => {
    const REVIEW = 'Fall 2026/MAT232 Calculus of Several Variables/Exams/Midterm/Midterm review.md';

    /** History in a narrow window, the review's version open over the list, the focus on the page. */
    async function coverWithReview(options: Parameters<typeof renderAnnounced>[0] = {}) {
      refuseFocusWhenHidden();
      narrowWindow();
      const rendered = renderAnnounced({ layout: NARROW, ...options });
      await findFeed();
      const [row] = await screen.findAllByRole('option', { name: REVIEW_ROW });
      if (row === undefined) throw new Error('no row');
      act(() => {
        row.focus();
      });
      await rendered.user.keyboard('{Enter}');
      expect(view()).toHaveAttribute('data-covered');
      // The view that asks hid the control that had the focus.
      act(() => {
        (document.activeElement as HTMLElement | null)?.blur();
      });
      return rendered;
    }

    it('shows the list and gives the focus to the file’s timeline when another view asks for the file the diff shows', async () => {
      await coverWithReview();

      act(() => {
        showHistory({ kind: 'entry', entry: refOf(REVIEW) });
      });

      const feed = await screen.findByRole('feed', { name: 'History of Midterm review.md, newest first' });
      await waitFor(() => {
        expect(feed.querySelector('article[tabindex="0"]')).toHaveFocus();
      });
      expect(view()).not.toHaveAttribute('data-covered');
      // The row the diff showed stays selected: Enter on it opens the diff over the list again.
      expect(within(feed).getByRole('option', { selected: true })).toBeInTheDocument();
    });

    it('shows the list and gives the focus to the whole history when another view asks for it', async () => {
      await coverWithReview();

      act(() => {
        showHistoryTimeline();
      });

      const entry = await findTabStop();
      await waitFor(() => {
        expect(entry).toHaveFocus();
      });
      expect(view()).not.toHaveAttribute('data-covered');
    });

    it('gives the focus to the diff, which stays over the list, when the timeline is asked for it from outside', async () => {
      await coverWithReview();

      act(() => {
        focusTimeline();
      });

      await waitFor(() => {
        expect(diffColumn()).toContainElement(document.activeElement as HTMLElement | null);
      });
      expect(view()).toHaveAttribute('data-covered');
      expect(useHistoryView.getState().focusNext).toBe(false);
    });
  });

  // The timeline's entries refuse the focus while hidden: it is asked again on a later render, as
  // long as nothing else has the focus.
  it('gives the focus to the tab stop once it can take it, unless the person put it somewhere meanwhile', async () => {
    refuseFocusWhenHidden();
    renderAnnounced();
    const entry = await findTabStop();
    const panel = panelFrame();
    act(() => {
      panel.style.visibility = 'hidden';
    });

    act(() => {
      focusTimeline();
    });
    expect(document.activeElement).toBe(document.body);

    act(() => {
      panel.style.visibility = '';
      setPanelWidth(500);
    });
    expect(entry).toHaveFocus();

    // Asked again while hidden, and the person moves the focus before the timeline can take it.
    act(() => {
      entry.blur();
      panel.style.visibility = 'hidden';
    });
    act(() => {
      focusTimeline();
    });
    act(() => {
      panel.style.visibility = '';
      filterButton().focus();
      setPanelWidth(520);
    });
    expect(filterButton()).toHaveFocus();
    act(() => {
      filterButton().blur();
      setPanelWidth(540);
    });
    expect(entry).not.toHaveFocus();
  });

  it('gives the first commit’s block the focus another view asks of the timeline before the history has started', async () => {
    renderAnnounced({ scenario: 'history-none' });
    expect(await screen.findByRole('heading', { name: 'History' })).toBeInTheDocument();

    act(() => {
      showHistory({ kind: 'entry', entry: refOf(RUN_BAT) });
    });

    await waitFor(() => {
      expect(document.querySelector('.first-commit')).toHaveFocus();
    });
    expect(useHistoryView.getState().focusNext).toBe(false);
  });
});

describe('the type filter', () => {
  it('checks every kind shown; unchecking one filters, keeps the menu open and is remembered', async () => {
    const { user } = renderHistory();
    const feed = await findFeed();

    await user.click(filterButton());
    const menu = await screen.findByRole('menu', { name: 'Filter by type: All types' });
    expect(within(menu).getByRole('group', { name: 'Types to show' })).toBeInTheDocument();
    const kinds = within(menu).getAllByRole('menuitemcheckbox');
    expect(kinds.map((item) => item.textContent)).toEqual(['Commits', 'Message edits', 'Undone commits', 'Restores']);
    expect(kinds.every((item) => item.getAttribute('aria-checked') === 'true')).toBe(true);
    expect(within(menu).getByRole('menuitem', { name: 'Show all types' })).toBeInTheDocument();

    await user.click(within(menu).getByRole('menuitemcheckbox', { name: 'Commits' }));

    expect(screen.getByRole('menu')).toBe(menu);
    expect(within(menu).getByRole('menuitemcheckbox', { name: 'Commits' })).toHaveAttribute('aria-checked', 'false');
    expect(filterButton()).toHaveAccessibleName('Filter by type: 3 types');
    expect(filterButton()).toHaveAttribute('data-filtering');
    expect(useHistoryPreferences.getState().types).toEqual(['reword', 'uncommit', 'restore']);
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}')).toMatchObject({ state: { types: ['reword', 'uncommit', 'restore'] } });
    // The small history's message edit and undone commit.
    await waitFor(() => {
      expect(within(screen.getByRole('feed', { hidden: true })).getAllByRole('article', { hidden: true })).toHaveLength(2);
    });
    expect(feed).not.toBeInTheDocument();

    await user.click(within(menu).getByRole('menuitem', { name: 'Show all types' }));

    await waitFor(() => {
      expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    });
    expect(filterButton()).toHaveAccessibleName('Filter by type: All types');
    await waitFor(() => {
      expect(within(screen.getByRole('feed')).getAllByRole('article')).toHaveLength(8);
    });
  });

  it('shows every kind again when the last checked one is unchecked', async () => {
    useHistoryPreferences.setState({ types: ['reword'] });
    const { user } = renderHistory();
    await findFeed();

    await user.click(filterButton());
    const menu = await screen.findByRole('menu');
    await user.click(within(menu).getByRole('menuitemcheckbox', { name: 'Message edits' }));

    expect(filterButton()).toHaveTextContent('All types');
    expect(within(menu).getAllByRole('menuitemcheckbox').every((item) => item.getAttribute('aria-checked') === 'true')).toBe(true);
  });

  it('reads the choice and the width back defensively', async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ state: { panelWidth: 500, types: ['uncommit', 'sync', 'uncommit'] }, version: 1 }));
    await useHistoryPreferences.persist.rehydrate();
    expect(useHistoryPreferences.getState()).toMatchObject({ panelWidth: 500, types: ['uncommit'] });

    localStorage.setItem(STORAGE_KEY, JSON.stringify({ state: { panelWidth: 9_999, types: 'all' }, version: 1 }));
    await useHistoryPreferences.persist.rehydrate();
    expect(useHistoryPreferences.getState()).toMatchObject({ panelWidth: SIZE.historyPanelMax, types: null });

    localStorage.setItem(STORAGE_KEY, JSON.stringify({ state: { panelWidth: '480px', types: [] }, version: 1 }));
    await useHistoryPreferences.persist.rehydrate();
    expect(useHistoryPreferences.getState()).toMatchObject({ panelWidth: SIZE.historyPanel, types: null });

    localStorage.setItem(STORAGE_KEY, 'not json');
    await useHistoryPreferences.persist.rehydrate();
    expect(useHistoryPreferences.getState()).toMatchObject({ panelWidth: SIZE.historyPanel, types: null });
  });

  it('reads the list it filters to from its top, with another tab stop', async () => {
    mockScrolling();
    renderHistory({ scenario: 'history-long' });
    const feed = await findFeed();
    scrollTimelineTo(3000);
    const [entry] = within(feed).getAllByRole('article');
    act(() => {
      entry?.focus();
    });
    expect(useHistoryView.getState().places.whole).toMatchObject({ offset: 3000, focus: { index: expect.any(Number) as number } });

    act(() => {
      showTypes(['commit']);
    });

    await waitFor(() => {
      expect(filterButton()).toHaveTextContent('1 type');
    });
    const filtered = await findFeed();
    expect(timelineScroller().scrollTop).toBe(0);
    expect(useHistoryView.getState().places.whole.offset).toBe(0);
    // The focus was in the list that went: the new list's first entry, its tab stop, has it.
    const [first] = within(filtered).getAllByRole('article');
    expect(first).toHaveAttribute('aria-posinset', '1');
    await waitFor(() => {
      expect(first).toHaveFocus();
    });
  });
});

describe('the resize handle', () => {
  it('is a separator between 360 and 640 px that Left and Right move by 16 px, Home and End to the ends', async () => {
    const { user } = renderHistory();
    await findFeed();
    const handle = separator();
    expect(handle).toHaveAttribute('aria-orientation', 'vertical');
    expect(handle).toHaveAttribute('aria-valuenow', '440');
    expect(handle).toHaveAttribute('aria-valuemin', '360');
    expect(handle).toHaveAttribute('aria-valuemax', '640');
    expect(panelFrame().style.width).toBe('440px');

    act(() => {
      handle.focus();
    });
    await user.keyboard('{ArrowRight}');
    expect(handle).toHaveAttribute('aria-valuenow', '456');
    expect(panelFrame().style.width).toBe('456px');
    await user.keyboard('{ArrowLeft}{ArrowLeft}');
    expect(handle).toHaveAttribute('aria-valuenow', '424');
    await user.keyboard('{Home}{ArrowLeft}');
    expect(handle).toHaveAttribute('aria-valuenow', '360');
    await user.keyboard('{End}{ArrowRight}');
    expect(handle).toHaveAttribute('aria-valuenow', '640');
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}')).toMatchObject({ state: { panelWidth: 640 } });

    await user.dblClick(handle);

    expect(handle).toHaveAttribute('aria-valuenow', '440');
    expect(useHistoryPreferences.getState().panelWidth).toBe(440);
  });

  it('resizes the panel as it is dragged, holding the pointer until it is let go', async () => {
    renderHistory();
    await findFeed();
    const handle = separator();

    fireEvent.pointerDown(handle, { button: 0, pointerId: 1, clientX: 500 });
    expect(pointerCapture.set).toHaveBeenCalledWith(1);
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 560 });
    expect(handle).toHaveAttribute('aria-valuenow', '500');
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 900 });
    expect(handle).toHaveAttribute('aria-valuenow', '640');
    fireEvent.pointerUp(handle, { pointerId: 1, clientX: 900 });
    expect(pointerCapture.release).toHaveBeenCalledWith(1);
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 400 });

    expect(handle).toHaveAttribute('aria-valuenow', '640');
    expect(useHistoryPreferences.getState().panelWidth).toBe(640);
    // Only the main button drags.
    fireEvent.pointerDown(handle, { button: 2, pointerId: 2, clientX: 500 });
    fireEvent.pointerMove(handle, { pointerId: 2, clientX: 300 });
    expect(handle).toHaveAttribute('aria-valuenow', '640');
  });

  it('leaves the diff column its room in a smaller window, and keeps the width it remembers', async () => {
    useHistoryPreferences.setState({ panelWidth: 600 });
    renderHistory({ layout: { width: 900, height: 700 } });
    await findFeed();

    // 900 − 8 (the handle) − 360 (the diff's least width).
    expect(separator()).toHaveAttribute('aria-valuemax', '532');
    expect(separator()).toHaveAttribute('aria-valuenow', '532');
    expect(useHistoryPreferences.getState().panelWidth).toBe(600);
  });
});

describe('a narrow window', () => {
  const width = window.innerWidth;
  afterEach(() => {
    window.innerWidth = width;
    window.dispatchEvent(new Event('resize'));
  });

  it('gives the panel the width, without the handle or the diff column', async () => {
    window.innerWidth = SIZE.narrowBreakpoint - 80;
    window.dispatchEvent(new Event('resize'));
    renderHistory({ layout: { width: 680, height: 720 } });
    await findFeed();

    expect(screen.queryByRole('separator')).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Selected version' })).not.toBeInTheDocument();
    const frame = screen.getByRole('region', { name: 'History' }).parentElement;
    expect(frame?.style.width).toBe('');
  });
});
