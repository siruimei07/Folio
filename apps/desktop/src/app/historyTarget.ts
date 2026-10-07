// "View history of this file" (handoff workspace-history §7.4, §12.4): any view asks History to
// show one file's history, and the History view takes the file once, as the Library takes a reveal
// target (`navigation.ts`); "N more in History" (§5) asks for the whole history, its timeline with
// the focus. Kept apart from the navigation store so the views that offer it
// (Library, Changes, History) do not change it. The target remembers its library: a target asked
// for in a library that is no longer open names a file of another library, and is dropped.
import { create } from 'zustand';

import { useSession } from '../data/session';
import type { FileRef } from '../ipc';
import { showView } from './navigation';

interface HistoryTarget {
  file: FileRef;
  libraryId: string;
}

interface HistoryTargets {
  target: HistoryTarget | null;
  /** The library whose whole history was asked for, its timeline with the focus (`showHistoryTimeline`). */
  timeline: string | null;
}

const useHistoryTargetStore = create<HistoryTargets>()(() => ({ target: null, timeline: null }));

/** Shows the History view filtered to `file`; History takes it with `takeHistoryTarget`. */
export function showHistory(file: FileRef): void {
  const libraryId = useSession.getState().libraryId;
  // History shows the open library's; without one there is no file to show.
  if (libraryId === null) return;
  useHistoryTargetStore.setState({ target: { file, libraryId }, timeline: null });
  showView('history');
}

/**
 * Shows the History view's whole history with the focus on its timeline ("N more in History"):
 * the control that had the focus goes with the view that hides. History takes it with
 * `takeHistoryTimeline`.
 */
export function showHistoryTimeline(): void {
  const libraryId = useSession.getState().libraryId;
  if (libraryId === null) return;
  useHistoryTargetStore.setState({ target: null, timeline: libraryId });
  showView('history');
}

/** Whether the whole history was asked for and History has not taken it yet. */
export function usePendingHistoryTimeline(): boolean {
  return useHistoryTargetStore((state) => state.timeline !== null);
}

/** Whether the whole history was asked for in the open library, cleared so it is handled once. */
export function takeHistoryTimeline(): boolean {
  const { timeline } = useHistoryTargetStore.getState();
  if (timeline === null) return false;
  useHistoryTargetStore.setState({ timeline: null });
  return timeline === useSession.getState().libraryId;
}

/** The file History was asked to show and has not taken yet, for the effect that takes it. */
export function usePendingHistoryTarget(): FileRef | null {
  return useHistoryTargetStore((state) => state.target?.file ?? null);
}

/** The pending file, cleared so it is handled once; `null` when none, or one of another library. */
export function takeHistoryTarget(): FileRef | null {
  const { target } = useHistoryTargetStore.getState();
  if (target === null) return null;
  useHistoryTargetStore.setState({ target: null });
  return target.libraryId === useSession.getState().libraryId ? target.file : null;
}
