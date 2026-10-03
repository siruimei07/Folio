// Subscriptions to the shell's events (docs/specs/ipc-m1.md §15). Each returns the function that
// stops it, so a React effect can return it directly:
// `useEffect(() => shellEvents.onCatalogChanged(refresh), [refresh])`.
import type { Event, UnlistenFn } from '@tauri-apps/api/event';

import {
  type AppSettingsChanged,
  type CatalogChanged,
  type DropFailed,
  type DropHover,
  events,
  type FilesDropped,
  type IgnoreRulesChanged,
  type JobChanged,
  type LibraryStateChanged,
  type ProblemsChanged,
} from './bindings';

/** A failed registration means a missing permission: a bug, reported to the console. */
function reportListenerError(error: unknown): void {
  console.error('event listener failed', error);
}

/**
 * Keeps a Tauri listener until the returned function runs. A registration that fails is reported
 * once, to `onError` (the console by default); stopping before the registration resolves stops
 * the listener as soon as it does.
 */
export function hold(
  registration: Promise<() => unknown>,
  onError: (error: unknown) => void = reportListenerError,
): () => void {
  const unlisten = registration.catch((error: unknown) => {
    onError(error);
    return undefined;
  });
  return () => {
    // Tauri's unlisten functions return a promise, although `UnlistenFn` says `void`.
    void unlisten.then((stop) => stop?.()).catch(reportListenerError);
  };
}

interface Listenable<T> {
  listen: (handler: (event: Event<T>) => void) => Promise<UnlistenFn>;
}

/**
 * Calls `onEvent` with every payload until the returned function runs, and never after it. A
 * failed registration goes to `onError` (the console by default).
 */
export function subscribe<T>(
  event: Listenable<T>,
  onEvent: (payload: T) => void,
  onError?: (error: unknown) => void,
): () => void {
  let active = true;
  const release = hold(
    event.listen(({ payload }) => {
      if (active) onEvent(payload);
    }),
    onError,
  );
  return () => {
    active = false;
    release();
  };
}

export const shellEvents = {
  /** The library opened, was created, or became unavailable or read-only. */
  onLibraryStateChanged: (onEvent: (payload: LibraryStateChanged) => void) =>
    subscribe(events.libraryStateChanged, onEvent),
  /** Catalog changes, Folio's own or from other programs. */
  onCatalogChanged: (onEvent: (payload: CatalogChanged) => void) =>
    subscribe(events.catalogChanged, onEvent),
  /** A job changed state or made progress. */
  onJobChanged: (onEvent: (payload: JobChanged) => void) => subscribe(events.jobChanged, onEvent),
  /** The problem list changed. */
  onProblemsChanged: (onEvent: (payload: ProblemsChanged) => void) =>
    subscribe(events.problemsChanged, onEvent),
  /** Files or folders were dropped on the window. */
  onFilesDropped: (onEvent: (payload: FilesDropped) => void) =>
    subscribe(events.filesDropped, onEvent),
  /** Files are dragged over the window, or left it. */
  onDropHover: (onEvent: (payload: DropHover) => void) => subscribe(events.dropHover, onEvent),
  /** Files were dropped, but the shell could not take them; nothing was chosen. */
  onDropFailed: (onEvent: (payload: DropFailed) => void) => subscribe(events.dropFailed, onEvent),
  /** App settings changed: device name, theme or reduced motion. */
  onAppSettingsChanged: (onEvent: (payload: AppSettingsChanged) => void) =>
    subscribe(events.appSettingsChanged, onEvent),
  /** Folio saved new ignore rules for the library; a scan job follows. */
  onIgnoreRulesChanged: (onEvent: (payload: IgnoreRulesChanged) => void) =>
    subscribe(events.ignoreRulesChanged, onEvent),
};
