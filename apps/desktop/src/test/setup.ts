import '@testing-library/jest-dom/vitest';

import { mockIPC, mockWindows } from '@tauri-apps/api/mocks';
import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';

import { initI18n } from '../i18n';

await initI18n();

// A stand-in for the Tauri shell: the main window exists, every command succeeds with no data,
// and events are delivered in the page. Tests replace `mockIPC` to script the shell.
mockWindows('main');
mockIPC(() => undefined, { shouldMockEvents: true });

// jsdom has no ResizeObserver; components only need it to exist.
vi.stubGlobal(
  'ResizeObserver',
  class {
    observe = vi.fn();
    unobserve = vi.fn();
    disconnect = vi.fn();
  },
);

afterEach(() => {
  cleanup();
});
