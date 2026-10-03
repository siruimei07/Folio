import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { Page } from '@playwright/test';

import library from '../../apps/desktop/src/i18n/locales/en/library.json' with { type: 'json' };
import search from '../../apps/desktop/src/i18n/locales/en/search.json' with { type: 'json' };
import type { SearchPage } from '../../apps/desktop/src/ipc/bindings';
import { blockingViolations, expect, invoke, openLibrary, test } from '../fixtures';

// The search dialog on the real shell (app-shell handoff §8, UI architecture §9): Ctrl+K, results
// from the real index in two groups with highlights as text, one- and two-character Chinese
// queries, the arrow keys and Enter revealing the file in the Library, Esc, the empty and too-long
// states, axe and reduced motion.

test.use({ libraryFolder: true });

const COURSE = 'MAT232 Calculus';

/** Opens the folder as the library and waits until the index finds `text`. */
async function openSearchable(page: Page, text: string): Promise<void> {
  await openLibrary(page);
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
  await openSearchable(page, 'midterm');

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

  expect(await blockingViolations(page, '[role="dialog"]')).toEqual([]);

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

test('finds Chinese names by one and two characters and marks exactly them', async ({ folio }) => {
  test.setTimeout(120_000);
  const { page, libraryDir } = folio;
  if (!libraryDir) throw new Error('This test requires the isolated library-folder fixture');
  const files = {
    '线性代数/复习笔记.md': '# 复习\n',
    '线性代数/第3讲 特征值.pdf': '%PDF-1.4\n',
    '数学分析/习题课笔记.docx': 'not really a document',
    '数学分析/期中.pdf': '%PDF-1.4\n',
  };
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(libraryDir, '2026 秋', name);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content);
  }
  await openSearchable(page, '笔');

  await page.keyboard.press('Control+K');
  const dialog = page.getByRole('dialog', { name: search.label });
  const field = dialog.getByRole('textbox', { name: search.label });
  const results = dialog.getByRole('listbox', { name: search.results });
  // FTS5 trigrams miss terms shorter than three characters; Folio's tokenizer finds them (ADR-0002 §5).
  const queries: [string, string[]][] = [
    ['笔', ['复习笔记.md', '习题课笔记.docx']],
    ['笔记', ['复习笔记.md', '习题课笔记.docx']],
    ['特征', ['第3讲 特征值.pdf']],
    ['期', ['期中.pdf']],
  ];
  for (const [text, expected] of queries) {
    await field.fill(text);
    await expect(results.getByRole('option')).toHaveCount(expected.length);
    for (const name of expected) {
      await expect(results.getByRole('option', { name }).locator('mark')).toHaveText(text);
    }
  }
});

test('says when nothing matches or the text is too long, and Esc closes it', async ({ folio }) => {
  test.setTimeout(120_000);
  const { page, libraryDir } = folio;
  if (!libraryDir) throw new Error('This test requires the isolated library-folder fixture');
  await seed(libraryDir);
  await openSearchable(page, 'midterm');

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
  await openSearchable(page, 'midterm');

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
