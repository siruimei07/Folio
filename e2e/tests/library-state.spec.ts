import { mkdir, readFile, realpath, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { Page as BrowserPage } from '@playwright/test';

import type {
  CatalogChanged,
  CreateLibrary,
  EntryChange,
  FolderChoice,
  Job,
  JobChanged,
  LibraryOpened,
  LibraryStateChanged,
  LibraryStatus,
  Page,
  ProblemItem,
} from '../../apps/desktop/src/ipc/bindings';
import { expect, invoke, rejection, test } from '../fixtures';

test.use({ libraryFolder: true });

test('runs a temporary library, observes outside changes, and drains jobs before reopening', async ({
  folio,
}) => {
  test.setTimeout(90_000);
  const { page, libraryDir, dataDir } = folio;
  if (!libraryDir) throw new Error('This test requires the isolated library-folder fixture');

  expect(await invoke<LibraryStatus>(page, 'library_status')).toEqual({ state: 'none' });
  await recordEvents(page);
  const choice = await invoke<FolderChoice | null>(page, 'pick_library_folder');
  expect(choice).toMatchObject({ content: { kind: 'empty' } });
  if (!choice) throw new Error('The isolated folder choice was cancelled');
  // The UI gets the folder as Windows users write it, without the verbatim `\\?\` prefix.
  expect(choice.path).toBe(await realpath(libraryDir));

  const request: CreateLibrary = {
    folder: choice.token,
    name: 'E2E library',
    presetTags: {
      notes: 'Notes',
      slides: 'Slides',
      homework: 'Homework',
      exam: 'Exam',
      reference: 'Reference',
    },
  };
  const opened = await invoke<LibraryOpened>(page, 'create_library', { request });
  expect(await invoke<LibraryStatus>(page, 'library_status')).toEqual({
    state: 'open',
    library: opened.library,
  });
  expect(await rejection(page, 'create_library', { request })).toMatchObject({
    code: 'ChoiceExpired',
  });
  await jobFinishes(page, opened.scan, 'scan');
  await expect.poll(async () => (await recordedEvents(page)).library).toContainEqual({
    status: { state: 'open', library: opened.library },
  });
  await expect.poll(async () => (await recordedEvents(page)).jobs).toContainEqual(
    expect.objectContaining({
      job: expect.objectContaining({ id: opened.scan, status: expect.objectContaining({ state: 'done' }) }),
    }),
  );

  const external = path.join(libraryDir, 'outside.md');
  await writeFile(external, 'Created outside Folio.\n');
  const added = await catalogChange(page, 'added', 'outside.md');
  await writeFile(external, 'Changed outside Folio, with a different size.\n');
  const modified = await catalogChange(page, 'modified', 'outside.md', added.revision);
  expect(modified.entry).toEqual(added.entry);
  await unlink(external);
  const removed = await catalogChange(page, 'removed', 'outside.md', modified.revision);
  expect(removed.entry).toEqual(added.entry);

  const problems = await invoke<Page<ProblemItem>>(page, 'list_problems', {
    request: { page: { offset: 0, limit: 50 } },
  });
  expect(problems).toMatchObject({ items: [], total: 0, offset: 0 });
  expect(problems.revision).toBeGreaterThanOrEqual(removed.revision);
  expect(await rejection(page, 'list_problems', {
    request: { page: { offset: 0, limit: 501 } },
  })).toMatchObject({ code: 'InvalidArgument' });
  expect(await rejection(page, 'cancel_job', { request: { job: 'not-a-job' } })).toMatchObject({
    code: 'NotFound',
  });

  const keptFile = path.join(libraryDir, 'keep.md');
  await writeFile(keptFile, 'Keep this source file through rebuild and shutdown.\n');
  const kept = await catalogChange(page, 'added', 'keep.md', removed.revision);
  const rebuild = await invoke<string>(page, 'rebuild_catalog');
  await jobFinishes(page, rebuild, 'rebuild');
  await expect.poll(async () => (await recordedEvents(page)).catalog.some(
    (event) => !event.complete && event.revision > kept.revision,
  )).toBe(true);
  expect(await rejection(page, 'cancel_job', { request: { job: rebuild } })).toMatchObject({
    code: 'NotFound',
  });

  const existing = await invoke<FolderChoice | null>(page, 'pick_library_folder');
  expect(existing).toMatchObject({ content: { kind: 'library', name: 'E2E library' } });
  if (!existing) throw new Error('The existing library choice was cancelled');
  const reopened = await invoke<LibraryOpened>(page, 'open_library', {
    request: { folder: existing.token },
  });
  expect(reopened.library.id).toBe(opened.library.id);
  await jobFinishes(page, reopened.scan, 'scan');
  const settingsPath = path.join(dataDir, 'settings.json');
  // The shell keeps the canonical path; the UI shows it without the verbatim prefix.
  const canonicalRoot = `\\\\?\\${reopened.library.root}`;
  expect(JSON.parse(await readFile(settingsPath, 'utf8')) as unknown).toMatchObject({
    format_version: 1,
    library_root: canonicalRoot,
  });
  const metadataPath = path.join(libraryDir, '.folio', 'library.json');
  const metadata = await readFile(metadataPath, 'utf8');

  // Enough real entries to exercise a queued/running rebuild while the shell closes. The
  // shell may finish or cancel it; neither outcome may depend on a page's close listener.
  const workload = path.join(libraryDir, 'Fall', 'CSC101');
  await mkdir(workload, { recursive: true });
  await Promise.all(Array.from({ length: 256 }, (_, index) => writeFile(
    path.join(workload, `note-${String(index)}.md`),
    'Source material for shutdown reconciliation.\n'.repeat(32),
  )));
  await page.evaluate(`(async () => {
    const { invoke, transformCallback } = window.__TAURI_INTERNALS__;
    await invoke('plugin:event|listen', {
      event: 'tauri://close-requested', target: { kind: 'Window', label: 'main' },
      handler: transformCallback(() => {}),
    });
  })()`);
  const closingJob = await invoke<string>(page, 'rebuild_catalog');
  expect(closingJob).not.toBe('');
  const restartedPage = await folio.restart();
  expect(await invoke<LibraryStatus>(restartedPage, 'library_status')).toMatchObject({
    state: 'open',
    library: { id: opened.library.id, name: 'E2E library', recovered: false },
  });
  await expect.poll(async () => (await invoke<Job[]>(restartedPage, 'list_jobs')).find(
    (job) => job.kind === 'scan',
  )).toMatchObject({ status: { state: 'done' } });
  expect(await readFile(keptFile, 'utf8')).toBe('Keep this source file through rebuild and shutdown.\n');
  expect(await readFile(metadataPath, 'utf8')).toBe(metadata);
  expect(JSON.parse(await readFile(settingsPath, 'utf8')) as unknown).toMatchObject({
    library_root: canonicalRoot,
  });
});

interface RecordedEvents {
  catalog: CatalogChanged[];
  jobs: JobChanged[];
  library: LibraryStateChanged[];
}

async function recordEvents(page: BrowserPage): Promise<void> {
  await page.evaluate(`(async () => {
    window.__folioLibraryEvents = { catalog: [], jobs: [], library: [] };
    const { invoke, transformCallback } = window.__TAURI_INTERNALS__;
    for (const [event, key] of [
      ['catalog-changed', 'catalog'], ['job-changed', 'jobs'], ['library-state-changed', 'library'],
    ]) {
      await invoke('plugin:event|listen', {
        event, target: { kind: 'Any' },
        handler: transformCallback(event => window.__folioLibraryEvents[key].push(event.payload)),
      });
    }
  })()`);
}

function recordedEvents(page: BrowserPage): Promise<RecordedEvents> {
  return page.evaluate<RecordedEvents>('window.__folioLibraryEvents');
}

async function catalogChange(
  page: BrowserPage,
  kind: EntryChange['kind'],
  entryPath: string,
  afterRevision = 0,
): Promise<EntryChange & { revision: number }> {
  const latest = async () => (await recordedEvents(page)).catalog.flatMap((event) =>
    event.entries.map((entry) => ({ ...entry, revision: event.revision })),
  ).findLast((entry) => entry.kind === kind && entry.entry.path === entryPath
    && entry.revision > afterRevision);
  await expect.poll(latest).toBeDefined();
  const change = await latest();
  if (!change) throw new Error(`No ${kind} catalog event for ${entryPath}`);
  return change;
}

async function jobFinishes(page: BrowserPage, id: string, kind: Job['kind']): Promise<void> {
  await expect.poll(async () => (await invoke<Job[]>(page, 'list_jobs')).find(
    (job) => job.id === id,
  )).toMatchObject({ kind, status: { state: 'done' } });
}
