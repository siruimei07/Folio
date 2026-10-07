import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { crc32 } from 'node:zlib';

import type { Page } from '@playwright/test';

import library from '../../apps/desktop/src/i18n/locales/en/library.json' with { type: 'json' };
import search from '../../apps/desktop/src/i18n/locales/en/search.json' with { type: 'json' };
import type { SearchPage } from '../../apps/desktop/src/ipc/bindings';
import { blockingViolations, expect, invoke, openLibrary, test } from '../fixtures';

// The search dialog on the real shell (app-shell handoff §8, UI architecture §9): Ctrl+K, results
// from the real index in two groups with highlights as text, one- and two-character Chinese
// queries, words inside Markdown and Word files with their snippets, an open search showing a file
// once the hash job has read its text, the arrow keys and Enter revealing the file in the Library,
// Esc, the empty and too-long states, axe and reduced motion.

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
 * path matches; no file's text holds "midterm".
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

/** A ZIP archive of `parts`, stored (not compressed), with ASCII names. */
function storedZip(parts: Record<string, string>): Buffer {
  const files: Buffer[] = [];
  const directory: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(parts)) {
    const content = Buffer.from(text, 'utf8');
    const nameBytes = Buffer.from(name, 'ascii');
    // From "version needed" to the extra field's length, the same in both headers: version 2.0,
    // no flags, stored, 2026-10-06 00:00, the CRC-32 and both sizes, no extra field.
    const fields = Buffer.alloc(26);
    fields.writeUInt16LE(20, 0);
    fields.writeUInt16LE((46 << 9) | (10 << 5) | 6, 8);
    fields.writeUInt32LE(crc32(content), 10);
    fields.writeUInt32LE(content.length, 14);
    fields.writeUInt32LE(content.length, 18);
    fields.writeUInt16LE(nameBytes.length, 22);
    const local = Buffer.alloc(4);
    local.writeUInt32LE(0x04034b50);
    files.push(local, fields, nameBytes, content);
    // Made by version 2.0; no comment, disk 0, no attributes; where the local header starts.
    const central = Buffer.alloc(6);
    central.writeUInt32LE(0x02014b50);
    central.writeUInt16LE(20, 4);
    const tail = Buffer.alloc(14);
    tail.writeUInt32LE(offset, 10);
    directory.push(central, fields, tail, nameBytes);
    offset += local.length + fields.length + nameBytes.length + content.length;
  }
  const listing = Buffer.concat(directory);
  const count = Object.keys(parts).length;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(count, 8);
  end.writeUInt16LE(count, 10);
  end.writeUInt32LE(listing.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...files, listing, end]);
}

/** A Word document with one run of text in each paragraph. */
function docx(paragraphs: string[]): Buffer {
  const body = paragraphs.map((text) => `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`).join('');
  return storedZip({
    '[Content_Types].xml':
      '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    '_rels/.rels':
      '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    'word/document.xml': `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`,
  });
}

test('finds Markdown and Word files by words inside them and marks the words in the snippet', async ({ folio }) => {
  test.setTimeout(120_000);
  const { page, libraryDir } = folio;
  if (!libraryDir) throw new Error('This test requires the isolated library-folder fixture');
  const course = path.join(libraryDir, 'Fall 2026', 'PHY131 Physics');
  await mkdir(course, { recursive: true });
  await writeFile(
    path.join(course, 'Week 3.md'),
    '# Week 3\n\nGaussian elimination finds each eigenvector of a small matrix by hand.\n',
  );
  await writeFile(path.join(course, 'Lab report.docx'), docx(['Lab 2: the simple pendulum', '单摆的周期只与摆长有关。']));
  await openLibrary(page);
  // The hash job extracts the text after hashing; files written just now wait a few seconds first.
  for (const text of ['eigenvector', '摆长']) {
    const request = { text, scope: null, page: { offset: 0, limit: 50 } };
    await expect
      .poll(async () => (await invoke<SearchPage>(page, 'search', { request })).items.length, { timeout: 30_000 })
      .toBe(1);
  }

  await page.keyboard.press('Control+K');
  const dialog = page.getByRole('dialog', { name: search.label });
  const field = dialog.getByRole('textbox', { name: search.label });
  const results = dialog.getByRole('listbox', { name: search.results });
  const contents = results.getByRole('group').filter({ hasText: search.groups.contents });
  const queries: [string, string][] = [
    ['eigenvector', 'Week 3.md'],
    ['pendulum', 'Lab report.docx'],
    ['摆长', 'Lab report.docx'],
  ];
  for (const [text, name] of queries) {
    await field.fill(text);
    await expect(results.getByRole('option')).toHaveCount(1);
    // Only the text matched: a Contents hit, its name unmarked and the word marked in its snippet.
    const hit = contents.getByRole('option', { name });
    await expect(hit.locator('.search-hit__name mark')).toHaveCount(0);
    await expect(hit.locator('.search-hit__snippet mark')).toHaveText(text);
  }
});

test('shows a file in an open search once its text is read, without the search typed again', async ({ folio }) => {
  test.setTimeout(120_000);
  const { page, libraryDir } = folio;
  if (!libraryDir) throw new Error('This test requires the isolated library-folder fixture');
  await seed(libraryDir);
  await openSearchable(page, 'midterm');

  await page.keyboard.press('Control+K');
  const dialog = page.getByRole('dialog', { name: search.label });
  const field = dialog.getByRole('textbox', { name: search.label });
  await page.keyboard.type('eigenvalue');
  await expect(dialog.getByRole('heading', { name: search.empty.title.replace('{{text}}', 'eigenvalue') })).toBeVisible();

  // Written outside Folio while the dialog is open. The scan that adds it refetches the search,
  // which its name does not match; a few seconds later the hash job reads its text, and that
  // CatalogChanged lists no entry but says `bodies` (ipc-m1 §15.1), which refetches every search.
  await writeFile(
    path.join(libraryDir, 'Fall 2026', COURSE, 'Week 4.md'),
    '# Week 4\n\nEach eigenvalue of a triangular matrix sits on its diagonal.\n',
  );
  const results = dialog.getByRole('listbox', { name: search.results });
  const hit = results
    .getByRole('group')
    .filter({ hasText: search.groups.contents })
    .getByRole('option', { name: 'Week 4.md' });
  await expect(hit).toBeVisible({ timeout: 30_000 });
  await expect(hit.locator('.search-hit__name mark')).toHaveCount(0);
  await expect(hit.locator('.search-hit__snippet mark')).toHaveText('eigenvalue');
  await expect(results.getByRole('option')).toHaveCount(1);
  await expect(field).toHaveValue('eigenvalue');
  await expect(field).toBeFocused();
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
