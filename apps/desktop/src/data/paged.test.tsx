import { type UseQueryResult } from '@tanstack/react-query';
import { waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { EntryRow, Page } from '../ipc';
import { renderAppHook } from '../test/render';
import { useChildren, useFiles } from './entries';
import { combinePages, LIST_PAGE, pagesOf, type RowRange, useCount } from './paged';

const NAME = { key: 'name', descending: false } as const;
const NO_FILTER = { tags: null, addedAfterMs: null };
const NOW = Date.UTC(2026, 8, 30, 12);

describe('pagesOf', () => {
  it('names the pages that hold a range of rows, widened by a margin', () => {
    expect(pagesOf({ start: 0, end: 19 }, 0)).toEqual([0]);
    expect(pagesOf({ start: 190, end: 210 }, 0)).toEqual([0, 1]);
    expect(pagesOf({ start: 30_000, end: 30_020 }, 50)).toEqual([149, 150]);
    expect(pagesOf({ start: 30_000, end: 30_020 }, 50, 30_010)).toEqual([149, 150]);
    expect(pagesOf({ start: 0, end: 30 }, 50, 60)).toEqual([0]);
  });

  it('names none beyond the end of the list', () => {
    expect(pagesOf({ start: 500, end: 520 }, 0, 100)).toEqual([]);
    expect(pagesOf({ start: 0, end: 10 }, 0, 0)).toEqual([]);
  });
});

function row(id: string): EntryRow {
  return {
    id,
    path: `f/${id}`,
    name: id,
    kind: 'file',
    class: 'other',
    size: '1',
    modifiedMs: null,
    addedMs: '0',
    tags: [],
    folderTags: [],
  };
}

function loaded(page: number, revision: number, ids: string[], total = 400) {
  return {
    data: { items: ids.map(row), offset: page * LIST_PAGE, total, revision },
    isError: false,
    error: null,
  } as unknown as UseQueryResult<Page<EntryRow>>;
}

const pending = { data: undefined, isError: false, error: null } as unknown as UseQueryResult<Page<EntryRow>>;

describe('combinePages', () => {
  it('is pending until a page arrives, with placeholders keyed by index', () => {
    const list = combinePages([0], [pending]);
    expect(list).toMatchObject({ status: 'pending', total: undefined, error: null });
    expect(list.rowAt(3)).toBeUndefined();
    expect(list.rowKey(3)).toBe('placeholder:3');
  });

  it('reads rows by index from their page, keyed by id', () => {
    const page1 = Array.from({ length: 5 }, (_, index) => `b${String(index)}`);
    const list = combinePages([0, 1], [loaded(0, 4, ['a0', 'a1']), loaded(1, 4, page1)]);
    expect(list.status).toBe('success');
    expect(list.rowAt(1)?.id).toBe('a1');
    expect(list.rowAt(LIST_PAGE + 2)?.id).toBe('b2');
    expect(list.rowKey(LIST_PAGE + 2)).toBe('b2');
    expect(list.rowAt(2)).toBeUndefined();
  });

  it('takes the total and revision from the newest page, across the wrap at 2³²', () => {
    const list = combinePages([0, 1], [loaded(0, 0xffff_ffff, ['a'], 300), loaded(1, 2, ['b'], 250)]);
    expect(list).toMatchObject({ total: 250, revision: 2 });
  });

  it('while two revisions are on screen, shows a row only where the newer page has it', () => {
    // A row was inserted above: `m` moved from page 1 (old) to the end of page 0 (new).
    const list = combinePages([0, 1], [loaded(0, 5, ['a', 'm']), loaded(1, 4, ['m', 'z'])]);
    expect(list.rowAt(1)?.id).toBe('m');
    expect(list.rowAt(LIST_PAGE)).toBeUndefined();
    expect(list.rowKey(LIST_PAGE)).toBe(`placeholder:${String(LIST_PAGE)}`);
    expect(list.rowAt(LIST_PAGE + 1)?.id).toBe('z');
  });

  it('is in error when a visible page failed, and retries only the failed ones', () => {
    const refetch = vi.fn();
    const failed = { data: undefined, isError: true, error: new Error('x'), refetch };
    const other = { ...loaded(0, 1, ['a']), refetch: vi.fn() };
    const list = combinePages([0, 1], [other, failed as unknown as UseQueryResult<Page<EntryRow>>]);
    expect(list.status).toBe('error');
    list.retry();
    expect(refetch).toHaveBeenCalledOnce();
    expect(other.refetch).not.toHaveBeenCalled();
  });
});

describe('usePagedList', () => {
  it('fetches page 0 and the visible pages, and fetches ahead without watching', async () => {
    const { shell, result, rerender } = renderAppHook(
      (range: RowRange) => {
        const list = useFiles(null, NO_FILTER, NAME, range);
        return { total: list.total, row: list.rowAt(range.start), before: list.rowAt(range.start - 1), list };
      },
      { scenario: 'large', now: NOW, initialProps: { start: 0, end: 20 } },
    );
    await waitFor(() => {
      expect(result.current.row).toBeDefined();
    });
    const invoke = vi.spyOn(shell, 'invoke');
    const offsets = () =>
      invoke.mock.calls
        .filter(([command]) => command === 'list_files')
        .map(([, payload]) => (payload as { request: { page: { offset: number } } }).request.page.offset);

    // Jump: only the pages around row 30,000 load, not those between.
    rerender({ start: 30_000, end: 30_020 });
    await waitFor(() => {
      expect(result.current.row).toBeDefined();
    });
    await waitFor(() => {
      expect(offsets().sort((a, b) => a - b)).toEqual([29_800, 30_000]);
    });
    // Page 149 was fetched ahead, but only what the range shows is read.
    expect(result.current.before).toBeUndefined();
    expect(result.current.list.rowKey(30_000)).toBe(result.current.row?.id);
    expect(result.current.total).toBeGreaterThan(30_020);

    // Scrolling up into it needs no request.
    rerender({ start: 29_990, end: 30_010 });
    await waitFor(() => {
      expect(result.current.row).toBeDefined();
    });
    expect(offsets()).toHaveLength(2);
  });

  it('asks only for the pages where a dragged scroll bar rests', async () => {
    const { shell, result, rerender } = renderAppHook(
      (range: RowRange) => useFiles(null, NO_FILTER, NAME, range).rowAt(range.start),
      { scenario: 'large', now: NOW, initialProps: { start: 0, end: 20 } },
    );
    await waitFor(() => {
      expect(result.current).toBeDefined();
    });
    const invoke = vi.spyOn(shell, 'invoke');

    // One range per frame, through 150 pages' worth of rows.
    for (let start = 1_000; start <= 30_000; start += 200) rerender({ start, end: start + 20 });

    await waitFor(() => {
      expect(result.current).toBeDefined();
    });
    const pages = invoke.mock.calls.filter(([command]) => command === 'list_files');
    expect(pages.length).toBeLessThanOrEqual(3);
  });

  it('shows the error of a page, and fetches it again on retry', async () => {
    const { shell, result } = renderAppHook(
      () => {
        const { status, error, retry, total } = useChildren(null, NAME, { start: 0, end: 20 });
        return { status, error, retry, total };
      },
      { now: NOW, fail: [{ command: 'list_children', code: 'Internal' }] },
    );
    await waitFor(() => {
      expect(result.current.status).toBe('error');
    });
    expect(result.current.error?.error.code).toBe('Internal');

    shell.setFailure('list_children', null);
    result.current.retry();
    await waitFor(() => {
      expect(result.current.status).toBe('success');
    });
    expect(result.current.total).toBe(5);
  });
});

describe('useCount', () => {
  it('counts with a page of limit 0', async () => {
    const { result } = renderAppHook(
      () => {
        const { data } = useCount({ of: 'files', scope: null, filter: { tags: { kind: 'untagged' }, addedAfterMs: null } });
        return data;
      },
      { now: NOW },
    );
    await waitFor(() => {
      expect(result.current).toBeGreaterThan(0);
    });
  });
});
