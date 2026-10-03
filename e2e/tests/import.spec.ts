import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';

import imports from '../../apps/desktop/src/i18n/locales/en/import.json' with { type: 'json' };
import type { EntryRow, FolderChoice, Job, LibraryOpened, Page as EntryPage } from '../../apps/desktop/src/ipc/bindings';
import { expect, invoke, test } from '../fixtures';

// Adding files on the real shell (library-actions handoff §4, §5): "Add files" (Ctrl+O) with the
// debug build's picker override (FOLIO_TEST_IMPORT_FILES, read when the app starts), the import
// dialog with its check, a tag and the one clash choice, the progress toast turning into the
// result, the copied files on disk with their tags, and the originals left where they were. The
// originals are never recycled here: the Recycle Bin is the user's own.

test.use({ libraryFolder: true });

const COURSE = 'MAT232 Calculus';
let sources = '';
const previousPicker = process.env.FOLIO_TEST_IMPORT_FILES;

test.beforeAll(async () => {
  sources = await mkdtemp(path.join(tmpdir(), 'folio-import-ui-'));
  await writeFile(path.join(sources, 'Lecture 7 notes.md'), '# Lagrange multipliers\n');
  await writeFile(path.join(sources, 'Formula sheet.pdf'), '%PDF-1.4\n');
  await mkdir(path.join(sources, 'Week 7'));
  await writeFile(path.join(sources, 'Week 7', 'Problem 2.pdf'), '%PDF-1.4\n');
  // Windows' path-list format, as the shell splits it.
  process.env.FOLIO_TEST_IMPORT_FILES = ['Lecture 7 notes.md', 'Formula sheet.pdf', 'Week 7']
    .map((name) => path.join(sources, name))
    .join(';');
});

test.afterAll(async () => {
  if (previousPicker === undefined) delete process.env.FOLIO_TEST_IMPORT_FILES;
  else process.env.FOLIO_TEST_IMPORT_FILES = previousPicker;
  if (sources) await rm(sources, { recursive: true, force: true });
});

/** Takes over the library folder and waits for its first scan. */
async function takeOver(page: Page): Promise<void> {
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
}

test('adds files with a tag and one clash choice, shows progress and the result, and passes axe', async ({ folio }) => {
  test.setTimeout(120_000);
  const { page, libraryDir } = folio;
  if (!libraryDir) throw new Error('This test requires the isolated library-folder fixture');
  const course = path.join(libraryDir, 'Fall 2026', COURSE);
  await mkdir(course, { recursive: true });
  await writeFile(path.join(course, 'Lecture 7 notes.md'), '# Already here\n');
  await takeOver(page);

  await page.getByRole('treeitem', { name: new RegExp(`^${COURSE}`) }).click();
  await page.keyboard.press('Control+O');
  const dialog = page.getByRole('dialog', { name: `Add files to ${COURSE}` });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('list', { name: imports.dialog.items }).getByRole('listitem')).toHaveCount(3);
  await expect(dialog.getByText('3 files in 1 folder · ', { exact: false })).toBeVisible();
  const clashes = dialog.getByRole('group', { name: `A name is already taken in ${COURSE}.` });
  await expect(clashes.getByText('Lecture 7 notes.md')).toBeVisible();
  await expect(clashes.getByRole('radio', { name: imports.clashes.keepBoth })).toBeChecked();
  await dialog.getByRole('button', { name: 'Notes' }).click();
  await expect(dialog.getByRole('button', { name: 'Notes' })).toHaveAttribute('aria-pressed', 'true');

  const { violations } = await new AxeBuilder({ page }).include('.modal').analyze();
  const blocking = violations.filter(({ impact }) => impact === 'serious' || impact === 'critical');
  expect(blocking.map(({ id, nodes }) => `${id}: ${nodes.map(({ target }) => target.join(' ')).join(', ')}`)).toEqual([]);

  await dialog.getByRole('button', { name: 'Add 3 files' }).click();
  await expect(dialog).toBeHidden();
  const result = page.getByRole('status').filter({ hasText: `Added 3 files to ${COURSE}` });
  await expect(result).toBeVisible();
  await expect(result).toContainText('1 kept as a copy');
  await expect(page.getByRole('button', { name: /^Activity: / })).toBeVisible();

  expect(await readFile(path.join(course, 'Lecture 7 notes (2).md'), 'utf8')).toBe('# Lagrange multipliers\n');
  expect(await readFile(path.join(course, 'Lecture 7 notes.md'), 'utf8')).toBe('# Already here\n');
  expect(await readFile(path.join(course, 'Week 7', 'Problem 2.pdf'), 'utf8')).toBe('%PDF-1.4\n');
  // The originals stay where they were.
  expect(await readFile(path.join(sources, 'Formula sheet.pdf'), 'utf8')).toBe('%PDF-1.4\n');

  const courseRef = await page.evaluate<{ id: string; path: string }>(`(async () => {
    const courses = await window.__TAURI_INTERNALS__.invoke('list_courses', { request: { semester: null } });
    return courses.find((course) => course.name === ${JSON.stringify(COURSE)}).folder;
  })()`);
  const children = await invoke<EntryPage<EntryRow>>(page, 'list_children', {
    request: { folder: courseRef, page: { offset: 0, limit: 50 }, sort: { key: 'name', descending: false } },
  });
  const tagsOf = (name: string) => children.items.find((item) => item.name === name)?.tags;
  expect(tagsOf('Lecture 7 notes (2).md')).toEqual(['notes']);
  expect(tagsOf('Week 7')).toEqual(['notes']);
  expect(tagsOf('Lecture 7 notes.md')).toEqual([]);

  // "Show" selects the course in the tree.
  await result.getByRole('button', { name: imports.progress.show }).click();
  await expect(page.getByRole('treeitem', { name: new RegExp(`^${COURSE}`) })).toHaveAttribute('aria-selected', 'true');
});

test('keeps the import dialog and the drop target still under reduced motion', async ({ folio }) => {
  const { page, libraryDir } = folio;
  if (!libraryDir) throw new Error('This test requires the isolated library-folder fixture');
  await mkdir(path.join(libraryDir, 'Fall 2026', COURSE), { recursive: true });
  await takeOver(page);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.getByRole('treeitem', { name: new RegExp(`^${COURSE}`) }).click();
  await page.keyboard.press('Control+O');
  await expect(page.getByRole('dialog', { name: `Add files to ${COURSE}` })).toBeVisible();
  const timing = await page.evaluate<string[]>(`[
    getComputedStyle(document.querySelector('.modal')).animationDuration,
    getComputedStyle(document.querySelector('.drop-panel')).transitionDuration,
  ]`);
  expect(timing.map((value) => value.split(', ').every((part) => part === '0s'))).toEqual([true, true]);
});
