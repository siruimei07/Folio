// Restoring a version in the History view (handoff workspace-history §8, §7.2, §14): the
// confirmation asked for, from the diff's "Restore" or a file row's menu, and the restore entry
// that arrives in the timeline afterwards, highlighted for `FRESH_COMMIT_MS`. The confirmation
// belongs to the view (plan decision 4): it keeps History's selection and scroll, and another
// library's screen closes it.
import { useEffect } from 'react';
import { create } from 'zustand';

import { historyItemKey } from '../../data/history';
import type { HistoryItem, VersionRef } from '../../ipc';
import { FRESH_COMMIT_MS } from '../../lib/timing';

export interface RestoreRequest {
  /** The version: its commit, as its id is now, and its path there. */
  version: VersionRef;
  /** That commit's own time: "Restore Midterm review.md to Oct 13?". */
  versionMs: number;
  /**
   * Puts the focus back where the confirmation was asked from once it has closed: "Restore" (or
   * "More") in the diff, or the row whose menu asked. React Aria does it while that element is in
   * the page; this covers one replaced meanwhile (Restore turning disabled).
   */
  refocus: () => void;
}

/** The confirmation asked for: a new one (`serial`) starts afresh; `open` false while it closes. */
export interface AskedRestore {
  request: RestoreRequest;
  serial: number;
  open: boolean;
}

/** The restore entry the timeline is waiting for, then highlighting. */
export interface FreshRestore {
  version: VersionRef;
  /** The restore entries listed when the restore started: none of them is the new one. */
  known: ReadonlySet<string>;
  /** The new entry's key once a timeline has listed it. */
  key: string | null;
}

interface RestoreState {
  asked: AskedRestore | null;
  fresh: FreshRestore | null;
}

export const useRestore = create<RestoreState>()(() => ({ asked: null, fresh: null }));

let serial = 0;
let freshTimer: ReturnType<typeof setTimeout> | undefined;

function clearFreshTimer(): void {
  if (freshTimer !== undefined) clearTimeout(freshTimer);
  freshTimer = undefined;
}

/** Forgets the fresh restore `FRESH_COMMIT_MS` from now, if it then still `holds`. */
function expireFresh(holds: (fresh: FreshRestore | null) => boolean): void {
  clearFreshTimer();
  freshTimer = setTimeout(() => {
    freshTimer = undefined;
    if (holds(useRestore.getState().fresh)) useRestore.setState({ fresh: null });
  }, FRESH_COMMIT_MS);
}

/** Opens the confirmation for a version (§8.2). */
export function askRestore(request: RestoreRequest): void {
  serial += 1;
  useRestore.setState({ asked: { request, serial, open: true } });
}

/** Closes the confirmation `serial`, unless another one has replaced it. */
export function closeRestore(which: number): void {
  const { asked } = useRestore.getState();
  if (asked?.serial === which && asked.open) useRestore.setState({ asked: { ...asked, open: false } });
}

/** A restore starts: the next restore entry of this version that is not among `known` is the new one. */
export function startFresh(version: VersionRef, known: ReadonlySet<string>): void {
  clearFreshTimer();
  useRestore.setState({ fresh: { version, known, key: null } });
}

/** The restore failed or changed nothing: no entry is coming. */
export function dropFresh(): void {
  clearFreshTimer();
  useRestore.setState({ fresh: null });
}

/**
 * The restore is done: its entry is on its way. One no timeline lists within `FRESH_COMMIT_MS`
 * (a type filter without restores, another file's history) is not waited for any longer.
 */
export function settleFresh(): void {
  // Nothing waited for, or already listed.
  if (useRestore.getState().fresh?.key !== null) return;
  expireFresh((fresh) => fresh?.key === null);
}

/** A timeline lists the new entry: it stays highlighted for `FRESH_COMMIT_MS` from now. */
export function seeFresh(key: string): void {
  const { fresh } = useRestore.getState();
  // Nothing waited for, or already listed.
  if (fresh?.key !== null) return;
  useRestore.setState({ fresh: { ...fresh, key } });
  expireFresh(() => true);
}

/** The key of the new restore entry among `items`, `null` while they do not list it. Pure. */
export function freshEntryKey(items: readonly HistoryItem[], fresh: FreshRestore | null): string | null {
  if (fresh === null) return null;
  if (fresh.key !== null) return fresh.key;
  const { version, known } = fresh;
  const item = items.find(
    (entry) => entry.kind === 'restore' && entry.commit === version.commit && entry.path === version.path && !known.has(historyItemKey(entry)),
  );
  return item === undefined ? null : historyItemKey(item);
}

/**
 * The key of the restore entry to highlight among a timeline's `items` (§7.2, §14): known in the
 * render that first lists it, so it fades and rises in as it appears; its `FRESH_COMMIT_MS` start
 * then.
 */
export function useFreshEntry(items: readonly HistoryItem[]): string | null {
  const fresh = useRestore((state) => state.fresh);
  const key = freshEntryKey(items, fresh);
  useEffect(() => {
    if (key !== null) seeFresh(key);
  }, [key]);
  return key;
}

/** The keys of the restore entries among `items`, for `startFresh`. Pure. */
export function restoreKeys(items: readonly HistoryItem[]): ReadonlySet<string> {
  return new Set(items.filter((item) => item.kind === 'restore').map(historyItemKey));
}

/** Nothing asked, nothing highlighted: another library's screen, or a test. */
export function resetRestore(): void {
  clearFreshTimer();
  useRestore.setState({ asked: null, fresh: null });
}
