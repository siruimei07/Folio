// "Show in Changes" in the Changes view (app/changeTarget.ts): once the list has its first pages,
// the view takes the path asked for and looks for its item page by page from the top, then hands
// the row to `reveal`. The shell sorts items by path in its own order, which the UI cannot repeat,
// so the pages are read in turn, a few at a time, from the query cache where they are; a list of
// 50,000 items is at most 250 pages. A page that fails says so; a path no item has any more (it was
// committed or undone meanwhile) says that instead.
import i18n from 'i18next';
import { useEffect, useEffectEvent, useRef } from 'react';

import { usePendingChangeTarget, takeChangeTarget } from '../app/changeTarget';
import { showFailure, whenSettled } from '../app/feedback';
import { showToast } from '../app/toasts';
import { LIST_PAGE, type LoadingPagedList } from '../data/paged';
import type { WorkspaceItem } from '../ipc';
import { type ChangeRows, itemRowKey } from './list/rows';

/** Pages asked for at once while looking for a path. */
const PAGES_AT_ONCE = 4;

interface Found {
  index: number;
  item: WorkspaceItem;
}

/** The item at `path` and its index among the `total` items, or `null` when none has it. */
async function findItem(
  items: LoadingPagedList<WorkspaceItem>,
  total: number,
  path: string,
  stale: () => boolean,
): Promise<Found | null> {
  const pages = Math.ceil(total / LIST_PAGE);
  for (let first = 0; first < pages && !stale(); first += PAGES_AT_ONCE) {
    const batch = Array.from({ length: Math.min(PAGES_AT_ONCE, pages - first) }, (_, at) => first + at);
    const answers = await Promise.all(batch.map((page) => items.loadPage(page)));
    for (const [at, answer] of answers.entries()) {
      const offset = answer.items.findIndex((item) => item.path === path);
      const item = answer.items[offset];
      if (item !== undefined) return { index: (batch[at] ?? 0) * LIST_PAGE + offset, item };
    }
  }
  return null;
}

/**
 * Takes a pending "Show in Changes" target once `rows` have their first pages, finds its item and
 * calls `reveal` with the row's index and key. Leaving the view (or another library) drops a search
 * under way.
 */
export function useChangeTarget(rows: ChangeRows, reveal: (index: number, key: string) => void): void {
  const pending = usePendingChangeTarget();
  const ready = rows.status === 'success';
  // Each search's number: a later one, or the view going, makes an earlier one stale.
  const search = useRef(0);
  useEffect(
    () => () => {
      search.current += 1;
    },
    [],
  );

  const start = useEffectEvent(() => {
    const path = takeChangeTarget();
    if (path === null) return;
    search.current += 1;
    const mine = search.current;
    const stale = () => search.current !== mine;
    whenSettled(
      findItem(rows.items, rows.itemCount, path, stale),
      'changes.target',
      (found) => {
        if (stale()) return;
        if (found === null) showToast({ tone: 'info', title: i18n.t('changes:target.gone') });
        else reveal(rows.rowOfItem(found.index), itemRowKey(found.item.key));
      },
      (failure) => {
        if (!stale()) showFailure(i18n.t('changes:target.failed'), failure.error, 'changes.target');
      },
    );
  });
  useEffect(() => {
    if (pending !== null && ready) start();
  }, [pending, ready]);
}
