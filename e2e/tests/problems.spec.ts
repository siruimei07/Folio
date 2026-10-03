import { execFileSync } from 'node:child_process';
import { mkdir, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';

import problems from '../../apps/desktop/src/i18n/locales/en/problems.json' with { type: 'json' };
import type { Job } from '../../apps/desktop/src/ipc/bindings';
import { createLibrary, expect, invoke, test } from '../fixtures';

// The problems list on the real shell (library-actions handoff §11): a library whose scan finds a
// junction, a .gitignore line and a line of the ignore rules it can't use. "View problems" in the
// Activity popover opens the list with focus on its title; the groups, Copy path and "Edit ignore
// rules" work; Esc returns focus to the activity button; the dialog stays still under reduced
// motion; axe finds nothing serious.

test.use({ libraryFolder: true });

const COURSE = path.join('Fall 2026', 'MAT232 Calculus');

/** Builds the folder, takes it over, saves an invalid ignore rule and waits for the scans. */
async function libraryWithProblems(page: Page, libraryDir: string): Promise<void> {
  const course = path.join(libraryDir, COURSE);
  await mkdir(path.join(course, 'project'), { recursive: true });
  await writeFile(path.join(course, 'project', '.gitignore'), '[z-a]\n*.o\n');
  await mkdir(path.join(libraryDir, 'Elsewhere'));
  // A junction needs no administrator rights; scans never follow it.
  await symlink(path.join(libraryDir, 'Elsewhere'), path.join(course, 'Shortcut'), 'junction');
  const opened = await createLibrary(page);
  const scanState = async (id: string) =>
    (await invoke<Job[]>(page, 'list_jobs')).find((job) => job.id === id)?.status.state;
  await expect.poll(() => scanState(opened.scan)).toBe('done');
  // Saving the rules starts a full scan (ipc-m1 §22), which the UI sees run and end.
  await invoke(page, 'set_ignore_rules', { request: { text: '*.log\n{unclosed\n' } });
  await expect
    .poll(async () => {
      const jobs = await invoke<Job[]>(page, 'list_jobs');
      return jobs.filter((job) => job.kind === 'scan' && job.status.state === 'done').length;
    })
    .toBe(2);
  await expect
    .poll(async () => (await invoke<{ total: number }>(page, 'list_problems', { request: { page: { offset: 0, limit: 0 } } })).total)
    .toBe(3);
}

/**
 * The Windows clipboard's text, read outside the page: WebView2 asks for permission before
 * `navigator.clipboard.readText()` answers.
 */
function windowsClipboard(): string {
  const script = '[Console]::OutputEncoding = [Text.Encoding]::UTF8; Get-Clipboard -Raw';
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8' }).trimEnd();
}

async function openProblems(page: Page) {
  const activity = page.getByRole('button', { name: /^Activity: / });
  await activity.click();
  await page.getByRole('dialog', { name: 'Activity' }).getByRole('button', { name: 'View problems' }).click();
  const dialog = page.getByRole('dialog', { name: problems.title });
  await expect(dialog).toBeVisible();
  return { activity, dialog };
}

test('lists what the scan left out, copies a path, opens the ignore rules, and passes axe', async ({ folio }) => {
  test.setTimeout(120_000);
  const { page, libraryDir } = folio;
  if (!libraryDir) throw new Error('This test requires the isolated library-folder fixture');
  await libraryWithProblems(page, libraryDir);

  const { activity, dialog } = await openProblems(page);
  await expect(dialog.getByRole('heading', { name: problems.title })).toBeFocused();
  await expect(dialog.getByRole('img', { name: '3 problems' })).toBeVisible();
  await expect(dialog.getByRole('heading', { level: 3 })).toHaveText([
    /^Shortcuts Folio doesn't follow/,
    /^Ignore rules Folio can't use/,
  ]);
  const links = dialog.getByRole('region', { name: "Shortcuts Folio doesn't follow, 1 item" });
  await expect(links.getByText(problems.explanation.link)).toBeVisible();
  const rules = dialog.getByRole('region', { name: "Ignore rules Folio can't use, 2 items" });
  await expect(rules.getByRole('listitem')).toHaveCount(2);
  await expect(rules.getByText('Line 2 of your ignore rules')).toBeVisible();
  await expect(dialog.getByText(/^From the scan at \d{1,2}:\d{2} [AP]M\. The list updates after every scan\.$/)).toBeVisible();

  const { violations } = await new AxeBuilder({ page }).include('.modal').analyze();
  const blocking = violations.filter(({ impact }) => impact === 'serious' || impact === 'critical');
  expect(blocking.map(({ id, nodes }) => `${id}: ${nodes.map(({ target }) => target.join(' ')).join(', ')}`)).toEqual([]);

  // Copy path joins the library-relative path to the library root.
  const shortcut = 'Fall 2026/MAT232 Calculus/Shortcut';
  await links.getByRole('button', { name: `Copy path of ${shortcut}` }).click();
  await expect(page.getByRole('status').filter({ hasText: problems.copy.one })).toBeVisible();
  expect(windowsClipboard()).toBe(path.join(libraryDir, COURSE, 'Shortcut'));

  // Esc closes the list and focus goes back to the activity button.
  await dialog.getByRole('heading', { name: problems.title }).focus();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(activity).toBeFocused();

  // "Edit ignore rules" opens Library settings on that page.
  const reopened = (await openProblems(page)).dialog;
  await reopened
    .getByRole('region', { name: "Ignore rules Folio can't use, 2 items" })
    .getByRole('button', { name: problems.editIgnoreRules })
    .click();
  const settings = page.getByRole('dialog', { name: 'Library settings' });
  await expect(settings.getByRole('tab', { name: 'Ignore rules', selected: true })).toBeVisible();
});

test('keeps the problems list still under reduced motion', async ({ folio }) => {
  test.setTimeout(120_000);
  const { page, libraryDir } = folio;
  if (!libraryDir) throw new Error('This test requires the isolated library-folder fixture');
  await libraryWithProblems(page, libraryDir);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await openProblems(page);
  const timing = await page.evaluate<string[]>(`[
    getComputedStyle(document.querySelector('.modal')).animationDuration,
    getComputedStyle(document.querySelector('.modal-overlay')).animationDuration,
  ]`);
  expect(timing.every((value) => value.split(', ').every((part) => part === '0s'))).toBe(true);
});
