// The timeline on the fake shell (handoff workspace-history §7.2, §7.5, §7.6): the feed's articles
// and what they say, Page Up and Page Down, paging through a long history, the end rows, failures,
// and the entry at the top staying put when entries arrive above it.
import { act, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { HISTORY_PAGE } from '../../data/history';
import type { HistoryItem, HistoryType, Page, PageRequest } from '../../ipc';
import { NOW } from '../../test/data';
import { settle } from '../../test/render';
import { dayLabel } from '../model/days';
import { useHistoryPreferences } from '../preferences';
import { findFeed, holdAnswers, renderHistory, resetHistoryPreferences, scrollTimelineTo, timelineScroller } from '../test/render';

resetHistoryPreferences();

type Shell = ReturnType<typeof renderHistory>['shell'];

/** The shell's timeline as `list_history` answers it. */
function timeline(shell: Shell, types: HistoryType[] | null = null, limit = 100): Page<HistoryItem> {
  return shell.versioning.historyPage({ offset: 0, limit }, types);
}

/** Edits the newest commit's message through the shell, which sends HistoryChanged. */
async function rewordHead(shell: Shell): Promise<void> {
  const commit = shell.versioning.head?.id;
  if (commit === undefined) throw new Error('no commit');
  await act(async () => {
    await shell.invoke('reword_commit', { request: { commit, summary: 'MAT232: reworded', body: null } });
  });
}

function headKey(shell: Shell): string {
  return `commit ${shell.versioning.head?.id ?? ''}`;
}

function articles(feed: HTMLElement): HTMLElement[] {
  return within(feed).getAllByRole('article');
}

/** Scrolls to the end of the entries read; jsdom has no scroll height, the feed has the virtualiser's. */
function scrollToEnd(): void {
  const feed = document.querySelector<HTMLElement>('.timeline__feed');
  scrollTimelineTo(Number.parseFloat(feed?.style.height ?? '0'));
}

/** Where an entry's item starts in the timeline, from its transform. */
function startOf(key: string): number {
  const item = document.querySelector<HTMLElement>(`[data-entry="${key}"]`)?.closest<HTMLElement>('.timeline__item');
  const match = item === null || item === undefined ? null : /translateY\((-?[\d.]+)px\)/.exec(item.style.transform);
  if (match?.[1] === undefined) throw new Error(`${key} is not rendered`);
  return Number(match[1]);
}

/** The class of the Lucide icon in an entry's icon column. */
function iconOf(article: HTMLElement): string {
  return article.querySelector('.entry__icon svg')?.getAttribute('class') ?? '';
}

describe('the feed', () => {
  it('is a feed of articles in the list’s order, each named by its title and described by its day, time and source', async () => {
    const { shell } = renderHistory();
    const feed = await findFeed();
    const page = timeline(shell);
    const all = articles(feed);

    expect(all).toHaveLength(page.total);
    all.forEach((article, index) => {
      expect(article).toHaveAttribute('aria-posinset', String(index + 1));
      expect(article).toHaveAttribute('aria-setsize', String(page.total));
    });
    // The newest entry: the small history's message edit, with the reworded commit's short id.
    const [reword] = page.items;
    if (reword?.kind !== 'reword') throw new Error('expected a message edit first');
    expect(all[0]).toHaveAccessibleName('Edited commit message');
    expect(all[0]).toHaveAccessibleDescription(expect.stringContaining(reword.commit.slice(3, 10)) as string);
    expect(all[0]).toHaveAccessibleDescription(expect.stringMatching(/^(Today|Yesterday), \w{3} \d+, \d+:\d{2} [AP]M /) as string);
    expect(all[1]).toHaveAccessibleName('Undid commit “ECO101: add demand data”');
    // A commit: made on this computer, its whole body in the description and the tooltip.
    const withBody = within(feed).getByRole('article', { name: 'MAT223: update exercise 1; MAT232: update the midterm review' });
    expect(withBody).toHaveAccessibleDescription(
      expect.stringMatching(/, made on G16 \w{7} Exercise 1 gets a third question\.\nThe review covers directional derivatives now\.$/) as string,
    );
    expect(withBody.querySelector('.entry__body')).toHaveAttribute(
      'title',
      'Exercise 1 gets a third question.\nThe review covers directional derivatives now.',
    );
    expect(within(withBody).getByText('G16').closest('.entry__source')).toHaveAttribute('title', 'Made on G16');
    // The first commit, with how many files the library held.
    const first = all.at(-1);
    expect(first).toHaveAccessibleName('Start history');
    expect(first).toHaveAccessibleDescription(expect.stringMatching(/files were in your library when Folio started keeping history\.$/) as string);
  });

  it('heads each day visually, hidden from the feed, and ends with the start of the history', async () => {
    const { shell } = renderHistory();
    const feed = await findFeed();
    const page = timeline(shell);

    const headers = [...feed.querySelectorAll('.day-header')];
    expect(headers.length).toBeGreaterThan(1);
    expect(headers.every((header) => header.getAttribute('aria-hidden') === 'true')).toBe(true);
    const [newest] = page.items;
    const effective = newest?.kind === 'commit' ? newest.commit.effectiveMs : newest?.effectiveMs;
    expect(headers[0]).toHaveTextContent(dayLabel(Number(effective), NOW, 'en'));
    // A feed owns only articles: the end row comes after it.
    expect(within(feed).queryByRole('status')).not.toBeInTheDocument();
    const start = screen.getByText("That's the start of your history.");
    expect(feed.contains(start)).toBe(false);
    expect(screen.queryByText('Loading earlier entries…')).not.toBeInTheDocument();
  });

  it('gives each kind its icon', async () => {
    renderHistory();
    const feed = await findFeed();
    const byKind = new Map(articles(feed).map((article) => [article.dataset.kind, iconOf(article)]));

    expect(byKind.get('reword')).toContain('lucide-pencil');
    expect(byKind.get('uncommit')).toContain('lucide-undo-2');
    expect(byKind.get('commit')).toContain('lucide-circle-check');
    expect(byKind.get('first')).toContain('lucide-flag');
  });

  it('words a restore with its file and version, and an import as from iCloud', async () => {
    useHistoryPreferences.setState({ types: ['restore'] });
    renderHistory({ scenario: 'history-long' });
    const restores = await findFeed();
    const [restore] = articles(restores);
    if (restore === undefined) throw new Error('no restore');
    expect(restore).toHaveAccessibleName(expect.stringMatching(/^Restored Midterm review\.md to the version from \w{3} \d+(, \d{4})?$/) as string);
    expect(restore).toHaveAttribute('data-kind', 'restore');
    expect(iconOf(restore)).toContain('lucide-rotate-ccw');
    // Operations name no device.
    expect(restore.querySelector('.entry__source')).toBeNull();

    act(() => {
      useHistoryPreferences.setState({ types: ['commit'] });
    });
    const commits = await waitFor(() => {
      const feed = screen.getByRole('feed');
      if (articles(feed)[0]?.dataset.kind === 'restore') throw new Error('still the restores');
      return feed;
    });
    // The newest import is a page's worth of commits down: scroll to it.
    let imported: HTMLElement | undefined;
    for (let top = 0; imported === undefined && top < 20_000; top += 600) {
      scrollTimelineTo(top);
      imported = articles(commits).find((article) => article.dataset.kind === 'import');
    }
    if (imported === undefined) throw new Error('no import rendered');
    expect(imported).toHaveAccessibleName('Changes from iCloud');
    expect(iconOf(imported)).toContain('lucide-cloud-download');
    expect(imported).toHaveAccessibleDescription(expect.stringContaining(', from iCloud ') as string);
    const source = imported.querySelector('.entry__source');
    expect(source).toHaveTextContent('iCloud');
    expect(source).toHaveAttribute('title', 'From iCloud');
    expect(source?.querySelector('svg')?.getAttribute('class')).toContain('lucide-cloud');
  });
});

describe('Page Up and Page Down', () => {
  it('move the focus between entries, with one entry the tab stop', async () => {
    const { user } = renderHistory();
    const feed = await findFeed();
    const all = articles(feed);
    expect(all.map((article) => article.tabIndex)).toEqual([0, ...all.slice(1).map(() => -1)]);

    act(() => {
      all[0]?.focus();
    });
    await user.keyboard('{PageDown}');
    expect(document.activeElement).toBe(articles(feed)[1]);
    await user.keyboard('{PageDown}{PageDown}');
    expect(document.activeElement).toBe(articles(feed)[3]);
    expect(articles(feed).map((article) => article.tabIndex).indexOf(0)).toBe(3);
    await user.keyboard('{PageUp}');
    expect(document.activeElement).toBe(articles(feed)[2]);
    await user.keyboard('{PageUp}{PageUp}{PageUp}');
    expect(document.activeElement).toBe(articles(feed)[0]);
    // The last entry: nothing further.
    act(() => {
      articles(feed).at(-1)?.focus();
    });
    await user.keyboard('{PageDown}');
    expect(document.activeElement).toBe(articles(feed).at(-1));
  });

  // WAI-ARIA feed: Tab crosses every entry's controls, and a long history keeps coming as it nears
  // the end, so these keys leave the feed at once.
  it('give way to Ctrl+End and Ctrl+Home, which move the focus past the feed or before it', async () => {
    const { user } = renderHistory({ scenario: 'history-long' });
    const feed = await findFeed();
    act(() => {
      articles(feed)[0]?.focus();
    });

    await user.keyboard('{Control>}{End}{/Control}');
    // After the feed: the resize handle (the end row has no control while it loads or ends).
    expect(screen.getByRole('separator', { name: 'Resize the history panel' })).toHaveFocus();

    // From a control inside an entry: before the feed, the header's type filter.
    const [inside] = within(feed).getAllByRole('button');
    act(() => {
      inside?.focus();
    });
    await user.keyboard('{Control>}{Home}{/Control}');
    expect(screen.getByRole('button', { name: /^Filter by type: / })).toHaveFocus();
  });

  it('keep the focused entry rendered while the view scrolls far from it', async () => {
    renderHistory({ scenario: 'history-long' });
    const feed = await findFeed();
    const first = articles(feed)[0];
    act(() => {
      first?.focus();
    });

    scrollTimelineTo(4_000);

    const rendered = articles(feed);
    expect(rendered[0]).toBe(first);
    expect(document.activeElement).toBe(first);
    // The rest are those around the view, far below it.
    expect(Number(rendered[1]?.getAttribute('aria-posinset'))).toBeGreaterThan(20);
  });

  it('keep the focus in the feed when a reword replaces the focused entry', async () => {
    const { shell } = renderHistory();
    const feed = await findFeed();
    const key = headKey(shell);
    const focused = feed.querySelector<HTMLElement>(`[data-entry="${key}"]`);
    act(() => {
      focused?.focus();
    });
    expect(document.activeElement).toBe(focused);

    await rewordHead(shell);

    await waitFor(() => {
      expect(feed.querySelector(`[data-entry="${key}"]`)).toBeNull();
    });
    await waitFor(() => {
      expect(articles(feed)).toContain(document.activeElement);
    });
    expect((document.activeElement as HTMLElement).tabIndex).toBe(0);
  });
});

describe('a long history', () => {
  it('loads earlier pages as the end comes near, saying so after the last entry', async () => {
    const { shell } = renderHistory({ scenario: 'history-long', latencyMs: 30 });
    const feed = await findFeed();
    const { total } = timeline(shell, null, 0);
    expect(total).toBeGreaterThan(1_200);
    expect(articles(feed)[0]).toHaveAttribute('aria-setsize', String(total));
    expect(articles(feed).length).toBeLessThan(HISTORY_PAGE);
    expect(screen.getByRole('status')).toHaveTextContent('Loading earlier entries…');

    scrollToEnd();

    await waitFor(() => {
      expect(feed).toHaveAttribute('aria-busy', 'true');
    });
    await waitFor(() => {
      expect(feed).not.toHaveAttribute('aria-busy');
    });
    scrollToEnd();
    await waitFor(() => {
      const last = articles(feed).at(-1);
      expect(Number(last?.getAttribute('aria-posinset'))).toBeGreaterThan(HISTORY_PAGE);
    });
  });

  it('loads the next page on Page Down at the last entry read, and Page Down then moves on', async () => {
    const { user } = renderHistory({ scenario: 'history-long', latencyMs: 200 });
    const feed = await findFeed();
    scrollToEnd();
    const last = await waitFor(() => {
      const article = articles(feed).find((candidate) => candidate.getAttribute('aria-posinset') === String(HISTORY_PAGE));
      if (article === undefined) throw new Error('the last entry read is not rendered');
      return article;
    });
    act(() => {
      last.focus();
    });

    // Asked already as the end came near, or now: the focus stays until the page arrives.
    await user.keyboard('{PageDown}');
    expect(document.activeElement).toBe(last);
    await waitFor(() => {
      expect(articles(feed).some((article) => article.getAttribute('aria-posinset') === String(HISTORY_PAGE + 1))).toBe(true);
    });
    await user.keyboard('{PageDown}');

    expect(document.activeElement).toHaveAttribute('aria-posinset', String(HISTORY_PAGE + 1));
  });

  it('asks for the next page again when a refresh cancelled the one loading', async () => {
    const { shell } = renderHistory({ scenario: 'history-long', latencyMs: 200 });
    const feed = await findFeed();
    const offsets: number[] = [];
    const invoke = shell.invoke.bind(shell);
    vi.spyOn(shell, 'invoke').mockImplementation(async (command, payload) => {
      if (command === 'list_history') offsets.push((payload as { request: { page: PageRequest } }).request.page.offset);
      return invoke(command, payload);
    });
    scrollToEnd();
    await waitFor(() => {
      expect(feed).toHaveAttribute('aria-busy', 'true');
    });

    // A message edit while the page loads: its HistoryChanged reads the first page again and
    // cancels the next one, which nothing else asks for again (the range stays near the end).
    await rewordHead(shell);

    await waitFor(
      () => {
        scrollToEnd();
        expect(Number(articles(feed).at(-1)?.getAttribute('aria-posinset'))).toBeGreaterThan(HISTORY_PAGE);
      },
      { timeout: 3_000 },
    );
    expect(offsets.filter((offset) => offset === HISTORY_PAGE).length).toBeGreaterThan(1);
  });

  it('shows a failed page after the entries with Try again, and asks for nothing more until then', async () => {
    const { user, shell } = renderHistory({ scenario: 'history-long' });
    const feed = await findFeed();
    shell.setFailure('list_history', 'Internal');

    scrollToEnd();

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent("Couldn't load earlier entries.");
    expect(feed.contains(alert)).toBe(false);
    expect(screen.queryByText('Loading earlier entries…')).not.toBeInTheDocument();
    const tryAgain = within(alert).getByRole('button', { name: 'Try again' });
    act(() => {
      tryAgain.focus();
    });
    const invoke = vi.spyOn(shell, 'invoke');

    // Failing again: the row stays, with the focus.
    await user.keyboard('{Enter}');
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('list_history', expect.anything());
    });
    await act(async () => {
      await (invoke.mock.results.at(-1)?.value as Promise<unknown> | undefined)?.catch(() => undefined);
    });
    expect(screen.getByRole('alert')).toBe(alert);
    expect(tryAgain).toHaveFocus();
    shell.setFailure('list_history', null);

    // Working: the row goes, and the timeline's tab stop takes the focus.
    await user.keyboard('{Enter}');
    await waitFor(() => {
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });
    expect(feed.querySelector('article[tabindex="0"]')).toHaveFocus();
    scrollToEnd();
    await waitFor(() => {
      expect(articles(feed).some((article) => Number(article.getAttribute('aria-posinset')) > HISTORY_PAGE)).toBe(true);
    });
  });

  it('keeps a failed page’s row through a refresh, which shows no refresh failure while it reads', async () => {
    const { shell } = renderHistory({ scenario: 'history-long' });
    await findFeed();
    shell.setFailure('list_history', 'Internal');
    scrollToEnd();
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent("Couldn't load earlier entries.");
    shell.setFailure('list_history', null);
    const refresh = holdAnswers(shell, 'list_history');

    // A message edit meanwhile: its HistoryChanged reads the pages again.
    await rewordHead(shell);
    await waitFor(() => {
      expect(refresh.invoke).toHaveBeenCalledWith('list_history', expect.anything());
    });
    await settle();

    expect(screen.getByRole('alert')).toBe(alert);
    expect(screen.queryByText("Couldn't update the history.")).not.toBeInTheDocument();
    // Once it has read them, the failure is gone with it: the next page can be asked again.
    refresh.release();
    await waitFor(() => {
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });
    expect(screen.queryByText("Couldn't update the history.")).not.toBeInTheDocument();
  });
});

describe('entries arriving above', () => {
  it('leave the entry at the top of the view where it was', async () => {
    const { shell } = renderHistory({ scenario: 'history-long' });
    const feed = await findFeed();
    scrollTimelineTo(1_500);
    // The entry the top of the view is in: the last one starting above it.
    const key = articles(feed)
      .map((article) => article.dataset.entry ?? '')
      .filter((candidate) => startOf(candidate) <= 1_500)
      .at(-1);
    if (key === undefined) throw new Error('no entry at the top');
    const delta = timelineScroller().scrollTop - startOf(key);
    const before = startOf(key);

    await rewordHead(shell);

    await waitFor(() => {
      expect(articles(feed)[0]).toHaveAccessibleName('Edited commit message');
    });
    expect(startOf(key)).toBeGreaterThan(before);
    expect(timelineScroller().scrollTop - startOf(key)).toBe(delta);
  });

  it('show at the top of a view scrolled to the top', async () => {
    const { shell } = renderHistory({ scenario: 'history-long' });
    const feed = await findFeed();
    const firstBefore = articles(feed)[0]?.dataset.entry;

    await rewordHead(shell);

    await waitFor(() => {
      expect(articles(feed)[0]).toHaveAccessibleName('Edited commit message');
    });
    expect(articles(feed)[0]?.dataset.entry).not.toBe(firstBefore);
    expect(timelineScroller().scrollTop).toBe(0);
  });

  it('a refresh that fails keeps the entries under a banner with Try again', async () => {
    const { user, shell } = renderHistory();
    const feed = await findFeed();
    const count = articles(feed).length;
    shell.setFailure('list_history', 'Internal');

    await rewordHead(shell);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent("Couldn't update the history.");
    expect(within(alert).getByRole('button', { name: 'Copy details' })).toBeInTheDocument();
    expect(articles(feed)).toHaveLength(count);
    shell.setFailure('list_history', null);

    await user.click(within(alert).getByRole('button', { name: 'Try again' }));

    await waitFor(() => {
      expect(articles(feed)).toHaveLength(count + 1);
    });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
