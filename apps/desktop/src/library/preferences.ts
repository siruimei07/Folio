// The Library view's preferences on this computer (UI architecture §6.1): the panel's List or Tree
// mode, the grid's List or Grid mode and the sort. Kept in localStorage under a versioned key and
// read defensively: anything unexpected falls back to the defaults.
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

import type { EntrySort, SortKey } from '../ipc';

export type PanelMode = 'tree' | 'list';
export type PaneMode = 'grid' | 'list';

/** The sort keys the grid and the list offer (brief §5.1: name, date modified, size, type). */
export const SORT_KEYS = ['name', 'modified', 'size', 'type', 'added'] as const satisfies readonly SortKey[];
export type ViewSortKey = (typeof SORT_KEYS)[number];

export interface ViewSort extends EntrySort {
  key: ViewSortKey;
}

interface Preferences {
  panel: PanelMode;
  pane: PaneMode;
  sort: ViewSort;
}

/** Newest first, as the grid header's "Date modified" shows (app-shell §5). */
export const DEFAULT_SORT: ViewSort = { key: 'modified', descending: true };

const DEFAULTS: Preferences = { panel: 'tree', pane: 'grid', sort: DEFAULT_SORT };

function readPersisted(value: unknown): Preferences {
  const stored = (typeof value === 'object' && value !== null ? value : {}) as Partial<Record<keyof Preferences, unknown>>;
  const sort = stored.sort as Partial<ViewSort> | undefined;
  return {
    panel: stored.panel === 'list' ? 'list' : 'tree',
    pane: stored.pane === 'list' ? 'list' : 'grid',
    sort:
      typeof sort === 'object' && typeof sort.descending === 'boolean'
        ? { key: SORT_KEYS.find((key) => key === sort.key) ?? DEFAULT_SORT.key, descending: sort.descending }
        : DEFAULT_SORT,
  };
}

export const usePreferences = create<Preferences>()(
  persist((): Preferences => DEFAULTS, {
    name: 'folio.library.preferences',
    version: 1,
    storage: createJSONStorage(() => localStorage),
    merge: (persisted, current) => ({ ...current, ...readPersisted(persisted) }),
  }),
);

export function setPanelMode(panel: PanelMode): void {
  usePreferences.setState({ panel });
}

export function setPaneMode(pane: PaneMode): void {
  usePreferences.setState({ pane });
}

export function setSort(sort: ViewSort): void {
  usePreferences.setState({ sort });
}
