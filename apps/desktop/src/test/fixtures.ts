// Fixtures built for one view test: a library of a test's own, or the small library with more
// entries. Feature folders never import the fake shell (eslint.config.js), so they build their
// fixtures here.
import type { ChangeKind, EntryKind, Readiness, SyncProvider } from '../ipc';
import { presetTags, SeedBuilder } from '../ipc/mock/fixtures/build';
import { type FolderKind, folderScript } from '../ipc/mock/fixtures/first-run';
import type { Fixture, FolderScript, LibrarySeed, SeedEntry } from '../ipc/mock/fixtures/types';
import { type ScenarioOptions, scenarioFixture } from '../ipc/mock/scenarios';
import { item, textVersion } from '../ipc/mock/versioning/model';
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

/** A change of a workspace a test builds (ipc-m2 §6.2): a text file's unless it says otherwise. */
export interface TestItem {
  change: ChangeKind;
  path: string;
  kind?: EntryKind;
  fromPath?: string;
  readiness?: Readiness;
  required?: boolean;
  /** A folder item's files. */
  files?: number;
  /** Bound changes besides the main one: 1 reads "2 changes". */
  parts?: number;
}

/**
 * The small library and its history with a workspace of the test's own: `items` replace the small
 * workspace's items (the fake keeps them in path order); its four tag and settings changes stay
 * unless `metadata` is false.
 */
export function smallWorkspace(items: readonly TestItem[], { metadata = true }: { metadata?: boolean } = {}): Fixture {
  const { fixture } = scenarioFixture('small', NOW);
  const library = fixture.library;
  const history = library?.history;
  if (library === null || history === undefined) throw new Error('the small fixture has a library and a history');
  library.history = (opened, now) => {
    const seed = history(opened, now);
    return {
      ...seed,
      metadata: metadata ? seed.metadata : [],
      items: items.map(({ parts = 0, kind = 'file', ...fields }) =>
        item({
          ...fields,
          kind,
          before: kind === 'folder' || fields.change === 'added' ? null : textVersion(`${fields.path}\n`),
          after: kind === 'folder' || fields.change === 'deleted' ? null : textVersion(`${fields.path}\nedited\n`),
          parts: Array.from({ length: parts }, () => ({ kind: 'versioningRules' as const })),
        }),
      ),
    };
  };
  return fixture;
}
