// The rows of a grid with sections (UI architecture §8.1; workspace-history handoff §12.3): label
// rows, tile rows of each section's own size, and arrows across them in reading order.
import { describe, expect, it } from 'vitest';

import { GridLayout, type GridSection } from './gridLayout';

// Folder cards (180 px, gap 8) above file tiles (150 px, gap 12) in a 700 px grid, padding 14:
// three cards or four tiles to a row.
const cards = (count: number, label?: string): GridSection => ({ count, minTileWidth: 180, tileHeight: 48, gap: 8, label });
const tiles = (count: number, label?: string): GridSection => ({ count, minTileWidth: 150, tileHeight: 150, gap: 12, label });

function layout(...sections: GridSection[]) {
  return new GridLayout({ sections, width: 700, padding: 14, labelHeight: 18, sectionGap: 12 });
}

describe('GridLayout', () => {
  it('lays out one section as before: rows of as many tiles as fit', () => {
    const grid = layout(tiles(10));
    expect(grid.rows.map((row) => (row.kind === 'tiles' ? [row.first, row.count, row.size] : row.kind))).toEqual([
      [0, 4, 162],
      [4, 4, 162],
      [8, 2, 150],
    ]);
    expect(grid.maxColumns).toBe(4);
  });

  it('puts each section under its label, with its own columns and sizes', () => {
    const grid = layout(cards(5, 'Folders'), tiles(6, 'Files'));
    expect(grid.rows.map((row) => (row.kind === 'tiles' ? `${String(row.first)}+${String(row.count)}/${String(row.size)}` : `label/${String(row.size)}`))).toEqual([
      'label/30',
      '0+3/56',
      // The last card row ends with the gap between sections.
      '3+2/60',
      'label/30',
      '5+4/162',
      '9+2/150',
    ]);
    expect(grid.tileRows.map((row) => row.tileRow)).toEqual([0, 1, 2, 3]);
    expect(grid.maxColumns).toBe(4);
    expect(grid.rowOfItem(4)).toBe(2);
    expect(grid.rowOfItem(5)).toBe(4);
  });

  it('leaves out a section without items, and its label', () => {
    const grid = layout(cards(0, 'Folders'), tiles(3, 'Files'));
    expect(grid.rows.map((row) => row.kind)).toEqual(['label', 'tiles']);
    expect(grid.tileRows[0]?.first).toBe(0);
  });

  it('moves up and down in the same column, across sections as far as a row has it', () => {
    const grid = layout(cards(5), tiles(6));
    // Card 1 (row 0, column 1) → card 4 (row 1, column 1) → tile 6 (column 1) → tile 10.
    expect(grid.move(1, 1, false)).toBe(4);
    expect(grid.move(4, 1, false)).toBe(6);
    expect(grid.move(6, 1, false)).toBe(10);
    expect(grid.move(10, 1, false)).toBeNull();
    // Card 2 has nothing below it in its section's last row: no move, as in one grid.
    expect(grid.move(2, 1, false)).toBeNull();
    // Tile 8 (column 3) goes up to the last card of the row above.
    expect(grid.move(8, -1, false)).toBe(4);
    expect(grid.move(0, -1, false)).toBeNull();
  });

  it('pages to the last row that starts within the view, keeping the column as far as a row has it', () => {
    // Rows of 56, 60 (cards), 162, 162 and 150 px (tiles).
    const grid = layout(cards(5), tiles(10));
    const view = (height: number) => ({ height });
    // From card 1, 130 px down: the rows 56 and 116 px away start in view; tile 6 is in column 1.
    expect(grid.move(1, 1, view(130))).toBe(6);
    expect(grid.move(6, 1, view(200))).toBe(10);
    expect(grid.move(14, -1, view(200))).toBe(10);
    // Past either end: the last or the first row.
    expect(grid.move(3, 1, view(10_000))).toBe(13);
    expect(grid.move(14, -1, view(10_000))).toBe(1);
    // A short row: its last item. A view shorter than a row still moves one row.
    expect(grid.move(2, 1, view(60))).toBe(4);
    expect(grid.move(1, 1, view(10))).toBe(4);
  });

  it('gives the items of a range of virtual rows', () => {
    const grid = layout(cards(5, 'Folders'), tiles(6, 'Files'));
    expect(grid.itemRange(0, 1)).toEqual({ start: 0, end: 2 });
    expect(grid.itemRange(2, 4)).toEqual({ start: 3, end: 8 });
    expect(grid.itemRange(3, 3)).toBeNull();
  });

  it('changes its sizes key when the columns change', () => {
    const wide = layout(cards(5), tiles(6));
    const narrow = new GridLayout({ sections: [cards(5), tiles(6)], width: 400, padding: 14, labelHeight: 18, sectionGap: 12 });
    expect(narrow.sizesKey).not.toBe(wide.sizesKey);
  });
});
