// Choosing, creating and opening a library against the fake shell (ipc-m1 §6; first-run handoff
// §4): the folder dialog's token, the library that opens, and LibraryStateChanged switching the
// cache over to it.
import { waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { scenarioFixture } from '../ipc/mock';
import { DEFAULT_PRESET_NAMES } from '../ipc/mock/fixtures/build';
import type { FolderKind } from '../ipc/mock/fixtures/first-run';
import type { Fixture } from '../ipc/mock/fixtures/types';
import { NOW } from '../test/data';
import { renderAppHook } from '../test/render';
import { useJob } from './jobs';
import { useCreateLibrary, useLibrary, useOpenLibrary, usePickLibraryFolder } from './library';
import { useSession } from './session';
import { useTags } from './tags';

function firstRun(choice: FolderKind): Fixture {
  return scenarioFixture('first-run', NOW, { choice }).fixture;
}

/** The folder the dialog answers with; the tests' dialogs never cancel. */
async function choose(result: { current: { pick: ReturnType<typeof usePickLibraryFolder> } }) {
  const choice = await result.current.pick.mutateAsync();
  if (choice === null) throw new Error('cancelled');
  return choice;
}

function useLibraryHooks() {
  return {
    library: useLibrary(),
    pick: usePickLibraryFolder(),
    create: useCreateLibrary(),
    open: useOpenLibrary(),
  };
}

describe('the folder dialog', () => {
  it('answers with a token and what the folder holds, or null when cancelled', async () => {
    const { result } = renderAppHook(usePickLibraryFolder, { fixture: firstRun('folders'), now: NOW });
    const choice = await result.current.mutateAsync();
    expect(choice).toEqual({
      token: expect.stringMatching(/^[0-9a-f]{32}$/) as string,
      path: 'D:\\University',
      content: { kind: 'folders', folders: 4, files: 1 },
      syncRoot: null,
    });

    const cancelled = renderAppHook(usePickLibraryFolder, {
      fixture: { ...firstRun('empty'), folderChoices: [null] },
      now: NOW,
    });
    await expect(cancelled.result.current.mutateAsync()).resolves.toBeNull();
  });
});

describe('create_library', () => {
  it('opens the new library with its preset tags; the cache follows LibraryStateChanged', async () => {
    let scan = '';
    const { result } = renderAppHook(
      () => ({ ...useLibraryHooks(), tags: useTags().data, scan: useJob(scan) }),
      { fixture: firstRun('empty'), now: NOW },
    );
    expect(result.current.library).toBeNull();
    const choice = await choose(result);

    const opened = await result.current.create.mutateAsync({
      folder: choice.token,
      name: 'Coursework',
      presetTags: DEFAULT_PRESET_NAMES,
    });
    scan = opened.scan;

    expect(opened.library).toMatchObject({ name: 'Coursework', root: choice.path, readOnly: false });
    await waitFor(() => {
      expect(result.current.library).toEqual(opened.library);
    });
    expect(useSession.getState().libraryId).toBe(opened.library.id);
    await waitFor(() => {
      expect(result.current.tags?.map((tag) => tag.name)).toEqual([
        'Notes',
        'Slides',
        'Homework',
        'Exams',
        'Reference',
      ]);
    });
    await waitFor(() => {
      expect(result.current.scan?.kind).toBe('scan');
    });
  });

  it('keeps errors typed: a used token, a name error, a folder that is a library', async () => {
    const { result } = renderAppHook(useLibraryHooks, { fixture: firstRun('empty'), now: NOW });
    const choice = await choose(result);
    const request = { folder: choice.token, name: 'Coursework', presetTags: DEFAULT_PRESET_NAMES };

    await expect(result.current.create.mutateAsync({ ...request, name: ' ' })).rejects.toMatchObject({
      error: { code: 'NameEmpty' },
    });
    await result.current.create.mutateAsync(request);
    await expect(result.current.create.mutateAsync(request)).rejects.toMatchObject({
      error: { code: 'ChoiceExpired' },
    });

    const library = renderAppHook(useLibraryHooks, { fixture: firstRun('library'), now: NOW });
    const existing = await choose(library.result);
    await expect(
      library.result.current.create.mutateAsync({ ...request, folder: existing.token }),
    ).rejects.toMatchObject({ error: { code: 'AlreadyALibrary' } });
  });
});

describe('open_library', () => {
  it('opens a folder that holds a library; the cache follows LibraryStateChanged', async () => {
    const { result } = renderAppHook(useLibraryHooks, { fixture: firstRun('library'), now: NOW });
    const choice = await choose(result);

    const opened = await result.current.open.mutateAsync({ folder: choice.token });

    expect(opened.library.name).toBe('University of Toronto');
    await waitFor(() => {
      expect(result.current.library?.id).toBe(opened.library.id);
    });
  });

  it('a folder without a library is NotALibrary, typed', async () => {
    const { result } = renderAppHook(useLibraryHooks, { fixture: firstRun('empty'), now: NOW });
    const choice = await choose(result);
    await expect(result.current.open.mutateAsync({ folder: choice.token })).rejects.toMatchObject({
      error: { code: 'NotALibrary' },
    });
    expect(result.current.library).toBeNull();
  });
});
