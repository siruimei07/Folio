// How a click or key changes the selection of the tree, the list or the grid (UI architecture
// §7.2): one row, a toggled row, a range from the anchor or all rows (up to `LIMITS.batch`
// entries, loading the pages the range needs first), or focus alone. Rows that are not entries
// (quick views, separators) take focus but no selection.
import i18n from 'i18next';

import { showToast } from '../app/toasts';
import { type ClickIntent, type Move } from '../components/collections/selection';
import { LIST_PAGE } from '../data/paged';
import { type EntryRef, type EntryRow, LIMITS, type Page } from '../ipc';
import { showFailure, whenSettled } from './feedback';
import { type Region, type Selected, selectOnly, setFocus, setSelection, useLibraryView } from './state';

/** The entries of a range of rows, in order. */
export interface EntryRange {
  entries: Selected[];
  /** The range held more than the limit: only the first ones are in `entries`. */
  capped: boolean;
}

/** A row whose page is not loaded: the list that can load it, and the row's index there. */
export interface RowSource {
  list: { loadPage: (page: number) => Promise<Page<EntryRow>> };
  index: number;
}

/** The reference to an entry, without the rest of its row. */
export function refOf(entry: EntryRef): EntryRef {
  return { id: entry.id, path: entry.path };
}

export function selectedOf(row: EntryRow): Selected {
  return { id: row.id, path: row.path, kind: row.kind };
}

/**
 * The entries of a range from its rows in order: an entry, a row to load, or `null` for a row
 * that is not an entry. At most `limit`; pages are loaded once each. Synchronous when nothing
 * needs loading; otherwise it rejects with an `IpcFailure` when a page cannot load.
 */
export function entriesOf(rows: Iterable<Selected | RowSource | null>, limit: number): EntryRange | Promise<EntryRange> {
  const items: (Selected | RowSource)[] = [];
  let capped = false;
  for (const row of rows) {
    if (row === null) continue;
    if (items.length === limit) {
      capped = true;
      break;
    }
    items.push(row);
  }
  const sources = items.filter((item): item is RowSource => 'list' in item);
  if (sources.length === 0) return { entries: items as Selected[], capped };
  const pages = new Map<RowSource['list'], Map<number, Promise<Page<EntryRow>>>>();
  for (const { list, index } of sources) {
    const page = Math.floor(index / LIST_PAGE);
    const loads = pages.get(list) ?? new Map<number, Promise<Page<EntryRow>>>();
    pages.set(list, loads);
    if (!loads.has(page)) loads.set(page, list.loadPage(page));
  }
  return Promise.all([...pages.values()].flatMap((loads) => [...loads.values()])).then(async () => {
    const entries: Selected[] = [];
    for (const item of items) {
      if (!('list' in item)) {
        entries.push(item);
        continue;
      }
      const page = await pages.get(item.list)?.get(Math.floor(item.index / LIST_PAGE));
      const row = page?.items[item.index % LIST_PAGE];
      if (row !== undefined) entries.push(selectedOf(row));
    }
    return { entries, capped };
  });
}

/**
 * Selects the rows from `from` to `to`, at most `LIMITS.batch`, once the pages they need have
 * loaded; says so when the range held more, or when a page could not load. Anything that changes
 * the region's selection meanwhile (a click, another range, another folder) wins.
 */
function selectRange(region: Region, rows: SelectableRows, from: number, to: number, apply: (entries: Map<string, Selected>) => void): void {
  const started = useLibraryView.getState()[region];
  const current = () => useLibraryView.getState()[region] === started;
  const done = ({ entries, capped }: EntryRange) => {
    if (!current()) return;
    if (capped) showToast({ tone: 'info', title: i18n.t('library:selection.tooMany', { count: LIMITS.batch }) });
    apply(new Map(entries.map((entry) => [entry.id, entry])));
  };
  const range = rows.entriesBetween(Math.min(from, to), Math.max(from, to), LIMITS.batch);
  if (!(range instanceof Promise)) {
    done(range);
    return;
  }
  whenSettled(range, 'library.select', done, (failure) => {
    if (current()) showFailure(i18n.t('library:selection.failed'), failure.error, `library.select.${region}`);
  });
}

/**
 * The index of the focused row: where it was when its key is still there (the common case, at no
 * cost), else wherever its key went, else its old place. The collection keeps it in range.
 */
export function focusedIndexOf(
  focus: { key: string; index: number } | null,
  count: number,
  keyAt: (index: number) => string,
  indexOfKey: (key: string) => number | null,
): number | null {
  if (focus === null || count === 0) return null;
  if (focus.index < count && keyAt(focus.index) === focus.key) return focus.index;
  return indexOfKey(focus.key) ?? focus.index;
}

/** Selects every row of a list (Ctrl+A), keeping focus and the anchor where they are. */
export function selectAll(region: Region, rows: SelectableRows, count: number): void {
  if (count === 0) return;
  selectRange(region, rows, 0, count - 1, (entries) => {
    const current = useLibraryView.getState()[region];
    setSelection(region, { ...current, entries });
  });
}

/** What the selection needs to know of a collection's rows. */
export interface SelectableRows {
  keyAt: (index: number) => string;
  /** The entry at a row, or `null` for a row that is not one. */
  entryAt: (index: number) => Selected | null;
  indexOfKey: (key: string) => number | null;
  /** A loaded entry's own and inherited tags, for its menu. */
  tagsOf: (id: string) => { tags: readonly string[]; folderTags: readonly string[] } | undefined;
  /** The entries of rows `from` to `to`, at most `limit`, loading the pages they need (`entriesOf`). */
  entriesBetween: (from: number, to: number, limit: number) => EntryRange | Promise<EntryRange>;
}

export function applySelection(
  region: Region,
  rows: SelectableRows,
  index: number,
  intent: Move | ClickIntent,
): void {
  const key = rows.keyAt(index);
  const current = useLibraryView.getState()[region];
  switch (intent) {
    case 'focus':
      setFocus(region, key, index);
      return;
    case 'replace':
      selectOnly(region, key, index, rows.entryAt(index));
      return;
    case 'toggle': {
      const entry = rows.entryAt(index);
      if (entry === null) {
        setFocus(region, key, index);
        return;
      }
      const entries = new Map(current.entries);
      if (entries.has(entry.id)) entries.delete(entry.id);
      else entries.set(entry.id, entry);
      setSelection(region, { entries, anchor: { key, index }, focus: { key, index } });
      return;
    }
    case 'extend': {
      // The anchor's key finds it wherever it moved; its index stands in when its page is gone.
      const anchor = current.anchor ?? { key, index };
      const from = rows.indexOfKey(anchor.key) ?? anchor.index;
      setFocus(region, key, index);
      selectRange(region, rows, from, index, (entries) => {
        setSelection(region, { entries, anchor, focus: { key, index } });
      });
    }
  }
}
