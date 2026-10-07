// Grouped by course, the pure part (workspace-history handoff §3.5): where a change belongs, where
// the headers go as pages arrive, rows to items and back, and a header's check box.
import { describe, expect, it } from 'vitest';

import type { SummaryGroup, WorkspaceItem } from '../../ipc';
import {
  countPlaces,
  findGroupStarts,
  GroupLayout,
  type GroupStart,
  isInPlaceFolder,
  NO_GROUPS,
  placeCheck,
  placeOfItem,
} from './grouped';

const MAT = 'Fall 2026/MAT232';
const CSC = 'Fall 2026/CSC148';

function item(path: string, fields: Partial<WorkspaceItem> = {}): WorkspaceItem {
  return {
    key: `k:${path}`,
    change: 'modified',
    kind: 'file',
    path,
    fromPath: null,
    entry: null,
    class: 'text',
    contentChanged: true,
    before: null,
    after: null,
    readiness: 'ready',
    files: 0,
    parts: [],
    required: false,
    tagsChanged: false,
    ...fields,
  };
}

/** A paged list of `items` whose pages in `loaded` have arrived (pages of 200). */
function pagedList(items: readonly WorkspaceItem[], loaded: readonly number[], revision = 1) {
  return {
    total: items.length,
    revision,
    rowAt: (index: number) => (loaded.includes(Math.floor(index / 200)) ? items[index] : undefined),
  };
}

function startsOf(memory: { starts: ReadonlyMap<number, GroupStart> }): [number, string][] {
  return [...memory.starts.values()].sort((a, b) => a.item - b.item).map((start) => [start.item, start.place.id]);
}

describe('placeOfItem', () => {
  it('puts a change in its course, else its semester, else the library; a place owns its own folder', () => {
    expect(placeOfItem({ path: `${MAT}/Problem sets/ps1.pdf`, kind: 'file' })).toEqual({ id: MAT, kind: 'course' });
    expect(placeOfItem({ path: MAT, kind: 'folder' })).toEqual({ id: MAT, kind: 'course' });
    expect(placeOfItem({ path: 'Fall 2026/Calendar.pdf', kind: 'file' })).toEqual({ id: 'Fall 2026', kind: 'semester' });
    expect(placeOfItem({ path: 'Fall 2026', kind: 'folder' })).toEqual({ id: 'Fall 2026', kind: 'semester' });
    expect(placeOfItem({ path: 'README.md', kind: 'file' })).toEqual({ id: '', kind: 'library' });
  });

  it("tells which paths lie in a place's folder", () => {
    expect(isInPlaceFolder(`${MAT}/a.md`, MAT)).toBe(true);
    expect(isInPlaceFolder(MAT, MAT)).toBe(true);
    expect(isInPlaceFolder(`${MAT} old/a.md`, MAT)).toBe(false);
    expect(isInPlaceFolder('anything.md', '')).toBe(true);
  });
});

describe('findGroupStarts', () => {
  // 600 items: CSC148 0–249, the semester's own 250–259, MAT232 260–599.
  const items = [
    ...Array.from({ length: 250 }, (_, at) => item(`${CSC}/f${String(at).padStart(3, '0')}.md`)),
    ...Array.from({ length: 10 }, (_, at) => item(`Fall 2026/g${String(at)}.md`)),
    ...Array.from({ length: 340 }, (_, at) => item(`${MAT}/h${String(at).padStart(3, '0')}.md`)),
  ];

  it('starts a group at the first item and where the place changes between loaded items', () => {
    const memory = findGroupStarts(pagedList(items, [0, 1]), NO_GROUPS);
    expect(startsOf(memory)).toEqual([
      [0, CSC],
      [250, 'Fall 2026'],
      [260, MAT],
    ]);
    // The header's key names the place and its first item, so a place with two runs has two.
    expect(memory.starts.get(250)?.key).toBe('group:Fall 2026:k:Fall 2026/g0.md');
  });

  it('needs the item before a start, keeps what it found while the list stays, and answers the same memory when nothing is new', () => {
    // Page 1 alone: item 199 is not there, so 200 cannot start a group; 250 and 260 can.
    const first = findGroupStarts(pagedList(items, [1]), NO_GROUPS);
    expect(startsOf(first)).toEqual([
      [250, 'Fall 2026'],
      [260, MAT],
    ]);
    // Page 1 goes and page 0 comes: what page 1 showed is kept.
    const second = findGroupStarts(pagedList(items, [0]), first);
    expect(startsOf(second)).toEqual([
      [0, CSC],
      [250, 'Fall 2026'],
      [260, MAT],
    ]);
    expect(findGroupStarts(pagedList(items, [0]), second)).toBe(second);
  });

  it('forgets what it found when the list changes, and drops a remembered start the loaded items deny', () => {
    const found = findGroupStarts(pagedList(items, [0, 1]), NO_GROUPS);
    // Another revision: only what its loaded pages show.
    expect(startsOf(findGroupStarts(pagedList(items, [0], 2), found))).toEqual([[0, CSC]]);
    // The same list, with a remembered start that item 249 and 250 now deny.
    const denied = { ...found, starts: new Map([...found.starts, [120, { item: 120, place: { id: MAT, kind: 'course' as const }, key: 'x' }]]) };
    expect(startsOf(findGroupStarts(pagedList(items, [0]), denied))).not.toContainEqual([120, MAT]);
  });
});

describe('GroupLayout', () => {
  it('puts a header row before each group start and maps rows to items and back', () => {
    const start = (index: number, id: string): GroupStart => ({ item: index, place: { id, kind: 'course' }, key: `group:${id}` });
    const layout = new GroupLayout([start(5, 'b'), start(0, 'a')], 8);
    expect(layout.rows).toBe(10);
    const rows = Array.from({ length: layout.rows }, (_, row) => layout.at(row));
    expect(rows.map((at) => ('start' in at ? at.start.place.id : at.item))).toEqual(['a', 0, 1, 2, 3, 4, 'b', 5, 6, 7]);
    expect([0, 4, 5, 7].map((index) => layout.rowOfItem(index))).toEqual([1, 5, 7, 9]);
    // A header's row reads as the item after it going forward, the item before it going back.
    expect(layout.itemFrom(6)).toBe(5);
    expect(layout.itemUpTo(6)).toBe(4);
    // Without starts, each row is its item.
    const flat = new GroupLayout([], 3);
    expect([flat.rows, flat.rowOfItem(2), flat.itemFrom(1)]).toEqual([3, 2, 1]);
  });
});

describe('placeCheck', () => {
  /** A course's summary group: `available` and `selected` count its `required` items too (ipc-m2 §6.4). */
  function group(available: number, selected: number, { items = available, required = 0 } = {}): SummaryGroup {
    const none = { added: 0, modified: 0, deleted: 0, moved: 0 };
    return {
      place: { kind: 'course', path: MAT, folder: null, name: 'MAT232', code: 'MAT232' },
      files: none,
      folders: none,
      tags: 0,
      settings: false,
      items,
      available,
      selected,
      required,
    };
  }

  it('reads on, mixed and off from the summary group, and disables a place with nothing to include', () => {
    expect(placeCheck(group(3, 3), undefined, { fresh: true })).toEqual({ state: true, count: 3, committable: null, disabled: false });
    expect(placeCheck(group(3, 1), undefined, { fresh: true }).state).toBe('mixed');
    expect(placeCheck(group(3, 0), undefined, { fresh: true }).state).toBe(false);
    // Every item blocked: the header still counts it, and its box does nothing.
    expect(placeCheck(group(0, 0, { items: 2 }), undefined, { fresh: true })).toEqual({ state: false, count: 2, committable: null, disabled: true });
  });

  it('counts every item, says how many can be committed when only some can, and leaves required items out of the box', () => {
    // Four items: one blocked, one required, two the person can change.
    const mat = (selected: number) => group(3, selected, { items: 4, required: 1 });
    expect(placeCheck(mat(3), undefined, { fresh: true })).toEqual({ state: true, count: 4, committable: 3, disabled: false });
    // Both changeable ones left out: only the required one is in, and the box is off, not mixed.
    expect(placeCheck(mat(1), undefined, { fresh: true }).state).toBe(false);
    expect(placeCheck(mat(2), undefined, { fresh: true }).state).toBe('mixed');
    // Only required items (one of them blocked): always in, nothing to change.
    expect(placeCheck(group(2, 2, { required: 2 }), undefined, { fresh: true })).toEqual({ state: true, count: 2, committable: null, disabled: true });
    // Only blocked items and no required one: off and disabled.
    expect(placeCheck(group(0, 0, { items: 1 }), undefined, { fresh: true }).state).toBe(false);
  });

  it('reads the loaded items at once when they hold every available item, blocked and required ones aside', () => {
    const loaded = countPlaces(
      [
        item(`${MAT}/a.md`),
        item(`${MAT}/b.md`, { key: 'out' }),
        item(`${MAT}/c.md`, { readiness: 'notLocal' }),
        item(`${MAT}/d.md`, { required: true }),
        // A required item counts as available whatever its readiness.
        item(`${MAT}/e.md`, { required: true, readiness: 'unreadable' }),
      ],
      (entry) => entry.key !== 'out',
    ).get(MAT);
    expect(loaded).toEqual({ available: 4, changeable: 2, included: 1, required: 2 });
    const summary = group(4, 4, { items: 5, required: 2 });
    // A summary of an older selection says all four are in; the loaded items know better.
    expect(placeCheck(summary, loaded, { fresh: false }).state).toBe('mixed');
    // Not every available item loaded: the summary, or what the person just set while it is old.
    const partial = { available: 1, changeable: 1, included: 0, required: 0 };
    expect(placeCheck(summary, partial, { fresh: false }).state).toBe(true);
    expect(placeCheck(summary, partial, { fresh: false, pending: false }).state).toBe(false);
    expect(placeCheck(summary, partial, { fresh: true, pending: false }).state).toBe(true);
    // Only required items: always in, nothing to change.
    expect(placeCheck(group(1, 1, { required: 1 }), { available: 1, changeable: 0, included: 0, required: 1 }, { fresh: true })).toEqual({
      state: true,
      count: 1,
      committable: null,
      disabled: true,
    });
  });
});
