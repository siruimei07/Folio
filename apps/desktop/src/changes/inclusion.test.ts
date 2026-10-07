// What the next commit includes (workspace-history handoff §3.4, §3.6; ipc-m2 §5.1, §6.2).
import { describe, expect, it } from 'vitest';

import { LIMITS, type Readiness, type SummaryGroup, type WorkspaceItem } from '../ipc';
import {
  addsKey,
  fitsSelection,
  headerState,
  INCLUDE_ALL,
  includeAll,
  isIncluded,
  keptKeyCount,
  leaveAllOut,
  noteBlocked,
  selectAllCounts,
  selectionOf,
  withItems,
  withoutKeys,
} from './inclusion';

function item(name: string, readiness: Readiness = 'ready', required = false): WorkspaceItem {
  return {
    key: `k-${name}`,
    change: 'modified',
    kind: 'file',
    path: `Fall 2026/${name}`,
    fromPath: null,
    entry: null,
    class: 'text',
    contentChanged: true,
    before: null,
    after: null,
    readiness,
    files: 0,
    parts: [],
    required,
    tagsChanged: false,
  };
}

const notes = item('notes.md');
const slides = item('slides.pdf', 'hashing');
const photo = item('photo.heic', 'notLocal');
const locked = item('locked.docx', 'unreadable');
const bound = item('bound.md', 'ready', true);

describe('inclusion', () => {
  it('includes every includable item at first, never the blocked ones, always the required ones', () => {
    expect([notes, slides, photo, locked, bound].map((each) => isIncluded(INCLUDE_ALL, each))).toEqual([true, true, false, false, true]);
    expect(selectionOf(INCLUDE_ALL)).toEqual({ kind: 'allExcept', keys: [] });
  });

  it('keeps the keys left out while every item is in, and the keys included after leaving all out', () => {
    const out = withItems(INCLUDE_ALL, [notes], false);
    expect(isIncluded(out, notes)).toBe(false);
    expect(selectionOf(out)).toEqual({ kind: 'allExcept', keys: ['k-notes.md'] });
    expect(out.keys.get('k-notes.md')).toBe('Fall 2026/notes.md');
    const none = leaveAllOut(out);
    expect([notes, slides, bound].map((each) => isIncluded(none, each))).toEqual([false, false, true]);
    const one = withItems(none, [slides], true);
    expect(selectionOf(one)).toEqual({ kind: 'only', keys: ['k-slides.pdf'] });
    expect(selectionOf(includeAll(one, () => true))).toEqual({ kind: 'allExcept', keys: [] });
  });

  it('changes nothing for blocked or required items, and gives back the same object when nothing changes', () => {
    expect(withItems(INCLUDE_ALL, [photo, locked, bound], false)).toBe(INCLUDE_ALL);
    expect(withItems(INCLUDE_ALL, [notes], true)).toBe(INCLUDE_ALL);
    expect(noteBlocked(INCLUDE_ALL, [notes, slides])).toBe(INCLUDE_ALL);
    expect(withoutKeys(INCLUDE_ALL, ['k-gone'])).toBe(INCLUDE_ALL);
  });

  it('keeps an item shown while blocked off once it can be committed, until it is checked', () => {
    const shown = noteBlocked(INCLUDE_ALL, [notes, photo]);
    expect(selectionOf(shown)).toEqual({ kind: 'allExcept', keys: ['k-photo.heic'] });
    const downloaded = { ...photo, readiness: 'ready' as const };
    expect(isIncluded(shown, downloaded)).toBe(false);
    expect(isIncluded(leaveAllOut(shown), downloaded)).toBe(false);
    // Select-all includes it once the list shows it ready, and keeps it off while it does not.
    expect(isIncluded(includeAll(shown, () => false), downloaded)).toBe(false);
    const all = includeAll(shown, (key) => key === 'k-photo.heic');
    expect(isIncluded(all, downloaded)).toBe(true);
    expect(selectionOf(all)).toEqual({ kind: 'allExcept', keys: [] });
    expect(includeAll(all, () => true).blocked).toBe(all.blocked);
    const checked = withItems(shown, [downloaded], true);
    expect(isIncluded(checked, downloaded)).toBe(true);
    expect(selectionOf(checked)).toEqual({ kind: 'allExcept', keys: [] });
    // In "only these" mode, checking it includes it.
    const only = withItems(leaveAllOut(shown), [downloaded], true);
    expect(selectionOf(only)).toEqual({ kind: 'only', keys: ['k-photo.heic'] });
  });

  it('takes an item checked after leaving all out out of the selection once it shows blocked, and keeps it off when ready again', () => {
    const picked = withItems(leaveAllOut(INCLUDE_ALL), [notes, slides], true);
    expect(selectionOf(picked)).toEqual({ kind: 'only', keys: ['k-notes.md', 'k-slides.pdf'] });
    const evicted = { ...notes, readiness: 'notLocal' as const };
    const shown = noteBlocked(picked, [evicted]);
    // The shell would fail a commit that names it: the row, the selection and its key count agree.
    expect(isIncluded(shown, evicted)).toBe(false);
    expect(selectionOf(shown)).toEqual({ kind: 'only', keys: ['k-slides.pdf'] });
    expect(keptKeyCount(shown)).toBe(1);
    expect(noteBlocked(shown, [evicted])).toBe(shown);
    // Ready again: still off, and still out of the selection, until it is checked.
    expect(isIncluded(shown, notes)).toBe(false);
    expect(selectionOf(shown).keys).not.toContain('k-notes.md');
    const checked = withItems(shown, [notes], true);
    expect(isIncluded(checked, notes)).toBe(true);
    expect(selectionOf(checked)).toEqual({ kind: 'only', keys: ['k-slides.pdf', 'k-notes.md'] });
    // While every item is in but some, a key left out and then seen blocked stays left out.
    expect(selectionOf(noteBlocked(withItems(INCLUDE_ALL, [notes], false), [evicted]))).toEqual({ kind: 'allExcept', keys: ['k-notes.md'] });
  });

  it('drops the keys of items that went', () => {
    const kept = noteBlocked(withItems(INCLUDE_ALL, [notes, slides], false), [photo]);
    const pruned = withoutKeys(kept, ['k-notes.md', 'k-photo.heic']);
    expect(selectionOf(pruned)).toEqual({ kind: 'allExcept', keys: ['k-slides.pdf'] });
  });
});

describe('headerState', () => {
  it('is off and stays off with nothing includable', () => {
    expect(headerState(INCLUDE_ALL, 0, 0)).toBe(false);
  });

  it('says on or off at once without kept keys, and mixed with them until the summary comes', () => {
    expect(headerState(INCLUDE_ALL, 10, undefined)).toBe(true);
    expect(headerState(leaveAllOut(INCLUDE_ALL), 10, undefined)).toBe(false);
    expect(headerState(withItems(INCLUDE_ALL, [notes], false), 10, undefined)).toBe('mixed');
  });

  it('follows the summary: on when every includable item is in, off when none, mixed between', () => {
    const some = withItems(INCLUDE_ALL, [notes], false);
    expect(headerState(some, 10, 9)).toBe('mixed');
    expect(headerState(some, 10, 0)).toBe(false);
    // A blocked item that became includable and stays off: not all are in any more.
    expect(headerState(noteBlocked(INCLUDE_ALL, [photo]), 10, 9)).toBe('mixed');
    expect(headerState(withItems(leaveAllOut(INCLUDE_ALL), [notes], true), 1, 1)).toBe(true);
    // Required items stay in after "leave all out": still off.
    expect(headerState(leaveAllOut(INCLUDE_ALL), 10, 2)).toBe(false);
  });
});

describe('selectAllCounts', () => {
  it('sums what each place can change and has in, required items aside', () => {
    const none = { added: 0, modified: 0, deleted: 0, moved: 0 };
    const group = (available: number, selected: number, required: number): SummaryGroup => ({
      place: { kind: 'library' },
      files: none,
      folders: none,
      tags: 0,
      settings: false,
      items: available + 1,
      available,
      selected,
      required,
    });
    // One ready item left out and one unreadable required item: the box is mixed, not on.
    expect(selectAllCounts([group(2, 1, 1), group(3, 3, 0)])).toEqual({ changeable: 4, included: 3 });
    expect(headerState(withItems(INCLUDE_ALL, [notes], false), 4, 3)).toBe('mixed');
    expect(selectAllCounts([])).toEqual({ changeable: 0, included: 0 });
  });
});

describe('the selection key limit', () => {
  /** `count` ready items. */
  const many = (count: number) => Array.from({ length: count }, (_, index) => item(`f${String(index)}.md`));

  it('counts the keys the shell takes: left-out and blocked keys once each, or the included ones', () => {
    const out = withItems(INCLUDE_ALL, [notes, slides], false);
    expect(keptKeyCount(out)).toBe(2);
    // Blocked keys go too, once, also when an item left out was later seen blocked.
    expect(keptKeyCount(noteBlocked(out, [photo, { ...notes, readiness: 'notLocal' }]))).toBe(3);
    expect(keptKeyCount(withItems(leaveAllOut(noteBlocked(INCLUDE_ALL, [photo])), [notes], true))).toBe(1);
  });

  it('tells which changes add a key', () => {
    expect(addsKey(INCLUDE_ALL, notes, false)).toBe(true);
    expect(addsKey(INCLUDE_ALL, notes, true)).toBe(false);
    expect(addsKey(INCLUDE_ALL, photo, false)).toBe(false);
    expect(addsKey(leaveAllOut(INCLUDE_ALL), notes, true)).toBe(true);
    expect(addsKey(leaveAllOut(INCLUDE_ALL), notes, false)).toBe(false);
  });

  it('refuses a change that would keep more than LIMITS.batch keys, and lets one that keeps fewer through', () => {
    const full = withItems(INCLUDE_ALL, many(LIMITS.batch), false);
    expect(keptKeyCount(full)).toBe(LIMITS.batch);
    expect(fitsSelection(full, INCLUDE_ALL)).toBe(true);
    // One more left out: 10,001 keys.
    const over = withItems(full, [notes], false);
    expect(fitsSelection(over, full)).toBe(false);
    expect(fitsSelection(withItems(INCLUDE_ALL, many(LIMITS.batch + 1), false), INCLUDE_ALL)).toBe(false);
    // Putting some back always fits, also from a selection already too long (blocked keys noted).
    const blockedOver = noteBlocked(full, [photo, locked, item('scan.pdf', 'notLocal')]);
    expect(keptKeyCount(blockedOver)).toBe(LIMITS.batch + 3);
    expect(fitsSelection(withItems(blockedOver, many(1), true), blockedOver)).toBe(true);
    expect(fitsSelection(withItems(blockedOver, [notes], false), blockedOver)).toBe(false);
    // In "only these" mode the included keys count.
    const picked = withItems(leaveAllOut(INCLUDE_ALL), many(LIMITS.batch), true);
    expect(fitsSelection(withItems(picked, [notes], true), picked)).toBe(false);
    expect(fitsSelection(full, full)).toBe(true);
  });
});
