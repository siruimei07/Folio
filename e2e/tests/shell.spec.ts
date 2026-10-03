import { access, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import type { Page } from '@playwright/test';

import libraryStrings from '../../apps/desktop/src/i18n/locales/en/library.json' with { type: 'json' };
import shell from '../../apps/desktop/src/i18n/locales/en/shell.json' with { type: 'json' };
import titlebar from '../../apps/desktop/src/i18n/locales/en/titlebar.json' with { type: 'json' };
import { blockingViolations, createLibrary, expect, test } from '../fixtures';

// The window shell (docs/design/handoff/app-shell.md §2–§4, ui-architecture §6): title bar, toolbar,
// rail and content region, on the real shell. Strings run in the page because this package has no
// DOM types.

// The shell shows once a library is open; before that, the first run (first-run handoff §2).
test.use({ libraryFolder: true });

/** Opens a library in the isolated folder, so the shell shows. */
async function openLibrary(page: Page): Promise<void> {
  await createLibrary(page);
  await expect(page.getByRole('navigation', { name: shell.rail.label })).toBeVisible();
}

test('shows the Library on the rail and in the content region, and passes axe', async ({ folio }) => {
  const { page } = folio;
  await openLibrary(page);
  const rail = page.getByRole('navigation', { name: shell.rail.label });
  const library = rail.getByRole('button', { name: shell.rail.library, exact: true });
  await expect(library).toHaveAttribute('aria-current', 'page');
  await expect(page.getByRole('main').getByRole('region', { name: libraryStrings.panel.title })).toBeVisible();
  await expect(page.getByRole('banner').getByRole('button', { name: titlebar.close })).toBeVisible();
  // Until M2 the rail shows the Library only (ADR-0005, product decision 3), then the gear and
  // the avatar of the settings dialogs.
  await expect(rail.getByRole('button')).toHaveCount(3);
  await expect(rail.getByRole('button', { name: 'Library settings' })).toHaveAttribute('aria-haspopup', 'dialog');

  // Focus opens the rail button's tooltip. Check it before any key: React Aria closes it on every
  // keydown on its trigger, so a check after one only passes during the fade-out.
  await library.focus();
  await expect(page.getByRole('tooltip')).toBeVisible();
  // Closed before axe runs, which would catch it halfway through a fade.
  await page.keyboard.press('Escape');
  await expect(page.getByRole('tooltip')).toBeHidden();

  // Ctrl+1 keeps the Library; the keyboard reaches the rail.
  await page.keyboard.press('Control+1');
  await expect(library).toBeFocused();
  await expect(library).toHaveAttribute('aria-current', 'page');

  expect(await blockingViolations(page)).toEqual([]);
});

test('puts the toolbar into one 40 px bar below 760 px and back', async ({ folio }) => {
  const { page } = folio;
  await openLibrary(page);
  const bar = page.getByRole('banner');
  await expect(bar).toHaveAttribute('data-variant', 'standard');

  await page.setViewportSize({ width: 600, height: 400 });
  await expect(page.locator('html')).toHaveAttribute('data-layout', 'narrow');
  await expect(bar).toHaveAttribute('data-variant', 'narrow');
  // To within 0.05 px: some displays lay the bar out at 40.995 px.
  expect((await bar.boundingBox())?.height).toBeCloseTo(41, 1);
  // The caption buttons stay at the right edge, where the snap layouts overlay follows them.
  const close = await bar.getByRole('button', { name: titlebar.close }).boundingBox();
  expect(close?.x).toBeCloseTo(600 - 46, 1);

  await page.setViewportSize({ width: 1000, height: 700 });
  await expect(page.locator('html')).toHaveAttribute('data-layout', 'wide');
  await expect(bar).toHaveAttribute('data-variant', 'standard');
});

test('follows Windows for dark mode and reduced motion until the app has its own settings', async ({
  folio,
}) => {
  const { page } = folio;
  await openLibrary(page);
  // The token in milliseconds: Chromium may print "0ms" as "0s".
  const read = () =>
    page.evaluate(`(() => {
      const fast = getComputedStyle(document.documentElement).getPropertyValue('--motion-duration-fast').trim();
      return {
        theme: document.documentElement.dataset.theme ?? null,
        background: getComputedStyle(document.body).backgroundColor,
        fast: parseFloat(fast) * (fast.endsWith('ms') ? 1 : 1000),
        transition: getComputedStyle(document.querySelector('.rail__button')).transitionDuration,
      };
    })()`);

  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
  // color.surface.app in dark mode; every duration token is 0 under reduced motion.
  expect(await read()).toEqual({ theme: null, background: 'rgb(21, 19, 18)', fast: 0, transition: '0s, 0s' });

  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'no-preference' });
  expect(await read()).toEqual({
    theme: null,
    background: 'rgb(243, 242, 240)',
    fast: 120,
    transition: '0.12s, 0.12s',
  });
});

test('the dev gallery is not part of the app build', async () => {
  const dist = path.resolve(import.meta.dirname, '../../apps/desktop/dist');
  await expect(access(path.join(dist, 'gallery.html'))).rejects.toThrow();
  const assets = path.join(dist, 'assets');
  for (const name of (await readdir(assets)).filter((file) => file.endsWith('.js'))) {
    expect(await readFile(path.join(assets, name), 'utf8'), name).not.toContain('Stand-in for the dialog');
  }
});
