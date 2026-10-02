// App settings and the library's ignore rules (docs/specs/ipc-m1.md §22). App settings belong to
// this computer and live outside every library; the rules belong to the open library. Both are
// kept current by their events (`events.ts`) and by the answer of each save, which is the saved
// value: a save whose event the shell failed to send still shows.
import { type QueryClient, queryOptions, useQuery } from '@tanstack/react-query';

import { type AppSettings, type IgnoreRules, ipc, type SetIgnoreRules, type UpdateAppSettings } from '../ipc';
import { unwrap } from './errors';
import { keys, libraryQuery } from './keys';
import { useCommandMutation } from './mutations';
import { useLibraryId, useSession } from './session';

const appSettingsQuery = queryOptions({
  queryKey: keys.appSettings(),
  // App-wide and tiny, like the library status.
  gcTime: Infinity,
  queryFn: () => unwrap(ipc.getAppSettings()),
});

/** This computer's settings: device name, theme and reduce motion. */
export function useAppSettings() {
  return useQuery(appSettingsQuery);
}

/** This computer's name alone, so a change of theme re-renders nothing that shows the name. */
export function useDeviceName(): string | null {
  const { data } = useQuery({ ...appSettingsQuery, select: (settings) => settings.deviceName });
  return data ?? null;
}

/** Puts saved App settings in the cache, from a save's answer or `AppSettingsChanged`. */
export function receiveAppSettings(client: QueryClient, settings: AppSettings): void {
  // A read in flight started before this save; its answer must not replace it.
  void client.cancelQueries({ queryKey: keys.appSettings(), exact: true }, { revert: false });
  client.setQueryData(keys.appSettings(), settings);
}

/**
 * Changes the fields that are not `null` (ipc-m1 §22.1): the device name's Save sends
 * `deviceName`, each appearance control its own field. Resolves to the settings as saved.
 */
export function useUpdateAppSettings() {
  return useCommandMutation(
    (request: UpdateAppSettings) => ipc.updateAppSettings(request),
    {},
    (client, settings) => {
      receiveAppSettings(client, settings);
    },
  );
}

/** The open library's ignore rules: the text of `.folio/ignore` and the lines scans skip. */
export function useIgnoreRules() {
  return useQuery(libraryQuery(useLibraryId(), keys.ignoreRules, () => unwrap(ipc.getIgnoreRules())));
}

/** Puts the rules of library `libraryId` in the cache, from a save's answer or `IgnoreRulesChanged`. */
export function receiveIgnoreRules(client: QueryClient, libraryId: string, rules: IgnoreRules): void {
  // A read in flight (a full refresh after a scan) started before this save; its answer must not
  // replace it.
  void client.cancelQueries({ queryKey: keys.ignoreRules(libraryId), exact: true }, { revert: false });
  client.setQueryData(keys.ignoreRules(libraryId), rules);
}

/**
 * Saves the rules; a change starts a full scan, which `JobChanged` reports (ipc-m1 §22.2).
 * Resolves to the rules as stored: LF line breaks and one final line break.
 */
export function useSetIgnoreRules() {
  return useCommandMutation(
    (request: SetIgnoreRules) => ipc.setIgnoreRules(request),
    {},
    (client, rules, libraryId) => {
      // After a switch to another library the answer is not this library's.
      if (libraryId !== null && libraryId === useSession.getState().libraryId) {
        receiveIgnoreRules(client, libraryId, rules);
      }
    },
  );
}
