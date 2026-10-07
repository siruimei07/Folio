// The changes list's rows (workspace-history handoff §3.2, §3.3, §3.5, §3.9): the workspace's items
// in path order, under a header for each course, semester or the library when grouped by course
// (`grouped.ts`); then, when there are any, the "Tags and settings" header and the tag and settings
// changes. Both lists page on their own (`data/workspace.ts`); the visible range of the one list is
// split between them, so only the pages near what shows are asked for.
import { useMemo, useState } from 'react';

import { nextFocusable } from '../../components/collections/keys';
import type { IndexRange } from '../../components/collections/useVirtualRows';
import { LIST_PAGE, type LoadingPagedList } from '../../data/paged';
import { useMetadataChanges, useWorkspace, useWorkspaceItems } from '../../data/workspace';
import type { IpcFailure } from '../../data/errors';
import type { MetadataChange, WorkspaceItem } from '../../ipc';
import type { RowRef } from '../state';
import { findGroupStarts, GroupLayout, type GroupMemory, type GroupStart, NO_GROUPS } from './grouped';

export type ChangeRow =
  | { kind: 'item'; key: string; item: WorkspaceItem }
  | { kind: 'metadata'; key: string; change: MetadataChange }
  /** Grouped by course: the header of a run of a place's items, an option with a check box. */
  | { kind: 'group'; key: string; start: GroupStart }
  /** "Tags and settings": not an option. */
  | { kind: 'header'; key: string }
  /** A row whose page has not arrived. */
  | { kind: 'placeholder'; key: string };

/** A row that shows a change: an item, or a tag or settings change. */
export type ChangeRowOf = Extract<ChangeRow, { kind: 'item' | 'metadata' }>;

/** The React key, and the store's, of each kind of row: an item and a metadata change may share a key. */
const ITEM = 'item:';
const META = 'meta:';
/** `PagedList.rowKey` of a row not loaded. */
const PLACEHOLDER = 'placeholder:';
const HEADER: ChangeRow = { kind: 'header', key: 'header:metadata' };

/** The row key of the item whose workspace key is `key` (`WorkspaceItem.key`). */
export function itemRowKey(key: string): string {
  return `${ITEM}${key}`;
}

export interface ChangeRows {
  /** Rows, the headers included. */
  count: number;
  /** The items, as the shell counts them. */
  itemCount: number;
  /** Rows that are options: all but the "Tags and settings" header. */
  options: number;
  /** The "Tags and settings" header's index; -1 without tag and settings changes. */
  header: number;
  rowAt: (index: number) => ChangeRow;
  /**
   * The index of a row by its key, `null` when it is not there: loaded rows, headers, and the
   * placeholder of an item not loaded (it stays that item's row).
   */
  indexOfKey: (key: string) => number | null;
  /** A loaded item by its workspace key (`WorkspaceItem.key`). */
  itemByKey: (key: string) => WorkspaceItem | undefined;
  /** The index among the items of the item, loaded or not, at row `index`; `null` for other rows. */
  itemIndexAt: (index: number) => number | null;
  /** The row of the item at `index` among the items, as far as the headers above it are known. */
  rowOfItem: (index: number) => number;
  /** The loaded items in the rows of `range`, first and last included. */
  itemsIn: (range: IndexRange) => WorkspaceItem[];
  /** Every loaded item. */
  loadedItems: () => WorkspaceItem[];
  items: LoadingPagedList<WorkspaceItem>;
  /** `pending` until both lists have a page; `error` when a page the list shows failed. */
  status: 'pending' | 'error' | 'success';
  error: IpcFailure | null;
  /** A page the list shows has no rows yet and is being read: scrolled to, or asked again (`retry`). */
  loading: boolean;
  retry: () => void;
}

/** The part of `range` (indexes of the whole list) that falls in a list starting at `offset`. */
function partOf(range: IndexRange | null, offset: number, total: number | undefined): IndexRange | null {
  if (range === null) return null;
  const end = total === undefined ? range.end - offset : Math.min(range.end - offset, total - 1);
  const start = Math.max(0, range.start - offset);
  return end < start ? null : { start, end };
}

/** The items in the rows of `range`, with `layout`'s headers. */
function itemRange(range: IndexRange | null, layout: GroupLayout, total: number | undefined): IndexRange | null {
  if (range === null) return null;
  const start = layout.itemFrom(range.start);
  const end = layout.itemUpTo(range.end);
  return partOf({ start, end }, 0, total);
}

/** Calls `each` with every loaded row and its index: a page is loaded when one of its rows is. */
function forLoaded<T>(list: { total: number | undefined; rowAt: (index: number) => T | undefined }, each: (row: T, index: number) => void): void {
  const total = list.total ?? 0;
  for (let start = 0; start < total; start += LIST_PAGE) {
    const end = Math.min(total, start + LIST_PAGE);
    if (list.rowAt(start) === undefined && list.rowAt(end - 1) === undefined) continue;
    for (let index = start; index < end; index++) {
      const row = list.rowAt(index);
      if (row !== undefined) each(row, index);
    }
  }
}

/** The index of a loaded row by its id, built when first asked for: most renders never need it. */
function lazyIndexes<T>(list: { total: number | undefined; rowAt: (index: number) => T | undefined }, id: (row: T) => string) {
  let indexes: Map<string, number> | undefined;
  return (key: string): number | undefined => {
    if (indexes === undefined) {
      const built = new Map<string, number>();
      forLoaded(list, (row, index) => built.set(id(row), index));
      indexes = built;
    }
    return indexes.get(key);
  };
}

/** The index a placeholder's key names (`PagedList.rowKey`), or `null` for another key. */
function placeholderIndex(key: string, total: number): number | null {
  if (!key.startsWith(PLACEHOLDER)) return null;
  const index = Number(key.slice(PLACEHOLDER.length));
  return Number.isInteger(index) && index >= 0 && index < total ? index : null;
}

/** The rows of the items laid out by `layout` and the metadata changes; one per set of inputs. */
function changeRows(items: LoadingPagedList<WorkspaceItem>, metadata: LoadingPagedList<MetadataChange>, layout: GroupLayout): ChangeRows {
  const itemCount = layout.items;
  const itemRows = layout.rows;
  const metaCount = metadata.total ?? 0;
  const header = metaCount > 0 ? itemRows : -1;
  const count = itemRows + (metaCount > 0 ? metaCount + 1 : 0);
  const itemRowAt = (index: number): ChangeRow => {
    const item = items.rowAt(index);
    return item === undefined
      ? { kind: 'placeholder', key: `${ITEM}${items.rowKey(index)}` }
      : { kind: 'item', key: itemRowKey(item.key), item };
  };
  const rowAt = (index: number): ChangeRow => {
    if (index < itemRows) {
      const at = layout.at(index);
      return 'start' in at ? { kind: 'group', key: at.start.key, start: at.start } : itemRowAt(at.item);
    }
    if (index === header) return HEADER;
    const at = index - itemRows - 1;
    const change = metadata.rowAt(at);
    return change === undefined
      ? { kind: 'placeholder', key: `${META}${metadata.rowKey(at)}` }
      : { kind: 'metadata', key: `${META}${change.key}`, change };
  };
  const itemIndexOf = lazyIndexes(items, (item) => item.key);
  const metaIndexOf = lazyIndexes(metadata, (change) => change.key);
  const groupRows = new Map(layout.starts.map((start, at) => [start.key, start.item + at]));
  const indexOfKey = (key: string): number | null => {
    if (key.startsWith(ITEM)) {
      const id = key.slice(ITEM.length);
      const index = itemIndexOf(id) ?? placeholderIndex(id, itemCount);
      return index === null ? null : layout.rowOfItem(index);
    }
    if (key.startsWith(META)) {
      const id = key.slice(META.length);
      const index = metaIndexOf(id) ?? placeholderIndex(id, metaCount);
      return index === null ? null : itemRows + 1 + index;
    }
    if (key === HEADER.key) return header >= 0 ? header : null;
    return groupRows.get(key) ?? null;
  };
  const itemIndexAt = (index: number): number | null => {
    if (index < 0 || index >= itemRows) return null;
    const at = layout.at(index);
    return 'start' in at ? null : at.item;
  };
  const itemsIn = (wanted: IndexRange): WorkspaceItem[] => {
    const found: WorkspaceItem[] = [];
    if (itemRows === 0 || wanted.end < 0 || wanted.start >= itemRows) return found;
    const last = layout.itemUpTo(Math.min(wanted.end, itemRows - 1));
    for (let index = layout.itemFrom(Math.max(0, wanted.start)); index <= last; index++) {
      const item = items.rowAt(index);
      if (item !== undefined) found.push(item);
    }
    return found;
  };
  const failed = items.status === 'error' ? items : metadata.status === 'error' ? metadata : null;
  return {
    count,
    itemCount,
    options: count - (header >= 0 ? 1 : 0),
    header,
    rowAt,
    indexOfKey,
    itemByKey: (key) => {
      const index = itemIndexOf(key);
      return index === undefined ? undefined : items.rowAt(index);
    },
    itemIndexAt,
    rowOfItem: (index) => layout.rowOfItem(index),
    itemsIn,
    loadedItems: () => {
      const loaded: WorkspaceItem[] = [];
      forLoaded(items, (item) => loaded.push(item));
      return loaded;
    },
    items,
    status: failed !== null ? 'error' : items.total === undefined || metadata.total === undefined ? 'pending' : 'success',
    error: failed?.error ?? null,
    loading: items.loading || metadata.loading,
    retry: () => {
      items.retry();
      metadata.retry();
    },
  };
}

/**
 * The rows the list shows around `range` (indexes of the whole list; `null` before it renders),
 * flat or `grouped` by course. Grouped, the headers found on the pages that came are kept for as
 * long as the list of items stays the same (`findGroupStarts`).
 */
export function useChangeRows(range: IndexRange | null, grouped: boolean): ChangeRows {
  // The summary's count splits the range before the items' first page has come.
  const known = useWorkspace().data?.items;
  const [memory, setMemory] = useState<GroupMemory>(NO_GROUPS);
  const starts = grouped ? memory.starts.values() : [];
  // The headers known so far turn the rows the list shows into the items to load.
  const before = new GroupLayout(starts, known ?? 0);
  const items = useWorkspaceItems(itemRange(range, before, known));
  const itemCount = items.total ?? known ?? 0;
  const metadata = useMetadataChanges(partOf(range, itemCount + before.starts.length + 1, undefined));
  const found = useMemo(() => (grouped ? findGroupStarts(items, memory) : NO_GROUPS), [grouped, items, memory]);
  // Kept during the render (React's pattern for information from earlier renders): it settles
  // once a render finds nothing new.
  if (grouped && found !== memory) setMemory(found);
  return useMemo(
    () => changeRows(items, metadata, new GroupLayout(found.starts.values(), itemCount)),
    [items, metadata, found, itemCount],
  );
}

/** Whether a row shows a change, or stands for one not loaded yet. */
function isChange(row: ChangeRow): boolean {
  return row.kind === 'item' || row.kind === 'metadata' || row.kind === 'placeholder';
}

/**
 * The row that holds the selection (and the focus): the stored row where it still is, else the
 * row now at its place (the next change, when it went, §3.6); never the "Tags and settings"
 * header; the first change before any was chosen. A group's header holds it while the person keeps
 * the focus there. `null` for an empty list.
 */
export function selectedIndexOf(focus: RowRef | null, rows: ChangeRows): number | null {
  if (rows.count === 0) return null;
  if (focus !== null && focus.index < rows.count && rows.rowAt(focus.index).key === focus.key) {
    if (focus.index !== rows.header) return focus.index;
  }
  const found = focus === null ? null : rows.indexOfKey(focus.key);
  if (found !== null && found !== rows.header) return found;
  const index = focus === null ? 0 : Math.min(focus.index, rows.count - 1);
  const change = (at: number) => isChange(rows.rowAt(at));
  const option = (at: number) => at !== rows.header;
  return (
    nextFocusable(change, rows.count, index, 1) ??
    nextFocusable(change, rows.count, index, -1) ??
    nextFocusable(option, rows.count, index, 1) ??
    nextFocusable(option, rows.count, index, -1)
  );
}

function changeOf(row: ChangeRowOf): WorkspaceItem | MetadataChange {
  return row.kind === 'item' ? row.item : row.change;
}

export interface SelectedChange {
  /** The selected row's index; `null` for an empty list. */
  index: number | null;
  /** The change it shows; `null` until its page has come, and for a group's header. */
  row: ChangeRowOf | null;
}

/**
 * The selected row and the change it shows, which the diff beside the list follows. The list asks
 * only for the pages it shows, so when the person scrolls far away the selected row's page goes
 * and its row turns into a placeholder; it is still the change last shown, as long as the
 * selection names it.
 */
export function useSelectedChange(rows: ChangeRows, focus: RowRef | null): SelectedChange {
  const index = selectedIndexOf(focus, rows);
  const row = index === null ? null : rows.rowAt(index);
  const loaded = row?.kind === 'item' || row?.kind === 'metadata' ? row : null;
  const [last, setLast] = useState<ChangeRowOf | null>(null);
  // Remembered during the render (React's pattern for information from earlier renders): a row
  // object is new each render, its change only when its page is.
  if (loaded !== null && (last === null || changeOf(last) !== changeOf(loaded))) setLast(loaded);
  if (loaded !== null) return { index, row: loaded };
  return { index, row: row !== null && last !== null && last.key === focus?.key ? last : null };
}
