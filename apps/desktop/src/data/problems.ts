// Problems found by scans (docs/specs/ipc-m1.md §14; ui-architecture §5.6). ProblemsChanged
// carries the new total, which `events.ts` writes into the count and which refreshes the pages.
import { ipc, type ProblemItem } from '../ipc';
import { keys } from './keys';
import { type PagedList, type PagedListOptions, type RowRange, useCount, usePagedList } from './paged';

/** The problem list, a page at a time, for Library settings. */
export function useProblems(
  range: RowRange | null,
  options?: PagedListOptions,
): PagedList<ProblemItem> {
  return usePagedList(keys.problems, (page) => ipc.listProblems({ page }), range, options);
}

/** How many problems there are, kept current by ProblemsChanged. */
export function useProblemsTotal() {
  return useCount({ of: 'problems' });
}
