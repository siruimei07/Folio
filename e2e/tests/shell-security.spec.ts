import zhCN from '../../apps/desktop/src/i18n/locales/zh-CN.json' with { type: 'json' };
import { expect, test } from '../fixtures';

test('a page close listener cannot veto the shell close decision', async ({ folio }) => {
  const { page } = folio;
  await page.getByRole('button', { name: zhCN.titleBar.close }).waitFor();
  await page.evaluate(`(async () => {
    const { invoke, transformCallback } = window.__TAURI_INTERNALS__;
    await invoke('plugin:event|listen', {
      event: 'tauri://close-requested', target: { kind: 'Window', label: 'main' },
      handler: transformCallback(() => {}),
    });
  })()`);
  const closed = page.waitForEvent('close');
  await page.evaluate(`setTimeout(() => {
    void window.__TAURI_INTERNALS__.invoke('plugin:window|close');
  }, 0)`);
  await closed;
});

test('the shell rejects oversized overlays and accepts explicit hiding', async ({ folio }) => {
  const { page } = folio;
  await page.getByRole('button', { name: zhCN.titleBar.maximize }).waitFor();
  const result = await page.evaluate(`(async () => {
    const { invoke } = window.__TAURI_INTERNALS__;
    let rejection;
    try {
      await invoke('set_maximize_button_bounds', {
        bounds: { right: 0, top: 0, width: 10000, height: 10000 },
      });
    } catch (error) { rejection = error; }
    await invoke('set_maximize_button_bounds', { bounds: null });
    return rejection;
  })()`);
  expect(result).toMatchObject({ code: 'InvalidArgument' });
});
