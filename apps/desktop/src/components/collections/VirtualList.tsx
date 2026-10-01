import './collections.css';

import { type KeyboardEvent, type ReactNode, type Ref, useRef } from 'react';

import { handleCollectionKey, ignoreRepeat } from './keys';
import { delegateRowEvents, eventIndex, type RowPointerHandlers } from './rows';
import type { Move } from './selection';
import { findByName, useNameMatcher, useTypeahead } from './useTypeahead';
import { type CollectionHandle, type IndexRange, useVirtualRows } from './useVirtualRows';

/** One option of a list or tile of a grid. */
export interface CollectionItem {
  /** Stable across renders: an entry id, or a placeholder's position. */
  key: string;
  selected: boolean;
  /** Its name, for type-ahead; `undefined` while it loads. */
  name?: string;
  /** Loading (a placeholder for a page not loaded yet). */
  busy?: boolean;
  /** The accessible name, when the row's text alone does not say it all ("MAT232 …, 10 files"). */
  label?: string;
}

export interface VirtualListProps extends RowPointerHandlers {
  /** The list's accessible name. */
  label: string;
  count: number;
  itemAt: (index: number) => CollectionItem;
  /** Each item's height in pixels. */
  itemHeight: number;
  /** The item's content; the list renders the `option` around it. */
  renderItem: (index: number, item: CollectionItem, focused: boolean) => ReactNode;
  focusedIndex: number | null;
  onNavigate: (index: number, move: Move) => void;
  onToggle: (index: number) => void;
  /** Enter. */
  onAction: (index: number) => void;
  /** Ctrl+A. */
  onSelectAll?: () => void;
  /** Runs first: call `preventDefault` to keep the list from handling the key. */
  onKeyDown?: (event: KeyboardEvent<HTMLElement>, index: number | null) => void;
  onRangeChange?: (range: IndexRange) => void;
  initialOffset?: number;
  onOffsetChange?: (offset: number) => void;
  className?: string;
  padding?: number;
  ref?: Ref<CollectionHandle>;
}


/**
 * A virtualised list box (WAI-ARIA listbox pattern with multiple selection, UI architecture
 * §7.2): options with `aria-setsize` and `aria-posinset`, a roving tab stop, Up, Down, Home,
 * End, Page Up, Page Down, Space, Ctrl+A, Enter and type-ahead.
 */
export function VirtualList({
  label,
  count,
  itemAt,
  itemHeight,
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
  padding = 0,
  ref,
  ...pointer
}: VirtualListProps) {
  const tabStop = count === 0 ? null : Math.min(focusedIndex ?? 0, count - 1);
  const scrollRef = useRef<HTMLDivElement>(null);
  const { virtualizer, items, requestFocus } = useVirtualRows({
    scrollRef,
    count,
    estimateSize: () => itemHeight,
    focusedRow: tabStop,
    initialOffset,
    paddingStart: padding,
    paddingEnd: padding,
    onRangeChange,
    onOffsetChange,
    focusedElement: (scroller) => scroller.querySelector<HTMLElement>('[role="option"][tabindex="0"]'),
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
    const scroller = scrollRef.current;
    const index = scroller === null ? null : eventIndex(event.target, scroller);
    onKeyDown?.(event, index);
    if (event.defaultPrevented || index === null) return;
    const handled = handleCollectionKey(event, {
      index,
      count,
      next: (from) => (from >= 0 && from < count ? from : null),
      page: Math.max(1, Math.floor((scroller?.clientHeight ?? 0) / itemHeight) - 1),
      vertical: 1,
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
      ref={scrollRef}
      role="listbox"
      aria-label={label}
      aria-multiselectable
      className={className === undefined ? 'virtual-collection' : `virtual-collection ${className}`}
      onKeyDown={handleKeyDown}
      {...delegateRowEvents(() => true, pointer)}
    >
      <div role="none" className="virtual-collection__sizer" style={{ height: virtualizer.getTotalSize() }}>
        {items.map((virtual) => {
          const item = itemAt(virtual.index);
          const focused = virtual.index === tabStop;
          return (
            <div
              key={item.key}
              role="option"
              aria-label={item.label}
              aria-selected={item.selected}
              aria-setsize={count}
              aria-posinset={virtual.index + 1}
              aria-busy={item.busy === true || undefined}
              tabIndex={focused ? 0 : -1}
              data-index={virtual.index}
              className="virtual-collection__row"
              style={{ height: virtual.size, transform: `translateY(${String(virtual.start)}px)` }}
            >
              {renderItem(virtual.index, item, focused)}
            </div>
          );
        })}
      </div>
    </div>
  );
}
