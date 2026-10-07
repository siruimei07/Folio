// The navigation store (UI architecture §6.1): which rail view shows, which dialog is open, and
// where to reveal an entry. No router: a desktop window has no address bar and no back button.
// Features never import each other; cross-feature actions ("reveal this file in the Library",
// "open Library settings on Tags") go through this store.

import { createContext, useContext } from 'react';
import { create } from 'zustand';

import type { CommitInfo, EntryRef, ImportSource, Job } from '../ipc';

/** The rail views. Until M2 only the Library is registered (ADR-0005, product decision 3). */
export type ViewId = 'library' | 'changes' | 'history';

/**
 * Each dialog the store can open, with what it opens on. A lane adds its dialog here with one
 * line, and registers the component in `dialogs.ts`.
 */
export interface DialogParams {
  search: undefined;
  librarySettings: { page?: string } | undefined;
  appSettings: { page?: string } | undefined;
  problems: undefined;
  /** A commit's message (`feat/ui-history-view`, handoff workspace-history §9.1). */
  editMessage: { commit: CommitInfo };
  /**
   * Adding files from "Add files" or a drop (`feat/ui-import`), to `target` or a place it asks
   * for; `tags` start selected (the Library's tag filter).
   */
  import: { source: ImportSource; target: EntryRef | null; tags?: readonly string[] };
  /** What an import left out or why it failed (`feat/ui-import`, library-actions §5 "Details"). */
  importResult: { job: Job; target?: string };
  /** A semester with its courses (first-run handoff §5.1, library-actions §8). */
  newSemester: undefined;
  /** More courses in a semester (library-actions §8). */
  addCourses: { semester: EntryRef };
}

export type DialogKind = keyof DialogParams;

export type OpenDialog = { [K in DialogKind]: { kind: K; params: DialogParams[K] } }[DialogKind];

interface NavigationState {
  view: ViewId;
  /** One dialog at a time; closing returns focus to where it was (React Aria's focus scope). */
  dialog: OpenDialog | null;
  /** An entry the Library should expand to, select and scroll to (UI architecture §8.2). */
  revealTarget: EntryRef | null;
}

const INITIAL: NavigationState = { view: 'library', dialog: null, revealTarget: null };

export const useNavigation = create<NavigationState>()(() => INITIAL);

/**
 * The dialogs the shell hosts (`registry.ts`). A view offers an action that opens a dialog only
 * while one is registered for it, as the toolbar does for search.
 */
export const HostedDialogs = createContext<ReadonlySet<DialogKind>>(new Set());

/** Whether a dialog of `kind` can open, so the button or menu item that opens it can show. */
export function useCanOpenDialog(kind: DialogKind): boolean {
  return useContext(HostedDialogs).has(kind);
}

/**
 * The rail views the shell hosts (`registry.ts`). A view offers an action that shows another view
 * ("Show in Changes", "Go to Changes") only while that view is registered.
 */
export const HostedViews = createContext<ReadonlySet<ViewId>>(new Set());

/** Whether `view` is on the rail, so the button or menu item that shows it can show. */
export function useCanShowView(view: ViewId): boolean {
  return useContext(HostedViews).has(view);
}

export function showView(view: ViewId): void {
  useNavigation.setState({ view });
}

export function openDialog<K extends DialogKind>(
  kind: K,
  ...params: undefined extends DialogParams[K] ? [params?: DialogParams[K]] : [params: DialogParams[K]]
): void {
  useNavigation.setState({ dialog: { kind, params: params[0] } as OpenDialog });
}

export function closeDialog(): void {
  useNavigation.setState({ dialog: null });
}

/** Shows the Library and asks it to reveal `target`; the Library takes it with `takeRevealTarget`. */
export function reveal(target: EntryRef): void {
  useNavigation.setState({ view: 'library', revealTarget: target });
}

/** The pending reveal target, cleared so it is handled once. */
export function takeRevealTarget(): EntryRef | null {
  const { revealTarget } = useNavigation.getState();
  if (revealTarget !== null) useNavigation.setState({ revealTarget: null });
  return revealTarget;
}

/**
 * Drops the references the store holds, for another library (UI architecture §5.4,
 * `LibraryStateChanged`). The view and an open dialog stay: the settings dialog may be what
 * changed the library.
 */
export function resetNavigation(): void {
  useNavigation.setState({ revealTarget: null });
}
