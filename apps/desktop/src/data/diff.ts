// Diffs (docs/specs/ipc-m2.md §9) and the file a version belongs to now (§8.3), for the diff pane
// (handoff workspace-history §6). A diff is read a window at a time, one query per window under
// `keys.diff`: the pane asks for the rows it shows and the folds it opens, every window answers
// with the whole header, and a refresh refetches only the windows on screen.
//
// Freshness (`events.ts`, `touch.ts`): CatalogChanged touches no diff, since a workspace diff
// waits for the WorkspaceChanged that follows (ipc-m2 §14) and a commit's diff does not change
// while its id names it, and touches every located version. WorkspaceChanged refreshes workspace
// diffs; HistoryChanged refreshes located versions.
import { useQueries, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef } from 'react';

import { type Diff, type DiffWindow, ipc, LIMITS, type VersionRef } from '../ipc';
import { PAGE_GC_TIME } from './client';
import { type IpcFailure, unwrap } from './errors';
import { refresh } from './events';
import { type DiffSource, keys, libraryQuery, readKey } from './keys';
import { useLibraryId } from './session';

export type { DiffSource } from './keys';

/** Rows in one window of the folded diff (`LIMITS.diffRows`). */
export const DIFF_WINDOW_ROWS = LIMITS.diffRows;

/** The window every diff reads: the header and the first rows. */
export const FIRST_WINDOW: DiffWindow = { kind: 'rows', offset: 0, limit: DIFF_WINDOW_ROWS };

/** The source in the key of a diff that asks for nothing. */
const NO_SOURCE: DiffSource = { source: 'workspace', key: '' };

/** The reference in the key of a located version that asks for nothing. */
const NO_VERSION: VersionRef = { commit: '', path: '' };

/** A window as text, for maps and React keys: equal windows give equal text. */
export function windowId(window: DiffWindow): string {
  return window.kind === 'rows'
    ? `rows ${String(window.offset)}+${String(window.limit)}`
    : `unchanged ${String(window.line)}+${String(window.count)}`;
}

/** Whether two sources name the same diff. */
export function sameSource(a: DiffSource, b: DiffSource): boolean {
  if (a.key !== b.key || a.source !== b.source) return false;
  return a.source === 'workspace' || (b.source === 'version' && b.commit === a.commit);
}

/** Only the fields of a source, so an object with more of them keys the same query. */
function exactSource(source: DiffSource): DiffSource {
  return source.source === 'workspace'
    ? { source: 'workspace', key: source.key }
    : { source: 'version', commit: source.commit, key: source.key };
}

function fetchWindow(source: DiffSource, window: DiffWindow): Promise<Diff> {
  return unwrap(
    source.source === 'workspace'
      ? ipc.getWorkspaceDiff({ key: source.key, window })
      : ipc.getVersionDiff({ commit: source.commit, key: source.key, window }),
  );
}

/** One window's query; `source` `null` asks for nothing. */
function windowQuery(libraryId: string | null, source: DiffSource | null, window: DiffWindow) {
  const of = source ?? NO_SOURCE;
  return {
    ...libraryQuery(
      source === null ? null : libraryId,
      (library) => keys.diff(library, of, window),
      () => fetchWindow(of, window),
    ),
    // Like a list's pages: windows nobody shows go, so a long diff read end to end does not stay.
    gcTime: PAGE_GC_TIME,
    // A window past the first that failed waits for "Try again" (`retry`), when it is asked for
    // again too: a window asked for as the view moves must not fail over and over by itself.
    retryOnMount: windowId(window) === windowId(FIRST_WINDOW),
  };
}

/** `windows` with each window once, where it first comes. */
export function uniqueWindows(windows: readonly DiffWindow[]): DiffWindow[] {
  const seen = new Set<string>();
  return windows.filter((window) => {
    const id = windowId(window);
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

/** `DiffWindowAnswer.settled` of a query's result. */
export function settledOf(result: Pick<UseQueryResult, 'dataUpdatedAt' | 'errorUpdateCount'> | undefined): string {
  return result === undefined ? '' : `${String(result.dataUpdatedAt)} ${String(result.errorUpdateCount)}`;
}

/** One window of a diff and its answer. */
export interface DiffWindowAnswer {
  window: DiffWindow;
  /** The latest answer: kept while a refresh is under way, and when the refresh failed. */
  diff: Diff | undefined;
  /** Why the latest fetch failed; `null` when it did not. */
  error: IpcFailure | null;
  /**
   * A fetch is under way. Windows that disagree with the first window's header wait until none
   * is before the pane reads the whole diff again (`diff/model/rows.ts`).
   */
  fetching: boolean;
  /**
   * Changes each time a fetch settles, with an answer or a failure, even one equal to the last: its
   * answer's time and its failure count. A "Try again" knows from it that its read has settled.
   */
  settled: string;
}

export interface DiffWindows {
  /** The windows asked for, each once: the first window, then the others in the order asked. */
  windows: readonly DiffWindowAnswer[];
  /**
   * The first window's state, which is the diff's: `pending` until the header arrives, `error`
   * when its latest fetch failed (an earlier answer stays in `windows[0].diff`).
   */
  status: 'pending' | 'error' | 'success';
  error: IpcFailure | null;
  /** Fetches the windows that failed again. */
  retry: () => void;
  /**
   * Reads the whole diff again: the windows asked for now, and any other cached window when it is
   * asked for next. For a window whose header differs from the first window's (the content
   * changed between the two answers), and for "Try again" after a failed read or refresh.
   */
  reload: () => void;
}

/**
 * Windows of one diff of the open library: the first window, which carries the header, and those
 * of `windows` (rows of the folded diff, unchanged lines that unfold a fold). Memoise `windows`.
 * `source` `null` asks for nothing.
 */
export function useDiffWindows(source: DiffSource | null, windows: readonly DiffWindow[]): DiffWindows {
  const client = useQueryClient();
  const libraryId = useLibraryId();
  const of = source === null ? null : exactSource(source);
  const asked = useMemo(() => uniqueWindows([FIRST_WINDOW, ...windows]), [windows]);
  const combine = useCallback(
    (results: UseQueryResult<Diff>[]) => {
      const first = results[0];
      return {
        windows: asked.map((window, index) => ({
          window,
          diff: results[index]?.data,
          error: results[index]?.error ?? null,
          fetching: results[index]?.isFetching ?? false,
          settled: settledOf(results[index]),
        })),
        status: first?.status ?? 'pending',
        error: first?.error ?? null,
        retry: () => {
          for (const result of results) if (result.isError) void result.refetch();
        },
      };
    },
    [asked],
  );
  const read = useQueries({ queries: asked.map((window) => windowQuery(libraryId, of, window)), combine });

  // The callbacks keep their identity, so what is built from the windows stays memoised.
  const latest = useRef({ libraryId, of });
  useEffect(() => {
    latest.current = { libraryId, of };
  });
  const reload = useCallback(() => {
    const { libraryId: library, of: current } = latest.current;
    if (library === null || current === null) return;
    refresh(client, library, (query) => {
      const key = readKey(query.queryKey);
      return key.kind === 'diff' && sameSource(key.of, current);
    });
  }, [client]);
  return useMemo(
    () => ({
      windows: read.windows,
      status: read.status,
      error: read.error,
      retry: read.retry,
      reload,
    }),
    [read, reload],
  );
}

/**
 * The file a version belongs to now (`locate_version`), `null` when it was deleted since: History's
 * "Open with default app" and "Show in File Explorer", and the current file's preview beside a
 * version that has no content to show (handoff §6.8, §7.3). `version` `null` asks for nothing.
 */
export function useLocatedVersion(version: VersionRef | null) {
  const libraryId = useLibraryId();
  const target = version === null ? NO_VERSION : { commit: version.commit, path: version.path };
  return useQuery(
    libraryQuery(
      version === null ? null : libraryId,
      (library) => keys.located(library, target),
      () => unwrap(ipc.locateVersion(target)),
    ),
  );
}
