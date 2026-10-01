import './collections.css';

import { type KeyboardEvent, type ReactNode, type Ref, type RefObject, useCallback, useRef, useState } from 'react';

import { handleCollectionKey, ignoreRepeat } from './keys';
import { delegateRowEvents, eventIndex, type RowPointerHandlers } from './rows';
import type { Move } from './selection';
import { findByName, useNameMatcher, useTypeahead } from './useTypeahead';
import { type CollectionHandle, type IndexRange, useVirtualRows } from './useVirtualRows';
import type { CollectionItem } from './VirtualList';

export interface VirtualGridProps extends RowPointerHandlers {
  /** The grid's accessible name. */
  label: string;
  count: number;
  itemAt: (index: number) => CollectionItem;
  /** Tiles are at least this wide; the columns share the rest. */
  minTileWidth: number;
  tileHeight: number;
  /** Between tiles, both ways. */
  gap: number;
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

/** How many tiles fit a row: ⌊(width + gap) / (min + gap)⌋, at least one (UI architecture §8.1). */
export function columnsFor(width: number, minTileWidth: number, gap: number, padding: number): number {
  return Math.max(1, Math.floor((width - 2 * padding + gap) / (minTileWidth + gap)));
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
 * type-ahead. Only rows on screen are rendered.
 */
export function VirtualGrid({
  label,
  count,
  itemAt,
  minTileWidth,
  tileHeight,
  gap,
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
  const columns = columnsFor(width, minTileWidth, gap, padding);
  const rows = Math.ceil(count / columns);
  const { virtualizer, items, requestFocus } = useVirtualRows({
    scrollRef,
    count: rows,
    estimateSize: (row) => (row === rows - 1 ? tileHeight : tileHeight + gap),
    focusedRow: tabStop === null ? null : Math.floor(tabStop / columns),
    initialOffset,
    paddingStart: padding,
    paddingEnd: padding,
    onRangeChange:
      onRangeChange &&
      ((range) => {
        onRangeChange({ start: range.start * columns, end: Math.min(count - 1, range.end * columns + columns - 1) });
      }),
    onOffsetChange,
    focusedElement: (element) => element.querySelector<HTMLElement>('[role="gridcell"][tabindex="0"]'),
    rowOfItem: (index) => Math.floor(index / columns),
    itemsPerRow: columns,
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
    const rowsShown = Math.max(1, Math.floor((element?.clientHeight ?? 0) / (tileHeight + gap)));
    const handled = handleCollectionKey(event, {
      index,
      count,
      next: (from) => (from >= 0 && from < count ? from : null),
      page: rowsShown * columns,
      vertical: columns,
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
      aria-rowcount={rows}
      aria-colcount={columns}
      className={className === undefined ? 'virtual-collection' : `virtual-collection ${className}`}
      onKeyDown={handleKeyDown}
      {...delegateRowEvents(() => true, pointer)}
    >
      <div role="none" className="virtual-collection__sizer" style={{ height: virtualizer.getTotalSize() }}>
        {items.map((virtual) => {
          const first = virtual.index * columns;
          const indexes = Array.from({ length: Math.min(columns, count - first) }, (_, column) => first + column);
          return (
            <div
              key={virtual.index}
              role="row"
              aria-rowindex={virtual.index + 1}
              className="virtual-collection__row virtual-collection__tiles"
              style={{
                height: tileHeight,
                transform: `translateY(${String(virtual.start)}px)`,
                gridTemplateColumns: `repeat(${String(columns)}, minmax(0, 1fr))`,
                gap,
                paddingInline: padding,
              }}
            >
              {indexes.map((index) => {
                const item = itemAt(index);
                const focused = index === tabStop;
                return (
                  <div
                    key={item.key}
                    role="gridcell"
                    aria-label={item.label}
                    aria-colindex={index - first + 1}
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
