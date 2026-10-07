// Mutations (docs/specs/ui-architecture.md §5.4). They never write to the cache: every catalog
// write ends in a CatalogChanged, which refreshes what it touched and moves the references the UI
// holds (`events.ts`), so a mutation's result is for focus and selection only. Errors stay typed:
// a failed command rejects with an `IpcFailure`, and a batch resolves with every item that failed.
//
// What a mutation adds: a `NotFound` for something the UI named means it showed what has since
// moved or gone, so what shows it is refreshed at once (library-actions handoff §9.4), whether or
// not the event is on its way (`touchesGone`).
import { type QueryClient, useMutation, useQueryClient } from '@tanstack/react-query';

import type { BatchResult, EntryRef } from '../ipc';
import { type IpcResult, unwrap } from './errors';
import { refresh } from './events';
import { readKey } from './keys';
import { useSession } from './session';
import { isHistoryQuery, touchesGone } from './touch';

/** What a request names, refreshed when the shell answers `NotFound` for it. */
interface Named<Variables> {
  /** The entries the request refers to. */
  entries?: (variables: Variables) => readonly EntryRef[];
  /** The request names a tag: `NotFound` means it is gone, so the tag list is refreshed. */
  tags?: boolean;
  /**
   * The request names a commit or a version: `NotFound` or `NotHead` means the history changed
   * since the UI read it (handoff workspace-history §9.2), so every query of the history is
   * refreshed.
   */
  history?: boolean;
}

/** Refreshes every query of the history, in the library the request was sent for. */
function refreshHistory(client: QueryClient, libraryId: string | null): void {
  if (libraryId === null) return;
  refresh(client, libraryId, (query) => isHistoryQuery(readKey(query.queryKey)));
}

/**
 * Refreshes what shows `entries`, and the tag list when `tags`, in the library the request was
 * sent for; after a switch to another library its queries are gone, and nothing is refreshed.
 */
function refreshGone(
  client: QueryClient,
  libraryId: string | null,
  entries: readonly EntryRef[],
  tags = false,
): void {
  if (libraryId === null || (entries.length === 0 && !tags)) return;
  refresh(client, libraryId, (query) => {
    const read = readKey(query.queryKey);
    return (tags && read.kind === 'tags') || entries.some((entry) => touchesGone(read, entry));
  });
}

/**
 * A command as a mutation. A `NotFound` answer refreshes what shows the things `named` names.
 * `onSuccess` sees the result and the library the request was sent for.
 */
export function useCommandMutation<Variables = void, Result = unknown>(
  command: (variables: Variables) => Promise<IpcResult<Result>>,
  named: Named<Variables> = {},
  onSuccess?: (client: QueryClient, result: Result, libraryId: string | null) => void,
) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (variables: Variables) => unwrap(command(variables)),
    onMutate: () => ({ libraryId: useSession.getState().libraryId }),
    onSuccess: (result, _variables, sent) => onSuccess?.(client, result, sent.libraryId),
    onError: (error, variables, sent) => {
      const code = error.error.code;
      const libraryId = sent?.libraryId ?? null;
      if (named.history === true && (code === 'NotFound' || code === 'NotHead')) {
        refreshHistory(client, libraryId);
      }
      if (code !== 'NotFound') return;
      refreshGone(client, libraryId, named.entries?.(variables) ?? [], named.tags);
    },
  });
}

/** Refreshes what shows the items of a batch that failed with `NotFound`. */
function refreshFailed(client: QueryClient, result: BatchResult, libraryId: string | null): void {
  const gone = result.failed.filter((item) => item.error.code === 'NotFound');
  refreshGone(
    client,
    libraryId,
    gone.map((item) => item.entry),
  );
}

/**
 * A batch command (ipc-m1 §5.4). It resolves with `done` and every item that failed, each with its
 * typed error, and what shows items that failed with `NotFound` is refreshed. It rejects only
 * when the whole request fails, such as `move_entries` to a target that is gone.
 */
export function useBatchMutation<Variables>(
  command: (variables: Variables) => Promise<IpcResult<BatchResult>>,
  named: Named<Variables> = {},
) {
  return useCommandMutation(command, named, refreshFailed);
}
