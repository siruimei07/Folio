import './collections.css';

import { type KeyboardEvent, type ReactNode, type Ref, type RefObject, useCallback, useMemo, useRef, useState } from 'react';

import { GridLayout, type GridSection } from './gridLayout';
import { handleCollectionKey, ignoreRepeat } from './keys';
import { delegateRowEvents, eventIndex, type RowPointerHandlers } from './rows';
import type { Move } from './selection';
import { findByName, useNameMatcher, useTypeahead } from './useTypeahead';
import { type CollectionHandle, type IndexRange, useVirtualRows } from './useVirtualRows';
import type { CollectionItem } from './VirtualList';

export { columnsFor, type GridSection } from './gridLayout';

export interface VirtualGridProps extends RowPointerHandlers {
  /** The grid's accessible name. */
  label: string;
  count: number;
  itemAt: (index: number) => CollectionItem;
  /** The tiles: one section of every item, or several of their own sizes; their counts add up to `count`. */
  sections: readonly GridSection[];
  /** A section's label row's height. */
  labelHeight?: number;
  /** Below a label row, and between one section's tiles and the next section. */
  sectionGap?: number;
  /** Around the tiles. */
  padding: number;
  /** The tile's content; the grid renders the `gridcell` around it. */
  renderItem: (index: number, item: CollectionItem, focused: boolean) => ReactNode;
  focusedIndex: number | null;
  onNavigate: (index: number, move: Move) => void;
  onToggle: (index: number) => void;
  onAction: (index: number) => void;
  onSelectAll?: () => void;
  onKeyDown?: (event: KeyboardEvent<HTMLElement>, index: number | null) => void;
  /** The items (not rows) on screen. */
  onRangeChange?: (range: IndexRange) => void;
  initialOffset?: number;
  onOffsetChange?: (offset: number) => void;
  className?: string;
  ref?: Ref<CollectionHandle>;
}

/**
 * The grid's scrolling element, through a callback ref that measures it and follows its width.
 * `scrollRef` holds it for the virtualiser.
 */
function useMeasuredScroller(scrollRef: RefObject<HTMLDivElement | null>) {
  const [width, setWidth] = useState(0);
  const attach = useCallback(
    (node: HTMLDivElement | null) => {
      scrollRef.current = node;
      if (node === null) return undefined;
      setWidth(node.clientWidth || node.offsetWidth);
      const observer = new ResizeObserver(([entry]) => {
        if (entry) setWidth(entry.contentRect.width);
      });
      observer.observe(node);
      return () => {
        observer.disconnect();
      };
    },
    [scrollRef],
  );
  return { width, attach };
}

/**
 * A virtualised grid of tiles (WAI-ARIA layout grid with multiple selection, UI architecture
 * §7.2, §8.1): rows of as many tiles as fit, `aria-rowcount` and `aria-colcount`, a roving tab
 * stop, arrows in both directions, Home, End, Page Up, Page Down, Space, Ctrl+A, Enter and
 * type-ahead. Only rows on screen are rendered. Sections of other tile sizes may follow each
 * other in one grid, with label rows that are for the eye only: the tiles' names say what they are.
 */
export function VirtualGrid({
  label,
  count,
  itemAt,
  sections,
  labelHeight = 0,
  sectionGap = 0,
  padding,
  renderItem,
  focusedIndex,
  onNavigate,
  onToggle,
  onAction,
  onSelectAll,
  onKeyDown,
  onRangeChange,
  initialOffset,
  onOffsetChange,
  className,
  ref,
  ...pointer
}: VirtualGridProps) {
  const tabStop = count === 0 ? null : Math.min(focusedIndex ?? 0, count - 1);
  const scrollRef = useRef<HTMLDivElement>(null);
  const { width, attach } = useMeasuredScroller(scrollRef);
  const layout = useMemo(
    () => new GridLayout({ sections, width, padding, labelHeight, sectionGap }),
    [sections, width, padding, labelHeight, sectionGap],
  );
  const { virtualizer, items, requestFocus } = useVirtualRows({
    scrollRef,
    count: layout.rows.length,
    estimateSize: (row) => layout.rows[row]?.size ?? 0,
    sizesKey: layout.sizesKey,
    focusedRow: tabStop === null ? null : layout.rowOfItem(tabStop),
    initialOffset,
    paddingStart: padding,
    paddingEnd: padding,
    onRangeChange:
      onRangeChange &&
      ((range) => {
        const shown = layout.itemRange(range.start, range.end);
        if (shown !== null) onRangeChange(shown);
      }),
    onOffsetChange,
    focusedElement: (element) => element.querySelector<HTMLElement>('[role="gridcell"][tabindex="0"]'),
    rowOfItem: (index) => layout.rowOfItem(index),
    ref,
  });
  const matches = useNameMatcher();
  const navigate = (index: number | null, move: Move) => {
    if (index === null) return;
    if (index !== focusedIndex) requestFocus();
    onNavigate(index, move);
  };
  const typeahead = useTypeahead((typed, fromNext) => {
    const from = tabStop === null ? 0 : tabStop + (fromNext ? 1 : 0);
    navigate(findByName(count, from, typed, matches, (index) => itemAt(index).name), 'replace');
  });

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (ignoreRepeat(event)) return;
    const element = scrollRef.current;
    const index = element === null ? null : eventIndex(event.target, element);
    onKeyDown?.(event, index);
    if (event.defaultPrevented || index === null) return;
    const handled = handleCollectionKey(event, {
      index,
      count,
      next: (from) => (from >= 0 && from < count ? from : null),
      // Rows differ in height, so a page is the rows that start within the view's height.
      across: (from, step, page) => layout.move(from, step, page && { height: element?.clientHeight ?? 0 }),
      grid: true,
      navigate,
      onToggle,
      onAction,
      onSelectAll,
      typeahead,
    });
    if (handled) event.preventDefault();
  };

  return (
    <div
      ref={attach}
      role="grid"
      aria-label={label}
      aria-multiselectable
      aria-rowcount={layout.tileRows.length}
      aria-colcount={layout.maxColumns}
      className={className === undefined ? 'virtual-collection' : `virtual-collection ${className}`}
      onKeyDown={handleKeyDown}
      {...delegateRowEvents(() => true, pointer)}
    >
      <div role="none" className="virtual-collection__sizer" style={{ height: virtualizer.getTotalSize() }}>
        {items.map((virtual) => {
          const row = layout.rows[virtual.index];
          if (row === undefined) return null;
          if (row.kind === 'label') {
            return (
              <div
                key={virtual.index}
                aria-hidden
                className="virtual-collection__row virtual-collection__label"
                style={{ height: labelHeight, transform: `translateY(${String(virtual.start)}px)`, paddingInline: padding }}
              >
                {row.label}
              </div>
            );
          }
          return (
            <div
              key={virtual.index}
              role="row"
              aria-rowindex={row.tileRow + 1}
              className="virtual-collection__row virtual-collection__tiles"
              style={{
                height: row.tileHeight,
                transform: `translateY(${String(virtual.start)}px)`,
                gridTemplateColumns: `repeat(${String(row.columns)}, minmax(0, 1fr))`,
                gap: row.gap,
                paddingInline: padding,
              }}
            >
              {Array.from({ length: row.count }, (_, column) => {
                const index = row.first + column;
                const item = itemAt(index);
                const focused = index === tabStop;
                return (
                  <div
                    key={item.key}
                    role="gridcell"
                    aria-label={item.label}
                    aria-describedby={item.description}
                    aria-colindex={column + 1}
                    aria-selected={item.selected}
                    aria-busy={item.busy === true || undefined}
                    tabIndex={focused ? 0 : -1}
                    data-index={index}
                    className="virtual-collection__tile"
                  >
                    {renderItem(index, item, focused)}
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}
