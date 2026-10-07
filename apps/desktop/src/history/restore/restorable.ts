// Which versions History offers to restore (handoff workspace-history §8.1; ipc-m2 §10): a version
// the commit stored of a text or Word file, not thinned out since, that the commit did not delete,
// and never a `.folio` path. In one file's history the version the file has now keeps "Restore",
// disabled with the reason (§7.4). Pure.
import type { CommitRef } from '../../app/panes';
import type { HistoryState, VersionRef } from '../../ipc';
import type { CardRow } from '../model/rows';
import type { CurrentVersion } from '../model/timelineRows';

function isFolioPath(path: string): boolean {
  return path === '.folio' || path.startsWith('.folio/');
}

/** Whether "Restore" is offered for a row's version (disabled or not). */
export function restorable(row: CardRow): boolean {
  if (row.kind !== 'file') return false;
  const { kind, change, after, path } = row.row;
  if (kind !== 'file' || change === 'deleted' || after === null) return false;
  if (row.row.class !== 'text' && row.row.class !== 'word') return false;
  return after.stored && !after.pruned && !isFolioPath(path);
}

/** The version a file row shows: its commit, as its id is now, and the row's path there. */
export function versionOfRow(commit: CommitRef, row: CardRow): VersionRef | null {
  return row.kind === 'file' && row.row.kind === 'file' ? { commit: commit.id, path: row.row.path } : null;
}

/** Whether a row's version is the one a file's history calls current ("Current version", §7.4). */
export function isCurrentVersion(commit: CommitRef, row: CardRow, current: CurrentVersion | null): boolean {
  return current !== null && row.kind === 'file' && commit.id === current.commit && row.row.key === current.key;
}

/**
 * "Restore" for a row's version: `null` when it is not offered, `current` for the version the file
 * has now, and `readOnly` or `damaged` while the history is read-only (a newer Folio's) or cannot be
 * read (§7.3, §7.5; listed, disabled with the reason), else `offered`.
 */
export function restoreOffer(
  row: CardRow,
  current: boolean,
  historyState?: HistoryState,
): 'offered' | 'current' | 'readOnly' | 'damaged' | null {
  if (!restorable(row)) return null;
  if (current) return 'current';
  return historyState === 'readOnly' || historyState === 'damaged' ? historyState : 'offered';
}

/** What a disabled Restore does when activated: nothing (the diff's and the row menu's `onRestore`). */
export const NO_RESTORE = (): void => undefined;
