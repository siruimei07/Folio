import titlebar from '../../apps/desktop/src/i18n/locales/en/titlebar.json' with { type: 'json' };
import { expect, test } from '../fixtures';

// Clicks from Playwright reach the page directly, bypassing the native snap layouts overlay, so
// this covers the keyboard path. The overlay itself is verified by hand (ADR-0001, spike 4b).
test('maximizes and restores the window from the keyboard', async ({ folio }) => {
  const { page } = folio;

  await page.getByRole('button', { name: titlebar.maximize }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('button', { name: titlebar.restore })).toBeFocused();

  await page.keyboard.press('Enter');
  await expect(page.getByRole('button', { name: titlebar.maximize })).toBeFocused();
});
