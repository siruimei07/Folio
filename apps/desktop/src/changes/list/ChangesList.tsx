import './ChangesList.css';

import { CircleCheck, List, ListTree } from 'lucide-react';
import { type MouseEvent, type Ref, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { LoadFailure, showFailure, whenSettled } from '../../app/feedback';
import { showToast } from '../../app/toasts';
import type { RetriedFailure } from '../../app/useRetriedFailure';
import { Checkbox } from '../../components/Checkbox/Checkbox';
import { keyboardMenuAnchor } from '../../components/collections/rows';
import type { CollectionHandle, IndexRange } from '../../components/collections/useVirtualRows';
import { type CollectionItem, VirtualList } from '../../components/collections/VirtualList';
import { ContextMenu, isContextMenuKey, type MenuAnchor } from '../../components/Menu/Menu';
import { Panel } from '../../components/Panel/Panel';
import { SegmentedControl } from '../../components/SegmentedControl/SegmentedControl';
import { Skeleton } from '../../components/Skeleton/Skeleton';
import { StateBlock } from '../../components/StateBlock/StateBlock';
import type { IpcFailure } from '../../data/errors';
import { useCourses } from '../../data/groups';
import { LIST_PAGE } from '../../data/paged';
import { isDroppedRead, readWorkspaceNow, useSelectionSummary, useWorkspace } from '../../data/workspace';
import { LIMITS, type Selection, type SummaryGroup, type WorkspaceItem, type WorkspaceSummary } from '../../ipc';
import { SIZE } from '../../tokens/tokens';
import {
  addsKey,
  headerState,
  includabilityOf,
  type Inclusion,
  isIncluded,
  keptKeyCount,
  sameSelection,
  selectAllCounts,
} from '../inclusion';
import { ChangeMenu, hasMenu, type InclusionAction } from '../menus/ChangeMenu';
import { type ListLayout, setListLayout, useChangesPreferences } from '../preferences';
import {
  dropStaleKeys,
  noteShown,
  type RowRef,
  setAllIncluded,
  setFocus,
  setIncluded,
  setOffset,
  useChangesView,
} from '../state';
import { ChangeRowView, MetadataHeaderRow, PlaceHeaderRow, PlaceholderRow, type RowBox } from './ChangeRowView';
import { type DescribeContext, describeItem, describeMetadata, describePlace, type RowText } from './describe';
import {
  countPlaces,
  type GroupStart,
  isAvailable,
  isInPlaceFolder,
  type PlaceCheck,
  placeCheck,
  placeIdOf,
  placeOfItem,
  type PlaceRef,
} from './grouped';
import { ListBanners } from './ListBanners';
import type { ChangeRowOf, ChangeRows } from './rows';

/** Pages read at once while looking for the items of a range or a place. */
const PAGES_AT_ONCE = 4;

/**
 * The items a check box change covers, and whether they are all there: `false` once they would make
 * the selection name more keys than the shell takes (`keyRoom`), when reading on is no use and the
 * change is refused as a whole.
 */
interface Covered {
  items: WorkspaceItem[];
  complete: boolean;
  /** They were read from pages (`walkItems`), one after another, not from the rows on screen. */
  paged: boolean;
}

/** What the items' indexes hold for: the workspace's fingerprint and HEAD. */
function listKeyOf({ fingerprint, head }: Pick<WorkspaceSummary, 'fingerprint' | 'head'>): string {
  return `${fingerprint}\n${head ?? ''}`;
}

/**
 * Counts the keys that turning items to `included` adds to what the shell takes (`addsKey`), and
 * says, for each item, whether the selection still fits (ipc-m2 §5.1, `LIMITS.batch`).
 */
function keyRoom(inclusion: Inclusion, included: boolean): (item: WorkspaceItem) => boolean {
  let room = LIMITS.batch - keptKeyCount(inclusion);
  return (item) => {
    if (!addsKey(inclusion, item, included)) return true;
    room -= 1;
    return room >= 0;
  };
}

/**
 * Reads the item pages of `pages` in turn, a few at once, handing their items and indexes to `take`
 * in that order (`backward`: each page's last item first); stops when `take` says so.
 */
async function walkItems(
  rows: ChangeRows,
  pages: readonly number[],
  backward: boolean,
  take: (item: WorkspaceItem, index: number) => boolean,
): Promise<void> {
  for (let first = 0; first < pages.length; first += PAGES_AT_ONCE) {
    const batch = pages.slice(first, first + PAGES_AT_ONCE);
    const answers = await Promise.all(batch.map((page) => rows.items.loadPage(page)));
    for (const answer of answers) {
      const indexed = answer.items.map((item, offset) => ({ item, index: answer.offset + offset }));
      if (backward) indexed.reverse();
      for (const { item, index } of indexed) if (!take(item, index)) return;
    }
  }
}

/**
 * The items from index `from` to the clicked index `to` among the items (either way), loading the
 * pages that are not cached, a few at once; `fits` stops it once the selection would be too long.
 */
async function itemsBetween(rows: ChangeRows, from: number, to: number, fits: (item: WorkspaceItem) => boolean): Promise<Covered> {
  const start = Math.min(from, to);
  const end = Math.min(Math.max(from, to), rows.itemCount - 1);
  const items: WorkspaceItem[] = [];
  let complete = true;
  const take = (item: WorkspaceItem, index: number): boolean => {
    if (index < start) return true;
    if (index > end) return false;
    items.push(item);
    complete = fits(item);
    return complete;
  };
  let loaded = true;
  for (let index = start; index <= end && loaded; index++) loaded = rows.items.rowAt(index) !== undefined;
  if (loaded) {
    // Every row of the range is there: no page to read.
    for (let index = start; index <= end; index++) {
      const item = rows.items.rowAt(index);
      if (item === undefined || !take(item, index)) break;
    }
    return { items, complete, paged: false };
  }
  const pages: number[] = [];
  for (let page = Math.floor(start / LIST_PAGE); page <= Math.floor(end / LIST_PAGE); page++) pages.push(page);
  await walkItems(rows, pages, false, take);
  return { items, complete, paged: true };
}

/**
 * The items of the place whose run of rows `start` begins, for its header's check box (§3.5),
 * loading the pages around it as the list caches them: on from its first item, then, for a
 * semester or the library, whose own files may also lie before it, back from there. Each way ends
 * where the place's folder does, or once `available` items that a selection can include (the
 * summary's count: includable or required) are found; `fits` stops it once the selection would be
 * too long.
 */
async function itemsOfPlace(rows: ChangeRows, start: GroupStart, available: number | null, fits: (item: WorkspaceItem) => boolean): Promise<Covered> {
  const { id, kind } = start.place;
  const items: WorkspaceItem[] = [];
  let found = 0;
  let complete = true;
  const take = (item: WorkspaceItem): boolean => {
    if (!complete || (available !== null && found >= available) || !isInPlaceFolder(item.path, id)) return false;
    if (placeOfItem(item).id !== id) return true;
    items.push(item);
    if (isAvailable(item)) found += 1;
    complete = fits(item);
    return complete;
  };
  const pages = Math.ceil(rows.itemCount / LIST_PAGE);
  const first = Math.floor(start.item / LIST_PAGE);
  const on = Array.from({ length: pages - first }, (_, at) => first + at);
  await walkItems(rows, on, false, (item, index) => index < start.item || take(item));
  if (kind === 'course') return { items, complete, paged: true };
  const back = Array.from({ length: first + 1 }, (_, at) => first - at);
  await walkItems(rows, back, true, (item, index) => index >= start.item || take(item));
  return { items, complete, paged: true };
}

/**
 * `compute` for one render, worked out once per `keyOf`: `itemAt` and the row both read a row's
 * words (by row key) and a place header's words and check box (by place id).
 */
function perRender<T, V>(keyOf: (input: T) => string, compute: (input: T) => V): (input: T) => V {
  const cache = new Map<string, V>();
  return (input) => {
    const key = keyOf(input);
    let value = cache.get(key);
    if (value === undefined) {
      value = compute(input);
      cache.set(key, value);
    }
    return value;
  };
}

/** What the place headers read from the selection's summary (§3.5, §6.4). */
export interface PlaceSummary {
  /** The summary's groups by place id (`placeIdOf`). */
  groups: ReadonlyMap<string, SummaryGroup>;
  /** The summary is of the selection the list shows, not of one changed a moment ago. */
  fresh: boolean;
  selection: Selection;
}

/** A place's header check box the person just set, until the summary of what they set comes. */
interface PendingPlace {
  id: string;
  state: boolean;
  selection: Selection;
}

/** A row's context menu while it is open. */
interface OpenMenu {
  anchor: MenuAnchor;
  row: ChangeRowOf;
  index: number;
  label: string;
  /** Opened by Shift+F10 or the Menu key. */
  keyboard: boolean;
}

interface RowsListProps {
  rows: ChangeRows;
  inclusion: Inclusion;
  /** The selected row (`selectedIndexOf`), which holds the focus. */
  selectedIndex: number | null;
  /** Ctrl+A: what "Include all changes" does. */
  onSelectAll: () => void;
  onRangeChange: (range: IndexRange) => void;
  /** Enter on a row (§3.6): the view moves the focus into the diff. */
  onEnter: (index: number) => void;
  /** A click on a row, after it is selected: in a narrow window it opens the diff (§2.2). */
  onRowClick?: (index: number) => void;
  /** A commit runs: the check boxes do nothing, the selection still moves (§3.8). */
  committing: boolean;
  /** Grouped by course (§3.5): the rows leave out what their place's header says. */
  grouped: boolean;
  places: PlaceSummary;
  /** The list the items' indexes hold for (`listKeyOf`): a range's or a place's read acts only under it. */
  listKey: string;
  listRef: Ref<CollectionHandle>;
}

/**
 * The rows of the list: a list box whose options carry check boxes (§3.6), grouped by course under
 * headers that are options too, with a check box for every change of their place (§3.5); and the
 * rows' menus (§3.7).
 */
function RowsList({
  rows,
  inclusion,
  selectedIndex,
  onSelectAll,
  onRangeChange,
  onEnter,
  onRowClick,
  committing,
  grouped,
  places,
  listKey,
  listRef,
}: RowsListProps) {
  const { t, i18n } = useTranslation(['changes', 'common']);
  const courses = useCourses().data ?? [];
  const [initialOffset] = useState(() => useChangesView.getState().offset);
  const [menu, setMenu] = useState<OpenMenu | null>(null);
  const [pending, setPending] = useState<PendingPlace | null>(null);
  // A header's check box is reading its place's pages: another press waits for it.
  const placeBusy = useRef(false);
  // `listKey` now, `null` once these rows are gone (`readThen`).
  const listNow = useRef<string | null>(listKey);
  useLayoutEffect(() => {
    listNow.current = listKey;
    return () => {
      listNow.current = null;
    };
  }, [listKey]);
  const descriptions = useId();

  // The selection follows the row now in its place once that row has loaded.
  const selectedRow = selectedIndex === null ? null : rows.rowAt(selectedIndex);
  const selectedKey = selectedRow?.kind === 'item' || selectedRow?.kind === 'metadata' || selectedRow?.kind === 'group' ? selectedRow.key : null;
  useEffect(() => {
    if (selectedKey !== null && selectedIndex !== null) setFocus({ key: selectedKey, index: selectedIndex });
  }, [selectedKey, selectedIndex]);

  const context: DescribeContext = { t, language: i18n.language, courses, grouped };
  const textOf = perRender(
    (row: ChangeRowOf) => row.key,
    (row): RowText => (row.kind === 'item' ? describeItem(row.item, context) : describeMetadata(row.change, context)),
  );
  const position = (index: number) => (rows.header >= 0 && index > rows.header ? index : index + 1);
  const descriptionId = (index: number) => `${descriptions}-${String(index)}`;

  // The loaded items of each place: their header's check box says them at once (`placeCheck`).
  const counts = useMemo(
    () => (grouped ? countPlaces(rows.loadedItems(), (item) => isIncluded(inclusion, item)) : null),
    [grouped, rows, inclusion],
  );
  const checkOf = (place: PlaceRef): PlaceCheck =>
    placeCheck(places.groups.get(place.id), counts?.get(place.id), {
      fresh: places.fresh,
      pending: pending !== null && pending.id === place.id && pending.selection === places.selection ? pending.state : undefined,
    });
  const placeOf = perRender(
    (start: GroupStart) => start.place.id,
    ({ place }) => {
      const check = checkOf(place);
      return { text: describePlace(place, places.groups.get(place.id), check, context), check };
    },
  );

  const itemAt = (index: number): CollectionItem => {
    const row = rows.rowAt(index);
    const selected = index === selectedIndex;
    switch (row.kind) {
      case 'header':
        return { key: row.key, selected: false, header: true };
      case 'group': {
        // A place is no change to show: its header takes the focus, never the selection.
        const { text, check } = placeOf(row.start);
        return {
          key: row.key,
          selected: false,
          label: text.label,
          description: descriptionId(index),
          checked: check.state,
          position: position(index),
        };
      }
      case 'placeholder':
        return { key: row.key, selected, busy: true, label: t('rows.loading'), position: position(index) };
      case 'item':
      case 'metadata': {
        const text = textOf(row);
        return {
          key: row.key,
          selected,
          name: text.name,
          label: text.label,
          description: text.description === null ? undefined : descriptionId(index),
          checked: row.kind === 'item' ? isIncluded(inclusion, row.item) : undefined,
          position: position(index),
        };
      }
    }
  };

  const refOf = (index: number): RowRef => ({ key: rows.rowAt(index).key, index });

  /**
   * Says why a check box change was refused: the selection would name more keys than the shell
   * takes (ipc-m2 §5.1). Worded for the mode the selection was in when the person asked (leaving
   * out, or picking), as a limit for one box, and how else to get there.
   */
  const refuse = (mode: Selection['kind'], one: boolean) => {
    const leaving = mode === 'allExcept';
    showToast({
      tone: 'warning',
      title: one ? t(leaving ? 'rows.limit.leaveOut' : 'rows.limit.include') : t('rows.rangeFailed'),
      body: t(leaving ? 'rows.tooMany.leaveOut' : 'rows.tooMany.include', { count: LIMITS.batch }),
    });
  };

  /**
   * Includes or leaves out what a range's or a place's check box covers, all of it or nothing: a
   * change that would make the selection name too many keys, or that could not be read whole for
   * that reason, is refused (`refuse`, worded for `mode`, the mode when the person asked).
   */
  const apply = ({ items, complete }: Covered, included: boolean, anchor: RowRef | null, mode: Selection['kind']): boolean => {
    if (complete && setIncluded(items, included, anchor)) return true;
    refuse(mode, false);
    return false;
  };
  /** One item in or out: Space, its box, its menu's check box item. */
  const applyOne = (item: WorkspaceItem, included: boolean, anchor: RowRef) => {
    if (!setIncluded([item], included, anchor)) refuse(useChangesView.getState().inclusion.mode, true);
  };

  /**
   * Reads what a range or a place covers (`read`, its pages as the list caches them), then `act`s on
   * it while the list is still the one the person clicked in. A new fingerprint or HEAD moves the
   * items' indexes, so read from pages, they count only when the shell's workspace, read again once
   * they are in (a page can answer before the WorkspaceChanged of a change it shows), is the one
   * the click began under, and when no WorkspaceChanged dropped them; else nothing changes, not
   * even a part, and a toast says so. Once these rows are gone, or while a commit runs (it keeps
   * the selection it sent), nothing happens. `done` runs once it has settled, before `act`.
   */
  const readThen = (read: Promise<Covered>, source: string, act: (covered: Covered) => void, done?: () => void) => {
    const since = listNow.current;
    const outcome = read
      .then(async (covered) => (!covered.paged || listKeyOf(await readWorkspaceNow()) === since ? covered : null))
      .catch((error: unknown) => {
        if (isDroppedRead(error)) return null;
        throw error;
      })
      .finally(done);
    whenSettled(
      outcome,
      source,
      (covered) => {
        if (listNow.current === null || useChangesView.getState().run.kind !== 'idle') return;
        if (covered === null || listNow.current !== since) {
          showToast({ tone: 'warning', title: t('rows.rangeFailed'), body: t('rows.listChanged') });
          return;
        }
        act(covered);
      },
      (failure) => {
        showFailure(t('rows.rangeFailed'), failure.error, source);
      },
    );
  };

  /** Opens the row's menu, if it has one: a settings change has nothing to offer. */
  const openMenu = (index: number, anchor: MenuAnchor, keyboard: boolean) => {
    const row = rows.rowAt(index);
    if ((row.kind !== 'item' && row.kind !== 'metadata') || !hasMenu(row)) return;
    setMenu({ anchor, row, index, label: t('menu.label', { name: textOf(row).name }), keyboard });
  };

  /** The context menu's check box item for its row; tag and settings changes have none. */
  const inclusionOf = ({ row, index }: OpenMenu): InclusionAction | null => {
    if (row.kind !== 'item') return null;
    const included = isIncluded(inclusion, row.item);
    return {
      included,
      waitReason: committing ? t('menu.committing') : null,
      onToggle: () => {
        applyOne(row.item, !included, { key: row.key, index });
      },
    };
  };

  /**
   * Space, or a click on a place header's box: every change of the place in, or out when all are
   * in (§3.5). Its pages load first (`readThen`).
   */
  const togglePlace = (start: GroupStart) => {
    const check = checkOf(start.place);
    if (committing || check.disabled || placeBusy.current) return;
    const included = check.state !== true;
    placeBusy.current = true;
    const available = places.groups.get(start.place.id)?.available ?? null;
    const asked = useChangesView.getState().inclusion;
    readThen(
      itemsOfPlace(rows, start, available, keyRoom(asked, included)),
      'changes.group',
      (covered) => {
        if (apply(covered, included, null, asked.mode)) setPending({ id: start.place.id, state: included, selection: useChangesView.getState().selection });
      },
      () => {
        placeBusy.current = false;
      },
    );
  };

  /** Space, or a click on a box: that item in or out; a place's header, its changes. */
  const toggle = (index: number) => {
    const row = rows.rowAt(index);
    if (row.kind === 'group') {
      togglePlace(row.start);
      return;
    }
    if (committing || row.kind !== 'item' || includabilityOf(row.item) !== 'includable') return;
    applyOne(row.item, !isIncluded(inclusion, row.item), refOf(index));
  };

  /** Shift+click on a box: the range from the last box changed takes this box's new state. */
  const toggleRange = (index: number, item: WorkspaceItem) => {
    if (committing) return;
    const anchor = useChangesView.getState().anchor;
    const anchorRow = anchor === null ? null : (rows.indexOfKey(anchor.key) ?? anchor.index);
    const from = anchorRow === null ? null : rows.itemIndexAt(anchorRow);
    const to = rows.itemIndexAt(index);
    if (from === null || to === null) {
      toggle(index);
      return;
    }
    const included = !isIncluded(inclusion, item);
    readThen(itemsBetween(rows, from, to, keyRoom(inclusion, included)), 'changes.range', (covered) => {
      apply(covered, included, refOf(index), inclusion.mode);
    });
  };

  const boxOf = (index: number, item: WorkspaceItem, text: RowText): RowBox => {
    const kind = includabilityOf(item);
    return {
      state: isIncluded(inclusion, item),
      disabled: kind !== 'includable',
      reason: kind === 'includable' ? null : text.description,
      onPress: (event: MouseEvent) => {
        if (event.shiftKey) toggleRange(index, item);
        else toggle(index);
      },
    };
  };

  return (
    <>
      <VirtualList
        ref={listRef}
        className="changes-list__rows"
        label={t('list.label')}
        count={rows.count}
        optionCount={rows.options}
        multiselectable={false}
        itemAt={itemAt}
        itemHeight={(index) => (index === rows.header ? SIZE.changesGroupHeader : SIZE.row)}
        sizesKey={String(rows.header)}
        focusedIndex={selectedIndex}
        initialOffset={initialOffset}
        onOffsetChange={setOffset}
        anchor={{ keyAt: (index) => rows.rowAt(index).key, indexOfKey: rows.indexOfKey }}
        onRangeChange={onRangeChange}
        onNavigate={(index) => {
          setFocus(refOf(index));
        }}
        onToggle={toggle}
        onAction={onEnter}
        onSelectAll={onSelectAll}
        onKeyDown={(event, index) => {
          if (index === null || event.nativeEvent.isComposing) return;
          if (isContextMenuKey(event)) {
            event.preventDefault();
            openMenu(index, keyboardMenuAnchor(event.target), true);
          }
        }}
        onRowClick={(index) => {
          setFocus(refOf(index));
          onRowClick?.(index);
        }}
        onRowContextMenu={(index, event) => {
          event.preventDefault();
          // Shift+F10 and the Menu key open the menu on keydown, and the browser then sends
          // `contextmenu` to the focused row: while that menu is open, this is its echo. A
          // right-click elsewhere closes it first (on pointer up), so it still opens a menu.
          if (menu?.keyboard === true) return;
          setFocus(refOf(index));
          openMenu(index, { x: event.clientX, y: event.clientY }, false);
        }}
        renderItem={(index, item) => {
          const row = rows.rowAt(index);
          switch (row.kind) {
            case 'header':
              return <MetadataHeaderRow />;
            case 'group': {
              const { text, check } = placeOf(row.start);
              const box: RowBox = {
                state: check.state,
                disabled: check.disabled,
                reason: check.disabled ? text.description : null,
                onPress: () => {
                  togglePlace(row.start);
                },
              };
              return <PlaceHeaderRow text={text} box={box} descriptionId={descriptionId(index)} />;
            }
            case 'placeholder':
              return <PlaceholderRow />;
            case 'item': {
              const text = textOf(row);
              return <ChangeRowView text={text} selected={item.selected} box={boxOf(index, row.item, text)} descriptionId={descriptionId(index)} />;
            }
            case 'metadata':
              return <ChangeRowView text={textOf(row)} selected={item.selected} box={null} descriptionId={descriptionId(index)} />;
          }
        }}
      />
      <ContextMenu
        anchor={menu?.anchor ?? null}
        label={menu?.label ?? ''}
        onClose={() => {
          setMenu(null);
        }}
      >
        {menu !== null && <ChangeMenu row={menu.row} label={menu.label} focusFirst={menu.keyboard} inclusion={inclusionOf(menu)} />}
      </ContextMenu>
    </>
  );
}

export interface ChangesListProps {
  /** The rows around `range` (`useChangeRows`), which the view shares with the diff. */
  rows: ChangeRows;
  /**
   * The load failure the list shows, with its "Try again" (`useRetriedFailure`): the view's, so the
   * diff and the commit box follow it while a retry reads.
   */
  failure: RetriedFailure<IpcFailure>;
  /** The rows the list shows, from `onRangeChange`; `null` before it renders. */
  range: IndexRange | null;
  selectedIndex: number | null;
  onRangeChange: (range: IndexRange) => void;
  /** Enter on a row. */
  onEnter: (index: number) => void;
  /** A click on a row, after it is selected. */
  onRowClick?: (index: number) => void;
  /**
   * A commit runs (§3.8): the check boxes do nothing while the selection still moves; `shown` once
   * it has run for 150 ms, when the rows' and course headers' boxes fade to 55 % (the header's
   * select-all is disabled, and so at 55 %, from the start); the rows keep full contrast.
   */
  committing: 'quiet' | 'shown' | null;
  listRef: Ref<CollectionHandle>;
}

/**
 * The changes list (workspace-history handoff §3): the header with "Include all changes", the
 * count from the workspace's summary and the layout toggle; the banners; then the rows, flat or
 * grouped by course with the place headers' check boxes from the selection's summary (§3.5), or
 * the state the workspace is in (§3.8). Inclusion is the view's (`state.ts`); select-all and
 * Ctrl+A send "every item except", so they never load a page (§3.9).
 */
export function ChangesList({ rows, failure, range, selectedIndex, committing, onRangeChange, onEnter, onRowClick, listRef }: ChangesListProps) {
  const { t } = useTranslation(['changes', 'common']);
  const workspace = useWorkspace();
  const summary = workspace.data;
  const layout = useChangesPreferences((state) => state.layout);
  const inclusion = useChangesView((state) => state.inclusion);
  const selection = useChangesView((state) => state.selection);
  const pruned = useSelectionSummary(selection, summary).data;
  // The summary of this very selection, perhaps under the workspace's last fingerprint while the
  // new one is asked for; another selection's (one changed within the last moment) does not count.
  // Told by content: a selection that comes back to keys summarized before is answered from the
  // cache, with the selection object of that time.
  const fresh = useMemo(() => pruned !== undefined && sameSelection(pruned.selection, selection), [pruned, selection]);
  const counts = useMemo(() => (pruned === undefined ? undefined : selectAllCounts(pruned.summary.groups)), [pruned]);
  // What a check box can change does not hang on the selection, so any summary says it; before the
  // first, the workspace's includable items stand in.
  const changeable = counts?.changeable ?? summary?.includable ?? 0;
  const all = headerState(inclusion, changeable, fresh ? counts?.included : undefined);
  const groups = useMemo(
    () => new Map((pruned?.summary.groups ?? []).map((group) => [placeIdOf(group.place), group])),
    [pruned],
  );
  /** Select-all and Ctrl+A; an item shown blocked counts once a loaded row shows it ready. */
  const setAll = (included: boolean) => {
    setAllIncluded(included, (key) => {
      const item = rows.itemByKey(key);
      return item !== undefined && includabilityOf(item) === 'includable';
    });
  };

  // Keys of items that went are dropped; blocked items the list shows stay off once ready (§3.4).
  useEffect(() => {
    if (pruned !== undefined) dropStaleKeys(pruned.stale);
  }, [pruned]);
  useEffect(() => {
    if (range !== null) noteShown(rows.itemsIn(range));
  }, [rows, range]);

  const total = summary === undefined ? undefined : summary.items + summary.metadata;
  const count = workspace.isError ? '–' : total ?? '…';
  const countLabel = workspace.isError
    ? t('list.countUnknown')
    : total === undefined
      ? t('list.countLoading')
      : t('list.count', { count: total });

  const body = () => {
    if (failure.shown !== null) return <LoadFailure title={t('states.loadFailed')} error={failure.shown.error} retry={failure.retry} />;
    if (summary === undefined || rows.status === 'pending') return <Skeleton rows={8} />;
    if (rows.count === 0) {
      // A damaged history lists what it can, which may be nothing: its banner says why.
      if (summary.historyState === 'damaged') return null;
      return <StateBlock tone="success" icon={CircleCheck} title={t('states.empty.title')} text={t('states.empty.text')} />;
    }
    return (
      <RowsList
        rows={rows}
        inclusion={inclusion}
        selectedIndex={selectedIndex}
        onSelectAll={() => {
          if (changeable > 0 && committing === null) setAll(all !== true);
        }}
        onRangeChange={onRangeChange}
        onEnter={onEnter}
        onRowClick={onRowClick}
        committing={committing !== null}
        grouped={layout === 'grouped'}
        places={{ groups, fresh, selection }}
        listKey={listKeyOf(summary)}
        listRef={listRef}
      />
    );
  };

  return (
    <Panel
      title={t('list.title')}
      leading={
        <Checkbox
          aria-label={t('list.includeAll')}
          isSelected={all === true}
          isIndeterminate={all === 'mixed'}
          isDisabled={changeable === 0 || committing !== null}
          onChange={setAll}
        />
      }
      count={count}
      countLabel={countLabel}
      className={committing === 'shown' ? 'changes-list changes-list--committing' : 'changes-list'}
      actions={
        <SegmentedControl<ListLayout>
          label={t('list.layout')}
          segments={[
            { id: 'flat', label: t('list.flat'), icon: List },
            { id: 'grouped', label: t('list.grouped'), icon: ListTree },
          ]}
          selected={layout}
          onChange={setListLayout}
        />
      }
    >
      <ListBanners historyState={summary?.historyState} />
      {body()}
    </Panel>
  );
}
