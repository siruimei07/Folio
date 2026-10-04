// Which chips of the tag filter bar fit in two rows (workspace-history handoff §12.1, 33B): the
// bar lays its chips out like `flex-wrap`, and the tags that would start a third row go behind a
// "+N" chip, which itself always ends the second row.

/** The rows the bar shows at most. */
export const CHIP_ROWS = 2;

export interface ChipMeasures {
  /** The bar's content width. */
  available: number;
  gap: number;
  /** The "All" chip, which always shows. */
  first: number;
  /** Each tag's chip, in the tags' order. */
  tags: readonly number[];
  /** The "+N" chip, at its widest label. */
  more: number;
}

/** The row each chip lands on when laid out like `flex-wrap`. */
function rowsOf(widths: readonly number[], available: number, gap: number): number[] {
  const rows: number[] = [];
  let row = 0;
  let end = 0;
  for (const [index, raw] of widths.entries()) {
    // A chip wider than the bar takes a row of its own, as `flex: none` would overflow it.
    const width = Math.min(raw, available);
    if (index > 0 && end + gap + width > available) {
      row++;
      end = width;
    } else {
      end = index === 0 ? width : end + gap + width;
    }
    rows.push(row);
  }
  return rows;
}

/** How many tags show before the "+N" chip; all of them when they fit in two rows. */
export function visibleTagCount({ available, gap, first, tags, more }: ChipMeasures): number {
  if (available <= 0) return tags.length;
  // The first tag on the third row; its index among the chips counts "All".
  const overflow = rowsOf([first, ...tags], available, gap).findIndex((row) => row >= CHIP_ROWS);
  if (overflow === -1) return tags.length;
  // The tags before it, then fewer until "+N" fits on the second row.
  for (let count = overflow - 1; count > 0; count--) {
    const moreRow = rowsOf([first, ...tags.slice(0, count), more], available, gap).at(-1) ?? 0;
    if (moreRow < CHIP_ROWS) return count;
  }
  return 0;
}
