// The fake shell against the contract it stands in for (docs/specs/ipc-m1.md), through the real
// generated bindings: what a UI lane sees in the browser pane and in view tests.
import { mockIPC } from '@tauri-apps/api/mocks';
import { afterEach, describe, expect, it } from 'vitest';

import { startAppearance } from '../../app/appearance';
import { unwrap } from '../../data/errors';
import {
  type AppSettingsChanged,
  type CatalogChanged,
  type EntryRef,
  type EntryRow,
  type IgnoreRulesChanged,
  type IpcError,
  ipc,
  type JobChanged,
  LIMITS,
  shellEvents,
} from '..';
import { installFakeShell, optionsFromUrl, scenarioFixture } from '.';
import { folderScript } from './fixtures/first-run';
import { LARGE_ENTRIES, largeLibrary } from './fixtures/large';
import type { Fixture } from './fixtures/types';
import type { FakeShell } from './shell';

const NOW = Date.UTC(2026, 8, 30, 12);
const NAME = { key: 'name', descending: false } as const;
const PAGE = { offset: 0, limit: 200 };
const NO_FILTER = { tags: null, addedAfterMs: null };

let shell: FakeShell | undefined;

function install(scenario: Parameters<typeof scenarioFixture>[0] = 'small', fixture?: Fixture) {
  shell = installFakeShell({
    fixture: fixture ?? scenarioFixture(scenario, NOW).fixture,
    now: () => NOW,
    jobStepMs: 1,
  });
  return shell;
}

afterEach(() => {
  shell?.dispose();
  shell = undefined;
  mockIPC(() => undefined, { shouldMockEvents: true });
});

/** The error a call resolved to. */
async function failure(call: Promise<{ status: string; error?: IpcError }>) {
  const result = await call;
  if (result.status !== 'error' || result.error === undefined) throw new Error('call succeeded');
  return result.error.code;
}

async function childrenOf(folder: EntryRef | null) {
  return unwrap(ipc.listChildren({ folder, sort: NAME, page: PAGE }));
}

async function entryAt(path: string): Promise<EntryRow> {
  const names = path.split('/');
  let folder: EntryRef | null = null;
  let found: EntryRow | undefined;
  for (const name of names) {
    found = (await childrenOf(folder)).items.find((item) => item.name === name);
    if (found === undefined) break;
    folder = found;
  }
  if (found === undefined) throw new Error(`no ${path}`);
  return found;
}

function collect<T>(subscribe: (onEvent: (payload: T) => void) => () => void) {
  const seen: T[] = [];
  const stop = subscribe((payload) => seen.push(payload));
  return { seen, stop };
}

// Merged CatalogChanged events, and every event already queued, reach their listeners.
const settle = async () => {
  await shell?.flush();
};

describe('library', () => {
  it('reports the open library, its semesters in order and its courses with file counts', async () => {
    install();
    const status = await unwrap(ipc.libraryStatus());
    expect(status).toMatchObject({ state: 'open', library: { name: 'University of Toronto' } });

    const semesters = await unwrap(ipc.listSemesters());
    expect(semesters.map((semester) => [semester.name, semester.archived])).toEqual([
      ['Fall 2025', true],
      ['Winter 2026', false],
      ['Fall 2026', false],
      ['Personal', false],
    ]);
    const fall = semesters[2]?.folder ?? null;
    const courses = await unwrap(ipc.listCourses({ semester: fall }));
    expect(courses.map((course) => [course.code, course.abbr])).toEqual([
      ['MAT232', 'MAT'],
      ['MAT223', '线代'],
      ['CSC148', null],
      [null, null],
    ]);
    expect(courses[0]?.files).toBe(27);
    expect((await unwrap(ipc.listCourses({ semester: null }))).length).toBeGreaterThan(courses.length);
  });

  it('answers NoLibrary before the first run made one', async () => {
    install('first-run');
    await expect(unwrap(ipc.libraryStatus())).resolves.toEqual({ state: 'none' });
    expect(await failure(ipc.listSemesters())).toBe('NoLibrary');
    expect(await failure(ipc.listJobs())).toBe('NoLibrary');
  });

  it('creates a library from a single-use folder token, and says so', async () => {
    install('first-run');
    const states = collect(shellEvents.onLibraryStateChanged);
    const choice = await unwrap(ipc.pickLibraryFolder());
    expect(choice).toMatchObject({ content: { kind: 'empty' }, syncRoot: null });
    const token = choice?.token ?? '';
    expect(token).toMatch(/^[0-9a-f]{32}$/);

    const presetTags = { notes: 'Notes', slides: 'Slides', homework: 'Homework', exam: 'Exams', reference: 'Reference' };
    expect(await failure(ipc.createLibrary({ folder: token, name: '  ', presetTags }))).toBe('NameEmpty');
    const opened = await unwrap(ipc.createLibrary({ folder: token, name: 'Uni', presetTags }));
    expect(opened.library.name).toBe('Uni');
    expect(await failure(ipc.createLibrary({ folder: token, name: 'Uni', presetTags }))).toBe(
      'ChoiceExpired',
    );
    await settle();
    states.stop();
    expect(states.seen.at(-1)?.status).toMatchObject({ state: 'open', library: { name: 'Uni' } });
    expect((await unwrap(ipc.listTags())).map((tag) => [tag.id, tag.color])).toEqual([
      ['notes', 'blue'],
      ['slides', 'green'],
      ['homework', 'orange'],
      ['exam', 'red'],
      ['reference', 'stone'],
    ]);
  });

  it('takes a folder over: the scan finds its content and reports it', async () => {
    const fixture = scenarioFixture('first-run', NOW).fixture;
    install('first-run', { ...fixture, folderChoices: [folderScript('folders', NOW)] });
    const catalog = collect(shellEvents.onCatalogChanged);
    const choice = await unwrap(ipc.pickLibraryFolder());
    const presetTags = { notes: 'N', slides: 'S', homework: 'H', exam: 'E', reference: 'R' };
    await unwrap(ipc.createLibrary({ folder: choice?.token ?? '', name: 'University', presetTags }));
    shell?.finishJobs();
    await settle();
    catalog.stop();

    expect((await unwrap(ipc.listSemesters())).length).toBe(4);
    expect(catalog.seen.some((event) => event.groups)).toBe(true);
    const jobs = await unwrap(ipc.listJobs());
    expect(jobs.map((job) => [job.kind, job.status.state])).toEqual([
      ['hash', 'done'],
      ['scan', 'done'],
    ]);
  });

  it('refuses a token of the other kind without using it up, and folders in a library', async () => {
    install('small');
    const choice = await unwrap(ipc.pickLibraryFolder()); // the small library's own folder
    const token = choice?.token ?? '';
    expect(await failure(ipc.checkImport({ source: token, target: { id: '1', path: 'x' } }))).toBe(
      'ChoiceExpired',
    );
    const presetTags = { notes: 'N', slides: 'S', homework: 'H', exam: 'E', reference: 'R' };
    expect(await failure(ipc.createLibrary({ folder: token, name: 'X', presetTags }))).toBe(
      'AlreadyALibrary',
    );
  });

  it('keeps an unavailable library unavailable until it can be reached', async () => {
    install('unavailable');
    await expect(unwrap(ipc.libraryStatus())).resolves.toMatchObject({ state: 'unavailable', reason: 'missing' });
    shell?.makeReachable();
    await expect(unwrap(ipc.libraryStatus())).resolves.toMatchObject({ state: 'open' });
  });
});

describe('entries', () => {
  it('pages children folders first, in File Explorer name order, with totals and the revision', async () => {
    install();
    const csc = await entryAt('Fall 2026/CSC148 Introduction to Computer Science');
    const page = await childrenOf(csc);
    expect(page.items.map((row) => row.name)).toEqual([
      'a1',
      'labs',
      'hw1.py',
      'hw2.py',
      'hw3.py',
      'hw10.py',
      'hw11.py',
      'hw12.py',
      'README.md',
    ]);
    expect(page).toMatchObject({ offset: 0, total: 9, revision: 0 });
    const second = await unwrap(ipc.listChildren({ folder: csc, sort: NAME, page: { offset: 4, limit: 2 } }));
    expect(second.items.map((row) => row.name)).toEqual(['hw3.py', 'hw10.py']);
    const count = await unwrap(ipc.listChildren({ folder: csc, sort: NAME, page: { offset: 0, limit: 0 } }));
    expect(count).toMatchObject({ items: [], total: 9 });
  });

  it('checks references and limits', async () => {
    install();
    const csc = await entryAt('Fall 2026/CSC148 Introduction to Computer Science');
    const file = await entryAt('Fall 2026/CSC148 Introduction to Computer Science/hw1.py');
    const tooBig = { offset: 0, limit: LIMITS.pageSize + 1 };
    expect(await failure(ipc.listChildren({ folder: csc, sort: NAME, page: tooBig }))).toBe('InvalidArgument');
    expect(await failure(ipc.listChildren({ folder: { ...csc, path: 'Fall 2026/csc148' }, sort: NAME, page: PAGE }))).toBe('NotFound');
    expect(await failure(ipc.listChildren({ folder: file, sort: NAME, page: PAGE }))).toBe('InvalidArgument');
    expect(await failure(ipc.getEntry({ entry: { id: file.id, path: 'hw1.py' } }))).toBe('NotFound');
  });

  it('lists files by effective tags: folder tags reach every file below them', async () => {
    install();
    const mat = await entryAt('Fall 2026/MAT232 Calculus of Several Variables');
    const list = (tags: { kind: 'withAll'; tags: string[] } | { kind: 'untagged' }) =>
      unwrap(ipc.listFiles({ scope: mat, filter: { tags, addedAfterMs: null }, sort: NAME, page: PAGE }));

    const exams = await list({ kind: 'withAll', tags: ['exam'] });
    expect(exams.items.map((row) => row.name)).toEqual(['Midterm 2025.pdf', 'Midterm review.md']);
    expect(exams.items[1]).toMatchObject({ tags: ['notes'], folderTags: ['exam'] });
    const both = await list({ kind: 'withAll', tags: ['exam', 'notes'] });
    expect(both.items.map((row) => row.name)).toEqual(['Midterm review.md']);
    expect((await list({ kind: 'untagged' })).total).toBe(0);
    expect(await failure(ipc.listFiles({ scope: mat, filter: { tags: { kind: 'withAll', tags: [] }, addedAfterMs: null }, sort: NAME, page: PAGE }))).toBe('InvalidArgument');

    const recent = await unwrap(
      ipc.listFiles({ scope: null, filter: { tags: null, addedAfterMs: String(NOW - 7 * 86_400_000) }, sort: { key: 'added', descending: true }, page: PAGE }),
    );
    expect(recent.items.slice(0, 2).map((row) => row.name)).toEqual(['笔记.md', 'IMG_2031.HEIC']);
    expect(recent.items.every((row) => Number(row.addedMs) > NOW - 7 * 86_400_000)).toBe(true);
  });

  it('sorts missing modification times last in both directions', async () => {
    install();
    const personal = await entryAt('Personal');
    for (const descending of [false, true]) {
      const page = await unwrap(
        ipc.listFiles({ scope: personal, filter: NO_FILTER, sort: { key: 'modified', descending }, page: PAGE }),
      );
      expect(page.items.at(-1)?.name).toBe('Old backup.zip');
    }
  });

  it('resolves paths relative to a note, as Windows matches names', async () => {
    install();
    const note = await entryAt('Fall 2026/MAT232 Calculus of Several Variables/week 2 notes.md');
    const rows = await unwrap(
      ipc.resolvePaths({
        base: note,
        paths: ['Lectures/Lecture 01.pdf', './lectures/lecture 02.PDF', '../线性代数/笔记.md', 'Lectures', '/etc/passwd', 'https://x.y/a.png', '../../../../a'],
      }),
    );
    expect(rows.map((row) => row?.name ?? null)).toEqual(['Lecture 01.pdf', 'Lecture 02.pdf', '笔记.md', null, null, null, null]);
    const tooMany = Array.from({ length: LIMITS.resolvePaths + 1 }, () => 'a.png');
    expect(await failure(ipc.resolvePaths({ base: note, paths: tooMany }))).toBe('InvalidArgument');
  });

  it('renames: the id stays, the old reference goes stale, and CatalogChanged reports the move', async () => {
    install();
    const catalog = collect(shellEvents.onCatalogChanged);
    const file = await entryAt('Fall 2026/CSC148 Introduction to Computer Science/hw1.py');
    const renamed = await unwrap(ipc.renameEntry({ entry: file, name: '  hw01.py ' }));
    expect(renamed).toMatchObject({ id: file.id, name: 'hw01.py' });
    expect(await failure(ipc.getEntry({ entry: file }))).toBe('NotFound');
    expect(await failure(ipc.renameEntry({ entry: renamed, name: 'HW2.py' }))).toBe('AlreadyExists');
    expect(await failure(ipc.renameEntry({ entry: renamed, name: 'a:b' }))).toBe('NameInvalidCharacter');
    expect(await failure(ipc.renameEntry({ entry: renamed, name: 'nul.txt' }))).toBe('NameReserved');
    expect(await failure(ipc.renameEntry({ entry: renamed, name: 'end.' }))).toBe('NameTrailingDotOrSpace');
    await settle();
    catalog.stop();
    expect(catalog.seen).toEqual<CatalogChanged[]>([
      {
        revision: 1,
        entries: [{ kind: 'moved', entry: { id: file.id, path: renamed.path }, from: file.path }],
        complete: true,
        tags: false,
        groups: false,
      },
    ]);
    expect((await childrenOf(null)).revision).toBe(1);
  });

  it('moves and deletes item by item, listing every failure', async () => {
    install();
    const csc = await entryAt('Fall 2026/CSC148 Introduction to Computer Science');
    const phy = await entryAt('Winter 2026/PHY131 Introduction to Physics I');
    const semester = await entryAt('Winter 2026');
    const hw = await entryAt('Fall 2026/CSC148 Introduction to Computer Science/hw2.py');
    const held = await entryAt('Fall 2026/ECO101 微观经济学/Lecture recording week 5.mp4');
    const stale = { id: hw.id, path: 'nowhere.py' };

    const moved = await unwrap(ipc.moveEntries({ entries: [hw, held, semester, stale, csc], to: phy }));
    expect(moved.done).toBe(2); // hw2.py, and CSC148 into PHY131 (as File Explorer would)
    expect(moved.failed.map((item) => item.error.code)).toEqual(['InUse', 'InvalidMove', 'NotFound']);

    const archive = await entryAt('Personal/Archive/2024/Scans/Receipts');
    const deleted = await unwrap(ipc.deleteEntries({ entries: [archive, stale] }));
    expect(deleted.done).toBe(0);
    expect(deleted.failed.map((item) => item.error.code)).toEqual(['NotRecyclable', 'NotFound']);
    expect(await failure(ipc.moveEntries({ entries: [hw], to: stale }))).toBe('NotFound');
  });

  it('reports tags a move strands as a new problem; the others keep their ids', async () => {
    install();
    const problems = collect(shellEvents.onProblemsChanged);
    const page = { page: { offset: 0, limit: 100 } };
    const before = await unwrap(ipc.listProblems(page));
    const sets = await entryAt('Fall 2026/MAT232 Calculus of Several Variables/Problem sets');
    const winter = await entryAt('Winter 2026');

    // Directly in a semester, the folder becomes a course, which carries no tags (ipc-m1 §9.2).
    await expect(unwrap(ipc.moveEntries({ entries: [sets], to: winter }))).resolves.toEqual({ done: 1, failed: [] });
    await settle();
    problems.stop();

    const after = await unwrap(ipc.listProblems(page));
    expect(after.items.slice(0, before.total)).toEqual(before.items);
    expect(after.items.at(-1)?.problem).toEqual({
      kind: 'notRelocated',
      from: sets.path,
      to: 'Winter 2026/Problem sets',
      cause: 'folderTags',
    });
    expect(problems.seen).toEqual([{ total: before.total + 1 }]);
  });

  it('makes folders only inside courses', async () => {
    install();
    const semester = await entryAt('Fall 2026');
    const course = await entryAt('Fall 2026/ECO101 微观经济学');
    expect(await failure(ipc.createFolder({ parent: semester, name: 'x' }))).toBe('InvalidArgument');
    const made = await unwrap(ipc.createFolder({ parent: course, name: 'Week 1' }));
    expect(made).toMatchObject({ kind: 'folder', class: 'other', size: '0' });
    expect(await failure(ipc.createFolder({ parent: course, name: 'week 1' }))).toBe('AlreadyExists');
  });

  it('reports more than eventEntries changes as one incomplete event', async () => {
    install('large');
    const catalog = collect(shellEvents.onCatalogChanged);
    const roll = await entryAt('Personal/Photos/Camera Roll');
    const photos = await unwrap(ipc.listChildren({ folder: roll, sort: NAME, page: { offset: 0, limit: 300 } }));
    const done = await unwrap(ipc.setEntryTags({ entries: photos.items, add: ['reference'], remove: [] }));
    expect(done).toEqual({ done: 300, failed: [] });
    await settle();
    catalog.stop();
    expect(catalog.seen).toEqual([{ revision: 1, entries: [], complete: false, tags: false, groups: false }]);
  });
});

describe('tags', () => {
  it('creates, renames, reorders and deletes tags, and assigns them', async () => {
    install();
    const catalog = collect(shellEvents.onCatalogChanged);
    expect(await failure(ipc.createTag({ name: 'notes', color: 'blue' }))).toBe('AlreadyExists');
    expect(await failure(ipc.createTag({ name: 'Lab', color: 'Blue!' }))).toBe('InvalidArgument');
    const lab = await unwrap(ipc.createTag({ name: 'Lab', color: 'teal' }));
    expect(lab).toMatchObject({ name: 'Lab', usage: 0 });
    expect(lab.id).toMatch(/^[0-9a-f]{16}$/);

    const file = await entryAt('Fall 2026/CSC148 Introduction to Computer Science/labs/lab1/lab1.py');
    const course = await entryAt('Fall 2026/CSC148 Introduction to Computer Science');
    expect(await failure(ipc.setEntryTags({ entries: [file], add: ['notes'], remove: ['notes'] }))).toBe('InvalidArgument');
    const result = await unwrap(ipc.setEntryTags({ entries: [file, course], add: [lab.id, 'notes'], remove: [] }));
    expect(result.done).toBe(1);
    expect(result.failed[0]?.error.code).toBe('InvalidArgument');
    expect(await unwrap(ipc.getEntry({ entry: file }))).toMatchObject({ tags: ['notes', lab.id] });

    const ids = (await unwrap(ipc.listTags())).map((tag) => tag.id);
    expect(await failure(ipc.reorderTags({ tags: ids.slice(1) }))).toBe('InvalidArgument');
    const reordered = await unwrap(ipc.reorderTags({ tags: [...ids].reverse() }));
    expect(reordered[0]?.id).toBe(lab.id);
    await expect(unwrap(ipc.deleteTag({ id: lab.id }))).resolves.toEqual({ assignments: 1 });
    await settle();
    catalog.stop();
    expect(catalog.seen.some((event) => event.tags)).toBe(true);
    expect(catalog.seen.flatMap((event) => event.entries).filter((change) => change.kind === 'tagged')).toHaveLength(2);
  });

  it('refuses metadata changes in a read-only library', async () => {
    install('read-only');
    expect(await failure(ipc.createTag({ name: 'Lab', color: 'teal' }))).toBe('ReadOnly');
    expect(await failure(ipc.createSemester({ name: 'Summer 2027' }))).toBe('ReadOnly');
    await expect(unwrap(ipc.listTags())).resolves.not.toHaveLength(0);
  });
});

describe('semesters and courses', () => {
  it('creates them last in their order, checks badges and codes, and reorders', async () => {
    install();
    const semester = await unwrap(ipc.createSemester({ name: 'Winter 2027' }));
    expect((await unwrap(ipc.listSemesters())).at(-1)?.name).toBe('Winter 2027');
    const course = { semester: semester.folder, name: 'MAT301 Groups and Symmetry', code: 'MAT301', color: 'blue' };
    expect(await failure(ipc.createCourse({ ...course, abbr: 'ABCD' }))).toBe('NameTooLong');
    expect(await failure(ipc.createCourse({ ...course, abbr: 'A B' }))).toBe('NameInvalidCharacter');
    const made = await unwrap(ipc.createCourse({ ...course, abbr: '群论' }));
    expect(made).toMatchObject({ abbr: '群论', code: 'MAT301', files: 0 });
    const updated = await unwrap(ipc.updateCourse({ course: made.folder, abbr: null, code: null, color: null, archived: true }));
    expect(updated).toMatchObject({ abbr: null, code: null, color: null, archived: true });

    const semesters = await unwrap(ipc.listSemesters());
    const reversed = semesters.map((item) => item.folder).reverse();
    const reordered = await unwrap(ipc.reorderSemesters({ semesters: reversed }));
    expect(reordered[0]?.name).toBe('Winter 2027');
    expect(await failure(ipc.reorderSemesters({ semesters: reversed.slice(1) }))).toBe('InvalidArgument');
  });
});

describe('search', () => {
  it('finds names, tags, paths and body text, with highlights as spans', async () => {
    install();
    const page = await unwrap(ipc.search({ text: 'midterm', scope: null, page: { offset: 0, limit: 50 } }));
    expect(page.items[0]?.entry.name).toMatch(/^Midterm/);
    expect(page.items[0]?.name).toEqual([
      { text: 'Midterm', matched: true },
      { text: page.items[0]?.entry.name.slice(7), matched: false },
    ]);
    const body = await unwrap(ipc.search({ text: '拉格朗日', scope: null, page: { offset: 0, limit: 50 } }));
    expect(body.items.map((hit) => hit.entry.name)).toEqual(['Midterm review.md']);
    expect(body.items[0]?.snippet?.some((span) => span.matched && span.text === '拉格朗日')).toBe(true);
  });

  it('checks the length first, then the window; blank text finds nothing', async () => {
    install();
    const long = 'a'.repeat(LIMITS.queryChars + 1);
    expect(await failure(ipc.search({ text: long, scope: { id: '0', path: 'x' }, page: { offset: 0, limit: 50 } }))).toBe('QueryTooLong');
    expect(await failure(ipc.search({ text: 'a', scope: null, page: { offset: 480, limit: 50 } }))).toBe('InvalidArgument');
    await expect(unwrap(ipc.search({ text: '   ', scope: null, page: { offset: 0, limit: 50 } }))).resolves.toMatchObject({ items: [], more: false });
  });

  it('pages one ranked window, with `more` until it ends', async () => {
    install();
    const first = await unwrap(ipc.search({ text: 'pdf', scope: null, page: { offset: 0, limit: 10 } }));
    const second = await unwrap(ipc.search({ text: 'pdf', scope: null, page: { offset: 10, limit: 50 } }));
    expect(first.more).toBe(true);
    expect(second.more).toBe(false);
    const ids = [...first.items, ...second.items].map((hit) => hit.entry.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('jobs', () => {
  it('rebuilds the catalog: writes are Busy meanwhile, then every id is new', async () => {
    install();
    const catalog = collect(shellEvents.onCatalogChanged);
    const jobs = collect(shellEvents.onJobChanged);
    const file = await entryAt('Personal/Todo.txt');
    const id = await unwrap(ipc.rebuildCatalog());
    expect(await failure(ipc.renameEntry({ entry: file, name: 'x.txt' }))).toBe('Busy');
    expect(await failure(ipc.rebuildCatalog())).toBe('Busy');
    shell?.finishJobs();
    await settle();
    catalog.stop();
    jobs.stop();

    expect(jobs.seen.filter((event: JobChanged) => event.job.id === id).map((event) => event.job.status.state)).toEqual(
      expect.arrayContaining(['queued', 'running', 'done']),
    );
    expect(catalog.seen.at(-1)).toMatchObject({ complete: false });
    expect(await failure(ipc.getEntry({ entry: file }))).toBe('NotFound');
    expect((await entryAt('Personal/Todo.txt')).id).not.toBe(file.id);
  });

  it('cancels a queued job at once and refuses an unknown one', async () => {
    install();
    const first = await unwrap(ipc.rebuildCatalog());
    await expect(unwrap(ipc.cancelJob({ job: first }))).resolves.toBeNull();
    expect((await unwrap(ipc.listJobs()))[0]?.status).toEqual({ state: 'cancelled' });
    expect(await failure(ipc.cancelJob({ job: first }))).toBe('NotFound');
  });
});

describe('import', () => {
  it('checks, then imports with one clash policy; ignored items stay out', async () => {
    install();
    const course = await entryAt('Fall 2026/CSC148 Introduction to Computer Science');
    await unwrap(ipc.createFolder({ parent: course, name: 'Lab 2' }));
    const source = await unwrap(ipc.pickImportFiles());
    expect(source).toMatchObject({ files: 2, folders: 1 });
    const token = source?.token ?? '';

    const check = await unwrap(ipc.checkImport({ source: token, target: course }));
    expect(check).toMatchObject({
      files: 4,
      folders: 1,
      skipped: 2,
      conflicts: [{ path: `${course.path}/hw3.py` }],
      conflictCount: 1,
    });

    const job = await unwrap(
      ipc.importFiles({ source: token, target: course, tags: ['reference'], onConflict: 'keepBoth', deleteOriginals: true }),
    );
    expect(await failure(ipc.checkImport({ source: token, target: course }))).toBe('ChoiceExpired');
    shell?.finishJobs();
    const done = (await unwrap(ipc.listJobs())).find((item) => item.id === job);
    expect(done?.status).toMatchObject({
      state: 'done',
      result: { kind: 'import', imported: 4, renamed: 1, skipped: 2, originalsDeleted: 2 },
    });
    await expect(entryAt(`${course.path}/hw3 (2).py`)).resolves.toMatchObject({ tags: ['reference'] });
    const pdf = await entryAt('Fall 2026/CSC148 Introduction to Computer Science/Lecture 05 - Gradients.pdf');
    expect(pdf.tags).toEqual(['reference']);
    await expect(entryAt('Fall 2026/CSC148 Introduction to Computer Science/Lab 2/report.docx')).resolves.toMatchObject({ folderTags: [] });
  });

  it('drops files: DropHover, then FilesDropped with a token for check_import', async () => {
    install();
    const hovers = collect(shellEvents.onDropHover);
    const drops = collect(shellEvents.onFilesDropped);
    shell?.dropFiles();
    await settle();
    hovers.stop();
    drops.stop();
    expect(hovers.seen.map((event) => event.position)).toEqual([{ x: 480, y: 320 }, null]);
    const course = await entryAt('Fall 2026/CSC148 Introduction to Computer Science');
    const token = drops.seen[0]?.source.token ?? '';
    await expect(unwrap(ipc.checkImport({ source: token, target: course }))).resolves.toMatchObject({ files: 4 });
  });
});

describe('the fake itself', () => {
  it('fails commands on request, and refuses unknown ones as Transport', async () => {
    install();
    shell?.setFailure('list_tags', 'Internal');
    expect(await failure(ipc.listTags())).toBe('Internal');
    shell?.setFailure('list_tags', null);
    await expect(unwrap(ipc.listTags())).resolves.not.toHaveLength(0);
    const { invoke } = await import('@tauri-apps/api/core');
    await expect(invoke('no_such_command')).rejects.toMatch(/not allowed/);
  });

  it('refuses lone surrogates, as the shell’s JSON parser does', async () => {
    install();
    const report = { kind: 'uncaught', source: 'test', message: 'broken \uD800', stack: null } as const;
    expect(await failure(ipc.logUiError(report))).toBe('Transport');
    expect(await failure(ipc.logUiError({ ...report, message: 'ok', source: 'has space' }))).toBe('InvalidArgument');
    await expect(unwrap(ipc.logUiError({ ...report, message: 'ok' }))).resolves.toBeNull();
    expect(shell?.log).toHaveLength(1);
  });

  it('answers the title bar’s window commands', async () => {
    install();
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    await expect(getCurrentWindow().isMaximized()).resolves.toBe(false);
  });

  it('generates the large library: exactly 50,000 entries, parents first, unique NFC paths', () => {
    const started = performance.now();
    const seed = largeLibrary(NOW);
    const elapsed = performance.now() - started;
    expect(seed.entries).toHaveLength(LARGE_ENTRIES);
    const paths = new Set<string>();
    for (const entry of seed.entries) {
      const slash = entry.path.lastIndexOf('/');
      if (slash !== -1) expect(paths.has(entry.path.slice(0, slash))).toBe(true);
      expect(entry.path.normalize('NFC')).toBe(entry.path);
      paths.add(entry.path);
    }
    expect(paths.size).toBe(LARGE_ENTRIES);
    expect(largeLibrary(NOW).entries.map((entry) => entry.path)).toEqual([...paths]);
    expect(elapsed).toBeLessThan(2000);
  });

  it('pages the whole large library quickly once sorted', async () => {
    install('large');
    const request = { scope: null, filter: NO_FILTER, sort: NAME };
    const first = await unwrap(ipc.listFiles({ ...request, page: { offset: 0, limit: 200 } }));
    const started = performance.now();
    const far = await unwrap(ipc.listFiles({ ...request, page: { offset: first.total - 200, limit: 200 } }));
    expect(performance.now() - started).toBeLessThan(100);
    expect(far.total).toBe(first.total);
    expect(far.items).toHaveLength(200);
  });
});

describe('App settings (ipc-m1 §22)', () => {
  it('start with Windows’ appearance and change one field at a time', async () => {
    install();
    const changes = collect<AppSettingsChanged>(shellEvents.onAppSettingsChanged);
    expect(await unwrap(ipc.getAppSettings())).toEqual({
      deviceName: 'G16',
      theme: 'system',
      reduceMotion: 'system',
    });
    const dark = await unwrap(ipc.updateAppSettings({ deviceName: null, theme: 'dark', reduceMotion: null }));
    expect(dark).toEqual({ deviceName: 'G16', theme: 'dark', reduceMotion: 'system' });
    const named = await unwrap(
      ipc.updateAppSettings({ deviceName: '  Café PC ', theme: null, reduceMotion: 'on' }),
    );
    expect(named).toEqual({ deviceName: 'Café PC', theme: 'dark', reduceMotion: 'on' });
    // Nothing new: no event.
    await unwrap(ipc.updateAppSettings({ deviceName: 'Café PC', theme: 'dark', reduceMotion: null }));
    await settle();
    expect(changes.seen).toEqual([{ settings: dark }, { settings: named }]);
    changes.stop();
  });

  it('refuse device names that break the display name rules, and change nothing else', async () => {
    install();
    const blank = ipc.updateAppSettings({ deviceName: ' ', theme: 'light', reduceMotion: null });
    expect(await failure(blank)).toBe('NameEmpty');
    const long = '字'.repeat(LIMITS.displayNameChars + 1);
    expect(await failure(ipc.updateAppSettings({ deviceName: long, theme: null, reduceMotion: null }))).toBe(
      'NameTooLong',
    );
    expect((await unwrap(ipc.getAppSettings())).theme).toBe('system');
  });

  it('come from the browser pane’s URL', () => {
    const { fixture } = optionsFromUrl('?scenario=first-run&theme=dark&motion=on', NOW);
    expect(fixture.appSettings).toMatchObject({ theme: 'dark', reduceMotion: 'on' });
    expect(optionsFromUrl('?theme=purple', NOW).fixture.appSettings).toMatchObject({ theme: 'system' });
  });

  it('set the root: the stored appearance, then every change', async () => {
    install().saveAppSettings({ deviceName: 'G16', theme: 'dark', reduceMotion: 'off' });
    await settle();
    const root = document.createElement('div');
    const stop = await startAppearance(root);
    expect(root.dataset).toMatchObject({ theme: 'dark', reduceMotion: 'off' });

    await unwrap(ipc.updateAppSettings({ deviceName: null, theme: 'system', reduceMotion: 'on' }));
    await settle();
    expect(root.dataset.theme).toBeUndefined();
    expect(root.dataset.reduceMotion).toBe('on');

    stop();
    await unwrap(ipc.updateAppSettings({ deviceName: null, theme: 'light', reduceMotion: null }));
    await settle();
    expect(root.dataset.theme).toBeUndefined();
  });

  it('leave the root to Windows, and log why, when they cannot be read', async () => {
    const fake = install();
    fake.setFailure('get_app_settings', 'DataDirUnavailable');
    const root = document.createElement('div');
    root.dataset.theme = 'dark';
    const stop = await startAppearance(root);
    expect(root.dataset.theme).toBeUndefined();
    await expect.poll(() => fake.log.map((entry) => entry.source)).toContain('appearance.load');
    stop();
  });
});

describe('ignore rules (ipc-m1 §22)', () => {
  it('store LF text with one final line break, mark invalid lines and scan after a change', async () => {
    const fake = install();
    const announced = collect<IgnoreRulesChanged>(shellEvents.onIgnoreRulesChanged);
    const jobs = collect<JobChanged>(shellEvents.onJobChanged);
    expect(await unwrap(ipc.getIgnoreRules())).toEqual({ text: '', invalidLines: [] });

    const rules = await unwrap(ipc.setIgnoreRules({ text: 'build/\r\n[z-a]\r\n{a,b\n*.bak\n\n' }));
    expect(rules).toEqual({ text: 'build/\n[z-a]\n{a,b\n*.bak\n', invalidLines: [2, 3] });
    expect(await unwrap(ipc.getIgnoreRules())).toEqual(rules);
    await unwrap(ipc.setIgnoreRules({ text: rules.text }));
    await fake.flush();
    expect(announced.seen).toEqual([{ rules }]);
    expect(jobs.seen.filter(({ job }) => job.kind === 'scan' && job.status.state === 'queued')).toHaveLength(1);
    announced.stop();
    jobs.stop();
  });

  it('count the limit without the final line break, save during a rebuild and need a library', async () => {
    const fake = install('read-only');
    expect(await failure(ipc.setIgnoreRules({ text: 'a'.repeat(LIMITS.ignoreRulesChars + 1) }))).toBe(
      'InvalidArgument',
    );
    // Its own text saves again; read-only metadata does not apply.
    const longest = await unwrap(ipc.setIgnoreRules({ text: 'a'.repeat(LIMITS.ignoreRulesChars) }));
    expect(await unwrap(ipc.setIgnoreRules({ text: longest.text }))).toEqual(longest);
    await unwrap(ipc.rebuildCatalog());
    expect((await unwrap(ipc.setIgnoreRules({ text: 'x' }))).text).toBe('x\n');
    fake.finishJobs();
    install('first-run');
    expect(await failure(ipc.getIgnoreRules())).toBe('NoLibrary');
  });
});
