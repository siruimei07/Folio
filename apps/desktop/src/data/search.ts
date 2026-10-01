// Search (docs/specs/ipc-m1.md §10; ui-architecture §9): an infinite query of pages of 50 over the
// shell's fixed window of the best `LIMITS.searchResults` matches. The shell ranks that window
// once per revision, so pages of one revision never overlap or skip. A page read at another
// revision than the first page may, so it is dropped with the pages after it, and the first page
// is asked again; the list asks for the rest as it needs them. A new text is a new key: a
// superseded answer never shows.
import {
  type InfiniteData,
  keepPreviousData,
  skipToken,
  useInfiniteQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { useCallback, useEffect, useMemo } from 'react';

import { type EntryRef, ipc, LIMITS, type SearchHit, type SearchPage } from '../ipc';
import { charCount } from '../lib/text';
import { PAGE_GC_TIME } from './client';
import { IpcFailure, unwrap } from './errors';
import { keys } from './keys';
import { useLibraryId } from './session';

/** Hits per page. */
export const SEARCH_PAGE = 50;

/** Where the page after `page` starts; `undefined` at the end of the matches or of the window. */
export function nextOffset(page: SearchPage): number | undefined {
  const next = page.offset + page.items.length;
  return page.more && page.items.length > 0 && next < LIMITS.searchResults ? next : undefined;
}

async function searchPage(text: string, scope: EntryRef | null, offset: number) {
  // The shell checks the length before anything else (ipc-m1 §10); so does the UI, without asking.
  if (charCount(text) > LIMITS.queryChars) {
    throw new IpcFailure({
      code: 'QueryTooLong',
      detail: `the search text is over ${String(LIMITS.queryChars)} characters`,
    });
  }
  const limit = Math.min(SEARCH_PAGE, LIMITS.searchResults - offset);
  return unwrap(ipc.search({ text, scope, page: { offset, limit } }));
}

interface SearchHits {
  /** The hits of the pages read at the first page's revision, in rank order. */
  hits: SearchHit[];
  /** `false` when a later page was read at another revision and was left out. */
  consistent: boolean;
}

/** Joins the pages of one revision; a page of another revision ends the list. */
export function combineHits(pages: readonly SearchPage[]): SearchHits {
  const revision = pages[0]?.revision;
  const hits: SearchHit[] = [];
  for (const page of pages) {
    if (page.revision !== revision) return { hits, consistent: false };
    hits.push(...page.items);
  }
  return { hits, consistent: true };
}

type SearchPages = InfiniteData<SearchPage, number>;

const selectHits = (data: SearchPages) => combineHits(data.pages);

/** The first page only: the one to ask again when later pages are of another revision. */
const firstPage = (data: SearchPages | undefined) =>
  data && { pages: data.pages.slice(0, 1), pageParams: data.pageParams.slice(0, 1) };

export interface SearchResults {
  /** Hits in rank order; the handoff's "File names" group holds those with a matched name span. */
  hits: SearchHit[];
  /** `idle` while there is no text or no library: nothing is asked. */
  status: 'idle' | 'pending' | 'error' | 'success';
  /** `QueryTooLong` for text over `LIMITS.queryChars`, found without asking the shell. */
  error: IpcFailure | null;
  /** The hits are an earlier text's, kept until this text's arrive. */
  isPrevious: boolean;
  /** More hits follow within the window; `loadMore` asks for the next page. */
  hasMore: boolean;
  isLoadingMore: boolean;
  loadMore: () => void;
  /** Asks again after an error. */
  retry: () => void;
}

/**
 * Searches the open library for `text`, trimmed, below `scope` (`null`: everywhere). Callers wait
 * for a pause in typing and skip IME composition (ui-architecture §9).
 */
export function useSearch(text: string, scope: EntryRef | null): SearchResults {
  const libraryId = useLibraryId();
  // A lone surrogate (pasted text) would fail the whole call as `Transport`; it matches nothing.
  const query = text.trim().toWellFormed();
  const enabled = libraryId !== null && query !== '';
  const client = useQueryClient();
  const queryKey = useMemo(
    () => keys.search(libraryId ?? '', { text: query, scope }),
    [libraryId, query, scope],
  );
  const result = useInfiniteQuery({
    queryKey,
    queryFn: enabled ? ({ pageParam }) => searchPage(query, scope, pageParam) : skipToken,
    initialPageParam: 0,
    getNextPageParam: nextOffset,
    // An earlier text's hits, never another library's (§5.2), and none once the text is cleared.
    placeholderData: (previous, previousQuery) =>
      enabled && previousQuery?.queryKey[1] === libraryId ? keepPreviousData(previous) : undefined,
    gcTime: PAGE_GC_TIME,
    select: selectHits,
  });
  const { data, error, isError, isFetching, hasNextPage, fetchNextPage, refetch } = result;

  const mixed = data !== undefined && !data.consistent && !result.isPlaceholderData;
  useEffect(() => {
    // A failed attempt is left to `retry`, so a failing shell is not asked again and again.
    if (!mixed || isFetching || isError) return;
    client.setQueryData<SearchPages>(queryKey, firstPage);
    void refetch();
  }, [mixed, isFetching, isError, client, queryKey, refetch]);

  const hasMore = enabled && hasNextPage && data?.consistent === true;
  const loadMore = useCallback(() => {
    // Joins a fetch under way instead of cancelling it.
    if (hasMore) void fetchNextPage({ cancelRefetch: false });
  }, [hasMore, fetchNextPage]);
  const retry = useCallback(() => {
    void refetch();
  }, [refetch]);
  return {
    hits: enabled ? (data?.hits ?? []) : [],
    status: !enabled ? 'idle' : isError ? 'error' : data === undefined ? 'pending' : 'success',
    error: enabled ? error : null,
    isPrevious: result.isPlaceholderData,
    hasMore,
    isLoadingMore: result.isFetchingNextPage,
    loadMore,
    retry,
  };
}
