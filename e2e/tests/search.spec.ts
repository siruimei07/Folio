import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';

import library from '../../apps/desktop/src/i18n/locales/en/library.json' with { type: 'json' };
import search from '../../apps/desktop/src/i18n/locales/en/search.json' with { type: 'json' };
import type { FolderChoice, Job, LibraryOpened, SearchPage } from '../../apps/desktop/src/ipc/bindings';
import { expect, test } from '../fixtures';

// The search dialog on the real shell (app-shell handoff §8, UI architecture §9): Ctrl+K, results
// from the real index in two groups with highlights as text, the arrow keys and Enter revealing
// the file in the Library, Esc, the empty and too-long states, axe and reduced motion.

test.use({ libraryFolder: true });

const COURSE = 'MAT232 Calculus';

function invoke<T>(page: Page, command: string, args: Record<string, unknown> = {}): Promise<T> {
  return page.evaluate<T>(`window.__TAURI_INTERNALS__.invoke(${JSON.stringify(command)}, ${JSON.stringify(args)})`);
}

/** Takes over the isolated folder as the library, waits for its first scan and for `text` to be found. */
async function takeOver(page: Page, text: string): Promise<void> {
  const choice = await invoke<FolderChoice | null>(page, 'pick_library_folder');
  if (!choice) throw new Error('The isolated folder choice was cancelled');
  const opened = await invoke<LibraryOpened>(page, 'create_library', {
    request: {
      folder: choice.token,
      name: 'E2E library',
      presetTags: { notes: 'Notes', slides: 'Slides', homework: 'Homework', exam: 'Exams', reference: 'Reference' },
    },
  });
  await expect
    .poll(async () => (await invoke<Job[]>(page, 'list_jobs')).find((job) => job.id === opened.scan)?.status.state)
    .toBe('done');
  const request = { text, scope: null, page: { offset: 0, limit: 50 } };
  await expect.poll(async () => (await invoke<SearchPage>(page, 'search', { request })).items.length).toBeGreaterThan(1);
}

/**
 * A course whose Exams/Midterm folder holds a file named for the midterm and one that only its
 * path matches. The real shell indexes names, paths and tags in M1; body text comes later, so the
 * snippet rendering is covered by the component tests against the fake shell.
 */
async function seed(libraryDir: string): Promise<void> {
  const midterm = path.join(libraryDir, 'Fall 2026', COURSE, 'Exams', 'Midterm');
  await mkdir(midterm, { recursive: true });
  await writeFile(path.join(midterm, 'Midterm review.md'), '# Review\n');
  await writeFile(path.join(midterm, 'practice.pdf'), '%PDF-1.4\n');
  await mkdir(path.join(libraryDir, 'Fall 2026', 'CSC148'), { recursive: true });
  await writeFile(path.join(libraryDir, 'Fall 2026', 'CSC148', 'hw1.py'), 'print(1)\n');
}

test('finds files by name and by folder, reveals one with the keyboard, and passes axe', async ({ folio }) => {
  test.setTimeout(120_000);
  const { page, libraryDir } = folio;
  if (!libraryDir) throw new Error('This test requires the isolated library-folder fixture');
  await seed(libraryDir);
  await takeOver(page, 'midterm');

  await page.keyboard.press('Control+K');
  const dialog = page.getByRole('dialog', { name: search.label });
  const field = dialog.getByRole('textbox', { name: search.label });
  await expect(field).toBeFocused();
  await expect(dialog.getByText(search.idle)).toBeVisible();

  await page.keyboard.type('midterm');
  const results = dialog.getByRole('listbox', { name: search.results });
  const names = results.getByRole('group').filter({ hasText: search.groups.names });
  const contents = results.getByRole('group').filter({ hasText: search.groups.contents });
  const review = names.getByRole('option', { name: 'Midterm review.md' });
  await expect(review).toBeVisible();
  await expect(review.locator('mark')).toHaveText('Midterm');
  await expect(review).toHaveAccessibleDescription(/ \/ Exams \/ Midterm$/);
  // Folders are hits too, with the folder icon instead of a file type's.
  const folder = names.getByRole('option', { name: 'Midterm', exact: true });
  await expect(folder.locator('mark')).toHaveText('Midterm');
  await expect(folder.locator('.search-hit__folder')).toBeVisible();
  // Only its folder matches: Contents, without a highlight in the name.
  const practice = contents.getByRole('option', { name: 'practice.pdf' });
  await expect(practice).toBeVisible();
  await expect(practice.locator('mark')).toHaveCount(0);
  await expect(dialog.locator('footer')).toContainText('3 results');

  const { violations } = await new AxeBuilder({ page }).include('[role="dialog"]').analyze();
  const blocking = violations.filter(({ impact }) => impact === 'serious' || impact === 'critical');
  expect(blocking.map(({ id, nodes }) => `${id}: ${nodes.map(({ target }) => target.join(' ')).join(', ')}`)).toEqual([]);

  // The first row starts active; ↓ moves the active row while the field keeps focus, in the order
  // the rows show. Enter shows the active file in the Library.
  const options = results.getByRole('option');
  const ids = await options.evaluateAll((elements) => elements.map((element) => element.id));
  expect(ids).toHaveLength(3);
  await expect(field).toHaveAttribute('aria-activedescendant', ids[0] ?? '');
  await page.keyboard.press('ArrowDown');
  await expect(field).toHaveAttribute('aria-activedescendant', ids[1] ?? '');
  await page.keyboard.press('ArrowDown');
  await expect(field).toHaveAttribute('aria-activedescendant', ids[2] ?? '');
  await expect(field).toBeFocused();
  const reviewId = (await review.getAttribute('id')) ?? '';
  for (let step = ids.indexOf(reviewId); step < 2; step++) await page.keyboard.press('ArrowUp');
  await expect(field).toHaveAttribute('aria-activedescendant', reviewId);
  await page.keyboard.press('Enter');
  await expect(dialog).toBeHidden();
  const tree = page.getByRole('tree', { name: library.tree.label.replace('{{semester}}', 'Fall 2026') });
  await expect(tree.getByRole('treeitem', { name: /^Midterm review\.md/ })).toHaveAttribute('aria-selected', 'true');
  await expect(tree.getByRole('treeitem', { name: /^Exams/ })).toHaveAttribute('aria-expanded', 'true');
});

test('says when nothing matches or the text is too long, and Esc closes it', async ({ folio }) => {
  test.setTimeout(120_000);
  const { page, libraryDir } = folio;
  if (!libraryDir) throw new Error('This test requires the isolated library-folder fixture');
  await seed(libraryDir);
  await takeOver(page, 'midterm');

  const button = page.getByRole('button', { name: 'Search', exact: true });
  await button.click();
  const dialog = page.getByRole('dialog', { name: search.label });
  const field = dialog.getByRole('textbox', { name: search.label });
  await expect(field).toBeFocused();

  await page.keyboard.type('zzqx');
  await expect(dialog.getByRole('heading', { name: search.empty.title.replace('{{text}}', 'zzqx') })).toBeVisible();

  await field.fill('a'.repeat(257));
  await expect(dialog.getByRole('heading', { name: search.tooLong.title })).toBeVisible();

  // Esc closes from a state without a list too, and focus returns to the button that opened it.
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(button).toBeFocused();
});

test('opens and closes without moving under reduced motion', async ({ folio }) => {
  const { page, libraryDir } = folio;
  if (!libraryDir) throw new Error('This test requires the isolated library-folder fixture');
  await seed(libraryDir);
  await takeOver(page, 'midterm');

  await page.keyboard.press('Control+K');
  const dialog = page.getByRole('dialog', { name: search.label });
  await page.keyboard.type('midterm');
  await expect(dialog.getByRole('option', { name: 'Midterm review.md' })).toBeVisible();
  const motion = () =>
    page.evaluate<string[]>(
      `[getComputedStyle(document.documentElement).getPropertyValue('--motion-duration-base').trim(),
        ...[...document.querySelectorAll('.search-hit')].map((element) => getComputedStyle(element).transitionDuration)]`,
    );
  // The dialog fades and rows change colour with motion on, so the check below is not of nothing.
  expect(new Set(await motion())).not.toEqual(new Set(['0s', '0ms']));
  await page.emulateMedia({ reducedMotion: 'reduce' });
  expect([...new Set(await motion())].every((duration) => /^0m?s$/.test(duration))).toBe(true);
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
});
