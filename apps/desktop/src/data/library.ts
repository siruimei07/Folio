// The library status (docs/specs/ipc-m1.md §6) and what follows from it: which library's queries
// the cache holds. `library_status` answers once the shell has opened the configured library;
// later changes arrive as LibraryStateChanged (`events.ts`), which lands here too. Choosing,
// creating and opening a library are here as well.
import { type QueryClient, queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import {
  type CreateLibrary,
  ipc,
  type LibraryInfo,
  type LibraryStatus,
  type OpenLibrary,
} from '../ipc';
import { type IpcResult, unwrap } from './errors';
import { keys } from './keys';
import { useCommandMutation } from './mutations';
import { publishReferences } from './references';
import { openSession, useSession } from './session';

function openLibraryId(status: LibraryStatus): string | null {
  return status.state === 'open' ? status.library.id : null;
}

/**
 * Makes the cache follow a new library status: every query of a library is dropped, the session
 * starts again and every held reference is let go (ui-architecture §5.4, "On LibraryStateChanged").
 */
export function changeLibrary(client: QueryClient, status: LibraryStatus): void {
  client.setQueryData(keys.libraryStatus(), status);
  client.removeQueries({ queryKey: keys.libraries() });
  openSession(openLibraryId(status));
  publishReferences({ kind: 'reset' });
}

/** How many LibraryStateChanged events have arrived; see `answeredStatus`. */
let stateEvents = 0;

/** LibraryStateChanged (`events.ts`): the cache follows the status it brings. */
export function receiveLibraryState(client: QueryClient, status: LibraryStatus): void {
  stateEvents += 1;
  changeLibrary(client, status);
}

/**
 * The status a command answers (`library_status`, `discard_unfinished_move`), which the cache
 * follows: the status, and every query of a library when it opens or closes one. The shell sends every change as LibraryStateChanged,
 * so one that arrives while the call waits is newer than the answer: at start-up and after a
 * retry, the answer may say `open` while the library's background work has already found an
 * unfinished move (ipc-m1 §6). Then the call resolves to the status the cache has from it. An
 * older event still on its way is no risk: the outcome of a retry or a discard has an event of
 * its own, sent after it, so the cache ends on the newest status either way.
 */
async function answeredStatus(client: QueryClient, call: Promise<IpcResult<LibraryStatus>>): Promise<LibraryStatus> {
  const seen = stateEvents;
  const status = await unwrap(call);
  if (stateEvents !== seen) return client.getQueryData<LibraryStatus>(keys.libraryStatus()) ?? status;
  if (openLibraryId(status) !== useSession.getState().libraryId) changeLibrary(client, status);
  else client.setQueryData(keys.libraryStatus(), status);
  return status;
}

export const libraryStatusQuery = queryOptions({
  queryKey: keys.libraryStatus(),
  // App-wide and tiny; a failure must stay until the root view shows it.
  gcTime: Infinity,
  // A refetch is also the unavailable screen's "Try again", which may open the library.
  queryFn: ({ client }) => answeredStatus(client, ipc.libraryStatus()),
});

/** The library status; `refetch()` retries an unavailable library (ipc-m1 §6). */
export function useLibraryStatus() {
  return useQuery(libraryStatusQuery);
}

/** The open library, or `null` while none is open or the status is loading. */
export function useLibrary(): LibraryInfo | null {
  const { data } = useQuery({
    ...libraryStatusQuery,
    select: (status) => (status.state === 'open' ? status.library : null),
  });
  return data ?? null;
}

/**
 * The folder dialog for a library; resolves to the chosen folder with its choice token and what
 * it holds, or `null` when cancelled.
 */
export function usePickLibraryFolder() {
  return useCommandMutation(() => ipc.pickLibraryFolder());
}

/**
 * Makes the chosen folder (a choice token) this machine's library: a new one, the content taken
 * over, or an incomplete one finished. Resolves to the library and the id of the scan it started.
 * The cache follows when LibraryStateChanged arrives (`changeLibrary`), which may be after this
 * answer: until then `useLibrary()` is still the previous status.
 */
export function useCreateLibrary() {
  return useCommandMutation((request: CreateLibrary) => ipc.createLibrary(request));
}

/** Opens the chosen folder that already holds a library, as `useCreateLibrary` does. */
export function useOpenLibrary() {
  return useCommandMutation((request: OpenLibrary) => ipc.openLibrary(request));
}

/**
 * The unavailable screen's "Discard move", once the user confirmed (ipc-m1 §6): lets go of an
 * unfinished move and opens the library again. Resolves to the status it led to, which the cache
 * follows as it follows "Try again" (the status query): a library that opened, or a new reason.
 * Any other status comes back as it was, so a second call changes nothing.
 */
export function useDiscardUnfinishedMove() {
  const client = useQueryClient();
  return useMutation({ mutationFn: () => answeredStatus(client, ipc.discardUnfinishedMove()) });
}
