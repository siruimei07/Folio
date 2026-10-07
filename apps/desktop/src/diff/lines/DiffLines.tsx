// Text and Word lines (handoff workspace-history §6.3–§6.6): one focusable, virtualised region
// that scrolls the event banners, the lines and what follows them together.
//
// - The region's items are a lead (the banners, and the note of an approximate diff), the rows of
//   the layout (`model/rows.ts`: lines, folds, rows whose window is loading or failed), and a trail
//   (the Word note, then the tags block when the tags changed with the content). Lines wrap, so
//   every item is measured (`measureElement`); a box of 0, as in jsdom, keeps the estimate.
// - The region asks for the windows its visible rows need, plus a window's worth of rows each
//   way, settled like the paged lists (100 ms), and reports them to the pane, which reads them
//   with `useDiffWindows`. The rows are settled by key, not by display index, so a window that
//   fails (one row for its 500) does not turn the same indices into other rows and other windows.
//   Opening a fold turns it into its lines in place; their text comes in `unchanged` windows as
//   they scroll into view.
// - A window that answers for other content than the header reads the whole diff again once
//   nothing is in flight, at most once a second.
// - The lines of the current change carry the bar (§6.3). The pane moves it (`useChangeNavigation`)
//   and asks the region to reveal the change's first row (`DiffLinesHandle.reveal`).
// - In the region, Up and Down scroll by a line, Page Up and Page Down by a page, Home and End to
//   the ends (§6.9). A fold or "Try again" that has the focus stays rendered when it scrolls out of
//   the virtualised range, and its window stays asked, so it keeps its control and the focus. A
//   control that goes (a fold opening, a failed row loading again, its window answering for other
//   content) leaves the focus to the region, not the page; focus the person moves out stays out
//   (`useFocusKeeper`). A failed row whose "Try again" fails again is read again (`useRetry`).
// - The region's focus ring is drawn by its frame, above the rows, whose backgrounds would cover a
//   ring drawn by the region itself.
import './DiffLines.css';

import { defaultRangeExtractor, type Range, useVirtualizer, type Virtualizer } from '@tanstack/react-virtual';
import { Info } from 'lucide-react';
import {
  type FocusEvent,
  type KeyboardEvent,
  type ReactNode,
  type Ref,
  useCallback,
  useEffect,
  useEffectEvent,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useTranslation } from 'react-i18next';

import { useFocusKeeper } from '../../components/collections/useFocusKeeper';
import { OVERSCAN } from '../../components/collections/useVirtualRows';
import { DIFF_WINDOW_ROWS, type DiffWindows, uniqueWindows, windowId } from '../../data/diff';
import { useSettled } from '../../data/paged';
import type { DiffWindow, TagChange } from '../../ipc';
import { SIZE, SPACE } from '../../tokens/tokens';
import { InfoNote } from '../EventNote';
import { TagsBlock } from '../MetadataDetail';
import { useRetry, useRetryAnnouncement } from '../useRetry';
import {
  buildLayout,
  type CheckedWindows,
  type DiffLayout,
  type DisplayRow,
  type FoldRow as Fold,
  NOTHING_UNFOLDED,
  openFold,
  runsOf,
  textOf,
} from '../model/rows';
import { DiffLine, PendingLine } from './DiffLine';
import { FailedRow, FoldRow } from './FoldRow';
import { motionOf, REVEAL_AT, scrollToTarget } from './reveal';

/** A line's estimated height: `font.size.diff` × `font.line-height.diff` (12.5 × 1.76). Measuring replaces it. */
const LINE_ESTIMATE = 22;

/** A fold or a failed window: `size.diff-fold` and its 2 px margins. */
const BAR_ESTIMATE = SIZE.diffFold + 2 * SPACE[2];

/** One banner or note before the lines. */
const NOTE_ESTIMATE = 36;

/** The Word note and the tags block after the lines. */
const WORD_NOTE_ESTIMATE = 32;
const TAGS_ESTIMATE = 160;

/** Rows each way beyond the visible ones whose windows load ahead: a window's worth. */
export const WINDOW_MARGIN = DIFF_WINDOW_ROWS;

/** A diff whose windows keep disagreeing with its header reads again at most this often. */
export const RELOAD_MS = 1_000;

const NO_WINDOWS: readonly DiffWindow[] = [];

/** The items before and after the layout's rows. */
const LEAD_KEY = 'lead';
const TRAIL_KEY = 'trail';

/**
 * A row of the layout in terms another layout understands: its key, and the row of the folded diff
 * it stands for when no row has that key any more (a window that failed, a fold that closed).
 */
interface Place {
  key: string;
  row: number;
}

function placeAt(layout: DiffLayout, index: number): Place {
  return { key: layout.rowAt(index).key, row: layout.rowOf(index) };
}

function indexOfPlace(layout: DiffLayout, place: Place): number {
  return layout.indexOfKey(place.key) ?? layout.indexOf(place.row);
}

/**
 * The item at the top of the view: its place (`null` for the trail), how far it starts above the
 * view, and the scroll offset then.
 */
interface Anchor {
  place: Place | null;
  delta: number;
  offset: number;
}

/** The virtualiser's own scroll correction, which the region replaces (see `DiffLines`). */
const NEVER = () => false;

/** The item index of an anchor in another layout: the trail, else its row by key or by what it stood for. */
function anchorItem(layout: DiffLayout, anchor: Anchor): number {
  if (anchor.place === null || layout.count === 0) return layout.count + 1;
  return indexOfPlace(layout, anchor.place) + 1;
}

function estimateRow(row: DisplayRow): number {
  return row.kind === 'failed' || (row.kind === 'row' && row.row.kind === 'fold') ? BAR_ESTIMATE : LINE_ESTIMATE;
}

/** The item's border box; the estimate when it has none (jsdom, or not laid out yet). */
function measureItem(
  element: Element,
  entry: ResizeObserverEntry | undefined,
  instance: Virtualizer<HTMLDivElement, Element>,
): number {
  const size = entry?.borderBoxSize[0]?.blockSize ?? element.getBoundingClientRect().height;
  return size > 0 ? size : instance.options.estimateSize(instance.indexFromElement(element));
}

/** What the pane asks of the region. */
export interface DiffLinesHandle {
  /** Moves the focus to the region. */
  focus: () => void;
  /**
   * Scrolls row `row` of the folded diff to the top third of the view (a failed window's row for
   * one of its rows): smoothly, or at once under reduced motion.
   */
  reveal: (row: number) => void;
}

export interface DiffLinesProps {
  /** The diff's windows (`useDiffWindows`); the first one's answer has lines. */
  read: DiffWindows;
  /** `checkWindows(read.windows)`. */
  checked: CheckedWindows;
  /** Word text: paragraphs in the UI font, and the closing note. */
  word: boolean;
  /** The region's name: "Changes in Midterm review.md". */
  label: string;
  /** Before the lines: the event banners, one element each. */
  banners: readonly ReactNode[];
  /** The entry's tags, when they changed with the content: a block after the lines. */
  tags: TagChange | null;
  /** The current change, whose lines carry the bar; `null` for none. */
  current: number | null;
  /** The windows the region needs now; the pane asks for them, and for the first window. */
  onWindows: (windows: readonly DiffWindow[]) => void;
  ref?: Ref<DiffLinesHandle>;
}

/** The lines of a text or Word diff. Remount it for another change, so its folds start shut. */
export function DiffLines({ read, checked, word, label, banners, tags, current, onWindows, ref }: DiffLinesProps) {
  const { t } = useTranslation('diff');
  const scrollRef = useRef<HTMLDivElement>(null);
  const text = textOf(checked.header);
  const total = text?.rows ?? 0;
  const approximate = text?.approximate === true;
  const { identity } = checked;

  const [unfolded, setUnfolded] = useState(NOTHING_UNFOLDED);
  const runs = useMemo(() => runsOf(unfolded, identity), [unfolded, identity]);
  const layout = useMemo(() => buildLayout(total, runs, checked), [total, runs, checked]);

  // Another content between two answers: read the whole diff again once nothing is in flight.
  const { reload, retry } = read;
  const reloadedAt = useRef(-Infinity);
  // Each answer looks again: two disagreements in a row can come in one render.
  useEffect(() => {
    if (!checked.reload) return undefined;
    const timer = setTimeout(
      () => {
        reloadedAt.current = Date.now();
        reload();
      },
      Math.max(0, reloadedAt.current + RELOAD_MS - Date.now()),
    );
    return () => {
      clearTimeout(timer);
    };
  }, [checked, reload]);

  // Items: the lead, the layout's rows, the trail.
  const count = layout.count + 2;
  const trail = count - 1;
  const notes = banners.length + (approximate ? 1 : 0);
  const leadEstimate = notes * NOTE_ESTIMATE + SPACE[4];
  const trailEstimate = SPACE[8] + (word ? WORD_NOTE_ESTIMATE : 0) + (tags === null ? 0 : TAGS_ESTIMATE);
  const getItemKey = useCallback(
    (index: number) => (index === 0 ? LEAD_KEY : index === layout.count + 1 ? TRAIL_KEY : layout.rowAt(index - 1).key),
    [layout],
  );
  const estimateSize = useCallback(
    (index: number) => {
      if (index === 0) return leadEstimate;
      if (index === layout.count + 1) return trailEstimate;
      return estimateRow(layout.rowAt(index - 1));
    },
    [layout, leadEstimate, trailEstimate],
  );

  // The item that has the focus (a fold, or a failed window's "Try again") stays rendered while it
  // is out of the range, or React would remove it and the focus would fall to the page; its window
  // stays asked (`wanted`), or its row would turn into skeleton lines.
  const [focused, setFocused] = useState<string | null>(null);
  // A control that goes all the same takes the focus with it: the region gets it back. The focused
  // item is let go only once the focus has left the region, not as it leaves the control: a render
  // in between would drop the control and take the focus back from where the person put it.
  const keepFocus = useFocusKeeper(
    () => {
      scrollRef.current?.focus({ preventScroll: true });
    },
    () => {
      setFocused(null);
    },
  );
  const onFocus = (event: FocusEvent<HTMLDivElement>) => {
    const item = event.target === event.currentTarget ? null : event.target.closest<HTMLElement>('.diff-lines__item');
    setFocused(item === null ? null : getItemKey(Number(item.dataset.index)));
  };
  const rangeExtractor = useCallback(
    (range: Range) => {
      const indexes = defaultRangeExtractor(range);
      if (focused === null) return indexes;
      const row = focused === LEAD_KEY ? -1 : focused === TRAIL_KEY ? layout.count : layout.indexOfKey(focused);
      const index = row === null ? null : row + 1;
      if (index === null || indexes.includes(index)) return indexes;
      return [...indexes, index].sort((a, b) => a - b);
    },
    [layout, focused],
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
    measureElement: measureItem,
  });
  const items = virtualizer.getVirtualItems();

  // The view keeps its place when what is above it changes size: a window that answers turns
  // skeleton lines into rows of other heights (folds), one no longer asked for turns back into
  // skeleton lines, one that failed becomes one row, one tried again its rows, and rows are measured
  // as they render. Without this, the rows under the view would change, and their windows load (or
  // fail) in turn. The virtualiser's own correction is off: it covers only measured rows, and it
  // scrolls from the offset of the last scroll event, which would undo a correction made since.
  // Each render notes the item at the top of the view, once the view is where it should be.
  useLayoutEffect(() => {
    virtualizer.shouldAdjustScrollPositionOnItemSizeChange = NEVER;
  }, [virtualizer]);
  const anchor = useRef<Anchor | null>(null);
  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (element === null) return;
    const held = anchor.current;
    // The element's own offset: the virtualiser's waits for the scroll event.
    const offset = element.scrollTop;
    // Only a view that has not moved since: the person, or a scroll to a change, chose where to
    // be. The browser keeps offsets in device pixels, so one it was given comes back a little off.
    if (held !== null && Math.abs(held.offset - offset) < 1) {
      const start = virtualizer.measurementsCache[anchorItem(layout, held)]?.start;
      if (start !== undefined && Math.abs(start + held.delta - offset) >= 1) {
        element.scrollTo({ top: start + held.delta, behavior: 'instant' });
        anchor.current = { ...held, offset: element.scrollTop };
        return;
      }
    }
    // Nothing above the lead can change: a view at the top stays there. Until the scroll event of a
    // jump (Home from the end, a page up), the items are those of the offset the virtualiser saw
    // last, and need not reach the view: the first one below it is no anchor.
    const top = items.find((item) => item.end > offset);
    anchor.current =
      top === undefined || top.index === 0 || top.start - offset >= 1
        ? null
        : { place: top.index === trail ? null : placeAt(layout, top.index - 1), delta: offset - top.start, offset };
  });

  // The windows of the rows on screen and those around them, at most every 100 ms. The first row
  // is settled as a place and found again in the layout of the moment, followed by as many rows as
  // the view had: a window that fails above the view turns its 500 rows into one, and the same
  // display indices would then name rows, and windows, further on; a fold that opens leaves the
  // view on its first lines.
  const visible = virtualizer.range;
  const last = layout.count - 1;
  let range: { start: Place; rows: number } | null = null;
  if (visible !== null && last >= 0) {
    const start = Math.min(last, Math.max(0, visible.startIndex - 1 - OVERSCAN));
    const end = Math.min(last, Math.max(start, visible.endIndex - 1 + OVERSCAN));
    range = { start: placeAt(layout, start), rows: end - start };
  }
  const settled = useSettled(range, range === null ? '' : `${range.start.key}+${String(range.rows)}`);
  const wanted = useMemo(() => {
    if (settled === null || layout.count === 0) return NO_WINDOWS;
    const start = indexOfPlace(layout, settled.start);
    const windows = layout.windowsFor({ start, end: Math.min(layout.count - 1, start + settled.rows) }, WINDOW_MARGIN);
    // And the window of the row with the focus, wherever the view went: its fold or failed row stays.
    const held = focused === null ? null : layout.indexOfKey(focused);
    if (held === null) return windows;
    return uniqueWindows([...windows, ...layout.windowsFor({ start: held, end: held })]);
  }, [layout, settled, focused]);
  const wantedKey = wanted.map(windowId).join(' ');
  const report = useEffectEvent(() => {
    onWindows(wanted);
  });
  useEffect(() => {
    report();
  }, [wantedKey]);

  // Revealing a change: the row's place is read again each frame from the latest layout and
  // measurements, so it still lands in the top third when rows above it are measured meanwhile.
  const latestLayout = useRef(layout);
  useLayoutEffect(() => {
    latestLayout.current = layout;
  });
  const stopScroll = useRef<(() => void) | null>(null);
  useEffect(
    () => () => {
      stopScroll.current?.();
    },
    [],
  );
  useImperativeHandle(
    ref,
    () => ({
      focus: () => {
        scrollRef.current?.focus();
      },
      reveal: (row) => {
        const element = scrollRef.current;
        if (element === null) return;
        const target = () => {
          const start = virtualizer.measurementsCache[latestLayout.current.indexOf(row) + 1]?.start;
          if (start === undefined) return element.scrollTop;
          const end = Math.max(0, element.scrollHeight - element.clientHeight);
          return Math.min(end, Math.max(0, start - element.clientHeight * REVEAL_AT));
        };
        stopScroll.current?.();
        stopScroll.current = scrollToTarget(element, target, motionOf(element));
      },
    }),
    [virtualizer],
  );

  // Up and Down by a line, Page Up and Page Down by a page less a line, Home and End (§6.9).
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const element = scrollRef.current;
    if (element === null || event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) {
      return;
    }
    const { scrollTop, clientHeight, scrollHeight } = element;
    const page = Math.max(LINE_ESTIMATE, clientHeight - LINE_ESTIMATE);
    let top: number;
    switch (event.key) {
      case 'ArrowUp':
        top = scrollTop - LINE_ESTIMATE;
        break;
      case 'ArrowDown':
        top = scrollTop + LINE_ESTIMATE;
        break;
      case 'PageUp':
        top = scrollTop - page;
        break;
      case 'PageDown':
        top = scrollTop + page;
        break;
      case 'Home':
        top = 0;
        break;
      case 'End':
        top = scrollHeight;
        break;
      default:
        return;
    }
    event.preventDefault();
    stopScroll.current?.();
    element.scrollTo({ top: Math.min(Math.max(0, scrollHeight - clientHeight), Math.max(0, top)), behavior: 'instant' });
  };

  // The region keeps the focus while the fold's row turns into its lines.
  const unfold = useCallback(
    (row: number, fold: Fold) => {
      if (identity === null) return;
      scrollRef.current?.focus({ preventScroll: true });
      setUnfolded((state) => openFold(state, identity, row, fold));
    },
    [identity],
  );
  // A failed window's "Try again" keeps the focus until its row turns into its rows, loading again;
  // the region then gets it (`keepFocus`). A row still failing when the read settles is read again.
  const unit = word ? 'paragraphs' : 'lines';
  const windows = useRetry(
    identity ?? '',
    {
      settled: read.windows.map((answer) => answer.settled).join(' '),
      fetching: read.windows.some((answer) => answer.fetching),
      failing: checked.failed.size > 0,
    },
    retry,
  );
  const failedText = t(`lines.failed.${unit}`);
  useRetryAnnouncement(failedText, windows.failedAgain);

  const signs = { added: t('sign.added'), removed: t('sign.removed') };
  const labels = {
    added: t(word ? 'lines.addedParagraph' : 'lines.added'),
    removed: t(word ? 'lines.removedParagraph' : 'lines.removed'),
  };
  const renderRow = (display: DisplayRow, index: number): ReactNode => {
    switch (display.kind) {
      case 'pending':
        return <PendingLine index={index} />;
      case 'failed':
        return <FailedRow text={failedText} retryLabel={t('actions.tryAgain')} onRetry={windows.retry} />;
      case 'row': {
        const { row } = display;
        if (row.kind === 'fold') {
          // Folds come only from rows of the folded diff, which have an index.
          if (display.index === null) return null;
          return (
            <FoldRow
              index={display.index}
              fold={row}
              label={t(`lines.unfold.${unit}`, { count: row.lines })}
              onUnfold={unfold}
            />
          );
        }
        if (row.kind === 'context') return <DiffLine row={row} sign="" label={null} />;
        return <DiffLine row={row} sign={signs[row.kind]} label={labels[row.kind]} current={row.change === current} />;
      }
    }
  };

  const content = (index: number): ReactNode => {
    if (index === 0) {
      return (
        <div className="diff-lines__lead">
          {banners}
          {approximate && <InfoNote text={t(`lines.approximate.${unit}`)} />}
        </div>
      );
    }
    if (index === trail) {
      return (
        <div className="diff-lines__trail">
          {word && (
            <p className="diff-lines__word-note">
              <Info aria-hidden size={SIZE.iconSmall} className="diff-lines__word-icon" />
              <span>{t('lines.wordNote')}</span>
            </p>
          )}
          {tags !== null && <TagsBlock tags={tags} intro="withContent" />}
        </div>
      );
    }
    return renderRow(layout.rowAt(index - 1), index - 1);
  };
  // Rows on screen still loading: the region is busy until their window answers.
  const loading = items.some((item) => item.index > 0 && item.index < trail && layout.rowAt(item.index - 1).kind === 'pending');
  const rendered = items.map((item) => (
    <div
      key={item.key}
      ref={virtualizer.measureElement}
      data-index={item.index}
      className="diff-lines__item"
      style={{ transform: `translateY(${String(item.start)}px)` }}
    >
      {content(item.index)}
    </div>
  ));

  return (
    <div ref={keepFocus} className="diff-lines-frame">
      <div
        ref={scrollRef}
        className="diff-lines"
        role="region"
        aria-label={label}
        aria-busy={loading || undefined}
        tabIndex={0}
        data-word={word || undefined}
        onKeyDown={onKeyDown}
        onFocus={onFocus}
      >
        <div className="diff-lines__sizer" style={{ height: virtualizer.getTotalSize() }}>
          {rendered}
        </div>
      </div>
    </div>
  );
}
