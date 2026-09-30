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

// jsdom has no matchMedia. `(width < Npx)`, the app's layout query, follows `window.innerWidth`
// (tests set it and dispatch `resize`); every other query, such as reduced motion, does not match.
function matchWidth(query: string): boolean {
  const below = /\(width < (\d+)px\)/.exec(query);
  return below ? window.innerWidth < Number(below[1]) : false;
}
vi.stubGlobal('matchMedia', (query: string): MediaQueryList => {
  const list = new EventTarget() as MediaQueryList;
  let matches = matchWidth(query);
  window.addEventListener('resize', () => {
    const next = matchWidth(query);
    if (next === matches) return;
    matches = next;
    list.dispatchEvent(Object.assign(new Event('change'), { matches, media: query }));
  });
  Object.defineProperties(list, {
    matches: { get: () => matches },
    media: { value: query },
  });
  return list;
});

afterEach(() => {
  cleanup();
});
