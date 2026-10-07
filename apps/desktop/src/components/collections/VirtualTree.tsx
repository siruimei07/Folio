import './collections.css';

import { type KeyboardEvent, type ReactNode, type Ref, useRef } from 'react';

import { acrossItems, handleCollectionKey, ignoreRepeat, nextFocusable } from './keys';
import { delegateRowEvents, eventIndex, type RowPointerHandlers } from './rows';
import type { Move } from './selection';
import { findByName, useNameMatcher, useTypeahead } from './useTypeahead';
import { type CollectionHandle, type IndexRange, useVirtualRows } from './useVirtualRows';

/** One row of a tree rendered as a flat list (UI architecture §8.2). */
export interface TreeRow {
  /** Stable across renders: an entry id, or a placeholder's position. */
  key: string;
  /** item: a `treeitem`; separator: a line that screen readers skip. */
  kind: 'item' | 'separator';
  /** Arrow keys and type-ahead stop on it; "Empty" rows they skip. */
  focusable: boolean;
  /** 1 at the top. */
  level: number;
  posinset: number;
  setsize: number;
  /** `undefined` for a leaf. */
  expanded?: boolean;
  selected: boolean;
  /** Its name, for type-ahead; `undefined` while it loads. */
  name?: string;
  /** Loading (a placeholder for a page not loaded yet). */
  busy?: boolean;
  /** Focusable but not choosable, such as a folder a move cannot go into. */
  disabled?: boolean;
  /** The accessible name, when the row's text alone does not say it all ("MAT232 …, 10 files"). */
  label?: string;
}

export interface VirtualTreeProps extends RowPointerHandlers {
  /** The tree's accessible name. */
  label: string;
  count: number;
  rowAt: (index: number) => TreeRow;
  rowHeight: (index: number) => number;
  /** Changes when rows of other heights move without the count changing (`useVirtualRows`). */
  sizesKey?: string;
  /** Several rows can be selected (the default); a picker of one folder says it cannot. */
  multiselectable?: boolean;
  /**
   * Rows open and close (the default). When they cannot, as in a tree that shows everything open,
   * Left goes to the parent, as on a row without children.
   */
  collapsible?: boolean;
  /** The row's content; the tree renders the `treeitem` around it. */
  renderRow: (index: number, row: TreeRow, focused: boolean) => ReactNode;
  /** The focused row, which holds the tab stop; `null`: the first focusable row does. */
  focusedIndex: number | null;
  /** Keyboard navigation: focus moved to `index`, with what it does to the selection. */
  onNavigate: (index: number, move: Move) => void;
  /** Space or Ctrl+Space: select or deselect the focused row. */
  onToggle: (index: number) => void;
  onExpand: (index: number, expanded: boolean) => void;
  /** Enter. */
  onAction: (index: number) => void;
  /** Runs first: call `preventDefault` to keep the tree from handling the key. */
  onKeyDown?: (event: KeyboardEvent<HTMLElement>, index: number | null) => void;
  onRangeChange?: (range: IndexRange) => void;
  initialOffset?: number;
  onOffsetChange?: (offset: number) => void;
  /** Positions the tree, like `library-tree`. */
  className?: string;
  /** Space above the first row and below the last, in pixels. */
  padding?: number;
  ref?: Ref<CollectionHandle>;
}


/**
 * A virtualised tree (WAI-ARIA tree pattern, UI architecture §7.2): one flat list of the visible
 * rows with `aria-level`, `aria-posinset` and `aria-setsize`, a roving tab stop, multiple
 * selection, Up and Down, Right to expand or enter, Left to collapse or go to the parent, Home,
 * End, Page Up, Page Down, Enter and type-ahead. Rows have fixed heights; nothing is measured.
 */
export function VirtualTree({
  label,
  count,
  rowAt,
  rowHeight,
  renderRow,
  focusedIndex,
  onNavigate,
  onToggle,
  onExpand,
  onAction,
  onKeyDown,
  onRangeChange,
  initialOffset,
  onOffsetChange,
  className,
  padding = 0,
  sizesKey,
  multiselectable = true,
  collapsible = true,
  ref,
  ...pointer
}: VirtualTreeProps) {
  // The tab stop is always a focusable row: after a delete, the focused index may point past the
  // end or at a separator, and the nearest focusable row above takes it.
  const focusable = (index: number) => rowAt(index).focusable;
  const tabStop =
    focusedIndex !== null && focusedIndex < count && focusable(focusedIndex)
      ? focusedIndex
      : (nextFocusable(focusable, count, Math.min(focusedIndex ?? 0, count - 1), -1) ?? nextFocusable(focusable, count, 0, 1));
  const scrollRef = useRef<HTMLDivElement>(null);
  const { virtualizer, items, requestFocus } = useVirtualRows({
    scrollRef,
    count,
    estimateSize: rowHeight,
    sizesKey,
    focusedRow: tabStop,
    initialOffset,
    paddingStart: padding,
    paddingEnd: padding,
    onRangeChange,
    onOffsetChange,
    focusedElement: (scroller) => scroller.querySelector<HTMLElement>('[role="treeitem"][tabindex="0"]'),
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
    navigate(
      findByName(count, from, typed, matches, (index) => {
        const row = rowAt(index);
        return row.focusable ? row.name : undefined;
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
    const row = rowAt(index);
    const next = (from: number, step: 1 | -1) => nextFocusable(focusable, count, from, step);
    const plain = !event.ctrlKey && !event.shiftKey && !event.altKey && !event.metaKey;
    let handled = true;
    if (event.key === 'ArrowRight' && plain) {
      if (row.expanded === false) onExpand(index, true);
      else if (row.expanded === true && index + 1 < count) {
        const child = rowAt(index + 1);
        if (child.level > row.level && child.focusable) navigate(index + 1, 'replace');
      }
    } else if (event.key === 'ArrowLeft' && plain) {
      if (row.expanded === true && collapsible) onExpand(index, false);
      else if (row.level > 1) {
        for (let parent = index - 1; parent >= 0; parent--) {
          const candidate = rowAt(parent);
          if (candidate.kind === 'item' && candidate.level < row.level) {
            navigate(parent, 'replace');
            break;
          }
        }
      }
    } else {
      handled = handleCollectionKey(event, {
        index,
        count,
        next,
        across: acrossItems(count, next, 1, Math.max(1, Math.floor((scroller?.clientHeight ?? 0) / (rowHeight(index) || 1)) - 1)),
        navigate,
        onToggle,
        onAction,
        typeahead,
      });
    }
    if (handled) event.preventDefault();
  };

  return (
    <div
      ref={scrollRef}
      role="tree"
      aria-label={label}
      aria-multiselectable={multiselectable}
      className={className === undefined ? 'virtual-collection' : `virtual-collection ${className}`}
      onKeyDown={handleKeyDown}
      {...delegateRowEvents((index) => rowAt(index).kind === 'item', pointer)}
    >
      <div role="none" className="virtual-collection__sizer" style={{ height: virtualizer.getTotalSize() }}>
        {items.map((item) => {
          const row = rowAt(item.index);
          const focused = item.index === tabStop;
          const style = { height: item.size, transform: `translateY(${String(item.start)}px)` };
          if (row.kind === 'separator') {
            return (
              <div key={row.key} aria-hidden className="virtual-collection__row" data-index={item.index} style={style}>
                {renderRow(item.index, row, false)}
              </div>
            );
          }
          return (
            <div
              key={row.key}
              role="treeitem"
              aria-label={row.label}
              aria-level={row.level}
              aria-posinset={row.posinset}
              aria-setsize={row.setsize}
              aria-expanded={row.expanded}
              aria-selected={row.selected}
              aria-busy={row.busy === true || undefined}
              aria-disabled={row.disabled === true || !row.focusable || undefined}
              tabIndex={focused ? 0 : -1}
              data-index={item.index}
              className="virtual-collection__row"
              style={style}
            >
              {renderRow(item.index, row, focused)}
            </div>
          );
        })}
      </div>
    </div>
  );
}
