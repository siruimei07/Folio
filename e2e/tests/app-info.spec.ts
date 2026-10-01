import type { AppInfo } from '../../apps/desktop/src/ipc/bindings';
import { expect, test } from '../fixtures';

// The path UI → IPC → Rust, now that the Library view has taken the placeholder's place: the page
// asks the shell for its versions and data directory as the UI would.
test('shows app info from the Rust shell and uses the isolated data directory', async ({ folio }) => {
  const info = (await folio.page.evaluate(
    "window.__TAURI_INTERNALS__.invoke('app_info')",
  )) as AppInfo;
  expect(info.appVersion).toMatch(/^\d+\.\d+\.\d+/);
  expect(info.dataDir).toBe(folio.dataDir);
});
