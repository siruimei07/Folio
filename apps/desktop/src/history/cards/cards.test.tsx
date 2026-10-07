// File cards on the fake shell (handoff workspace-history §7.2, §7.6, §2.2; decision B2): a
// commit's first rows and how they read, the card's keys, "Show all" and "Show more" in pages of
// 200, the selected row in the diff, the selection through a message edit and an undone commit, a
// restore's card, and the diff over the list in a narrow window.
import { act, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, type MockInstance, vi } from 'vitest';

import { CHANGES_PAGE, HISTORY_PAGE } from '../../data/history';
import type { FileRef, ListFileHistory, PageRequest } from '../../ipc';
import { smallHistoryWith } from '../../test/history';
import { settle } from '../../test/render';
import { SIZE } from '../../tokens/tokens';
import { showTypes, useHistoryView } from '../state';
import { findFeed, renderHistory, resetHistoryPreferences } from '../test/render';

resetHistoryPreferences();

const MAT = 'Fall 2026/MAT232 Calculus of Several Variables';
const LINEAR = 'Fall 2026/线性代数';
const REVIEW = `${MAT}/Exams/Midterm/Midterm review.md`;
const RESTORED = /^Restored Midterm review\.md to the version from /;

type Shell = ReturnType<typeof renderHistory>['shell'];

/** A commit of moves, a deletion, an edit and a tag or settings change: five changes. */
const TIDY = {
  summary: 'Tidy up',
  changes: [
    { change: 'deleted', path: `${MAT}/Old slides L2.pdf` },
    { change: 'moved', path: `${MAT}/Problem sets/ps2 solutions.md`, fromPath: `${MAT}/ps2 solutions.md` },
    { change: 'moved', kind: 'folder', path: `${LINEAR}/习题`, fromPath: `${LINEAR}/Exercises` },
    { change: 'modified', path: REVIEW },
  ],
  metadata: 1,
} as const;

function article(name: string): Promise<HTMLElement> {
  return screen.findByRole('article', { name });
}

function cardOf(entry: HTMLElement, name = 'Changes in this commit'): HTMLElement {
  return within(entry).getByRole('listbox', { name });
}

function options(card: HTMLElement): HTMLElement[] {
  return within(card).getAllByRole('option');
}

/** The diff column, once a row is selected. */
function diffColumn(): HTMLElement {
  return screen.getByRole('region', { name: 'Selected version' });
}

/** The heading of the diff pane: the path of the change it shows. */
function diffHeading(): string {
  return within(diffColumn()).getByRole('heading', { level: 2 }).textContent;
}

function pagesAsked(invoke: MockInstance<Shell['invoke']>, command: string): PageRequest[] {
  return invoke.mock.calls
    .filter(([name]) => name === command)
    .map(([, payload]) => (payload as { request: { page: PageRequest } }).request.page);
}

/** The reads of a version's own history (`list_file_history` of a version): a restore card's row. */
function versionReads(invoke: MockInstance<Shell['invoke']>): ListFileHistory[] {
  return invoke.mock.calls
    .filter(([name]) => name === 'list_file_history')
    .map(([, payload]) => (payload as { request: ListFileHistory }).request)
    .filter((request) => request.file.kind === 'version');
}

function headId(shell: Shell): string {
  const id = shell.versioning.head?.id;
  if (id === undefined) throw new Error('no commit');
  return id;
}

describe('a commit’s card', () => {
  it('lists its first four changes, how each changed, and "Show all" for the rest', async () => {
    renderHistory({ fixture: smallHistoryWith(TIDY) });
    await findFeed();
    const card = cardOf(await article('Tidy up'));
    const rows = options(card);

    expect(rows).toHaveLength(4);
    for (const [index, row] of rows.entries()) {
      expect(row).toHaveAttribute('aria-posinset', String(index + 1));
      expect(row).toHaveAttribute('aria-setsize', '5');
      expect(row).toHaveAttribute('aria-selected', 'false');
    }
    const deleted = within(card).getByRole('option', { name: 'MAT232/Old slides L2.pdf, Deleted' });
    expect(deleted).toHaveAttribute('data-deleted');
    const moved = within(card).getByRole('option', { name: /^MAT232\/Problem sets\/ps2 solutions\.md, Renamed, Moved from MAT232\/ps2 solutions\.md$/ });
    expect(moved.querySelector('.path-text')).toHaveAttribute(
      'title',
      'MAT232/Problem sets/ps2 solutions.md\nMoved from MAT232/ps2 solutions.md',
    );
    const folder = within(card).getByRole('option', { name: /习题, Renamed, Moved from .*Exercises$/ });
    expect(folder.querySelector('.card-row__icon svg')?.getAttribute('class')).toContain('lucide-folder-open');
    expect(within(card).getByRole('option', { name: 'MAT232/Exams/Midterm/Midterm review.md, Modified' })).toBeInTheDocument();
    expect(within(await article('Tidy up')).getByRole('button', { name: 'Show all 5 changes' })).toBeInTheDocument();
  });

  it('has none for the first commit, and no "Show all" when it shows every change', async () => {
    renderHistory();
    await findFeed();
    expect(within(await article('Start history')).queryByRole('listbox')).not.toBeInTheDocument();
    const entry = await article('MAT232: update 1 file');
    expect(options(cardOf(entry))).toHaveLength(1);
    expect(within(entry).queryByRole('button', { name: /^Show/ })).not.toBeInTheDocument();
  });

  it('shows a commit of only tag and settings changes at once', async () => {
    renderHistory({ fixture: smallHistoryWith({ summary: 'Settings', metadata: 3 }) });
    await findFeed();
    const entry = await article('Settings');
    await waitFor(() => {
      expect(options(cardOf(entry)).map((row) => row.getAttribute('aria-label'))).toEqual([
        'Ignore rules, Modified',
        'CSC148 course settings, Modified',
        'Tag definitions, Added',
      ]);
    });
    expect(within(entry).queryByRole('button', { name: /^Show/ })).not.toBeInTheDocument();
  });
});

describe('the card’s keys', () => {
  it('is one tab stop that Up, Down, Home and End move, and Enter or Space shows that version', async () => {
    const { user } = renderHistory({ fixture: smallHistoryWith(TIDY) });
    await findFeed();
    const card = cardOf(await article('Tidy up'));
    const rows = options(card);
    expect(rows.map((row) => row.tabIndex)).toEqual([0, -1, -1, -1]);
    expect(screen.getByRole('region', { name: 'Selected version' })).toHaveTextContent(
      'Select a file to see this version and what changed',
    );

    act(() => {
      rows[0]?.focus();
    });
    await user.keyboard('{ArrowDown}');
    expect(rows[1]).toHaveFocus();
    await user.keyboard('{End}');
    expect(rows[3]).toHaveFocus();
    await user.keyboard('{ArrowDown}');
    expect(rows[3]).toHaveFocus();
    await user.keyboard('{Home}');
    expect(rows[0]).toHaveFocus();
    await user.keyboard('{ArrowUp}');
    expect(rows[0]).toHaveFocus();
    // Moving the focus shows nothing yet.
    expect(rows.every((row) => row.getAttribute('aria-selected') === 'false')).toBe(true);

    // The rows come in path order: the review, the slides, the problem set, the exercises folder.
    await user.keyboard('{ArrowDown}{ArrowDown}{ArrowDown}');
    await user.keyboard(' ');
    expect(rows[3]).toHaveAttribute('aria-selected', 'true');
    expect(rows[3]).toHaveFocus();
    await waitFor(() => {
      expect(diffHeading()).toBe('MAT223/习题');
    });
    expect(rows.map((row) => row.tabIndex)).toEqual([-1, -1, -1, 0]);

    await user.keyboard('{ArrowUp}{Enter}');
    expect(rows[2]).toHaveAttribute('aria-selected', 'true');
    expect(rows[3]).toHaveAttribute('aria-selected', 'false');
    expect(rows[2]).toHaveFocus();
    await waitFor(() => {
      expect(diffHeading()).toBe('MAT232/Problem sets/ps2 solutions.md');
    });
    // Enter on the row shown moves the focus into the diff.
    await user.keyboard('{Enter}');
    expect(diffColumn().querySelector('.diff')?.contains(document.activeElement)).toBe(true);
  });

  it('leaves Page Down and Page Up to the timeline, which moves between entries', async () => {
    const { user } = renderHistory({ fixture: smallHistoryWith(TIDY) });
    await findFeed();
    const entry = await article('Tidy up');
    const index = Number(entry.closest<HTMLElement>('.timeline__item')?.dataset.index);
    const entryAt = (at: number) => document.querySelector(`.timeline__item[data-index="${String(at)}"] > article`);
    act(() => {
      options(cardOf(entry))[2]?.focus();
    });

    await user.keyboard('{PageDown}');
    expect(entryAt(index + 1)).toHaveFocus();
    await user.keyboard('{PageUp}');
    expect(entry).toHaveFocus();
  });

  it('shows a version on a click and keeps the tab stop on the row the diff shows', async () => {
    const { user } = renderHistory({ fixture: smallHistoryWith(TIDY) });
    await findFeed();
    const card = cardOf(await article('Tidy up'));
    await user.click(within(card).getByRole('option', { name: 'MAT232/Old slides L2.pdf, Deleted' }));

    const selected = within(card).getByRole('option', { selected: true });
    expect(selected).toHaveAccessibleName('MAT232/Old slides L2.pdf, Deleted');
    expect(selected).toHaveFocus();
    expect(selected.querySelector('.selection-indicator')).not.toBeNull();
    await waitFor(() => {
      expect(diffHeading()).toBe('MAT232/Old slides L2.pdf');
    });
    const { selection } = useHistoryView.getState();
    expect(selection?.row.kind === 'file' ? selection.row.row.path : null).toBe(`${MAT}/Old slides L2.pdf`);
  });
});

describe('showing all of a card’s changes', () => {
  it('reads list_commit_changes in pages of 200, then the tag and settings changes, and puts the focus on the first new row', async () => {
    const { user, shell } = renderHistory({ fixture: smallHistoryWith({ summary: 'Bulk import', bulk: 450, metadata: 2 }) });
    const invoke = vi.spyOn(shell, 'invoke');
    await findFeed();
    const entry = await article('Bulk import');
    expect(options(cardOf(entry))).toHaveLength(4);

    await user.click(within(entry).getByRole('button', { name: 'Show all 452 changes' }));
    await waitFor(() => {
      expect(options(cardOf(entry))).toHaveLength(CHANGES_PAGE);
    });
    expect(pagesAsked(invoke, 'list_commit_changes')).toEqual([{ offset: 0, limit: CHANGES_PAGE }]);
    expect(options(cardOf(entry))[4]).toHaveFocus();
    expect(options(cardOf(entry))[4]).toHaveAccessibleName('Bulk/file 004.md, Added');

    await user.click(within(entry).getByRole('button', { name: 'Show more' }));
    await waitFor(() => {
      expect(options(cardOf(entry))).toHaveLength(2 * CHANGES_PAGE);
    });
    expect(options(cardOf(entry))[CHANGES_PAGE]).toHaveFocus();

    await user.click(within(entry).getByRole('button', { name: 'Show more' }));
    await waitFor(() => {
      expect(options(cardOf(entry))).toHaveLength(452);
    });
    const rows = options(cardOf(entry));
    expect(rows.slice(-2).map((row) => row.getAttribute('aria-label'))).toEqual([
      'Ignore rules, Modified',
      'CSC148 course settings, Modified',
    ]);
    expect(rows[2 * CHANGES_PAGE]).toHaveFocus();
    expect(pagesAsked(invoke, 'list_commit_changes').map((page) => page.offset)).toEqual([0, 200, 400]);
    expect(pagesAsked(invoke, 'list_commit_metadata')).toEqual([{ offset: 0, limit: CHANGES_PAGE }]);
    expect(within(entry).queryByRole('button', { name: /^Show/ })).not.toBeInTheDocument();
  });

  it('says when a page failed and reads it again on Try again', async () => {
    const { user, shell } = renderHistory({ fixture: smallHistoryWith({ summary: 'Bulk import', bulk: 300 }) });
    await findFeed();
    const entry = await article('Bulk import');
    shell.setFailure('list_commit_changes', 'Internal');
    await user.click(within(entry).getByRole('button', { name: 'Show all 300 files' }));
    expect(await within(entry).findByRole('alert')).toHaveTextContent('Couldn\'t load the rest of the changes.');
    expect(options(cardOf(entry))).toHaveLength(4);

    shell.setFailure('list_commit_changes', null);
    await user.click(within(entry).getByRole('button', { name: 'Try again' }));
    await waitFor(() => {
      expect(options(cardOf(entry))).toHaveLength(CHANGES_PAGE);
    });
    expect(within(entry).queryByRole('alert')).not.toBeInTheDocument();
  });

  it('shows a tag or settings change’s diff when it is selected', async () => {
    const { user } = renderHistory({ fixture: smallHistoryWith(TIDY) });
    await findFeed();
    const entry = await article('Tidy up');
    await user.click(within(entry).getByRole('button', { name: 'Show all 5 changes' }));
    const rules = await within(entry).findByRole('option', { name: 'Ignore rules, Modified' });
    await user.click(rules);
    await waitFor(() => {
      expect(diffHeading()).toBe('Ignore rules');
    });
    expect(useHistoryView.getState().selection?.row.kind).toBe('metadata');
  });
});

describe('the selection', () => {
  it('follows its commit to the new id a message edit gives it, and its card stays open', async () => {
    const { user, shell } = renderHistory({ fixture: smallHistoryWith(TIDY) });
    await findFeed();
    const entry = await article('Tidy up');
    await user.click(within(entry).getByRole('button', { name: 'Show all 5 changes' }));
    await within(entry).findByRole('option', { name: 'Ignore rules, Modified' });
    await user.click(within(cardOf(entry)).getByRole('option', { name: 'MAT232/Exams/Midterm/Midterm review.md, Modified' }));
    const before = headId(shell);

    await act(async () => {
      await shell.invoke('reword_commit', { request: { commit: before, summary: 'Tidied up', body: null } });
    });
    const edited = await article('Tidied up');
    const after = headId(shell);
    expect(after).not.toBe(before);
    await waitFor(() => {
      expect(useHistoryView.getState().selection?.commit.id).toBe(after);
    });
    const card = cardOf(edited);
    expect(within(card).getByRole('option', { selected: true })).toHaveAccessibleName('MAT232/Exams/Midterm/Midterm review.md, Modified');
    // Still showing all five changes.
    await waitFor(() => {
      expect(options(card)).toHaveLength(5);
    });
    expect(diffHeading()).toBe('MAT232/Exams/Midterm/Midterm review.md');
  });

  it('goes, and the desk comes back, when its commit is undone', async () => {
    const { user, shell } = renderHistory({ fixture: smallHistoryWith(TIDY) });
    await findFeed();
    const entry = await article('Tidy up');
    await user.click(within(cardOf(entry)).getByRole('option', { name: 'MAT232/Old slides L2.pdf, Deleted' }));
    await waitFor(() => {
      expect(diffHeading()).toBe('MAT232/Old slides L2.pdf');
    });

    await act(async () => {
      await shell.invoke('uncommit', { request: { commit: headId(shell) } });
    });
    await waitFor(() => {
      expect(useHistoryView.getState().selection).toBeNull();
    });
    expect(diffColumn()).toHaveTextContent('Select a file to see this version and what changed');
  });

  it('goes when the type filter leaves its commit out, even when every entry listed is newer', async () => {
    const { user, shell } = renderHistory({ fixture: smallHistoryWith(TIDY) });
    await findFeed();
    const entry = await article('Tidy up');
    await user.click(within(cardOf(entry)).getByRole('option', { name: 'MAT232/Old slides L2.pdf, Deleted' }));
    await waitFor(() => {
      expect(diffHeading()).toBe('MAT232/Old slides L2.pdf');
    });
    // A restore after it: the one entry the "Restores" filter lists, newer than "Tidy up".
    const source = (await article('MAT232: rewrite the midterm review')).dataset.entry?.replace('commit ', '') ?? '';
    await act(async () => {
      await shell.invoke('restore_version', { request: { commit: source, path: REVIEW } });
    });
    await screen.findByRole('article', { name: RESTORED });

    act(() => {
      showTypes(['restore']);
    });

    await waitFor(() => {
      expect(useHistoryView.getState().selection).toBeNull();
    });
    expect(screen.getAllByRole('article').map((item) => item.dataset.kind)).toEqual(['restore']);
    expect(diffColumn()).toHaveTextContent('Select a file to see this version and what changed');
  });
});

describe('a restore’s card', () => {
  it('finds the restored version among its commit’s changes, and shows that version', async () => {
    const { user, shell } = renderHistory();
    await findFeed();
    const source = (await article('MAT232: rewrite the midterm review')).dataset.entry?.replace('commit ', '') ?? '';
    await act(async () => {
      await shell.invoke('restore_version', { request: { commit: source, path: REVIEW } });
    });
    const restored = await screen.findByRole('article', { name: /^Restored Midterm review\.md to the version from / });
    const card = await within(restored).findByRole('listbox', { name: 'Restored file' });
    const row = within(card).getByRole('option', { name: 'MAT232/Exams/Midterm/Midterm review.md, Modified' });
    expect(row).toHaveAttribute('aria-setsize', '1');

    await user.click(row);
    expect(row).toHaveAttribute('aria-selected', 'true');
    expect(useHistoryView.getState().selection?.commit.id).toBe(source);
    // The same version in its own commit's card is not the one selected.
    const own = cardOf(await article('MAT232: rewrite the midterm review'));
    expect(within(own).getByRole('option')).toHaveAttribute('aria-selected', 'false');
    await waitFor(() => {
      expect(diffHeading()).toBe('MAT232/Exams/Midterm/Midterm review.md');
    });
  });

  // A version from a commit of thousands of files (the brief's 50,000-file library, a file's
  // original version from "Start history"): its row comes from the file's history, read to that
  // commit, never from the commit's changes; a history change reads only that again.
  it('finds its row in one read of its file’s history, however many files the commit changed', async () => {
    const { shell } = renderHistory({ fixture: smallHistoryWith({ summary: 'Bulk import', bulk: 5000 }) });
    const invoke = vi.spyOn(shell, 'invoke');
    await findFeed();
    const source = headId(shell);
    await act(async () => {
      await shell.invoke('restore_version', { request: { commit: source, path: 'Bulk/file 4999.md' } });
    });
    const restored = await screen.findByRole('article', { name: /^Restored file 4999\.md to the version from / });

    const card = await within(restored).findByRole('listbox', { name: 'Restored file' });
    expect(options(card).map((row) => row.getAttribute('aria-label'))).toEqual(['Bulk/file 4999.md, Added']);
    expect(pagesAsked(invoke, 'list_commit_changes')).toEqual([]);
    expect(versionReads(invoke)).toEqual([
      { file: { kind: 'version', commit: source, path: 'Bulk/file 4999.md' }, page: { offset: 0, limit: HISTORY_PAGE }, types: ['commit'] },
    ]);

    for (let change = 0; change < 3; change++) {
      act(() => {
        shell.historyChanged();
      });
      await waitFor(() => {
        expect(versionReads(invoke)).toHaveLength(change + 2);
      });
    }
    await settle();
    expect(pagesAsked(invoke, 'list_commit_changes')).toEqual([]);
    expect(versionReads(invoke)).toHaveLength(4);
    expect(options(card)).toHaveLength(1);
  });

  it('says when its row could not be read, and Try again reads it again', async () => {
    const { shell, user } = renderHistory();
    await findFeed();
    const source = headId(shell);
    shell.setFailure('list_file_history', 'Internal');
    await act(async () => {
      await shell.invoke('restore_version', { request: { commit: source, path: REVIEW } });
    });
    const restored = await screen.findByRole('article', { name: RESTORED });
    const alert = await within(restored).findByRole('alert');
    expect(alert).toHaveTextContent("Couldn't find the restored version.");

    shell.setFailure('list_file_history', null);
    await user.click(within(alert).getByRole('button', { name: 'Try again' }));

    const card = await within(restored).findByRole('listbox', { name: 'Restored file' });
    expect(within(card).getByRole('option')).toHaveAccessibleName('MAT232/Exams/Midterm/Midterm review.md, Modified');
  });

  it('keeps its row through a message edit of the version’s commit, even when the commit answers first', async () => {
    const { shell } = renderHistory();
    await findFeed();
    const source = headId(shell);
    await act(async () => {
      await shell.invoke('restore_version', { request: { commit: source, path: REVIEW } });
    });
    const restored = await screen.findByRole('article', { name: RESTORED });
    await within(restored).findByRole('listbox', { name: 'Restored file' });
    // The timeline's refresh waits until the old id has answered `NotFound`.
    let release: () => void = () => undefined;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const asked: string[] = [];
    const invoke = shell.invoke.bind(shell);
    vi.spyOn(shell, 'invoke').mockImplementation(async (command, payload) => {
      if (command === 'list_history') await released;
      const answer = invoke(command, payload);
      const { file } = (payload as { request: { file?: FileRef } } | undefined)?.request ?? {};
      if (command === 'list_file_history' && file?.kind === 'version') {
        await answer.catch(() => undefined);
        asked.push(file.commit);
      }
      return answer;
    });

    await act(async () => {
      await invoke('reword_commit', { request: { commit: source, summary: 'MAT232: the review, rewritten', body: null } });
    });
    await waitFor(() => {
      expect(asked).toContain(source);
    });
    // While the timeline reads, the old id's `NotFound` may not last: the card stays.
    expect(within(restored).getByRole('listbox', { name: 'Restored file' })).toBeInTheDocument();
    act(() => {
      release();
    });

    const after = headId(shell);
    expect(after).not.toBe(source);
    const card = await within(await screen.findByRole('article', { name: RESTORED })).findByRole('listbox', { name: 'Restored file' });
    expect(within(card).getByRole('option')).toHaveAccessibleName('MAT232/Exams/Midterm/Midterm review.md, Modified');
  });

  it('shows no card once the version’s commit is undone, without a placeholder that never ends', async () => {
    const { shell } = renderHistory();
    await findFeed();
    const source = headId(shell);
    await act(async () => {
      await shell.invoke('restore_version', { request: { commit: source, path: REVIEW } });
    });
    await within(await screen.findByRole('article', { name: RESTORED })).findByRole('listbox', { name: 'Restored file' });

    await act(async () => {
      await shell.invoke('uncommit', { request: { commit: source } });
    });

    await waitFor(() => {
      expect(screen.queryByRole('article', { name: 'MAT232: rewrite the midterm review' })).not.toBeInTheDocument();
    });
    // The restore entry stays, naming a commit the history no longer has.
    const restored = screen.getByRole('article', { name: RESTORED });
    await waitFor(() => {
      expect(restored.querySelector('.file-card')).toBeNull();
    });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});

describe('a narrow window', () => {
  const width = window.innerWidth;
  afterEach(() => {
    window.innerWidth = width;
    window.dispatchEvent(new Event('resize'));
  });

  it('covers the list with the diff, and Back, Esc or Alt+Left return to it with its selection and focus', async () => {
    window.innerWidth = SIZE.narrowBreakpoint - 80;
    window.dispatchEvent(new Event('resize'));
    const { user } = renderHistory({ fixture: smallHistoryWith(TIDY), layout: { width: 680, height: 720 } });
    await findFeed();
    const view = document.querySelector('.history-view');
    const card = cardOf(await article('Tidy up'));
    expect(screen.queryByRole('region', { name: 'Selected version' })).not.toBeInTheDocument();

    const review = within(card).getByRole('option', { name: 'MAT232/Exams/Midterm/Midterm review.md, Modified' });
    act(() => {
      review.focus();
    });
    await user.keyboard('{Enter}');
    expect(view).toHaveAttribute('data-covered');
    expect(within(diffColumn()).getByRole('button', { name: 'Back to history' })).toBeInTheDocument();
    expect(diffColumn().contains(document.activeElement)).toBe(true);
    await waitFor(() => {
      expect(diffHeading()).toBe('MAT232/Exams/Midterm/Midterm review.md');
    });

    await user.keyboard('{Escape}');
    expect(view).not.toHaveAttribute('data-covered');
    expect(screen.queryByRole('region', { name: 'Selected version' })).not.toBeInTheDocument();
    expect(review).toHaveAttribute('aria-selected', 'true');
    expect(review).toHaveFocus();
    // The list comes back with the fade and rise (§14), at once with reduced motion.
    expect(document.querySelector('.history-view__panel')).toHaveAttribute('data-returned');

    // Enter on the row shown opens its diff again; Alt+Left goes back too.
    await user.keyboard('{Enter}');
    expect(view).toHaveAttribute('data-covered');
    expect(diffColumn().contains(document.activeElement)).toBe(true);
    await user.keyboard('{Alt>}{ArrowLeft}{/Alt}');
    expect(view).not.toHaveAttribute('data-covered');
    expect(review).toHaveFocus();

    const deleted = within(card).getByRole('option', { name: 'MAT232/Old slides L2.pdf, Deleted' });
    await user.click(deleted);
    expect(view).toHaveAttribute('data-covered');
    await user.click(within(diffColumn()).getByRole('button', { name: 'Back to history' }));
    expect(view).not.toHaveAttribute('data-covered');
    expect(deleted).toHaveAttribute('aria-selected', 'true');
    expect(deleted).toHaveFocus();
  });
});
