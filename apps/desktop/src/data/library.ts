// The library status (docs/specs/ipc-m1.md §6) and what follows from it: which library's queries
// the cache holds. `library_status` answers once the shell has opened the configured library;
// later changes arrive as LibraryStateChanged (`events.ts`), which lands here too.
import { type QueryClient, queryOptions, useQuery } from '@tanstack/react-query';

import { ipc, type LibraryInfo, type LibraryStatus } from '../ipc';
import { unwrap } from './errors';
import { keys } from './keys';
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

export const libraryStatusQuery = queryOptions({
  queryKey: keys.libraryStatus(),
  // App-wide and tiny; a failure must stay until the root view shows it.
  gcTime: Infinity,
  queryFn: async ({ client }) => {
    const status = await unwrap(ipc.libraryStatus());
    // A refetch is also the unavailable screen's "Try again", which may open the library.
    if (openLibraryId(status) !== useSession.getState().libraryId) changeLibrary(client, status);
    return status;
  },
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
