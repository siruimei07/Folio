import { access, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';

import library from '../../apps/desktop/src/i18n/locales/en/library.json' with { type: 'json' };
import type { FolderChoice, Job, LibraryOpened } from '../../apps/desktop/src/ipc/bindings';
import { expect, test } from '../fixtures';

// The Library view on the real shell (app-shell handoff §5; library-actions §6, §7): a folder the
// user already has becomes the library, then the tree, the grid, rename, a new folder, Move to…,
// Tags ▸ and the tag filter work on the real files. Nothing is deleted: the Recycle Bin is the
// user's own. Strings run in the page because this package has no DOM types.

test.use({ libraryFolder: true });

const COURSE = 'MAT232 Calculus';

function invoke<T>(page: Page, command: string, args: Record<string, unknown> = {}): Promise<T> {
  return page.evaluate<T>(`window.__TAURI_INTERNALS__.invoke(${JSON.stringify(command)}, ${JSON.stringify(args)})`);
}

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

/** Takes over `root` as the library and waits for its first scan. */
async function takeOver(page: Page): Promise<void> {
  const choice = await invoke<FolderChoice | null>(page, 'pick_library_folder');
  if (!choice) throw new Error('The isolated folder choice was cancelled');
  expect(choice.content.kind).toBe('folders');
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
}

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

  await takeOver(page);

  const tree = page.getByRole('tree', { name: library.tree.label.replace('{{semester}}', 'Fall 2026') });
  const row = (name: string) => tree.getByRole('treeitem', { name: new RegExp(`^${name.replace(/[.()]/g, '\\$&')}`) });
  await expect(row(COURSE)).toBeVisible();
  await expect(row('CSC148')).toBeVisible();

  // A click expands the course and shows its grid.
  await row(COURSE).click();
  await expect(row('Lectures')).toBeVisible();
  const pane = page.getByRole('region', { name: library.pane.label });
  await expect(pane.getByRole('grid', { name: `Files in ${COURSE}` })).toBeVisible();

  // F2 renames in place; Enter commits on disk.
  await row('notes.md').click();
  await page.keyboard.press('F2');
  const field = page.getByRole('textbox', { name: 'New name for notes.md' });
  await expect(field).toBeFocused();
  await page.keyboard.type('week 1');
  await page.keyboard.press('Enter');
  await expect(row('week 1.md')).toBeVisible();
  await expect.poll(() => exists(path.join(course, 'week 1.md'))).toBe(true);
  await expect(row('week 1.md')).toBeFocused();

  // The menu opens from the keyboard, and Esc gives focus back to the row.
  await page.keyboard.press('Shift+F10');
  await expect(page.getByRole('menuitem', { name: library.menu.open })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(row('week 1.md')).toBeFocused();

  // Ctrl+Shift+N makes a folder in the course: Left goes from the file to its course first.
  await page.keyboard.press('ArrowLeft');
  await expect(row(COURSE)).toBeFocused();
  await page.keyboard.press('Control+Shift+N');
  const folderField = page.getByRole('textbox', { name: library.tree.newFolder });
  await expect(folderField).toHaveValue('New folder');
  await folderField.fill('Problem sets');
  await page.keyboard.press('Enter');
  await expect(row('Problem sets')).toBeVisible();
  await expect.poll(() => exists(path.join(course, 'Problem sets'))).toBe(true);

  // Move to… through the folder picker.
  await row('week 1.md').click({ button: 'right' });
  await page.getByRole('menuitem', { name: library.menu.moveTo }).click();
  const dialog = page.getByRole('dialog', { name: 'Move week 1.md' });
  await dialog.getByRole('treeitem', { name: 'Problem sets' }).click();
  await dialog.getByRole('button', { name: library.move.confirm }).click();
  await expect.poll(() => exists(path.join(course, 'Problem sets', 'week 1.md'))).toBe(true);
  await expect(page.getByRole('status').filter({ hasText: `Moved week 1.md to ${COURSE} / Problem sets` })).toBeVisible();

  // Tags ▸ tags the file at once; the filter then shows only it.
  await row('Problem sets').click();
  await row('week 1.md').click({ button: 'right' });
  await page.getByRole('menuitem', { name: library.menu.tags }).click();
  await page.getByRole('menuitemcheckbox', { name: 'Notes' }).click();
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await expect(row('week 1.md, tags Notes')).toBeVisible();
  await page.getByRole('group', { name: library.filter.label }).getByRole('button', { name: 'Notes' }).click();
  await expect(tree.getByRole('treeitem', { name: /\.(md|py|pdf)/ })).toHaveCount(1);
  await expect(row(COURSE)).toHaveAccessibleName(`${COURSE}, 1 file`);

  const { violations } = await new AxeBuilder({ page }).analyze();
  const blocking = violations.filter(({ impact }) => impact === 'serious' || impact === 'critical');
  expect(blocking.map(({ id, nodes }) => `${id}: ${nodes.map(({ target }) => target.join(' ')).join(', ')}`)).toEqual([]);
});

test('keeps rows and tiles still under reduced motion', async ({ folio }) => {
  const { page, libraryDir } = folio;
  if (!libraryDir) throw new Error('This test requires the isolated library-folder fixture');
  await mkdir(path.join(libraryDir, 'Fall 2026', 'CSC148'), { recursive: true });
  await writeFile(path.join(libraryDir, 'Fall 2026', 'CSC148', 'hw1.py'), 'print(1)\n');
  await takeOver(page);
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
