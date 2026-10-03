import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import imports from '../../apps/desktop/src/i18n/locales/en/import.json' with { type: 'json' };
import library from '../../apps/desktop/src/i18n/locales/en/library.json' with { type: 'json' };
import { desktopAllowed, desktopSkipReason, nativeDrop, recycledFrom } from '../desktop';
import { answerImportPicker, expect, openLibrary, test, treeRow } from '../fixtures';

// Adding files on the real shell, the parts that reach the Windows desktop (library-actions
// handoff §3–§5): a file and a folder dragged from outside the app onto a folder row, with
// Windows' own drag and drop, and the originals moved to the Recycle Bin once everything is
// copied. The drop moves the pointer and recycling fills the Recycle Bin, so these run on CI, and
// locally only with FOLIO_E2E_DESKTOP=1 (desktop.ts).

test.skip(!desktopAllowed, desktopSkipReason);
test.use({ libraryFolder: true });

const COURSE = 'MAT232 Calculus';

test('a file and a folder dragged onto a folder row are added to that folder', async ({ folio }) => {
  test.setTimeout(120_000);
  const { page, processId, libraryDir } = folio;
  if (!libraryDir) throw new Error('This test requires the isolated library-folder fixture');
  const course = path.join(libraryDir, 'Fall 2026', COURSE);
  await mkdir(path.join(course, 'Problem sets'), { recursive: true });
  await writeFile(path.join(course, 'Problem sets', 'ps1.pdf'), '%PDF-1.4\n');
  const sources = await mkdtemp(path.join(tmpdir(), 'folio-drop-'));
  try {
    await writeFile(path.join(sources, 'ps2.pdf'), '%PDF-1.4\n% ps2\n');
    await mkdir(path.join(sources, 'Week 8'));
    await writeFile(path.join(sources, 'Week 8', 'notes.md'), '# Week 8\n');
    await openLibrary(page);
    await treeRow(page, COURSE).click();
    const folder = treeRow(page, 'Problem sets');
    const box = await folder.boundingBox();
    if (!box) throw new Error('The folder row has no box');

    const [dropped, hovered] = await Promise.allSettled([
      nativeDrop(processId, [path.join(sources, 'ps2.pdf'), path.join(sources, 'Week 8')], {
        x: box.x + box.width / 2,
        y: box.y + box.height / 2,
      }),
      // While the files hover, the row says that they go there.
      expect(folder).toContainText(library.tree.addHere, { timeout: 10_000 }),
    ]);
    if (dropped.status === 'rejected') throw dropped.reason;
    test.skip(dropped.value.result === 'no input desktop', 'This session has no input desktop to drag on');
    expect(dropped.value).toMatchObject({ result: 'dropped' });
    if (hovered.status === 'rejected') throw hovered.reason;

    const dialog = page.getByRole('dialog', { name: `Add files to ${COURSE} / Problem sets` });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('list', { name: imports.dialog.items }).getByRole('listitem')).toHaveCount(2);
    await dialog.getByRole('button', { name: 'Add 2 files' }).click();
    await expect(page.getByRole('status').filter({ hasText: `Added 2 files to ${COURSE} / Problem sets` })).toBeVisible();
    expect(await readFile(path.join(course, 'Problem sets', 'ps2.pdf'), 'utf8')).toBe('%PDF-1.4\n% ps2\n');
    expect(await readFile(path.join(course, 'Problem sets', 'Week 8', 'notes.md'), 'utf8')).toBe('# Week 8\n');
    // The originals stay where they were.
    expect((await readdir(sources)).sort()).toEqual(['Week 8', 'ps2.pdf']);
  } finally {
    await rm(sources, { recursive: true, force: true });
  }
});

test.describe('the originals', () => {
  let sources = '';
  const NAMES = ['Recycle me 1.txt', 'Recycle me 2.txt'];

  test.beforeAll(async () => {
    // The long path: the Recycle Bin records where items came from that way.
    sources = await realpath(await mkdtemp(path.join(tmpdir(), 'folio-recycle-')));
    for (const name of NAMES) await writeFile(path.join(sources, name), `${name}\n`);
    answerImportPicker(NAMES.map((name) => path.join(sources, name)));
  });

  test.afterAll(async () => {
    answerImportPicker(null);
    if (sources) await rm(sources, { recursive: true, force: true });
  });

  test('go to the Recycle Bin once everything is copied', async ({ folio }) => {
    test.setTimeout(120_000);
    const { page, libraryDir } = folio;
    if (!libraryDir) throw new Error('This test requires the isolated library-folder fixture');
    const course = path.join(libraryDir, 'Fall 2026', COURSE);
    await mkdir(course, { recursive: true });
    await openLibrary(page);

    await page.getByRole('treeitem', { name: new RegExp(`^${COURSE}`) }).click();
    await page.keyboard.press('Control+O');
    const dialog = page.getByRole('dialog', { name: `Add files to ${COURSE}` });
    const originals = dialog.getByRole('checkbox', { name: imports.dialog.originals });
    await expect(originals).not.toBeChecked();
    // The 24 px hit area covers the visually hidden input; a click on the label checks it.
    await dialog.getByText(imports.dialog.originals, { exact: true }).click();
    await expect(originals).toBeChecked();
    await dialog.getByRole('button', { name: 'Add 2 files' }).click();

    const result = page.getByRole('status').filter({ hasText: `Added 2 files to ${COURSE}` });
    await expect(result).toContainText('originals moved to the Recycle Bin');
    for (const name of NAMES) expect(await readFile(path.join(course, name), 'utf8')).toBe(`${name}\n`);
    expect(await readdir(sources)).toEqual([]);
    expect((await recycledFrom(sources)).sort()).toEqual(NAMES.map((name) => path.parse(name).name));
  });
});
