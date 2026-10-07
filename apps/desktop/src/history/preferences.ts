// The History view's preferences on this computer (UI architecture §6.1; handoff workspace-history
// §7.1, app-shell §7): the panel's width and the type filter. Kept in localStorage under a
// versioned key and read defensively: anything unexpected falls back to the defaults.
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

import type { HistoryType } from '../ipc';
import { SIZE } from '../tokens/tokens';
import { filterOf } from './model/filter';

interface Preferences {
  /** The panel's width in CSS pixels, between `size.history-panel-min` and `-max`. */
  panelWidth: number;
  /** The kinds of entry shown; `null` shows every kind. */
  types: HistoryType[] | null;
}

const DEFAULTS: Preferences = { panelWidth: SIZE.historyPanel, types: null };

/** A width between the panel's least and greatest, in whole pixels. */
export function clampPanelWidth(width: number, max: number = SIZE.historyPanelMax): number {
  return Math.round(Math.min(Math.max(width, SIZE.historyPanelMin), Math.max(SIZE.historyPanelMin, max)));
}

function readPersisted(value: unknown): Preferences {
  const stored = (typeof value === 'object' && value !== null ? value : {}) as Partial<Record<keyof Preferences, unknown>>;
  const width = stored.panelWidth;
  return {
    panelWidth: typeof width === 'number' && Number.isFinite(width) ? clampPanelWidth(width) : DEFAULTS.panelWidth,
    types: Array.isArray(stored.types) ? filterOf(stored.types) : null,
  };
}

export const useHistoryPreferences = create<Preferences>()(
  persist((): Preferences => DEFAULTS, {
    name: 'folio.history.preferences',
    version: 1,
    storage: createJSONStorage(() => localStorage),
    merge: (persisted, current) => ({ ...current, ...readPersisted(persisted) }),
  }),
);

export function setPanelWidth(width: number): void {
  useHistoryPreferences.setState({ panelWidth: clampPanelWidth(width) });
}

/** Back to `size.history-panel` (the handle's double-click). */
export function resetPanelWidth(): void {
  useHistoryPreferences.setState({ panelWidth: DEFAULTS.panelWidth });
}

export function setHistoryTypes(types: HistoryType[] | null): void {
  useHistoryPreferences.setState({ types: types === null ? null : filterOf(types) });
}
