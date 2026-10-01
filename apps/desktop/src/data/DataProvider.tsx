import { noop, type QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { type ReactNode, useLayoutEffect } from 'react';

import { connectShellEvents } from './events';
import { libraryStatusQuery } from './library';

/**
 * The data layer at the app root (docs/specs/ui-architecture.md §5): the query cache, and the
 * one subscription to the shell's events that keeps it fresh. The subscription starts in a
 * layout effect, before the children's effects start their first queries; the library status is
 * asked for at once, since every library query waits for the library's id.
 */
export function DataProvider({ client, children }: { client: QueryClient; children: ReactNode }) {
  useLayoutEffect(() => {
    const stop = connectShellEvents(client);
    // A failure stays in the status query, never collected, for the root view to show as "Folio
    // can't start" (first-run handoff §7); this promise has nothing more to do with it.
    client.query(libraryStatusQuery).catch(noop);
    return stop;
  }, [client]);
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
