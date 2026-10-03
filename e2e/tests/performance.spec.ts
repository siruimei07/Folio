import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { Page } from '@playwright/test';

import preview from '../../apps/desktop/src/i18n/locales/en/preview.json' with { type: 'json' };
import type { Job } from '../../apps/desktop/src/ipc/bindings';
import { expect, invoke, openLibrary, test, treeRow } from '../fixtures';
import { pdf, png, SRGB_PROFILE } from '../preview-samples';

// M1's performance targets in the running app (docs/specs/m1-acceptance.md §2): a library of
// 49,920 files on disk, laid out like crates/folio-core/tests/scan_benchmark.rs, plus a folder of
// common files to preview. It records the first scan, a page of 200 rows and a search page
// through IPC, and the time from a click to a rendered preview. Run it on an optimised build that
// keeps the debug-only test hooks, in a quiet window (testing strategy, "Performance"):
//
//   FOLIO_E2E_PERF=1 FOLIO_APP_PATH=<target>/release/folio-app.exe playwright test performance
//
// Numbers are printed and attached; the test fails only past the targets.

test.skip(process.env.FOLIO_E2E_PERF !== '1', 'a timing run: set FOLIO_E2E_PERF=1 on an optimised build');
test.use({ libraryFolder: true });

const SEMESTERS = 6;
const COURSES = 8;
const FOLDERS = ['作业', '课件', '笔记', '考试', '参考资料'];
const FILES = 208;
const EXTENSIONS = ['pdf', 'docx', 'pptx', 'md', 'txt', 'xlsx', 'png'];
const SAMPLES = path.join('2026 秋', '课程 0', '预览');

const NOTE = `# 第 5 讲：特征值

${Array.from({ length: 40 }, (_, section) => `## ${String(section + 1)}. Eigenvalues

For $A \\in \\mathbb{R}^{n \\times n}$, $\\det(A - \\lambda I) = 0$ and

$$
A v = \\lambda v, \\quad v \\neq 0
$$

\`\`\`python
import numpy as np
values, vectors = np.linalg.eig(np.array([[2, 1], [1, 2]]))
\`\`\`
`).join('\n')}`;

const CODE = Array.from(
  { length: 3000 },
  (_, line) => `def step_${String(line)}(x, y):  # 第 ${String(line)} 步\n    return x * ${String(line % 17)} + y\n`,
).join('');

/** 49,920 files of 2 KB, `concurrency` writes at a time. */
async function largeLibrary(root: string): Promise<number> {
  const paths: string[] = [];
  for (let semester = 0; semester < SEMESTERS; semester++) {
    for (let course = 0; course < COURSES; course++) {
      for (const folder of FOLDERS) {
        const dir = path.join(root, `${String(2024 + Math.floor(semester / 2))} ${['春', '秋'][semester % 2] ?? ''}`, `课程 ${String(course)}`, folder);
        await mkdir(dir, { recursive: true });
        for (let file = 0; file < FILES; file++) {
          paths.push(path.join(dir, `第${String(file)}讲 资料.${EXTENSIONS[file % EXTENSIONS.length] ?? 'txt'}`));
        }
      }
    }
  }
  const bytes = Buffer.alloc(2048, 'x');
  const concurrency = 64;
  for (let start = 0; start < paths.length; start += concurrency) {
    await Promise.all(paths.slice(start, start + concurrency).map((file) => writeFile(file, bytes)));
  }
  return paths.length;
}

function stats(times: number[]): { median: number; max: number } {
  const sorted = [...times].sort((a, b) => a - b);
  return { median: Math.round(sorted[Math.floor(sorted.length / 2)] ?? 0), max: Math.round(sorted.at(-1) ?? 0) };
}

/** Round trips of one command through IPC, timed in the page; the first run warms up. */
async function timeCommand(page: Page, command: string, args: Record<string, unknown>, runs = 10): Promise<number[]> {
  return page.evaluate<number[]>(`(async () => {
    const invoke = window.__TAURI_INTERNALS__.invoke;
    const args = ${JSON.stringify(args)};
    await invoke(${JSON.stringify(command)}, args);
    const times = [];
    for (let run = 0; run < ${String(runs)}; run++) {
      const start = performance.now();
      await invoke(${JSON.stringify(command)}, args);
      times.push(performance.now() - start);
    }
    return times;
  })()`);
}

test('a 50,000-file library: first scan, pages, search and previews', async ({ folio }) => {
  test.setTimeout(900_000);
  const { page, libraryDir } = folio;
  if (!libraryDir) throw new Error('This test requires the isolated library-folder fixture');
  const results: Record<string, unknown> = {};

  const created = Date.now();
  const files = await largeLibrary(libraryDir);
  const samples = path.join(libraryDir, SAMPLES);
  await mkdir(samples, { recursive: true });
  const profile = await readFile(SRGB_PROFILE).catch(() => undefined);
  await writeFile(path.join(samples, 'Lecture notes.pdf'), pdf({ pages: 30 }));
  await writeFile(path.join(samples, 'Scanned handout.pdf'), pdf({ pages: 12, iccProfile: profile, scan: { width: 1275, height: 1650 } }));
  await writeFile(path.join(samples, 'Whiteboard.png'), png(4000, 3000, [40, 120, 200]));
  await writeFile(path.join(samples, 'eigen.py'), CODE);
  await writeFile(path.join(samples, 'Week 5.md'), NOTE);
  results.library = { files: files + 5, createdMs: Date.now() - created };

  // The first scan, as the app runs it when a folder becomes the library, then hashing.
  const started = Date.now();
  await openLibrary(page, undefined, { timeout: 600_000, intervals: [50] });
  const scanned = Date.now() - started;
  // Every hash job, a retry of files that were too fresh included, has run and none waits. A job
  // that deferred files queues its retry just after it finishes, so the last one (finished jobs
  // are listed in the order they finished) must have deferred none.
  const hashing = async () => {
    const hashes = (await invoke<Job[]>(page, 'list_jobs')).filter((job) => job.kind === 'hash');
    const last = hashes.at(-1)?.status;
    return (
      hashes.every((job) => job.status.state === 'done') &&
      last?.state === 'done' &&
      last.result.kind === 'hash' &&
      last.result.deferred === 0
    );
  };
  await expect.poll(hashing, { timeout: 600_000, intervals: [100] }).toBe(true);
  results.firstScan = { scanMs: scanned, scanAndHashMs: Date.now() - started };

  // A page of 200 rows: the whole library's files by name and by size, and a folder of 208.
  const page200 = { offset: 0, limit: 200 };
  const filter = { tags: null, addedAfterMs: null };
  const byName = stats(await timeCommand(page, 'list_files', { request: { scope: null, filter, sort: { key: 'name', descending: false }, page: page200 } }));
  const bySize = stats(await timeCommand(page, 'list_files', { request: { scope: null, filter, sort: { key: 'size', descending: true }, page: page200 } }));
  results.page200 = { byName, bySize };

  // A search page of 50 results with highlights: one and two Chinese characters, a Latin word.
  const search = async (text: string) => stats(await timeCommand(page, 'search', { request: { text, scope: null, page: { offset: 0, limit: 50 } } }));
  results.search = { 讲: await search('讲'), 资料: await search('资料'), pdf: await search('pdf') };

  // Previews: from the click on a row to the rendered file, five times each, alternating so that
  // every click opens a fresh frame.
  const switcher = page.getByRole('button', { name: /^Switch semester, current / });
  if (!(await switcher.getAttribute('aria-label'))?.endsWith('2026 秋')) {
    await switcher.click();
    await page.getByRole('menuitemradio', { name: '2026 秋' }).click();
  }
  const row = (name: string) => treeRow(page, name, '2026 秋');
  await row('课程 0').click();
  await row('预览').click();
  const frame = page.frameLocator('iframe.preview-frame');
  const ready: Record<string, () => Promise<void>> = {
    'Lecture notes.pdf': () => frame.getByText('Week 1 Lecture').first().waitFor(),
    'Scanned handout.pdf': () => frame.getByText('Week 1 Lecture').first().waitFor(),
    'Whiteboard.png': async () => {
      const image = page.getByRole('group', { name: preview.label.replace('{{name}}', 'Whiteboard.png') }).getByRole('img', { name: 'Whiteboard.png' });
      await image.waitFor();
      await image.evaluate((element: unknown) => (element as { decode: () => Promise<void> }).decode());
    },
    'eigen.py': () => frame.locator('.lines__gutter').waitFor(),
    'Week 5.md': () => frame.getByRole('heading', { level: 1 }).waitFor(),
  };
  const times: Record<string, number[]> = {};
  for (let round = 0; round < 5; round++) {
    for (const [name, rendered] of Object.entries(ready)) {
      const start = performance.now();
      await row(name).click();
      await rendered();
      (times[name] ??= []).push(performance.now() - start);
    }
  }
  results.preview = Object.fromEntries(Object.entries(times).map(([name, list]) => [name, stats(list)]));

  console.log(JSON.stringify(results, null, 2));
  await test.info().attach('performance', { body: JSON.stringify(results, null, 2), contentType: 'application/json' });
  for (const [name, { max }] of Object.entries(results.preview as Record<string, { max: number }>)) {
    expect(max, `preview of ${name}`).toBeLessThan(1000);
  }
});
