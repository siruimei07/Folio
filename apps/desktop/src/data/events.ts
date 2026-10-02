// The one subscription to the shell's events (docs/specs/ui-architecture.md §5.4–§5.6), mounted
// by `DataProvider`. Components never subscribe to catalog events themselves: they read queries,
// and this module keeps the queries fresh.
import type { Query, QueryClient } from '@tanstack/react-query';

import { type CatalogChanged, shellEvents } from '../ipc';
import { isOlderRevision } from '../lib/revision';
import { receiveJob } from './jobs';
import { keys, readKey } from './keys';
import { changeLibrary } from './library';
import { publishReferences } from './references';
import { sawRevision, useSession } from './session';
import { receiveAppSettings, receiveIgnoreRules } from './settings';
import { isTouched } from './touch';

/**
 * The oldest catalog revision a query's data was read at: a page's, or the oldest page of an
 * infinite query. `undefined` for data without one.
 */
export function revisionOf(data: unknown): number | undefined {
  if (typeof data !== 'object' || data === null) return undefined;
  if ('revision' in data && typeof data.revision === 'number') return data.revision;
  if ('pages' in data && Array.isArray(data.pages)) {
    let oldest: number | undefined;
    for (const page of data.pages as unknown[]) {
      const revision = revisionOf(page);
      if (revision === undefined) return undefined;
      if (oldest === undefined || isOlderRevision(revision, oldest)) oldest = revision;
    }
    return oldest;
  }
  return undefined;
}

/**
 * Refreshes the queries of a library that `predicate` picks: those something shows refetch and
 * keep their data until the new data arrives; the others are removed, so a page scrolled into
 * view later is fetched again instead of showing rows of an older revision.
 *
 * A fetch still under way may have been answered before the change (the event overtook the
 * answer), so it is cancelled and asked again. Query cancels a running refetch by itself, but
 * joins a running first load, which would then keep the older answer.
 */
export function refresh(
  client: QueryClient,
  libraryId: string,
  predicate: (query: Query) => boolean,
): void {
  const cache = client.getQueryCache();
  const shown = new Set<Query>();
  for (const query of cache.findAll({ queryKey: keys.library(libraryId), predicate })) {
    if (query.isActive()) shown.add(query);
    else cache.remove(query);
  }
  if (shown.size === 0) return;
  const filters = { predicate: (query: Query) => shown.has(query) };
  // Neither rejects: a failed refetch becomes the query's error state.
  void client.cancelQueries(filters).then(() => client.invalidateQueries(filters));
}

function onCatalogChanged(client: QueryClient, event: CatalogChanged): void {
  const libraryId = useSession.getState().libraryId;
  // Events belong to the open library; there is none while it opens or is unavailable.
  if (libraryId === null) return;
  sawRevision(event.revision);
  // Holders move to the new paths before the old keys refetch, so a moved entry's old key is
  // mostly unobserved by the time it answers `NotFound`.
  publishReferences(
    event.complete ? { kind: 'changes', changes: event.entries } : { kind: 'rebuilt' },
  );
  refresh(client, libraryId, (query) => {
    const revision = revisionOf(query.state.data);
    // Data read at this event's revision or later already holds its changes.
    const current =
      revision !== undefined &&
      !isOlderRevision(revision, event.revision) &&
      query.state.fetchStatus === 'idle';
    return !current && isTouched(readKey(query.queryKey), event);
  });
}

/** Subscribes the cache to the shell's events; returns the function that stops it. */
export function connectShellEvents(client: QueryClient): () => void {
  const stops = [
    shellEvents.onLibraryStateChanged(({ status }) => {
      changeLibrary(client, status);
    }),
    shellEvents.onCatalogChanged((event) => {
      onCatalogChanged(client, event);
    }),
    shellEvents.onJobChanged(({ job }) => {
      const libraryId = useSession.getState().libraryId;
      if (libraryId !== null) receiveJob(client, libraryId, job);
    }),
    shellEvents.onProblemsChanged(({ total }) => {
      const libraryId = useSession.getState().libraryId;
      if (libraryId === null) return;
      client.setQueryData(keys.count(libraryId, { of: 'problems' }), total);
      refresh(client, libraryId, (query) => readKey(query.queryKey).kind === 'problems');
    }),
    shellEvents.onAppSettingsChanged(({ settings }) => {
      receiveAppSettings(client, settings);
    }),
    // Sent before the LibraryStateChanged of any later switch (ipc-m1 §22.2), so the open
    // library is the one whose rules changed.
    shellEvents.onIgnoreRulesChanged(({ rules }) => {
      const libraryId = useSession.getState().libraryId;
      if (libraryId !== null) receiveIgnoreRules(client, libraryId, rules);
    }),
  ];
  return () => {
    for (const stop of stops) stop();
  };
}
