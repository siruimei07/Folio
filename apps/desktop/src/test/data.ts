// Shared setup of the data-layer tests: the small fixture at a fixed time, references to its
// entries as the fake shell numbers them (the root is 0, then 1, 2, … in the fixture's order,
// src/ipc/mock/library.ts), a sort and a visible range, and reference followers that stop when
// the test ends.
import { onTestFinished } from 'vitest';

import { followReferences, type ReferenceUpdate } from '../data/references';
import type { EntryRef, EntrySort } from '../ipc';
import { smallLibrary } from '../ipc/mock/fixtures/small';
import type { LibrarySeed } from '../ipc/mock/fixtures/types';

/** The time fixtures count from in tests: pass it as `now` to `renderApp`. */
export const NOW = Date.UTC(2026, 8, 30, 12);

/** The small fixture at `NOW`. */
export const SMALL = smallLibrary(NOW);

export const BY_NAME: EntrySort = { key: 'name', descending: false };

/** The rows a list shows first. */
export const FIRST_ROWS = { start: 0, end: 50 };

/** The reference the fake gives the entry at `path` of `seed`, until the catalog is rebuilt. */
export function refIn(seed: LibrarySeed, path: string): EntryRef {
  const index = seed.entries.findIndex((entry) => entry.path === path);
  if (index === -1) throw new Error(`no ${path} in the fixture`);
  return { id: String(index + 1), path };
}

/** The reference to the entry at `path` of the small fixture. */
export function smallRef(path: string): EntryRef {
  return refIn(SMALL, path);
}

/** Calls `follower` with every reference update until the test ends. */
export function followUntilTestEnds(follower: (update: ReferenceUpdate) => void): void {
  onTestFinished(followReferences(follower));
}
