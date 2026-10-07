// The type filter of the History header (handoff workspace-history §7.1): which kinds of entry the
// timeline shows. `null` shows every kind, so a kind a later version adds (M3's syncs) shows too.
import type { HistoryType } from '../../ipc';

/** The kinds the filter offers, in its menu's order: Commits · Message edits · Undone commits · Restores. */
export const HISTORY_TYPES = ['commit', 'reword', 'uncommit', 'restore'] as const satisfies readonly HistoryType[];

/** Whether a value read back from storage is a kind the filter offers. */
export function isHistoryType(value: unknown): value is HistoryType {
  return HISTORY_TYPES.some((type) => type === value);
}

/**
 * The filter that shows `types`, in the menu's order and each once: `null` (every kind) when they
 * are every kind, or none. Unchecking the last checked kind in the menu shows every kind again
 * rather than an empty timeline.
 */
export function filterOf(types: Iterable<unknown>): HistoryType[] | null {
  const chosen = new Set<unknown>(types);
  const shown = HISTORY_TYPES.filter((type) => chosen.has(type));
  return shown.length === 0 || shown.length === HISTORY_TYPES.length ? null : shown;
}

/** A filter as a string, the same for equal filters: the timeline's React key while it shows them. */
export function filterKey(filter: readonly HistoryType[] | null): string {
  return filter === null ? 'all' : filter.join(' ');
}

/** The kinds a filter shows: every kind for `null`. */
export function shownTypes(filter: readonly HistoryType[] | null): readonly HistoryType[] {
  return filter ?? HISTORY_TYPES;
}
