// The row a file card shows in the diff (handoff workspace-history §7.2, §7.6; plan decision 3):
// kept by the card it was selected in and the row's id, and found again after a message edit. A
// reword gives the commit and every later one a new id but keeps their times, devices and changes
// (versioning §8.3), so a commit card is found again by its time and device, and its row by its
// path. A restore entry's card keeps its key; only the restored version's commit id moves. Pure.
import { historyItemKey } from '../../data/history';
import type { CommitInfo, HistoryItem } from '../../ipc';
import type { CommitRef, DiffTarget } from '../../app/panes';
import { effectiveMsOf } from './entries';
import { type CardRow, cardRowId, cardRowPath } from './rows';

/** The card a row was selected in. */
export type CardAnchor =
  | { kind: 'commit'; id: string; timeMs: string; device: string; effectiveMs: number }
  | { kind: 'restore'; key: string; effectiveMs: number };

export interface HistorySelection {
  card: CardAnchor;
  /** The version's commit: the commit card's own, or the restored version's. */
  commit: CommitRef;
  row: CardRow;
}

/** A commit's identity across message edits: its own time and its device (versioning §8.3). */
export function commitAnchorKey(commit: Pick<CommitInfo, 'timeMs' | 'device'>): string {
  return `${commit.timeMs} ${commit.device.id}`;
}

export function commitAnchor(commit: CommitInfo): CardAnchor {
  return {
    kind: 'commit',
    id: commit.id,
    timeMs: commit.timeMs,
    device: commit.device.id,
    effectiveMs: Number(commit.effectiveMs),
  };
}

/** Whether `anchor` is the card of `item`. */
export function isCardOf(anchor: CardAnchor, item: HistoryItem): boolean {
  if (anchor.kind === 'commit') return item.kind === 'commit' && item.commit.id === anchor.id;
  return item.kind === 'restore' && historyItemKey(item) === anchor.key;
}

/** The id of the row `selection` shows when it is in the card of `item`, else `null`. */
export function selectedRowIn(selection: HistorySelection | null, item: HistoryItem): string | null {
  return selection !== null && isCardOf(selection.card, item) ? cardRowId(selection.row) : null;
}

/** What the diff pane shows for the selection. */
export function selectionTarget(selection: HistorySelection): DiffTarget {
  const { commit, row } = selection;
  return row.kind === 'file'
    ? { kind: 'version', commit, row: row.row }
    : { kind: 'versionMetadata', commit, change: row.change };
}

/**
 * The selection once the timeline's entries changed: `undefined` when it stands as it is, a new
 * selection when a message edit gave its commit a new id, `null` when its entry is gone (an undone
 * commit, a filter that leaves it out). An entry missing from a list that has not been read as far
 * back as it is may be on a later page, and stays; one missing from a list read to its end
 * (`complete`) is gone, however new the entries listed are.
 */
export function reanchor(
  selection: HistorySelection,
  items: readonly HistoryItem[],
  complete: boolean,
): HistorySelection | null | undefined {
  const { card } = selection;
  if (card.kind === 'restore') {
    const entry = items.find((item) => isCardOf(card, item));
    if (entry?.kind === 'restore') {
      return entry.commit === selection.commit.id ? undefined : { ...selection, commit: { ...selection.commit, id: entry.commit } };
    }
  } else {
    if (items.some((item) => isCardOf(card, item))) return undefined;
    const edited = items.find(
      (item) => item.kind === 'commit' && item.commit.timeMs === card.timeMs && item.commit.device.id === card.device,
    );
    if (edited?.kind === 'commit') {
      const { id, timeMs } = edited.commit;
      return { ...selection, card: { ...card, id }, commit: { id, timeMs } };
    }
  }
  if (complete) return null;
  const last = items.at(-1);
  return last !== undefined && effectiveMsOf(last) <= card.effectiveMs ? null : undefined;
}

/**
 * The row of a card that the selection names once the card's rows changed: `undefined` when its
 * row is among them or no row has its path, else the row with its path (a change key that moved
 * with the commit's id).
 */
export function refindRow(selection: HistorySelection, rows: readonly CardRow[]): CardRow | undefined {
  const id = cardRowId(selection.row);
  if (rows.some((row) => cardRowId(row) === id)) return undefined;
  const path = cardRowPath(selection.row);
  if (path === null) return undefined;
  return rows.find((row) => row.kind === selection.row.kind && cardRowPath(row) === path);
}
