// Fixtures built for one view test: a library of a test's own, or the small library with more
// entries. Feature folders never import the fake shell (eslint.config.js), so they build their
// fixtures here.
import type { SyncProvider } from '../ipc';
import { presetTags, SeedBuilder } from '../ipc/mock/fixtures/build';
import { type FolderKind, folderScript } from '../ipc/mock/fixtures/first-run';
import type { Fixture, FolderScript, LibrarySeed, SeedEntry } from '../ipc/mock/fixtures/types';
import { type ScenarioOptions, scenarioFixture } from '../ipc/mock/scenarios';
import { NOW } from './data';

const DAY = 86_400_000;

/** An open library built for one test, with the preset tags. */
export function libraryFixture(build: (builder: SeedBuilder) => void, seed: Partial<LibrarySeed> = {}): Fixture {
  const builder = new SeedBuilder(NOW);
  build(builder);
  return {
    status: { state: 'open' },
    library: {
      name: 'Test library',
      root: 'C:\\Test',
      readOnly: false,
      recovered: false,
      tags: presetTags(),
      entries: builder.build(),
      problems: [],
      ...seed,
    },
    folderChoices: [null],
    importSources: [null],
  };
}

/** The small library at `NOW`, with more entries; a file added and modified 60 days ago by default. */
export function smallLibraryWith(...entries: (Partial<SeedEntry> & { path: string })[]): Fixture {
  const { fixture } = scenarioFixture('small', NOW);
  const library = fixture.library;
  if (library === null) throw new Error('the small fixture has a library');
  for (const entry of entries) {
    library.entries.push({
      kind: 'file',
      size: '1000',
      modifiedMs: String(NOW - 60 * DAY),
      addedMs: String(NOW - 60 * DAY),
      tags: [],
      group: null,
      text: null,
      blocked: null,
      ...entry,
    });
  }
  return fixture;
}

/** What the folder dialog answers with: a folder holding `kind` (first-run handoff §4.2). */
export function folderChoice(kind: FolderKind, syncRoot: SyncProvider | null = null): FolderScript {
  return folderScript(kind, NOW, syncRoot);
}

/** No library yet, or one that cannot be opened, with the folder dialog's answers in order. */
export function startFixture(
  scenario: 'first-run' | 'unavailable',
  options: ScenarioOptions & { choices?: (FolderScript | null)[] } = {},
): Fixture {
  const { choices, ...rest } = options;
  const { fixture } = scenarioFixture(scenario, NOW, rest);
  return choices === undefined ? fixture : { ...fixture, folderChoices: choices };
}
