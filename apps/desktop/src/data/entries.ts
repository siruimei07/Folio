// Entries (docs/specs/ipc-m1.md §9): folder children and filtered files as paged lists, single
// entries, and the changes the Library view makes. A change answers before its CatalogChanged
// arrives; the event refreshes the lists it touched and moves the references the UI holds
// (`events.ts`), so a row keeps its place until the catalog reports the change.
import { useQuery } from '@tanstack/react-query';

import {
  type CreateFolder,
  type DeleteEntries,
  type EntryFilter,
  type EntryRef,
  type EntrySort,
  ipc,
  type MoveEntries,
  type RenameEntry,
} from '../ipc';
import { unwrap } from './errors';
import { keys, libraryQuery, NO_ENTRY } from './keys';
import { useBatchMutation, useCommandMutation } from './mutations';
import { type PagedListOptions, type RowRange, usePagedList } from './paged';
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
