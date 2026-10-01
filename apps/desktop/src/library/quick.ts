// The quick views (app-shell handoff §5; library-actions decision "Recently added"): files added
// in the last 7 days, and files without tags, over the whole library, so files at the top level
// of the library show there too (library-actions §16 item 6).
import { useEffect, useState } from 'react';

import { useCount } from '../data/paged';
import type { EntryFilter } from '../ipc';
import type { QuickView } from './state';

const RECENT_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;
/**
 * The cutoff moves on every hour, not every render: each move is a new query, whose list starts
 * over. Seven days give or take an hour is still "the last 7 days".
 */
const HOUR_MS = 60 * 60 * 1000;

function cutoff(): string {
  const now = Math.floor(Date.now() / HOUR_MS) * HOUR_MS;
  return String(now - RECENT_DAYS * DAY_MS);
}

/** When "Recently added" starts, moving with the clock. */
function useRecentCutoff(): string {
  const [value, setValue] = useState(cutoff);
  useEffect(() => {
    const timer = window.setInterval(() => {
      setValue(cutoff());
    }, HOUR_MS);
    return () => {
      window.clearInterval(timer);
    };
  }, []);
  return value;
}

const UNTAGGED: EntryFilter = { tags: { kind: 'untagged' }, addedAfterMs: null };

/** The filter of each quick view. */
export function useQuickFilters(): Record<QuickView, EntryFilter> {
  return { recent: recentFilter(useRecentCutoff()), untagged: UNTAGGED };
}

function recentFilter(after: string): EntryFilter {
  return { tags: null, addedAfterMs: after };
}

/**
 * The filter of a quick view the third column shows: fixed while it is open, so its list never
 * starts over (and takes focus with it) under someone reading it; the next opening moves on.
 */
export function useOpenQuickFilter(view: QuickView): EntryFilter {
  const [opened] = useState(() => (view === 'recent' ? recentFilter(cutoff()) : UNTAGGED));
  return opened;
}

/** How many files each quick view holds. */
export function useQuickCounts(): Record<QuickView, number | undefined> {
  const filters = useQuickFilters();
  const recent = useCount({ of: 'files', scope: null, filter: filters.recent });
  const untagged = useCount({ of: 'files', scope: null, filter: filters.untagged });
  return { recent: recent.data, untagged: untagged.data };
}
