import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { Page } from '@playwright/test';

import type {
  MetadataChange,
  Page as ListPage,
  SelectionSummary,
  WorkspaceChanged,
  WorkspaceItem,
  WorkspaceSummary,
} from '../../apps/desktop/src/ipc/bindings';
import { expect, invoke, openLibrary, rejection, test } from '../fixtures';

// The workspace commands on the real shell (ipc-m2 §5, §6, §14; versioning.md §6). A new library
// has no history: until feat/core-commit-history registers `start_history` and `commit`, nothing
// can make one, so the real shell answers `none` with nothing listed whatever the folder holds.
// The workspace itself (items, bound items, metadata changes, summaries) runs in folio-core's
// workspace tests and folio-app's library::workspace tests over histories written through the
// store. For feat/core-commit-history: add the flow over a committed library here (a few changed
// files listed, a selection summarized, a commit, the workspace empty again).

test.use({ libraryFolder: true });

/** `LIMITS` in the bindings, which this package does not import at run time. */
const PAGE_SIZE = 500;
const BATCH = 10_000;
const KEY_CHARS = 32_800;
const NO_CHANGES = '0'.repeat(32);

const allExcept = (keys: string[], fingerprint = NO_CHANGES) => ({
  request: { selection: { kind: 'allExcept', keys }, fingerprint },
});
const page = (offset: number, limit: number) => ({ request: { page: { offset, limit } } });

/** Records every `WorkspaceChanged` the page receives from now on. */
async function recordWorkspaceEvents(window: Page): Promise<void> {
  await window.evaluate(`(async () => {
    window.__folioWorkspaceEvents = [];
    const { invoke, transformCallback } = window.__TAURI_INTERNALS__;
    await invoke('plugin:event|listen', {
      event: 'workspace-changed', target: { kind: 'Any' },
      handler: transformCallback(event => window.__folioWorkspaceEvents.push(event.payload)),
    });
  })()`);
}

function workspaceEvents(window: Page): Promise<WorkspaceChanged[]> {
  return window.evaluate<WorkspaceChanged[]>('window.__folioWorkspaceEvents');
}

test('checks the limits, then answers NoLibrary before a library opens', async ({ folio }) => {
  const window = folio.page;
  // The limits come first, as for every command that reads a page or a selection (ipc-m2 §5.1).
  expect(await rejection(window, 'list_workspace_items', page(0, PAGE_SIZE + 1)))
    .toMatchObject({ code: 'InvalidArgument' });
  expect(await rejection(window, 'list_metadata_changes', page(0, PAGE_SIZE + 1)))
    .toMatchObject({ code: 'InvalidArgument' });
  const tooMany = Array.from({ length: BATCH + 1 }, (_, index) => `fa${index}`);
  expect(await rejection(window, 'summarize_selection', allExcept(tooMany)))
    .toMatchObject({ code: 'InvalidArgument' });
  expect(await rejection(window, 'summarize_selection', allExcept(['f'.repeat(KEY_CHARS + 1)])))
    .toMatchObject({ code: 'InvalidArgument' });

  expect(await rejection(window, 'get_workspace')).toMatchObject({ code: 'NoLibrary' });
  expect(await rejection(window, 'list_workspace_items', page(0, PAGE_SIZE)))
    .toMatchObject({ code: 'NoLibrary' });
  expect(await rejection(window, 'list_metadata_changes', page(0, 50)))
    .toMatchObject({ code: 'NoLibrary' });
  expect(await rejection(window, 'summarize_selection', allExcept([])))
    .toMatchObject({ code: 'NoLibrary' });
});

test('a new library has no history: nothing listed, an empty summary and one event', async ({ folio }) => {
  const window = folio.page;
  if (!folio.libraryDir) throw new Error('This test requires the isolated library-folder fixture');
  await mkdir(path.join(folio.libraryDir, 'Fall 2026', 'MAT232 Calculus'), { recursive: true });
  await writeFile(path.join(folio.libraryDir, 'Fall 2026', 'MAT232 Calculus', 'notes.md'), '# Notes\n');
  await recordWorkspaceEvents(window);
  await openLibrary(window);

  const { revision, ...summary } = await invoke<WorkspaceSummary>(window, 'get_workspace');
  expect(revision).toBeGreaterThan(0);
  expect(summary).toEqual({
    historyState: 'none',
    head: null,
    fingerprint: NO_CHANGES,
    items: 0,
    metadata: 0,
    includable: 0,
    hashing: 0,
    notLocal: 0,
    unreadable: 0,
  });
  const pages: [number, number][] = [[0, PAGE_SIZE], [10, 1]];
  for (const [offset, limit] of pages) {
    const items = await invoke<ListPage<WorkspaceItem>>(window, 'list_workspace_items', page(offset, limit));
    const metadata = await invoke<ListPage<MetadataChange>>(window, 'list_metadata_changes', page(offset, limit));
    for (const { revision: pageRevision, ...rest } of [items, metadata]) {
      // The catalog revision of the snapshot the page comes from (the hash job may commit since).
      expect(pageRevision).toBeGreaterThanOrEqual(revision);
      expect(rest).toEqual({ items: [], offset, total: 0 });
    }
  }
  const empty: SelectionSummary = {
    items: 0,
    metadata: 0,
    groups: [],
    tagDefinitions: false,
    library: false,
    ignoreRules: false,
  };
  expect(await invoke<SelectionSummary>(window, 'summarize_selection', allExcept([])))
    .toEqual(empty);
  expect(await invoke<SelectionSummary>(window, 'summarize_selection', {
    request: { selection: { kind: 'only', keys: [] }, fingerprint: NO_CHANGES },
  })).toEqual(empty);

  // The shell sends one event once a library opens, whatever changed (ipc-m2 §14).
  await expect.poll(async () => (await workspaceEvents(window)).length).toBeGreaterThan(0);
  expect((await workspaceEvents(window)).at(-1)).toMatchObject({
    historyState: 'none',
    head: null,
    total: 0,
  });

  // A selection read against another workspace, then a key that names no item (ipc-m2 §5.1).
  expect(await rejection(window, 'summarize_selection', allExcept([], 'f'.repeat(32))))
    .toMatchObject({ code: 'WorkspaceChanged' });
  expect(await rejection(window, 'summarize_selection', {
    request: { selection: { kind: 'only', keys: ['fa'] }, fingerprint: NO_CHANGES },
  })).toMatchObject({ code: 'InvalidArgument' });
});

test('commit, start_history and the workspace diff are still refused before any handler', async ({ folio }) => {
  const window = folio.page;
  await openLibrary(window);
  const calls: [string, object][] = [
    ['commit', { request: { selection: { kind: 'allExcept', keys: [] }, fingerprint: NO_CHANGES, message: 'm' } }],
    ['start_history', { request: { summary: 'Start history' } }],
    ['get_workspace_diff', { request: { key: 'fa' } }],
  ];
  for (const [command, args] of calls) {
    await expect(
      window.evaluate(`window.__TAURI_INTERNALS__.invoke(${JSON.stringify(command)}, ${JSON.stringify(args)})`),
    ).rejects.toThrow(/not allowed/);
  }
});
