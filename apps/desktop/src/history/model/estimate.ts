// The height an entry is expected to take before it is measured: the virtualised timeline places
// entries it has not rendered yet by these, and measuring replaces them (jsdom measures nothing, so
// tests run on them).
import type { HistoryItem } from '../../ipc';
import { SIZE, SPACE } from '../../tokens/tokens';
import { cardShape } from './rows';
import type { TimelineRow } from './timelineRows';

/** One line of `font.size.small` text at the body line height (12 × 1.45). */
const SMALL_LINE = 18;

/** The lines of a commit body shown before the ellipsis (§7.2). */
const BODY_LINES = 3;

/** A file card's top and bottom border (`border.width`, 1 px each). */
const CARD_BORDERS = 2;

/** A file card before it shows all its changes: its rows, and "Show all N files" under them. */
function cardHeight(item: HistoryItem): number {
  const shape = cardShape(item);
  if (shape === null) return 0;
  const more = shape.total > shape.rows ? SPACE[4] + SIZE.targetMin : 0;
  return SPACE[8] + Math.max(1, shape.rows) * SIZE.row + CARD_BORDERS + more;
}

/** An entry with a card this tall: its padding, the title's first line, its body or note, and its day header. */
function entryHeight(item: HistoryItem, startsDay: boolean, card: number): number {
  let height = SPACE[12] + SIZE.historyIconColumn + SPACE[12] + card;
  if (item.kind === 'commit') {
    const { commit } = item;
    const body = commit.kind === 'prune' || commit.body === null || commit.body.trim() === '' ? 0 : commit.body.split('\n').length;
    if (body > 0) height += SPACE[2] + Math.min(BODY_LINES, body) * SMALL_LINE;
    if (commit.first) height += SPACE[2] + SMALL_LINE;
  }
  return startsDay ? height + SIZE.row : height;
}

/**
 * An entry: its padding, the title's first line, its body or note, its file card, and its day
 * header when it starts a day.
 */
export function estimateEntry(item: HistoryItem, startsDay: boolean): number {
  return entryHeight(item, startsDay, cardHeight(item));
}

/**
 * A row of the timeline: an entry as above; a commit of one file's history with its one-row card and
 * "and 2 other files in this commit" under it (none for the first commit, whose note counts them).
 */
export function estimateRow(row: TimelineRow, startsDay: boolean): number {
  if (row.kind !== 'version') return estimateEntry(row.item, startsDay);
  const others = row.others > 0 && !row.item.commit.first ? SPACE[4] + SMALL_LINE : 0;
  return entryHeight(row.item, startsDay, SPACE[8] + SIZE.row + CARD_BORDERS + others);
}
