// The timeline (handoff workspace-history §7.2, §7.4–§7.6): a `role="feed"` of articles, newest
// first, read a page at a time as it scrolls: the whole history, or one file's.
//
// - Entries differ in height (bodies, notes, file cards, day headers), so the virtualiser measures
//   each (`measureElement`); a box of 0, as in jsdom, keeps the estimate.
// - Earlier pages load once the rendered range nears the end, not on an IntersectionObserver, which
//   the hidden browser pane stalls; a row after the feed says so, or that the history starts there.
// - Page Down and Page Up move the focus between entries, and Ctrl+End and Ctrl+Home out of the
//   feed (WAI-ARIA feed); one entry is the tab stop, and it stays rendered while scrolled away, so
//   the focus never falls to the page. When React replaces its element (a reword gives later
//   commits new ids), the focus goes to the entry now at its index (`useFocusKeeper`).
// - Entries that arrive above the view (a new commit, a restore) leave the entry at its top where
//   it was, unless the view is at the very top, where the new entries show. Entries measured above
//   the view keep it in place too: the virtualiser's own correction does that.
// - Each timeline keeps its place in the view's store (`TimelinePlace`): its tab stop, its offset
//   and the heights it measured, so the whole history shows again where it was after one file's.
import { defaultRangeExtractor, type Range, useVirtualizer } from '@tanstack/react-virtual';
import { type FocusEvent, type KeyboardEvent, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import { measureItem } from '../../components/collections/measure';
import { tabbableBeside } from '../../components/collections/tabbable';
import { useFocusKeeper } from '../../components/collections/useFocusKeeper';
import { OVERSCAN } from '../../components/collections/useVirtualRows';
import type { HistoryPages } from '../../data/history';
import { timelineLayout } from '../model/entries';
import { estimateRow } from '../model/estimate';
import type { TimelineRow } from '../model/timelineRows';
import { type EntryFocus, keepMeasurements, setEntryFocus, setTimelineOffset, type TimelineName, useHistoryView } from '../state';
import { Entry } from './Entry';
import { TimelineEnd } from './TimelineEnd';

/** The entry at the top of the view: its key and how far it starts above the view, at an offset. */
interface Anchor {
  key: string;
  delta: number;
  offset: number;
}

/** Whether nothing has the focus: the page has it, as when the element that had it went or hid. */
function isFocusOnPage(): boolean {
  return document.activeElement === null || document.activeElement === document.body;
}

/** The tab stop's index: its entry by key, else the index it had, within the list. */
function focusedIndexOf(focus: EntryFocus | null, count: number, indexOf: (key: string) => number | undefined): number | null {
  if (count === 0) return null;
  if (focus === null) return 0;
  return indexOf(focus.key) ?? Math.min(focus.index, count - 1);
}

export interface TimelineProps {
  /** Which timeline this is, for the place the view keeps for it. */
  name: TimelineName;
  /** What it shows, newest first (`timelineRows.ts`). */
  rows: readonly TimelineRow[];
  /** The list the rows come from: its paging, loading and failure. */
  list: HistoryPages<unknown>;
  /** Entries in the whole timeline (`aria-setsize`); `undefined` while unknown. */
  setSize: number | undefined;
  /** The feed's name: "History, newest first". */
  label: string;
  /** Asked while the view asks a timeline for the focus (`focusNext`): whether its tab stop takes it. */
  takeFocus?: () => boolean;
  /** Esc in the timeline: one file's history gives way to the whole history (§7.4). */
  onEscape?: () => void;
  /** The key of a restore entry that just arrived: highlighted, it fades and rises in (§7.2, §14). */
  fresh?: string | null;
}

export function Timeline({ name, rows, list, setSize, label, takeFocus, onEscape, fresh = null }: TimelineProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const { hasMore, isLoadingMore, isFetching, loadMore } = list;
  const items = useMemo(() => rows.map((row) => row.item), [rows]);
  const layout = useMemo(() => timelineLayout(items), [items]);
  const count = rows.length;
  const focus = useHistoryView((state) => state.places[name].focus);
  const focusedIndex = focusedIndexOf(focus, count, layout.indexOf);
  // Where it was when it showed last; read once, as the virtualiser reads them only when it starts.
  const [place] = useState(() => useHistoryView.getState().places[name]);
  const [measured] = useState(() => [...place.measured]);
  // Today as of when the timeline opened, for "Today" and "Yesterday".
  const [now] = useState(() => Date.now());

  const getItemKey = useCallback((index: number) => layout.places[index]?.key ?? index, [layout]);
  const estimateSize = useCallback(
    (index: number) => {
      const row = rows[index];
      return row === undefined ? 0 : estimateRow(row, layout.places[index]?.startsDay ?? false);
    },
    [rows, layout],
  );
  const rangeExtractor = useCallback(
    (range: Range) => {
      const indexes = defaultRangeExtractor(range);
      if (focusedIndex === null || focusedIndex >= range.count || indexes.includes(focusedIndex)) return indexes;
      return [...indexes, focusedIndex].sort((a, b) => a - b);
    },
    [focusedIndex],
  );
  // TanStack Virtual hands out functions that change with scrolling; the app does not use the React
  // Compiler, so nothing memoises them (ADR-0005 §4, "Revisit when").
  // eslint-disable-next-line react-hooks/incompatible-library -- the virtualiser is read each render
  const virtualizer = useVirtualizer({
    count,
    getScrollElement: () => scrollRef.current,
    estimateSize,
    getItemKey,
    overscan: OVERSCAN,
    rangeExtractor,
    initialOffset: place.offset,
    initialMeasurementsCache: measured,
    measureElement: measureItem,
  });
  const virtualItems = virtualizer.getVirtualItems();

  // The heights measured go to the store as the timeline goes (one file's history replacing it, the
  // filter, the view hidden), so it shows again where it was.
  useEffect(
    () => () => {
      keepMeasurements(name, virtualizer.takeSnapshot());
    },
    [name, virtualizer],
  );

  // Earlier entries: the next page once the rendered range nears the end, asked again once a read
  // settles, since a refresh that overtakes the next page cancels it (`loadMore` asks nothing at the
  // end or after an error).
  const end = virtualizer.range?.endIndex ?? -1;
  const nearEnd = count > 0 && end >= count - 1 - OVERSCAN;
  useEffect(() => {
    if (nearEnd && hasMore && !isFetching) loadMore();
  }, [nearEnd, hasMore, isFetching, loadMore, count]);

  // The offset goes to the store from the scroll events, never during a render.
  useEffect(() => {
    const scroller = scrollRef.current;
    if (scroller === null) return undefined;
    const onScroll = () => {
      setTimelineOffset(name, scroller.scrollTop);
    };
    scroller.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      scroller.removeEventListener('scroll', onScroll);
    };
  }, [name]);

  // Entries that arrive above the view keep the entry at its top in place. Each render notes that
  // entry once the view is where it should be; a view the person or the virtualiser has moved since
  // the last render is where they put it.
  const anchor = useRef<Anchor | null>(null);
  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (element === null) return;
    const offset = element.scrollTop;
    const held = anchor.current;
    if (held !== null && Math.abs(held.offset - offset) < 1) {
      const index = layout.indexOf(held.key);
      const start = index === undefined ? undefined : virtualizer.measurementsCache[index]?.start;
      if (start !== undefined && Math.abs(start + held.delta - offset) >= 1) {
        element.scrollTop = start + held.delta;
        anchor.current = { ...held, offset: element.scrollTop };
        return;
      }
    }
    // At the very top, entries that arrive show.
    const top = offset < 1 ? undefined : virtualItems.find((item) => item.end > offset);
    anchor.current = top === undefined ? null : { key: String(top.key), delta: offset - top.start, offset };
  });

  const entryAt = useCallback(
    (index: number) => scrollRef.current?.querySelector<HTMLElement>(`.timeline__item[data-index="${String(index)}"] > article`) ?? null,
    [],
  );
  const focusEntry = useCallback(
    (index: number) => {
      entryAt(index)?.focus({ preventScroll: true });
    },
    [entryAt],
  );

  // Asked for the focus (one file's history opened or closed, another view showing the whole
  // history): as it shows, or later while it shows, the tab stop takes the focus once it is
  // rendered, where the timeline was scrolled, if the view says so. An entry that refuses it (not
  // visible) leaves the request kept, and a later render tries again while the focus is still on
  // the page; once the person has put it somewhere, it stays there.
  const asked = useHistoryView((state) => state.focusNext);
  const focusOnShow = useRef<'none' | 'asked' | 'kept'>('none');
  useLayoutEffect(() => {
    // Taken once: an effect run again for the same render (strict mode) finds the flag cleared.
    if (asked && (takeFocus?.() ?? false)) focusOnShow.current = 'asked';
    if (focusOnShow.current === 'none' || focusedIndex === null) return;
    if (focusOnShow.current === 'kept' && !isFocusOnPage()) {
      focusOnShow.current = 'none';
      return;
    }
    const entry = entryAt(focusedIndex);
    if (entry === null) return;
    entry.focus({ preventScroll: true });
    focusOnShow.current = document.activeElement !== entry && isFocusOnPage() ? 'kept' : 'none';
  });

  // Page Down and Page Up move the focus to the next or previous entry once it is rendered, scrolled
  // so its top shows.
  const pendingFocus = useRef(false);
  useLayoutEffect(() => {
    if (!pendingFocus.current || focusedIndex === null) return;
    pendingFocus.current = false;
    const element = scrollRef.current;
    const measured = virtualizer.measurementsCache[focusedIndex];
    if (element !== null && measured !== undefined) {
      const fits = measured.size <= element.clientHeight;
      if (measured.start < element.scrollTop || !fits) virtualizer.scrollToIndex(focusedIndex, { align: 'start' });
      else if (measured.end > element.scrollTop + element.clientHeight) virtualizer.scrollToIndex(focusedIndex, { align: 'end' });
    }
    focusEntry(focusedIndex);
  });
  const moveFocus = (index: number) => {
    const at = layout.places[index];
    if (at === undefined) return;
    setEntryFocus(name, { key: at.key, index });
    pendingFocus.current = true;
    // The same entry again: no render follows, so focus it now.
    if (index === focusedIndex) {
      pendingFocus.current = false;
      focusEntry(index);
    }
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.defaultPrevented || event.altKey || event.metaKey || event.shiftKey) return;
    if (event.ctrlKey) {
      // Ctrl+End and Ctrl+Home leave the feed, past it or before it (WAI-ARIA feed): Tab would cross
      // every entry's controls, and the entries keep coming as it nears the end.
      const feed = event.currentTarget.querySelector('.timeline__feed');
      if ((event.key !== 'End' && event.key !== 'Home') || !feed?.contains(event.target as Node)) return;
      const target = tabbableBeside(feed, event.key === 'End' ? 'after' : 'before');
      if (target === null) return;
      event.preventDefault();
      target.focus();
      return;
    }
    if (event.key === 'Escape' && onEscape !== undefined) {
      event.preventDefault();
      onEscape();
      return;
    }
    if (event.key !== 'PageDown' && event.key !== 'PageUp') return;
    const item = event.target instanceof Element ? event.target.closest<HTMLElement>('.timeline__item') : null;
    const from = item === null ? (focusedIndex ?? 0) : Number(item.dataset.index);
    event.preventDefault();
    if (event.key === 'PageUp') {
      moveFocus(Math.max(0, from - 1));
    } else if (from + 1 < count) {
      moveFocus(from + 1);
    } else {
      // The last entry read: the next page, and Page Down again moves on once it has arrived.
      loadMore();
    }
  };
  // The tab stop follows the focus: a click or Tab into an entry makes it the one Page Down moves from.
  const onFocus = (event: FocusEvent<HTMLDivElement>) => {
    const item = event.target.closest<HTMLElement>('.timeline__item');
    if (item === null) return;
    const index = Number(item.dataset.index);
    const at = layout.places[index];
    if (at !== undefined) setEntryFocus(name, { key: at.key, index });
  };

  // The focused entry's element replaced or gone: the focus goes to the entry now at its index.
  const keepFocus = useFocusKeeper(() => {
    const index = focusedIndexOf(useHistoryView.getState().places[name].focus, count, layout.indexOf);
    if (index !== null) focusEntry(index);
  });

  const last = items.at(-1);
  const atStart = !hasMore && last?.kind === 'commit' && last.commit.first;
  return (
    <div ref={scrollRef} className="timeline" onKeyDown={onKeyDown} onFocus={onFocus}>
      <div
        ref={keepFocus}
        className="timeline__feed"
        role="feed"
        aria-label={label}
        aria-busy={isLoadingMore || undefined}
        style={{ height: virtualizer.getTotalSize() }}
      >
        {virtualItems.map((virtual) => {
          const row = rows[virtual.index];
          const at = layout.places[virtual.index];
          if (row === undefined || at === undefined) return null;
          return (
            <div
              key={virtual.key}
              ref={virtualizer.measureElement}
              data-index={virtual.index}
              className="timeline__item"
              style={{ transform: `translateY(${String(virtual.start)}px)` }}
            >
              <Entry
                row={row}
                place={at}
                position={virtual.index + 1}
                setSize={setSize ?? -1}
                tabStop={virtual.index === focusedIndex}
                now={now}
                fresh={at.key === fresh}
              />
            </div>
          );
        })}
      </div>
      <TimelineEnd list={list} atStart={atStart} />
    </div>
  );
}
