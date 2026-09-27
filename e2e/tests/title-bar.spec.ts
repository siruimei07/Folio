import zhCN from '../../apps/desktop/src/i18n/locales/zh-CN.json' with { type: 'json' };
import { expect, test } from '../fixtures';

// Clicks from Playwright reach the page directly, bypassing the native snap layouts overlay, so
// this covers the keyboard path. The overlay itself is verified by hand (ADR-0001, spike 4b).
test('maximizes and restores the window from the keyboard', async ({ folio }) => {
  const { page } = folio;

  await page.getByRole('button', { name: zhCN.titleBar.maximize }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('button', { name: zhCN.titleBar.restore })).toBeFocused();

  await page.keyboard.press('Enter');
  await expect(page.getByRole('button', { name: zhCN.titleBar.maximize })).toBeFocused();
});
