// Search against the fake shell (ipc-m1 §10; ui-architecture §9): pages of 50 over the fixed
// window, pages of one revision only, the length limit checked without asking, and earlier hits
// kept while a new text loads.
import { waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { ipc, LIMITS, type SearchHit, type SearchPage } from '../ipc';
import { SeedBuilder } from '../ipc/mock/fixtures/build';
import type { Fixture } from '../ipc/mock/fixtures/types';
import { NOW, refIn, SMALL } from '../test/data';
import { renderAppHook } from '../test/render';
import { unwrap } from './errors';
import { combineHits, nextOffset, SEARCH_PAGE, useSearch } from './search';

const MAT = 'Fall 2026/MAT232 Calculus of Several Variables';

/** A library with `count` notes that match "gradient", and a folder elsewhere. */
function notesLibrary(count: number): Fixture {
  const b = new SeedBuilder(NOW);
  b.folder('Fall 2026', { group: { order: 1 } });
  b.folder('Fall 2026/MAT232', { group: { order: 1, code: 'MAT232' } });
  for (let n = 1; n <= count; n++) b.file(`Fall 2026/MAT232/gradient ${String(n)}.md`, { size: 10 });
  b.folder('Fall 2026/CSC148', { group: { order: 2 } });
  b.file('Fall 2026/CSC148/hw1.py', { size: 10 });
  return {
    status: { state: 'open' },
    library: { ...SMALL, tags: [], problems: [], entries: b.build() },
    folderChoices: [],
    importSources: [],
  };
}

function hit(id: string): SearchHit {
  return {
    entry: {
      id,
      path: id,
      name: id,
      kind: 'file',
      class: 'text',
      size: '1',
      modifiedMs: null,
      addedMs: '0',
      tags: [],
      folderTags: [],
    },
    name: [{ text: id, matched: true }],
    snippet: null,
  };
}

function page(offset: number, ids: string[], more: boolean, revision = 1): SearchPage {
  return { items: ids.map(hit), offset, more, revision };
}

describe('nextOffset', () => {
  it('follows the last page while more hits follow within the window', () => {
    expect(nextOffset(page(0, ['a', 'b'], true))).toBe(2);
    expect(nextOffset(page(0, ['a', 'b'], false))).toBeUndefined();
    expect(nextOffset(page(450, Array.from({ length: 50 }, String), true))).toBeUndefined();
    // An empty page never asks for the same offset again.
    expect(nextOffset(page(100, [], true))).toBeUndefined();
  });
});

describe('combineHits', () => {
  it('joins the pages of one revision in order', () => {
    expect(combineHits([page(0, ['a', 'b'], true, 4), page(2, ['c'], false, 4)])).toEqual({
      hits: ['a', 'b', 'c'].map(hit),
      consistent: true,
    });
  });

  it('leaves out a page of another revision, and what follows it', () => {
    const pages = [page(0, ['a'], true, 4), page(1, ['b'], true, 5), page(2, ['c'], false, 4)];
    expect(combineHits(pages)).toEqual({ hits: [hit('a')], consistent: false });
  });
});

describe('useSearch', () => {
  it('asks for pages of 50, and stops where the matches end', async () => {
    const { result, shell } = renderAppHook(() => useSearch('  gradient ', null), {
      fixture: notesLibrary(120),
      now: NOW,
    });
    const invoke = vi.spyOn(shell, 'invoke');
    await waitFor(() => {
      expect(result.current.hits).toHaveLength(50);
    });
    expect(result.current).toMatchObject({ status: 'success', hasMore: true, error: null });

    result.current.loadMore();
    await waitFor(() => {
      expect(result.current.hits).toHaveLength(100);
    });
    result.current.loadMore();
    await waitFor(() => {
      expect(result.current.hits).toHaveLength(120);
    });

    expect(result.current.hasMore).toBe(false);
    expect(new Set(result.current.hits.map((item) => item.entry.id)).size).toBe(120);
    expect(invoke.mock.calls.map(([, payload]) => payload)).toEqual([
      { request: { text: 'gradient', scope: null, page: { offset: 50, limit: SEARCH_PAGE } } },
      { request: { text: 'gradient', scope: null, page: { offset: 100, limit: SEARCH_PAGE } } },
    ]);
  });

  it('never asks beyond the window of the best matches', async () => {
    const { result, shell } = renderAppHook(() => useSearch('gradient', null), {
      fixture: notesLibrary(LIMITS.searchResults + 20),
      now: NOW,
    });
    const invoke = vi.spyOn(shell, 'invoke');
    for (let loaded = SEARCH_PAGE; loaded <= LIMITS.searchResults; loaded += SEARCH_PAGE) {
      await waitFor(() => {
        expect(result.current.hits).toHaveLength(loaded);
      });
      result.current.loadMore();
    }
    expect(result.current.hasMore).toBe(false);
    expect(invoke.mock.calls).toHaveLength(LIMITS.searchResults / SEARCH_PAGE - 1);
  });

  it('asks for the first page again when a page arrives from a newer revision', async () => {
    const { result, shell } = renderAppHook(() => useSearch('gradient', null), {
      fixture: notesLibrary(80),
      now: NOW,
      // The change's CatalogChanged does not arrive during the test.
      eventDelayMs: 60_000,
    });
    await waitFor(() => {
      expect(result.current.hits).toHaveLength(50);
    });
    // A change elsewhere: the next page is read at the next revision.
    const notes = notesLibrary(80).library;
    if (notes === null) throw new Error('no library');
    await unwrap(ipc.renameEntry({ entry: refIn(notes, 'Fall 2026/CSC148/hw1.py'), name: 'hw01.py' }));
    const invoke = vi.spyOn(shell, 'invoke');

    result.current.loadMore();

    // The second page's revision differs from the first's: both go, and the first is asked again.
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledTimes(2);
    });
    await waitFor(() => {
      expect(result.current).toMatchObject({ hasMore: true, isLoadingMore: false });
    });
    expect(result.current.hits).toHaveLength(50);
    result.current.loadMore();
    await waitFor(() => {
      expect(result.current.hits).toHaveLength(80);
    });
    expect(invoke.mock.calls.map(([, payload]) => (payload as { request: { page: unknown } }).request.page)).toEqual([
      { offset: 50, limit: 50 },
      { offset: 0, limit: 50 },
      { offset: 50, limit: 50 },
    ]);
    expect(new Set(result.current.hits.map((item) => item.entry.id)).size).toBe(80);
  });

  it('asks nothing without text, and finds text over the limit too long without asking', async () => {
    const { result, rerender, shell } = renderAppHook((text: string) => useSearch(text, null), {
      initialProps: '   ',
      now: NOW,
    });
    const invoke = vi.spyOn(shell, 'invoke');
    expect(result.current).toMatchObject({ status: 'idle', hits: [], hasMore: false, error: null });

    rerender('数'.repeat(LIMITS.queryChars + 1));

    await waitFor(() => {
      expect(result.current.status).toBe('error');
    });
    expect(result.current.error?.error.code).toBe('QueryTooLong');
    expect(invoke).not.toHaveBeenCalled();
  });

  it('sends pasted text with a lone surrogate well formed, so the call does not fail', async () => {
    const { result } = renderAppHook(() => useSearch('lecture \uD800', null), { now: NOW });
    await waitFor(() => {
      expect(result.current.status).toBe('success');
    });
  });

  it('keeps the earlier text’s hits while a new text loads, never a cleared text’s', async () => {
    const { result, rerender } = renderAppHook((text: string) => useSearch(text, null), {
      initialProps: 'lecture',
      now: NOW,
      latencyMs: 30,
    });
    await waitFor(() => {
      expect(result.current.status).toBe('success');
    });
    const earlier = result.current.hits;
    expect(earlier.length).toBeGreaterThan(0);

    rerender('midterm');
    expect(result.current).toMatchObject({ isPrevious: true, hits: earlier });
    await waitFor(() => {
      expect(result.current.isPrevious).toBe(false);
    });
    expect(result.current.hits.map((item) => item.entry.name)).toContain('Midterm 2025.pdf');

    rerender('');
    expect(result.current).toMatchObject({ status: 'idle', hits: [], isPrevious: false });
  });

  it('searches within a scope, and refreshes when a change lands in it', async () => {
    const { result } = renderAppHook(() => useSearch('pdf', refIn(SMALL, `${MAT}/Exams`)), { now: NOW });
    await waitFor(() => {
      expect(result.current.hits.map((item) => item.entry.name)).toEqual(['Midterm 2025.pdf']);
    });

    await unwrap(
      ipc.renameEntry({ entry: refIn(SMALL, `${MAT}/Exams/Midterm/Midterm 2025.pdf`), name: 'Midterm 2025.docx' }),
    );

    await waitFor(() => {
      expect(result.current.hits).toEqual([]);
    });
  });

  it('keeps a stale scope’s error typed', async () => {
    const exams = refIn(SMALL, `${MAT}/Exams`);
    const { result, rerender } = renderAppHook((text: string) => useSearch(text, exams), {
      initialProps: '',
      now: NOW,
    });
    await unwrap(ipc.renameEntry({ entry: exams, name: 'Tests' }));

    rerender('pdf');

    await waitFor(() => {
      expect(result.current.status).toBe('error');
    });
    expect(result.current.error?.error.code).toBe('NotFound');
  });
});
