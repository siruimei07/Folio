// The pages the Library tree reads (docs/specs/ui-architecture.md §8.2): page 0 of the semester
// and of every expanded course and folder (each carries its list's total), the pages of the rows
// on screen and a little beyond, the page that holds each expanded folder's own row, the page of
// the focused row (so focus never sits on a row that turns into a placeholder), and, while a
// reveal waits, the next page of its folder until the entry appears, then the page that holds it.
// Rows below never jump when a page nobody watches is evicted: totals and the rows of expanded
// folders come from pages the tree always watches, and an evicted page shows placeholders.
import { useMemo, useState } from 'react';

import { type FolderPages, useFolderChildren } from '../../data/entries';
import { LIST_PAGE, PREFETCH_ROWS, useSettledRange } from '../../data/paged';
import type { Course, EntryRef, EntrySort, Semester } from '../../ipc';
import { parentOf } from '../../lib/paths';
import type { IndexRange } from '../../components/collections/useVirtualRows';
import { useLibraryView } from '../state';
import { type FolderList, TreeLayout } from './layout';

/** Folders first, then names as File Explorer sorts them (ipc-m1 §5.3). */
export const TREE_SORT: EntrySort = { key: 'name', descending: false };

export interface TreeDataOptions {
  semester: Semester | null;
  courses: readonly Course[];
  quickViews: boolean;
  /** The rows on screen. */
  range: IndexRange | null;
}

function pagesKey(requests: readonly FolderPages[]): string {
  return requests.map(({ folder, pages }) => `${folder.id}@${folder.path}:${pages.join(',')}`).join('\n');
}

/** The first page of `list` that has not arrived, or `null` when all have. */
function missingPage(list: FolderList | undefined): number | null {
  const total = list?.total;
  if (list === undefined || total === undefined) return 0;
  for (let start = 0; start < total; start += LIST_PAGE) {
    if (list.rowAt(start) === undefined) return start / LIST_PAGE;
  }
  return null;
}

export function useTreeData({ semester, courses, quickViews, range }: TreeDataOptions) {
  const expanded = useLibraryView((state) => state.expanded);
  const newFolderIn = useLibraryView((state) => state.newFolder?.parent ?? null);
  const reveal = useLibraryView((state) => state.reveal);
  const focus = useLibraryView((state) => state.panel.focus);
  const [requests, setRequests] = useState<readonly FolderPages[]>([]);
  const lists = useFolderChildren(requests, TREE_SORT);
  const byId = useMemo(
    () => new Map<string, FolderList>(requests.map(({ folder }, index) => [folder.id, lists[index] as FolderList])),
    [requests, lists],
  );
  const semesterList = semester === null ? undefined : byId.get(semester.folder.id);

  const layout = useMemo(
    () => new TreeLayout({ quickViews, courses, expanded, lists: byId, semester: semesterList, newFolderIn }),
    [quickViews, courses, expanded, byId, semesterList, newFolderIn],
  );

  const settled = useSettledRange(range);
  const next = useMemo(() => {
    const wanted = new Map<string, { folder: EntryRef; pages: Set<number> }>();
    const want = (folder: EntryRef, page: number) => {
      const entry = wanted.get(folder.id);
      if (entry === undefined) wanted.set(folder.id, { folder, pages: new Set([0, page]) });
      else entry.pages.add(page);
    };
    if (semester !== null) want(semester.folder, 0);
    const refs = new Map<string, EntryRef>();
    for (const { node } of layout.folders) refs.set(node.ref.id, node.ref);
    for (const { node, parent, index } of layout.folders) {
      want(node.ref, 0);
      const parentRef = parent === null ? undefined : refs.get(parent);
      if (parentRef !== undefined && index !== null) want(parentRef, Math.floor(index / LIST_PAGE));
    }
    const wantRows = (start: number, end: number) => {
      for (const [id, indexes] of layout.sources(start, end)) {
        const folder = id === 'semester' ? semester?.folder : refs.get(id);
        if (folder === undefined) continue;
        for (const index of indexes) want(folder, Math.floor(index / LIST_PAGE));
      }
    };
    if (settled !== null && layout.count > 0) {
      wantRows(Math.max(0, settled.start - PREFETCH_ROWS), Math.min(layout.count - 1, settled.end + PREFETCH_ROWS));
    }
    if (focus !== null) {
      const at = layout.indexOfKey(focus.key) ?? focus.index;
      if (at < layout.count) wantRows(at, at);
    }
    // A reveal loads its folder page by page until the entry appears (§8.2), then keeps the page
    // that holds it: dropping it would hide the entry and ask for the page again, without end.
    if (reveal !== null) {
      const at = layout.indexOfKey(reveal.id);
      if (at !== null) {
        wantRows(at, at);
      } else {
        const parent = parentOf(reveal.path);
        const folder =
          semester?.folder.path === parent ? semester.folder : layout.folders.find(({ node }) => node.ref.path === parent)?.node.ref;
        // Every page up to the first missing one stays watched, so the search only moves on: a
        // page dropped once searched would be missing again, and asked for again.
        const page = folder === undefined ? null : missingPage(byId.get(folder.id));
        if (folder !== undefined && page !== null) for (let next = 0; next <= page; next++) want(folder, next);
      }
    }
    return [...wanted.values()].map(({ folder, pages }) => ({
      folder,
      pages: [...pages].sort((a, b) => a - b),
    }));
  }, [layout, settled, semester, reveal, focus, byId]);

  // New pages to watch follow from what the last ones held: React's pattern for state that a
  // render derives from the previous one. It settles once the pages on screen have all arrived.
  if (pagesKey(next) !== pagesKey(requests)) setRequests(next);

  return layout;
}
