// Text and Word lines (handoff workspace-history §6.3–§6.6) on the fake shell: the region and its
// lines, numbers and signs, the hidden "Added line" labels, marks, Word text and its note, folds
// that open in place, windows that load as the region scrolls (the `diffs` scenario's 45,000-row
// file), a window that failed, the approximate note, the tags block after the lines, ignore rules,
// and a window whose header disagrees. jsdom has no layout: every item keeps its estimated height.
import { act, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { DiffWindow } from '../../ipc';
import { serveFiles } from '../../test/files';
import { foldedRows, textDiff } from '../test/diffs';
import {
  BAR,
  findRegion,
  LEAD,
  LINE,
  mockScrolling,
  rowsAsked,
  scrollRegion,
  shownLines,
  stubbedItem,
  stubRows,
  texts,
  topRow,
} from '../test/lines';
import { CSC, fake, item, metadata, notes, PHY, recordAnnouncements, REVIEW, showDiff, strip, wait } from '../test/pane';
import { lineParts } from './DiffLine';

const DATA = `${CSC}/labs/lab2/data.csv`;
const REPORT = `${CSC}/labs/lab1/report.docx`;
const FAILED = "Couldn't load these lines.";

beforeEach(() => {
  mockScrolling();
});

describe('lines', () => {
  it('shows the numbers and the sign, hidden from screen readers, and says which lines changed', async () => {
    const { pane } = showDiff(() => item(REVIEW));
    const region = await findRegion(pane, 'Changes in Midterm review.md');
    expect(region).toHaveAttribute('tabindex', '0');
    await waitFor(() => {
      expect(texts(region)).toContain('Check the boundary too.');
    });
    const lines = shownLines(region);
    expect(lines.slice(0, 5)).toEqual([
      { old: '1', new: '1', sign: '', label: null, text: '# Midterm review', marks: [] },
      { old: '2', new: '2', sign: '', label: null, text: '', marks: [] },
      { old: '3', new: '3', sign: '', label: null, text: '## Chain rule', marks: [] },
      { old: '4', new: '', sign: '−', label: 'Removed line', text: 'Write z = f(x(t), y(t)).', marks: [] },
      {
        old: '',
        new: '4',
        sign: '+',
        label: 'Added line',
        text: 'Write z = f(x(t), y(t)) and differentiate through both paths.',
        marks: ['and differentiate through both paths'],
      },
    ]);
    expect(lines.slice(-3).map((line) => [line.sign, line.text])).toEqual([
      ['−', '拉格朗日乘数法要背公式。'],
      ['+', 'Check the boundary too.'],
      ['+', '拉格朗日乘数法要背公式，边界也要检查。'],
    ]);

    const removed = region.querySelectorAll('.diff-line')[3];
    expect(removed).toHaveAttribute('data-kind', 'removed');
    for (const column of removed?.querySelectorAll('.diff-line__number, .diff-line__sign') ?? []) {
      expect(column).toHaveAttribute('aria-hidden', 'true');
    }
    expect(removed?.querySelector('.diff-line__label')).toHaveClass('visually-hidden');
    // Screen readers hear the label, then the whole line: the marks are plain spans in it.
    expect(region.querySelectorAll('.diff-line')[4]?.querySelector('.diff-line__text')).toHaveTextContent(
      /^Added line Write z = f\(x\(t\), y\(t\)\) and differentiate through both paths\.$/,
    );
    expect(region.querySelector('mark')).toBeNull();
    expect(within(region).getByRole('button', { name: 'Show 2 unchanged lines' })).toBeInTheDocument();
    expect(region).not.toHaveAttribute('aria-busy');
  });

  it('marks the changed words of both lines of a pair', async () => {
    const { pane } = showDiff(() => item(REVIEW));
    const region = await findRegion(pane);
    await waitFor(() => {
      expect(texts(region)).toContain('Check the boundary too.');
    });
    const pair = shownLines(region).filter((line) => line.text === '拉格朗日乘数法要背公式。' || line.text === 'Check the boundary too.');
    expect(pair.map((line) => line.marks)).toEqual([['拉格朗日乘数法要背公式。'], ['Check the boundary too.']]);
  });

  it('puts the banners in the region, before the lines', async () => {
    const { pane } = showDiff(() => item(`${PHY}/Kinematics.md`));
    const region = await findRegion(pane, 'Changes in Kinematics.md');
    await waitFor(() => {
      expect(shownLines(region).length).toBeGreaterThan(0);
    });
    expect(within(region).getAllByRole('note')).toHaveLength(notes(pane).length);
    expect(notes(pane)).toEqual(['Moved from PHY131/notes/.', 'Replaces a file that was deleted.']);
    const firstLine = region.querySelector('.diff-line');
    const lastNote = within(region).getAllByRole('note').at(-1);
    expect(lastNote?.compareDocumentPosition(firstLine as Node)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it('puts the tags that changed too in the region, after the lines', async () => {
    const { pane } = showDiff(() => item(REVIEW));
    const region = await findRegion(pane, 'Changes in Midterm review.md');
    const tags = await within(region).findByText('The tags changed too.');
    const lines = region.querySelectorAll('.diff-line');
    expect(lines[lines.length - 1]?.compareDocumentPosition(tags)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(within(region).getAllByText('Exams')).toHaveLength(2);
  });

  it('shows the ignore rules as text', async () => {
    const { pane } = showDiff(() => metadata('ignoreRules'));
    const region = await findRegion(pane, 'Changes in the ignore rules');
    await waitFor(() => {
      expect(shownLines(region).filter((line) => line.sign === '+').map((line) => line.text)).toEqual(['*.tmp', 'build/']);
    });
    expect(strip(pane)).toHaveTextContent('2 lines added');
  });

  it('notes above the lines that an approximate diff marks only whole lines', async () => {
    const { pane, render } = showDiff(() => item(REVIEW));
    stubRows(foldedRows(3), { approximate: true });
    render(stubbedItem());
    const region = await findRegion(pane, 'Changes in Stubbed.md');
    const note = await within(region).findByRole('note');
    expect(note).toHaveTextContent('This file is too big to compare word by word, so only whole lines are marked.');
    expect(note.compareDocumentPosition(region.querySelector('.diff-line') as Node)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });
});

describe('marks', () => {
  it('cut a line at its changed words, in order, without losing or repeating text', () => {
    expect(lineParts('dz/dt = f_x x′(t)', [{ start: 13, end: 17 }])).toEqual([
      { text: 'dz/dt = f_x x', marked: false },
      { text: '′(t)', marked: true },
    ]);
    // Out of the text, empty, overlapping and touching ranges, given out of order.
    expect(
      lineParts('abcdefgh', [
        { start: 6, end: 40 },
        { start: 1, end: 3 },
        { start: 2, end: 2 },
        { start: 2, end: 4 },
        { start: 4, end: 5 },
        { start: -3, end: 0 },
      ]),
    ).toEqual([
      { text: 'a', marked: false },
      { text: 'bcde', marked: true },
      { text: 'f', marked: false },
      { text: 'gh', marked: true },
    ]);
    expect(lineParts('', [])).toEqual([{ text: '', marked: false }]);
    expect(lineParts('拉格朗日', [{ start: 0, end: 4 }])).toEqual([{ text: '拉格朗日', marked: true }]);
  });
});

describe('Word text', () => {
  it('counts paragraphs, uses the text font and ends with what the comparison leaves out', async () => {
    const { pane } = showDiff(() => item(REPORT));
    const region = await findRegion(pane, 'Changes in report.docx');
    expect(region).toHaveAttribute('data-word', 'true');
    await waitFor(() => {
      expect(shownLines(region).length).toBeGreaterThan(3);
    });
    const labels = new Set(shownLines(region).flatMap((line) => (line.label === null ? [] : [line.label])));
    expect(labels).toEqual(new Set(['Added paragraph', 'Removed paragraph']));
    const note = within(region).getByText(
      "Folio compares the text of Word files. Changes to formatting, images or comments don't show here.",
    );
    const lines = region.querySelectorAll('.diff-line');
    expect(lines[lines.length - 1]?.compareDocumentPosition(note)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(strip(pane)).toHaveTextContent(/paragraphs? added/);
  });

  it('words folds, failures and the approximate note in paragraphs', async () => {
    const { pane, render } = showDiff(() => item(REVIEW));
    stubRows(foldedRows(120), { word: true, approximate: true, fail: (window) => window.kind === 'rows' && window.offset === 500 });
    render(stubbedItem(`${PHY}/Stubbed.docx`));
    const region = await findRegion(pane, 'Changes in Stubbed.docx');
    expect(await within(region).findAllByRole('button', { name: 'Show 20 unchanged paragraphs' })).not.toHaveLength(0);
    expect(within(region).getByRole('note')).toHaveTextContent('so only whole paragraphs are marked.');
    // Row 500 starts after 55 blocks of nine rows (a fold and eight lines) and five rows more.
    scrollRegion(region, LEAD + 55 * (BAR + 8 * LINE) + BAR + 4 * LINE - 100);
    expect(await within(region).findByText("Couldn't load these paragraphs.")).toBeInTheDocument();
  });
});

describe('folds', () => {
  it('opens a fold in place by keyboard: the region keeps the focus and the unchanged window loads', async () => {
    const { pane, user, target } = showDiff(() => item(REVIEW));
    const spy = vi.spyOn(fake().versioning, 'workspaceDiff');
    const region = await findRegion(pane);
    const fold = await within(region).findByRole('button', { name: 'Show 2 unchanged lines' });
    act(() => {
      region.focus();
    });
    // Tab order: the region, then the folds in it.
    await user.tab();
    expect(fold).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(region).toHaveFocus();
    expect(within(region).queryByRole('button', { name: /unchanged/ })).toBeNull();
    await waitFor(() => {
      expect(texts(region)).toContain('D_u f = ∇f · u along a unit vector u.');
    });
    if (target.kind !== 'workspace') throw new Error('not a workspace row');
    expect(spy).toHaveBeenCalledWith(target.item.key, { kind: 'unchanged', line: 8, count: 2 });
    const unfolded = shownLines(region).filter((line) => line.old === '8' || line.old === '9');
    expect(unfolded).toEqual([
      { old: '8', new: '8', sign: '', label: null, text: 'D_u f = ∇f · u along a unit vector u.', marks: [] },
      { old: '9', new: '9', sign: '', label: null, text: 'The gradient points the way f grows fastest.', marks: [] },
    ]);
    // The rows after the fold follow its lines.
    expect(shownLines(region).map((line) => line.old).slice(4, 12)).toEqual(['', '5', '6', '7', '8', '9', '10', '11']);
  });

  it('opens a fold of any size at once and reads its lines in windows of 500 as they show', async () => {
    const { pane, user, render } = showDiff(() => item(REVIEW), { latencyMs: 50 });
    const spy = stubRows(foldedRows(3, (block) => (block === 0 ? 1234 : 20)));
    render(stubbedItem());
    const region = await findRegion(pane);
    await user.click(await within(region).findByRole('button', { name: 'Show 1,234 unchanged lines' }));
    expect(region).toHaveFocus();
    // Skeleton lines until the window answers; the region is busy meanwhile.
    expect(region).toHaveAttribute('aria-busy', 'true');
    expect(region.querySelectorAll('.diff-skeleton__line').length).toBeGreaterThan(10);
    await waitFor(() => {
      expect(texts(region)).toContain('line 1');
    });
    expect(region).not.toHaveAttribute('aria-busy');
    const unchanged = () => spy.mock.calls.map(([, window]) => window).filter((window) => window.kind === 'unchanged');
    expect(unchanged()).toEqual([{ kind: 'unchanged', line: 1, count: 500 }, { kind: 'unchanged', line: 501, count: 500 }]);

    // The last of its lines, and the rows after it, load as they scroll into view.
    scrollRegion(region, LEAD + 1200 * LINE);
    await waitFor(() => {
      expect(texts(region)).toContain('line 1234');
    });
    expect(unchanged()).toContainEqual({ kind: 'unchanged', line: 1001, count: 234 });
  });
});

describe('long diffs', () => {
  it('renders a screenful of the 45,000 rows of the 40,000-line file and loads windows where it scrolls', async () => {
    const { pane } = showDiff(() => item(DATA), { scenario: 'diffs' });
    const spy = vi.spyOn(fake().versioning, 'workspaceDiff');
    const region = await findRegion(pane, 'Changes in data.csv');
    await waitFor(() => {
      expect(shownLines(region)[0]).toMatchObject({ old: '1', new: '1', text: 'row 1,0,ok' });
    });
    expect(strip(pane)).toHaveTextContent('5,000 lines added, 5,000 removed');
    expect(region.querySelectorAll('.diff-lines__item').length).toBeLessThan(60);
    const sizer = region.firstElementChild as HTMLElement;
    expect(Number.parseFloat(sizer.style.height)).toBeGreaterThan(45_000 * LINE);

    // Dragged there through other rows within 100 ms: only where it rests asks for windows.
    for (const row of [5_000, 10_000, 15_000, 20_000]) scrollRegion(region, row * LINE);
    // Rows whose window has not answered are skeleton lines, and the region is busy.
    expect(region).toHaveAttribute('aria-busy', 'true');
    expect(shownLines(region)).toHaveLength(0);
    await waitFor(() => {
      expect(shownLines(region).length).toBeGreaterThan(20);
    });
    const around = shownLines(region).map((line) => Number(line.new || line.old));
    expect(Math.min(...around)).toBeGreaterThan(16_000);
    expect(region).not.toHaveAttribute('aria-busy');
    // The windows where the view rests and one each way; none of those it passed on the way.
    const asked = rowsAsked(spy);
    expect(asked.every((offset) => offset < 1_000 || offset >= 18_500)).toBe(true);
    expect(asked.filter((offset) => offset >= 18_500).length).toBeGreaterThanOrEqual(2);

    // The end: the last lines, and the one unchanged line after the last change, folded.
    scrollRegion(region, 2_000_000);
    await waitFor(() => {
      expect(texts(region).at(-1)).toMatch(/^row 39999,/);
    });
    const rows = [...region.querySelectorAll('.diff-line, .diff-bar')];
    expect(rows.at(-1)).toHaveTextContent('Show 1 unchanged line');
  });

  it('keeps the rows in view where they are when a window above them answers', async () => {
    const { pane, render } = showDiff(() => item(REVIEW), { latencyMs: 80 });
    stubRows(foldedRows(200));
    render(stubbedItem());
    const region = await findRegion(pane);
    await waitFor(() => {
      expect(texts(region)).toContain('new 0');
    });
    // Into rows whose windows have not answered: skeleton lines of 22 px, where folds are 32.
    scrollRegion(region, LEAD + 55 * (BAR + 8 * LINE) + 5 * LINE + 400 * LINE);
    const before = topRow(region);
    expect(region).toHaveAttribute('aria-busy', 'true');
    await waitFor(() => {
      expect(region).not.toHaveAttribute('aria-busy');
    });
    await waitFor(() => {
      expect(topRow(region)).toBe(before);
    });
  });
});

describe('failures', () => {
  it('shows a window that failed as one row, keeps the view on it, and tries it again', async () => {
    const { pane, user, render } = showDiff(() => item(REVIEW));
    let failing = true;
    const spy = stubRows(foldedRows(200), { fail: (window) => failing && window.kind === 'rows' && window.offset === 500 });
    render(stubbedItem());
    const region = await findRegion(pane);
    await waitFor(() => {
      expect(texts(region)).toContain('new 0');
    });
    // Row 500 starts after 55 blocks of nine rows and five rows more; 100 px above it, a screenful.
    scrollRegion(region, LEAD + 55 * (BAR + 8 * LINE) + BAR + 4 * LINE - 100);
    const failed = await within(region).findByText(FAILED);
    expect(within(region).getAllByText(FAILED)).toHaveLength(1);
    expect(failed.closest('.diff-bar')?.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
    // The rows after the failed window move up under it and load.
    await waitFor(() => {
      expect(texts(region)).toContain('old 111');
    });

    failing = false;
    // By keyboard: the row goes as its window loads again, and the region keeps the focus.
    const retry = within(region).getByRole('button', { name: 'Try again' });
    act(() => {
      retry.focus();
    });
    await user.keyboard('{Enter}');
    expect(region).toHaveFocus();
    await waitFor(() => {
      expect(within(region).queryByText(FAILED)).toBeNull();
    });
    expect(region).toHaveFocus();
    await waitFor(() => {
      expect(texts(region)).toContain('new 55');
    });
    expect(rowsAsked(spy).filter((offset) => offset === 500).length).toBeGreaterThanOrEqual(2);
  });

  it.each([
    { when: 'once its row went while it loaded', ms: 30, focus: 'region' },
    { when: 'on a row that stayed, failing at once', ms: 0, focus: 'retry' },
  ] as const)('reads a failed window’s row again when its Try again fails again, $when', async ({ ms, focus }) => {
    const { pane, user, render } = showDiff(() => item(REVIEW));
    const failing = (window: DiffWindow) => window.kind === 'rows' && window.offset === 500;
    const spy = stubRows(foldedRows(200), {
      fail: failing,
      hold: (window) => (ms > 0 && failing(window) ? new Promise<void>((resolve) => setTimeout(resolve, ms)) : null),
    });
    render(stubbedItem());
    const region = await findRegion(pane);
    await waitFor(() => {
      expect(texts(region)).toContain('new 0');
    });
    scrollRegion(region, LEAD + 55 * (BAR + 8 * LINE) + BAR + 4 * LINE - 100);
    const retry = await within(region).findByRole('button', { name: 'Try again' });
    const asked = rowsAsked(spy).filter((offset) => offset === 500).length;
    const said = recordAnnouncements();
    act(() => {
      retry.focus();
    });
    await user.keyboard('{Enter}');
    // A row that goes while its window loads again leaves the focus to the region; one that stays
    // keeps it on Try again. Either way the failure is read.
    await waitFor(() => {
      expect(said).toEqual([FAILED]);
    });
    expect(rowsAsked(spy).filter((offset) => offset === 500)).toHaveLength(asked + 1);
    expect(within(region).getByText(FAILED)).toBeInTheDocument();
    if (focus === 'region') expect(region).toHaveFocus();
    else expect(retry).toHaveFocus();
  });

  it('reads a failed row again only when Try again fails, not when the diff shows again after This version', async () => {
    serveFiles(() => 'text');
    const { pane, user, render } = showDiff(() => item(REVIEW));
    stubRows(foldedRows(200), { fail: (window) => window.kind === 'rows' && window.offset === 500 });
    render(stubbedItem());
    const region = await findRegion(pane);
    await waitFor(() => {
      expect(texts(region)).toContain('new 0');
    });
    scrollRegion(region, LEAD + 55 * (BAR + 8 * LINE) + BAR + 4 * LINE - 100);
    const said = recordAnnouncements();
    await user.click(await within(region).findByRole('button', { name: 'Try again' }));
    await waitFor(() => {
      expect(said).toEqual([FAILED]);
    });
    // The diff set aside and shown again: nothing failed since, so nothing is read.
    await user.click(within(pane).getByRole('radio', { name: 'This version' }));
    await waitFor(() => {
      expect(within(pane).queryByRole('region', { name: 'Changes in Stubbed.md' })).toBeNull();
    });
    await user.click(within(pane).getByRole('radio', { name: 'Changes' }));
    expect(await findRegion(pane, 'Changes in Stubbed.md')).toBeVisible();
    await wait(100);
    expect(said).toEqual([FAILED]);
  });

  it('shows the windows that fail in and above the view as failed rows, asking each once', async () => {
    const { pane, render } = showDiff(() => item(REVIEW));
    // 9,000 rows in 18 windows; every window but the first fails.
    const spy = stubRows(foldedRows(1_000), { fail: (window) => window.kind === 'rows' && window.offset > 0 });
    render(stubbedItem());
    const region = await findRegion(pane);
    await waitFor(() => {
      expect(texts(region)).toContain('new 0');
    });
    // Row 4,500 (block 500), deep in the diff: the windows around it fail, one row each, and the
    // view shows the rows of more windows (the content shrinks under it), until it shows only
    // failed rows. Each window is asked for once, then never again until Try again.
    scrollRegion(region, LEAD + 500 * (BAR + 8 * LINE));
    let asked: number[] = [];
    let askedAt = Date.now();
    await waitFor(
      () => {
        const now = rowsAsked(spy);
        if (now.length !== asked.length) {
          asked = now;
          askedAt = Date.now();
        }
        // Nothing asked for in the last 400 ms: four times the region's settling time.
        expect(Date.now() - askedAt).toBeGreaterThanOrEqual(400);
        expect(within(region).queryAllByText(FAILED).length).toBeGreaterThan(1);
        expect(region).not.toHaveAttribute('aria-busy');
      },
      { timeout: 5_000 },
    );
    const failedOffsets = asked.filter((offset) => offset > 0);
    expect(failedOffsets).toContain(4_500);
    expect(new Set(failedOffsets).size).toBe(failedOffsets.length);
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(rowsAsked(spy)).toEqual(asked);
  });

  it('reads the whole diff again when a window answers for other content, at most once a second', async () => {
    const { pane, render } = showDiff(() => item(REVIEW));
    const rows = foldedRows(120);
    let stale = 2;
    const { versioning } = fake();
    const spy = vi.spyOn(versioning, 'workspaceDiff').mockImplementation((_key: string, window: DiffWindow) => {
      // Window 500 answers twice for content with one more line added, then for the header's.
      if (window.kind === 'rows' && window.offset === 500 && stale > 0) {
        stale -= 1;
        return textDiff(rows, window, { text: { added: 121 } });
      }
      return textDiff(rows, window);
    });
    render(stubbedItem());
    await findRegion(pane);
    const firstWindow = () => rowsAsked(spy).filter((offset) => offset === 0).length;
    await waitFor(() => {
      expect(firstWindow()).toBe(2);
    });
    // The second disagreement waits for the second since the first reload.
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(firstWindow()).toBe(2);
    await waitFor(
      () => {
        expect(firstWindow()).toBe(3);
      },
      { timeout: 2_000 },
    );
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    expect(firstWindow()).toBe(3);
  });
});
