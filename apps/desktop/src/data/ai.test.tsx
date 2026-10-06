// The AI settings in the cache (ipc-m2 §12): read once, kept current by every answer and by
// AiSettingsChanged; the key is set, cleared and tested, and reaches no cache.
//
// An answer is checked in the cache itself right after the call, so the test shows that the
// answer put it there and not the AiSettingsChanged that follows it.
import { act, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { type AiSettings, DEFAULT_AI_ENDPOINT, LIMITS, type UpdateAiSettings } from '../ipc';
import { renderAppHook } from '../test/render';
import { aiService, aiServiceAt, removesKey, useAiKey, useAiSettings, useUpdateAiSettings } from './ai';
import { IpcFailure } from './errors';
import { keys } from './keys';

/** Obviously not a real key. */
const FAKE_KEY = 'sk-test-not-a-real-key-0000';
const OTHER_ENDPOINT = 'https://ai.example.test/v1';
const KEEP: UpdateAiSettings = { enabled: null, endpoint: null, model: null, sendContent: null };

/** The hooks on the fake shell, once the settings have loaded. `ai-off` stores no key. */
async function renderAi(options: Parameters<typeof renderAppHook>[1] = {}) {
  const rendered = renderAppHook(
    () => ({ settings: useAiSettings().data, update: useUpdateAiSettings(), key: useAiKey() }),
    { aiDelayMs: 5, ...options },
  );
  await waitFor(() => {
    expect(rendered.result.current.settings).toBeDefined();
  });
  const cached = () => rendered.client.getQueryData<AiSettings>(keys.aiSettings());
  return { ...rendered, cached };
}

/** What an IPC call rejected with. */
async function failureOf(call: Promise<unknown>): Promise<unknown> {
  return call.then(
    () => 'resolved',
    (error: unknown) => error,
  );
}

describe('AI settings in the cache', () => {
  it('loads the seeded settings, which say only whether a key is stored', async () => {
    const { result } = await renderAi();
    expect(result.current.settings).toEqual({
      enabled: true,
      endpoint: DEFAULT_AI_ENDPOINT,
      model: 'deepseek-chat',
      sendContent: true,
      hasKey: true,
    });
  });

  it('loads the ai-off scenario: off, and no key', async () => {
    const { result } = await renderAi({ scenario: 'ai-off' });
    expect(result.current.settings).toMatchObject({ enabled: false, hasKey: false });
  });

  it('takes an update’s answer; an endpoint on another origin drops the key', async () => {
    const { result, cached } = await renderAi();
    const saved = await act(() =>
      result.current.update.mutateAsync({ enabled: null, endpoint: OTHER_ENDPOINT, model: 'm-1', sendContent: false }),
    );
    expect(saved).toMatchObject({ endpoint: OTHER_ENDPOINT, model: 'm-1', sendContent: false, hasKey: false });
    expect(cached()).toEqual(saved);
    await waitFor(() => {
      expect(result.current.settings).toEqual(saved);
    });
  });

  it('rejects an invalid update with its code and keeps the cache', async () => {
    const { result, cached } = await renderAi();
    const before = cached();
    await act(async () => {
      expect(
        await failureOf(result.current.update.mutateAsync({ ...KEEP, endpoint: 'http://plain.example.test' })),
      ).toMatchObject({ error: { code: 'AiEndpointInvalid' } });
      expect(await failureOf(result.current.update.mutateAsync({ ...KEEP, model: 'two words' }))).toMatchObject({
        error: { code: 'AiModelInvalid' },
      });
    });
    expect(cached()).toEqual(before);
  });

  it('follows AiSettingsChanged for a change made elsewhere', async () => {
    const { result, shell } = await renderAi();
    act(() => {
      shell.ai.update({ ...KEEP, enabled: false, model: 'deepseek-reasoner' });
    });
    await waitFor(() => {
      expect(result.current.settings).toMatchObject({ enabled: false, model: 'deepseek-reasoner' });
    });
    act(() => {
      shell.ai.clearKey();
    });
    await waitFor(() => {
      expect(result.current.settings?.hasKey).toBe(false);
    });
  });

  it('stores a key, and puts the answer in the cache', async () => {
    const { result, cached } = await renderAi({ scenario: 'ai-off' });
    const answer = await act(() => result.current.key.set(FAKE_KEY));
    expect(answer).toMatchObject({ endpoint: DEFAULT_AI_ENDPOINT, hasKey: true });
    expect(cached()).toEqual(answer);
  });

  it('a declined confirmation for another service resolves null and stores nothing', async () => {
    const { result, shell, cached } = await renderAi({ confirm: 'cancel' });
    await act(() => result.current.update.mutateAsync({ ...KEEP, endpoint: OTHER_ENDPOINT }));
    const answer = await act(() => result.current.key.set(FAKE_KEY));
    expect(answer).toBeNull();
    expect(cached()).toMatchObject({ endpoint: OTHER_ENDPOINT, hasKey: false });
    expect(shell.ai.settings().hasKey).toBe(false);
  });

  it('stores a key for another service once allowed', async () => {
    const { result, cached } = await renderAi({ confirm: 'allow' });
    await act(() => result.current.update.mutateAsync({ ...KEEP, endpoint: OTHER_ENDPOINT }));
    const answer = await act(() => result.current.key.set(FAKE_KEY));
    expect(answer).toMatchObject({ endpoint: OTHER_ENDPOINT, hasKey: true });
    // The update's AiSettingsChanged may arrive after this answer; the key's own event follows it.
    await waitFor(() => {
      expect(cached()).toEqual(answer);
    });
  });

  it('rejects an invalid key with AiKeyInvalid and keeps the cache', async () => {
    const { result, cached } = await renderAi({ scenario: 'ai-off' });
    const failure = await act(() => failureOf(result.current.key.set('two words')));
    expect(failure).toBeInstanceOf(IpcFailure);
    expect(failure).toMatchObject({ error: { code: 'AiKeyInvalid' } });
    expect(cached()?.hasKey).toBe(false);
  });

  it('a key the shell fails to store rejects with its code and keeps the cache', async () => {
    const { result, cached } = await renderAi({
      scenario: 'ai-off',
      fail: [{ command: 'set_ai_key', code: 'AiCredential' }],
    });
    const failure = await act(() => failureOf(result.current.key.set(FAKE_KEY)));
    expect(failure).toMatchObject({ error: { code: 'AiCredential' } });
    expect(cached()?.hasKey).toBe(false);
  });

  it('clears the key; clearing none still answers the settings', async () => {
    const { result, cached } = await renderAi();
    const cleared = await act(() => result.current.key.clear());
    expect(cleared.hasKey).toBe(false);
    expect(cached()).toEqual(cleared);
    expect(await act(() => result.current.key.clear())).toEqual(cleared);
  });

  it('a clear the shell fails rejects with its code and keeps the cache', async () => {
    const { result, cached } = await renderAi({ fail: [{ command: 'clear_ai_key', code: 'DataDirUnavailable' }] });
    const failure = await act(() => failureOf(result.current.key.clear()));
    expect(failure).toMatchObject({ error: { code: 'DataDirUnavailable' } });
    expect(cached()?.hasKey).toBe(true);
  });

  it('a failed read is the query’s error', async () => {
    const rendered = renderAppHook(() => useAiSettings().error, {
      fail: [{ command: 'get_ai_settings', code: 'DataDirUnavailable' }],
    });
    await waitFor(() => {
      expect(rendered.result.current).toMatchObject({ error: { code: 'DataDirUnavailable' } });
    });
  });

  it('a test without a key is AiNotConfigured', async () => {
    const { result } = await renderAi({ scenario: 'ai-off' });
    const failure = await failureOf(result.current.key.test());
    expect(failure).toBeInstanceOf(IpcFailure);
    expect(failure).toMatchObject({ error: { code: 'AiNotConfigured' } });
  });

  it('a test the service answers resolves', async () => {
    const { result } = await renderAi({ aiMode: 'ok' });
    await expect(result.current.key.test()).resolves.toBeUndefined();
  });

  it.each([
    ['network', 'AiNetwork'],
    ['timeout', 'AiTimeout'],
    ['rejected', 'AiRejected'],
    ['rateLimited', 'AiRateLimited'],
    ['unavailable', 'AiUnavailable'],
    ['badResponse', 'AiBadResponse'],
    ['credential', 'AiCredential'],
  ] as const)('a test the service answers %s rejects with %s', async (aiMode, code) => {
    const { result } = await renderAi({ aiMode });
    const failure = await failureOf(result.current.key.test());
    expect(failure).toBeInstanceOf(IpcFailure);
    expect(failure).toMatchObject({ error: { code } });
  });

  it('keeps the key out of every cache', async () => {
    const { result, client } = await renderAi({ confirm: 'cancel' });
    await act(() => result.current.key.set(FAKE_KEY));
    await act(() => result.current.update.mutateAsync({ ...KEEP, endpoint: OTHER_ENDPOINT }));
    await act(() => result.current.key.set(FAKE_KEY));
    await act(() => failureOf(result.current.key.set(`${FAKE_KEY} x`)));
    const mutations = client.getMutationCache().getAll();
    expect(mutations.length).toBeGreaterThan(0);
    const held = JSON.stringify([
      mutations.map((mutation) => [mutation.options.mutationKey ?? null, mutation.state]),
      client.getQueryCache().getAll().map((query) => [query.queryKey, query.state]),
    ]);
    expect(held).not.toContain(FAKE_KEY);
  });
});

describe('aiService', () => {
  it('names DeepSeek only for the default endpoint itself', () => {
    expect(aiService({ endpoint: DEFAULT_AI_ENDPOINT })).toBe('deepseek');
    expect(aiService({ endpoint: `${DEFAULT_AI_ENDPOINT}/v1` })).toBe('other');
    expect(aiService({ endpoint: OTHER_ENDPOINT })).toBe('other');
  });
});

describe('removesKey', () => {
  const saved = { endpoint: OTHER_ENDPOINT, hasKey: true };

  it('is true only for a stored key and an address on another origin', () => {
    expect(removesKey(saved, 'https://other.example.test/v1')).toBe(true);
    expect(removesKey(saved, DEFAULT_AI_ENDPOINT)).toBe(true);
    expect(removesKey(saved, 'https://ai.example.test:8443/v1')).toBe(true);
    expect(removesKey({ ...saved, hasKey: false }, 'https://other.example.test/v1')).toBe(false);
  });

  it('keeps the key for a change of path, case or trailing slash on the same origin', () => {
    expect(removesKey(saved, 'https://ai.example.test/v2')).toBe(false);
    expect(removesKey(saved, ' HTTPS://AI.Example.test/v1/ ')).toBe(false);
    expect(removesKey(saved, 'https://ai.example.test:443/v1')).toBe(false);
    expect(removesKey({ endpoint: DEFAULT_AI_ENDPOINT, hasKey: true }, `${DEFAULT_AI_ENDPOINT}/beta`)).toBe(false);
  });

  it('is false for an address the shell refuses, which changes nothing', () => {
    expect(removesKey(saved, 'not an address')).toBe(false);
    expect(removesKey(saved, 'http://other.example.test/v1')).toBe(false);
    expect(removesKey(saved, '')).toBe(false);
    expect(removesKey(saved, 'https://other.example.test/v1?x=1')).toBe(false);
  });

  it.each([
    'https://me@other.example.test/v1',
    'https://me:secret@other.example.test/v1',
    'https://other.example.test/v1?',
    'https://other.example.test/v1#',
  ])('is false for %s, which the shell refuses too', (address) => {
    expect(removesKey(saved, address)).toBe(false);
  });

  it('is false for an address over LIMITS.endpointChars, which the shell refuses too', () => {
    expect(removesKey(saved, `https://other.example.test/${'a'.repeat(LIMITS.endpointChars)}`)).toBe(false);
  });
});

describe('aiServiceAt', () => {
  it("names DeepSeek for DeepSeek's own address in any spelling the shell stores as it", () => {
    expect(aiServiceAt(DEFAULT_AI_ENDPOINT)).toBe('deepseek');
    expect(aiServiceAt(`${DEFAULT_AI_ENDPOINT}/`)).toBe('deepseek');
    expect(aiServiceAt(' HTTPS://API.DeepSeek.com// ')).toBe('deepseek');
    expect(aiServiceAt('https://api.deepseek.com:443')).toBe('deepseek');
  });

  it('names another service for any other address, or one the shell refuses', () => {
    expect(aiServiceAt(`${DEFAULT_AI_ENDPOINT}/beta`)).toBe('other');
    expect(aiServiceAt(OTHER_ENDPOINT)).toBe('other');
    expect(aiServiceAt('http://api.deepseek.com')).toBe('other');
    expect(aiServiceAt(`${DEFAULT_AI_ENDPOINT}?x=1`)).toBe('other');
    expect(aiServiceAt('')).toBe('other');
    expect(aiServiceAt('https://me@api.deepseek.com')).toBe('other');
    expect(aiServiceAt(`${DEFAULT_AI_ENDPOINT}?`)).toBe('other');
    expect(aiServiceAt(`${DEFAULT_AI_ENDPOINT}#`)).toBe('other');
  });
});
