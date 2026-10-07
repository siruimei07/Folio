import '../components/motion.css';
import './HistoryView.css';

import { CircleX, FunnelX, History, Lock, RefreshCw } from 'lucide-react';
import { type ReactNode, type RefObject, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { showChange } from '../app/changeTarget';
import { DETAILED, LoadFailure } from '../app/feedback';
import { COPY_PATH_KEYS, useFileActions } from '../app/fileActions';
import { isHistoryStarting } from '../app/firstCommit';
import { FirstCommitBlock } from '../app/FirstCommitBlock';
import { takeHistoryTarget, takeHistoryTimeline, usePendingHistoryTarget, usePendingHistoryTimeline } from '../app/historyTarget';
import { useLayout } from '../app/layout';
import { useCanShowView } from '../app/navigation';
import type { DiffPaneHandle } from '../app/panes';
import { useShortcut } from '../app/shortcuts';
import { useRetriedFailure } from '../app/useRetriedFailure';
import { copyErrorDetails } from '../app/windowErrors';
import { Banner } from '../components/Banner/Banner';
import { Button } from '../components/Button/Button';
import { useFocusKeeper } from '../components/collections/useFocusKeeper';
import { Panel } from '../components/Panel/Panel';
import { StateBlock } from '../components/StateBlock/StateBlock';
import { useLocatedVersion } from '../data/diff';
import type { IpcFailure } from '../data/errors';
import { type HistoryPages, useFileHistory, useFirstCommit, useHistoryTimeline } from '../data/history';
import { useLibrary } from '../data/library';
import { useWorkspace } from '../data/workspace';
import type { FileRef, FileVersion, HistoryItem, HistoryState, HistoryType, IpcError } from '../ipc';
import { nameOf } from '../lib/paths';
import { SIZE } from '../tokens/tokens';
import { type CardHost, CardHostContext } from './cards/host';
import { EmptyDiff } from './EmptyDiff';
import { FileFilterChip } from './FileFilterChip';
import { HistoryDiff } from './HistoryDiff';
import { EntryMenu } from './menus/EntryMenu';
import { RowMenu } from './menus/RowMenu';
import { filterKey } from './model/filter';
import { copyablePath } from './model/rows';
import { type HistorySelection, reanchor } from './model/selection';
import {
  cameLater,
  type CurrentVersion,
  currentVersionOf,
  fileHistoryRows,
  type TimelineRow,
  wholeHistoryRows,
} from './model/timelineRows';
import { clampPanelWidth, resetPanelWidth, setPanelWidth, useHistoryPreferences } from './preferences';
import { ResizeHandle } from './ResizeHandle';
import { isCurrentVersion } from './restore/restorable';
import { RestoreHost } from './restore/RestoreDialog';
import { restoreKeys, useFreshEntry } from './restore/state';
import {
  cover,
  fileKey,
  focusFileHistory,
  focusWholeHistory,
  placeFile,
  selectRow,
  setSelection,
  showTypes,
  showWholeHistory,
  takeTimelineFocus,
  type TimelineName,
  uncover,
  useHistoryView,
} from './state';
import { Timeline } from './timeline/Timeline';
import { TimelineSkeleton } from './timeline/TimelineSkeleton';
import { TypeFilter } from './TypeFilter';

/** The least width the diff column keeps beside the panel: the panel's own least width. */
const DIFF_MIN = SIZE.historyPanelMin;

/** The widest the panel can be in a view this wide: `size.history-panel-max`, less when the diff needs the room. */
function greatestPanelWidth(viewWidth: number): number {
  if (viewWidth <= 0) return SIZE.historyPanelMax;
  return Math.max(SIZE.historyPanelMin, Math.min(SIZE.historyPanelMax, viewWidth - SIZE.resizeHandle - DIFF_MIN));
}

/**
 * An element's width, followed with a `ResizeObserver` on the element the returned callback ref
 * gets. A width of 0 (the view hidden in `<Activity>`) keeps the last one.
 */
function useElementWidth(): [width: number, ref: (node: HTMLElement | null) => (() => void) | undefined] {
  const [width, setWidth] = useState(0);
  const ref = useCallback((node: HTMLElement | null) => {
    if (node === null) return undefined;
    const measure = (next: number) => {
      if (next > 0) setWidth(next);
    };
    measure(node.offsetWidth);
    const observer = new ResizeObserver(([entry]) => {
      if (entry) measure(entry.contentRect.width);
    });
    observer.observe(node);
    return () => {
      observer.disconnect();
    };
  }, []);
  return [width, ref];
}

/** "Couldn't update the history.": a refresh failed while the entries read before still show. */
function RefreshFailed({ failure, retry }: { failure: IpcFailure; retry: () => void }) {
  const { t } = useTranslation(['history', 'shell', 'errors']);
  const title = t('states.refreshFailed');
  const { error } = failure;
  return (
    <div className="history-banner">
      <Banner
        tone="danger"
        announce
        title={title}
        text={t(`errors:${error.code}`)}
        actions={
          <>
            <Button size="compact" icon={RefreshCw} onPress={retry}>
              {t('shell:tryAgain')}
            </Button>
            {DETAILED.has(error.code) && (
              <Button
                size="compact"
                onPress={() => {
                  copyErrorDetails(title, error);
                }}
              >
                {t('shell:copyDetails.action')}
              </Button>
            )}
          </>
        }
      />
    </div>
  );
}

/** "Nothing of these types yet" (§7.5), naming the kinds the filter shows, and "Show all types". */
function NothingOfTheseTypes({ filter }: { filter: readonly HistoryType[] }) {
  const { t, i18n } = useTranslation('history');
  const types = new Intl.ListFormat(i18n.language, { type: 'disjunction' }).format(filter.map((type) => t(`nothingOf.${type}`)));
  return (
    <StateBlock
      icon={FunnelX}
      title={t('states.filtered.title')}
      text={t('states.filtered.text', { types })}
      actions={
        <Button
          onPress={() => {
            showTypes(null);
          }}
        >
          {t('states.filtered.action')}
        </Button>
      }
    />
  );
}

/**
 * The selection follows the entries: a message edit gives its commit a new id, and an entry that
 * went (an undone commit) or that the filter leaves out lets the diff go back to the desk, once the
 * list is read past where it was or to its end (`complete`).
 */
function useReanchoredSelection(items: readonly HistoryItem[], complete: boolean): void {
  const selection = useHistoryView((state) => state.selection);
  useEffect(() => {
    if (selection === null) return;
    const next = reanchor(selection, items, complete);
    if (next !== undefined) setSelection(next);
  }, [selection, items, complete]);
}

/** What the panel shows: the whole history, or one file's (§7.4). */
interface ShownTimeline {
  name: TimelineName;
  /** The timeline's React key: another list starts afresh. */
  key: string;
  /** The feed's name. */
  label: string;
  list: HistoryPages<unknown>;
  rows: readonly TimelineRow[];
  /** The rows' entries, for the selection to follow. */
  items: readonly HistoryItem[];
  /** Entries in the whole list, the first commit after a file that came later included. */
  setSize: number | undefined;
  /** One file's history: the file's path, for the chip and its states; `null` for the whole history. */
  path: string | null;
  /** A version's file is being looked up: nothing is asked yet. */
  locating: boolean;
  /** One file's history: the version the file has now. */
  current: CurrentVersion | null;
}

/** The whole history, kept observed while one file's shows, so Esc finds it as it was. */
function useWholeTimeline(filter: readonly HistoryType[] | null): ShownTimeline {
  const { t } = useTranslation('history');
  const list = useHistoryTimeline(filter);
  const rows = useMemo(() => wholeHistoryRows(list.items), [list.items]);
  return {
    name: 'whole',
    key: filterKey(filter),
    label: t('feed'),
    list,
    rows,
    items: list.items,
    setSize: list.total,
    path: null,
    locating: false,
    current: null,
  };
}

/**
 * The file whose history shows (plan decision 12): a file of the library as asked, or the file a
 * version belongs to now once `locate_version` finds it, which then takes the version's place in
 * the store so the history follows the file (through rewords and later moves). A version whose file
 * was deleted since, or could not be looked up, stays a version. `undefined` while it is looked up.
 */
function useFileToShow(requested: FileRef | null): FileRef | null | undefined {
  const version = requested?.kind === 'version' ? { commit: requested.commit, path: requested.path } : null;
  const located = useLocatedVersion(version);
  const found = located.data;
  useEffect(() => {
    if (requested?.kind === 'version' && found !== undefined && found !== null) {
      placeFile(requested, { kind: 'entry', entry: { id: found.id, path: found.path } });
    }
  }, [requested, found]);
  if (requested === null || requested.kind === 'entry') return requested;
  return located.error !== null || found === null ? requested : undefined;
}

/**
 * One file's history (§7.4, ipc-m2 §8.3), newest first, then the first commit when the file came
 * later; the type filter applies.
 */
function useFileTimeline(requested: FileRef | null, filter: readonly HistoryType[] | null): ShownTimeline {
  const { t } = useTranslation('history');
  const file = useFileToShow(requested);
  const list = useFileHistory(file ?? null, filter);
  const path = requested === null ? null : requested.kind === 'entry' ? requested.entry.path : requested.path;
  const name = path === null ? '' : nameOf(path);
  const complete = list.status === 'success' && !list.hasMore;
  const later = cameLater(list.items, complete);
  const firstCommit = useFirstCommit(later);
  const first = firstCommit.data ?? null;
  const rows = useMemo(
    () => fileHistoryRows(list.items, { complete, first: later ? first : null, name }),
    [list.items, complete, later, first, name],
  );
  const items = useMemo(() => rows.map((row) => row.item), [rows]);
  const current = useMemo(() => currentVersionOf(list.items), [list.items]);
  const before = rows.at(-1)?.kind === 'before';
  // The first commit could not be read: the history ends with the failed earlier entries' row, and
  // its Try again reads the first commit again (no silent failure, CLAUDE.md §5).
  const firstUnread = later && firstCommit.data === undefined && (firstCommit.isError || firstCommit.isFetching);
  const { refetch } = firstCommit;
  const shownList: HistoryPages<FileVersion> = firstUnread
    ? {
        ...list,
        error: firstCommit.error,
        loadMoreFailed: true,
        isFetching: list.isFetching || firstCommit.isFetching,
        retry: () => {
          void refetch();
        },
      }
    : list;
  return {
    name: 'file',
    key: `${file === undefined || file === null ? '' : fileKey(file)} ${filterKey(filter)}`,
    label: t('fileFeed', { name }),
    list: shownList,
    rows,
    items,
    setSize: list.total === undefined ? undefined : list.total + (before ? 1 : 0),
    path,
    locating: requested !== null && file === undefined,
    current,
  };
}

/**
 * "View history of this file" from any view (`app/historyTarget.ts`): its history shows here. "N
 * more in History": the whole history, its timeline with the focus.
 */
function useHistoryTarget(): void {
  const pending = usePendingHistoryTarget();
  const timeline = usePendingHistoryTimeline();
  useEffect(() => {
    if (pending === null) return;
    const file = takeHistoryTarget();
    if (file !== null) focusFileHistory(file);
  }, [pending]);
  useEffect(() => {
    if (timeline && takeHistoryTimeline()) focusWholeHistory();
  }, [timeline]);
}

/** "Go to Changes" (§7.4, §7.5), while the Changes view is on the rail. */
function GoToChanges() {
  const { t } = useTranslation('history');
  if (!useCanShowView('changes')) return null;
  return (
    <Button
      variant="accent"
      onPress={() => {
        showChange();
      }}
    >
      {t('states.goToChanges')}
    </Button>
  );
}

/** "Midterm review.md has no history yet" (§7.4): a file no commit holds yet. */
function NoFileHistory({ name }: { name: string }) {
  const { t } = useTranslation('history');
  return <StateBlock icon={History} title={t('file.none.title', { name })} text={t('file.none.text')} actions={<GoToChanges />} />;
}

/**
 * "History is read-only." (§7.5): a newer Folio wrote it; the actions say so where they are
 * disabled. The read-only lock, as the Library's and Changes' read-only banners (library-actions §2.3).
 */
function ReadOnlyBanner() {
  const { t } = useTranslation('history');
  return (
    <div className="history-banner">
      <Banner tone="warning" icon={Lock} title={t('states.readOnly.title')} text={t('states.readOnly.text')} />
    </div>
  );
}

/**
 * "Folio can't read this library's history" (§7.5): the files are fine; "Copy details" copies the
 * timeline's own `HistoryDamaged` when it has one, for the developer.
 */
function DamagedHistory({ error }: { error: IpcError | null }) {
  const { t } = useTranslation(['history', 'shell']);
  const title = t('states.damaged.title');
  const details: IpcError = error ?? { code: 'HistoryDamaged', detail: 'get_workspace: historyState damaged' };
  return (
    <StateBlock
      tone="danger"
      icon={CircleX}
      title={title}
      text={t('states.damaged.text')}
      actions={
        <Button
          onPress={() => {
            copyErrorDetails(title, details);
          }}
        >
          {t('shell:copyDetails.action')}
        </Button>
      }
    />
  );
}

/**
 * Whether a timeline that just showed takes the focus: once one file's history opened or closed,
 * unless the diff has the focus (its "More" offered "View history of this file").
 */
function takeFocusOnShow(): boolean {
  if (!takeTimelineFocus()) return false;
  return (document.activeElement?.closest('.history-diff') ?? null) === null;
}

/**
 * Before the history has started, the first commit's block takes the focus asked of the timeline
 * (WCAG 2.4.3): "View history of this file" or "N more in History" from another view hid the control
 * that had it, and no timeline shows to take it. Once the history starts, the view's keeper hands
 * it on to the timeline.
 */
function useFirstCommitFocus(starting: boolean, section: RefObject<HTMLElement | null>): void {
  const asked = useHistoryView((state) => state.focusNext);
  useLayoutEffect(() => {
    const block = section.current?.querySelector<HTMLElement>('.first-commit') ?? null;
    if (starting && asked && block !== null && takeFocusOnShow()) block.focus({ preventScroll: true });
  }, [starting, asked, section]);
}

interface TimelineAreaProps {
  shown: ShownTimeline;
  filter: readonly HistoryType[] | null;
  /** The restore entry that just arrived, highlighted for a while (§7.2). */
  fresh: string | null;
  /** The history's state (`get_workspace`); `undefined` until it is known, or when it could not be read. */
  historyState: HistoryState | undefined;
  /** The panel it is in, which takes the focus asked of the timeline while a state shows. */
  panel: RefObject<HTMLDivElement | null>;
  /** A narrow window's diff covers the panel, which then cannot take the focus: the diff takes it (`useCardHost`). */
  covered: boolean;
}

/**
 * The panel's body: the read-only banner on its own row whatever shows under it (§7.5), then the
 * timeline, or the state or skeleton that takes its place (§7.4, §7.5). A failure (the first
 * page's, a refresh's, the next page's) keeps its "Try again" and the focus while the retry reads,
 * and is read out again when it fails again (`useRetriedFailure`); when the retry works, the view's
 * keeper hands the focus to the timeline. A state shown when the view asks the timeline for the
 * focus (`focusNext`: one file's history opened from the Library or closed) takes it instead
 * (`panelFocusTarget`), so it never stays on the page; neither takes it while the diff covers the
 * panel. Keyed by the list it shows.
 */
function TimelineArea({ shown, filter, fresh, historyState, panel, covered }: TimelineAreaProps) {
  const { t } = useTranslation('history');
  const { list } = shown;
  const failure = useRetriedFailure(
    [list.error],
    list.isFetching,
    t(list.items.length === 0 ? 'states.failed' : list.loadMoreFailed ? 'states.earlierFailed' : 'states.refreshFailed'),
    list.retry,
  );
  // What takes the timeline's place: a state, or the skeleton while the list loads.
  let state: ReactNode = null;
  let loading = false;
  if (historyState === 'damaged') {
    state = <DamagedHistory error={list.error?.error.code === 'HistoryDamaged' ? list.error.error : null} />;
  } else if (shown.locating) {
    loading = true;
  } else if (failure.shown !== null && list.items.length === 0) {
    state = <LoadFailure title={t('states.failed')} error={failure.shown.error} retry={failure.retry} placement="panel" />;
  } else if (list.total === undefined) {
    loading = true;
  } else if (list.total === 0) {
    state =
      filter !== null ? (
        <NothingOfTheseTypes filter={filter} />
      ) : shown.path !== null ? (
        <NoFileHistory name={nameOf(shown.path)} />
      ) : (
        <StateBlock icon={History} title={t('states.empty.title')} text={t('states.empty.text')} actions={<GoToChanges />} />
      );
  }
  const asked = useHistoryView((view) => view.focusNext);
  const showsState = state !== null;
  useLayoutEffect(() => {
    if (!asked || !showsState || covered || panel.current === null) return;
    const target = panelFocusTarget(panel.current);
    if (target !== null && takeFocusOnShow()) target.focus({ preventScroll: true });
  });
  const banner = historyState === 'readOnly' ? <ReadOnlyBanner /> : null;
  if (loading || state !== null) {
    return (
      <>
        {banner}
        {loading ? <TimelineSkeleton /> : state}
      </>
    );
  }
  return (
    <>
      {banner}
      {failure.shown !== null && !list.loadMoreFailed && <RefreshFailed failure={failure.shown} retry={failure.retry} />}
      <Timeline
        key={shown.key}
        name={shown.name}
        rows={shown.rows}
        list={{ ...list, error: failure.shown, retry: failure.retry }}
        setSize={shown.setSize}
        label={shown.label}
        takeFocus={covered ? undefined : takeFocusOnShow}
        onEscape={shown.path === null ? undefined : showWholeHistory}
        fresh={fresh}
      />
    </>
  );
}

/**
 * Where the focus goes with the diff (§2.2, §7.6): into it when a narrow window's diff opens over
 * the list, and back to the row it shows (else the timeline's tab stop) when "Back" closes it, the
 * list as it was. The cards reach it through `CardHostContext`.
 */
function useCardHost(narrow: boolean, covered: boolean, panel: RefObject<HTMLDivElement | null>) {
  const diffRef = useRef<DiffPaneHandle>(null);
  const focusOnCover = useRef(false);
  const focusOnUncover = useRef(false);
  // Back in a narrow window: the list comes back with the fade and rise (§14).
  const [returned, setReturned] = useState(false);
  const host = useMemo(
    (): CardHost => ({
      select: (selection) => {
        selectRow(selection, narrow);
        focusOnCover.current = narrow;
        setReturned(false);
      },
      focusDiff: () => {
        if (!narrow) {
          diffRef.current?.focus();
          return;
        }
        focusOnCover.current = true;
        setReturned(false);
        cover();
      },
    }),
    [narrow],
  );
  const back = useCallback(() => {
    focusOnUncover.current = true;
    setReturned(true);
    uncover();
  }, []);
  const settled = useCallback(() => {
    setReturned(false);
  }, []);
  // A wider window shows the diff beside the list and forgets the one over it, as the Changes view
  // does: narrowing again never covers the list by itself, where the focus may be (§2.2). The view's
  // keeper takes a focus that was in the cover to the diff in its new place.
  useLayoutEffect(() => {
    if (!narrow && useHistoryView.getState().covered) uncover();
  }, [narrow]);
  useLayoutEffect(() => {
    if (covered && focusOnCover.current) {
      focusOnCover.current = false;
      diffRef.current?.focus();
    } else if (!covered && focusOnUncover.current) {
      focusOnUncover.current = false;
      if (panel.current !== null) panelFocusTarget(panel.current, true)?.focus();
    }
  }, [covered, panel]);
  // The timeline asked for the focus while the diff covers the list (a dialog closed after its
  // commit went): the list under the cover cannot take it, so the diff does, the cover kept.
  const asked = useHistoryView((state) => state.focusNext);
  useLayoutEffect(() => {
    if (covered && asked && diffRef.current !== null && takeFocusOnShow()) diffRef.current.focus();
  }, [covered, asked]);
  return { host, diffRef, back, returned, settled };
}

/**
 * Where the panel puts the focus it is given (WCAG 2.4.3): the timeline's tab stop, or from the
 * diff the row it showed first; with a state in the timeline's place, the state's first button
 * ("Go to Changes", "Show all types", "Try again"), else the header's first control (the file chip's
 * button, else the type filter). `null` while the panel loads: the list that arrives takes it.
 */
function panelFocusTarget(panel: Element, fromDiff = false): HTMLElement | null {
  const row = fromDiff ? panel.querySelector<HTMLElement>('[role="option"][aria-selected="true"]') : null;
  const entry = row ?? panel.querySelector<HTMLElement>('article[tabindex="0"]');
  if (entry !== null) return entry;
  const state = panel.querySelector('.panel__body > .state-block');
  if (state === null) return null;
  return state.querySelector<HTMLElement>('button') ?? panel.querySelector<HTMLElement>('.panel__actions button');
}

/**
 * The parts of the view that keep their own focus while they stay (`useFocusKeeper`): the diff pane,
 * beside the panel or over it, and the feed with its entries and cards. Any other control is a part
 * of its own: a state's or banner's "Try again", the timeline's end row, the file chip's button, the
 * first commit's block.
 */
const FOCUS_PARTS = '.history-diff, .timeline__feed';

/**
 * Keeps the focus in the view when the part that had it goes as a whole (WCAG 2.4.3): a failure's
 * block, banner or row once its "Try again" worked, "Nothing of these types yet" after "Show all
 * types", the feed when its list empties (one file's only commit undone), the first commit's block
 * once the history has started, the diff column when its selection goes or the window crosses the
 * breakpoint. A part still on the page keeps its own focus, whose keeper runs after this one (a
 * `MutationObserver` created later: the diff's Restore turning disabled or moving into More, a
 * diff's "Try again" giving way to its lines). The diff in its new place takes it, else the panel
 * (`panelFocusTarget`), as soon as it has something to take it: a list still loading gives it once
 * it arrives; before the history has started, the first commit's block. A callback ref for the
 * view's element.
 */
function useViewFocus(diff: RefObject<DiffPaneHandle | null>): (view: HTMLElement | null) => (() => void) | undefined {
  const last = useRef<Element | null>(null);
  const element = useRef<HTMLElement | null>(null);
  const keep = useFocusKeeper(() => {
    const part = last.current;
    const view = element.current;
    if (part === null || part.isConnected || view === null) return;
    const fromDiff = part.matches('.history-diff');
    if (fromDiff && diff.current !== null) {
      diff.current.focus();
      return;
    }
    const panel = view.querySelector('.history-view__panel');
    const target = panel === null ? view.querySelector<HTMLElement>('.first-commit') : panelFocusTarget(panel, fromDiff);
    target?.focus({ preventScroll: true });
  });
  return useCallback(
    (view: HTMLElement | null) => {
      if (view === null) return undefined;
      element.current = view;
      const note = (event: FocusEvent) => {
        const { target } = event;
        last.current = target instanceof Element ? (target.closest(FOCUS_PARTS) ?? target) : null;
      };
      view.addEventListener('focusin', note, true);
      const stop = keep(view);
      return () => {
        view.removeEventListener('focusin', note, true);
        element.current = null;
        stop?.();
      };
    },
    [keep],
  );
}

/** Ctrl+Shift+C copies the path of the row the diff shows (library-actions §6), as its menus' "Copy path" does. */
function useCopyPathShortcut(selection: HistorySelection | null): void {
  const files = useFileActions();
  const path = selection === null ? null : copyablePath(selection.row);
  useShortcut(
    COPY_PATH_KEYS,
    path === null
      ? null
      : () => {
          files.copyPaths([path]);
        },
  );
}

function HistoryScreen() {
  const { t } = useTranslation('history');
  const narrow = useLayout() === 'narrow';
  const panelId = useId();
  const headingId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const historyState = useWorkspace().data?.historyState;
  const [viewWidth, measureView] = useElementWidth();
  const selection = useHistoryView((state) => state.selection);
  const covered = useHistoryView((state) => state.covered) && narrow && selection !== null;
  const { host, diffRef, back, returned, settled } = useCardHost(narrow, covered, panelRef);
  const keepFocus = useViewFocus(diffRef);
  const view = useCallback(
    (element: HTMLElement | null) => {
      const stopMeasuring = measureView(element);
      const stopKeeping = keepFocus(element);
      return () => {
        stopMeasuring?.();
        stopKeeping?.();
      };
    },
    [measureView, keepFocus],
  );
  const stored = useHistoryPreferences((state) => state.panelWidth);
  const filter = useHistoryPreferences((state) => state.types);
  const requested = useHistoryView((state) => state.file);
  useHistoryTarget();
  const starting = isHistoryStarting(historyState);
  const firstCommitRef = useRef<HTMLElement>(null);
  useFirstCommitFocus(starting, firstCommitRef);
  const whole = useWholeTimeline(filter);
  const oneFile = useFileTimeline(requested, filter);
  const shown = requested === null ? whole : oneFile;
  useReanchoredSelection(shown.items, shown.list.status === 'success' && !shown.list.hasMore);
  const fresh = useFreshEntry(shown.items);
  const knownRestores = useCallback(() => restoreKeys(shown.items), [shown.items]);
  const current = selection !== null && isCurrentVersion(selection.commit, selection.row, shown.current);
  useCopyPathShortcut(selection);
  const max = greatestPanelWidth(viewWidth);
  const width = clampPanelWidth(stored, max);
  const header = (
    <>
      {shown.path !== null && <FileFilterChip path={shown.path} onRemove={showWholeHistory} />}
      <TypeFilter />
    </>
  );

  return (
    <CardHostContext value={host}>
      <div ref={view} className="history-view" data-covered={covered || undefined}>
        {starting ? (
          // Before the history has started, the view is one panel with the first commit's block
          // (§10), as the Changes view is, named "History" by a heading above the block's.
          <section ref={firstCommitRef} className="panel history-view__first-commit" aria-labelledby={headingId}>
            <h2 id={headingId} className="visually-hidden">
              {t('title')}
            </h2>
            <FirstCommitBlock text={t('states.starting')} />
          </section>
        ) : (
          <>
            <div
              ref={panelRef}
              id={panelId}
              className="history-view__panel"
              style={narrow ? undefined : { width }}
              data-returned={(returned && !covered) || undefined}
              onAnimationEnd={(event) => {
                if (event.target === event.currentTarget && event.animationName === 'rise-in') settled();
              }}
            >
              <Panel title={t('title')} actions={header} className="history-panel">
                <TimelineArea
                  key={`${shown.name} ${shown.key}`}
                  shown={shown}
                  filter={filter}
                  fresh={fresh}
                  historyState={historyState}
                  panel={panelRef}
                  covered={covered}
                />
              </Panel>
            </div>
            {!narrow && (
              <>
                <ResizeHandle
                  value={width}
                  min={SIZE.historyPanelMin}
                  max={max}
                  controls={panelId}
                  label={t('resize')}
                  onChange={setPanelWidth}
                  onReset={resetPanelWidth}
                />
                {selection === null ? <EmptyDiff /> : <HistoryDiff ref={diffRef} selection={selection} current={current} />}
              </>
            )}
            {covered && (
              <div className="history-view__cover">
                <HistoryDiff ref={diffRef} selection={selection} current={current} onBack={back} />
              </div>
            )}
            <RowMenu current={shown.current} />
            <EntryMenu />
            <RestoreHost knownRestores={knownRestores} />
          </>
        )}
      </div>
    </CardHostContext>
  );
}

/**
 * The History view (handoff workspace-history §7, app-shell §7): the History panel with its type
 * filter and timeline, and beside it the diff column with the version of the file row selected in a
 * card; the handle between them resizes the panel. "View history of this file" shows one file's
 * history instead, with its chip in the header, until the chip's button or Esc (§7.4). Restoring a
 * version asks first, in the view's own confirmation, and the restore entry that arrives is
 * highlighted for a while (§8, `restore/`). A commit's entry offers Edit message and Undo commit
 * (§7.3, §9; app/CommitActions.tsx). The history's own state (`get_workspace`) shows too (§7.5,
 * §10): read-only under a banner with those actions disabled, damaged as a block with Copy details,
 * and before the first commit the first commit's block in one panel. In a narrow window the panel
 * takes the width, the handle goes, and a selected row's diff covers the list until "Back" (§2.2).
 * The window shows it only while a library is open; another library gets a fresh screen.
 */
export function HistoryView() {
  const library = useLibrary();
  return library === null ? null : <HistoryScreen key={library.id} />;
}
