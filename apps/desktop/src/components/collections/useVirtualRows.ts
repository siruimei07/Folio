// What the virtualised tree, list and grid share (docs/specs/ui-architecture.md §7.2, §8.1): one
// TanStack virtualiser over fixed-height rows, the visible range for the paged lists, the scroll
// offset for the view's store, and moving DOM focus to the focused row after keyboard navigation.
import { defaultRangeExtractor, type Range, useVirtualizer } from '@tanstack/react-virtual';
import {
  type Ref,
  type RefObject,
  useCallback,
  useEffect,
  useEffectEvent,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
} from 'react';

/** Rows rendered beyond the visible ones, each way. */
export const OVERSCAN = 8;

/**
 * The range is reported in steps of this many rows, widened outwards: scrolling re-renders the
 * view that loads the pages every few rows, not on every one.
 */
const RANGE_STEP = 16;

/** The rows a collection renders, first and last included: the pages its paged lists need. */
export interface IndexRange {
  start: number;
  end: number;
}

/** What a view can ask a collection to do. */
export interface CollectionHandle {
  /** Scrolls an item into view (a reveal). */
  scrollToIndex: (index: number) => void;
  /** Moves DOM focus to the focused item once it is rendered, without scrolling (a reveal has). */
  focusFocused: () => void;
}

export interface VirtualRowsOptions {
  /** The scrolling element, which the collection renders. */
  scrollRef: RefObject<HTMLDivElement | null>;
  /** Virtual rows: items, or rows of tiles in a grid. */
  count: number;
  estimateSize: (index: number) => number;
  /** The virtual row of the focused item, always rendered so focus never lands on a removed element. */
  focusedRow: number | null;
  /** Where the scroll was when the view was last shown. */
  initialOffset?: number;
  paddingStart?: number;
  paddingEnd?: number;
  onRangeChange?: (range: IndexRange) => void;
  onOffsetChange?: (offset: number) => void;
  /** The element of the focused item, for focusing it after keyboard navigation. */
  focusedElement: (scroller: HTMLElement) => HTMLElement | null;
  /** The virtual row an item index is in (a grid's rows hold several items). */
  rowOfItem?: (index: number) => number;
  /** Items in a virtual row: a grid reports its range again when its columns change. */
  itemsPerRow?: number;
  /**
   * Changes when rows of other heights move without the count changing (the tree's separators):
   * the virtualiser reads `estimateSize` again only then, or when the count changes.
   */
  sizesKey?: string;
  ref?: Ref<CollectionHandle>;
}

export function useVirtualRows({
  scrollRef,
  count,
  estimateSize,
  focusedRow,
  initialOffset,
  paddingStart,
  paddingEnd,
  onRangeChange,
  onOffsetChange,
  focusedElement,
  rowOfItem = (index) => index,
  itemsPerRow = 1,
  sizesKey,
  ref,
}: VirtualRowsOptions) {
  const rangeExtractor = useCallback(
    (range: Range) => {
      const rows = defaultRangeExtractor(range);
      if (focusedRow === null || focusedRow >= range.count || rows.includes(focusedRow)) return rows;
      return [...rows, focusedRow].sort((a, b) => a - b);
    },
    [focusedRow],
  );
  // TanStack Virtual hands out functions that change with scrolling; the app does not use the React
  // Compiler, so nothing memoises them (ADR-0005 §4, "Revisit when").
  // eslint-disable-next-line react-hooks/incompatible-library -- the virtualiser is read each render
  const virtualizer = useVirtualizer({
    count,
    getScrollElement: () => scrollRef.current,
    estimateSize,
    overscan: OVERSCAN,
    rangeExtractor,
    initialOffset,
    paddingStart,
    paddingEnd,
  });
  const items = virtualizer.getVirtualItems();
  useLayoutEffect(() => {
    if (sizesKey !== undefined) virtualizer.measure();
  }, [virtualizer, sizesKey]);

  // The visible rows widened by the overscan and out to whole steps: what the paged lists load.
  const visible = virtualizer.range;
  const start = visible === null ? 0 : Math.max(0, Math.floor((visible.startIndex - OVERSCAN) / RANGE_STEP) * RANGE_STEP);
  const end =
    visible === null
      ? Math.min(count, 1) - 1
      : Math.min(count - 1, Math.ceil((visible.endIndex + OVERSCAN + 1) / RANGE_STEP) * RANGE_STEP - 1);
  const report = useEffectEvent((range: IndexRange) => {
    onRangeChange?.(range);
  });
  useEffect(() => {
    if (end >= start) report({ start, end });
  }, [start, end, itemsPerRow]);

  // The offset goes to the view's store from the scroll events, never during a render.
  const reportOffset = useEffectEvent((offset: number) => {
    onOffsetChange?.(offset);
  });
  useEffect(() => {
    const scroller = scrollRef.current;
    if (scroller === null) return undefined;
    const onScroll = () => {
      reportOffset(scroller.scrollTop);
    };
    scroller.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      scroller.removeEventListener('scroll', onScroll);
    };
  }, [scrollRef]);

  // Keyboard navigation asks for focus, scrolled into view; it moves once the focused item is
  // rendered. A reveal has scrolled the item to the centre already, and asks for focus alone.
  const pendingFocus = useRef<'scroll' | 'focus' | null>(null);
  const findFocused = useRef(focusedElement);
  useEffect(() => {
    findFocused.current = focusedElement;
  });
  useLayoutEffect(() => {
    if (pendingFocus.current === null || focusedRow === null) return;
    if (pendingFocus.current === 'scroll') virtualizer.scrollToIndex(focusedRow, { align: 'auto' });
    pendingFocus.current = null;
    const scroller = scrollRef.current;
    if (scroller !== null) findFocused.current(scroller)?.focus({ preventScroll: true });
  });
  const requestFocus = useCallback(() => {
    pendingFocus.current = 'scroll';
  }, []);

  // Focus stays when React replaces the focused item's element: a placeholder whose page arrives
  // gets the entry's key, and a new element. The browser then focuses the body, and the next
  // layout effect puts focus back on the focused item. Focus the user moved elsewhere stays there.
  const holdsFocus = useRef(false);
  useEffect(() => {
    const scroller = scrollRef.current;
    if (scroller === null) return undefined;
    const onFocusIn = () => {
      holdsFocus.current = true;
    };
    const onFocusOut = (event: FocusEvent) => {
      const left = event.target;
      queueMicrotask(() => {
        // A removed element did not give its focus away; one still in the page did.
        if (!scroller.contains(document.activeElement) && left instanceof Element && left.isConnected) {
          holdsFocus.current = false;
        }
      });
    };
    scroller.addEventListener('focusin', onFocusIn);
    scroller.addEventListener('focusout', onFocusOut);
    return () => {
      scroller.removeEventListener('focusin', onFocusIn);
      scroller.removeEventListener('focusout', onFocusOut);
    };
  }, [scrollRef]);
  useLayoutEffect(() => {
    const scroller = scrollRef.current;
    const active = document.activeElement;
    if (!holdsFocus.current || scroller === null || (active !== null && active !== document.body)) return;
    findFocused.current(scroller)?.focus({ preventScroll: true });
  });

  useImperativeHandle(
    ref,
    () => ({
      scrollToIndex: (index) => {
        virtualizer.scrollToIndex(rowOfItem(index), { align: 'center' });
      },
      focusFocused: () => {
        pendingFocus.current = 'focus';
        const scroller = scrollRef.current;
        if (scroller !== null) findFocused.current(scroller)?.focus({ preventScroll: true });
      },
    }),
    [virtualizer, rowOfItem, scrollRef],
  );

  return { virtualizer, items, requestFocus };
}
