import { invoke } from '@tauri-apps/api/core';
import { describe, expect, it, vi } from 'vitest';

import { ipc } from '.';

// Exercises the generated `typedError` (crates/folio-app/src/ipc.rs) against Tauri's invoke.
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

describe('ipc', () => {
  it('returns the data of a successful command', async () => {
    const data = { appVersion: '0.1.0', coreVersion: '0.1.0', dataDir: 'C:\\Folio' };
    vi.mocked(invoke).mockResolvedValue(data);

    await expect(ipc.appInfo()).resolves.toEqual({ status: 'ok', data });
  });

  it('returns a command error as the typed error', async () => {
    const error = { code: 'DataDirUnavailable', detail: 'no local app data' };
    vi.mocked(invoke).mockRejectedValue(error);

    await expect(ipc.appInfo()).resolves.toEqual({ status: 'error', error });
  });

  it('returns a rejection that is not a command error as a transport error', async () => {
    // Tauri rejects a command the window may not call with a plain string.
    vi.mocked(invoke).mockRejectedValue('app_info not allowed');

    await expect(ipc.appInfo()).resolves.toEqual({
      status: 'error',
      error: { code: 'Transport', detail: 'app_info not allowed' },
    });
  });
});
