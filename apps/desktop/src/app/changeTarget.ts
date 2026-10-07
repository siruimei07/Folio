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

interface ChangeTargets {
  target: ChangeTarget | null;
  /** The library in which Changes was asked to take the focus without a path (`takeChangesFocus`). */
  focus: string | null;
}

const useChangeTargetStore = create<ChangeTargets>()(() => ({ target: null, focus: null }));

/**
 * Shows the Changes view; with `path`, the view then selects the change at that path, scrolls to it
 * and gives it the focus (`takeChangeTarget`); without, the view takes the focus as it shows
 * (`takeChangesFocus`), since the control that had it went with the view that hid. Without a
 * library open there is nothing to show.
 */
export function showChange(path?: string): void {
  const libraryId = useSession.getState().libraryId;
  if (libraryId === null) return;
  // A path asked for earlier and not taken yet stays: it still selects its change.
  useChangeTargetStore.setState(path === undefined ? { focus: libraryId } : { target: { path, libraryId }, focus: null });
  showView('changes');
}

/** Whether Changes was asked to take the focus and has not yet. */
export function usePendingChangesFocus(): boolean {
  return useChangeTargetStore((state) => state.focus !== null);
}

/** Whether Changes was asked to take the focus in the open library, cleared so it is handled once. */
export function takeChangesFocus(): boolean {
  const { focus } = useChangeTargetStore.getState();
  if (focus === null) return false;
  useChangeTargetStore.setState({ focus: null });
  return focus === useSession.getState().libraryId;
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
