import { mkdir, readFile, realpath, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { Page } from '@playwright/test';

import common from '../../apps/desktop/src/i18n/locales/en/common.json' with { type: 'json' };
import firstRun from '../../apps/desktop/src/i18n/locales/en/first-run.json' with { type: 'json' };
import library from '../../apps/desktop/src/i18n/locales/en/library.json' with { type: 'json' };
import type { Course } from '../../apps/desktop/src/ipc/bindings';
import { blockingViolations, createLibrary, exists, expect, invoke, test } from '../fixtures';

// The first run on the real shell (first-run handoff §2–§7), in a temporary folder that the debug
// folder dialog double answers with: a new library with its semester and courses, a folder taken
// over with its course codes, and a library whose settings went missing, with Try again. Strings
// run in the page because this package has no DOM types.

test.use({ libraryFolder: true });

function heading(page: Page, name: string) {
  return page.getByRole('heading', { level: 1, name });
}

test('creates a library, its semester and courses, and opens it in the Library', async ({ folio }) => {
  test.setTimeout(120_000);
  const { page, libraryDir } = folio;
  if (!libraryDir) throw new Error('This test requires the isolated library-folder fixture');

  await expect(heading(page, firstRun.welcome.title)).toBeVisible();
  await expect(page.getByRole('button', { name: firstRun.welcome.newLibrary.title })).toBeFocused();
  expect(await blockingViolations(page)).toEqual([]);

  // Step 1: the empty folder, its name selected.
  await page.getByRole('button', { name: firstRun.welcome.newLibrary.title }).click();
  await expect(heading(page, firstRun.folder.empty.title)).toBeVisible();
  await expect(page.getByText(firstRun.folder.empty.meta)).toBeVisible();
  const name = page.getByRole('textbox', { name: firstRun.name.label });
  await expect(name).toBeFocused();
  await expect(name).toHaveValue(path.basename(libraryDir));
  expect(await blockingViolations(page)).toEqual([]);
  await name.fill('E2E library');
  await page.keyboard.press('Enter');

  // Step 2: the semester, a course per row; Enter in a name adds the next row.
  await expect(heading(page, firstRun.courses.title)).toBeVisible();
  const semester = page.getByRole('textbox', { name: firstRun.courses.semesterLabel });
  await expect(semester).toBeFocused();
  await semester.fill('Fall 2026');
  await page.getByRole('textbox', { name: 'Course 1 code' }).fill('MAT232');
  await page.getByRole('textbox', { name: 'Course 1 name' }).fill('Calculus');
  await page.getByRole('textbox', { name: 'Course 1 name' }).press('Enter');
  await expect(page.getByRole('textbox', { name: 'Course 2 code' })).toBeFocused();
  await page.getByRole('textbox', { name: 'Course 2 name' }).fill('Linear Algebra');
  // The colour popover: a radio group of the palette.
  await page.getByRole('button', { name: 'Course 2 colour: Orange' }).click();
  const colours = page.getByRole('dialog', { name: common.colour.caption });
  await expect(colours.getByRole('radio', { name: 'Orange' })).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Enter');
  await expect(colours).toBeHidden();
  await expect(page.getByRole('button', { name: 'Course 2 colour: Amber' })).toBeFocused();
  expect(await blockingViolations(page)).toEqual([]);
  await page.getByRole('button', { name: 'Create 2 courses' }).click();

  // The Library opens on the new semester, with the first course selected.
  const tree = page.getByRole('tree', { name: library.tree.label.replace('{{semester}}', 'Fall 2026') });
  await expect(tree.getByRole('treeitem', { name: /^MAT232 Calculus/ })).toHaveAttribute('aria-selected', 'true');
  await expect(tree.getByRole('treeitem', { name: /^Linear Algebra/ })).toBeVisible();
  // Badges: the letters of the code, else of the name (app-shell handoff 23).
  await expect(tree.getByRole('treeitem', { name: /^MAT232 Calculus/ }).locator('.course-badge')).toHaveText('MAT');
  await expect(tree.getByRole('treeitem', { name: /^Linear Algebra/ }).locator('.course-badge')).toHaveText('Lin');
  expect(await exists(path.join(libraryDir, 'Fall 2026', 'Calculus'))).toBe(true);
  expect(await exists(path.join(libraryDir, 'Fall 2026', 'Linear Algebra'))).toBe(true);
  expect(JSON.parse(await readFile(path.join(libraryDir, '.folio', 'library.json'), 'utf8')) as unknown).toMatchObject({
    name: 'E2E library',
  });
  const courses = await invoke<Course[]>(page, 'list_courses', { request: { semester: null } });
  expect(courses.map(({ name: course, code, color }) => ({ course, code, color }))).toEqual([
    { course: 'Calculus', code: 'MAT232', color: 'red' },
    { course: 'Linear Algebra', code: null, color: 'amber' },
  ]);

  // The library opens by itself the next time.
  const restarted = await folio.restart();
  await expect(restarted.getByRole('tree', { name: library.tree.label.replace('{{semester}}', 'Fall 2026') })).toBeVisible();
});

test('takes over a folder, writes the course codes, and opens the semester chosen', async ({ folio }) => {
  test.setTimeout(120_000);
  const { page, libraryDir } = folio;
  if (!libraryDir) throw new Error('This test requires the isolated library-folder fixture');
  for (const course of ['Fall 2026/CSC148 Intro', 'Fall 2026/MAT232 Calculus', 'Winter 2027/STA247 Probability']) {
    await mkdir(path.join(libraryDir, course), { recursive: true });
  }
  await writeFile(path.join(libraryDir, 'Fall 2026', 'CSC148 Intro', 'hw1.py'), 'print(1)\n');
  await writeFile(path.join(libraryDir, 'readme.txt'), 'Top-level file.\n');

  await page.getByRole('button', { name: firstRun.welcome.existing.title }).click();
  await expect(heading(page, firstRun.folder.folders.title)).toBeVisible();
  await expect(page.getByText('2 folders and 1 file at the top level')).toBeVisible();
  await expect(page.getByRole('figure', { name: firstRun.folder.map.label })).toBeVisible();
  await page.getByRole('button', { name: firstRun.folder.folders.submit }).click();

  await expect(heading(page, firstRun.review.title)).toBeVisible();
  await expect(page.locator('.scan-strip__lead')).toHaveText(/^(Read \d+ files?|Folio has read your library)$/);
  const select = page.getByRole('button', { name: /Semester to show first/ });
  await expect(select).toContainText('Fall 2026');
  await expect(page.getByRole('region', { name: 'Courses in Fall 2026 · 2' })).toBeVisible();
  expect(await blockingViolations(page)).toEqual([]);

  await select.click();
  await page.getByRole('option', { name: 'Winter 2027' }).click();
  await expect(page.getByRole('region', { name: 'Courses in Winter 2027 · 1' })).toBeVisible();
  await page.getByRole('textbox', { name: 'Course 1 code' }).fill('STA247');
  await page.getByRole('button', { name: firstRun.review.finish }).click();

  await expect(page.getByRole('tree', { name: library.tree.label.replace('{{semester}}', 'Winter 2027') })).toBeVisible();
  const courses = await invoke<Course[]>(page, 'list_courses', { request: { semester: null } });
  expect(courses.find((course) => course.name === 'STA247 Probability')).toMatchObject({ code: 'STA247', color: 'red' });
  // Nothing was moved or renamed.
  expect(await exists(path.join(libraryDir, 'Fall 2026', 'CSC148 Intro', 'hw1.py'))).toBe(true);
  expect(await exists(path.join(libraryDir, 'readme.txt'))).toBe(true);
});

test('steps appear without rising under reduced motion', async ({ folio }) => {
  const { page } = folio;
  await page.getByRole('button', { name: firstRun.welcome.newLibrary.title }).click();
  await expect(heading(page, firstRun.folder.empty.title)).toBeVisible();
  const step = () => page.evaluate<string>("getComputedStyle(document.querySelector('.step')).animationDuration");
  // The step rises in with motion on (first-run §10), so the check below is not of nothing.
  expect(await step()).not.toBe('0s');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  expect(await step()).toBe('0s');
});

test('says when the library settings are missing, and Try again opens it once they are back', async ({ folio }) => {
  test.setTimeout(120_000);
  const { page, libraryDir } = folio;
  if (!libraryDir) throw new Error('This test requires the isolated library-folder fixture');
  await createLibrary(page);
  await expect(page.getByRole('navigation')).toBeVisible();

  const metadata = path.join(libraryDir, '.folio', 'library.json');
  await rename(metadata, `${metadata}.away`);
  const restarted = await folio.restart();
  await expect(heading(restarted, firstRun.unavailable.notALibrary.title)).toBeFocused();
  // The UI gets the folder as Windows users write it.
  await expect(restarted.getByRole('textbox', { name: firstRun.unavailable.pathLabel })).toHaveValue(await realpath(libraryDir));
  expect(await blockingViolations(restarted)).toEqual([]);

  // Still missing: the screen stays.
  await restarted.getByRole('button', { name: firstRun.unavailable.tryAgain }).click();
  await expect(restarted.getByRole('button', { name: firstRun.unavailable.tryAgain })).toBeVisible();
  await expect(heading(restarted, firstRun.unavailable.notALibrary.title)).toBeVisible();

  await rename(`${metadata}.away`, metadata);
  await restarted.getByRole('button', { name: firstRun.unavailable.tryAgain }).click();
  await expect(restarted.getByRole('navigation')).toBeVisible();
});
