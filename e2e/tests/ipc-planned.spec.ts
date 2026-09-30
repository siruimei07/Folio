import { expect, test } from '../fixtures';

// Planned commands of docs/specs/ipc-m1.md are typed in the bindings but not registered, listed
// in the app manifest or granted (spec §3). Tauri's ACL must reject them before any handler could
// run; a Rust test in folio-app's ipc.rs keeps them out of the manifest and the capabilities.
test('rejects planned commands before they reach a handler', async ({ folio }) => {
  for (const command of ['list_children', 'import_files']) {
    await expect(
      folio.page.evaluate(`window.__TAURI_INTERNALS__.invoke(${JSON.stringify(command)}, {})`),
    ).rejects.toThrow(/not allowed/);
  }
});
