// Histories built for one History view test: the small library and its history with commits of
// the test's own on top, such as a commit of hundreds of files, one with moves and deletions, or
// one with tag and settings changes. Feature folders never import the fake shell
// (eslint.config.js), so they build their histories here.
import type { ChangeKind, EntryKind } from '../ipc';
import type { Fixture } from '../ipc/mock/fixtures/types';
import { scenarioFixture } from '../ipc/mock/scenarios';
import { change, commitId, type FakeChange, type FakeCommit, type FakeMeta, textVersion } from '../ipc/mock/versioning/model';
import { NOW } from './data';

const DAY = 86_400_000;
const CSC = 'Fall 2026/CSC148 Introduction to Computer Science';
const MIDTERM = 'Fall 2026/MAT232 Calculus of Several Variables/Exams/Midterm/Midterm 2025.pdf';
const REVIEW_TAG = { id: 'review', name: 'Review', color: 'blue' };
/** The small history's device. */
const G16 = { id: '8c1e0d2b4a6f43e19d7c5b3a2f1e0d9c', name: 'G16' };

/** A changed file or folder of a test's commit: a text file's unless it says otherwise. */
export interface TestChange {
  change: ChangeKind;
  path: string;
  kind?: EntryKind;
  fromPath?: string;
}

export interface TestCommit {
  summary: string;
  changes?: readonly TestChange[];
  /** That many added files more: "Bulk/file 000.md", "Bulk/file 001.md", … */
  bulk?: number;
  /**
   * That many tag and settings changes, up to four: the ignore rules, a course's settings, the tag
   * definitions, a file's tags.
   */
  metadata?: number;
}

/** The tag and settings changes a test's commit can have, in this order. */
const METADATA: readonly FakeMeta[] = [
  {
    key: 'meta:ignoreRules',
    change: 'modified',
    subject: { kind: 'ignoreRules' },
    detail: null,
    text: { before: ['*.log'], after: ['*.log', '*.tmp'] },
  },
  {
    key: `meta:course:${CSC}`,
    change: 'modified',
    subject: { kind: 'course', path: CSC, folder: null },
    detail: { kind: 'settings', changes: [{ field: 'color', before: 'teal', after: 'green' }] },
    text: null,
  },
  {
    key: 'meta:tagDefinitions',
    change: 'added',
    subject: { kind: 'tagDefinitions' },
    detail: { kind: 'tagDefinitions', changes: [{ id: 'review', before: null, after: { name: 'Review', color: 'blue', order: 7 } }] },
    text: null,
  },
  {
    key: `meta:tags:${MIDTERM}`,
    change: 'modified',
    subject: { kind: 'tags', path: MIDTERM, entryKind: 'file', entry: null },
    detail: { kind: 'tags', added: [REVIEW_TAG], removed: [], now: [REVIEW_TAG] },
    text: null,
  },
];

function testChange({ change: kind, path, kind: entryKind = 'file', fromPath }: TestChange): FakeChange {
  if (entryKind === 'folder') return change({ change: kind, kind: 'folder', path, fromPath });
  const before = textVersion(`${fromPath ?? path}\n`);
  const after = kind === 'moved' ? before : textVersion(`${path}\nedited\n`);
  return change({
    change: kind,
    kind: 'file',
    path,
    fromPath,
    before: kind === 'added' ? null : before,
    after: kind === 'deleted' ? null : after,
  });
}

/**
 * The small library and its history with `commits` made after it, the last one newest: twelve
 * hours ago and a minute apart, on the small history's device.
 */
export function smallHistoryWith(...commits: TestCommit[]): Fixture {
  const { fixture } = scenarioFixture('small', NOW);
  const library = fixture.library;
  const history = library?.history;
  if (library === null || history === undefined) throw new Error('the small fixture has a library and a history');
  library.history = (opened, now) => {
    const seed = history(opened, now);
    const start = Math.floor((now - DAY / 2) / 1000) * 1000;
    commits.forEach(({ summary, changes = [], bulk = 0, metadata = 0 }, index) => {
      const made: FakeCommit = {
        id: commitId(),
        kind: 'commit',
        timeMs: start + index * 60_000,
        summary,
        body: null,
        device: G16,
        changes: [
          ...changes.map(testChange),
          ...Array.from({ length: bulk }, (_, n) =>
            testChange({ change: 'added', path: `Bulk/file ${String(n).padStart(3, '0')}.md` }),
          ),
        ],
        metadata: METADATA.slice(0, metadata).map((meta) => ({ ...meta })),
        pruned: 0,
      };
      seed.commits.push(made);
    });
    return seed;
  };
  return fixture;
}

/**
 * `fixture` without the workspace's change at `path`, as when a test's commit holds it: an added
 * file a test commits is no longer "added", so its history starts at that commit.
 */
export function withoutWorkspaceChange(fixture: Fixture, path: string): Fixture {
  const history = fixture.library?.history;
  if (fixture.library === null || history === undefined) throw new Error('the fixture has a library and a history');
  fixture.library.history = (opened, now) => {
    const seed = history(opened, now);
    return { ...seed, items: seed.items.filter((item) => item.path !== path) };
  };
  return fixture;
}

/**
 * A history that has started but lists nothing (handoff workspace-history §7.5 "Empty", as when a
 * damaged store lost the first commit): `ready`, without commits or operations.
 */
export function emptyHistory(): Fixture {
  const { fixture } = scenarioFixture('history-none', NOW);
  const library = fixture.library;
  const history = library?.history;
  if (library === null || history === undefined) throw new Error('the history-none fixture has a library and a history');
  library.history = (opened, now) => ({ ...history(opened, now), state: 'ready' });
  return fixture;
}
