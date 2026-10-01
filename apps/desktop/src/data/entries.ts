// Entries (docs/specs/ipc-m1.md §9): folder children and filtered files as paged lists, single
// entries, and the changes the Library view makes. A change answers before its CatalogChanged
// arrives; the event refreshes the lists it touched and moves the references the UI holds
// (`events.ts`), so a row keeps its place until the catalog reports the change.
import { useQueries, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import { useCallback, useRef } from 'react';

import {
  type CreateFolder,
  type DeleteEntries,
  type EntryFilter,
  type EntryRef,
  type EntryRow,
  type EntrySort,
  ipc,
  type MoveEntries,
  type Page,
  type RenameEntry,
} from '../ipc';
import { unwrap } from './errors';
import { keys, libraryQuery, NO_ENTRY } from './keys';
import { useBatchMutation, useCommandMutation } from './mutations';
import {
  combinePages,
  LIST_PAGE,
  type LoadingPagedList,
  type PagedListOptions,
  pageQuery,
  type RowRange,
  usePagedList,
} from './paged';
import { useLibraryId } from './session';

/** The children of a folder (`null`: the library root), folders first. */
export function useChildren(
  folder: EntryRef | null,
  sort: EntrySort,
  range: RowRange | null,
  options?: PagedListOptions,
) {
  return usePagedList(
    (libraryId) => keys.children(libraryId, { folder, sort }),
    (page) => ipc.listChildren({ folder, sort, page }),
    range,
    options,
  );
}

/** One folder of a list that shows several at once, and the pages of it that list needs. */
export interface FolderPages {
  folder: EntryRef;
  /** Page indexes; include page 0, which carries the folder's total. */
  pages: readonly number[];
}

/** One folder's list of `useFolderChildren`: the pages asked for, and which of them failed. */
export interface FolderChildren extends LoadingPagedList<EntryRow> {
  /** Whether the row at `index` is on a page that failed; rows of pages still loading are not. */
  failedAt: (index: number) => boolean;
}

/** What one folder's list was built from: the same pages, data and errors give the same list. */
interface BuiltList {
  pages: readonly number[];
  data: readonly unknown[];
  errors: readonly unknown[];
  list: FolderChildren;
}

function sameItems(a: readonly unknown[], b: readonly unknown[]): boolean {
  return a.length === b.length && a.every((item, index) => item === b[index]);
}

/**
 * The children of several folders at once, one paged list per folder in the order asked: the
 * Library tree, whose expanded folders come and go. Each list holds the pages asked for, under
 * the same keys as `useChildren`, so CatalogChanged refreshes them alike. A folder whose pages
 * did not change keeps its list object, so what is built from it (the tree's layout, its memoised
 * rows) is not built again when another folder's page arrives. Memoise `folders`.
 */
export function useFolderChildren(folders: readonly FolderPages[], sort: EntrySort): FolderChildren[] {
  const client = useQueryClient();
  const libraryId = useLibraryId();
  const enabled = libraryId !== null;
  const pageOf = useCallback(
    (folder: EntryRef, page: number) =>
      pageQuery(
        keys.children(libraryId ?? '', { folder, sort }),
        page,
        (request) => ipc.listChildren({ folder, sort, page: request }),
        enabled,
      ),
    [libraryId, sort, enabled],
  );
  const queries = folders.flatMap(({ folder, pages }) => pages.map((page) => pageOf(folder, page)));
  // Query results are new objects each time `combine` runs; their data and errors are not.
  const built = useRef(new Map<string, BuiltList>());
  const combine = useCallback(
    (results: UseQueryResult<Page<EntryRow>>[]) => {
      const last = built.current;
      const next = new Map<string, BuiltList>();
      let at = 0;
      const lists = folders.map(({ folder, pages }) => {
        const own = results.slice(at, at + pages.length);
        at += pages.length;
        const key = `${folder.id}@${folder.path}`;
        const data = own.map((result) => result.data);
        const errors = own.map((result) => result.error);
        const before = last.get(key);
        if (before !== undefined && sameItems(before.pages, pages) && sameItems(before.data, data) && sameItems(before.errors, errors)) {
          next.set(key, before);
          return before.list;
        }
        const failed = new Set(pages.filter((_, index) => own[index]?.isError === true));
        const list: FolderChildren = {
          ...combinePages(pages, own),
          failedAt: (index) => failed.has(Math.floor(index / LIST_PAGE)),
          loadPage: (page) => client.query(pageOf(folder, page)),
        };
        next.set(key, { pages, data, errors, list });
        return list;
      });
      built.current = next;
      return lists;
    },
    [folders, client, pageOf],
  );
  return useQueries({ queries, combine });
}

/** Files at any depth below `scope` (`null`: the whole library) that pass `filter`. */
export function useFiles(
  scope: EntryRef | null,
  filter: EntryFilter,
  sort: EntrySort,
  range: RowRange | null,
  options?: PagedListOptions,
) {
  return usePagedList(
    (libraryId) => keys.files(libraryId, { scope, filter, sort }),
    (page) => ipc.listFiles({ scope, filter, sort, page }),
    range,
    options,
  );
}

/** One entry's row, such as the previewed file's; `null` asks for nothing. */
export function useEntry(entry: EntryRef | null) {
  const libraryId = useLibraryId();
  const target = entry ?? NO_ENTRY;
  return useQuery(
    libraryQuery(
      entry === null ? null : libraryId,
      (library) => keys.entry(library, target),
      () => unwrap(ipc.getEntry({ entry: target })),
    ),
  );
}

/** "New folder" in a course or a folder inside one; resolves to the new folder's row. */
export function useCreateFolder() {
  return useCommandMutation((request: CreateFolder) => ipc.createFolder(request), {
    entries: (request) => [request.parent],
  });
}

/**
 * Renames a file, folder, course or semester (a change of case too); resolves to its row, under
 * the same id. The CatalogChanged that follows reports it as `moved`.
 */
export function useRenameEntry() {
  return useCommandMutation((request: RenameEntry) => ipc.renameEntry(request), {
    entries: (request) => [request.entry],
  });
}

/**
 * Moves entries into a folder (`to: null`: the library root). Resolves with every entry that
 * failed (`InvalidMove`, `AlreadyExists`, `NotFound`, …); rejects with `NotFound` when the target
 * is gone. An entry already in the target counts as done.
 */
export function useMoveEntries() {
  return useBatchMutation((request: MoveEntries) => ipc.moveEntries(request), {
    entries: (request) => (request.to === null ? [] : [request.to]),
  });
}

/**
 * Moves entries to the Recycle Bin, folders with everything in them. Resolves with every entry
 * that failed: `InUse`, `NotFound`, and `NotRecyclable` for what the Recycle Bin cannot take,
 * which stays where it is (Folio never deletes for good).
 */
export function useDeleteEntries() {
  return useBatchMutation((request: DeleteEntries) => ipc.deleteEntries(request));
}
