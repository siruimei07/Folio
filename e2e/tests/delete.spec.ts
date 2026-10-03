import { mkdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';

import library from '../../apps/desktop/src/i18n/locales/en/library.json' with { type: 'json' };
import { desktopAllowed, desktopSkipReason, recycledFrom } from '../desktop';
import { exists, expect, openLibrary, test, treeRow } from '../fixtures';

// Deleting on the real shell (library-actions handoff §7.4): Del moves a file to the Recycle Bin
// at once, and a course goes there only after its confirmation, Cancel first. Folio never deletes
// for good, so the Recycle Bin lists both from where they were. It fills the Recycle Bin, so it
// runs on CI, and locally only with FOLIO_E2E_DESKTOP=1 (desktop.ts).

test.skip(!desktopAllowed, desktopSkipReason);
test.use({ libraryFolder: true });

test('Del sends a file to the Recycle Bin, and a course goes there after asking', async ({ folio }) => {
  test.setTimeout(120_000);
  const { page, libraryDir } = folio;
  if (!libraryDir) throw new Error('This test requires the isolated library-folder fixture');
  const semester = path.join(libraryDir, 'Fall 2026');
  await mkdir(path.join(semester, 'MAT232 Calculus'), { recursive: true });
  await writeFile(path.join(semester, 'MAT232 Calculus', 'Delete me.md'), '# Gone\n');
  await mkdir(path.join(semester, 'CSC148 Delete me too'), { recursive: true });
  await writeFile(path.join(semester, 'CSC148 Delete me too', 'hw1.py'), 'print(1)\n');
  await openLibrary(page);
  const row = (name: string) => treeRow(page, name);

  // A file: at once, with a toast.
  await row('MAT232 Calculus').click();
  await row('Delete me.md').click();
  await page.keyboard.press('Delete');
  await expect(page.getByRole('status').filter({ hasText: 'Moved Delete me.md to the Recycle Bin' })).toBeVisible();
  await expect(row('Delete me.md')).toHaveCount(0);
  expect(await exists(path.join(semester, 'MAT232 Calculus', 'Delete me.md'))).toBe(false);

  // A course asks first, with Cancel focused; Esc keeps it.
  await row('CSC148 Delete me too').click();
  await page.keyboard.press('Delete');
  const confirm = page.getByRole('dialog', { name: 'Delete CSC148 Delete me too?' });
  await expect(confirm.getByRole('button', { name: 'Cancel' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(confirm).toBeHidden();
  expect(await exists(path.join(semester, 'CSC148 Delete me too', 'hw1.py'))).toBe(true);
  await page.keyboard.press('Delete');
  await confirm.getByRole('button', { name: library.delete.course.confirm }).click();
  await expect(row('CSC148 Delete me too')).toHaveCount(0);
  expect(await exists(path.join(semester, 'CSC148 Delete me too'))).toBe(false);

  // Both are in the Recycle Bin, from where they were.
  const long = await realpath(semester);
  const [file, course] = await Promise.all([recycledFrom(path.join(long, 'MAT232 Calculus')), recycledFrom(long)]);
  expect(file).toContain('Delete me');
  expect(course).toContain('CSC148 Delete me too');
});
