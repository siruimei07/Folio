// The fake shell (docs/specs/ui-architecture.md §11; ADR-0005 §5): the M1 commands and events on an
// in-memory library, installed below the generated bindings through `@tauri-apps/api/mocks`, so
// the real `ipc` module, `typedError` and `shellEvents` run unchanged. `main.tsx` installs it in a
// dev browser (the browser pane); `src/test/render.tsx` installs it for view tests. It never ships:
// production builds drop the import, and an e2e test checks the app has no `__FOLIO_FAKE_SHELL__`.
import { mockIPC, mockWindows } from '@tauri-apps/api/mocks';

import { FakeShell, type FakeShellOptions } from './shell';

export type { CommandName } from './contract';
export type { Fixture } from './fixtures/types';
export { optionsFromUrl, type Scenario, scenarioFixture, SCENARIOS } from './scenarios';
export { FakeShell, type FakeShellOptions } from './shell';

declare global {
  interface Window {
    /** The fake shell, for driving it from the console of the browser pane. */
    __FOLIO_FAKE_SHELL__?: FakeShell;
  }
}

/** Replaces the shell with a fake: every IPC call and event goes to the returned `FakeShell`. */
export function installFakeShell(options: FakeShellOptions): FakeShell {
  window.__FOLIO_FAKE_SHELL__?.dispose();
  const shell = new FakeShell(options);
  mockWindows('main');
  mockIPC((command, payload) => shell.invoke(command, payload), { shouldMockEvents: true });
  window.__FOLIO_FAKE_SHELL__ = shell;
  return shell;
}
