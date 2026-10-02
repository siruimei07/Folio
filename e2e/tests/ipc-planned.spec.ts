import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { ImportResult, Job } from '../../apps/desktop/src/ipc/bindings';
import { expect, test } from '../fixtures';

// All M1 commands are implemented. Unknown commands still have no manifest entry or grant,
// and Tauri must reject them before any handler runs (ipc-m1 §3, §17).
test('rejects unknown commands before they reach a handler', async ({ folio }) => {
  await expect(
    folio.page.evaluate(`window.__TAURI_INTERNALS__.invoke('folio_unknown_command', {})`),
  ).rejects.toThrow(/not allowed/);
});

test.describe('implemented import command boundary', () => {
  test.use({ libraryFolder: true });
  let sources = '';
  const previousPicker = process.env.FOLIO_TEST_IMPORT_FILES;

  test.beforeAll(async () => {
    sources = await mkdtemp(path.join(tmpdir(), 'folio-import-e2e-'));
    const source = path.join(sources, 'lecture.txt');
    await writeFile(source, 'Verified import bytes.');
    process.env.FOLIO_TEST_IMPORT_FILES = source;
  });

  test.afterAll(async () => {
    if (previousPicker === undefined) delete process.env.FOLIO_TEST_IMPORT_FILES;
    else process.env.FOLIO_TEST_IMPORT_FILES = previousPicker;
    if (sources) await rm(sources, { recursive: true, force: true });
  });

  test('rejects page-supplied paths through the registered import handlers', async ({ folio }) => {
    const codes = await folio.page.evaluate(`(async () => {
      const invoke = window.__TAURI_INTERNALS__.invoke;
      const choice = await invoke('pick_library_folder');
      await invoke('create_library', { request: {
        folder: choice.token, name: 'Import boundary', presetTags: {
          notes: 'Notes', slides: 'Slides', homework: 'Homework', exam: 'Exam', reference: 'Reference'
        }
      }});
      const target = { id: '1', path: 'Course' };
      const codes = [];
      for (const command of ['check_import', 'import_files']) {
        try {
          await invoke(command, { request: {
            source: 'C:/not-a-shell-choice/private.txt', target, tags: [],
            onConflict: 'keepBoth', deleteOriginals: true
          }});
          codes.push('unexpected-success');
        } catch (error) { codes.push(error.code); }
      }
      return codes;
    })()`);
    expect(codes).toEqual(['ChoiceExpired', 'ChoiceExpired']);
  });

  test('picks, checks and copies with tags, then keeps both using a new single-use choice', async ({ folio }) => {
    const invoke = <T>(command: string, args: object = {}) => folio.page.evaluate<T>(
      `window.__TAURI_INTERNALS__.invoke(${JSON.stringify(command)}, ${JSON.stringify(args)})`,
    );
    const choice = await invoke<{ token: string }>('pick_library_folder');
    await invoke('create_library', { request: {
      folder: choice.token, name: 'Import copy', presetTags: {
        notes: 'Notes', slides: 'Slides', homework: 'Homework', exam: 'Exam', reference: 'Reference',
      },
    } });
    await expect.poll(async () => (await invoke<Job[]>('list_jobs')).every(
      (job) => job.status.state !== 'queued' && job.status.state !== 'running',
    )).toBe(true);
    const semester = await invoke<{ folder: { id: string; path: string } }>('create_semester', { request: { name: 'Fall' } });
    const course = await invoke<{ folder: { id: string; path: string } }>('create_course', {
      request: { semester: semester.folder, name: 'Course', abbr: null, code: null, color: null },
    });
    for (const renamed of [0, 1]) {
      const source = await invoke<{ token: string; files: number; folders: number }>('pick_import_files');
      expect(source).toMatchObject({ files: 1, folders: 0 });
      const request = { source: source.token, target: course.folder };
      expect(await invoke('check_import', { request })).toMatchObject({ files: 1, folders: 0, bytes: '22', conflictCount: renamed });
      const id = await invoke<string>('import_files', { request: {
        ...request, tags: ['notes'], onConflict: 'keepBoth', deleteOriginals: false,
      } });
      let finished: Job | undefined;
      await expect.poll(async () => {
        finished = (await invoke<Job[]>('list_jobs')).find((job) => job.id === id);
        return finished?.status.state;
      }).toBe('done');
      if (finished?.status.state !== 'done' || finished.status.result.kind !== 'import') {
        throw new Error(`Unexpected import result: ${JSON.stringify(finished)}`);
      }
      const result: ImportResult = finished.status.result;
      expect(result).toMatchObject({ imported: 1, renamed, replaced: 0, failureCount: 0, originalsDeleted: 0 });
      expect(await folio.page.evaluate<string>(
        `window.__TAURI_INTERNALS__.invoke('check_import', ${JSON.stringify({ request })})
          .then(() => 'unexpected-success', error => error.code)`,
      )).toBe('ChoiceExpired');
      const name = renamed === 0 ? 'lecture.txt' : 'lecture (2).txt';
      if (!folio.libraryDir) throw new Error('Import needs the isolated library fixture');
      expect(await readFile(path.join(folio.libraryDir, 'Fall/Course', name), 'utf8')).toBe('Verified import bytes.');
    }
    const entries = await invoke<{ items: { tags: string[] }[] }>('list_children', {
      request: { folder: course.folder, page: { offset: 0, limit: 50 }, sort: { key: 'name', descending: false } },
    });
    expect(entries.items).toHaveLength(2);
    expect(entries.items.every((entry) => entry.tags.includes('notes'))).toBe(true);
    expect(await readFile(path.join(sources, 'lecture.txt'), 'utf8')).toBe('Verified import bytes.');
  });
});
