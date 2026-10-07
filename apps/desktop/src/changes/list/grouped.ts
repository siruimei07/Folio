// Grouped by course (workspace-history handoff §3.5): a header over the rows of each course, of a
// semester's own files and of the library's own files. Pure: `rows.ts` lays the rows out with it,
// and the list draws and toggles the headers.
//
// The shell lists items by path (ipc-m2 §6.2) and gives each place's counts in a selection's
// summary (§6.4), but not where a place's rows are. So a header goes where the place changes
// between two loaded items, found as their pages arrive and remembered while the list stays the
// same (`GroupMemory`); the list keeps its first visible row in place when a header turns up above
// it. A course is a folder, so its rows come together; a semester's own files may lie on both
// sides of one of its courses, and the library's own between semesters: such a place has a header
// over each run of its rows, each with the check box of the whole place.
import type { CheckState } from '../../components/Checkbox/Checkbox';
import { LIST_PAGE, type PagedList } from '../../data/paged';
import type { EntryKind, Place, SummaryGroup, WorkspaceItem } from '../../ipc';
import { countState, includabilityOf } from '../inclusion';

/**
 * Where a change belongs (ipc-m1 §6.1: a semester is a folder in the library, a course a folder in
 * a semester): its course, else its semester, else the library. A course's or semester's own folder
 * belongs to it.
 */
export interface PlaceRef {
  /** The course's or semester's path; `''` for the library. */
  id: string;
  kind: Place['kind'];
}

export function placeOfItem({ path, kind }: { path: string; kind: EntryKind }): PlaceRef {
  const names = path.split('/');
  const folderAt = (depth: number) => names.length > depth || (names.length === depth && kind === 'folder');
  if (folderAt(2)) return { id: names.slice(0, 2).join('/'), kind: 'course' };
  if (folderAt(1)) return { id: names[0] ?? '', kind: 'semester' };
  return { id: '', kind: 'library' };
}

/** The id of a summary group's place (`PlaceRef.id`). */
export function placeIdOf(place: Place): string {
  return place.kind === 'library' ? '' : place.path;
}

/** Whether `path` is the place's folder or lies in it; everything lies in the library. */
export function isInPlaceFolder(path: string, id: string): boolean {
  return id === '' || path === id || path.startsWith(`${id}/`);
}

/** Where a run of a place's rows starts. */
export interface GroupStart {
  /** The index of its first item among the items. */
  item: number;
  place: PlaceRef;
  /** The header's row key: the place and its first item, so a place with two runs has two headers. */
  key: string;
}

/** The group starts found in one state of the list of items. */
export interface GroupMemory {
  /** That state: the revision of the list's newest page and its total (`listState`). */
  list: string;
  /** By the index of their first item. */
  starts: ReadonlyMap<number, GroupStart>;
}

export const NO_GROUPS: GroupMemory = { list: '', starts: new Map() };

/** The state of a list of items that group starts hold for: a refetch that moves rows changes it. */
export function listState(items: Pick<PagedList<WorkspaceItem>, 'revision' | 'total'>): string {
  return `${String(items.revision ?? '')}:${String(items.total ?? '')}`;
}

function startAt(index: number, item: WorkspaceItem, place: PlaceRef): GroupStart {
  return { item: index, place, key: `group:${place.id}:${item.key}` };
}

/**
 * The group starts of `items`: those `memory` found in the same state of the list, with those its
 * loaded pages show now. A start needs the item before it loaded too, except the first item's. A
 * remembered start the loaded items deny goes. `memory` itself when nothing changed, so a view can
 * keep what it found without looping.
 */
export function findGroupStarts(items: Pick<PagedList<WorkspaceItem>, 'revision' | 'total' | 'rowAt'>, memory: GroupMemory): GroupMemory {
  const list = listState(items);
  const known = memory.list === list ? memory.starts : NO_GROUPS.starts;
  const found = new Map(known);
  const total = items.total ?? 0;
  for (const index of found.keys()) if (index >= total) found.delete(index);
  for (let first = 0; first < total; first += LIST_PAGE) {
    const end = Math.min(total, first + LIST_PAGE);
    if (items.rowAt(first) === undefined && items.rowAt(end - 1) === undefined) continue;
    const before = first === 0 ? undefined : items.rowAt(first - 1);
    // The place of the item before, while it is loaded.
    let beforePlace = before === undefined ? null : placeOfItem(before).id;
    for (let index = first; index < end; index++) {
      const item = items.rowAt(index);
      if (item === undefined) {
        beforePlace = null;
        continue;
      }
      const place = placeOfItem(item);
      const start = startAt(index, item, place);
      if (index === 0 || (beforePlace !== null && beforePlace !== place.id)) found.set(index, start);
      else if (beforePlace !== null) found.delete(index);
      else if (found.has(index)) found.set(index, start);
      beforePlace = place.id;
    }
  }
  if (memory.list === list && found.size === known.size) {
    let same = true;
    for (const [index, start] of found) {
      if (known.get(index)?.key !== start.key) {
        same = false;
        break;
      }
    }
    if (same) return memory;
  }
  return { list, starts: found };
}

/** What a row of the items' part of a grouped list holds: a group's header, or an item. */
export type GroupedRow = { start: GroupStart } | { item: number };

/**
 * The rows of `items` items with a header before each group start, in order: rows to items and
 * back. Without starts, each row is its item (the flat list).
 */
export class GroupLayout {
  readonly starts: readonly GroupStart[];

  constructor(
    starts: Iterable<GroupStart>,
    readonly items: number,
  ) {
    this.starts = [...starts].sort((a, b) => a.item - b.item);
  }

  /** The items and their headers. */
  get rows(): number {
    return this.items + this.starts.length;
  }

  /** The row of item `index`: after the headers of the groups that start at it or before. */
  rowOfItem(index: number): number {
    let low = 0;
    let high = this.starts.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if ((this.starts[middle]?.item ?? 0) <= index) low = middle + 1;
      else high = middle;
    }
    return index + low;
  }

  /** What row `row` holds: the header of the k-th start is at its first item's index plus k. */
  at(row: number): GroupedRow {
    let low = 0;
    let high = this.starts.length - 1;
    let found = -1;
    while (low <= high) {
      const middle = (low + high) >> 1;
      if ((this.starts[middle]?.item ?? 0) + middle <= row) {
        found = middle;
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }
    const start = this.starts[found];
    if (start !== undefined && start.item + found === row) return { start };
    return { item: row - (found + 1) };
  }

  /** The first item at row `row` or after it. */
  itemFrom(row: number): number {
    const at = this.at(row);
    return 'start' in at ? at.start.item : at.item;
  }

  /** The last item at row `row` or before it. */
  itemUpTo(row: number): number {
    const at = this.at(row);
    return 'start' in at ? at.start.item - 1 : at.item;
  }
}

/**
 * Whether the shell counts `item` in its place's `available` (ipc-m2 §6.4): an item a selection can
 * include, ready or hashing, or a required one whatever its readiness.
 */
export function isAvailable(item: Pick<WorkspaceItem, 'required' | 'readiness'>): boolean {
  return item.required || item.readiness === 'ready' || item.readiness === 'hashing';
}

/** A place's loaded items, for its header's check box. */
export interface PlaceCount {
  /** Those the shell counts as `available` (`isAvailable`). */
  available: number;
  /** Those a check box can change: neither blocked nor required. */
  changeable: number;
  /** Those of `changeable` that are included. */
  included: number;
  /** The required ones: in every commit, not the person's to change. */
  required: number;
}

/** Counts the loaded items of each place (`PlaceCount`), by place id. */
export function countPlaces(items: Iterable<WorkspaceItem>, isIncluded: (item: WorkspaceItem) => boolean): Map<string, PlaceCount> {
  const counts = new Map<string, PlaceCount>();
  for (const item of items) {
    const id = placeOfItem(item).id;
    let count = counts.get(id);
    if (count === undefined) {
      count = { available: 0, changeable: 0, included: 0, required: 0 };
      counts.set(id, count);
    }
    if (isAvailable(item)) count.available += 1;
    if (item.required) count.required += 1;
    if (includabilityOf(item) !== 'includable') continue;
    count.changeable += 1;
    if (isIncluded(item)) count.included += 1;
  }
  return counts;
}

/** A place's header check box (§3.5) and what the header counts. */
export interface PlaceCheck {
  state: CheckState;
  /** What the header counts: every item in the place (the summary's `items`); `null` before a summary names it. */
  count: number | null;
  /**
   * How many of them a commit can take (the summary's `available`) when only some can, so the
   * header's description says it; `null` when all or none can, or before a summary names it.
   */
  committable: number | null;
  /** Nothing in it is the person's to change: its items are blocked, required, or not there. */
  disabled: boolean;
}

/**
 * A place's header check box from its summary group: `selected - required` of `available - required`
 * (ipc-m2 §6.4, "Group headers"), so required items, always in, and blocked ones, never in, do not
 * count. When the loaded items hold every available item of the place, they say it at once, without
 * waiting for the summary of a selection just changed; until then `pending` (what the person just
 * set it to) stands in for a summary of an older selection.
 */
export function placeCheck(
  group: SummaryGroup | undefined,
  loaded: PlaceCount | undefined,
  options: { fresh: boolean; pending?: boolean },
): PlaceCheck {
  const count = group?.items ?? null;
  const committable = group !== undefined && group.available > 0 && group.available < group.items ? group.available : null;
  if (loaded !== undefined && (group === undefined || loaded.available >= group.available)) {
    const state = countState(loaded.included, loaded.changeable, loaded.required);
    return { state, count, committable, disabled: loaded.changeable === 0 };
  }
  if (group === undefined) return { state: false, count, committable, disabled: true };
  const changeable = group.available - group.required;
  if (!options.fresh && options.pending !== undefined && changeable > 0) return { state: options.pending, count, committable, disabled: false };
  return { state: countState(group.selected - group.required, changeable, group.required), count, committable, disabled: changeable === 0 };
}
