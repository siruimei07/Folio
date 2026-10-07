// The virtualised collections (UI architecture §7.2): their ARIA attributes and keyboard patterns,
// driven by hand-made rows so each behaviour is visible on its own.
import { act, render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { useCallback, useState } from 'react';
import { describe, expect, it, onTestFinished, vi } from 'vitest';

import { focusBlurrer } from '../../test/focus';
import { mockLayout, mockScrolling } from '../../test/virtual';
import type { Move } from './selection';
import { columnsFor, VirtualGrid } from './VirtualGrid';
import { type CollectionItem, VirtualList } from './VirtualList';
import { type TreeRow, VirtualTree } from './VirtualTree';

function layout() {
  onTestFinished(mockLayout());
}

/** Lets timers and microtasks run for `ms`. */
async function wait(ms: number) {
  await act(() => new Promise((resolve) => setTimeout(resolve, ms)));
}

interface Node {
  name: string;
  level: number;
  expanded?: boolean;
  focusable?: boolean;
  separator?: boolean;
}

const NODES: Node[] = [
  { name: 'Recently added', level: 1 },
  { name: '—', level: 1, separator: true, focusable: false },
  { name: 'Algebra', level: 1, expanded: true },
  { name: 'Notes', level: 2, expanded: false },
  { name: 'Empty', level: 2, focusable: false },
  { name: 'Calculus', level: 1, expanded: false },
  { name: 'Biology', level: 1 },
];

function Tree({ onExpand, onAction, onToggle, moves, initialFocus = null }: {
  onExpand?: (index: number, expanded: boolean) => void;
  onAction?: (index: number) => void;
  onToggle?: (index: number) => void;
  moves?: Move[];
  initialFocus?: number | null;
}) {
  const [focused, setFocused] = useState<number | null>(initialFocus);
  const rowAt = (index: number): TreeRow => {
    const node = NODES[index] ?? NODES[0];
    if (node === undefined) throw new Error('no rows');
    return {
      key: String(index),
      kind: node.separator === true ? 'separator' : 'item',
      focusable: node.focusable ?? true,
      level: node.level,
      posinset: 1,
      setsize: 1,
      expanded: node.expanded,
      selected: index === focused,
      name: node.name,
    };
  };
  return (
    <VirtualTree
      label="Courses"
      count={NODES.length}
      rowAt={rowAt}
      rowHeight={() => 32}
      renderRow={(index) => <span>{NODES[index]?.name}</span>}
      focusedIndex={focused}
      onNavigate={(index, move) => {
        moves?.push(move);
        setFocused(index);
      }}
      onToggle={onToggle ?? vi.fn()}
      onExpand={onExpand ?? vi.fn()}
      onAction={onAction ?? vi.fn()}
    />
  );
}

describe('VirtualTree', () => {
  it('renders treeitems with their level and expansion, and separators that screen readers skip', () => {
    layout();
    render(<Tree />);
    const tree = screen.getByRole('tree', { name: 'Courses' });
    expect(tree).toHaveAttribute('aria-multiselectable', 'true');
    expect(screen.getAllByRole('treeitem').map((row) => row.textContent)).toEqual([
      'Recently added',
      'Algebra',
      'Notes',
      'Empty',
      'Calculus',
      'Biology',
    ]);
    expect(screen.getByRole('treeitem', { name: 'Notes' })).toHaveAttribute('aria-level', '2');
    expect(screen.getByRole('treeitem', { name: 'Algebra' })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('treeitem', { name: 'Empty' })).toHaveAttribute('aria-disabled', 'true');
    // One tab stop: the first focusable row.
    expect(screen.getByRole('treeitem', { name: 'Recently added' })).toHaveAttribute('tabindex', '0');
    expect(screen.getByRole('treeitem', { name: 'Algebra' })).toHaveAttribute('tabindex', '-1');
  });

  it('gives the tab stop to the nearest row above when the focused index cannot hold it', () => {
    layout();
    // After a delete, the focused index can point at a separator, a row that is not focusable, or
    // past the end; one row still holds the tab stop.
    const { unmount } = render(<Tree initialFocus={1} />);
    expect(screen.getByRole('treeitem', { name: 'Recently added' })).toHaveAttribute('tabindex', '0');
    unmount();
    const second = render(<Tree initialFocus={4} />);
    expect(screen.getByRole('treeitem', { name: 'Notes' })).toHaveAttribute('tabindex', '0');
    second.unmount();
    render(<Tree initialFocus={40} />);
    expect(screen.getByRole('treeitem', { name: 'Biology' })).toHaveAttribute('tabindex', '0');
  });

  it('moves with the arrows past rows it cannot stop on; Shift extends and Ctrl only moves focus', async () => {
    layout();
    const moves: Move[] = [];
    const user = userEvent.setup();
    render(<Tree moves={moves} />);
    screen.getByRole('treeitem', { name: 'Recently added' }).focus();
    await user.keyboard('{ArrowDown}');
    expect(screen.getByRole('treeitem', { name: 'Algebra' })).toHaveFocus();
    await user.keyboard('{ArrowDown}{ArrowDown}');
    expect(screen.getByRole('treeitem', { name: 'Calculus' })).toHaveFocus();
    await user.keyboard('{Shift>}{ArrowDown}{/Shift}{Control>}{ArrowUp}{/Control}');
    expect(moves).toEqual(['replace', 'replace', 'replace', 'extend', 'focus']);
    await user.keyboard('{End}');
    expect(screen.getByRole('treeitem', { name: 'Biology' })).toHaveFocus();
    await user.keyboard('{Home}');
    expect(screen.getByRole('treeitem', { name: 'Recently added' })).toHaveFocus();
  });

  it('expands with Right, enters an expanded row, goes to the parent and collapses with Left', async () => {
    layout();
    const onExpand = vi.fn();
    const user = userEvent.setup();
    render(<Tree onExpand={onExpand} />);
    screen.getByRole('treeitem', { name: 'Calculus' }).focus();
    await user.keyboard('{ArrowRight}');
    expect(onExpand).toHaveBeenLastCalledWith(5, true);

    screen.getByRole('treeitem', { name: 'Algebra' }).focus();
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('treeitem', { name: 'Notes' })).toHaveFocus();
    await user.keyboard('{ArrowLeft}');
    expect(screen.getByRole('treeitem', { name: 'Algebra' })).toHaveFocus();
    await user.keyboard('{ArrowLeft}');
    expect(onExpand).toHaveBeenLastCalledWith(2, false);
  });

  it('finds rows by typing their names, and acts on Enter and Space', async () => {
    layout();
    const onAction = vi.fn();
    const onToggle = vi.fn();
    const user = userEvent.setup();
    render(<Tree onAction={onAction} onToggle={onToggle} />);
    screen.getByRole('treeitem', { name: 'Recently added' }).focus();
    await user.keyboard('ca');
    expect(screen.getByRole('treeitem', { name: 'Calculus' })).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(onAction).toHaveBeenCalledWith(5);
    // A space right after typing continues the search; Ctrl+Space toggles the selection.
    await user.keyboard('{Control>} {/Control}');
    expect(onToggle).toHaveBeenCalledWith(5);
  });
});

const NAMES = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta', 'theta', 'iota'];

function List({ onSelectAll }: { onSelectAll: () => void }) {
  const [focused, setFocused] = useState<number | null>(null);
  const itemAt = (index: number): CollectionItem => ({ key: String(index), selected: false, name: NAMES[index] });
  return (
    <VirtualList
      label="Files"
      count={NAMES.length}
      itemAt={itemAt}
      itemHeight={32}
      renderItem={(index) => NAMES[index]}
      focusedIndex={focused}
      onNavigate={setFocused}
      onToggle={vi.fn()}
      onAction={vi.fn()}
      onSelectAll={onSelectAll}
    />
  );
}

interface CheckedRow {
  name: string;
  checked?: boolean | 'mixed';
  header?: boolean;
}

const HEADER_ROW: CheckedRow = { name: 'Tags and settings', header: true };

/** Changes with check boxes, then a tag change without one under a header row. */
const CHECKED_ROWS: CheckedRow[] = [
  { name: 'alpha', checked: true },
  { name: 'beta', checked: false },
  { name: 'gamma' },
  HEADER_ROW,
  { name: 'delta', checked: true },
  { name: 'epsilon', checked: false },
];

/** A list like the Changes list: one option is selected, options carry check boxes, a header row is 28 px. */
function CheckedList({
  rows,
  initialFocus = null,
  onRowClick,
}: {
  rows: readonly CheckedRow[];
  initialFocus?: number | null;
  onRowClick?: (index: number, intent: string, event: unknown) => void;
}) {
  const [focused, setFocused] = useState<number | null>(initialFocus);
  const header = rows.findIndex((row) => row.header === true);
  const itemAt = (index: number): CollectionItem => {
    const row = rows[index] ?? { name: '' };
    if (row.header === true) return { key: 'header', selected: false, header: true };
    return {
      key: row.name,
      selected: index === focused,
      name: row.name,
      checked: row.checked,
      position: header >= 0 && index > header ? index : index + 1,
      description: header >= 0 && index > header ? 'always' : undefined,
    };
  };
  return (
    <VirtualList
      label="Changes"
      count={rows.length}
      optionCount={rows.length - (header >= 0 ? 1 : 0)}
      multiselectable={false}
      itemAt={itemAt}
      itemHeight={(index) => (index === header ? 28 : 32)}
      sizesKey={String(header)}
      renderItem={(index) => rows[index]?.name}
      focusedIndex={focused}
      onNavigate={setFocused}
      onToggle={vi.fn()}
      onAction={vi.fn()}
      onRowClick={onRowClick}
    />
  );
}

/** A list of rows known by their keys, which keeps its first visible row when rows above it change. */
function KeyedList({ keys }: { keys: readonly string[] }) {
  const indexes = new Map(keys.map((key, index) => [key, index]));
  return (
    <VirtualList
      label="Keyed"
      count={keys.length}
      itemAt={(index) => ({ key: keys[index] ?? '', selected: false, name: keys[index] })}
      itemHeight={32}
      renderItem={(index) => keys[index]}
      focusedIndex={null}
      onNavigate={vi.fn()}
      onToggle={vi.fn()}
      onAction={vi.fn()}
      anchor={{ keyAt: (index) => keys[index] ?? '', indexOfKey: (key) => indexes.get(key) ?? null }}
    />
  );
}

describe('VirtualList', () => {
  it('is a multi-select list box whose options know their place, with Ctrl+A', async () => {
    layout();
    const onSelectAll = vi.fn();
    const user = userEvent.setup();
    render(<List onSelectAll={onSelectAll} />);
    expect(screen.getByRole('listbox', { name: 'Files' })).toHaveAttribute('aria-multiselectable', 'true');
    const gamma = screen.getByRole('option', { name: 'gamma' });
    expect(gamma).toHaveAttribute('aria-posinset', '3');
    expect(gamma).toHaveAttribute('aria-setsize', '9');
    screen.getByRole('option', { name: 'alpha' }).focus();
    await user.keyboard('{End}');
    expect(screen.getByRole('option', { name: 'iota' })).toHaveFocus();
    await user.keyboard('{Control>}a{/Control}');
    expect(onSelectAll).toHaveBeenCalled();
  });

  it('checks options apart from selecting them, and shows header rows that are not options', () => {
    layout();
    render(<CheckedList rows={CHECKED_ROWS} />);
    expect(screen.getByRole('listbox', { name: 'Changes' })).toHaveAttribute('aria-multiselectable', 'false');
    expect(screen.getByRole('option', { name: 'alpha' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('option', { name: 'beta' })).toHaveAttribute('aria-checked', 'false');
    // An option without a check box, like a tag change that every commit records.
    expect(screen.getByRole('option', { name: 'gamma' })).not.toHaveAttribute('aria-checked');
    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual(['alpha', 'beta', 'gamma', 'delta', 'epsilon']);
    // The header shows, but screen readers pass it by; the options count without it.
    const header = screen.getByText('Tags and settings');
    expect(header.closest('[data-index]')).toHaveAttribute('aria-hidden', 'true');
    const delta = screen.getByRole('option', { name: 'delta' });
    expect(delta).toHaveAttribute('aria-posinset', '4');
    expect(delta).toHaveAttribute('aria-setsize', '5');
    expect(delta).toHaveAttribute('aria-describedby', 'always');
  });

  it('passes header rows by with the keys, type-ahead and clicks, and never gives them the tab stop', async () => {
    layout();
    const user = userEvent.setup();
    const onRowClick = vi.fn();
    const { unmount } = render(<CheckedList rows={CHECKED_ROWS} onRowClick={onRowClick} />);
    screen.getByRole('option', { name: 'gamma' }).focus();
    await user.keyboard('{ArrowDown}');
    expect(screen.getByRole('option', { name: 'delta' })).toHaveFocus();
    await user.keyboard('{ArrowUp}');
    expect(screen.getByRole('option', { name: 'gamma' })).toHaveFocus();
    await user.keyboard('{Home}t');
    // Only "Tags and settings" starts with t, and it is no option: type-ahead stays.
    expect(screen.getByRole('option', { name: 'alpha' })).toHaveFocus();
    await user.click(screen.getByText('Tags and settings'));
    expect(onRowClick).not.toHaveBeenCalled();
    await user.click(screen.getByText('beta'));
    expect(onRowClick).toHaveBeenCalledWith(1, 'replace', expect.anything());
    unmount();
    // When the focused row's place holds a header (the row above it went), the next option takes it.
    render(<CheckedList rows={CHECKED_ROWS} initialFocus={3} />);
    expect(screen.getByRole('option', { name: 'delta' })).toHaveAttribute('tabindex', '0');
  });

  it('gives each row its own height, and lays them out again when they move', () => {
    layout();
    const offsetOf = (name: string) => screen.getByRole('option', { name }).style.transform;
    const { rerender } = render(<CheckedList rows={CHECKED_ROWS} />);
    expect(screen.getByText('Tags and settings').closest('[data-index]')).toHaveStyle({ height: '28px' });
    expect(offsetOf('delta')).toBe('translateY(124px)');
    // The header moves up a row: the same count, other heights.
    const moved = [CHECKED_ROWS[0], HEADER_ROW, CHECKED_ROWS[1], CHECKED_ROWS[2], CHECKED_ROWS[4], CHECKED_ROWS[5]].filter(
      (row) => row !== undefined,
    );
    rerender(<CheckedList rows={moved} />);
    expect(offsetOf('beta')).toBe('translateY(60px)');
    expect(offsetOf('delta')).toBe('translateY(124px)');
  });

  it('checks a group option as mixed when some of what it covers is checked', () => {
    layout();
    render(<CheckedList rows={[{ name: 'MAT232', checked: 'mixed' }, { name: 'alpha', checked: true }, { name: 'beta', checked: false }]} />);
    expect(screen.getByRole('option', { name: 'MAT232' })).toHaveAttribute('aria-checked', 'mixed');
  });

  it('keeps the first visible row in place when rows come or go above it, found by its key', async () => {
    layout();
    mockScrolling();
    const rows = Array.from({ length: 100 }, (_, index) => `row ${String(index)}`);
    const { rerender } = render(<KeyedList keys={rows} />);
    const list = screen.getByRole('listbox', { name: 'Keyed' });
    act(() => {
      list.scrollTo({ top: 320 });
    });
    await wait(10);
    const onScreen = (name: string) => {
      const match = /translateY\((\d+)px\)/.exec(screen.getByRole('option', { name }).style.transform);
      return Number(match?.[1]) - list.scrollTop;
    };
    expect(onScreen('row 10')).toBe(0);
    rerender(<KeyedList keys={['new a', 'new b', ...rows]} />);
    expect(onScreen('row 10')).toBe(0);
    expect(list.scrollTop).toBe(384);
    await wait(10);
    rerender(<KeyedList keys={rows.slice(3)} />);
    expect(onScreen('row 10')).toBe(0);
    expect(list.scrollTop).toBe(224);
    // At the very top nothing is kept: what arrives above shows.
    act(() => {
      list.scrollTo({ top: 0 });
    });
    await wait(10);
    rerender(<KeyedList keys={['newest', ...rows.slice(3)]} />);
    expect(list.scrollTop).toBe(0);
    expect(onScreen('newest')).toBe(0);
  });

  it('keeps focus on the focused item when its element is replaced, as when its page arrives', async () => {
    layout();
    const user = userEvent.setup();
    function Loading({ loaded }: { loaded: boolean }) {
      const [focused, setFocused] = useState<number | null>(null);
      // An unloaded item is a placeholder with a key of its own (`data/paged.ts`).
      const itemAt = (index: number): CollectionItem => ({
        key: loaded || index < 4 ? NAMES[index] ?? '' : `placeholder:${String(index)}`,
        selected: false,
        name: loaded || index < 4 ? NAMES[index] : undefined,
      });
      return (
        <VirtualList
          label="Files"
          count={NAMES.length}
          itemAt={itemAt}
          itemHeight={32}
          renderItem={(index) => (loaded || index < 4 ? NAMES[index] : '…')}
          focusedIndex={focused}
          onNavigate={setFocused}
          onToggle={vi.fn()}
          onAction={vi.fn()}
        />
      );
    }
    const { rerender } = render(<Loading loaded={false} />);
    screen.getByRole('option', { name: 'alpha' }).focus();
    await user.keyboard('{End}');
    expect(document.activeElement).toHaveAttribute('aria-posinset', '9');
    const placeholder = document.activeElement;
    rerender(<Loading loaded />);
    expect(placeholder?.isConnected).toBe(false);
    await waitFor(() => {
      expect(screen.getByRole('option', { name: 'iota' })).toHaveFocus();
    });
  });

  it('lets the focus go where the person puts it, even when the list renders before it hears the blur', async () => {
    // Each listener of the blur runs on its own, with the microtasks it queues (React's commit)
    // after it, as in Chromium: the name field in a row ends its edit on its own focusout, which
    // runs before the list's bubbling listeners do, and removes it.
    const blur = focusBlurrer();
    layout();
    function Editing({ suffix = '' }: { suffix?: string }) {
      const [focused, setFocused] = useState<number | null>(0);
      const [editing, setEditing] = useState(true);
      const field = useCallback((element: HTMLInputElement | null) => {
        if (element === null) return undefined;
        const stop = () => {
          setEditing(false);
        };
        element.addEventListener('focusout', stop);
        return () => {
          element.removeEventListener('focusout', stop);
        };
      }, []);
      const itemAt = (index: number): CollectionItem => ({ key: String(index), selected: index === focused, name: NAMES[index] });
      return (
        <VirtualList
          label="Files"
          count={NAMES.length}
          itemAt={itemAt}
          itemHeight={32}
          renderItem={(index) =>
            index === 0 && editing ? (
              <input ref={field} aria-label="Name" defaultValue={NAMES[0]} />
            ) : (
              `${NAMES[index] ?? ''}${suffix}`
            )
          }
          focusedIndex={focused}
          onNavigate={setFocused}
          onToggle={vi.fn()}
          onAction={vi.fn()}
        />
      );
    }
    const { rerender } = render(<Editing />);
    const field = screen.getByRole('textbox', { name: 'Name' });
    act(() => {
      field.focus();
    });
    // The virtualiser's first measure renders the rows again; the list hears that before the blur,
    // as it would in a browser, where the person's click comes in a task of its own.
    await wait(0);
    // A click on text elsewhere: the field gives the focus to the page and goes.
    await blur(field);
    expect(field.isConnected).toBe(false);
    await wait(50);
    expect(document.activeElement).toBe(document.body);
    // The same from a row; rows that change later leave the focus where it is.
    const beta = screen.getByRole('option', { name: 'beta' });
    act(() => {
      beta.focus();
    });
    await blur(beta);
    rerender(<Editing suffix="." />);
    expect(screen.getByRole('option', { name: 'beta.' })).toBeInTheDocument();
    await wait(50);
    expect(document.activeElement).toBe(document.body);
  });
});

/** One section of 150 px tiles, 12 px apart. */
const tiles = (count: number) => [{ count, minTileWidth: 150, tileHeight: 150, gap: 12 }];
const NAME_TILES = tiles(NAMES.length);
const PHOTO_TILES = tiles(1000);

function Grid() {
  const [focused, setFocused] = useState<number | null>(null);
  const itemAt = (index: number): CollectionItem => ({ key: String(index), selected: false, name: NAMES[index] });
  return (
    <VirtualGrid
      label="Files in Algebra"
      count={NAMES.length}
      itemAt={itemAt}
      sections={NAME_TILES}
      padding={14}
      renderItem={(index) => NAMES[index]}
      focusedIndex={focused}
      onNavigate={setFocused}
      onToggle={vi.fn()}
      onAction={vi.fn()}
    />
  );
}

describe('VirtualGrid', () => {
  it('reports the items it shows again when its columns change', () => {
    layout();
    // The grid's own observer is the first one created: it attaches with the element, before
    // TanStack Virtual observes the same element in an effect.
    const observers: ResizeObserverCallback[] = [];
    const saved = globalThis.ResizeObserver;
    globalThis.ResizeObserver = class {
      constructor(callback: ResizeObserverCallback) {
        observers.push(callback);
      }
      observe() {
        // The test calls the callback itself.
      }
      unobserve() {
        // Nothing to stop.
      }
      disconnect() {
        // Nothing to stop.
      }
    };
    onTestFinished(() => {
      globalThis.ResizeObserver = saved;
    });
    const ranges: { start: number; end: number }[] = [];
    render(
      <VirtualGrid
        label="Photos"
        count={1000}
        itemAt={(index) => ({ key: String(index), selected: false, name: `IMG_${String(index)}` })}
        sections={PHOTO_TILES}
        padding={14}
        renderItem={(index) => `IMG_${String(index)}`}
        focusedIndex={null}
        onNavigate={vi.fn()}
        onToggle={vi.fn()}
        onAction={vi.fn()}
        onRangeChange={(range) => ranges.push(range)}
      />,
    );
    const before = ranges.at(-1);
    expect(before?.start).toBe(0);
    // The preview opens and the grid narrows to one column: the same rows hold other items.
    act(() => {
      observers[0]?.([{ contentRect: { width: 300 } } as ResizeObserverEntry], {} as ResizeObserver);
    });
    const after = ranges.at(-1);
    expect(after?.end).toBeLessThan(before?.end ?? 0);
    // Every tile on screen is in the range.
    expect(after?.end).toBeGreaterThanOrEqual(screen.getAllByRole('gridcell').length - 1);
  });

  it('fits as many columns as tiles of the smallest width', () => {
    expect(columnsFor(800, 150, 12, 14)).toBe(4);
    expect(columnsFor(300, 150, 12, 14)).toBe(1);
    expect(columnsFor(0, 150, 12, 14)).toBe(1);
  });

  it('lays tiles out in rows of cells and moves in two directions', async () => {
    layout();
    const user = userEvent.setup();
    render(<Grid />);
    const grid = screen.getByRole('grid', { name: 'Files in Algebra' });
    expect(grid).toHaveAttribute('aria-colcount', '4');
    expect(grid).toHaveAttribute('aria-rowcount', '3');
    expect(screen.getAllByRole('row')[1]).toHaveAttribute('aria-rowindex', '2');
    screen.getByRole('gridcell', { name: 'alpha' }).focus();
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('gridcell', { name: 'beta' })).toHaveFocus();
    await user.keyboard('{ArrowDown}');
    expect(screen.getByRole('gridcell', { name: 'zeta' })).toHaveFocus();
    await user.keyboard('{ArrowLeft}{ArrowUp}');
    expect(screen.getByRole('gridcell', { name: 'alpha' })).toHaveFocus();
  });
});
