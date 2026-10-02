// App settings and ignore rules in the cache (ipc-m1 §22): read once, then kept current by each
// save's answer and by AppSettingsChanged and IgnoreRulesChanged.
import { act, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { renderAppHook } from '../test/render';
import { useAppSettings, useIgnoreRules, useSetIgnoreRules, useUpdateAppSettings } from './settings';

describe('settings in the cache', () => {
  it('follows AppSettingsChanged, and takes a save’s answer', async () => {
    const { result, shell } = renderAppHook(() => ({ settings: useAppSettings().data, update: useUpdateAppSettings() }));
    await waitFor(() => {
      expect(result.current.settings?.deviceName).toBe('G16');
    });
    act(() => {
      shell.saveAppSettings({ ...shell.appSettings, theme: 'dark' });
    });
    await waitFor(() => {
      expect(result.current.settings?.theme).toBe('dark');
    });
    await act(() => result.current.update.mutateAsync({ deviceName: 'Desk', theme: null, reduceMotion: null }));
    await waitFor(() => {
      expect(result.current.settings).toMatchObject({ deviceName: 'Desk', theme: 'dark' });
    });
  });

  it('follows IgnoreRulesChanged for the open library, and takes a save’s answer', async () => {
    const { result, shell } = renderAppHook(() => ({ rules: useIgnoreRules().data, save: useSetIgnoreRules() }));
    await waitFor(() => {
      expect(result.current.rules?.text).toBe('');
    });
    act(() => {
      shell.saveIgnoreRules({ text: '*.log\n', invalidLines: [] });
    });
    await waitFor(() => {
      expect(result.current.rules?.text).toBe('*.log\n');
    });
    const saved = await act(() => result.current.save.mutateAsync({ text: '[\r\n\r\n' }));
    expect(saved).toEqual({ text: '[\n', invalidLines: [1] });
    await waitFor(() => {
      expect(result.current.rules).toEqual(saved);
    });
  });
});
