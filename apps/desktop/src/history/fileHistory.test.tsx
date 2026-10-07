// One file's history in the History view (handoff workspace-history §7.4) on the fake shell: opened
// from a row's menu and the diff's "More", the version followed to the file it belongs to now, the
// chip and Esc back to the whole history where it was, its entries with one-row cards, "Current
// version" with Restore disabled, the first commit after a file that came later, the file without
// history, the type filter, paging, and the file followed through the catalog.
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, type MockInstance, vi } from 'vitest';

import { showHistory } from '../app/historyTarget';
import { HISTORY_PAGE } from '../data/history';
import { publishReferences } from '../data/references';
import type { FileRef } from '../ipc';
import { refOf } from '../test/files';
import { smallHistoryWith } from '../test/history';
import { mockScrolling } from '../test/virtual';
import { setHistoryTypes } from './preferences';
import { useHistoryView } from './state';
import {
  findFeed,
  politeText,
  renderAnnounced,
  renderHistory,
  resetHistoryPreferences,
  scrollTimelineTo,
  timelineScroller,
} from './test/render';

resetHistoryPreferences();

const MAT = 'Fall 2026/MAT232 Calculus of Several Variables';
const REVIEW = `${MAT}/Exams/Midterm/Midterm review.md`;
const WEEK2 = `${MAT}/week 2 notes.md`;
const CHAPTER3 = `${MAT}/第3章 偏导数.md`;
const TREE = 'Fall 2026/CSC148 Introduction to Computer Science/a1/starter/tree.py';
const REVIEW_ROW = 'MAT232/Exams/Midterm/Midterm review.md, Modified';

type Shell = ReturnType<typeof renderHistory>['shell'];

function show(file: FileRef): void {
  act(() => {
    showHistory(file);
  });
}

function findFileFeed(name: string): Promise<HTMLElement> {
  return screen.findByRole('feed', { name: `History of ${name}, newest first` });
}

function articles(feed: HTMLElement): HTMLElement[] {
  return within(feed).getAllByRole('article');
}

function names(feed: HTMLElement): string[] {
  return articles(feed).map((article) => article.querySelector('.entry__title')?.textContent ?? '');
}

function chip(): HTMLElement {
  const element = document.querySelector<HTMLElement>('.file-chip');
  if (element === null) throw new Error('no file chip');
  return element;
}

/** The whole history's feed with its tab stop, once it shows again. */
async function findWholeFeed(): Promise<HTMLElement> {
  const feed = await findFeed();
  expect(screen.queryByRole('button', { name: 'Show the whole history' })).toBeNull();
  return feed;
}

/** The pages of `list_file_history` asked, in order. */
function fileHistoryAsked(invoke: MockInstance<Shell['invoke']>): unknown[] {
  return invoke.mock.calls.filter(([command]) => command === 'list_file_history').map(([, args]) => (args as { request: unknown }).request);
}

describe('opening one file’s history', () => {
  it('follows a row’s version to the file it is now, with the chip, one-row cards and the focus on its newest entry', async () => {
    const { shell, user } = renderHistory();
    const invoke = vi.spyOn(shell, 'invoke');
    await findFeed();
    const entry = await screen.findByRole('article', { name: 'MAT232: rewrite the midterm review' });
    fireEvent.contextMenu(within(entry).getByRole('option', { name: REVIEW_ROW }), { clientX: 40, clientY: 20 });
    const menu = await screen.findByRole('menu', { name: 'Actions for Midterm review.md' });
    await user.click(within(menu).getByRole('menuitem', { name: 'View history of this file' }));

    const feed = await findFileFeed('Midterm review.md');
    expect(chip()).toHaveTextContent('MAT232/Exams/Midterm/Midterm review.md');
    expect(within(chip()).getByRole('button', { name: 'Show the whole history' })).toBeInTheDocument();
    // Asked for the file the version belongs to now (decision 12), not the version.
    const review = refOf(REVIEW);
    expect(fileHistoryAsked(invoke)).toEqual([{ file: { kind: 'entry', entry: review }, page: { offset: 0, limit: HISTORY_PAGE }, types: null }]);
    expect(useHistoryView.getState().file).toEqual({ kind: 'entry', entry: review });

    // Its commits, each card with only the file's row; the first commit is where it was added.
    expect(names(feed)).toEqual(['MAT232: rewrite the midterm review', 'MAT223: update exercise 1; MAT232: update the midterm review', 'Start history']);
    const [newest, both, first] = articles(feed);
    if (newest === undefined || both === undefined || first === undefined) throw new Error('three entries');
    articles(feed).forEach((article) => {
      expect(article).toHaveAttribute('aria-setsize', '3');
      expect(within(article).getAllByRole('option')).toHaveLength(1);
    });
    expect(within(both).getByRole('listbox', { name: 'This file in this commit' })).toBeInTheDocument();
    expect(both).toHaveTextContent('and 1 other file in this commit');
    expect(newest).not.toHaveTextContent(/other files? in this commit/);
    expect(within(first).getByRole('option', { name: 'MAT232/Exams/Midterm/Midterm review.md, Added' })).toBeInTheDocument();
    expect(first).toHaveAccessibleDescription(expect.stringMatching(/files were in your library when Folio started keeping history\.$/) as string);
    expect(first).not.toHaveTextContent(/other files? in this commit/);
    expect(screen.getByText("That's the start of your history.")).toBeInTheDocument();
    // The file has uncommitted changes: no version is current.
    expect(within(feed).queryByText('Current version')).toBeNull();
    await waitFor(() => {
      expect(newest).toHaveFocus();
    });
  });

  it('leaves the focus in the diff when its "More" asks, and keeps the version shown', async () => {
    const { user } = renderHistory();
    await findFeed();
    const entry = await screen.findByRole('article', { name: 'MAT232: rewrite the midterm review' });
    await user.click(within(entry).getByRole('option', { name: REVIEW_ROW }));
    const diff = await screen.findByRole('region', { name: 'Selected version' });
    const more = await within(diff).findByRole('button', { name: 'More' });
    await user.click(more);
    await user.click(await screen.findByRole('menuitem', { name: 'View history of this file' }));

    const feed = await findFileFeed('Midterm review.md');
    await waitFor(() => {
      expect(more).toHaveFocus();
    });
    expect(articles(feed)[0]).not.toHaveFocus();
    // The row shown is a version of this file: it stays selected in the file's history.
    expect(within(articles(feed)[0] ?? feed).getByRole('option', { name: REVIEW_ROW })).toHaveAttribute('aria-selected', 'true');
  });

  it('keeps a version whose file was deleted since', async () => {
    const { shell } = renderHistory({ fixture: smallHistoryWith({ summary: 'Old notes', changes: [{ change: 'modified', path: 'Personal/Gone.md' }] }) });
    const invoke = vi.spyOn(shell, 'invoke');
    await findFeed();
    const commit = shell.versioning.head?.id ?? '';
    show({ kind: 'version', commit, path: 'Personal/Gone.md' });

    const feed = await findFileFeed('Gone.md');
    expect(chip()).toHaveTextContent('Personal/Gone.md');
    expect(names(feed)[0]).toBe('Old notes');
    expect(fileHistoryAsked(invoke)).toEqual([{ file: { kind: 'version', commit, path: 'Personal/Gone.md' }, page: { offset: 0, limit: HISTORY_PAGE }, types: null }]);
  });

  it('keeps a version whose file could not be looked up', async () => {
    const { shell } = renderHistory();
    const invoke = vi.spyOn(shell, 'invoke');
    await findFeed();
    const commit = shell.versioning.head?.id ?? '';
    shell.setFailure('locate_version', 'Internal');
    show({ kind: 'version', commit, path: REVIEW });

    const feed = await findFileFeed('Midterm review.md');
    expect(names(feed)[0]).toBe('MAT232: rewrite the midterm review');
    expect(fileHistoryAsked(invoke)).toEqual([{ file: { kind: 'version', commit, path: REVIEW }, page: { offset: 0, limit: HISTORY_PAGE }, types: null }]);
  });
});

describe('back to the whole history', () => {
  it('shows it where it was on Esc in the timeline, on the chip and with the chip’s button', async () => {
    mockScrolling();
    const { user } = renderHistory({ scenario: 'history-long' });
    await findFeed();
    scrollTimelineTo(3000);
    const review = refOf(REVIEW);

    // Esc in the timeline.
    show({ kind: 'entry', entry: review });
    let feed = await findFileFeed('Midterm review.md');
    await waitFor(() => {
      expect(articles(feed)[0]).toHaveFocus();
    });
    expect(timelineScroller().scrollTop).toBe(0);
    await user.keyboard('{Escape}');
    feed = await findWholeFeed();
    expect(timelineScroller().scrollTop).toBe(3000);
    // The whole history's tab stop has the focus, where it was scrolled.
    await waitFor(() => {
      expect(feed.querySelector('article[tabindex="0"]')).toHaveFocus();
    });
    expect(timelineScroller().scrollTop).toBe(3000);

    // The chip's button.
    show({ kind: 'entry', entry: review });
    await findFileFeed('Midterm review.md');
    await user.click(within(chip()).getByRole('button', { name: 'Show the whole history' }));
    await findWholeFeed();
    expect(timelineScroller().scrollTop).toBe(3000);

    // Esc on the chip.
    show({ kind: 'entry', entry: review });
    await findFileFeed('Midterm review.md');
    fireEvent.keyDown(within(chip()).getByRole('button', { name: 'Show the whole history' }), { key: 'Escape' });
    await findWholeFeed();
    expect(timelineScroller().scrollTop).toBe(3000);
  });

  it('shows it when the file goes, and follows the file when it moves', async () => {
    renderHistory();
    await findFeed();
    const week2 = refOf(WEEK2);
    show({ kind: 'entry', entry: week2 });
    await findFileFeed('week 2 notes.md');

    const moved = `${MAT}/Notes/week 2 notes.md`;
    act(() => {
      publishReferences({ kind: 'changes', changes: [{ kind: 'moved', entry: { id: week2.id, path: moved }, from: WEEK2 }] });
    });
    expect(useHistoryView.getState().file).toEqual({ kind: 'entry', entry: { id: week2.id, path: moved } });
    expect(chip()).toHaveTextContent('MAT232/Notes/week 2 notes.md');

    act(() => {
      publishReferences({ kind: 'changes', changes: [{ kind: 'removed', entry: { id: week2.id, path: moved } }] });
    });
    await findWholeFeed();
    expect(useHistoryView.getState().file).toBeNull();
  });
});

describe('what one file’s history shows', () => {
  it('marks the current version, whose diff has Restore disabled with the reason', async () => {
    const { user } = renderHistory();
    await findFeed();
    show({ kind: 'entry', entry: refOf(WEEK2) });
    const feed = await findFileFeed('week 2 notes.md');

    expect(names(feed)).toEqual(['MAT232: update 1 file', 'Start history']);
    const [current, first] = articles(feed);
    if (current === undefined || first === undefined) throw new Error('two entries');
    expect(within(current).getByText('Current version')).toHaveClass('entry__pill');
    expect(current).toHaveAccessibleDescription(expect.stringContaining('Current version') as string);
    expect(within(first).queryByText('Current version')).toBeNull();

    await user.click(within(current).getByRole('option'));
    const diff = await screen.findByRole('region', { name: 'Selected version' });
    const restore = await within(diff).findByRole('button', { name: 'Restore' });
    expect(restore).toHaveAttribute('aria-disabled', 'true');
    // In the tab order, the reason in its tooltip (read before any key closes it).
    act(() => {
      within(diff).getByRole('radio', { name: 'Changes' }).focus();
    });
    await user.tab();
    expect(restore).toHaveFocus();
    expect(await screen.findByRole('tooltip')).toHaveTextContent('This is the version you have now.');
    expect(restore).toHaveAccessibleDescription('This is the version you have now.');

    // Another version can be restored.
    await user.click(within(first).getByRole('option'));
    await waitFor(() => {
      expect(within(diff).getByRole('button', { name: 'Restore' })).not.toHaveAttribute('aria-disabled');
    });
  });

  it('ends a file that came later with the first commit, which says it wasn’t there yet', async () => {
    renderHistory();
    await findFeed();
    show({ kind: 'entry', entry: refOf(CHAPTER3) });
    const feed = await findFileFeed('第3章 偏导数.md');

    await waitFor(() => {
      expect(names(feed)).toEqual(['MAT232: add 1 file', 'Start history']);
    });
    const [added, first] = articles(feed);
    if (added === undefined || first === undefined) throw new Error('two entries');
    expect(within(added).getByRole('option', { name: 'MAT232/第3章 偏导数.md, Added' })).toBeInTheDocument();
    expect(first).toHaveAccessibleDescription(expect.stringMatching(/第3章 偏导数\.md wasn't in the library yet\.$/) as string);
    expect(within(first).queryByRole('option')).toBeNull();
    articles(feed).forEach((article) => {
      expect(article).toHaveAttribute('aria-setsize', '2');
    });
    expect(screen.getByText("That's the start of your history.")).toBeInTheDocument();
  });

  it('says when the first commit after a file that came later could not be read, and Try again reads it', async () => {
    const { shell, user } = renderHistory();
    await findFeed();
    // The first commit is looked up in the timeline (`list_history`); the file's history still reads.
    shell.setFailure('list_history', 'Internal');
    show({ kind: 'entry', entry: refOf(CHAPTER3) });
    const feed = await findFileFeed('第3章 偏导数.md');

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent("Couldn't load earlier entries.");
    expect(names(feed)).toEqual(['MAT232: add 1 file']);
    expect(screen.queryByText("That's the start of your history.")).toBeNull();
    shell.setFailure('list_history', null);

    await user.click(within(alert).getByRole('button', { name: 'Try again' }));

    await waitFor(() => {
      expect(names(feed)).toEqual(['MAT232: add 1 file', 'Start history']);
    });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByText("That's the start of your history.")).toBeInTheDocument();
  });

  it('keeps that row and its focus while Try again reads, and says so again when it fails again', async () => {
    const { shell, user } = renderAnnounced({ latencyMs: 200 });
    await findFeed();
    shell.setFailure('list_history', 'Internal');
    show({ kind: 'entry', entry: refOf(CHAPTER3) });
    await findFileFeed('第3章 偏导数.md');
    const alert = await screen.findByRole('alert', {}, { timeout: 3000 });
    const tryAgain = within(alert).getByRole('button', { name: 'Try again' });
    act(() => {
      tryAgain.focus();
    });

    await user.keyboard('{Enter}');

    // While it reads, the row stays with the focus; failing again, it is read out again.
    expect(screen.getByRole('alert')).toBe(alert);
    expect(tryAgain).toHaveFocus();
    await waitFor(() => {
      expect(politeText()).toBe("Couldn't load earlier entries.");
    });
    expect(tryAgain).toHaveFocus();
  });

  it('says nothing failed while the first commit is still being looked up', async () => {
    renderHistory({ latencyMs: 300 });
    await findFeed();
    show({ kind: 'entry', entry: refOf(CHAPTER3) });
    const feed = await findFileFeed('第3章 偏导数.md');
    expect(names(feed)).toEqual(['MAT232: add 1 file']);

    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByText("Couldn't load earlier entries.")).toBeNull();
    await waitFor(() => {
      expect(names(feed)).toEqual(['MAT232: add 1 file', 'Start history']);
    });
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('says a file no commit holds has no history yet', async () => {
    renderHistory();
    await findFeed();
    show({ kind: 'entry', entry: refOf(TREE) });

    expect(await screen.findByRole('heading', { name: 'tree.py has no history yet' })).toBeInTheDocument();
    expect(screen.getByText('Commit it from Changes to start its history.')).toBeInTheDocument();
    expect(chip()).toHaveTextContent('CSC148/a1/starter/tree.py');
  });

  it('applies the type filter', async () => {
    setHistoryTypes(['restore']);
    renderHistory({ scenario: 'history-long' });
    await findFeed();
    show({ kind: 'entry', entry: refOf(REVIEW) });
    const feed = await findFileFeed('Midterm review.md');
    await waitFor(() => {
      expect(names(feed)).toHaveLength(3);
    });
    expect(names(feed).every((name) => name.startsWith('Restored Midterm review.md to the version from '))).toBe(true);

    show({ kind: 'entry', entry: refOf(WEEK2) });
    expect(await screen.findByRole('heading', { name: 'Nothing of these types yet' })).toBeInTheDocument();
  });

  it('reads a long history a page at a time', async () => {
    mockScrolling();
    const { shell } = renderHistory({ scenario: 'history-long' });
    const invoke = vi.spyOn(shell, 'invoke');
    await findFeed();
    const week2 = refOf(WEEK2);
    const total = shell.versioning.fileHistory({ kind: 'entry', entry: week2 }, { offset: 0, limit: 1 }, null).total;
    expect(total).toBeGreaterThan(2 * HISTORY_PAGE);
    show({ kind: 'entry', entry: week2 });
    const feed = await findFileFeed('week 2 notes.md');

    expect(articles(feed)[0]).toHaveAttribute('aria-setsize', String(total));
    expect(within(articles(feed)[0] ?? feed).getByText('Current version')).toBeInTheDocument();
    const end = () => Number.parseFloat(document.querySelector<HTMLElement>('.timeline__feed')?.style.height ?? '0');
    scrollTimelineTo(end());
    await waitFor(() => {
      expect(fileHistoryAsked(invoke).map((request) => (request as { page: { offset: number } }).page.offset)).toEqual([0, HISTORY_PAGE]);
    });
    expect(await within(timelineScroller()).findByRole('status')).toHaveTextContent('Loading earlier entries…');
  });
});
