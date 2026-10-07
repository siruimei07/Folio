// The Changes view's own window-size queries: its narrow layout below
// `size.changes-narrow-breakpoint` (workspace-history handoff §2.1 as built) and the commit bar's
// short window below `size.commit-bar-overlay` (§4.7). Media queries cannot read custom
// properties, so the sizes come from the generated token constants, read with app/layout.ts's
// `windowQuery` like the app's own breakpoint, which the shell and the other views keep.

import { useSyncExternalStore } from 'react';

import { windowQuery } from '../app/layout';
import { SIZE } from '../tokens/tokens';

const narrow = windowQuery(`(width < ${String(SIZE.changesNarrowBreakpoint)}px)`);
const short = windowQuery(`(height < ${String(SIZE.commitBarOverlay)}px)`);

/**
 * The Changes view lays out narrow, the diff over the list and the commit bar under it, in a
 * window narrower than `size.changes-narrow-breakpoint` (1,000 px), wider than the app's 760 px:
 * beside the fixed list (290) and commit lane (320) the diff would get about 300 px or less.
 */
export function useChangesNarrow(): boolean {
  return useSyncExternalStore(narrow.subscribe, narrow.matches);
}

/** A window this short opens the commit bar's description over the list (§4.7, 500 × 320). */
export function useShortWindow(): boolean {
  return useSyncExternalStore(short.subscribe, short.matches);
}
