// The entry filters the Library asks with (ipc-m1 §9.1): none, and a tag filter, whose files have
// every one of its tags (app-shell handoff §5).
import { NO_FILTER } from '../data/entries';
import type { EntryFilter } from '../ipc';

export { NO_FILTER };

/** Files with every tag of `tags`; no filter for none. */
export function tagFilterOf(tags: readonly string[]): EntryFilter {
  return tags.length === 0 ? NO_FILTER : { tags: { kind: 'withAll', tags: [...tags] }, addedAfterMs: null };
}
