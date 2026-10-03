import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import imports from '../../apps/desktop/src/i18n/locales/en/import.json' with { type: 'json' };
import shell from '../../apps/desktop/src/i18n/locales/en/shell.json' with { type: 'json' };
import type { EntryRow, Page as EntryPage } from '../../apps/desktop/src/ipc/bindings';
import { answerImportPicker, blockingViolations, expect, invoke, openLibrary, test } from '../fixtures';

// Adding files on the real shell (library-actions handoff §4, §5): "Add files" (Ctrl+O) with the
// debug build's picker override (FOLIO_TEST_IMPORT_FILES, read when the app starts), the import
// dialog with its check, a tag and the one clash choice, the progress toast turning into the
// result, the copied files on disk with their tags, and the originals left where they were; and an
// import cancelled from its toast. The originals are never recycled here: the Recycle Bin is the
// user's own.

test.use({ libraryFolder: true });

const COURSE = 'MAT232 Calculus';
let sources = '';

test.beforeAll(async () => {
  sources = await mkdtemp(path.join(tmpdir(), 'folio-import-ui-'));
});

test.afterAll(async () => {
  answerImportPicker(null);
  if (sources) await rm(sources, { recursive: true, force: true });
});

/** Answers the file picker of the apps started from now on with these sources. */
function pick(...names: string[]): void {
  answerImportPicker(names.map((name) => path.join(sources, name)));
}

test.describe('adding files', () => {
  test.beforeAll(async () => {
    await writeFile(path.join(sources, 'Lecture 7 notes.md'), '# Lagrange multipliers\n');
    await writeFile(path.join(sources, 'Formula sheet.pdf'), '%PDF-1.4\n');
    await mkdir(path.join(sources, 'Week 7'));
    await writeFile(path.join(sources, 'Week 7', 'Problem 2.pdf'), '%PDF-1.4\n');
    pick('Lecture 7 notes.md', 'Formula sheet.pdf', 'Week 7');
  });

  test('adds files with a tag and one clash choice, shows progress and the result, and passes axe', async ({ folio }) => {
    test.setTimeout(120_000);
    const { page, libraryDir } = folio;
    if (!libraryDir) throw new Error('This test requires the isolated library-folder fixture');
    const course = path.join(libraryDir, 'Fall 2026', COURSE);
    await mkdir(course, { recursive: true });
    await writeFile(path.join(course, 'Lecture 7 notes.md'), '# Already here\n');
    await openLibrary(page);

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

    expect(await blockingViolations(page, '.modal')).toEqual([]);

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
    await openLibrary(page);
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
});

test.describe('a cancelled import', () => {
  /** Enough files that the import still runs when Cancel is pressed: 1,000 of 64 KB. */
  const FOLDERS = 20;
  const FILES = 50;
  const SIZE = 64 * 1024;

  test.beforeAll(async () => {
    const bytes = Buffer.alloc(SIZE, 'x');
    for (let folder = 1; folder <= FOLDERS; folder++) {
      const week = path.join(sources, 'Term', `Week ${String(folder)}`);
      await mkdir(week, { recursive: true });
      await Promise.all(
        Array.from({ length: FILES }, (_, file) => writeFile(path.join(week, `Scan ${String(file + 1)}.txt`), bytes)),
      );
    }
    pick('Term');
  });

  test('stops at a safe point, keeps what it copied and every original, and says how far it got', async ({ folio }) => {
    test.setTimeout(180_000);
    const { page, libraryDir } = folio;
    if (!libraryDir) throw new Error('This test requires the isolated library-folder fixture');
    const course = path.join(libraryDir, 'Fall 2026', COURSE);
    await mkdir(course, { recursive: true });
    await openLibrary(page);

    await page.getByRole('treeitem', { name: new RegExp(`^${COURSE}`) }).click();
    await page.keyboard.press('Control+O');
    const total = FOLDERS * FILES;
    await page
      .getByRole('dialog', { name: `Add files to ${COURSE}` })
      .getByRole('button', { name: `Add ${total.toLocaleString('en')} files` })
      .click();
    // A progress toast speaks only its title; Cancel sits beside it in the toast.
    await expect(page.getByRole('status').filter({ hasText: `Adding ${String(total)} files to ${COURSE}` })).toBeVisible();
    await page
      .getByRole('region', { name: shell.notifications })
      .getByRole('button', { name: imports.progress.cancel })
      .click();

    const stopped = page.getByRole('status').filter({ hasText: `Stopped adding files to ${COURSE}` });
    await expect(stopped).toBeVisible({ timeout: 60_000 });
    const text = (await stopped.textContent()) ?? '';
    const match = /([\d,]+) of ([\d,]+) (?:was|were) added before you stopped\./.exec(text);
    if (!match?.[1] || !match[2]) throw new Error(`Unexpected result: ${text}`);
    const added = Number(match[1].replaceAll(',', ''));
    test.info().annotations.push({ type: 'added before Cancel', description: `${String(added)} of ${String(total)}` });
    expect(Number(match[2].replaceAll(',', ''))).toBe(total);
    expect(added).toBeLessThan(total);

    // What it copied stays, each file whole; every original stays where it was.
    const filesIn = async (folder: string) =>
      (await readdir(folder, { recursive: true, withFileTypes: true }).catch(() => []))
        .filter((entry) => entry.isFile())
        .map((entry) => path.join(entry.parentPath, entry.name));
    const copied = await filesIn(path.join(course, 'Term'));
    expect(copied).toHaveLength(added);
    expect(new Set(await Promise.all(copied.map(async (file) => (await stat(file)).size)))).toEqual(
      new Set(added > 0 ? [SIZE] : []),
    );
    expect(await filesIn(path.join(sources, 'Term'))).toHaveLength(total);
  });
});
