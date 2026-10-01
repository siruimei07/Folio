// Paged lists (docs/specs/ui-architecture.md §5.3): a virtualised list asks for the pages its
// visible rows need, one query per page of 200, and jumps anywhere without loading what lies
// between. Page 0 is always asked for, because every page carries the list's `total`.
import {
  hashKey,
  noop,
  type QueryKey,
  queryOptions,
  skipToken,
  useQueries,
  useQuery,
  useQueryClient,
  type UseQueryResult,
} from '@tanstack/react-query';
import { useCallback, useEffect, useEffectEvent, useMemo, useRef, useState } from 'react';

import { type EntrySort, ipc, type Page, type PageRequest } from '../ipc';
import { isOlderRevision } from '../lib/revision';
import { PAGE_GC_TIME } from './client';
import { type IpcFailure, type IpcResult, unwrap } from './errors';
import { type CountRequest, keys, libraryQuery } from './keys';
import { useLibraryId } from './session';

/** Rows per page (at most `LIMITS.pageSize`). */
export const LIST_PAGE = 200;

/** Pages this many rows beyond the visible ones are fetched ahead of scrolling. */
export const PREFETCH_ROWS = 50;

/** While the visible rows keep moving, pages are asked for at most this often. */
export const RANGE_SETTLE_MS = 100;

/** The rows a virtualiser renders, first and last included (its overscan counts as visible). */
export interface RowRange {
  start: number;
  end: number;
}

export interface PagedList<T> {
  /** Rows in the whole list, from the newest page; `undefined` until a page arrives. */
  total: number | undefined;
  /** The row at `index`, or `undefined` while its page is not loaded: render a placeholder. */
  rowAt: (index: number) => T | undefined;
  /** The React key of the row at `index`: its id, which renames and moves keep. */
  rowKey: (index: number) => string;
  /** `error` when a visible page failed; `pending` until the first page arrives. */
  status: 'pending' | 'error' | 'success';
  error: IpcFailure | null;
  /** The catalog revision of the newest page. */
  revision: number | undefined;
  /** Fetches the pages that failed again. */
  retry: () => void;
}

/**
 * A list of `usePagedList`, which can also load any page as the list caches it: a selection over
 * rows nobody shows (UI architecture §7.2). The page rejects with an `IpcFailure`.
 */
export interface LoadingPagedList<T> extends PagedList<T> {
  loadPage: (page: number) => Promise<Page<T>>;
}

export interface PagedListOptions {
  /** `false` while the list cannot be asked for, such as before a library is open. */
  enabled?: boolean;
  /** How long pages nobody shows stay cached. */
  gcTime?: number;
}

type FetchPage<T> = (page: PageRequest) => Promise<IpcResult<Page<T>>>;

/** The pages that hold the rows of `range` widened by `margin`, within `total` when known. */
export function pagesOf(range: RowRange, margin: number, total?: number): number[] {
  const start = Math.max(0, range.start - margin);
  const end = total === undefined ? range.end + margin : Math.min(range.end + margin, total - 1);
  if (end < start) return [];
  const pages: number[] = [];
  for (let page = Math.floor(start / LIST_PAGE); page <= Math.floor(end / LIST_PAGE); page++) {
    pages.push(page);
  }
  return pages;
}

/** The query of one page of a list; lists that show several lists at once build theirs with it. */
export function pageQuery<T>(
  listKey: QueryKey,
  page: number,
  fetchPage: FetchPage<T>,
  enabled: boolean,
  gcTime = PAGE_GC_TIME,
) {
  return queryOptions({
    queryKey: [...listKey, page],
    queryFn: enabled
      ? () => unwrap(fetchPage({ offset: page * LIST_PAGE, limit: LIST_PAGE }))
      : skipToken,
    gcTime,
  });
}

/**
 * Reads the visible pages of a list. Rows are keyed by entry id. While pages of two revisions
 * are both on screen (a refetch is under way), a row that the newer pages already hold is a
 * placeholder in the older one, so no id appears twice.
 */
export function combinePages<T extends { id: string }>(
  pages: readonly number[],
  results: readonly UseQueryResult<Page<T>>[],
): PagedList<T> {
  const loaded = new Map<number, Page<T>>();
  let newest: Page<T> | undefined;
  results.forEach((result, index) => {
    const page = pages[index];
    if (page === undefined || result.data === undefined) return;
    loaded.set(page, result.data);
    if (newest === undefined || isOlderRevision(newest.revision, result.data.revision)) {
      newest = result.data;
    }
  });
  const fresh = new Set<string>();
  for (const page of loaded.values()) {
    if (page.revision === newest?.revision) for (const row of page.items) fresh.add(row.id);
  }
  const rowAt = (index: number): T | undefined => {
    const page = loaded.get(Math.floor(index / LIST_PAGE));
    const row = page?.items[index % LIST_PAGE];
    if (row === undefined || page === undefined) return undefined;
    return page.revision === newest?.revision || !fresh.has(row.id) ? row : undefined;
  };
  const failed = results.find((result) => result.isError);
  return {
    total: newest?.total,
    rowAt,
    rowKey: (index) => rowAt(index)?.id ?? `placeholder:${String(index)}`,
    status: failed ? 'error' : newest === undefined ? 'pending' : 'success',
    error: failed?.error ?? null,
    revision: newest?.revision,
    retry: () => {
      for (const result of results) if (result.isError) void result.refetch();
    },
  };
}

/**
 * The range pages are asked for: the latest `range`, but at most one change every
 * `RANGE_SETTLE_MS`, and the last one always lands. Dragging the scroll bar to row 40,000 asks
 * for the pages where the list rests, not for every page it passes (§8.1).
 */
export function useSettledRange(range: RowRange | null): RowRange | null {
  const [settled, setSettled] = useState(range);
  const changedAt = useRef(0);
  const settle = useEffectEvent(() => {
    changedAt.current = Date.now();
    setSettled(range);
  });
  const rangeKey = range === null ? '' : `${String(range.start)}:${String(range.end)}`;
  useEffect(() => {
    const timer = setTimeout(settle, Math.max(0, changedAt.current + RANGE_SETTLE_MS - Date.now()));
    return () => {
      clearTimeout(timer);
    };
  }, [rangeKey]);
  return settled;
}

/**
 * The pages of one list of the open library that `range` shows, plus page 0. Pages within
 * `PREFETCH_ROWS` of the range are fetched ahead but not watched, so a refresh leaves them to be
 * fetched again. `listKey` builds the list's key for a library id (`keys.children`, …).
 */
export function usePagedList<T extends { id: string }>(
  listKey: (libraryId: string) => QueryKey,
  fetchPage: FetchPage<T>,
  visibleRange: RowRange | null,
  options: PagedListOptions = {},
): LoadingPagedList<T> {
  const client = useQueryClient();
  const libraryId = useLibraryId();
  const enabled = libraryId !== null && options.enabled !== false;
  const key = listKey(libraryId ?? '');
  const listHash = hashKey(key);
  const range = useSettledRange(visibleRange);
  const visible = range === null ? [0] : [...new Set([0, ...pagesOf(range, 0)])];
  const visibleHash = visible.join(',');
  const pages = useMemo(() => visibleHash.split(',').map(Number), [visibleHash]);
  const combine = useCallback(
    (results: UseQueryResult<Page<T>>[]) => combinePages(pages, results),
    [pages],
  );
  const list = useQueries({
    queries: pages.map((page) => pageQuery(key, page, fetchPage, enabled, options.gcTime)),
    combine,
  });

  const ahead =
    range === null || !enabled
      ? []
      : pagesOf(range, PREFETCH_ROWS, list.total).filter((page) => !pages.includes(page));
  const aheadHash = ahead.join(',');
  const prefetch = useEffectEvent(() => {
    // Cached pages are not asked for again; a failure shows once the page is visible.
    for (const page of ahead) {
      client.query(pageQuery(key, page, fetchPage, enabled, options.gcTime)).catch(noop);
    }
  });
  useEffect(() => {
    prefetch();
  }, [listHash, aheadHash]);

  // The list keeps its identity while its pages do, so what is built from it stays memoised.
  const source = useRef({ key, fetchPage, enabled, gcTime: options.gcTime });
  useEffect(() => {
    source.current = { key, fetchPage, enabled, gcTime: options.gcTime };
  });
  const loadPage = useCallback(
    (page: number) => {
      const { key: latest, fetchPage: fetch, enabled: on, gcTime } = source.current;
      return client.query(pageQuery(latest, page, fetch, on, gcTime));
    },
    [client],
  );
  return useMemo(
    () => ({
      total: list.total,
      rowAt: list.rowAt,
      rowKey: list.rowKey,
      status: list.status,
      error: list.error,
      revision: list.revision,
      retry: list.retry,
      loadPage,
    }),
    [list, loadPage],
  );
}

const COUNT_SORT: EntrySort = { key: 'name', descending: false };
const COUNT_PAGE: PageRequest = { offset: 0, limit: 0 };

function countPage(request: CountRequest): Promise<IpcResult<Page<unknown>>> {
  switch (request.of) {
    case 'children':
      return ipc.listChildren({ folder: request.folder, sort: COUNT_SORT, page: COUNT_PAGE });
    case 'files':
      return ipc.listFiles({
        scope: request.scope,
        filter: request.filter,
        sort: COUNT_SORT,
        page: COUNT_PAGE,
      });
    case 'problems':
      return ipc.listProblems({ page: COUNT_PAGE });
  }
}

/** How many rows a list has: a page with `limit: 0` (quick views, course and folder counts). */
export function useCount(request: CountRequest) {
  return useQuery(
    libraryQuery(
      useLibraryId(),
      (libraryId) => keys.count(libraryId, request),
      async () => (await unwrap(countPage(request))).total,
    ),
  );
}
