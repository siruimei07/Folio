// The problems list (library-actions handoff §11) against the fake shell: the header with its
// count, the groups in order, focus on the title, Copy path and Edit ignore rules, paging as the
// list scrolls, the refetch on ProblemsChanged, the empty, loading and error states, and the
// footer's scan time.
import { act, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { ActivityControl } from '../app/activity/ActivityControl';
import { noteFinished, resetJobNotes } from '../app/activity/notes';
import { DialogHost } from '../app/DialogHost';
import { closeDialog, HostedDialogs, useNavigation } from '../app/navigation';
import { keys } from '../data/keys';
import type { Job, Problem } from '../ipc';
import { NOW } from '../test/data';
import { libraryFixture } from '../test/fixtures';
import { renderApp, toastTexts } from '../test/render';
import { ProblemsDialog } from './ProblemsDialog';

// The end-of-list watcher uses an IntersectionObserver (a no-op in jsdom's setup): this one
// remembers its callbacks, and `reachEnd` tells every watcher it came into view, as scrolling to
// the end of the list would. A new watcher reports at once, as the real one does.
const watchers = new Set<IntersectionObserverCallback>();
let endInView = false;
vi.stubGlobal(
  'IntersectionObserver',
  class {
    constructor(private readonly callback: IntersectionObserverCallback) {}
    observe() {
      watchers.add(this.callback);
      if (endInView) this.callback([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver);
    }
    unobserve = vi.fn();
    disconnect() {
      watchers.delete(this.callback);
    }
  },
);

function reachEnd(): void {
  act(() => {
    for (const callback of [...watchers]) {
      callback([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver);
    }
  });
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
  endInView = false;
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

function rowTitle(text: string) {
  return screen.findByText(titled(text));
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

  it('loads a page more each time the end of the list comes into view', async () => {
    renderProblems(manyLinks(450));
    await rowTitle('Links/link 0');
    expect(screen.getByRole('img', { name: '450 problems' })).toBeInTheDocument();
    expect(screen.getAllByRole('listitem')).toHaveLength(200);
    expect(screen.getByText('Loading more problems…')).toBeInTheDocument();
    reachEnd();
    await waitFor(() => {
      expect(screen.getAllByRole('listitem')).toHaveLength(400);
    });
    reachEnd();
    await waitFor(() => {
      expect(screen.getAllByRole('listitem')).toHaveLength(450);
    });
    expect(screen.queryByText('Loading more problems…')).toBeNull();
    expect(screen.getByRole('region', { name: "Shortcuts Folio doesn't follow, 450 items" })).toBeInTheDocument();
  });

  it('asks for the next page by itself while the end of a short list is in view', async () => {
    endInView = true;
    renderProblems(manyLinks(250));
    // renderProblems resets the flag: set it again before the first watcher starts.
    endInView = true;
    await waitFor(() => {
      expect(screen.getAllByRole('listitem')).toHaveLength(250);
    });
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
