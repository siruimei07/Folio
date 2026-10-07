// The history (docs/specs/ipc-m2.md §8, §10; handoff workspace-history §7–§9): the timeline, a
// commit's changes, one file's history, the first commit, restore plans, and the commands that
// change the history. Lists are infinite queries read a page at a time, newest first, as the view
// scrolls or a card shows more; each page answers with the list's total.
//
// Freshness (`events.ts`, `touch.ts`): HistoryChanged refreshes every query here; CatalogChanged
// touches only file histories and restore plans, which follow the files, and WorkspaceChanged
// refreshes those two again once the files' hashes are known. A refresh reads every page shown
// again, from the first, so the pages agree once it settles.
import {
  type InfiniteData,
  type Query,
  type QueryKey,
  skipToken,
  useInfiniteQuery,
  useIsFetching,
  useQuery,
} from '@tanstack/react-query';
import { useCallback, useState } from 'react';

import {
  type ChangeRow,
  type CommitInfo,
  type FileRef,
  type FileVersion,
  type HistoryItem,
  type HistoryType,
  ipc,
  type MetadataChange,
  type Page,
  type RewordCommit,
  type Uncommit,
  type VersionRef,
} from '../ipc';
import { PAGE_GC_TIME } from './client';
import { type IpcFailure, unwrap } from './errors';
import { keys, libraryQuery, readKey } from './keys';
import { useCommandMutation } from './mutations';
import { useLibraryId } from './session';

/** Entries per page of the timeline and of a file's history. */
export const HISTORY_PAGE = 100;

/** Rows per page of a commit's changes, after the four its card shows first (handoff §7.2). */
export const CHANGES_PAGE = 200;

/** The reference in the key of a file history that asks for nothing. */
const NO_FILE: FileRef = { kind: 'version', commit: '', path: '' };

/** The reference in the key of a restore plan that asks for nothing. */
const NO_VERSION: VersionRef = { commit: '', path: '' };

/** A timeline entry's identity, for React keys and the view's selection. */
export function historyItemKey(item: HistoryItem): string {
  return item.kind === 'commit' ? `commit ${item.commit.id}` : `${item.kind} ${item.id}`;
}

/** An entry of a file's history: its commit, which has one row of the file, or the restore. */
export function fileVersionKey(version: FileVersion): string {
  return version.kind === 'commit' ? `commit ${version.commit.id}` : `restore ${version.id}`;
}

/** `types` sorted and each once, so equal filters share a query; `null` shows every type. */
function exactTypes(types: readonly HistoryType[] | null): HistoryType[] | null {
  return types === null ? null : [...new Set(types)].sort();
}

/** Only the fields of a reference, so an object with more of them keys the same query. */
function exactFile(file: FileRef): FileRef {
  return file.kind === 'entry'
    ? { kind: 'entry', entry: { id: file.entry.id, path: file.entry.path } }
    : { kind: 'version', commit: file.commit, path: file.path };
}

/** Where the page after `page` starts; `undefined` at the end of the list. */
export function nextPageOffset(page: Page<unknown>): number | undefined {
  const next = page.offset + page.items.length;
  return page.items.length > 0 && next < page.total ? next : undefined;
}

interface Flattened<T> {
  items: T[];
  total: number;
}

/**
 * The entries of the pages in order, each once: an entry a change moved onto the next page
 * between two reads is not shown twice until the refresh that follows the change settles.
 */
function flatten<T>(pages: readonly Page<T>[], keyOf: (item: T) => string): Flattened<T> {
  const seen = new Set<string>();
  const items: T[] = [];
  for (const page of pages) {
    for (const item of page.items) {
      const key = keyOf(item);
      if (seen.has(key)) continue;
      seen.add(key);
      items.push(item);
    }
  }
  return { items, total: pages.at(-1)?.total ?? 0 };
}

type Pages<T> = InfiniteData<Page<T>, number>;

/** The entries of a list with none read yet, the same array each time. */
const NO_ITEMS: readonly never[] = [];

// One function per list, so each select keeps its identity and runs only when the pages change.
const selectTimeline = (data: Pages<HistoryItem>) => flatten(data.pages, historyItemKey);
const selectFileHistory = (data: Pages<FileVersion>) => flatten(data.pages, fileVersionKey);
const selectChanges = (data: Pages<ChangeRow>) => flatten(data.pages, (row) => row.key);
const selectMetadata = (data: Pages<MetadataChange>) => flatten(data.pages, (change) => change.key);

/** A list read a page at a time: the timeline, a file's history, a commit's changes. */
export interface HistoryPages<T> {
  /** The entries of the pages read so far, in the list's order, each once. */
  items: readonly T[];
  /** Entries in the whole list, as the latest page counted them; `undefined` before the first. */
  total: number | undefined;
  /** `idle` while nothing is asked: no library, no file, or a card that shows only its first rows. */
  status: 'idle' | 'pending' | 'error' | 'success';
  /** Why the latest read failed: the first page, a refresh, or the next page (`items` stay). */
  error: IpcFailure | null;
  /** More entries follow; `loadMore` reads the next page. */
  hasMore: boolean;
  isLoadingMore: boolean;
  /**
   * A read is under way: the first page, a refresh or the next page. A refresh cancels a next page
   * it overtakes, so whatever waits for the next page asks again once this turns false.
   */
  isFetching: boolean;
  /** The latest error is the next page's: the pages read so far are as they were. */
  loadMoreFailed: boolean;
  /** Reads the next page; joins a read under way, and asks nothing at the end or after an error. */
  loadMore: () => void;
  /** Asks again after an error: the next page when that is what failed, else every page. */
  retry: () => void;
}

/**
 * One list of the history; `fetchPage` reads the page at an offset, `null` when there is nothing to
 * ask (no library, no file), and `enabled` false asks nothing for now (a card that shows only its
 * first rows). A query that waits is `enabled: false`, never only `skipToken`: TanStack counts a
 * `skipToken` observer as active, so a refresh of a query two observers share would refetch it with
 * the waiting one's `skipToken`, and fail.
 */
function useHistoryPages<T>(
  queryKey: QueryKey,
  fetchPage: ((offset: number) => Promise<Page<T>>) | null,
  select: (data: Pages<T>) => Flattened<T>,
  enabled = true,
): HistoryPages<T> {
  const asks = fetchPage !== null && enabled;
  const result = useInfiniteQuery({
    queryKey,
    queryFn: fetchPage === null ? skipToken : ({ pageParam }) => fetchPage(pageParam),
    enabled: asks,
    initialPageParam: 0,
    getNextPageParam: nextPageOffset,
    // Like a list's pages: a list nobody shows goes, so a long history read to its start does not stay.
    gcTime: PAGE_GC_TIME,
    select,
  });
  const { error, isError, hasNextPage, fetchNextPage, refetch, isFetchNextPageError } = result;
  // TanStack forgets that the error is the next page's once a refresh starts (its read has no
  // `fetchMore` mark), while the error itself stays until a read succeeds: the error a next page
  // failed with is kept, so a refresh meanwhile does not read as a failed refresh until it fails.
  const [nextPageError, setNextPageError] = useState<IpcFailure | null>(null);
  if (isFetchNextPageError && error !== nextPageError) setNextPageError(error);
  const nextPageFailed = isError && (isFetchNextPageError || error === nextPageError);
  // A card that shows only its first rows again keeps the pages it read for a while, unshown.
  const data = asks ? result.data : undefined;
  const hasMore = asks && hasNextPage;
  const loadMore = useCallback(() => {
    // A failed page waits for `retry`, so a list scrolled to its end does not ask again and again.
    if (hasMore && !isError) void fetchNextPage({ cancelRefetch: false });
  }, [hasMore, isError, fetchNextPage]);
  const retry = useCallback(() => {
    void (isFetchNextPageError ? fetchNextPage() : refetch());
  }, [isFetchNextPageError, fetchNextPage, refetch]);
  return {
    items: data?.items ?? NO_ITEMS,
    total: data?.total,
    status: !asks ? 'idle' : isError ? 'error' : data === undefined ? 'pending' : 'success',
    error: asks ? error : null,
    hasMore,
    isLoadingMore: asks && result.isFetchingNextPage,
    isFetching: asks && result.isFetching,
    loadMoreFailed: asks && nextPageFailed,
    loadMore,
    retry,
  };
}

/** The timeline of the open library, newest first (ipc-m2 §8.1); `types` `null` shows every type. */
export function useHistoryTimeline(types: readonly HistoryType[] | null): HistoryPages<HistoryItem> {
  const libraryId = useLibraryId();
  const list = { types: exactTypes(types) };
  return useHistoryPages(
    keys.history(libraryId ?? '', list),
    libraryId === null
      ? null
      : (offset) => unwrap(ipc.listHistory({ page: { offset, limit: HISTORY_PAGE }, types: list.types })),
    selectTimeline,
  );
}

/**
 * A commit's changed files and folders past its card's first four (ipc-m2 §8.2), `CHANGES_PAGE`
 * a page: read once `enabled` ("Show all N files").
 */
export function useCommitChanges(commit: string, enabled: boolean): HistoryPages<ChangeRow> {
  const libraryId = useLibraryId();
  return useHistoryPages(
    keys.commitChanges(libraryId ?? '', commit),
    libraryId === null
      ? null
      : (offset) => unwrap(ipc.listCommitChanges({ commit, page: { offset, limit: CHANGES_PAGE } })),
    selectChanges,
    enabled,
  );
}

/**
 * A commit's tag and settings changes (ipc-m2 §8.2), the rows after its files in the card (plan
 * decision B2): read once `enabled`, `CHANGES_PAGE` a page.
 */
export function useCommitMetadata(commit: string, enabled: boolean): HistoryPages<MetadataChange> {
  const libraryId = useLibraryId();
  return useHistoryPages(
    keys.commitMetadata(libraryId ?? '', commit),
    libraryId === null
      ? null
      : (offset) => unwrap(ipc.listCommitMetadata({ commit, page: { offset, limit: CHANGES_PAGE } })),
    selectMetadata,
    enabled,
  );
}

/**
 * One file's history, newest first (ipc-m2 §8.3): a file of the library or of the Changes list
 * (`entry`), or a row of a commit (`version`). `file` `null` asks for nothing. A file no commit
 * holds yet has none: an empty list.
 */
export function useFileHistory(
  file: FileRef | null,
  types: readonly HistoryType[] | null,
): HistoryPages<FileVersion> {
  const libraryId = useLibraryId();
  const list = { file: file === null ? NO_FILE : exactFile(file), types: exactTypes(types) };
  return useHistoryPages(
    keys.fileHistory(libraryId ?? '', list),
    libraryId === null || file === null
      ? null
      : (offset) =>
          unwrap(
            ipc.listFileHistory({ file: list.file, page: { offset, limit: HISTORY_PAGE }, types: list.types }),
          ),
    selectFileHistory,
  );
}

/**
 * A version's own row (ipc-m2 §8.3): the commit entries of the file's history from the version, read
 * until the version's commit, whose `change` is the file's row in it; `null` when none of them is
 * that commit. Newer commits of the same file at most come before it, so one page nearly always
 * holds it, however many files the commit changed.
 */
async function fetchVersionChange(version: VersionRef): Promise<ChangeRow | null> {
  const file: FileRef = { kind: 'version', commit: version.commit, path: version.path };
  let offset: number | undefined = 0;
  while (offset !== undefined) {
    const page = await unwrap(ipc.listFileHistory({ file, page: { offset, limit: HISTORY_PAGE }, types: ['commit'] }));
    const own = page.items.find((entry) => entry.kind === 'commit' && entry.commit.id === version.commit);
    if (own?.kind === 'commit') return own.change;
    offset = nextPageOffset(page);
  }
  return null;
}

/**
 * The row of `version` in its commit, for a restore's card (plan decision 11): `null` when the
 * commit no longer has it, `NotFound` once the commit is gone (undone, or a message edit gave it a
 * new id). A commit's rows never change under its id, so HistoryChanged refreshes it, which
 * also says when its commit has gone, and the files' events do not.
 */
export function useVersionChange(version: VersionRef) {
  const libraryId = useLibraryId();
  const target = { commit: version.commit, path: version.path };
  return useQuery(
    libraryQuery(
      libraryId,
      (library) => keys.versionChange(library, target),
      () => fetchVersionChange(target),
    ),
  );
}

/** The timeline's and the file histories' queries. */
const ENTRY_LISTS = {
  predicate: (query: Query) => {
    const { kind } = readKey(query.queryKey);
    return kind === 'history' || kind === 'fileHistory';
  },
};

/**
 * Whether the timeline or a file's history is being read. After a change to the history, an entry
 * may name another commit once the read settles (a message edit gives its commit a new id), so what
 * the entry's commit answers meanwhile (`NotFound` for the old id) may not last.
 */
export function useEntryListsFetching(): boolean {
  return useIsFetching(ENTRY_LISTS) > 0;
}

/** Reads of the commit list before the first commit is taken as found. */
const FIRST_COMMIT_READS = 3;

/**
 * The first commit: the last of the commits newest first, found from their count. A commit made
 * or undone between two reads moves it, and the later read's count says where to look again; a
 * change that keeps moving it is followed by the HistoryChanged that refreshes this.
 */
async function fetchFirstCommit(): Promise<CommitInfo | null> {
  const types: HistoryType[] = ['commit'];
  let total = (await unwrap(ipc.listHistory({ page: { offset: 0, limit: 0 }, types }))).total;
  for (let read = 0; read < FIRST_COMMIT_READS && total > 0; read++) {
    const page = await unwrap(ipc.listHistory({ page: { offset: total - 1, limit: 1 }, types }));
    const last = page.items[0];
    if (last?.kind === 'commit' && last.commit.first) return last.commit;
    total = page.total;
  }
  return null;
}

/**
 * The library's first commit ("Start history"), `null` before it: where one file's history marks
 * "Midterm review.md wasn't in the library yet." (handoff §7.2). Read once `enabled`.
 */
export function useFirstCommit(enabled: boolean) {
  const libraryId = useLibraryId();
  return useQuery(libraryQuery(enabled ? libraryId : null, keys.firstCommit, fetchFirstCommit));
}

/**
 * What restoring `version` would do now (`plan_restore`, ipc-m2 §10), for the confirmation; `null`
 * asks for nothing. Asked afresh each time the dialog opens: nothing keeps a plan nobody shows.
 */
export function useRestorePlan(version: VersionRef | null) {
  const libraryId = useLibraryId();
  const target = version === null ? NO_VERSION : { commit: version.commit, path: version.path };
  return useQuery({
    ...libraryQuery(
      version === null ? null : libraryId,
      (library) => keys.restorePlan(library, target),
      () => unwrap(ipc.planRestore(target)),
    ),
    gcTime: 0,
  });
}

/**
 * Restores a version as an uncommitted change (ipc-m2 §10); resolves to where it went. It never
 * rewrites history: HistoryChanged (the restore entry) and WorkspaceChanged (the change) follow.
 */
export function useRestoreVersion() {
  return useCommandMutation(
    (version: VersionRef) => ipc.restoreVersion({ commit: version.commit, path: version.path }),
    { history: true },
  );
}

/** Edits a commit's message (ipc-m2 §8.4); resolves to the commit's new id. */
export function useRewordCommit() {
  return useCommandMutation((request: RewordCommit) => ipc.rewordCommit(request), { history: true });
}

/** Takes back the newest commit (ipc-m2 §8.4); `NotHead` refreshes the history. */
export function useUncommit() {
  return useCommandMutation((request: Uncommit) => ipc.uncommit(request), { history: true });
}

/**
 * A commit as the shell has it now (`get_commit`, ipc-m2 §8.1), for an action that holds only its
 * id, such as the toast after a commit (handoff §4.3, "Edit message"). Rejects with an
 * `IpcFailure`; `NotFound` once a later edit or undo replaced it.
 */
export function readCommitNow(commit: string): Promise<CommitInfo> {
  return unwrap(ipc.getCommit({ commit }));
}
