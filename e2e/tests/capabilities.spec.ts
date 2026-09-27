import { expect, test } from '../fixtures';

// Smoke test of Tauri's permission check: a core command the main window was not granted must be
// rejected. The static rule (individual permissions only) is a Rust test in folio-app's ipc.rs.
test('rejects a core command the main window was not granted', async ({ folio }) => {
  await expect(
    folio.page.evaluate("window.__TAURI_INTERNALS__.invoke('plugin:app|version')"),
  ).rejects.toThrow('not allowed');
});
