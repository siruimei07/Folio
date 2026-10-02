import { mkdir, realpath, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';

import settings from '../../apps/desktop/src/i18n/locales/en/settings.json' with { type: 'json' };
import type { AppSettings, IgnoreRules, Job, Tag } from '../../apps/desktop/src/ipc/bindings';
import { createLibrary, expect, invoke, test } from '../fixtures';

// The settings dialogs on the real shell (app-shell handoff §9; ipc-m1 §22): Library settings from
// Ctrl+, with its pages, a new tag, ignore rules and a new semester; App settings from the avatar
// with the device name, the theme and reduce motion applied at once; axe on both.

test.use({ libraryFolder: true });

/** Opens a library with one semester and one course, and waits for its first scan. */
async function openLibrary(page: Page, libraryDir: string): Promise<void> {
  await mkdir(path.join(libraryDir, 'Fall 2026', 'MAT232 Calculus'), { recursive: true });
  await writeFile(path.join(libraryDir, 'Fall 2026', 'MAT232 Calculus', 'notes.md'), '# Notes\n');
  const opened = await createLibrary(page);
  await expect
    .poll(async () => (await invoke<Job[]>(page, 'list_jobs')).find((job) => job.id === opened.scan)?.status.state)
    .toBe('done');
}

async function expectNoBlockingViolations(page: Page): Promise<void> {
  // Contrast is measured once the dialog has finished fading in. Polled with `evaluate`: the
  // page's CSP refuses the function `waitForFunction` builds from text.
  await expect
    .poll(() => page.evaluate<boolean>(`document.getAnimations().every((animation) => animation.playState !== 'running')`))
    .toBe(true);
  const { violations } = await new AxeBuilder({ page }).include('[role="dialog"]').analyze();
  const blocking = violations.filter(({ impact }) => impact === 'serious' || impact === 'critical');
  expect(blocking.map(({ id, nodes }) => `${id}: ${nodes.map(({ target }) => target.join(' ')).join(', ')}`)).toEqual([]);
}

test('Library settings: pages from the keyboard, a new tag, ignore rules, axe, and focus back on the gear', async ({ folio }) => {
  test.setTimeout(120_000);
  const { page, libraryDir } = folio;
  if (!libraryDir) throw new Error('This test requires the isolated library-folder fixture');
  await openLibrary(page, libraryDir);

  await page.keyboard.press('Control+,');
  const dialog = page.getByRole('dialog', { name: settings.library.title });
  await expect(dialog.getByRole('tab', { name: settings.library.pages.library })).toBeFocused();
  // The shell shows the canonical path; os.tmpdir() can be an 8.3 short one (RUNNER~1 on CI).
  await expect(dialog.getByRole('textbox', { name: settings.folder.label })).toHaveValue(await realpath(libraryDir));
  await expectNoBlockingViolations(page);

  // Arrow keys move between pages; Tags lists the presets.
  await page.keyboard.press('ArrowDown');
  await expect(dialog.getByRole('list', { name: 'Courses in Fall 2026' }).getByRole('listitem')).toHaveCount(1);
  await expectNoBlockingViolations(page);
  await dialog.getByRole('tab', { name: settings.library.pages.courses }).focus();
  await page.keyboard.press('ArrowDown');
  await expect(dialog.getByRole('tab', { name: settings.library.pages.tags })).toHaveAttribute('aria-selected', 'true');
  await expect(dialog.getByRole('list', { name: settings.tags.title }).getByRole('listitem')).toHaveCount(5);
  await dialog.getByRole('button', { name: settings.tags.new }).click();
  const tagDialog = page.getByRole('dialog', { name: settings.tagDialog.newTitle });
  await expect(tagDialog.getByRole('textbox', { name: settings.tagDialog.name })).toBeFocused();
  await page.keyboard.type('Lab reports');
  await page.keyboard.press('Enter');
  await expect(tagDialog).toBeHidden();
  await expect.poll(async () => (await invoke<Tag[]>(page, 'list_tags')).map((tag) => tag.name)).toContain('Lab reports');
  await expect(dialog.getByRole('list', { name: settings.tags.title }).getByRole('listitem')).toHaveCount(6);

  // Ignore rules: saved to .folio/ignore, which starts a scan.
  await dialog.getByRole('tab', { name: settings.library.pages.ignore }).click();
  const rules = dialog.getByRole('textbox', { name: settings.ignore.label });
  await rules.fill('*.log\n');
  await dialog.getByRole('button', { name: settings.save, exact: true }).click();
  await expect(dialog.getByText(settings.ignore.saved)).toBeVisible();
  expect(await invoke<IgnoreRules>(page, 'get_ignore_rules')).toEqual({ text: '*.log\n', invalidLines: [] });
  await expectNoBlockingViolations(page);

  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
});

test('New semester from Library settings makes the folders and switches to it', async ({ folio }) => {
  test.setTimeout(120_000);
  const { page, libraryDir } = folio;
  if (!libraryDir) throw new Error('This test requires the isolated library-folder fixture');
  await openLibrary(page, libraryDir);

  await page.getByRole('button', { name: 'Library settings' }).click();
  const dialog = page.getByRole('dialog', { name: settings.library.title });
  await dialog.getByRole('button', { name: settings.semester.new }).click();
  const create = page.getByRole('dialog', { name: settings.newSemester.title });
  const name = create.getByRole('textbox', { name: settings.newSemester.name });
  await name.fill('Winter 2027');
  await create.getByRole('textbox', { name: 'Course 1 code' }).fill('CSC207');
  await create.getByRole('textbox', { name: 'Course 1 name' }).fill('Software Design');
  await expectNoBlockingViolations(page);
  await create.getByRole('button', { name: 'Create semester and 1 course' }).click();
  await expect(create).toBeHidden();
  expect((await stat(path.join(libraryDir, 'Winter 2027', 'Software Design'))).isDirectory()).toBe(true);
  // The toolbar's semester follows.
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: /current Winter 2027/ })).toBeVisible();
});

test('App settings: device name, theme and reduce motion apply at once', async ({ folio }) => {
  test.setTimeout(120_000);
  const { page, libraryDir } = folio;
  if (!libraryDir) throw new Error('This test requires the isolated library-folder fixture');
  await openLibrary(page, libraryDir);

  const avatar = page.getByRole('button', { name: /^App settings/ });
  await avatar.click();
  const dialog = page.getByRole('dialog', { name: settings.app.title });
  const device = dialog.getByRole('textbox', { name: settings.general.device.label });
  await device.fill('Lab PC');
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await invoke<AppSettings>(page, 'get_app_settings')).deviceName).toBe('Lab PC');
  await expect(avatar).toHaveText('L');
  await expectNoBlockingViolations(page);

  await dialog.getByRole('tab', { name: settings.app.pages.appearance }).click();
  await dialog.getByRole('radio', { name: settings.appearance.theme.dark }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expectNoBlockingViolations(page);

  const duration = () =>
    page.evaluate<string>(`getComputedStyle(document.documentElement).getPropertyValue('--motion-duration-base').trim()`);
  expect(await duration()).not.toMatch(/^0m?s$/);
  await dialog.getByRole('button', { name: new RegExp(settings.appearance.motion.label) }).click();
  await page.getByRole('option', { name: settings.appearance.motion.on, exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-reduce-motion', 'on');
  expect(await duration()).toMatch(/^0m?s$/);
  expect(await invoke<AppSettings>(page, 'get_app_settings')).toMatchObject({ theme: 'dark', reduceMotion: 'on' });

  // Stored: the next start applies them before the first render.
  const restarted = await folio.restart();
  await expect(restarted.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(restarted.locator('html')).toHaveAttribute('data-reduce-motion', 'on');
});
