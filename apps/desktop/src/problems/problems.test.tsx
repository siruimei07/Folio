// The problems list (library-actions handoff §11) against the fake shell: the header with its
// count, the groups in order, focus on the title, Copy path and Edit ignore rules, paging as the
// list scrolls (a page renders only the rows it adds), the refetch on ProblemsChanged, the empty,
// loading and error states, and the footer's scan time.
import { act, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, onTestFinished, vi } from 'vitest';

import { ActivityControl } from '../app/activity/ActivityControl';
import { noteFinished, resetJobNotes } from '../app/activity/notes';
import { DialogHost } from '../app/DialogHost';
import { closeDialog, HostedDialogs, useNavigation } from '../app/navigation';
import { MiddleTruncate } from '../components/MiddleTruncate/MiddleTruncate';
import { keys } from '../data/keys';
import type { Job, Problem } from '../ipc';
import { NOW } from '../test/data';
import { libraryFixture } from '../test/fixtures';
import { fakeListEnd } from '../test/listEnd';
import { renderApp, toastTexts } from '../test/render';
import { ProblemsDialog } from './ProblemsDialog';

/**
 * The rows shown. Waits for a page count with it: a role query over hundreds of rows, run on every
 * change, would slow the very renders the wait is for.
 */
function rowCount(): number {
  return document.querySelectorAll('.problems__row').length;
}

const listEnd = fakeListEnd(rowCount);

/**
 * How long one page of the list may take to show: twice the slowest page measured, rounded up to
 * 500 ms. Measured with 30 parallel processes running this file and SearchDialog.test.tsx beside a
 * full vitest run or a full `pnpm check`, 270 runs of each paging test: a page wait took a median of
 * 239–535 ms, 10 of 2,970 took over waitFor's default 1 s, the slowest 2,948 ms (a first page, in a
 * stall that also failed unrelated tests), and one 450-row test ran past vitest's 5 s limit. Main's
 * CI failed on a page that took over 1 s (run 37519512994).
 */
const PAGE_WAIT = { timeout: 6000 };
/** A paging test's own limit: its page waits (three at most), and as long again for the rest. */
const PAGING_TEST = { timeout: 4 * PAGE_WAIT.timeout };

// The real MiddleTruncate, watched: each row renders its title through it once per render.
vi.mock('../components/MiddleTruncate/MiddleTruncate', { spy: true });

/** How many times the row titled `text` has rendered in this test. */
function titleRenders(text: string): number {
  return vi.mocked(MiddleTruncate).mock.calls.filter(([props]) => props.text === text).length;
}

const SAMPLE: Problem[] = [
  { kind: 'notRelocated', from: 'Personal/a.pdf', to: 'MAT232/a.pdf', cause: 'folderTags' },
  { kind: 'invalidName', folder: 'CSC207/lab2', name: 'notes:v2.md', rule: 'invalidCharacter' },
  { kind: 'caseTwins', paths: ['MAT232/Lecture 3.pdf', 'MAT232/lecture 3.pdf'] },
  { kind: 'invalidIgnoreRule', file: null, line: 4 },
  { kind: 'unreadable', path: 'STA256/rec.m4a', failure: 'inUse' },
];

function renderProblems(problems: Problem[], options: Parameters<typeof renderApp>[1] = {}) {
  closeDialog();
  resetJobNotes();
  const onClose = vi.fn();
  const rendered = renderApp(<ProblemsDialog isOpen params={undefined} onClose={onClose} />, {
    fixture: libraryFixture(() => undefined, { problems }),
    now: NOW,
    ...options,
  });
  return { ...rendered, onClose };
}

/** Matches a row's title, which MiddleTruncate may split in two. */
function titled(text: string) {
  return (_: string, element: Element | null) =>
    element?.classList.contains('problems__row-title') === true && element.textContent === text;
}

function rowTitle(text: string, wait?: typeof PAGE_WAIT) {
  return screen.findByText(titled(text), undefined, wait);
}

function queryRowTitle(text: string) {
  return screen.queryByText(titled(text));
}

function libraryIdOf(shell: ReturnType<typeof renderApp>['shell']): string {
  const status = shell.status();
  if (status.state !== 'open') throw new Error('the fixture has an open library');
  return status.library.id;
}

function manyLinks(count: number): Problem[] {
  return Array.from({ length: count }, (_, index) => ({ kind: 'link', folder: 'Links', name: `link ${String(index)}` }));
}

describe('ProblemsDialog', () => {
  it('shows the title with the count, the intro, and the groups in the §11 order', async () => {
    renderProblems(SAMPLE);
    const dialog = await screen.findByRole('dialog', { name: 'Problems' });
    expect(await within(dialog).findByRole('img', { name: '5 problems' })).toHaveTextContent('5');
    expect(dialog).toHaveAccessibleDescription(
      "Folio left these out of your library or couldn't finish something in the last scan. Your files are safe: Folio didn't change any of them.",
    );
    const headings = within(dialog).getAllByRole('heading', { level: 3 });
    expect(headings.map((heading) => heading.getAttribute('aria-label'))).toEqual([
      "Names Windows doesn't allow, 1 item",
      'Names that differ only in capitals, 1 item',
      "Couldn't read, 1 item",
      "Ignore rules Folio can't use, 1 item",
      "Tags that didn't follow a move, 1 item",
    ]);
    const group = within(dialog).getByRole('region', { name: "Names Windows doesn't allow, 1 item" });
    expect(within(group).getByTitle('CSC207/lab2/notes:v2.md')).toBeInTheDocument();
    expect(
      within(group).getByText(
        'Has a colon ( : ). Rename it on the device that made it; until then Folio leaves it out.',
      ),
    ).toBeInTheDocument();
  });

  it("lists a damaged Word document under Couldn't read, saying it is tried again when the file changes", async () => {
    renderProblems([
      { kind: 'unreadable', path: 'MAT232/Essay draft.docx', failure: 'damaged' },
      { kind: 'unreadable', path: 'STA256/rec.m4a', failure: 'inUse' },
    ]);
    const dialog = await screen.findByRole('dialog', { name: 'Problems' });
    const group = await within(dialog).findByRole('region', { name: "Couldn't read, 2 items" });
    expect(within(group).getByTitle('MAT232/Essay draft.docx')).toBeInTheDocument();
    expect(
      within(group).getByText(
        "It may be damaged or protected with a password, so Folio can't search inside it. Folio tries again when the file changes.",
      ),
    ).toBeInTheDocument();
    expect(within(group).getByText('Another app is using it. Folio tries again on the next scan.')).toBeInTheDocument();
    expect(within(group).getByRole('button', { name: 'Copy path of MAT232/Essay draft.docx' })).toBeInTheDocument();
  });

  it('starts with focus on the title, then Tab moves through the row buttons; Esc closes', async () => {
    const { user, onClose } = renderProblems(SAMPLE);
    const title = await screen.findByRole('heading', { name: 'Problems' });
    await rowTitle('CSC207/lab2/notes:v2.md');
    await waitFor(() => {
      expect(title).toHaveFocus();
    });
    await user.tab();
    expect(screen.getByRole('button', { name: 'Close (Esc)' })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('button', { name: 'Copy path of CSC207/lab2/notes:v2.md' })).toHaveFocus();
    await user.tab();
    expect(
      screen.getByRole('button', { name: 'Copy paths of MAT232/Lecture 3.pdf and MAT232/lecture 3.pdf' }),
    ).toHaveFocus();
    // The focused button shows its tooltip: Esc closes that first (WCAG 1.4.13), then the dialog.
    await user.keyboard('{Escape}');
    expect(onClose).not.toHaveBeenCalled();
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalled();
  });

  it('copies the path joined to the library root, and both paths of names that differ in capitals', async () => {
    const { user } = renderProblems(SAMPLE);
    await user.click(await screen.findByRole('button', { name: 'Copy path of CSC207/lab2/notes:v2.md' }));
    await waitFor(() => {
      expect(toastTexts()).toContain('Copied the path');
    });
    expect(await navigator.clipboard.readText()).toBe('C:\\Test\\CSC207\\lab2\\notes:v2.md');

    await user.click(screen.getByRole('button', { name: 'Copy paths of MAT232/Lecture 3.pdf and MAT232/lecture 3.pdf' }));
    await waitFor(() => {
      expect(toastTexts()).toContain('Copied 2 paths');
    });
    expect(await navigator.clipboard.readText()).toBe('C:\\Test\\MAT232\\Lecture 3.pdf\nC:\\Test\\MAT232\\lecture 3.pdf');

    // A notRelocated row copies where the item is now.
    await user.click(screen.getByRole('button', { name: 'Copy path of MAT232/a.pdf' }));
    await waitFor(async () => {
      expect(await navigator.clipboard.readText()).toBe('C:\\Test\\MAT232\\a.pdf');
    });
  });

  it('says when the clipboard refuses the path', async () => {
    const { user } = renderProblems(SAMPLE);
    const button = await screen.findByRole('button', { name: 'Copy path of STA256/rec.m4a' });
    vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValueOnce(new Error('denied'));
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await user.click(button);
    await waitFor(() => {
      expect(toastTexts()).toContain("Couldn't copy the path");
    });
  });

  it('opens Library settings on the ignore rules from "Edit ignore rules"', async () => {
    const { user } = renderProblems(SAMPLE);
    const group = await screen.findByRole('region', { name: "Ignore rules Folio can't use, 1 item" });
    expect(within(group).getByTitle('Line 4 of your ignore rules')).toBeInTheDocument();
    await user.click(within(group).getByRole('button', { name: 'Edit ignore rules' }));
    expect(useNavigation.getState().dialog).toEqual({ kind: 'librarySettings', params: { page: 'ignore' } });
  });

  it('shows the empty state, without the intro or a count, when there are no problems', async () => {
    renderProblems([]);
    const dialog = await screen.findByRole('dialog', { name: 'Problems' });
    expect(await within(dialog).findByRole('heading', { name: 'No problems' })).toBeInTheDocument();
    expect(within(dialog).getByText('Folio found nothing to fix in the last scan.')).toBeInTheDocument();
    expect(within(dialog).queryByRole('img')).toBeNull();
    expect(dialog).not.toHaveAccessibleDescription();
  });

  it('says it is loading until the first page arrives', async () => {
    renderProblems(SAMPLE, { latencyMs: 200 });
    expect(await screen.findByRole('heading', { name: 'Loading the problems…' })).toBeInTheDocument();
    expect(await rowTitle('CSC207/lab2/notes:v2.md')).toBeInTheDocument();
  });

  it('shows the error state when the list fails to load, and Try again loads it', async () => {
    const { user, shell } = renderProblems(SAMPLE, { fail: [{ command: 'list_problems', code: 'AccessDenied' }] });
    expect(await screen.findByRole('heading', { name: "Couldn't load the problems" })).toBeInTheDocument();
    expect(screen.getByText('Windows denied access to this file or folder. Check its permissions, then try again.')).toBeInTheDocument();
    shell.setFailure('list_problems', null);
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await rowTitle('CSC207/lab2/notes:v2.md')).toBeInTheDocument();
  });

  it('refetches on ProblemsChanged: new problems join their group, gone ones leave', async () => {
    const { shell } = renderProblems(SAMPLE);
    await rowTitle('CSC207/lab2/notes:v2.md');
    act(() => {
      shell.addProblems([{ kind: 'special', folder: null, name: 'pipe' }]);
    });
    expect(await screen.findByRole('region', { name: "Items that aren't files or folders, 1 item" })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: '6 problems' })).toBeInTheDocument();
    act(() => {
      shell.setProblems([{ kind: 'link', folder: null, name: 'only' }]);
    });
    expect(await screen.findByText('only')).toBeInTheDocument();
    expect(queryRowTitle('CSC207/lab2/notes:v2.md')).toBeNull();
  });

  it('keeps the rows and offers Try again when the refetch fails', async () => {
    const { user, shell } = renderProblems(SAMPLE);
    await rowTitle('CSC207/lab2/notes:v2.md');
    shell.setFailure('list_problems', 'Internal');
    act(() => {
      shell.addProblems([{ kind: 'special', folder: null, name: 'pipe' }]);
    });
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent("Couldn't update the list");
    expect(within(alert).getByRole('button', { name: 'Copy details' })).toBeInTheDocument();
    expect(queryRowTitle('CSC207/lab2/notes:v2.md')).toBeInTheDocument();
    shell.setFailure('list_problems', null);
    await user.click(within(alert).getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('pipe')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('loads a page more each time the end of the list comes into view', PAGING_TEST, async () => {
    renderProblems(manyLinks(450));
    await rowTitle('Links/link 0', PAGE_WAIT);
    expect(screen.getByRole('img', { name: '450 problems' })).toBeInTheDocument();
    expect(screen.getAllByRole('listitem')).toHaveLength(200);
    expect(screen.getByText('Loading more problems…')).toBeInTheDocument();
    listEnd.reach();
    await waitFor(() => {
      expect(rowCount()).toBe(400);
    }, PAGE_WAIT);
    listEnd.reach();
    await waitFor(() => {
      expect(rowCount()).toBe(450);
    }, PAGE_WAIT);
    expect(screen.queryByText('Loading more problems…')).toBeNull();
    expect(screen.getByRole('region', { name: "Shortcuts Folio doesn't follow, 450 items" })).toBeInTheDocument();
  });

  it('loads the next page when the end is reached the moment a page shows', PAGING_TEST, async () => {
    renderProblems(manyLinks(450));
    await rowTitle('Links/link 0', PAGE_WAIT);
    // Reaches the end in the microtask after the commit that shows 400 rows, before React has
    // run that commit's effects: the earliest a user could scroll there. The page arrives outside
    // `act`, a default-lane update, so React runs those effects in a later task. The watcher of
    // the first page reports first and the list skips it (its onEnd has not seen page 2 yet); the
    // effects then watch the end anew, and that watcher, which reports at once, has to load page 3.
    // The reach landed in this window in all 292 runs of a probe under 30 parallel processes, and
    // the last check makes sure it did here: page 3 ends the paging, so no watcher starts for it,
    // and a watcher started after the reach is the one those effects started. A reach after the
    // effects reaches that watcher itself, and the check fails.
    let reached = false;
    let watchesAtReach = 0;
    const scroll = new MutationObserver(() => {
      if (rowCount() !== 400) return;
      scroll.disconnect();
      reached = true;
      watchesAtReach = listEnd.watches();
      listEnd.reachNow();
    });
    scroll.observe(document.body, { childList: true, subtree: true });
    onTestFinished(() => {
      scroll.disconnect();
    });
    listEnd.reach();
    await waitFor(() => {
      expect(reached).toBe(true);
    }, PAGE_WAIT);
    await waitFor(() => {
      expect(rowCount()).toBe(450);
    }, PAGE_WAIT);
    expect(listEnd.watches()).toBeGreaterThan(watchesAtReach);
  });

  it('renders only the rows a page adds, and a row again when the shell changes its problem', PAGING_TEST, async () => {
    const { shell } = renderProblems(manyLinks(250));
    await rowTitle('Links/link 0', PAGE_WAIT);
    const first = document.querySelector('.problems__row');
    const copy = first?.querySelector('button');
    expect(copy).toHaveAccessibleName('Copy path of Links/link 0');
    const renders = titleRenders('Links/link 0');
    listEnd.reach();
    await waitFor(() => {
      expect(rowCount()).toBe(250);
    }, PAGE_WAIT);
    // The first page's rows stayed as they were: the same nodes, not rendered again.
    expect(document.querySelector('.problems__row')).toBe(first);
    expect(first?.querySelector('button')).toBe(copy);
    expect(titleRenders('Links/link 0')).toBe(renders);
    expect(titleRenders('Links/link 249')).toBeGreaterThan(0);

    // The first problem changes and keeps its id; ProblemsChanged refetches the pages.
    const unchanged = titleRenders('Links/link 1');
    act(() => {
      const [item] = shell.library.problems;
      if (item === undefined) throw new Error('the list has problems');
      shell.library.problems[0] = { ...item, problem: { kind: 'link', folder: 'Links', name: 'renamed' } };
      shell.addProblems([]);
    });
    expect(await rowTitle('Links/renamed', PAGE_WAIT)).toBeInTheDocument();
    expect(queryRowTitle('Links/link 0')).toBeNull();
    expect(titleRenders('Links/link 1')).toBe(unchanged);
  });

  it('asks for the next page by itself while the end of a short list is in view', PAGING_TEST, async () => {
    listEnd.fit();
    renderProblems(manyLinks(250));
    // A wait for the first page, then one for the next, which the list asks for without any
    // scrolling: one wait for both would have to cover every render of the list in one timeout.
    await rowTitle('Links/link 0', PAGE_WAIT);
    await waitFor(() => {
      expect(rowCount()).toBe(250);
    }, PAGE_WAIT);
    expect(screen.queryByText('Loading more problems…')).toBeNull();
  });

  it('says when the scan was: today by time, an earlier day by date, else only that it updates', async () => {
    const { client, shell } = renderProblems(SAMPLE);
    expect(await screen.findByText('The list updates after every scan.')).toBeInTheDocument();
    const scan: Job = {
      id: 'scan-1',
      kind: 'scan',
      cancellable: false,
      status: { state: 'done', result: { kind: 'scan', changes: 0, problems: 5 } },
    };
    const at = new Date(NOW);
    at.setHours(17, 3, 0, 0);
    act(() => {
      noteFinished([scan.id], at.getTime());
      client.setQueryData(keys.jobs(libraryIdOf(shell)), [scan]);
    });
    expect(await screen.findByText('From the scan at 5:03 PM. The list updates after every scan.')).toBeInTheDocument();

    const earlier: Job = { ...scan, id: 'scan-0' };
    act(() => {
      resetJobNotes();
      noteFinished([earlier.id], Date.UTC(2026, 8, 27, 12));
      client.setQueryData(keys.jobs(libraryIdOf(shell)), [earlier]);
    });
    expect(await screen.findByText('From the scan on Sep 27. The list updates after every scan.')).toBeInTheDocument();
  });

  it('opens from the Activity popover, and Esc returns focus to the activity button', async () => {
    closeDialog();
    resetJobNotes();
    const { user, shell } = renderApp(
      <HostedDialogs value={new Set(['problems'])}>
        <ActivityControl compact={false} />
        <DialogHost dialogs={{ problems: ProblemsDialog }} />
      </HostedDialogs>,
      { fixture: libraryFixture(() => undefined, { problems: SAMPLE }), now: NOW },
    );
    act(() => {
      shell.startScan();
    });
    // "Done" for a while after the scan, then the problem count: either opens the popover.
    const button = await screen.findByRole('button', { name: /^Activity: (all )?tasks done/ }, { timeout: 3000 });
    await user.click(button);
    await user.click(await screen.findByRole('button', { name: 'View problems' }));
    const title = await screen.findByRole('heading', { name: 'Problems' });
    await waitFor(() => {
      expect(title).toHaveFocus();
    });
    await user.keyboard('{Escape}');
    // React Aria gives focus back in the frame after the dialog unmounts.
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Problems' })).toBeNull();
      expect(screen.getByRole('button', { name: /^Activity/ })).toHaveFocus();
    });
  });
});
