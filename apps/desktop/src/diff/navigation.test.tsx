// Moving between changes (handoff workspace-history §6.2, §6.3, §6.9, §14) on the fake shell: F7
// and Shift+F7 in order and at the ends, from a text field, past the windows that have loaded (the
// `diffs` scenario's 5,000 changes), the announcement for lines, removed lines and paragraphs, the
// strip's buttons, a window that fails, the region's scrolling keys, Esc and Alt+Left with Back, the
// focus handle, a pane hidden in <Activity>, and the scroll over the motion token or at once.
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { Activity, createRef } from 'react';
import { beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';

import { installShortcuts } from '../app/shortcuts';
import { MenuItem } from '../components/Menu/Menu';
import type { DiffRow, DiffWindow } from '../ipc';
import { cubicBezier, durationMs, easingOf } from './lines/reveal';
import { foldedRows, textDiff } from './test/diffs';
import { focusBlurrer } from './test/focus';
import {
  BAR,
  diffQueries,
  findRegion,
  itemStart,
  LEAD,
  LINE,
  maxScroll,
  mockScrolling,
  rowsAsked,
  scrollRegion,
  shownLines,
  stubbedItem,
  type StubOptions,
  stubRows,
  texts,
} from './test/lines';
import { announced, CSC, fake, item, position, REVIEW, showDiff, type ShowOptions, wait } from './test/pane';
import type { DiffPaneHandle } from './types';
import { PIN_HOLD_MS } from './useChangeNavigation';

const DATA = `${CSC}/labs/lab2/data.csv`;

/** The view's height in jsdom (`renderApp`): a revealed row goes a third of it down. */
const VIEW = 600;

const NEXT = '{F7}';
const PREVIOUS = '{Shift>}{F7}{/Shift}';

const context = (old: number, line: number): DiffRow => ({ kind: 'context', old, new: line, text: `line ${String(line)}` });
const removed = (old: number, change: number): DiffRow => ({ kind: 'removed', old, text: `old ${String(old)}`, marks: [], change });
const added = (line: number, change: number): DiffRow => ({ kind: 'added', new: line, text: `new ${String(line)}`, marks: [], change });

beforeEach(() => {
  mockScrolling();
  onTestFinished(installShortcuts());
});

/** The texts of the lines that carry the current change's bar. */
function barred(region: HTMLElement): string[] {
  const elements = [...region.querySelectorAll('.diff-line')];
  return shownLines(region).flatMap((line, index) => (elements[index]?.hasAttribute('data-current') === true ? [line.text] : []));
}

/** The polite live region's current message element: a new one for every announcement. */
function politeMessage(): Element | null {
  return document.querySelector('[aria-live="polite"][aria-atomic="true"] > span');
}

/** The pane on a stubbed text item whose diff has `rows`, once its lines show. */
async function showRows(rows: readonly DiffRow[], options: ShowOptions & Pick<StubOptions, 'word' | 'hold'> = {}) {
  const { word, hold, ...show } = options;
  const shown = showDiff(() => item(REVIEW), show);
  const spy = stubRows(rows, { word, hold });
  shown.render(stubbedItem(word === true ? `${CSC}/Stubbed.docx` : undefined));
  const region = await findRegion(shown.pane, word === true ? 'Changes in Stubbed.docx' : 'Changes in Stubbed.md');
  await waitFor(() => {
    expect(shownLines(region).length).toBeGreaterThan(0);
  });
  return { ...shown, region, spy };
}

describe('F7 and Shift+F7', () => {
  it('move through the changes in order, put the bar on the current one and stop at the ends', async () => {
    const { pane, region, user } = await showRows(foldedRows(3));
    // The first change is current until a move lands.
    expect(position(pane)).toBe('Change 1 of 3');
    expect(barred(region)).toEqual(['old 0', 'new 0']);

    await user.keyboard(NEXT);
    await waitFor(() => {
      expect(announced()).toBe('Change 2 of 3, line 51');
    });
    expect(position(pane)).toBe('Change 2 of 3');
    expect(barred(region)).toEqual(['old 1', 'new 1']);
    await user.keyboard(NEXT);
    await waitFor(() => {
      expect(announced()).toBe('Change 3 of 3, line 78');
    });
    expect(barred(region)).toEqual(['old 2', 'new 2']);

    // At the last change F7 does nothing, and says nothing.
    const said = politeMessage();
    await user.keyboard(NEXT);
    await wait(50);
    expect(politeMessage()).toBe(said);
    expect(position(pane)).toBe('Change 3 of 3');

    await user.keyboard(PREVIOUS);
    await waitFor(() => {
      expect(announced()).toBe('Change 2 of 3, line 51');
    });
    await user.keyboard(PREVIOUS);
    await waitFor(() => {
      expect(announced()).toBe('Change 1 of 3, line 24');
    });
    expect(barred(region)).toEqual(['old 0', 'new 0']);
    const first = politeMessage();
    await user.keyboard(PREVIOUS);
    await wait(50);
    expect(politeMessage()).toBe(first);
    expect(position(pane)).toBe('Change 1 of 3');
  });

  it('work from a text field elsewhere in the view', async () => {
    const { pane, user } = await showRows(foldedRows(3), {
      wrap: (diff) => (
        <>
          <input aria-label="Summary" />
          {diff}
        </>
      ),
    });
    const field = screen.getByRole('textbox', { name: 'Summary' });
    await user.click(field);
    await user.keyboard(NEXT);
    await waitFor(() => {
      expect(position(pane)).toBe('Change 2 of 3');
    });
    expect(field).toHaveFocus();
    expect(field).toHaveValue('');
  });

  it('load the window of a change past the loaded ones and reveal it in the top third', async () => {
    const { pane } = showDiff(() => item(DATA), { scenario: 'diffs' });
    const spy = vi.spyOn(fake().versioning, 'workspaceDiff');
    const region = await findRegion(pane, 'Changes in data.csv');
    await waitFor(() => {
      expect(position(pane)).toBe('Change 1 of 5,000');
    });
    expect(rowsAsked(spy)).not.toContain(1_000);

    // 112 presses before any lands: they add up. Change 112 is lines 900, row 3 + 9 × 112 of the
    // folded diff, in the window from row 1,000, which nothing asked for yet.
    act(() => {
      for (let press = 0; press < 112; press++) fireEvent.keyDown(document.body, { key: 'F7' });
    });
    await waitFor(() => {
      expect(announced()).toBe('Change 113 of 5,000, line 900');
    });
    expect(rowsAsked(spy)).toContain(1_000);
    expect(position(pane)).toBe('Change 113 of 5,000');
    const row = await waitFor(() => {
      const found = region.querySelector<HTMLElement>(`[data-index="${String(3 + 9 * 112 + 1)}"]`);
      if (found === null) throw new Error('the change is not rendered');
      return found;
    });
    expect(Math.abs(region.scrollTop - (itemStart(row) - VIEW / 3))).toBeLessThan(1);
    await waitFor(() => {
      expect(barred(region)).toHaveLength(2);
    });
    expect(barred(region).every((text) => text.startsWith('row 900,'))).toBe(true);
  });
});

describe('pinned windows', () => {
  it('read the last window for the lines of a long last change, and stop being asked a moment later', async () => {
    // Change 1, the last, adds 1,200 lines: rows 8 to 1,207 of the folded diff.
    const rows: DiffRow[] = [
      context(1, 1),
      context(2, 2),
      context(3, 3),
      removed(4, 0),
      added(4, 0),
      context(5, 5),
      context(6, 6),
      context(7, 7),
      ...Array.from({ length: 1_200 }, (_, index) => added(8 + index, 1)),
    ];
    const { client, user } = await showRows(rows);
    /** Whether a query watches the diff's window from row `offset`. */
    const watched = (offset: number) => diffQueries(client, offset).some((query) => query.getObserversCount() > 0);
    await user.keyboard(NEXT);
    await waitFor(() => {
      expect(announced()).toBe('Change 2 of 2, lines 8 to 1,207');
    });
    // The view is at the top; the window with the change's last line was read only to name it.
    expect(watched(1_000)).toBe(true);
    // Still asked a moment after the move ended, then released once it has held for PIN_HOLD_MS
    // (a slow runner may take longer to get there). Real time only: renderApp's faked Date falls
    // behind on a busy runner, so it cannot measure the hold.
    await wait(PIN_HOLD_MS / 10);
    expect(watched(1_000)).toBe(true);
    await waitFor(
      () => {
        expect(watched(1_000)).toBe(false);
      },
      { timeout: PIN_HOLD_MS + 3_000 },
    );
    expect(watched(0)).toBe(true);
  });
});

describe('the announcement', () => {
  // Change 0 replaces line 4 with lines 4 to 6; change 1 only removes old lines 21 and 22; change 2
  // adds line 26 at the very end.
  const rows: DiffRow[] = [
    context(1, 1),
    context(2, 2),
    context(3, 3),
    removed(4, 0),
    added(4, 0),
    added(5, 0),
    added(6, 0),
    context(5, 7),
    context(6, 8),
    context(7, 9),
    { kind: 'fold', old: 8, new: 10, lines: 10 },
    context(18, 20),
    context(19, 21),
    context(20, 22),
    removed(21, 1),
    removed(22, 1),
    context(23, 23),
    context(24, 24),
    context(25, 25),
    added(26, 2),
  ];

  it('names the lines a change covers, and the old ones for a change that only removes', async () => {
    const { user } = await showRows(rows);
    await user.keyboard(NEXT);
    await waitFor(() => {
      expect(announced()).toBe('Change 2 of 3, removed lines 21 to 22');
    });
    await user.keyboard(NEXT);
    await waitFor(() => {
      expect(announced()).toBe('Change 3 of 3, line 26');
    });
    await user.keyboard(PREVIOUS);
    await user.keyboard(PREVIOUS);
    await waitFor(() => {
      expect(announced()).toBe('Change 1 of 3, lines 4 to 6');
    });
  });

  it('counts paragraphs in a Word file', async () => {
    const { user } = await showRows(rows, { word: true });
    await user.keyboard(NEXT);
    await waitFor(() => {
      expect(announced()).toBe('Change 2 of 3, removed paragraphs 21 to 22');
    });
    await user.keyboard(NEXT);
    await waitFor(() => {
      expect(announced()).toBe('Change 3 of 3, paragraph 26');
    });
    await user.keyboard(PREVIOUS);
    await user.keyboard(PREVIOUS);
    await waitFor(() => {
      expect(announced()).toBe('Change 1 of 3, paragraphs 4 to 6');
    });
  });
});

describe('the strip', () => {
  it('has the previous and next buttons with their F7 hints, disabled at the ends', async () => {
    const { pane, region, user } = await showRows(foldedRows(3));
    const previous = within(pane).getByRole('button', { name: 'Previous change' });
    const next = within(pane).getByRole('button', { name: 'Next change' });
    expect(previous).toBeDisabled();
    expect(next).toBeEnabled();
    // The strip's buttons come before the region in the tab order.
    act(() => {
      region.focus();
    });
    await user.tab({ shift: true });
    expect(next).toHaveFocus();
    // React Aria tooltips close on any key: read it before pressing one.
    const tooltip = await screen.findByRole('tooltip');
    expect(tooltip).toHaveTextContent('Next change');
    expect(within(tooltip).getByText('F7')).toBeInTheDocument();

    await user.keyboard('{Enter}');
    await waitFor(() => {
      expect(position(pane)).toBe('Change 2 of 3');
    });
    expect(previous).toBeEnabled();
    // The last change: Next turns disabled and hands the focus to Previous.
    await user.keyboard('{Enter}');
    await waitFor(() => {
      expect(next).toBeDisabled();
    });
    expect(previous).toHaveFocus();
    expect(announced()).toBe('Change 3 of 3, line 78');
    await user.click(previous);
    await waitFor(() => {
      expect(announced()).toBe('Change 2 of 3, line 51');
    });
  });

  it('shows no position for an added empty file, which has no changes', async () => {
    const { pane, render } = showDiff(() => item(REVIEW));
    vi.spyOn(fake().versioning, 'workspaceDiff').mockImplementation((_key: string, window: DiffWindow) =>
      textDiff([], window, { before: null }),
    );
    render(stubbedItem());
    await findRegion(pane, 'Changes in Stubbed.md');
    expect(within(pane).queryByRole('button', { name: 'Next change' })).toBeNull();
    expect(position(pane)).toBe('');
  });
});

describe('a window a move needs that fails', () => {
  it('names the change without its lines, or goes to the failed row and says so; Try again mends it', async () => {
    let failing = true;
    // Change 1 adds 1,200 lines (rows 8 to 1,207), so its end and change 2 are in the window from
    // row 1,000, which fails.
    const rows: DiffRow[] = [
      context(1, 1),
      context(2, 2),
      context(3, 3),
      removed(4, 0),
      added(4, 0),
      context(5, 5),
      context(6, 6),
      context(7, 7),
      ...Array.from({ length: 1_200 }, (_, index) => added(8 + index, 1)),
      context(8, 1208),
      context(9, 1209),
      context(10, 1210),
      removed(11, 2),
      added(1211, 2),
      context(12, 1212),
    ];
    const shown = showDiff(() => item(REVIEW));
    stubRows(rows, { fail: (window) => failing && window.kind === 'rows' && window.offset === 1_000 });
    shown.render(stubbedItem());
    const { pane, user } = shown;
    const region = await findRegion(pane);
    await waitFor(() => {
      expect(texts(region)).toContain('new 8');
    });

    // Change 2 of 3 lands, but where it ends cannot be read: it is named without its lines.
    await user.keyboard(NEXT);
    await waitFor(() => {
      expect(announced()).toBe('Change 2 of 3');
    });
    expect(position(pane)).toBe('Change 2 of 3');

    // Change 3 is in the window that fails: the region goes to its failed row, the change stays.
    await user.keyboard(NEXT);
    await waitFor(() => {
      expect(announced()).toBe("Couldn't load change 3 of 3.");
    });
    expect(position(pane)).toBe('Change 2 of 3');
    const failed = await within(region).findByText("Couldn't load these lines.");
    const failedItem = failed.closest<HTMLElement>('.diff-lines__item');
    if (failedItem === null) throw new Error('the failed row is not an item of the region');
    expect(Math.abs(region.scrollTop - Math.min(maxScroll(region), itemStart(failedItem) - VIEW / 3))).toBeLessThan(1);

    failing = false;
    await user.click(within(region).getByRole('button', { name: 'Try again' }));
    await waitFor(() => {
      expect(within(region).queryByText("Couldn't load these lines.")).toBeNull();
    });
    await user.keyboard(NEXT);
    await waitFor(() => {
      expect(announced()).toBe('Change 3 of 3, line 1,211');
    });
  });
});

describe('scrolling', () => {
  it('scrolls the region by a line, a page and to the ends with the keys', async () => {
    const { region, user } = await showRows(foldedRows(200));
    act(() => {
      region.focus();
    });
    await user.keyboard('{ArrowDown}');
    expect(region.scrollTop).toBe(LINE);
    await user.keyboard('{ArrowDown}{ArrowDown}{ArrowUp}');
    expect(region.scrollTop).toBe(2 * LINE);
    await user.keyboard('{PageDown}');
    expect(region.scrollTop).toBe(2 * LINE + VIEW - LINE);
    await user.keyboard('{PageUp}');
    expect(region.scrollTop).toBe(2 * LINE);
    await user.keyboard('{End}');
    expect(region.scrollTop).toBe(maxScroll(region));
    await user.keyboard('{Home}');
    expect(region.scrollTop).toBe(0);
    // With a modifier the keys are not the region's.
    await user.keyboard('{Control>}{End}{/Control}');
    expect(region.scrollTop).toBe(0);
  });

  it('stays at the top after Home when windows answer before its scroll event', async () => {
    // 1,800 rows; the windows from row 1,000 answer only when the test lets them.
    const held: (() => void)[] = [];
    let holding = true;
    const { region, user, render, client, spy } = await showRows(foldedRows(200), {
      hold: (window) =>
        holding && window.kind === 'rows' && window.offset >= 1_000
          ? new Promise<void>((resolve) => {
              held.push(resolve);
            })
          : null,
    });
    /** Whether the window from row `offset` has answered. */
    const answered = (offset: number) => diffQueries(client, offset).some((query) => query.state.data !== undefined);
    expect(texts(region)).toContain('new 0');
    act(() => {
      region.focus();
    });
    // At the end, whose windows are asked and wait.
    await user.keyboard('{End}');
    await waitFor(() => {
      expect(rowsAsked(spy)).toContain(1_500);
    });
    // A scroll event there: the virtualiser reads the offset again only 150 ms after the last one.
    fireEvent.scroll(region);

    // Home moves the view to the top, but its scroll event waits: the virtualiser's rows are still
    // those at the end when something renders (here the host; a range settling, in the app).
    let scrolled: () => void = () => undefined;
    region.scrollTo = ((options?: ScrollToOptions) => {
      region.scrollTop = Math.min(Math.max(0, options?.top ?? 0), maxScroll(region));
      scrolled = () => {
        fireEvent.scroll(region);
      };
    }) as typeof region.scrollTo;
    onTestFinished(() => {
      Reflect.deleteProperty(region, 'scrollTo');
    });
    fireEvent.keyDown(region, { key: 'Home' });
    expect(region.scrollTop).toBe(0);
    render(stubbedItem());
    // The windows at the end answer: the rows above those the virtualiser had grow into folds.
    act(() => {
      holding = false;
      for (const answer of held.splice(0)) answer();
    });
    await waitFor(() => {
      expect(answered(1_500)).toBe(true);
    });
    await wait(50);
    expect(region.scrollTop).toBe(0);
    act(() => {
      scrolled();
    });
    await wait(200);
    expect(region.scrollTop).toBe(0);
  });

  it('scrolls to a change over --motion-duration-base, and jumps when reduced motion makes it 0', async () => {
    const root = document.documentElement;
    root.style.setProperty('--motion-duration-base', '160ms');
    root.style.setProperty('--motion-easing-standard', 'cubic-bezier(0.2, 0, 0, 1)');
    onTestFinished(() => {
      root.style.removeProperty('--motion-duration-base');
      root.style.removeProperty('--motion-easing-standard');
    });
    const { region, user } = await showRows(foldedRows(200));
    // Change b's first row is 9b + 4: two folds and eleven lines above change 1, three and
    // nineteen above change 2, after the lead.
    const change1 = LEAD + 2 * BAR + 11 * LINE - VIEW / 3;
    const change2 = LEAD + 3 * BAR + 19 * LINE - VIEW / 3;

    let landing = -1;
    await user.keyboard(NEXT);
    await waitFor(() => {
      expect(announced()).toBe('Change 2 of 200, line 51');
      landing = region.scrollTop;
    });
    // Announced as the scroll begins; it ends where the change is.
    expect(landing).toBeLessThan(change1);
    await waitFor(() => {
      expect(region.scrollTop).toBe(change1);
    });

    root.style.setProperty('--motion-duration-base', '0ms');
    await user.keyboard(NEXT);
    await waitFor(() => {
      expect(announced()).toBe('Change 3 of 200, line 78');
      landing = region.scrollTop;
    });
    expect(landing).toBe(change2);
  });

  it('stops a scroll to a change when the wheel, a pointer, a touch or a key takes over', async () => {
    const root = document.documentElement;
    // A long scroll, so a runner that stalls still catches it under way.
    root.style.setProperty('--motion-duration-base', '2000ms');
    onTestFinished(() => {
      root.style.removeProperty('--motion-duration-base');
    });
    const { region, user } = await showRows(foldedRows(200));
    // Where a scroll to change b (from 0) ends: its first row, 9b + 4, a third down the view.
    const target = (b: number) => LEAD + (b + 1) * BAR + (8 * b + 3) * LINE - VIEW / 3;
    const takeOvers: [string, () => void][] = [
      ['wheel', () => fireEvent.wheel(region)],
      ['pointer', () => fireEvent.pointerDown(region)],
      ['touch', () => fireEvent.touchStart(region)],
      ['key', () => fireEvent.keyDown(region, { key: 'a' })],
    ];
    for (const [index, [name, takeOver]] of takeOvers.entries()) {
      const from = region.scrollTop;
      await user.keyboard(NEXT);
      // Under way: moved, not there yet.
      await waitFor(
        () => {
          expect(region.scrollTop).toBeGreaterThan(from);
        },
        { interval: 1 },
      );
      takeOver();
      const stopped = region.scrollTop;
      await wait(300);
      expect([name, region.scrollTop]).toEqual([name, stopped]);
      expect(stopped).toBeLessThan(target(index + 1));
    }
  });

  it('reads CSS times and cubic-bezier easings, and falls back to a jump and a straight line', () => {
    expect(durationMs('160ms')).toBe(160);
    expect(durationMs(' 0.2s ')).toBe(200);
    expect(durationMs('0ms')).toBe(0);
    expect(durationMs('')).toBe(0);
    expect(durationMs('fast')).toBe(0);
    const standard = easingOf(' cubic-bezier(0.2, 0, 0, 1)');
    expect(standard(0)).toBe(0);
    expect(standard(1)).toBe(1);
    expect(standard(0.5)).toBeGreaterThan(0.8);
    const samples = [0.1, 0.2, 0.4, 0.6, 0.8].map(standard);
    expect(samples).toEqual([...samples].sort((a, b) => a - b));
    expect(cubicBezier(0.25, 0.25, 0.75, 0.75)(0.3)).toBeCloseTo(0.3, 5);
    expect(easingOf('linear')(0.3)).toBe(0.3);
  });
});

describe('a fold with the focus', () => {
  /** The pane with a stubbed diff of 200 changes and Back, the focus on its first fold. */
  async function focusFirstFold() {
    const onBack = vi.fn();
    const shown = await showRows(foldedRows(200), { props: { back: { label: 'Back to changes', onBack } } });
    const { region, user } = shown;
    act(() => {
      region.focus();
    });
    await user.tab();
    const [fold] = within(region).getAllByRole('button', { name: 'Show 20 unchanged lines' });
    if (fold === undefined) throw new Error('no fold');
    expect(fold).toHaveFocus();
    return { ...shown, fold, onBack };
  }

  /** Waits until the rows next to the first fold (item 1) are no longer rendered. */
  async function scrolledAway(region: HTMLElement) {
    await waitFor(() => {
      expect(region.querySelector('[data-index="2"]')).toBeNull();
    });
  }

  it('keeps it when Page Down or End scrolls the fold out of the rendered rows, so Esc still goes back', async () => {
    const { region, user, fold, onBack } = await focusFirstFold();
    await user.keyboard('{PageDown}'.repeat(6));
    expect(region.scrollTop).toBe(6 * (VIEW - LINE));
    await scrolledAway(region);
    expect(fold).toHaveFocus();
    await user.keyboard('{End}');
    expect(region.scrollTop).toBe(maxScroll(region));
    await wait(0);
    expect(fold).toHaveFocus();
    expect(fold.isConnected).toBe(true);
    // The keys still reach the region and the pane.
    await user.keyboard('{Home}');
    expect(region.scrollTop).toBe(0);
    await user.keyboard('{Escape}');
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('lets it go when the person puts it elsewhere, from a fold out of view or from the region', async () => {
    const blur = focusBlurrer();
    const { region, user, fold } = await focusFirstFold();
    await user.keyboard('{PageDown}'.repeat(6));
    await scrolledAway(region);
    expect(fold).toHaveFocus();
    // A click on text, in the pane or outside it: the fold gives the focus to the page, and goes
    // before the pane has heard the blur, its listeners run one by one as in Chromium.
    await blur(fold);
    expect(fold.isConnected).toBe(false);
    expect(document.activeElement).toBe(document.body);
    await wait(150);
    expect(document.activeElement).toBe(document.body);
    // The same from the region; scrolling renders it again, and it leaves the focus where it is.
    act(() => {
      region.focus();
    });
    await blur(region);
    scrollRegion(region, 0);
    await wait(150);
    expect(document.activeElement).toBe(document.body);
  });

  it('lets a failed window’s Try again out of view go when the person puts the focus elsewhere', async () => {
    const blur = focusBlurrer();
    const shown = showDiff(() => item(REVIEW));
    const spy = stubRows(foldedRows(400), { fail: (window) => window.kind === 'rows' && window.offset === 500 });
    shown.render(stubbedItem());
    const region = await findRegion(shown.pane);
    await waitFor(() => {
      expect(texts(region)).toContain('new 0');
    });
    // Row 500 starts after 55 blocks and five rows more.
    scrollRegion(region, LEAD + 55 * (BAR + 8 * LINE) + BAR + 4 * LINE - 100);
    const retry = await within(region).findByRole('button', { name: 'Try again' });
    act(() => {
      retry.focus();
    });
    await shown.user.keyboard('{End}');
    await waitFor(() => {
      expect(rowsAsked(spy)).toContain(3_500);
    });
    await wait(50);
    expect(retry).toHaveFocus();
    await blur(retry);
    expect(retry.isConnected).toBe(false);
    expect(document.activeElement).toBe(document.body);
    await wait(150);
    expect(document.activeElement).toBe(document.body);
  });

  it('keeps it when F7 moves far from the fold', async () => {
    const { region, user, fold } = await focusFirstFold();
    await user.keyboard(NEXT.repeat(40));
    await waitFor(() => {
      expect(announced()).toBe('Change 41 of 200, line 1,104');
    });
    await scrolledAway(region);
    expect(fold).toHaveFocus();
    // Tab goes on from it, to the next fold in the region, where the view is.
    await user.tab();
    const next = document.activeElement;
    expect(next).not.toBe(fold);
    expect(next).toHaveAccessibleName('Show 20 unchanged lines');
    expect(Number(next?.closest<HTMLElement>('.diff-lines__item')?.dataset.index)).toBeGreaterThan(300);
  });

  /** Presses End on `control` in the 3,600 rows of 400 blocks, and checks it keeps the focus once the windows at the end load. */
  async function keepsFocusThroughEnd(
    shown: { region: HTMLElement; user: ReturnType<typeof showDiff>['user']; spy: { mock: { calls: unknown[][] } } },
    control: HTMLElement,
    onBack: () => void,
  ) {
    const { region, user, spy } = shown;
    act(() => {
      control.focus();
    });
    await user.keyboard('{End}');
    expect(region.scrollTop).toBe(maxScroll(region));
    // The view's windows are the last ones now; the one of the control's row is still asked.
    await waitFor(() => {
      expect(rowsAsked(spy)).toContain(3_500);
    });
    await wait(50);
    expect(control.isConnected).toBe(true);
    expect(control).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(onBack).toHaveBeenCalledTimes(1);
  }

  it('keeps it on a fold past the first window when End leaves that window behind', async () => {
    const onBack = vi.fn();
    const shown = await showRows(foldedRows(400), { props: { back: { label: 'Back to changes', onBack } } });
    // Block 56's fold: row 504 of the folded diff, in the window from row 500.
    scrollRegion(shown.region, LEAD + 56 * (BAR + 8 * LINE) - 100);
    const fold = await waitFor(() => {
      const found = shown.region.querySelector<HTMLElement>('[data-index="505"] button');
      if (found === null) throw new Error('the fold is not rendered');
      return found;
    });
    expect(fold).toHaveAccessibleName('Show 20 unchanged lines');
    await keepsFocusThroughEnd(shown, fold, onBack);
  });

  it('keeps it on the Try again of a failed window when End leaves that window behind', async () => {
    const onBack = vi.fn();
    const shown = showDiff(() => item(REVIEW), { props: { back: { label: 'Back to changes', onBack } } });
    const spy = stubRows(foldedRows(400), { fail: (window) => window.kind === 'rows' && window.offset === 500 });
    shown.render(stubbedItem());
    const region = await findRegion(shown.pane);
    await waitFor(() => {
      expect(texts(region)).toContain('new 0');
    });
    // Row 500 starts after 55 blocks and five rows more.
    scrollRegion(region, LEAD + 55 * (BAR + 8 * LINE) + BAR + 4 * LINE - 100);
    const retry = await within(region).findByRole('button', { name: 'Try again' });
    await keepsFocusThroughEnd({ region, user: shown.user, spy }, retry, onBack);
  });

  it('gives it to the region when the fold turns into a line as its window answers anew', async () => {
    const rows = foldedRows(200);
    const onBack = vi.fn();
    const { region, user, shell } = await showRows(rows, { props: { back: { label: 'Back to changes', onBack } } });
    act(() => {
      region.focus();
    });
    await user.tab();
    const fold = document.activeElement;
    expect(fold).toHaveAccessibleName('Show 20 unchanged lines');
    // The file changed: its first row is a line now, with the same counts.
    rows[0] = context(1, 1);
    act(() => {
      shell.editFile(REVIEW);
    });
    await waitFor(() => {
      expect(fold?.isConnected).toBe(false);
    });
    expect(region).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(onBack).toHaveBeenCalledTimes(1);
  });
});

describe('the host', () => {
  it('goes back with Esc and Alt+Left; Esc in the More menu only closes the menu', async () => {
    const onBack = vi.fn();
    const { pane, user } = showDiff(() => item(REVIEW), {
      props: { back: { label: 'Back to changes', onBack }, moreItems: <MenuItem>Copy path</MenuItem> },
    });
    const region = await findRegion(pane, 'Changes in Midterm review.md');
    act(() => {
      region.focus();
    });
    await user.keyboard('{Escape}');
    expect(onBack).toHaveBeenCalledTimes(1);
    await user.keyboard('{Alt>}{ArrowLeft}{/Alt}');
    expect(onBack).toHaveBeenCalledTimes(2);
    await user.keyboard('{Control>}{Escape}{/Control}{ArrowLeft}');
    expect(onBack).toHaveBeenCalledTimes(2);

    await user.click(within(pane).getByRole('button', { name: 'More' }));
    await screen.findByRole('menu');
    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByRole('menu')).toBeNull();
    });
    expect(onBack).toHaveBeenCalledTimes(2);
  });

  it('moves the focus into the diff through its ref: the heading while it loads, then the lines', async () => {
    const ref = createRef<DiffPaneHandle>();
    const { pane } = showDiff(() => item(REVIEW), { latencyMs: 300, props: { ref } });
    act(() => {
      ref.current?.focus();
    });
    expect(within(pane).getByRole('heading', { level: 2 })).toHaveFocus();
    const region = await findRegion(pane);
    act(() => {
      ref.current?.focus();
    });
    expect(region).toHaveFocus();
  });

  it('does not answer F7 while a hidden view keeps the pane', async () => {
    let mode: 'visible' | 'hidden' = 'visible';
    const { pane, user, render } = await showRows(foldedRows(3), { wrap: (diff) => <Activity mode={mode}>{diff}</Activity> });
    await user.keyboard(NEXT);
    await waitFor(() => {
      expect(position(pane)).toBe('Change 2 of 3');
    });

    mode = 'hidden';
    render(stubbedItem());
    const said = politeMessage();
    await user.keyboard(NEXT);
    await wait(50);
    expect(politeMessage()).toBe(said);

    mode = 'visible';
    render(stubbedItem());
    expect(position(pane)).toBe('Change 2 of 3');
    await user.keyboard(NEXT);
    await waitFor(() => {
      expect(announced()).toBe('Change 3 of 3, line 78');
    });
  });
});
