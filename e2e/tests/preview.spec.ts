import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { FrameLocator, Locator, Page } from '@playwright/test';

import preview from '../../apps/desktop/src/i18n/locales/en/preview.json' with { type: 'json' };
import { blockingViolations, expect, openLibrary, test, treeRow } from '../fixtures';
import { pdf, png, SRGB_PROFILE, wav } from '../preview-samples';

// The preview pane on the real shell (app-shell handoff §5; UI architecture §10), one flow per
// renderer family: a note with maths, code and images next to it; text and code; PDF with the
// page pill, links and the worker; images and audio; the cards. Nothing is opened in another app:
// "Open with default app" and "Show in File Explorer" would start Windows programs. Strings run in
// the page because this package has no DOM types.

test.use({ libraryFolder: true });

const COURSE = 'MAT232 Calculus';

const NOTE = `# Week 1: vectors

Inline maths $\\nabla f = (f_x, f_y)$ and a display formula:

$$
\\begin{aligned} \\mathbb{R}^n &= \\{ (x_1, \\dots, x_n) \\} \\\\ A &= \\begin{pmatrix} 1 & 2 \\\\ 3 & 4 \\end{pmatrix} \\end{aligned}
$$

\`\`\`python
def norm(v):
    return sum(x * x for x in v) ** 0.5
\`\`\`

| Term | Meaning |
| --- | --- |
| span | all combinations |

![Unit circle](figure.png) ![Missing](nope.png) ![Web](https://example.com/web.png)

See the [syllabus](https://example.com/syllabus) or [the maths](#week-1-vectors).

<img src="x" onerror="document.title = 'ran'"><script>document.title = 'ran'</script>
`;

/** Puts `files` into the course, takes the folder over as the library and waits for its scan. */
async function library_(page: Page, root: string, files: Record<string, string | Buffer>): Promise<void> {
  const course = path.join(root, 'Fall 2026', COURSE);
  for (const [name, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(course, name)), { recursive: true });
    await writeFile(path.join(course, name), content);
  }
  await openLibrary(page);
}

/** Opens a file of the course in the preview. */
async function show(page: Page, name: string): Promise<Locator> {
  if (!(await treeRow(page, name).isVisible())) await treeRow(page, COURSE).click();
  await treeRow(page, name).click();
  const pane = page.getByRole('group', { name: preview.label.replace('{{name}}', path.basename(name)) });
  await expect(pane).toBeVisible();
  return pane;
}

function frameOf(page: Page): FrameLocator {
  return page.frameLocator('iframe.preview-frame');
}

test('a note shows maths, code, its images and inert links', async ({ folio }) => {
  test.setTimeout(120_000);
  const { page, libraryDir } = folio;
  if (!libraryDir) throw new Error('This test requires the isolated library-folder fixture');
  await library_(page, libraryDir, { 'notes.md': NOTE, 'figure.png': png(160, 120, [40, 120, 200]) });

  const pane = await show(page, 'notes.md');
  const note = frameOf(page);
  await expect(note.getByRole('heading', { level: 1, name: 'Week 1: vectors' })).toBeVisible();
  // Temml writes MathML; Chromium lays it out with the maths font.
  await expect(note.locator('math')).toHaveCount(2);
  await expect(note.locator('math mtable')).not.toHaveCount(0);
  await expect(note.locator('code .hljs-keyword').first()).toHaveText('def');
  await expect(note.getByRole('table')).toBeVisible();

  // The image next to the note arrives from the window; the others keep their placeholders.
  const figure = note.getByRole('img', { name: 'Unit circle' });
  await expect(figure).toHaveAttribute('src', /^blob:/);
  await expect.poll(() => figure.evaluate((image: unknown) => (image as { naturalWidth: number }).naturalWidth)).toBe(160);
  await expect(note.locator('.note-image[data-state="missing"]', { hasText: 'Missing' })).toContainText(
    preview.frame.imageMissing,
  );
  await expect(note.locator('.note-image[data-state="remote"]')).toContainText('https://example.com/web.png');
  // The note's own markup ran no script.
  expect(await note.locator('html').evaluate(() => (globalThis as unknown as { document: { title: string } }).document.title)).toBe('Preview of notes.md');

  // A link shows its address and copies it; it opens nothing.
  const link = note.getByRole('link', { name: 'syllabus' });
  await expect(link).toHaveAttribute('title', 'https://example.com/syllabus');
  await link.click();
  const popover = page.getByRole('dialog', { name: preview.link.label });
  await expect(popover).toContainText('https://example.com/syllabus');
  await popover.getByRole('button', { name: preview.link.copy }).click();
  await expect(page.getByRole('status').filter({ hasText: preview.link.copied })).toBeVisible();
  expect(page.url()).toMatch(/^http:\/\/tauri\.localhost\//);
  await expect(page.frames().filter((frame) => frame.url().includes('example.com'))).toHaveLength(0);

  // Esc inside the frame gives focus back to the header.
  await note.getByRole('heading', { level: 1 }).click();
  await page.keyboard.press('Escape');
  await expect(pane.getByRole('heading', { level: 2 })).toBeFocused();

  expect(await blockingViolations(page)).toEqual([]);
});

test('text and code show with line numbers, Chinese GBK text included', async ({ folio }) => {
  const { page, libraryDir } = folio;
  if (!libraryDir) throw new Error('This test requires the isolated library-folder fixture');
  // "线性代数笔记" in GBK, which is not valid UTF-8.
  const gbk = Buffer.from([0xcf, 0xdf, 0xd0, 0xd4, 0xb4, 0xfa, 0xca, 0xfd, 0xb1, 0xca, 0xbc, 0xc7, 0x0d, 0x0a]);
  await library_(page, libraryDir, { 'hw1.py': 'import math\n\ndef area(r):\n    return math.pi * r ** 2\n', 'notes.txt': gbk });

  await show(page, 'hw1.py');
  const code = frameOf(page);
  await expect(code.locator('.lines__gutter')).toHaveText('1\n2\n3\n4');
  await expect(code.locator('.hljs-keyword').first()).toHaveText('import');
  await expect(code.getByLabel('Contents of hw1.py')).toContainText('return math.pi');

  await show(page, 'notes.txt');
  await expect(frameOf(page).locator('.lines__text')).toHaveText('线性代数笔记');
});

test('a PDF pages, zooms, follows its own links and keeps others inert', async ({ folio }) => {
  test.setTimeout(120_000);
  const { page, libraryDir } = folio;
  if (!libraryDir) throw new Error('This test requires the isolated library-folder fixture');
  const profile = await readFile(SRGB_PROFILE).catch(() => undefined);
  await library_(page, libraryDir, { 'Lecture 1.pdf': pdf({ pages: 3, iccProfile: profile }) });
  // The page and its frames log no error: pdf.js once named its bundled fonts by a `bundled:` URL
  // in the CSS of substituted fonts (Helvetica here), which the frame's CSP refuses. A file
  // Windows makes no thumbnail of answers 404 by design (ipc-m1 §11.2); its tile shows the icon.
  const errors: string[] = [];
  page.on('console', (message) => {
    const { url } = message.location();
    if (message.type() === 'error' && !url.startsWith('http://folio-file.localhost/thumbnail/')) {
      errors.push(`${message.text()} @ ${url}`);
    }
  });

  await show(page, 'Lecture 1.pdf');
  const pages = frameOf(page);
  const pill = page.getByRole('toolbar', { name: preview.pdf.controls });
  await expect(pill).toContainText('1 / 3');
  // Text layer: Latin text and Chinese text through the bundled UniGB-UCS2-H CMap.
  await expect(pages.locator('.textLayer').first()).toContainText('Week 1 Lecture');
  await expect(pages.locator('.textLayer').first()).toContainText('线性代数');
  // pdf.js runs in its blob: worker, not on the frame's thread.
  await expect(pages.locator('#preview')).toHaveAttribute('data-thread', 'worker');

  await pill.getByRole('button', { name: preview.pdf.next }).click();
  await expect(pill).toContainText('2 / 3');
  const zoom = await pill.locator('.pdf-pill__zoom').textContent();
  await pill.getByRole('button', { name: preview.pdf.zoomIn }).click();
  await expect(pill.locator('.pdf-pill__zoom')).not.toHaveText(zoom ?? '');

  // A link to another page works inside the document; a web address only shows.
  await pill.getByRole('button', { name: preview.pdf.previous }).click();
  await expect(pill).toContainText('1 / 3');
  await pill.getByRole('button', { name: preview.pdf.fitWidth }).click();
  await pages.locator('.linkAnnotation a[href^="#"]').click();
  await expect(pill).toContainText('2 / 3');
  await pill.getByRole('button', { name: preview.pdf.previous }).click();
  await pages.locator('.linkAnnotation a[href^="https"]').click();
  await expect(page.getByRole('dialog', { name: preview.link.label })).toContainText('https://example.com/syllabus');
  await page.keyboard.press('Escape');

  expect(await blockingViolations(page)).toEqual([]);
  expect(errors).toEqual([]);
});

test('images, audio and files Folio does not show', async ({ folio }) => {
  const { page, libraryDir } = folio;
  if (!libraryDir) throw new Error('This test requires the isolated library-folder fixture');
  await library_(page, libraryDir, {
    'board.png': png(320, 200, [200, 80, 40]),
    'tone.wav': wav(),
    'Week 1.pptx': 'not really a deck',
    'data.zip': 'not really an archive',
  });

  const image = (await show(page, 'board.png')).getByRole('img', { name: 'board.png' });
  await expect.poll(() => image.evaluate((element: unknown) => (element as { naturalWidth: number }).naturalWidth)).toBe(320);

  const audio = (await show(page, 'tone.wav')).locator('audio');
  await expect.poll(() => audio.evaluate((element: unknown) => (element as { duration: number }).duration)).toBeCloseTo(1, 1);

  const deck = await show(page, 'Week 1.pptx');
  await expect(deck).toContainText(preview.card.office);
  await expect(deck.locator('.preview-card').getByRole('button', { name: preview.header.open })).toBeVisible();

  const archive = await show(page, 'data.zip');
  await expect(archive).toContainText(preview.card.other);
  expect(await blockingViolations(page)).toEqual([]);
});

test('the tag row adds and removes a tag on the file', async ({ folio }) => {
  const { page, libraryDir } = folio;
  if (!libraryDir) throw new Error('This test requires the isolated library-folder fixture');
  await library_(page, libraryDir, { 'ps1.md': '# Problem set 1\n' });
  const pane = await show(page, 'ps1.md');

  await pane.getByRole('button', { name: preview.tags.addLabel }).click();
  await page.getByRole('menuitemcheckbox', { name: 'Homework' }).click();
  await page.keyboard.press('Escape');
  const tags = pane.getByRole('grid', { name: preview.tags.label });
  await expect(tags.getByRole('row', { name: 'Homework' })).toBeVisible();
  await expect(treeRow(page, 'ps1.md, tags Homework')).toBeVisible();

  await tags.getByRole('button', { name: /Remove tag/ }).click();
  await expect(tags.getByRole('row', { name: 'Homework' })).toHaveCount(0);
  await expect(treeRow(page, 'ps1.md')).toHaveAccessibleName(/^ps1\.md$/);
});

test('reduced motion stops the preview popover from moving', async ({ folio }) => {
  const { page, libraryDir } = folio;
  if (!libraryDir) throw new Error('This test requires the isolated library-folder fixture');
  await library_(page, libraryDir, { 'links.md': '[home](https://example.com/)\n' });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await show(page, 'links.md');
  await frameOf(page).getByRole('link', { name: 'home' }).click();
  const popover = page.locator('.link-popover');
  await expect(popover).toBeVisible();
  expect(await page.evaluate("getComputedStyle(document.querySelector('.link-popover')).animationDuration")).toBe('0s');
  // The frame follows the window's reduced motion too.
  await expect(frameOf(page).locator('html')).toHaveAttribute('data-reduce-motion', 'on');
});
