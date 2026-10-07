import './collections.css';

import { type KeyboardEvent, type ReactNode, type Ref, useRef } from 'react';

import { acrossItems, handleCollectionKey, ignoreRepeat, nextFocusable } from './keys';
import { delegateRowEvents, eventIndex, type RowPointerHandlers } from './rows';
import type { Move } from './selection';
import { findByName, useNameMatcher, useTypeahead } from './useTypeahead';
import { type CollectionHandle, type IndexRange, type RowAnchor, useVirtualRows } from './useVirtualRows';

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
  /** The id of an element that says more about it (`aria-describedby`), such as a folder's count. */
  description?: string;
  /**
   * Lists only: whether the option is checked (`aria-checked`), apart from being selected, as a
   * change included in the commit is (workspace-history handoff §3.6); `'mixed'` for a group's
   * option when some of what it covers is checked; `undefined` for an option without a check box.
   */
  checked?: boolean | 'mixed';
  /**
   * Lists only: a row that is not an option, such as a group's header. Screen readers skip it
   * (`aria-hidden`), and the keys, type-ahead and clicks pass it by: say what it groups in the
   * options' descriptions.
   */
  header?: boolean;
  /** Lists with header rows: the option's place among the options, 1 at the top (`aria-posinset`). */
  position?: number;
}

export interface VirtualListProps extends RowPointerHandlers {
  /** The list's accessible name. */
  label: string;
  /** Rows: options and header rows. */
  count: number;
  /** Options, when header rows are among the rows (`aria-setsize`); `count` without. */
  optionCount?: number;
  itemAt: (index: number) => CollectionItem;
  /** Each row's height in pixels: one for every row, or each row's own. */
  itemHeight: number | ((index: number) => number);
  /** With heights per row: changes when rows of other heights move without the count changing. */
  sizesKey?: string;
  /** Several options can be selected (the default); a list whose options carry check boxes says it cannot. */
  multiselectable?: boolean;
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
  /** Rows that may come and go above the visible ones: the first visible row stays in place (`RowAnchor`). */
  anchor?: RowAnchor;
  className?: string;
  padding?: number;
  ref?: Ref<CollectionHandle>;
}


/**
 * A virtualised list box (WAI-ARIA listbox pattern, with multiple selection unless it says
 * otherwise, UI architecture §7.2): options with `aria-setsize`, `aria-posinset` and, when they
 * carry a check box, `aria-checked`; header rows that only show; a roving tab stop, Up, Down,
 * Home, End, Page Up, Page Down, Space, Ctrl+A, Enter and type-ahead.
 */
export function VirtualList({
  label,
  count,
  optionCount = count,
  itemAt,
  itemHeight,
  sizesKey,
  multiselectable = true,
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
  anchor,
  className,
  padding = 0,
  ref,
  ...pointer
}: VirtualListProps) {
  const heightOf = typeof itemHeight === 'number' ? () => itemHeight : itemHeight;
  const focusable = (index: number) => itemAt(index).header !== true;
  const next = (from: number, step: 1 | -1) => nextFocusable(focusable, count, from, step);
  // The tab stop is always an option: when the focused row went, the row now at its place takes
  // it, and a header there gives it to the option after it (or before it, at the end).
  const from = count === 0 ? null : Math.min(focusedIndex ?? 0, count - 1);
  const tabStop = from === null ? null : focusable(from) ? from : (next(from, 1) ?? next(from, -1));
  const scrollRef = useRef<HTMLDivElement>(null);
  const { virtualizer, items, requestFocus } = useVirtualRows({
    scrollRef,
    count,
    estimateSize: heightOf,
    sizesKey,
    focusedRow: tabStop,
    initialOffset,
    paddingStart: padding,
    paddingEnd: padding,
    onRangeChange,
    onOffsetChange,
    focusedElement: (scroller) => scroller.querySelector<HTMLElement>('[role="option"][tabindex="0"]'),
    anchor,
    ref,
  });
  const matches = useNameMatcher();
  const navigate = (index: number | null, move: Move) => {
    if (index === null) return;
    if (index !== focusedIndex) requestFocus();
    onNavigate(index, move);
  };
  const typeahead = useTypeahead((typed, fromNext) => {
    const start = tabStop === null ? 0 : tabStop + (fromNext ? 1 : 0);
    navigate(
      findByName(count, start, typed, matches, (index) => {
        const item = itemAt(index);
        return item.header === true ? undefined : item.name;
      }),
      'replace',
    );
  });

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (ignoreRepeat(event)) return;
    const scroller = scrollRef.current;
    const index = scroller === null ? null : eventIndex(event.target, scroller);
    onKeyDown?.(event, index);
    if (event.defaultPrevented || index === null) return;
    const page = Math.max(1, Math.floor((scroller?.clientHeight ?? 0) / (heightOf(index) || 1)) - 1);
    const handled = handleCollectionKey(event, {
      index,
      count,
      next,
      across: acrossItems(count, next, 1, page),
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
      aria-multiselectable={multiselectable}
      className={className === undefined ? 'virtual-collection' : `virtual-collection ${className}`}
      onKeyDown={handleKeyDown}
      {...delegateRowEvents(focusable, pointer)}
    >
      <div role="none" className="virtual-collection__sizer" style={{ height: virtualizer.getTotalSize() }}>
        {items.map((virtual) => {
          const item = itemAt(virtual.index);
          const focused = virtual.index === tabStop;
          const style = { height: virtual.size, transform: `translateY(${String(virtual.start)}px)` };
          if (item.header === true) {
            return (
              <div key={item.key} aria-hidden className="virtual-collection__row" data-index={virtual.index} style={style}>
                {renderItem(virtual.index, item, false)}
              </div>
            );
          }
          return (
            <div
              key={item.key}
              role="option"
              aria-label={item.label}
              aria-describedby={item.description}
              aria-selected={item.selected}
              aria-checked={item.checked}
              aria-setsize={optionCount}
              aria-posinset={item.position ?? virtual.index + 1}
              aria-busy={item.busy === true || undefined}
              tabIndex={focused ? 0 : -1}
              data-index={virtual.index}
              className="virtual-collection__row"
              style={style}
            >
              {renderItem(virtual.index, item, focused)}
            </div>
          );
        })}
      </div>
    </div>
  );
}
