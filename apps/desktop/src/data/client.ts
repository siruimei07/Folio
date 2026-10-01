// The query client: one per window, the cache for everything the shell returns (ADR-0005 §1;
// docs/specs/ui-architecture.md §5.1). Freshness comes from the shell's events (`events.ts`), never
// from timers, focus or the network.
import { QueryClient } from '@tanstack/react-query';

/** How long a page nobody shows stays cached; keeps memory bounded on long lists. */
export const PAGE_GC_TIME = 60_000;

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        // 'online' would pause every query while Windows reports no network; IPC needs none.
        networkMode: 'always',
        // Command errors are deterministic, and a Transport error is a bug.
        retry: false,
        staleTime: Infinity,
        refetchOnWindowFocus: false,
        refetchOnReconnect: false,
      },
      mutations: { networkMode: 'always', retry: false },
    },
  });
}
