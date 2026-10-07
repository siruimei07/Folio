// The AI settings in the cache (docs/specs/ipc-m2.md §12). App-wide like the App settings, and
// kept current by each answer and by AiSettingsChanged (`events.ts`).
//
// The API key is write-only across IPC (§12.2): no answer carries it, and the UI must not keep it
// either. So setting, clearing and testing the key are plain calls, not TanStack mutations: a
// mutation keeps its `variables` in the mutation cache, and the key must reach no cache.
import { type QueryClient, queryOptions, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo } from 'react';

import { type AiSettings, DEFAULT_AI_ENDPOINT, ipc, LIMITS, type UpdateAiSettings } from '../ipc';
import { charCount } from '../lib/text';
import { unwrap } from './errors';
import { keys } from './keys';
import { useCommandMutation } from './mutations';

const aiSettingsQuery = queryOptions({
  queryKey: keys.aiSettings(),
  // App-wide and tiny, like the App settings.
  gcTime: Infinity,
  queryFn: () => unwrap(ipc.getAiSettings()),
});

/** On or off, the service and model, what is sent, and whether a key is stored. */
export function useAiSettings() {
  return useQuery(aiSettingsQuery);
}

/** Puts AI settings in the cache, from an answer or `AiSettingsChanged`. */
export function receiveAiSettings(client: QueryClient, settings: AiSettings): void {
  // A read in flight started before this change; its answer must not replace it.
  void client.cancelQueries({ queryKey: keys.aiSettings(), exact: true }, { revert: false });
  client.setQueryData(keys.aiSettings(), settings);
}

/**
 * AI settings to change: each field given replaces the stored one; a field left out, or given as
 * `undefined`, stays as it is (`update_ai_settings` takes `null` for that, which only this module
 * sends).
 */
export type AiSettingsChange = { [Field in keyof UpdateAiSettings]?: NonNullable<UpdateAiSettings[Field]> };

/**
 * Changes the fields given (ipc-m2 §12.1); the others stay as they are. An endpoint on another
 * origin deletes the stored key in the same update, so the answer says `hasKey: false`. Resolves
 * to the settings as saved.
 */
export function useUpdateAiSettings() {
  return useCommandMutation(
    (change: AiSettingsChange) =>
      ipc.updateAiSettings({
        enabled: change.enabled ?? null,
        endpoint: change.endpoint ?? null,
        model: change.model ?? null,
        sendContent: change.sendContent ?? null,
      }),
    {},
    receiveAiSettings,
  );
}

/**
 * Stores `key` for the current endpoint's origin. For a service other than DeepSeek the shell
 * first asks in a Windows dialog; `null` means the user declined and nothing was stored.
 * Rejects with an `IpcFailure` (`AiKeyInvalid`, `AiCredential`, `DataDirUnavailable`, …).
 */
export async function setAiKey(client: QueryClient, key: string): Promise<AiSettings | null> {
  const settings = await unwrap(ipc.setAiKey({ key }));
  if (settings !== null) receiveAiSettings(client, settings);
  return settings;
}

/** Deletes the stored key; with none stored it changes nothing. Resolves to the settings. */
export async function clearAiKey(client: QueryClient): Promise<AiSettings> {
  const settings = await unwrap(ipc.clearAiKey());
  receiveAiSettings(client, settings);
  return settings;
}

/**
 * Sends the service a minimal request with the stored key. Resolves when it answered; rejects
 * with an `IpcFailure` naming the AI failure (`AiNetwork`, `AiRejected`, …), or
 * `AiNotConfigured` when no key is stored for the endpoint.
 */
export async function testAi(): Promise<void> {
  await unwrap(ipc.testAi());
}

/** The key's calls bound to the app's query client. */
export function useAiKey() {
  const client = useQueryClient();
  return useMemo(
    () => ({
      set: (key: string) => setAiKey(client, key),
      clear: () => clearAiKey(client),
      test: testAi,
    }),
    [client],
  );
}

/** Which service the settings name: DeepSeek's own endpoint, or any other. */
export type AiService = 'deepseek' | 'other';

/**
 * The service the UI names (ipc-m2 §12.1): "DeepSeek" for `DEFAULT_AI_ENDPOINT`, "the AI service"
 * for any other endpoint. Each view words it from its own namespace; only the exact default
 * endpoint counts, never another address on the same origin.
 */
export function aiService(settings: Pick<AiSettings, 'endpoint'>): AiService {
  return settings.endpoint === DEFAULT_AI_ENDPOINT ? 'deepseek' : 'other';
}

/** The service an address would name once stored: DeepSeek's own address in any spelling, or another. */
export function aiServiceAt(endpoint: string): AiService {
  return storedEndpoint(endpoint) === DEFAULT_AI_ENDPOINT ? 'deepseek' : 'other';
}

/**
 * Whether saving `endpoint` deletes the stored key (ipc-m2 §12.1): a key is stored and the new
 * address is on another origin. `URL` lower-cases the scheme and host as the shell stores them,
 * so a change of path, case or trailing `/` keeps the key. An address that is not `https` never
 * reaches the key: the shell answers `AiEndpointInvalid` and changes nothing.
 */
export function removesKey(settings: Pick<AiSettings, 'endpoint' | 'hasKey'>, endpoint: string): boolean {
  if (!settings.hasKey) return false;
  const next = httpsUrl(endpoint)?.origin ?? null;
  return next !== null && next !== (httpsUrl(settings.endpoint)?.origin ?? null);
}

/**
 * `endpoint` as the shell would store it (ipc-m2 §12.1): trimmed, the scheme and host
 * lower-cased, no trailing `/`. `null` for an address the shell would refuse with
 * `AiEndpointInvalid`. Only for wording; the shell's answer is what was saved.
 */
function storedEndpoint(endpoint: string): string | null {
  const url = httpsUrl(endpoint);
  return url === null ? null : `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

/**
 * `endpoint` as a URL when the shell would accept it (ipc-m2 §12.1), or `null` when it answers
 * `AiEndpointInvalid`: over `LIMITS.endpointChars` once trimmed, not `https`, no host, a user name
 * or password, or a query or fragment. `URL` drops a bare trailing `?` or `#` and keeps user info
 * out of `origin`, so the text itself is checked for them, as the shell does.
 */
function httpsUrl(endpoint: string): URL | null {
  const text = endpoint.trim();
  if (charCount(text) > LIMITS.endpointChars || text.includes('?') || text.includes('#')) return null;
  if (!URL.canParse(text)) return null;
  const url = new URL(text);
  const accepted = url.protocol === 'https:' && url.hostname !== '' && url.username === '' && url.password === '';
  return accepted ? url : null;
}
