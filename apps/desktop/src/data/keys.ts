// Query keys (docs/specs/ui-architecture.md §5.2). This file is the only place that builds them,
// and `readKey` is the only place that reads them back, for the CatalogChanged predicates in
// `touch.ts`. Every key of a library starts with `['lib', libraryId]`, so a library switch drops
// them all at once and no page of one library answers a query of another.
//
// A lane that adds a kind of query adds its builder here, its case to `LibraryQuery` and
// `readKey`, and its rule to `touch.ts`. Until then an unknown kind is touched by every change.
import { type QueryKey, queryOptions, skipToken } from '@tanstack/react-query';

import type { EntryFilter, EntryRef, EntrySort } from '../ipc';

/** One folder's children: `list_children` (`null`: the library root). */
export interface ChildrenList {
  folder: EntryRef | null;
  sort: EntrySort;
}

/** Files at any depth below a folder: `list_files` (`null`: the whole library). */
export interface FilesList {
  scope: EntryRef | null;
  filter: EntryFilter;
  sort: EntrySort;
}

/** A search: an infinite query of pages. */
export interface SearchList {
  text: string;
  scope: EntryRef | null;
}

/** What a count (a page request with `limit: 0`) counts. */
export type CountRequest =
  | { of: 'children'; folder: EntryRef | null }
  | { of: 'files'; scope: EntryRef | null; filter: EntryFilter }
  | { of: 'problems' };

/** Paths a note names, each resolved against the note's folder: `resolve_paths`. */
interface ResolveRequest {
  base: EntryRef;
  paths: readonly string[];
}

/** What adding a chosen source to a folder would do: `check_import`. */
interface ImportCheckRequest {
  source: string;
  target: EntryRef;
}

export const keys = {
  /** `library_status`; outside a library, like the App settings. */
  libraryStatus: () => ['app', 'libraryStatus'] as const,
  /** `get_app_settings`: this computer's settings, whatever library is open (ipc-m1 §22.1). */
  appSettings: () => ['app', 'appSettings'] as const,
  /** Every query of every library. */
  libraries: () => ['lib'] as const,
  /** Every query of one library. */
  library: (libraryId: string) => ['lib', libraryId] as const,
  /** Pages of a folder's children; `usePagedList` appends the page index. */
  children: (libraryId: string, list: ChildrenList) =>
    ['lib', libraryId, 'children', list] as const,
  /** Pages of files; `usePagedList` appends the page index. */
  files: (libraryId: string, list: FilesList) => ['lib', libraryId, 'files', list] as const,
  count: (libraryId: string, request: CountRequest) =>
    ['lib', libraryId, 'count', request.of, request] as const,
  search: (libraryId: string, list: SearchList) => ['lib', libraryId, 'search', list] as const,
  /**
   * One entry by reference. The spec keys it by id; the key holds the whole reference because
   * the query function needs the path too, and a key whose path is stale must not be refetched
   * under the same key after a move (the reference followers give the holder the new path).
   */
  entry: (libraryId: string, entry: EntryRef) => ['lib', libraryId, 'entry', entry] as const,
  semesters: (libraryId: string) => ['lib', libraryId, 'semesters'] as const,
  /** The courses of every semester; one semester's are a selection of them (`groups.ts`). */
  courses: (libraryId: string) => ['lib', libraryId, 'courses'] as const,
  tags: (libraryId: string) => ['lib', libraryId, 'tags'] as const,
  resolve: (libraryId: string, request: ResolveRequest) =>
    ['lib', libraryId, 'resolve', request] as const,
  importCheck: (libraryId: string, request: ImportCheckRequest) =>
    ['lib', libraryId, 'importCheck', request] as const,
  jobs: (libraryId: string) => ['lib', libraryId, 'jobs'] as const,
  /** Pages of problems; `usePagedList` appends the page index. */
  problems: (libraryId: string) => ['lib', libraryId, 'problems'] as const,
  /** The library's `.folio/ignore` (ipc-m1 §22.2). */
  ignoreRules: (libraryId: string) => ['lib', libraryId, 'ignoreRules'] as const,
  /** `get_ai_settings`: this computer's, like the App settings (ipc-m2 §12.1). Never the key. */
  aiSettings: () => ['app', 'aiSettings'] as const,
};

/** The reference in the key of a query that asks for nothing (it has no entry yet). */
export const NO_ENTRY: EntryRef = { id: '', path: '' };

/**
 * A query of the open library (`libraryId`): keyed under it, and asking nothing while none is
 * open. Every library hook goes through this or `usePagedList`, so none asks the shell for a
 * library that is not there.
 */
export function libraryQuery<T, Key extends QueryKey>(
  libraryId: string | null,
  key: (libraryId: string) => Key,
  fetch: () => Promise<T>,
) {
  return queryOptions({
    queryKey: key(libraryId ?? ''),
    queryFn: libraryId === null ? skipToken : fetch,
  });
}

/** A library query, read back from its key. */
export type LibraryQuery =
  | { kind: 'children'; folder: EntryRef | null }
  | { kind: 'files'; scope: EntryRef | null }
  | { kind: 'count'; request: CountRequest }
  | { kind: 'search'; scope: EntryRef | null }
  | { kind: 'entry'; entry: EntryRef }
  | { kind: 'semesters' }
  | { kind: 'courses' }
  | { kind: 'tags' }
  | { kind: 'resolve'; base: EntryRef }
  | { kind: 'importCheck'; target: EntryRef }
  | { kind: 'jobs' }
  | { kind: 'problems' }
  | { kind: 'ignoreRules' }
  | { kind: 'unknown' };

/** The query a library key names. Keys come only from `keys`, so their shapes are known. */
export function readKey(queryKey: QueryKey): LibraryQuery {
  const kind = queryKey[2];
  const detail = queryKey[3];
  switch (kind) {
    case 'children':
      return { kind, folder: (detail as ChildrenList).folder };
    case 'files':
      return { kind, scope: (detail as FilesList).scope };
    case 'count':
      return { kind, request: queryKey[4] as CountRequest };
    case 'search':
      return { kind, scope: (detail as SearchList).scope };
    case 'entry':
      return { kind, entry: detail as EntryRef };
    case 'resolve':
      return { kind, base: (detail as ResolveRequest).base };
    case 'importCheck':
      return { kind, target: (detail as ImportCheckRequest).target };
    case 'semesters':
    case 'courses':
    case 'tags':
    case 'jobs':
    case 'problems':
    case 'ignoreRules':
      return { kind };
    default:
      return { kind: 'unknown' };
  }
}
