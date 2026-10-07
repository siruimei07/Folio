import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import errors from '../../apps/desktop/src/i18n/locales/en/errors.json' with { type: 'json' };
import settings from '../../apps/desktop/src/i18n/locales/en/settings.json' with { type: 'json' };
import shell from '../../apps/desktop/src/i18n/locales/en/shell.json' with { type: 'json' };
import { blockingViolations, countCalls, expect, openLibrary, test } from '../fixtures';

// App settings → AI on the real shell (app-shell handoff §9; ipc-m2 §12). The AI commands are
// planned stubs until feat/core-ai-message registers them, so get_ai_settings resolves to a
// Transport error and the page shows its load failure. The page's flows (switches, service,
// write-only key, Test) run in apps/desktop/src/settings/ai.test.tsx on the fake shell; the lane
// that registers the commands adds the real-shell set/test flow (FOLIO_TEST_AI_CONFIRM).

test.use({ libraryFolder: true });

test('App settings → AI from the keyboard shows the load failure with Try again, passes axe, and Esc returns to the avatar', async ({ folio }) => {
  test.setTimeout(120_000);
  const { page, libraryDir } = folio;
  if (!libraryDir) throw new Error('This test requires the isolated library-folder fixture');
  await mkdir(path.join(libraryDir, 'Fall 2026', 'MAT232 Calculus'), { recursive: true });
  await writeFile(path.join(libraryDir, 'Fall 2026', 'MAT232 Calculus', 'notes.md'), '# Notes\n');
  await openLibrary(page);
  const aiSettingsCalls = countCalls(page, 'get_ai_settings');

  const avatar = page.getByRole('button', { name: /^App settings/ });
  await avatar.focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: settings.app.title });
  await expect(dialog.getByRole('tab', { name: settings.app.pages.general })).toBeFocused();

  // General → Appearance → AI.
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  const tab = dialog.getByRole('tab', { name: settings.app.pages.ai });
  await expect(tab).toBeFocused();
  await expect(tab).toHaveAttribute('aria-selected', 'true');

  const panel = dialog.getByRole('tabpanel', { name: settings.app.pages.ai });
  await expect(panel.getByText(settings.ai.loadFailed)).toBeVisible();
  await expect(panel.getByText(errors.Transport)).toBeVisible();
  // Nothing of the page's controls renders without settings.
  await expect(panel.getByRole('switch')).toHaveCount(0);
  await expect(panel.getByRole('textbox')).toHaveCount(0);
  expect(await blockingViolations(page, '[role="dialog"]')).toEqual([]);

  // Try again asks the shell again; the command is still a stub, so the failure stays.
  const before = aiSettingsCalls();
  expect(before).toBeGreaterThan(0);
  await panel.getByRole('button', { name: shell.tryAgain }).click();
  await expect.poll(aiSettingsCalls).toBeGreaterThan(before);
  await expect(panel.getByText(settings.ai.loadFailed)).toBeVisible();
  await expect(panel.getByRole('button', { name: shell.tryAgain })).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(avatar).toBeFocused();
});
