// The rows of a virtualised grid (UI architecture §8.1): one section of tiles, or several, each
// with tiles of its own size and an optional label row above them, such as the Library's folder
// cards above its file tiles (workspace-history handoff §12.3). Items keep one index order across
// the sections; arrows treat them as one grid in reading order.
import type { ReactNode } from 'react';

/** A run of items with tiles of one size. */
export interface GridSection {
  /** Items in it; the sections follow each other in index order. */
  count: number;
  /** Tiles are at least this wide; the columns share the rest. */
  minTileWidth: number;
  tileHeight: number;
  /** Between its tiles, both ways. */
  gap: number;
  /** A row above its tiles, such as "Folders 5"; none without it. */
  label?: ReactNode;
}

/** A virtual row: a section's label, or a row of its tiles. `size` includes the space below it. */
export type GridRow =
  | { kind: 'label'; label: ReactNode; size: number }
  | {
      kind: 'tiles';
      /** The index of its first item. */
      first: number;
      count: number;
      columns: number;
      tileHeight: number;
      gap: number;
      /** The section it belongs to. */
      section: number;
      /** Its index among the virtual rows. */
      row: number;
      /** Its place among the rows of tiles, from 0 (`aria-rowindex` less one). */
      tileRow: number;
      size: number;
    };

type TileRow = Extract<GridRow, { kind: 'tiles' }>;

/** How many tiles fit a row: ⌊(width + gap) / (min + gap)⌋, at least one (UI architecture §8.1). */
export function columnsFor(width: number, minTileWidth: number, gap: number, padding: number): number {
  return Math.max(1, Math.floor((width - 2 * padding + gap) / (minTileWidth + gap)));
}

export interface GridLayoutOptions {
  sections: readonly GridSection[];
  /** The grid's width, its padding included. */
  width: number;
  /** Around the tiles. */
  padding: number;
  /** A label row's own height. */
  labelHeight: number;
  /** Below a label row, and between one section's tiles and the next section. */
  sectionGap: number;
}

export class GridLayout {
  readonly rows: readonly GridRow[];
  /** The rows of tiles, in order. */
  readonly tileRows: readonly TileRow[];
  /** The most columns of any section (`aria-colcount`). */
  readonly maxColumns: number;
  /** Every row's size and items in one string: when it changes, the virtualiser measures again. */
  readonly sizesKey: string;

  constructor({ sections, width, padding, labelHeight, sectionGap }: GridLayoutOptions) {
    const rows: GridRow[] = [];
    const tileRows: TileRow[] = [];
    const key: string[] = [String(labelHeight), String(sectionGap)];
    const lastShown = sections.findLastIndex((section) => section.count > 0);
    let first = 0;
    let maxColumns = 1;
    for (const [index, section] of sections.entries()) {
      if (section.count === 0) continue;
      const { count, tileHeight, gap, label } = section;
      const columns = columnsFor(width, section.minTileWidth, gap, padding);
      maxColumns = Math.max(maxColumns, columns);
      key.push(`${String(label !== undefined)}:${String(count)}:${String(columns)}:${String(tileHeight)}:${String(gap)}`);
      if (label !== undefined) rows.push({ kind: 'label', label, size: labelHeight + sectionGap });
      const lines = Math.ceil(count / columns);
      for (let line = 0; line < lines; line++) {
        const after = line < lines - 1 ? gap : index === lastShown ? 0 : sectionGap;
        const tiles: TileRow = {
          kind: 'tiles',
          first: first + line * columns,
          count: Math.min(columns, count - line * columns),
          columns,
          tileHeight,
          gap,
          section: index,
          row: rows.length,
          tileRow: tileRows.length,
          size: tileHeight + after,
        };
        rows.push(tiles);
        tileRows.push(tiles);
      }
      first += count;
    }
    this.rows = rows;
    this.tileRows = tileRows;
    this.maxColumns = maxColumns;
    this.sizesKey = key.join('|');
  }

  /** The virtual row an item is in. */
  rowOfItem(index: number): number {
    return this.tileRowOf(index)?.row ?? 0;
  }

  /** The row of tiles an item is in, by binary search; `null` outside the items. */
  tileRowOf(index: number): TileRow | null {
    let low = 0;
    let high = this.tileRows.length - 1;
    while (low <= high) {
      const middle = (low + high) >> 1;
      const row = this.tileRows[middle];
      if (row === undefined) break;
      if (index < row.first) high = middle - 1;
      else if (index >= row.first + row.count) low = middle + 1;
      else return row;
    }
    return null;
  }

  /**
   * Where Up and Down (`page` false) or Page Up and Page Down (`page` true, a view `height` tall)
   * move from an item, `step` -1 up and 1 down: the same column of the row of tiles above or below,
   * or of the last one that starts within the height (at least the next one); `null` for nowhere.
   * A row of the same section that lacks the column is no move for an arrow, as in a single grid;
   * otherwise the column is kept as far as the row has it.
   */
  move(index: number, step: 1 | -1, page: false | { height: number }): number | null {
    const from = this.tileRowOf(index);
    if (from === null) return null;
    let to = this.tileRows[from.tileRow + step];
    if (page !== false) {
      let distance = 0;
      for (let row = from.row + step; row >= 0 && row < this.rows.length; row += step) {
        distance += this.rows[step > 0 ? row - 1 : row]?.size ?? 0;
        const target = this.rows[row];
        if (distance > page.height) break;
        if (target?.kind === 'tiles') to = target;
      }
    }
    if (to === undefined) return null;
    const column = index - from.first;
    if (column < to.count) return to.first + column;
    return page === false && to.section === from.section ? null : to.first + to.count - 1;
  }

  /** The virtual rows from `start` to `end` as the items they hold, first and last included. */
  itemRange(start: number, end: number): { start: number; end: number } | null {
    let first: TileRow | undefined;
    let last: TileRow | undefined;
    for (let row = start; row <= end; row++) {
      const candidate = this.rows[row];
      if (candidate?.kind !== 'tiles') continue;
      first ??= candidate;
      last = candidate;
    }
    return first === undefined || last === undefined ? null : { start: first.first, end: last.first + last.count - 1 };
  }
}
