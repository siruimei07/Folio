// Which changes go into the next commit (workspace-history handoff §3.4, §3.6; ipc-m2 §5.1, §6.2).
// Pure: the view's store (`state.ts`) keeps an `Inclusion`, and these turn it into what the list
// shows and what the shell takes.
//
// - "Every item except" by default, so new items arrive included and select-all never loads a
//   page (§3.9); "leave all out" turns it into "only these", where checked items are added.
// - Items the list showed as blocked (not on this computer, unreadable) are kept apart: they stay
//   off once they become includable, until the person checks them or includes everything (§3.4),
//   whatever the mode; in "only these" mode one checked before leaves the selection when it shows
//   blocked, so the selection never names an item the list showed blocked (ipc-m2 §5.1).
// - Required items (bound to a tag or settings change, ipc-m2 §6.2) are always included: their key
//   is never kept, and their check box is on and disabled.
// - Each key is kept with its path, for as long as its item exists; the stale ones go when a
//   selection summary names them (`data/workspace.ts`).
// - What the shell takes names at most `LIMITS.batch` keys (ipc-m2 §5.1): a change that would keep
//   more is refused as a whole and the view says why (`fitsSelection`), never applied in part.
import { LIMITS, type Selection, type SummaryGroup, type WorkspaceItem } from '../ipc';
import type { CheckState } from '../components/Checkbox/Checkbox';

export interface Inclusion {
  mode: Selection['kind'];
  /** `allExcept`: the items left out; `only`: the items included. Each key with its path. */
  keys: ReadonlyMap<string, string>;
  /** Items shown while blocked, left out until checked (also after they become includable). */
  blocked: ReadonlyMap<string, string>;
}

/** Every item but the blocked ones: where a library starts. */
export const INCLUDE_ALL: Inclusion = { mode: 'allExcept', keys: new Map(), blocked: new Map() };

/** What a check box can do for an item. */
export type Includability = 'includable' | 'blocked' | 'required';

export function includabilityOf(item: Pick<WorkspaceItem, 'required' | 'readiness'>): Includability {
  if (item.required) return 'required';
  return item.readiness === 'notLocal' || item.readiness === 'unreadable' ? 'blocked' : 'includable';
}

/** Whether `item` goes into the commit. */
export function isIncluded(inclusion: Inclusion, item: Pick<WorkspaceItem, 'key' | 'required' | 'readiness'>): boolean {
  const kind = includabilityOf(item);
  if (kind !== 'includable') return kind === 'required';
  if (inclusion.blocked.has(item.key)) return false;
  return inclusion.mode === 'allExcept' ? !inclusion.keys.has(item.key) : inclusion.keys.has(item.key);
}

/**
 * `items` included or left out: those a check box can change, the others as they are. The same
 * object when nothing changes.
 */
export function withItems(inclusion: Inclusion, items: readonly WorkspaceItem[], included: boolean): Inclusion {
  let keys: Map<string, string> | null = null;
  let blocked: Map<string, string> | null = null;
  for (const item of items) {
    if (includabilityOf(item) !== 'includable' || isIncluded(inclusion, item) === included) continue;
    keys ??= new Map(inclusion.keys);
    // Kept in `allExcept` while left out, in `only` while included.
    if ((inclusion.mode === 'allExcept') === included) keys.delete(item.key);
    else keys.set(item.key, item.path);
    if (included && inclusion.blocked.has(item.key)) {
      blocked ??= new Map(inclusion.blocked);
      blocked.delete(item.key);
    }
  }
  if (keys === null) return inclusion;
  return { mode: inclusion.mode, keys, blocked: blocked ?? inclusion.blocked };
}

/**
 * Select-all and Ctrl+A: every includable item. An item shown while blocked is included once
 * `includable` says the list now shows it ready; one the list does not show stays off, since it
 * may still be blocked (the shell would leave it out) or was last seen blocked.
 */
export function includeAll(inclusion: Inclusion, includable: (key: string) => boolean): Inclusion {
  const blocked = new Map([...inclusion.blocked].filter(([key]) => !includable(key)));
  return { mode: 'allExcept', keys: new Map(), blocked: blocked.size === inclusion.blocked.size ? inclusion.blocked : blocked };
}

/** Select-all and Ctrl+A again: nothing but the required items. */
export function leaveAllOut(inclusion: Inclusion): Inclusion {
  return { mode: 'only', keys: new Map(), blocked: inclusion.blocked };
}

/**
 * Notes the blocked items among `items`, which the list shows. In "only these" mode one that was
 * checked goes out of the selection too: the shell would fail a commit that names it (ipc-m2 §5.1),
 * and once ready it stays off like any item seen blocked, so its row, the summary and the commit
 * agree. The same object when none is new.
 */
export function noteBlocked(inclusion: Inclusion, items: Iterable<WorkspaceItem>): Inclusion {
  let blocked: Map<string, string> | null = null;
  let keys: Map<string, string> | null = null;
  for (const item of items) {
    if (includabilityOf(item) !== 'blocked') continue;
    if (inclusion.mode === 'only' && inclusion.keys.has(item.key)) {
      keys ??= new Map(inclusion.keys);
      keys.delete(item.key);
    }
    if (inclusion.blocked.has(item.key)) continue;
    blocked ??= new Map(inclusion.blocked);
    blocked.set(item.key, item.path);
  }
  if (blocked === null && keys === null) return inclusion;
  return { mode: inclusion.mode, keys: keys ?? inclusion.keys, blocked: blocked ?? inclusion.blocked };
}

/** Without `stale`, keys that name no item any more. The same object when none was kept. */
export function withoutKeys(inclusion: Inclusion, stale: readonly string[]): Inclusion {
  if (!stale.some((key) => inclusion.keys.has(key) || inclusion.blocked.has(key))) return inclusion;
  const keys = new Map(inclusion.keys);
  const blocked = new Map(inclusion.blocked);
  for (const key of stale) {
    keys.delete(key);
    blocked.delete(key);
  }
  return { mode: inclusion.mode, keys, blocked };
}

/** What the shell takes (ipc-m2 §5.1): the keys left out (blocked ones too), or those included. */
export function selectionOf(inclusion: Inclusion): Selection {
  if (inclusion.mode === 'only') return { kind: 'only', keys: [...inclusion.keys.keys()] };
  return { kind: 'allExcept', keys: [...new Set([...inclusion.keys.keys(), ...inclusion.blocked.keys()])] };
}

/**
 * Whether two selections name the same items: the same kind and the same keys, in any order. The
 * selection summaries are cached by content, so a summary asked for one selection answers for
 * another with the same keys (a check box turned off and on again).
 */
export function sameSelection(a: Selection, b: Selection): boolean {
  if (a === b) return true;
  if (a.kind !== b.kind || a.keys.length !== b.keys.length) return false;
  const keys = new Set(a.keys);
  return keys.size === new Set(b.keys).size && b.keys.every((key) => keys.has(key));
}

/**
 * What the header's "Include all changes" counts (ipc-m2 §6.4, "Select-all"), summed over a
 * selection summary's places: the items a check box can change (`available - required`), and those
 * of them included (`selected - required`). Required items are always in and blocked ones never, so
 * neither counts.
 */
export function selectAllCounts(groups: readonly SummaryGroup[]): { changeable: number; included: number } {
  let changeable = 0;
  let included = 0;
  for (const group of groups) {
    changeable += group.available - group.required;
    included += group.selected - group.required;
  }
  return { changeable, included };
}

/**
 * A check box over `changeable` items, `included` of them in (ipc-m2 §6.4): on when all are, mixed
 * when some are, off when none are; with nothing to change, on only when `required` items are in
 * every commit.
 */
export function countState(included: number, changeable: number, required = 0): CheckState {
  if (changeable === 0) return required > 0;
  if (included >= changeable) return true;
  return included === 0 ? false : 'mixed';
}

/**
 * The header's "Include all changes" (§3.1): `countState` of the items a check box can change
 * (`selectAllCounts`). `included` is the summary's count for the current selection, `undefined`
 * while it is asked for: until then a selection without kept keys says on itself, and one with
 * keys says mixed.
 */
export function headerState(inclusion: Inclusion, changeable: number, included: number | undefined): CheckState {
  // Required items stay in after "leave all out": they are not the person's to count.
  if (changeable === 0 || (inclusion.mode === 'only' && inclusion.keys.size === 0)) return false;
  if (included === undefined) return inclusion.keys.size === 0 ? true : 'mixed';
  return countState(included, changeable);
}

/** How many keys the shell takes for `inclusion` (`selectionOf`), without building the selection. */
export function keptKeyCount(inclusion: Inclusion): number {
  if (inclusion.mode === 'only') return inclusion.keys.size;
  let count = inclusion.keys.size;
  for (const key of inclusion.blocked.keys()) if (!inclusion.keys.has(key)) count += 1;
  return count;
}

/**
 * Whether `next`, made from `before`, can go to the shell: a selection names at most `LIMITS.batch`
 * keys (ipc-m2 §5.1), so a change that would keep more is refused as a whole, never applied in part.
 * A change that keeps fewer keys than before always can.
 */
export function fitsSelection(next: Inclusion, before: Inclusion): boolean {
  if (next === before) return true;
  const kept = keptKeyCount(next);
  return kept <= LIMITS.batch || kept <= keptKeyCount(before);
}

/**
 * Whether including (`included`) or leaving out `item` adds a key to what the shell takes: leaving
 * out an item while every item is in but some, or including one while only some are.
 */
export function addsKey(inclusion: Inclusion, item: WorkspaceItem, included: boolean): boolean {
  return includabilityOf(item) === 'includable' && isIncluded(inclusion, item) !== included && (inclusion.mode === 'allExcept') !== included;
}
