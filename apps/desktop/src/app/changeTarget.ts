// "Show in Changes" (handoff workspace-history §8.3, §9.2): any view asks the Changes view to show
// the change at a path, and the Changes view takes the path once, finds its row and selects it, as
// the Library takes a reveal target (`navigation.ts`). Kept apart from the navigation store, whose
// lines other lanes edit. The target remembers its library: a target asked for in a library that is
// no longer open names a path of another library, and is dropped.
import { create } from 'zustand';

import { useSession } from '../data/session';
import { showView } from './navigation';

interface ChangeTarget {
  /** Below the library root, as workspace items name it. */
  path: string;
  libraryId: string;
}

const useChangeTargetStore = create<{ target: ChangeTarget | null }>()(() => ({ target: null }));

/**
 * Shows the Changes view; with `path`, the view then selects the change at that path, scrolls to it
 * and gives it the focus (`takeChangeTarget`). Without a library open there is nothing to show.
 */
export function showChange(path?: string): void {
  const libraryId = useSession.getState().libraryId;
  if (libraryId === null) return;
  if (path !== undefined) useChangeTargetStore.setState({ target: { path, libraryId } });
  showView('changes');
}

/** The path Changes was asked to show and has not taken yet, for the effect that takes it. */
export function usePendingChangeTarget(): string | null {
  return useChangeTargetStore((state) => state.target?.path ?? null);
}

/** The pending path, cleared so it is handled once; `null` when none, or one of another library. */
export function takeChangeTarget(): string | null {
  const { target } = useChangeTargetStore.getState();
  if (target === null) return null;
  useChangeTargetStore.setState({ target: null });
  return target.libraryId === useSession.getState().libraryId ? target.path : null;
}
