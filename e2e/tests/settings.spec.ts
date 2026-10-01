import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { Page as BrowserPage } from '@playwright/test';

import type {
  AppError,
  AppSettings,
  EntryRow,
  FolderChoice,
  IgnoreRules,
  IgnoreRulesChanged,
  Job,
  LibraryOpened,
  Page,
  ProblemItem,
} from '../../apps/desktop/src/ipc/bindings';
import { expect, test } from '../fixtures';

// Settings through the real shell (docs/specs/ipc-m1.md §22).

test('App settings persist and set the root before the first render', async ({ folio }) => {
  const { page, dataDir } = folio;
  const defaults = await invoke<AppSettings>(page, 'get_app_settings');
  expect(defaults).toMatchObject({ theme: 'system', reduceMotion: 'system' });
  // Windows names every computer.
  expect(defaults.deviceName).toMatch(/\S/);
  expect(await rejection(page, 'update_app_settings', {
    request: { deviceName: '  ', theme: 'dark', reduceMotion: null },
  })).toMatchObject({ code: 'NameEmpty' });

  const saved = await invoke<AppSettings>(page, 'update_app_settings', {
    request: { deviceName: ' E2E PC ', theme: 'dark', reduceMotion: 'on' },
  });
  expect(saved).toEqual({ deviceName: 'E2E PC', theme: 'dark', reduceMotion: 'on' });
  // The window's root follows AppSettingsChanged.
  await expect.poll(() => rootAppearance(page)).toEqual({ theme: 'dark', reduceMotion: 'on' });
  expect(JSON.parse(await readFile(path.join(dataDir, 'settings.json'), 'utf8')) as unknown).toMatchObject({
    format_version: 1,
    library_root: null,
    device_name: 'E2E PC',
    theme: 'dark',
    reduce_motion: 'on',
  });

  // main.tsx applies the stored appearance before React renders anything, so it is on the root
  // as soon as the app has rendered.
  const restarted = await folio.restart();
  await restarted.waitForFunction("(document.getElementById('root')?.childElementCount ?? 0) > 0");
  expect(await rootAppearance(restarted)).toEqual({ theme: 'dark', reduceMotion: 'on' });
  expect(await invoke<AppSettings>(restarted, 'get_app_settings')).toEqual(saved);

  await invoke(restarted, 'update_app_settings', {
    request: { deviceName: null, theme: 'system', reduceMotion: 'system' },
  });
  await expect.poll(() => rootAppearance(restarted)).toEqual({ theme: null, reduceMotion: null });
});

test.describe('ignore rules', () => {
  test.use({ libraryFolder: true });

  test('saving rules rescans the library with them', async ({ folio }) => {
    test.setTimeout(90_000);
    const { page, libraryDir } = folio;
    if (!libraryDir) throw new Error('This test requires the isolated library-folder fixture');
    await writeFile(path.join(libraryDir, 'notes.md'), 'Kept.\n');
    await mkdir(path.join(libraryDir, 'build'));
    await writeFile(path.join(libraryDir, 'build', 'out.o'), 'Left out.\n');

    const choice = await invoke<FolderChoice | null>(page, 'pick_library_folder');
    if (!choice) throw new Error('The isolated folder choice was cancelled');
    const opened = await invoke<LibraryOpened>(page, 'create_library', {
      request: {
        folder: choice.token,
        name: 'Settings library',
        presetTags: { notes: 'Notes', slides: 'Slides', homework: 'Homework', exam: 'Exam', reference: 'Reference' },
      },
    });
    await jobsSettle(page, opened.scan);
    expect(await rootNames(page)).toEqual(['build', 'notes.md']);
    expect(await invoke<IgnoreRules>(page, 'get_ignore_rules')).toMatchObject({ text: '', invalidLines: [] });

    await recordIgnoreEvents(page);
    const rules = await invoke<IgnoreRules>(page, 'set_ignore_rules', { request: { text: 'build/\r\n[z-a]' } });
    expect(rules).toEqual({ text: 'build/\n[z-a]\n', invalidLines: [2] });
    expect(await readFile(path.join(libraryDir, '.folio', 'ignore'), 'utf8')).toBe('build/\n[z-a]\n');
    await expect.poll(() => rootNames(page)).toEqual(['notes.md']);
    await expect.poll(() => page.evaluate<IgnoreRulesChanged[]>('window.__folioIgnoreEvents')).toEqual([{ rules }]);
    await expect.poll(async () => (await invoke<Page<ProblemItem>>(page, 'list_problems', {
      request: { page: { offset: 0, limit: 50 } },
    })).items.map((item) => item.problem)).toContainEqual({ kind: 'invalidIgnoreRule', file: null, line: 2 });

    expect(await rejection(page, 'set_ignore_rules', {
      request: { text: 'a'.repeat(65_537) },
    })).toMatchObject({ code: 'InvalidArgument' });
    await invoke(page, 'set_ignore_rules', { request: { text: '' } });
    await expect.poll(() => rootNames(page)).toEqual(['build', 'notes.md']);
  });
});

function invoke<T>(page: BrowserPage, command: string, args: Record<string, unknown> = {}): Promise<T> {
  return page.evaluate<T>(
    `window.__TAURI_INTERNALS__.invoke(${JSON.stringify(command)}, ${JSON.stringify(args)})`,
  );
}

function rejection(page: BrowserPage, command: string, args: Record<string, unknown>): Promise<AppError | null> {
  return page.evaluate<AppError | null>(
    `window.__TAURI_INTERNALS__.invoke(${JSON.stringify(command)}, ${JSON.stringify(args)})
      .then(() => null, error => error)`,
  );
}

function rootAppearance(page: BrowserPage): Promise<{ theme: string | null; reduceMotion: string | null }> {
  return page.evaluate(`({
    theme: document.documentElement.dataset.theme ?? null,
    reduceMotion: document.documentElement.dataset.reduceMotion ?? null,
  })`);
}

async function rootNames(page: BrowserPage): Promise<string[]> {
  const children = await invoke<Page<EntryRow>>(page, 'list_children', {
    request: { folder: null, sort: { key: 'name', descending: false }, page: { offset: 0, limit: 50 } },
  });
  return children.items.map((item) => item.name);
}

async function recordIgnoreEvents(page: BrowserPage): Promise<void> {
  await page.evaluate(`(async () => {
    window.__folioIgnoreEvents = [];
    const { invoke, transformCallback } = window.__TAURI_INTERNALS__;
    await invoke('plugin:event|listen', {
      event: 'ignore-rules-changed', target: { kind: 'Any' },
      handler: transformCallback(event => window.__folioIgnoreEvents.push(event.payload)),
    });
  })()`);
}

/** Waits until the start-up scan and the jobs it queued have finished. */
async function jobsSettle(page: BrowserPage, scan: string): Promise<void> {
  await expect.poll(async () => {
    const jobs = await invoke<Job[]>(page, 'list_jobs');
    const active = jobs.some((job) => job.status.state === 'queued' || job.status.state === 'running');
    return !active && jobs.some((job) => job.id === scan && job.status.state === 'done');
  }).toBe(true);
}
