// The library session (docs/specs/ui-architecture.md §5.4, §6.1): which library the cached queries
// belong to, the newest catalog revision the UI has seen, and the current semester. Server state
// (the library's name, its pages) stays in the query cache; this store keeps only what the data
// layer needs synchronously and what must survive a restart.
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

import { newerRevision } from '../lib/revision';
import { followPath, followReferences } from './references';

interface SessionState {
  /** The open library, or `null` while none is open. */
  libraryId: string | null;
  /** The current semester's folder path, per library id. Kept on this machine only. */
  semesters: Record<string, string>;
}

function readPersisted(value: unknown): Pick<SessionState, 'semesters'> {
  const semesters: Record<string, string> = {};
  const stored: unknown = (value as { semesters?: unknown } | null)?.semesters;
  if (typeof stored === 'object' && stored !== null) {
    for (const [library, path] of Object.entries(stored)) {
      if (typeof path === 'string') semesters[library] = path;
    }
  }
  return { semesters };
}

export const useSession = create<SessionState>()(
  persist((): SessionState => ({ libraryId: null, semesters: {} }), {
    // The key carries its version; anything unexpected in it is ignored.
    name: 'folio.session',
    version: 1,
    storage: createJSONStorage(() => localStorage),
    partialize: (state) => ({ semesters: state.semesters }),
    merge: (persisted, current) => ({ ...current, ...readPersisted(persisted) }),
  }),
);

/**
 * The revision of the newest CatalogChanged of the open library; `null` before the first. Only
 * the event handler reads it, so it lives outside the store: no render and no storage write per
 * event.
 */
let lastRevision: number | null = null;

export function latestRevision(): number | null {
  return lastRevision;
}

/**
 * Starts a session for the library whose queries are cached (`null`: none is open). Revisions
 * start again at 0 whenever a library opens (ipc-m1 §15.2), so nothing seen before applies.
 */
export function openSession(libraryId: string | null): void {
  lastRevision = null;
  useSession.setState({ libraryId });
}

/** Records the revision of a CatalogChanged; an older one (events out of order) changes nothing. */
export function sawRevision(revision: number): void {
  lastRevision = lastRevision === null ? revision : newerRevision(lastRevision, revision);
}

/** Makes `path` the open library's current semester (`null`: none chosen). */
export function setCurrentSemester(path: string | null): void {
  useSession.setState((state) => {
    const libraryId = state.libraryId;
    if (libraryId === null) return state;
    const others = Object.fromEntries(
      Object.entries(state.semesters).filter(([library]) => library !== libraryId),
    );
    return { semesters: path === null ? others : { ...others, [libraryId]: path } };
  });
}

/** The open library's id. */
export function useLibraryId(): string | null {
  return useSession((state) => state.libraryId);
}

/** The open library's current semester path, if one was chosen. */
export function useCurrentSemester(): string | null {
  return useSession((state) =>
    state.libraryId === null ? null : (state.semesters[state.libraryId] ?? null),
  );
}

// The current semester is held by path, so it follows renames and moves like expanded folders.
followReferences((update) => {
  if (update.kind !== 'changes') return;
  const { libraryId, semesters } = useSession.getState();
  const path = libraryId === null ? undefined : semesters[libraryId];
  if (path === undefined) return;
  const followed = followPath(path, update.changes);
  if (followed !== path) setCurrentSemester(followed);
});
