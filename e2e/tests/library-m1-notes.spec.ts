import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import library from '../../apps/desktop/src/i18n/locales/en/library.json' with { type: 'json' };
import { blockingViolations, expect, invoke, openLibrary, test, treeRow } from '../fixtures';

// The Library details the M1 gate left (workspace-history handoff §12) on the real shell: the tag
// filter keeps to two rows with "+N" (33B), and a course's folders are 48 px cards above its file
// tiles, one grid for the arrow keys (35A). The quick views' semester (34A) is in
// library-view.spec.ts. Strings run in the page because this package has no DOM types.

test.use({ libraryFolder: true });

const COURSE = 'MAT232 Calculus';
/** Five tags beside the five presets: more than two rows of a 340 px panel hold. */
const MORE_TAGS = [
  ['Labs', 'teal'],
  ['Readings', 'amber'],
  ['Projects', 'indigo'],
  ['Quizzes', 'pink'],
  ['Group work', 'violet'],
] as const;

test('keeps the tag filter to two rows, with the rest behind "+N"', async ({ folio }) => {
  const { page, libraryDir } = folio;
  if (!libraryDir) throw new Error('This test requires the isolated library-folder fixture');
  await mkdir(path.join(libraryDir, 'Fall 2026', COURSE), { recursive: true });
  await writeFile(path.join(libraryDir, 'Fall 2026', COURSE, 'notes.md'), '# Week 1\n');
  await openLibrary(page);
  for (const [name, color] of MORE_TAGS) await invoke(page, 'create_tag', { request: { name, color } });

  const bar = page.getByRole('group', { name: library.filter.label });
  const more = bar.getByRole('button', { name: /^\d+ more tags$/ });
  await expect(more).toBeVisible();
  await expect(more).toHaveText(/^\+\d+$/);
  // The chips sit on two rows: two distinct tops.
  const rows = await page.evaluate<number>(
    `new Set([...document.querySelectorAll('.tag-filter > .tag-chip')].map((chip) => Math.round(chip.getBoundingClientRect().top))).size`,
  );
  expect(rows).toBe(2);

  // The menu lists the hidden tags; one of them filters, and the menu stays open.
  await more.click();
  const menu = page.getByRole('menu');
  const quizzes = menu.getByRole('menuitemcheckbox', { name: 'Quizzes' });
  await expect(quizzes).toBeVisible();
  await quizzes.click();
  await expect(quizzes).toHaveAttribute('aria-checked', 'true');
  await expect(menu).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  const on = bar.getByRole('button', { name: /^\d+ more tags, 1 selected$/ });
  await expect(on).toBeFocused();
  await expect(on).toHaveText(/^\+\d+ · 1 on$/);
  await expect(page.getByRole('heading', { name: library.states.noMatch.title })).toBeVisible();
  expect(await blockingViolations(page, '.tag-filter')).toEqual([]);

  // "All" clears it.
  await bar.getByRole('button', { name: library.filter.all }).click();
  await expect(bar.getByRole('button', { name: /^\d+ more tags$/ })).toBeVisible();
});

test('shows a course\'s folders as cards above its files, one grid for the keyboard', async ({ folio }) => {
  test.setTimeout(90_000);
  const { page, libraryDir } = folio;
  if (!libraryDir) throw new Error('This test requires the isolated library-folder fixture');
  const course = path.join(libraryDir, 'Fall 2026', COURSE);
  await mkdir(path.join(course, 'Lectures'), { recursive: true });
  await writeFile(path.join(course, 'Lectures', 'Lecture 1.pdf'), '%PDF-1.4\n');
  await writeFile(path.join(course, 'Lectures', 'Lecture 2.pdf'), '%PDF-1.4\n');
  await mkdir(path.join(course, 'Problem sets'), { recursive: true });
  await writeFile(path.join(course, 'Problem sets', 'ps1.md'), '# Problem set 1\n');
  await writeFile(path.join(course, 'notes.md'), '# Week 1\n');
  await writeFile(path.join(course, 'syllabus.md'), '# Syllabus\n');
  await openLibrary(page);

  await treeRow(page, COURSE).click();
  const pane = page.getByRole('region', { name: library.pane.label });
  const grid = pane.getByRole('grid', { name: `Files in ${COURSE}` });
  await expect(grid).toBeVisible();
  await expect(grid.getByText(library.cards.folders, { exact: true })).toBeVisible();
  await expect(grid.getByText(library.cards.files, { exact: true })).toBeVisible();

  // A card: 48 px, named as a folder, described by how many files it holds.
  const lectures = grid.getByRole('gridcell', { name: 'Lectures, folder' });
  await expect(lectures).toHaveAccessibleDescription('2 files');
  expect((await lectures.boundingBox())?.height).toBeCloseTo(48, 0);
  await expect(grid.getByRole('gridcell', { name: 'Problem sets, folder' })).toHaveAccessibleDescription('1 file');

  // Arrows go from the cards to the tiles below and back, and right in reading order: two cards,
  // then the first file.
  const focused = grid.locator('[role="gridcell"]:focus');
  await lectures.click();
  await expect(lectures).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(focused).toHaveAccessibleName(/\.md/);
  await page.keyboard.press('ArrowUp');
  await expect(lectures).toBeFocused();
  await page.keyboard.press('Home');
  await expect(focused).toHaveAccessibleName(/, folder$/);
  await page.keyboard.press('ArrowRight');
  await expect(focused).toHaveAccessibleName(/, folder$/);
  await page.keyboard.press('ArrowRight');
  await expect(focused).toHaveAccessibleName(/\.md/);
  expect(await blockingViolations(page, '.library-pane')).toEqual([]);

  // Hover and selection change at once under reduced motion.
  const durations = async () =>
    new Set(
      await page.evaluate<string[]>(
        `[...document.querySelectorAll('.folder-card, .tag-filter .tag-chip')].flatMap((element) => getComputedStyle(element).transitionDuration.split(', '))`,
      ),
    );
  expect(await durations()).not.toEqual(new Set(['0s']));
  await page.emulateMedia({ reducedMotion: 'reduce' });
  expect(await durations()).toEqual(new Set(['0s']));

  // A double-click opens the folder, as a tile did.
  await grid.getByRole('gridcell', { name: 'Problem sets, folder' }).dblclick();
  await expect(pane.getByRole('grid', { name: 'Files in Problem sets' })).toBeVisible();
  await expect(pane.getByRole('gridcell', { name: /^ps1\.md/ })).toBeVisible();
  await expect(pane.getByText(library.cards.folders, { exact: true })).toBeHidden();
});
