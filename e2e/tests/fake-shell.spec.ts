import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { expect, test } from '../fixtures';

// The fake shell (apps/desktop/src/ipc/mock/) serves the browser pane and view tests only: the app
// never installs it, and production builds drop it (UI architecture §11.2, §14 rule 7). Its
// strings all say "fake shell", which minification keeps.
test('the app runs on the real shell, and its build holds no fake shell', async ({ folio }) => {
  expect(await folio.page.evaluate("'__FOLIO_FAKE_SHELL__' in window")).toBe(false);

  const assets = path.resolve(import.meta.dirname, '../../apps/desktop/dist/assets');
  const scripts = (await readdir(assets)).filter((name) => name.endsWith('.js'));
  expect(scripts.length).toBeGreaterThan(0);
  for (const name of scripts) {
    expect(await readFile(path.join(assets, name), 'utf8'), name).not.toContain('fake shell');
  }
});
