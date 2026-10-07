import { describe, expect, it } from 'vitest';

import type { CatalogChanged, EntryChange, EntryRef } from '../ipc';
import type { LibraryQuery } from './keys';
import { comparesWithFiles, isHistoryQuery, isTouched, touches, touchesGone } from './touch';

const ref = (id: string, path: string): EntryRef => ({ id, path });
const noTags = { tags: null, addedAfterMs: null };

const course = ref('10', 'Fall 2026/MAT232');
const lectures = ref('11', 'Fall 2026/MAT232/Lectures');
const lecture = ref('12', 'Fall 2026/MAT232/Lectures/Lecture 01.pdf');
const other = ref('20', 'Fall 2026/CSC148');

const children = (folder: EntryRef | null): LibraryQuery => ({ kind: 'children', folder });
const files = (scope: EntryRef | null): LibraryQuery => ({ kind: 'files', scope });
const search = (scope: EntryRef | null): LibraryQuery => ({ kind: 'search', scope });
const entry = (target: EntryRef): LibraryQuery => ({ kind: 'entry', entry: target });

const added = (target: EntryRef): EntryChange => ({ kind: 'added', entry: target });
const modified = (target: EntryRef): EntryChange => ({ kind: 'modified', entry: target });
const removed = (target: EntryRef): EntryChange => ({ kind: 'removed', entry: target });
const tagged = (target: EntryRef): EntryChange => ({ kind: 'tagged', entry: target });
const moved = (target: EntryRef, from: string): EntryChange => ({ kind: 'moved', entry: target, from });

describe('touches: children of a folder', () => {
  it.each([
    ['added', added(lecture)],
    ['modified', modified(lecture)],
    ['removed', removed(lecture)],
    ['tagged', tagged(lecture)],
  ])('a change %s in the folder touches it, and nothing else', (_kind, change) => {
    expect(touches(children(lectures), change)).toBe(true);
    expect(touches(children(course), change)).toBe(false);
    expect(touches(children(other), change)).toBe(false);
    expect(touches(children(null), change)).toBe(false);
  });

  it('a change at the top level touches the root', () => {
    expect(touches(children(null), added(ref('1', 'Personal')))).toBe(true);
  });

  it('a move touches both the old and the new parent', () => {
    const change = moved(ref('12', 'Fall 2026/CSC148/Lecture 01.pdf'), lecture.path);
    expect(touches(children(lectures), change)).toBe(true);
    expect(touches(children(other), change)).toBe(true);
    expect(touches(children(course), change)).toBe(false);
  });

  it('a tagged folder touches every folder at or below it, whose rows carry its tags', () => {
    const change = tagged(course);
    expect(touches(children(course), change)).toBe(true);
    expect(touches(children(lectures), change)).toBe(true);
    expect(touches(children(ref('1', 'Fall 2026')), change)).toBe(true); // its own row
    expect(touches(children(other), change)).toBe(false);
  });

  it('a folder that moved or went away leaves its own children list and those below it stale', () => {
    const renamed = moved(ref('10', 'Fall 2026/MAT237'), course.path);
    expect(touches(children(course), renamed)).toBe(true);
    expect(touches(children(lectures), renamed)).toBe(true);
    // A key made with the new path was read after the move.
    expect(touches(children(ref('10', 'Fall 2026/MAT237')), renamed)).toBe(false);
    expect(touches(children(lectures), removed(course))).toBe(true);
  });
});

describe('touches: files, counts and search over a scope', () => {
  it.each([
    ['files', files],
    ['search', search],
    ['count of files', (scope: EntryRef | null): LibraryQuery => ({
      kind: 'count',
      request: { of: 'files', scope, filter: noTags },
    })],
  ])('%s: a change anywhere inside the scope touches it', (_name, query) => {
    expect(touches(query(course), added(lecture))).toBe(true);
    expect(touches(query(null), added(lecture))).toBe(true);
    expect(touches(query(other), added(lecture))).toBe(false);
    // Out of the scope and into another one.
    const change = moved(ref('12', 'Fall 2026/CSC148/Lecture 01.pdf'), lecture.path);
    expect(touches(query(course), change)).toBe(true);
    expect(touches(query(other), change)).toBe(true);
    // A folder above the scope was tagged: effective tags inside it changed.
    expect(touches(query(lectures), tagged(course))).toBe(true);
    expect(touches(query(other), tagged(course))).toBe(false);
  });

  it('paths compare as whole names, case included', () => {
    const similar = ref('30', 'Fall 2026/MAT2320/notes.md');
    expect(touches(files(course), added(similar))).toBe(false);
    expect(touches(files(course), added(ref('31', 'fall 2026/MAT232/a.md')))).toBe(false);
  });

  it('a count of children follows the children rule', () => {
    const count: LibraryQuery = { kind: 'count', request: { of: 'children', folder: lectures } };
    expect(touches(count, added(lecture))).toBe(true);
    expect(touches(count, added(ref('40', 'Fall 2026/MAT232/Lectures/Old/a.pdf')))).toBe(false);
  });

  it('the problem count changes only with ProblemsChanged', () => {
    const count: LibraryQuery = { kind: 'count', request: { of: 'problems' } };
    expect(touches(count, added(lecture))).toBe(false);
  });
});

describe('touches: one entry', () => {
  it('changes of the entry itself touch it', () => {
    expect(touches(entry(lecture), modified(lecture))).toBe(true);
    expect(touches(entry(lecture), tagged(lecture))).toBe(true);
    expect(touches(entry(lecture), modified(ref('99', 'Fall 2026/MAT232/Lectures/x.pdf')))).toBe(false);
  });

  it('a tagged folder above it changes its folder tags', () => {
    expect(touches(entry(lecture), tagged(course))).toBe(true);
    expect(touches(entry(lecture), tagged(other))).toBe(false);
  });

  it('the entry, or a folder above it, moving or going away leaves the reference stale', () => {
    expect(touches(entry(lecture), moved(ref('12', 'Fall 2026/MAT232/L1.pdf'), lecture.path))).toBe(true);
    expect(touches(entry(lecture), moved(ref('11', 'Fall 2026/MAT232/Slides'), lectures.path))).toBe(true);
    expect(touches(entry(lecture), removed(course))).toBe(true);
    // Another entry that took the same path does not.
    expect(touches(entry(ref('50', lecture.path)), removed(lecture))).toBe(false);
  });
});

describe('touches: groups, tags, jobs, problems', () => {
  it('semesters and courses follow entries coming, going and moving (course file counts)', () => {
    for (const kind of ['semesters', 'courses'] as const) {
      expect(touches({ kind }, added(lecture))).toBe(true);
      expect(touches({ kind }, removed(lecture))).toBe(true);
      expect(touches({ kind }, moved(lecture, 'a.pdf'))).toBe(true);
      expect(touches({ kind }, modified(lecture))).toBe(false);
      expect(touches({ kind }, tagged(lecture))).toBe(false);
    }
  });

  it('tags follow assignments (usage counts)', () => {
    expect(touches({ kind: 'tags' }, tagged(lecture))).toBe(true);
    expect(touches({ kind: 'tags' }, added(lecture))).toBe(false);
  });

  it('paths a note names follow every change: they may name anything, without case', () => {
    const resolve: LibraryQuery = { kind: 'resolve', base: lecture };
    for (const change of [added(ref('60', 'Personal/a.png')), modified(lecture), tagged(other)]) {
      expect(touches(resolve, change)).toBe(true);
    }
  });

  it('an import check follows what its target folder holds', () => {
    const check: LibraryQuery = { kind: 'importCheck', target: lectures };
    expect(touches(check, added(lecture))).toBe(true);
    expect(touches(check, moved(ref('12', 'Fall 2026/CSC148/Lecture 01.pdf'), lecture.path))).toBe(true);
    expect(touches(check, added(ref('61', 'Fall 2026/CSC148/a.py')))).toBe(false);
    // Names clash, not tags or content.
    expect(touches(check, tagged(lecture))).toBe(false);
    expect(touches(check, tagged(course))).toBe(false);
    expect(touches(check, modified(lecture))).toBe(false);
    // The target itself moved: its reference is stale.
    expect(touches(check, moved(ref('11', 'Fall 2026/MAT232/Slides'), lectures.path))).toBe(true);
  });

  it('jobs and problems never: their own events keep them current', () => {
    for (const change of [added(lecture), removed(lecture), tagged(course)]) {
      expect(touches({ kind: 'jobs' }, change)).toBe(false);
      expect(touches({ kind: 'problems' }, change)).toBe(false);
    }
  });

  it('a query kind this file does not know is touched by every change', () => {
    expect(touches({ kind: 'unknown' }, modified(lecture))).toBe(true);
  });
});

describe('touches: diffs and located versions', () => {
  const workspaceDiff: LibraryQuery = { kind: 'diff', of: { source: 'workspace', key: 'k1' } };
  const versionDiff: LibraryQuery = { kind: 'diff', of: { source: 'version', commit: 'b3:01', key: 'k1' } };
  const everyChange = [
    added(lecture),
    modified(lecture),
    removed(lecture),
    tagged(course),
    moved(ref('12', 'Fall 2026/CSC148/Lecture 01.pdf'), lecture.path),
  ];

  it('no change touches a diff: WorkspaceChanged refreshes a workspace diff, a commit’s stays', () => {
    for (const change of everyChange) {
      expect(touches(workspaceDiff, change)).toBe(false);
      expect(touches(versionDiff, change)).toBe(false);
    }
    expect(touchesGone(workspaceDiff, lecture)).toBe(false);
  });

  it('every change touches a located version: its file may have moved, gone or come back', () => {
    for (const change of everyChange) expect(touches({ kind: 'located' }, change)).toBe(true);
    expect(touchesGone({ kind: 'located' }, lecture)).toBe(true);
  });
});

describe('touches: the history', () => {
  const ofEntry = (target: EntryRef): LibraryQuery => ({ kind: 'fileHistory', file: { kind: 'entry', entry: target } });
  const ofVersion: LibraryQuery = { kind: 'fileHistory', file: { kind: 'version', commit: 'b3:01', path: lecture.path } };
  const plan: LibraryQuery = { kind: 'restorePlan' };
  const commits: LibraryQuery[] = [
    { kind: 'history' },
    { kind: 'commitChanges' },
    { kind: 'commitMetadata' },
    { kind: 'firstCommit' },
    { kind: 'versionChange' },
  ];
  const everyChange = [
    added(lecture),
    modified(lecture),
    removed(lecture),
    tagged(lecture),
    moved(ref('12', 'Fall 2026/CSC148/Lecture 01.pdf'), lecture.path),
  ];

  it('no change touches the timeline, a commit’s rows or the first commit: HistoryChanged refreshes them', () => {
    for (const query of commits) {
      for (const change of everyChange) expect(touches(query, change)).toBe(false);
      expect(isTouched(query, { revision: 5, entries: everyChange, complete: true, tags: true, groups: true, bodies: true })).toBe(false);
      // Not even a rebuilt catalog's.
      expect(isTouched(query, { revision: 6, entries: [], complete: false, tags: false, groups: false, bodies: false })).toBe(false);
    }
    // File histories and restore plans compare versions with the files: a rebuild refreshes them.
    for (const query of [ofEntry(lecture), ofVersion, plan]) {
      expect(isTouched(query, { revision: 6, entries: [], complete: false, tags: false, groups: false, bodies: false })).toBe(true);
    }
  });

  it('an entry’s history follows the entry’s own changes and folders above it, not its tags or other files', () => {
    expect(touches(ofEntry(lecture), modified(lecture))).toBe(true);
    expect(touches(ofEntry(lecture), removed(lecture))).toBe(true);
    expect(touches(ofEntry(lecture), moved(ref('12', 'Fall 2026/CSC148/Lecture 01.pdf'), lecture.path))).toBe(true);
    expect(touches(ofEntry(lecture), moved(ref('10', 'Fall 2026/MAT237'), course.path))).toBe(true);
    expect(touches(ofEntry(lecture), tagged(lecture))).toBe(false);
    expect(touches(ofEntry(lecture), tagged(course))).toBe(false);
    expect(touches(ofEntry(lecture), modified(ref('13', 'Fall 2026/MAT232/Lectures/Lecture 02.pdf')))).toBe(false);
  });

  it('a version’s history and a restore plan follow every change but tags: the file may have moved, gone or come back', () => {
    for (const query of [ofVersion, plan]) {
      for (const change of everyChange) expect(touches(query, change)).toBe(change.kind !== 'tagged');
    }
  });

  it('touchesGone leaves out the history of the entry that is gone: it would answer NotFound', () => {
    expect(touchesGone(ofEntry(lecture), lecture)).toBe(false);
    expect(touchesGone(ofEntry(lecture), lectures)).toBe(false);
    expect(touchesGone(ofEntry(lecture), other)).toBe(false);
    expect(touchesGone(ofVersion, lecture)).toBe(true);
  });

  it('HistoryChanged refreshes every query of the history; WorkspaceChanged file histories and restore plans', () => {
    const others: LibraryQuery[] = [{ kind: 'located' }, { kind: 'diff', of: { source: 'version', commit: 'b3:01', key: 'k1' } }, entry(lecture)];
    for (const query of [...commits, ofEntry(lecture), ofVersion, plan]) expect(isHistoryQuery(query)).toBe(true);
    for (const query of others) expect(isHistoryQuery(query)).toBe(false);
    for (const query of [ofEntry(lecture), ofVersion, plan]) expect(comparesWithFiles(query)).toBe(true);
    for (const query of [...commits, ...others]) expect(comparesWithFiles(query)).toBe(false);
  });
});

describe('touchesGone', () => {
  it('picks what shows an entry the shell no longer has where the UI saw it', () => {
    expect(touchesGone(children(lectures), lecture)).toBe(true);
    expect(touchesGone(files(course), lecture)).toBe(true);
    expect(touchesGone(search(null), lecture)).toBe(true);
    expect(touchesGone({ kind: 'courses' }, lecture)).toBe(true);
    expect(touchesGone({ kind: 'resolve', base: ref('70', 'Fall 2026/MAT232/notes.md') }, lecture)).toBe(true);
    expect(touchesGone(children(other), lecture)).toBe(false);
    expect(touchesGone({ kind: 'tags' }, lecture)).toBe(false);
  });

  it('leaves out queries keyed by it or by something below it: they would answer NotFound', () => {
    expect(touchesGone(entry(lecture), lecture)).toBe(false);
    expect(touchesGone(children(lectures), lectures)).toBe(false);
    expect(touchesGone(files(lectures), course)).toBe(false);
    expect(touchesGone({ kind: 'resolve', base: lecture }, lecture)).toBe(false);
    expect(touchesGone({ kind: 'importCheck', target: lectures }, course)).toBe(false);
    // The list that showed the folder is refreshed.
    expect(touchesGone(children(course), lectures)).toBe(true);
  });
});

describe('isTouched', () => {
  const event = (overrides: Partial<CatalogChanged>): CatalogChanged => ({
    revision: 5,
    entries: [],
    complete: true,
    tags: false,
    groups: false,
    bodies: false,
    ...overrides,
  });

  it('`complete: false` touches everything', () => {
    for (const query of [children(null), { kind: 'jobs' } as const, entry(lecture)]) {
      expect(isTouched(query, event({ complete: false }))).toBe(true);
    }
  });

  it('`tags` touches the tag list and `groups` the semesters and courses', () => {
    expect(isTouched({ kind: 'tags' }, event({ tags: true }))).toBe(true);
    expect(isTouched({ kind: 'semesters' }, event({ groups: true }))).toBe(true);
    expect(isTouched({ kind: 'courses' }, event({ groups: true }))).toBe(true);
    expect(isTouched({ kind: 'tags' }, event({ groups: true }))).toBe(false);
    expect(isTouched(children(null), event({ tags: true, groups: true }))).toBe(false);
  });

  it('`tags` touches every search too, since tag names are searched', () => {
    expect(isTouched(search(course), event({ tags: true }))).toBe(true);
    expect(isTouched(search(null), event({ groups: true }))).toBe(false);
  });

  it('`bodies` alone touches every search, whatever its scope, and no other query (ipc-m1 §15.1)', () => {
    // One query of every kind: `tsc` fails here when a kind is added.
    const every: { [Kind in LibraryQuery['kind']]: Extract<LibraryQuery, { kind: Kind }> } = {
      workspace: { kind: 'workspace', part: 'summary' },
      children: { kind: 'children', folder: null },
      files: { kind: 'files', scope: null },
      count: { kind: 'count', request: { of: 'files', scope: null, filter: noTags } },
      search: { kind: 'search', scope: lecture },
      entry: { kind: 'entry', entry: lecture },
      semesters: { kind: 'semesters' },
      courses: { kind: 'courses' },
      tags: { kind: 'tags' },
      resolve: { kind: 'resolve', base: lecture },
      importCheck: { kind: 'importCheck', target: lectures },
      jobs: { kind: 'jobs' },
      problems: { kind: 'problems' },
      ignoreRules: { kind: 'ignoreRules' },
      diff: { kind: 'diff', of: { source: 'workspace', key: 'k1' } },
      located: { kind: 'located' },
      history: { kind: 'history' },
      commitChanges: { kind: 'commitChanges' },
      commitMetadata: { kind: 'commitMetadata' },
      fileHistory: { kind: 'fileHistory', file: { kind: 'entry', entry: lecture } },
      firstCommit: { kind: 'firstCommit' },
      restorePlan: { kind: 'restorePlan' },
      versionChange: { kind: 'versionChange' },
      unknown: { kind: 'unknown' },
    };
    const bodies = event({ bodies: true });
    for (const query of Object.values(every)) {
      expect(isTouched(query, bodies), query.kind).toBe(query.kind === 'search');
    }
    for (const scope of [null, course, other]) expect(isTouched(search(scope), bodies)).toBe(true);
  });

  it('otherwise any listed change decides', () => {
    expect(isTouched(children(lectures), event({ entries: [added(ref('1', 'x')), added(lecture)] }))).toBe(true);
    expect(isTouched(children(lectures), event({ entries: [added(ref('1', 'x'))] }))).toBe(false);
  });

  it('never touches a diff, not even after a rebuild, and touches located versions with any change', () => {
    const diff: LibraryQuery = { kind: 'diff', of: { source: 'workspace', key: 'k1' } };
    for (const flags of [{ complete: false }, { tags: true, groups: true }, { entries: [modified(lecture)] }]) {
      expect(isTouched(diff, event(flags))).toBe(false);
    }
    expect(isTouched({ kind: 'located' }, event({ complete: false }))).toBe(true);
    expect(isTouched({ kind: 'located' }, event({ entries: [modified(other)] }))).toBe(true);
    expect(isTouched({ kind: 'located' }, event({ tags: true }))).toBe(false);
  });
});
