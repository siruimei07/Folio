import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import library from '../../apps/desktop/src/i18n/locales/en/library.json' with { type: 'json' };
import type { Course, EntryRow, Page as EntryPage } from '../../apps/desktop/src/ipc/bindings';
import { blockingViolations, exists, expect, invoke, libraryTree, openLibrary, test, treeRow } from '../fixtures';

// The Library view on the real shell (app-shell handoff §5; library-actions §6, §7): a folder the
// user already has becomes the library, then the tree, the grid, rename, a new folder, Move to…,
// dragging rows onto a folder, Tags ▸ and the tag filter work on the real files; the semester
// switcher and the quick views. Nothing is deleted: the Recycle Bin is the user's own. Strings run
// in the page because this package has no DOM types.

test.use({ libraryFolder: true });

const COURSE = 'MAT232 Calculus';

test('browses, renames, makes a folder, moves and tags real files, and passes axe', async ({ folio }) => {
  test.setTimeout(120_000);
  const { page, libraryDir } = folio;
  if (!libraryDir) throw new Error('This test requires the isolated library-folder fixture');
  const course = path.join(libraryDir, 'Fall 2026', COURSE);
  await mkdir(path.join(course, 'Lectures'), { recursive: true });
  await writeFile(path.join(course, 'Lectures', 'Lecture 1.pdf'), '%PDF-1.4\n');
  await writeFile(path.join(course, 'notes.md'), '# Week 1\n');
  await mkdir(path.join(libraryDir, 'Fall 2026', 'CSC148'), { recursive: true });
  await writeFile(path.join(libraryDir, 'Fall 2026', 'CSC148', 'hw1.py'), 'print(1)\n');

  await openLibrary(page);

  await expect(treeRow(page, COURSE)).toBeVisible();
  await expect(treeRow(page, 'CSC148')).toBeVisible();

  // A click expands the course and shows its grid.
  await treeRow(page, COURSE).click();
  await expect(treeRow(page, 'Lectures')).toBeVisible();
  const pane = page.getByRole('region', { name: library.pane.label });
  await expect(pane.getByRole('grid', { name: `Files in ${COURSE}` })).toBeVisible();

  // F2 renames in place; Enter commits on disk.
  await treeRow(page, 'notes.md').click();
  await page.keyboard.press('F2');
  const field = page.getByRole('textbox', { name: 'New name for notes.md' });
  await expect(field).toBeFocused();
  await page.keyboard.type('week 1');
  await page.keyboard.press('Enter');
  await expect(treeRow(page, 'week 1.md')).toBeVisible();
  await expect.poll(() => exists(path.join(course, 'week 1.md'))).toBe(true);
  await expect(treeRow(page, 'week 1.md')).toBeFocused();

  // The menu opens from the keyboard, and Esc gives focus back to the row.
  await page.keyboard.press('Shift+F10');
  await expect(page.getByRole('menuitem', { name: library.menu.open })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(treeRow(page, 'week 1.md')).toBeFocused();

  // Ctrl+Shift+N makes a folder in the course: Left goes from the file to its course first.
  await page.keyboard.press('ArrowLeft');
  await expect(treeRow(page, COURSE)).toBeFocused();
  await page.keyboard.press('Control+Shift+N');
  const folderField = page.getByRole('textbox', { name: library.tree.newFolder });
  await expect(folderField).toHaveValue('New folder');
  await folderField.fill('Problem sets');
  await page.keyboard.press('Enter');
  await expect(treeRow(page, 'Problem sets')).toBeVisible();
  await expect.poll(() => exists(path.join(course, 'Problem sets'))).toBe(true);

  // Move to… through the folder picker.
  await treeRow(page, 'week 1.md').click({ button: 'right' });
  await page.getByRole('menuitem', { name: library.menu.moveTo }).click();
  const dialog = page.getByRole('dialog', { name: 'Move week 1.md' });
  await dialog.getByRole('treeitem', { name: 'Problem sets' }).click();
  await dialog.getByRole('button', { name: library.move.confirm }).click();
  await expect.poll(() => exists(path.join(course, 'Problem sets', 'week 1.md'))).toBe(true);
  await expect(page.getByRole('status').filter({ hasText: `Moved week 1.md to ${COURSE} / Problem sets` })).toBeVisible();

  // Tags ▸ tags the file at once; the filter then shows only it.
  await treeRow(page, 'Problem sets').click();
  await treeRow(page, 'week 1.md').click({ button: 'right' });
  await page.getByRole('menuitem', { name: library.menu.tags }).click();
  await page.getByRole('menuitemcheckbox', { name: 'Notes' }).click();
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await expect(treeRow(page, 'week 1.md, tags Notes')).toBeVisible();
  await page.getByRole('group', { name: library.filter.label }).getByRole('button', { name: 'Notes' }).click();
  await expect(libraryTree(page).getByRole('treeitem', { name: /\.(md|py|pdf)/ })).toHaveCount(1);
  await expect(treeRow(page, COURSE)).toHaveAccessibleName(`${COURSE}, 1 file`);

  expect(await blockingViolations(page)).toEqual([]);
});

test('drags a file onto a folder row to move it', async ({ folio }) => {
  test.setTimeout(120_000);
  const { page, libraryDir } = folio;
  if (!libraryDir) throw new Error('This test requires the isolated library-folder fixture');
  const course = path.join(libraryDir, 'Fall 2026', COURSE);
  await mkdir(path.join(course, 'Lectures'), { recursive: true });
  await writeFile(path.join(course, 'Lectures', 'Lecture 1.pdf'), '%PDF-1.4\n');
  await writeFile(path.join(course, 'notes.md'), '# Week 1\n');
  await openLibrary(page);
  await treeRow(page, COURSE).click();

  // Pointer events, past the 4 px threshold, then over the folder (library-actions §7.3).
  const from = await treeRow(page, 'notes.md').boundingBox();
  const to = await treeRow(page, 'Lectures').boundingBox();
  if (!from || !to) throw new Error('The rows have no box');
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + from.width / 2 + 12, from.y + from.height / 2 + 2, { steps: 4 });
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 8 });
  await expect(treeRow(page, 'Lectures')).toContainText(library.tree.moveHere);
  await page.mouse.up();

  await expect.poll(() => exists(path.join(course, 'Lectures', 'notes.md'))).toBe(true);
  expect(await exists(path.join(course, 'notes.md'))).toBe(false);
  await expect(page.getByRole('status').filter({ hasText: `Moved notes.md to ${COURSE} / Lectures` })).toBeVisible();
});

test('switches semesters from the toolbar, and the quick views list recent and untagged files', async ({ folio }) => {
  test.setTimeout(120_000);
  const { page, libraryDir } = folio;
  if (!libraryDir) throw new Error('This test requires the isolated library-folder fixture');
  await mkdir(path.join(libraryDir, 'Fall 2026', COURSE), { recursive: true });
  await writeFile(path.join(libraryDir, 'Fall 2026', COURSE, 'notes.md'), '# Week 1\n');
  await mkdir(path.join(libraryDir, 'Winter 2027', 'STA247 Probability'), { recursive: true });
  await writeFile(path.join(libraryDir, 'Winter 2027', 'STA247 Probability', 'ch1.pdf'), '%PDF-1.4\n');
  await openLibrary(page);

  // Whichever semester shows first, the menu switches to the other.
  const switcher = page.getByRole('button', { name: /^Switch semester, current / });
  const first = (await switcher.getAttribute('aria-label'))?.includes('Fall 2026') ? 'Fall 2026' : 'Winter 2027';
  const other = first === 'Fall 2026' ? 'Winter 2027' : 'Fall 2026';
  await expect(libraryTree(page, first)).toBeVisible();
  await switcher.click();
  await page.getByRole('menuitemradio', { name: other }).click();
  await expect(libraryTree(page, other)).toBeVisible();
  await expect(page.getByRole('button', { name: `Switch semester, current ${other}` })).toBeVisible();
  const otherCourse = other === 'Fall 2026' ? COURSE : 'STA247 Probability';
  await expect(treeRow(page, otherCourse, other)).toBeVisible();

  // The quick views list the current semester's files only (workspace-history §12.2, 34A).
  const pane = page.getByRole('region', { name: library.pane.label });
  const otherFile = other === 'Fall 2026' ? 'notes.md' : 'ch1.pdf';
  await treeRow(page, library.tree.quick.recent, other).click();
  const recent = pane.getByRole('grid', { name: library.tree.quick.recent });
  await expect(recent.getByRole('gridcell')).toHaveCount(1);
  await treeRow(page, library.tree.quick.untagged, other).click();
  const untagged = pane.getByRole('grid', { name: library.tree.quick.untagged });
  await expect(untagged.getByRole('gridcell')).toHaveCount(1);
  await expect(untagged.getByRole('gridcell', { name: otherFile })).toBeVisible();

  // A tag takes the file out of Untagged, which then says the semester is all tagged.
  const courses = await invoke<Course[]>(page, 'list_courses', {
    request: { semester: null },
  });
  const course = courses.find((candidate) => candidate.name === (other === 'Fall 2026' ? COURSE : 'STA247 Probability'));
  if (!course) throw new Error(`No course in ${other}`);
  const files = await invoke<EntryPage<EntryRow>>(page, 'list_children', {
    request: { folder: course.folder, page: { offset: 0, limit: 50 }, sort: { key: 'name', descending: false } },
  });
  const file = files.items.find((item) => item.name === otherFile);
  if (!file) throw new Error(`No ${otherFile}`);
  await invoke(page, 'set_entry_tags', {
    request: { entries: [{ id: file.id, path: file.path }], add: ['slides'], remove: [] },
  });
  await expect(pane.getByRole('heading', { name: library.pane.untaggedEmpty.title.replace('{{semester}}', other) })).toBeVisible();
});

test('keeps rows and tiles still under reduced motion', async ({ folio }) => {
  const { page, libraryDir } = folio;
  if (!libraryDir) throw new Error('This test requires the isolated library-folder fixture');
  await mkdir(path.join(libraryDir, 'Fall 2026', 'CSC148'), { recursive: true });
  await writeFile(path.join(libraryDir, 'Fall 2026', 'CSC148', 'hw1.py'), 'print(1)\n');
  await openLibrary(page);
  await page.getByRole('treeitem', { name: /^CSC148/ }).click();
  await expect(page.getByRole('gridcell', { name: /^hw1\.py/ })).toBeVisible();
  const durations = async () =>
    new Set(
      await page.evaluate<string[]>(
        `[...document.querySelectorAll('.tree-row, .entry-tile')].map((element) => getComputedStyle(element).transitionDuration)`,
      ),
    );
  // Rows and tiles move with motion on, so the check below is not of nothing.
  expect(await durations()).not.toEqual(new Set(['0s']));
  await page.emulateMedia({ reducedMotion: 'reduce' });
  expect(await durations()).toEqual(new Set(['0s']));
});
