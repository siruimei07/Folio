// The Changes view's preferences on this computer (UI architecture §6.1): the list flat or grouped
// by course (workspace-history handoff §3.1, 21A). Kept in localStorage under a versioned key and
// read defensively: anything unexpected falls back to the flat list.
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

export type ListLayout = 'flat' | 'grouped';

interface Preferences {
  layout: ListLayout;
}

const DEFAULTS: Preferences = { layout: 'flat' };

function readPersisted(value: unknown): Preferences {
  const stored = (typeof value === 'object' && value !== null ? value : {}) as Partial<Record<keyof Preferences, unknown>>;
  return { layout: stored.layout === 'grouped' ? 'grouped' : 'flat' };
}

export const useChangesPreferences = create<Preferences>()(
  persist((): Preferences => DEFAULTS, {
    name: 'folio.changes.preferences',
    version: 1,
    storage: createJSONStorage(() => localStorage),
    merge: (persisted, current) => ({ ...current, ...readPersisted(persisted) }),
  }),
);

export function setListLayout(layout: ListLayout): void {
  useChangesPreferences.setState({ layout });
}
