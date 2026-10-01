// Reading entries (docs/specs/ipc-m1.md §9.1): folder children and filtered files as paged lists,
// and single entries. The views that change entries add their mutations here.
import { useQuery } from '@tanstack/react-query';

import { type EntryFilter, type EntryRef, type EntrySort, ipc } from '../ipc';
import { unwrap } from './errors';
import { keys, libraryQuery } from './keys';
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

const NO_ENTRY: EntryRef = { id: '', path: '' };

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
