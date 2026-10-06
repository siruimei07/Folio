// What the pane says about each row (handoff workspace-history §6.1, §6.2, §6.7, §6.8): every
// target and content kind maps to its heading, strip, banners, body and toggle, worded in English.
import i18n from 'i18next';
import { describe as group, expect, it } from 'vitest';

import { previewShowsVersion } from '../../app/previewFile';
import { FIRST_WINDOW } from '../../data/diff';
import type { Course, Diff, DiffContent, ItemPart } from '../../ipc';
import {
  changeRow,
  COMMIT_REF,
  contentDiff,
  diskSide,
  foldedRows,
  metadataChange,
  textDiff,
  versionSide,
  workspaceItem,
} from '../test/diffs';
import { type DescribeContext, describe, type DiffDescription, type Message, renderMessage } from './describe';
import type { DiffTarget } from './target';

const MAT = 'Fall 2026/MAT232 Calculus of Several Variables';
const COURSE: Course = {
  folder: { id: '7', path: MAT },
  name: 'MAT232 Calculus of Several Variables',
  abbr: null,
  code: 'MAT232',
  color: null,
  archived: false,
  files: 12,
};
/** Every file shows as a version; the Word tests below use the preview's own answer. */
const CONTEXT: DescribeContext = { language: 'en', now: Number(COMMIT_REF.timeMs), courses: [COURSE], showsVersion: () => true };

const t = i18n.getFixedT<['diff', 'common']>('en', ['diff', 'common']);
const say = (message: Message) => renderMessage(t, message);

/** What a description reads like: its heading, strip and banners as text, the rest as data. */
function read(description: DiffDescription) {
  const { heading, strip } = description;
  return {
    heading: heading.kind === 'path' ? [heading.path, heading.suffix && say(heading.suffix)] : say(heading.title),
    strip: strip === null || strip.kind === 'loading' ? strip?.kind ?? null : strip.parts.map(say).join(t('strip.separator')),
    banners: description.banners.map(({ status, message }) => `${status}: ${say(message)}`),
  };
}

const ROWS = foldedRows(5);
/** "4 lines added, 3 removed", in 2 changes. */
const COUNTS = { text: { added: 4, removed: 3, changes: 2 } };
const LINES = textDiff(ROWS, FIRST_WINDOW, COUNTS);

function changes(fields: Parameters<typeof workspaceItem>[0] = {}): DiffTarget {
  return { kind: 'workspace', item: workspaceItem(fields) };
}

function history(fields: Parameters<typeof changeRow>[0] = {}): DiffTarget {
  return { kind: 'version', commit: COMMIT_REF, row: changeRow(fields) };
}

function content(kind: DiffContent, fields: Partial<Diff> = {}): Diff {
  return contentDiff(kind, fields);
}

group('a text or Word file in Changes', () => {
  it('compares with the last commit and counts lines, with the toggle', () => {
    const description = describe(changes(), LINES, CONTEXT);
    expect(read(description)).toEqual({
      heading: [`${MAT}/notes.md`, null],
      strip: 'Compared with the last commit (Oct 10, 3:10 PM) · 4 lines added, 3 removed',
      banners: [],
    });
    expect(description).toMatchObject({
      icon: { kind: 'file', name: 'notes.md' },
      status: 'modified',
      body: { kind: 'lines', word: false },
      strip: { changes: 2 },
      tags: null,
      toggle: true,
    });
  });

  it('counts paragraphs of a Word file and sets it in the Word body', () => {
    const word = textDiff(ROWS, FIRST_WINDOW, { word: true, text: { added: 2, removed: 1, changes: 1 } });
    const description = describe(changes({ class: 'word', path: `${MAT}/Essay.docx` }), word, CONTEXT);
    expect(read(description).strip).toBe('Compared with the last commit (Oct 10, 3:10 PM) · 2 paragraphs added, 1 removed');
    expect(description.body).toMatchObject({ kind: 'lines', word: true });
    expect(description.icon).toEqual({ kind: 'file', name: 'Essay.docx' });
  });

  it('shows an added file as new since the last commit, every line added', () => {
    const added = textDiff(ROWS, FIRST_WINDOW, { before: null, text: { added: 24, removed: 0, changes: 1 } });
    const description = describe(changes({ change: 'added', before: null }), added, CONTEXT);
    expect(read(description).strip).toBe('New since the last commit · 24 lines added');
    expect(description).toMatchObject({ status: 'added', body: { kind: 'lines' }, toggle: true });
  });

  it('shows a deleted file as in the Recycle Bin, without a strip or the toggle, whatever its content', () => {
    for (const diff of [
      textDiff(ROWS, FIRST_WINDOW, { after: null }),
      content({ kind: 'notStored' }, { after: null }),
    ]) {
      const description = describe(changes({ change: 'deleted', entry: null, after: null }), diff, CONTEXT);
      expect(read(description)).toMatchObject({
        strip: null,
        banners: ['deleted: Deleted: committing removes it from the library. The file is in the Recycle Bin.'],
      });
      expect(description).toMatchObject({
        status: 'deleted',
        body: { kind: 'deleted', name: 'notes.md', folder: false, files: 0 },
        toggle: false,
      });
    }
  });

  it('words a text file that only changed its formatting, line endings or encoding', () => {
    const same = (fields: object, word = false) =>
      describe(changes(), textDiff([], FIRST_WINDOW, { word, text: { added: 0, removed: 0, changes: 0, ...fields } }), CONTEXT);

    const formatting = same({}, true);
    expect(read(formatting).strip).toBe('Compared with the last commit (Oct 10, 3:10 PM) · No text changed');
    expect(formatting.body).toEqual({ kind: 'noTextChange', reason: 'formatting', lineEndings: null, encoding: null });
    expect(formatting.toggle).toBe(true);

    const endings = same({ lineEndings: { before: 'crlf', after: 'lf' } });
    expect(read(endings).strip).toBe('Compared with the last commit (Oct 10, 3:10 PM) · Only the line endings changed');
    expect(endings.body).toMatchObject({ kind: 'noTextChange', reason: 'lineEndings', lineEndings: { before: 'crlf', after: 'lf' } });

    const encoding = same({ encoding: { before: 'gb18030', after: 'utf8' } });
    expect(read(encoding).strip).toBe('Compared with the last commit (Oct 10, 3:10 PM) · Only the encoding changed');
    expect(encoding.body).toMatchObject({ kind: 'noTextChange', reason: 'encoding' });
  });

  it('passes an approximate diff through to the lines, which note it', () => {
    const approximate = textDiff(ROWS, FIRST_WINDOW, { text: { approximate: true } });
    expect(describe(changes(), approximate, CONTEXT).body).toMatchObject({ kind: 'lines', text: { approximate: true } });
  });

  it('counts a change too big to show when the count is known, and offers this version', () => {
    const counted = describe(changes(), content({ kind: 'tooLarge', lines: 24_382 }), CONTEXT);
    expect(read(counted).strip).toBe('Compared with the last commit (Oct 10, 3:10 PM) · 24,382 lines changed');
    expect(counted).toMatchObject({ body: { kind: 'tooLarge', lines: 24_382, word: false }, strip: { changes: 0 }, toggle: true });

    const uncounted = describe(changes(), content({ kind: 'tooLarge', lines: null }), CONTEXT);
    expect(read(uncounted).strip).toBe('Compared with the last commit (Oct 10, 3:10 PM)');
    expect(uncounted.body).toEqual({ kind: 'tooLarge', lines: null, word: false });

    const word = describe(changes({ class: 'word', path: `${MAT}/Essay.docx` }), content({ kind: 'tooLarge', lines: 1 }), CONTEXT);
    expect(read(word).strip).toBe('Compared with the last commit (Oct 10, 3:10 PM) · 1 paragraph changed');
  });

  it('shows the blocks of content it cannot compare, with the toggle only where the file can show', () => {
    const cases: [DiffContent, Partial<DiffDescription>][] = [
      [{ kind: 'binary' }, { body: { kind: 'binary' }, toggle: false }],
      [{ kind: 'notLocal' }, { body: { kind: 'notLocal' }, toggle: false }],
      [
        { kind: 'unreadable', error: { code: 'InUse', detail: 'in use' } },
        { body: { kind: 'unreadable', error: { code: 'InUse', detail: 'in use' } }, toggle: true },
      ],
      [{ kind: 'pruned' }, { body: { kind: 'pruned' }, toggle: true }],
    ];
    for (const [kind, expected] of cases) {
      const description = describe(changes(), content(kind), CONTEXT);
      expect(description).toMatchObject({ ...expected, strip: null, banners: [] });
    }
    // A file not on this disk or unreadable offers nothing from its row.
    expect(describe(changes({ readiness: 'notLocal' }), undefined, CONTEXT).toggle).toBe(false);
    expect(describe(changes({ readiness: 'unreadable' }), undefined, CONTEXT).toggle).toBe(false);
  });

  it('keeps a text file over the size limit to the sizes and a block, without the toggle', () => {
    const target = changes({ before: { size: '14889779', stored: false }, after: { size: '15309210', stored: false } });
    const diff = content({ kind: 'notStored' }, { before: versionSide({ size: '14889779', stored: false }), after: diskSide({ size: '15309210', stored: false }) });
    const description = describe(target, diff, CONTEXT);
    expect(read(description).banners).toEqual([
      "modified: Modified: 14.2 MB → 14.6 MB. Text files over 10 MB keep only the latest copy, so there's no older version to compare.",
    ]);
    expect(description).toMatchObject({ body: { kind: 'overLimit' }, strip: null, toggle: false });
    expect(describe(target, undefined, CONTEXT)).toMatchObject({ strip: null, toggle: false });

    const added = describe(
      changes({ change: 'added', before: null, after: { size: '15309210', stored: false } }),
      content({ kind: 'notStored' }, { before: null, after: diskSide({ size: '15309210', stored: false }) }),
      CONTEXT,
    );
    expect(read(added).banners).toEqual(['added: Added. Folio keeps only the latest copy of text files over 10 MB.']);
  });

  it('shows the tag change under the content', () => {
    const tags = { added: [{ id: 't1', name: 'Exams', color: 'red' }], removed: [], now: [{ id: 't1', name: 'Exams', color: 'red' }] };
    const description = describe(changes({ tagsChanged: true }), { ...LINES, tags }, CONTEXT);
    expect(description.tags).toBe(tags);
    expect(description.body.kind).toBe('lines');
  });
});

group('event-only files in Changes', () => {
  const slides = `${MAT}/Lecture 4.pptx`;

  it('names the kind of file in the banner and shows its preview', () => {
    const description = describe(
      changes({ change: 'added', path: slides, class: 'other', before: null, after: { size: '1000', stored: false } }),
      content({ kind: 'notStored' }, { before: null, after: diskSide({ stored: false }) }),
      CONTEXT,
    );
    expect(read(description)).toMatchObject({
      heading: [slides, null],
      strip: null,
      banners: ['added: Added. Folio records changes to slides but keeps only the latest copy.'],
    });
    expect(description).toMatchObject({ icon: { kind: 'file', name: 'Lecture 4.pptx' }, body: { kind: 'preview', source: 'disk' }, toggle: false });
  });

  it('gives the sizes of a modified one', () => {
    const description = describe(
      changes({ path: `${MAT}/Budget.xlsx`, class: 'other', before: { size: '188416', stored: false }, after: { size: '217088', stored: false } }),
      content({ kind: 'notStored' }, { before: versionSide({ size: '188416', stored: false }), after: diskSide({ size: '217088', stored: false }) }),
      CONTEXT,
    );
    expect(read(description).banners).toEqual([
      "modified: Modified: 184 KB → 212 KB. Folio keeps only the latest copy of spreadsheets, so there's no older version to compare.",
    ]);
    const message = description.banners[0]?.message;
    expect(message?.values?.before).toEqual({ key: 'common:size.kilobytes', values: { value: '184' } });
  });

  it.each([
    ['Notes.pdf', 'PDFs'],
    ['Photo.jpg', 'images'],
    ['Lecture.m4a', 'audio files'],
    ['Demo.mp4', 'videos'],
    ['Code.zip', 'archives'],
    ['Model.fig', 'files like this'],
    ['Old essay.doc', 'files like this'],
  ])('words %s as one of the %s', (name, kind) => {
    const description = describe(
      changes({ change: 'added', path: `${MAT}/${name}`, class: 'other', before: null }),
      content({ kind: 'notStored' }, { before: null }),
      CONTEXT,
    );
    expect(read(description).banners).toEqual([`added: Added. Folio records changes to ${kind} but keeps only the latest copy.`]);
  });
});

group('moves', () => {
  it('says where a file came from before its diff, from the row while the diff loads', () => {
    const renamed = changes({ change: 'moved', fromPath: `${MAT}/Problem sets/Exercise 14.3.jpg`, path: `${MAT}/Problem sets/Ex 14.3.jpg`, class: 'other', contentChanged: false });
    const loading = describe(renamed, undefined, CONTEXT);
    expect(read(loading).banners).toEqual(['renamed: Renamed from Exercise 14.3.jpg.']);
    expect(loading).toMatchObject({ status: 'renamed', strip: null, body: { kind: 'loading' }, toggle: false });

    const loaded = describe(renamed, content({ kind: 'same' }), CONTEXT);
    expect(read(loaded).banners).toEqual(['renamed: Renamed from Exercise 14.3.jpg.']);
    expect(loaded).toMatchObject({ body: { kind: 'preview', source: 'disk' }, toggle: false });
  });

  it('names the old folder with its course label, the top of the library, or the old path with a new name', () => {
    const moved = changes({ change: 'moved', fromPath: `${MAT}/Problem sets/notes.md`, path: `${MAT}/notes.md` });
    const description = describe(moved, LINES, CONTEXT);
    expect(read(description).banners).toEqual(['renamed: Moved from MAT232/Problem sets/.']);
    expect(description).toMatchObject({ body: { kind: 'lines' }, toggle: true });

    const fromTop = describe(changes({ change: 'moved', fromPath: 'notes.md', path: `${MAT}/notes.md` }), LINES, CONTEXT);
    expect(read(fromTop).banners).toEqual(['renamed: Moved from the top of the library.']);

    const both = describe(changes({ change: 'moved', fromPath: `${MAT}/Problem sets/old notes.md`, path: `${MAT}/notes.md` }), LINES, CONTEXT);
    expect(read(both).banners).toEqual(['renamed: Moved and renamed from MAT232/Problem sets/old notes.md.']);
  });

  it('offers this version only for a moved file that was also edited', () => {
    expect(describe(changes({ change: 'moved', fromPath: `${MAT}/a.md`, contentChanged: false }), undefined, CONTEXT)).toMatchObject({
      strip: null,
      toggle: false,
    });
    expect(describe(changes({ change: 'moved', fromPath: `${MAT}/a.md`, contentChanged: true }), undefined, CONTEXT)).toMatchObject({
      strip: { kind: 'loading' },
      toggle: true,
    });
  });
});

group('folder items in Changes', () => {
  it('shows a moved folder with the files that went with it', () => {
    const description = describe(
      changes({ change: 'moved', kind: 'folder', class: 'other', path: `${MAT}/Exercises`, fromPath: `${MAT}/Old/Exercises`, before: null, after: null, files: 4 }),
      content({ kind: 'folder' }, { before: null, after: null }),
      CONTEXT,
    );
    expect(read(description)).toEqual({ heading: [`${MAT}/Exercises`, null], strip: null, banners: ['renamed: Moved from MAT232/Old/.'] });
    expect(description).toMatchObject({ icon: { kind: 'folderOpen' }, body: { kind: 'folder', change: 'moved', files: 4 }, toggle: false });
  });

  it('shows a deleted folder in the Recycle Bin with its files', () => {
    const folder = (files: number) =>
      describe(
        changes({ change: 'deleted', kind: 'folder', class: 'other', path: `${MAT}/Exercises`, entry: null, before: null, after: null, files }),
        content({ kind: 'folder' }, { before: null, after: null }),
        CONTEXT,
      );
    expect(read(folder(4)).banners).toEqual([
      'deleted: Deleted: committing removes it from the library. The folder and its 4 files are in the Recycle Bin.',
    ]);
    expect(folder(4)).toMatchObject({ icon: { kind: 'folder' }, body: { kind: 'deleted', name: 'Exercises', folder: true, files: 4 } });
    expect(read(folder(1)).banners).toEqual([
      'deleted: Deleted: committing removes it from the library. The folder and the file in it are in the Recycle Bin.',
    ]);
    expect(read(folder(0)).banners).toEqual(['deleted: Deleted: committing removes it from the library. The folder is in the Recycle Bin.']);
  });

  it('shows an added empty folder', () => {
    const description = describe(
      changes({ change: 'added', kind: 'folder', class: 'other', path: `${MAT}/Labs`, before: null, after: null }),
      content({ kind: 'folder' }, { before: null, after: null }),
      CONTEXT,
    );
    expect(read(description).banners).toEqual(['added: Added an empty folder.']);
    expect(description).toMatchObject({ icon: { kind: 'folder' }, status: 'added', body: { kind: 'folder', change: 'added', files: 0 } });
  });
});

group('bound items', () => {
  const ITEM = `${MAT}/Problem sets/hw2.pdf`;
  const banners = (fields: Parameters<typeof workspaceItem>[0], parts: ItemPart[]) =>
    read(describe(changes({ path: ITEM, class: 'other', ...fields, parts }), undefined, CONTEXT)).banners;

  it('lists the move and then each part, from the row', () => {
    expect(
      banners({ change: 'moved', fromPath: `${MAT}/Problem sets/Exercise 14.3.pdf` }, [
        { kind: 'entry', change: 'deleted', entryKind: 'file', path: ITEM, fromPath: null },
        { kind: 'versioningRules' },
      ]),
    ).toEqual([
      'renamed: Renamed from Exercise 14.3.pdf.',
      'deleted: Replaces a file that was deleted.',
      "modified: Library settings now keep this file's versions, so it goes into the same commit.",
    ]);
  });

  it('words each way a part can touch the item', () => {
    const folder = { change: 'deleted' as const, kind: 'folder' as const, path: `${MAT}/作业`, entry: null };
    expect(
      banners(folder, [
        { kind: 'entry', change: 'moved', entryKind: 'file', path: `${MAT}/hw2.pdf`, fromPath: `${MAT}/作业/hw2.pdf` },
        { kind: 'entry', change: 'deleted', entryKind: 'file', path: `${MAT}/作业/old.pdf`, fromPath: null },
      ]),
    ).toEqual(['renamed: hw2.pdf was moved out of this folder first.', 'deleted: old.pdf was deleted from this folder first.']);

    const moved = { change: 'moved' as const, fromPath: `${MAT}/Problem sets/hw1.pdf` };
    expect(
      banners(moved, [
        { kind: 'entry', change: 'moved', entryKind: 'file', path: `${MAT}/Problem sets/hw1.pdf`, fromPath: ITEM },
      ]).slice(1),
    ).toEqual(['renamed: Swapped names with hw1.pdf.']);
    expect(
      banners(moved, [
        { kind: 'entry', change: 'moved', entryKind: 'file', path: `${MAT}/Problem sets/hw1.pdf`, fromPath: `${MAT}/draft.pdf` },
        { kind: 'entry', change: 'added', entryKind: 'folder', path: `${MAT}/Problem sets/hw1.pdf`, fromPath: null },
        { kind: 'entry', change: 'added', entryKind: 'file', path: `${MAT}/Problem sets/hw1.pdf`, fromPath: null },
      ]).slice(1),
    ).toEqual([
      'renamed: draft.pdf was moved to where it was.',
      'added: A new folder was added where it was.',
      'added: A new file was added where it was.',
    ]);

    const deleted = { change: 'deleted' as const, entry: null };
    expect(
      banners(deleted, [
        { kind: 'entry', change: 'moved', entryKind: 'file', path: ITEM, fromPath: `${MAT}/draft.pdf` },
        { kind: 'entry', change: 'added', entryKind: 'file', path: ITEM, fromPath: null },
        { kind: 'entry', change: 'added', entryKind: 'folder', path: ITEM, fromPath: null },
      ]),
    ).toEqual([
      'renamed: draft.pdf was moved here in its place.',
      'added: A new file was added in its place.',
      'added: A new folder was added in its place.',
    ]);

    // A file replaced by a folder that now holds the item.
    expect(
      banners({ change: 'added', path: `${MAT}/Problem sets/hw2/answers.pdf` }, [
        { kind: 'entry', change: 'deleted', entryKind: 'folder', path: `${MAT}/Problem sets/hw2`, fromPath: null },
      ]),
    ).toEqual(['deleted: Replaces a folder that was deleted.']);
  });

  it('falls back to naming the other change by its place', () => {
    expect(
      banners({}, [
        { kind: 'entry', change: 'added', entryKind: 'file', path: `${MAT}/a.pdf`, fromPath: null },
        { kind: 'entry', change: 'deleted', entryKind: 'file', path: `${MAT}/b.pdf`, fromPath: null },
        { kind: 'entry', change: 'modified', entryKind: 'file', path: `${MAT}/c.pdf`, fromPath: null },
        { kind: 'entry', change: 'moved', entryKind: 'file', path: `${MAT}/d.pdf`, fromPath: 'Spring 2026/d.pdf' },
      ]),
    ).toEqual([
      'added: Goes into the same commit as MAT232 / a.pdf, which was added.',
      'deleted: Goes into the same commit as MAT232 / b.pdf, which was deleted.',
      'modified: Goes into the same commit as MAT232 / c.pdf, which was changed.',
      'renamed: Goes into the same commit as MAT232 / d.pdf, which was moved from Spring 2026 / d.pdf.',
    ]);
  });
});

group('rows of a commit in History', () => {
  it('names this version and what it is compared with', () => {
    const diff = textDiff(ROWS, FIRST_WINDOW, { ...COUNTS, after: versionSide({ commit: COMMIT_REF.id, timeMs: COMMIT_REF.timeMs }) });
    const description = describe(history(), diff, CONTEXT);
    expect(read(description).strip).toBe(
      'This version: Oct 13, 9:30 PM · compared with Oct 10, 3:10 PM · 4 lines added, 3 removed',
    );
    expect(description).toMatchObject({ body: { kind: 'lines' }, toggle: true, banners: [] });
  });

  it("counts a file's first version and the lines a deletion removed", () => {
    const first = textDiff(ROWS, FIRST_WINDOW, { before: null, text: { added: 24, removed: 0, changes: 1 } });
    expect(read(describe(history({ change: 'added', before: null }), first, CONTEXT)).strip).toBe(
      'First version: Oct 13, 9:30 PM · 24 lines',
    );

    const gone = textDiff(ROWS, FIRST_WINDOW, { after: null, text: { added: 0, removed: 1, changes: 1 } });
    const deleted = describe(history({ change: 'deleted', after: null }), gone, CONTEXT);
    expect(read(deleted)).toMatchObject({ strip: 'Deleted in this version: Oct 13, 9:30 PM · 1 line removed', banners: [] });
    expect(deleted).toMatchObject({ body: { kind: 'lines' }, toggle: false });
  });

  it('shows an event-only file as it is now, and nothing for one that was deleted', () => {
    const image = `${MAT}/Photo.jpg`;
    const added = describe(
      history({ change: 'added', path: image, class: 'other', before: null }),
      content({ kind: 'notStored' }, { before: null }),
      CONTEXT,
    );
    expect(read(added).banners).toEqual([
      'added: This version added the file. Folio keeps only the latest copy of images, so the preview shows the file as it is now.',
    ]);
    expect(added).toMatchObject({ body: { kind: 'preview', source: 'located' }, toggle: false, strip: null });

    const modified = describe(
      history({ path: `${MAT}/Notes.pdf`, class: 'other' }),
      content({ kind: 'notStored' }, { before: versionSide({ size: '188416' }), after: versionSide({ size: '217088' }) }),
      CONTEXT,
    );
    expect(read(modified).banners).toEqual([
      'modified: This version changed the file (184 KB → 212 KB). Folio keeps only the latest copy of PDFs, so the preview shows the file as it is now.',
    ]);

    const deleted = describe(history({ change: 'deleted', path: image, class: 'other', after: null }), content({ kind: 'notStored' }, { after: null }), CONTEXT);
    expect(read(deleted).banners).toEqual(['deleted: This version deleted the file.']);
    expect(deleted.body).toEqual({ kind: 'gone' });
  });

  it('keeps a text version over the size limit to its block, and previews the version when it was kept', () => {
    const over = describe(
      history({ before: { hash: 'b3:c', size: '9000000', stored: true, pruned: false }, after: { hash: 'b3:d', size: '15309210', stored: false, pruned: false } }),
      content({ kind: 'notStored' }, { before: versionSide({ size: '9000000' }), after: versionSide({ size: '15309210', stored: false }) }),
      CONTEXT,
    );
    expect(read(over).banners).toEqual([
      "modified: This version changed the file (8.6 MB → 14.6 MB). Text files over 10 MB keep only the latest copy, so there's no older version to compare.",
    ]);
    expect(over).toMatchObject({ body: { kind: 'overLimit' }, toggle: false });

    const kept = describe(
      history({ before: { hash: 'b3:c', size: '15309210', stored: false, pruned: false } }),
      content({ kind: 'notStored' }, { before: versionSide({ size: '15309210', stored: false }), after: versionSide({ size: '9000000' }) }),
      CONTEXT,
    );
    expect(kept.body).toEqual({ kind: 'preview', source: 'version' });

    const added = describe(history({ change: 'added', before: null }), content({ kind: 'notStored' }, { before: null, after: versionSide({ stored: false }) }), CONTEXT);
    expect(read(added).banners).toEqual(['added: This version added the file. Folio keeps only the latest copy of text files over 10 MB.']);
  });

  it('previews a version moved without edits, or the file as it is now when its versions are not kept', () => {
    const same = { before: { hash: 'b3:c', size: '10', stored: true, pruned: false }, after: { hash: 'b3:c', size: '10', stored: true, pruned: false } };
    const text = describe(history({ change: 'moved', fromPath: `${MAT}/old.md`, ...same }), content({ kind: 'same' }), CONTEXT);
    expect(text).toMatchObject({ body: { kind: 'preview', source: 'version' }, toggle: false });
    expect(read(text).banners).toEqual(['renamed: Renamed from old.md.']);

    const unkept = { before: { ...same.before, stored: false }, after: { ...same.after, stored: false } };
    const image = describe(history({ change: 'moved', fromPath: `${MAT}/a.jpg`, path: `${MAT}/b.jpg`, class: 'other', ...unkept }), content({ kind: 'same' }), CONTEXT);
    expect(image.body).toEqual({ kind: 'preview', source: 'located' });
  });

  it('offers no version that was thinned out', () => {
    const pruned = history({ after: { hash: 'b3:d', size: '10', stored: true, pruned: true } });
    expect(describe(pruned, undefined, CONTEXT)).toMatchObject({ strip: null, toggle: false });
    expect(describe(pruned, content({ kind: 'pruned' }), CONTEXT)).toMatchObject({ body: { kind: 'pruned' }, toggle: false });
  });

  it('shows folder rows', () => {
    const folder = (change: 'moved' | 'added' | 'deleted') =>
      describe(
        history({ change, kind: 'folder', class: 'other', path: `${MAT}/Labs`, fromPath: change === 'moved' ? `${MAT}/Old labs` : null, before: null, after: null }),
        content({ kind: 'folder' }, { before: null, after: null }),
        CONTEXT,
      );
    expect(read(folder('moved')).banners).toEqual(['renamed: Renamed from Old labs.']);
    expect(folder('moved').body).toEqual({ kind: 'folder', change: 'moved', files: null });
    expect(read(folder('added')).banners).toEqual(['added: This version added an empty folder.']);
    expect(read(folder('deleted')).banners).toEqual(['deleted: This version deleted the folder.']);
    expect(folder('deleted')).toMatchObject({ icon: { kind: 'folder' }, body: { kind: 'folder', change: 'deleted' } });
  });
});

group('tag and settings changes', () => {
  const tags = { added: [{ id: 't1', name: 'Exams', color: 'red' }], removed: [], now: [{ id: 't1', name: 'Exams', color: 'red' }] };
  const metadata = (change: ReturnType<typeof metadataChange>, history = false): DiffTarget =>
    history ? { kind: 'versionMetadata', commit: COMMIT_REF, change } : { kind: 'workspaceMetadata', change };
  const noSides = { before: null, after: null };

  it("shows a file's tags under its path with · Tags, without a strip or the toggle", () => {
    const target = metadata(metadataChange({ kind: 'tags', path: `${MAT}/notes.md`, entryKind: 'file', entry: null }));
    const description = describe(target, content({ kind: 'metadata', detail: { kind: 'tags', ...tags } }, noSides), CONTEXT);
    expect(read(description)).toEqual({ heading: [`${MAT}/notes.md`, 'Tags'], strip: null, banners: [] });
    expect(description).toEqual({
      icon: { kind: 'tag' },
      heading: { kind: 'path', path: `${MAT}/notes.md`, suffix: { key: 'heading.tags' } },
      status: 'modified',
      strip: null,
      banners: [],
      body: { kind: 'tags', tags, folder: false, history: false },
      tags: null,
      toggle: false,
    });

    const folder = metadata(metadataChange({ kind: 'tags', path: MAT, entryKind: 'folder', entry: null }, 'added'), true);
    expect(describe(folder, content({ kind: 'metadata', detail: { kind: 'tags', ...tags } }, noSides), CONTEXT)).toMatchObject({
      status: 'added',
      body: { kind: 'tags', folder: true, history: true },
    });
  });

  it('titles settings by their course label or folder name, and lists their changes', () => {
    const settings = content({ kind: 'metadata', detail: { kind: 'settings', changes: [{ field: 'code', before: 'CSC236', after: 'CSC 236' }] } }, noSides);
    const course = describe(metadata(metadataChange({ kind: 'course', path: MAT, folder: null })), settings, CONTEXT);
    expect(read(course).heading).toBe('MAT232 course settings');
    expect(course).toMatchObject({ icon: { kind: 'settings' }, body: { kind: 'settings', changes: [{ field: 'code' }] }, strip: null });

    expect(read(describe(metadata(metadataChange({ kind: 'course', path: 'Fall 2026/CSC236 Theory', folder: null })), settings, CONTEXT)).heading).toBe(
      'CSC236 Theory course settings',
    );
    expect(read(describe(metadata(metadataChange({ kind: 'semester', path: 'Fall 2026', folder: null })), settings, CONTEXT)).heading).toBe(
      'Fall 2026 semester settings',
    );
    const library = describe(metadata(metadataChange({ kind: 'library' })), settings, CONTEXT);
    expect(read(library).heading).toBe('Library settings');
    expect(library.icon).toEqual({ kind: 'settings' });

    const definitions = content(
      { kind: 'metadata', detail: { kind: 'tagDefinitions', changes: [{ id: 't2', before: null, after: { name: 'Labs', color: 'teal', order: 3 } }] } },
      noSides,
    );
    const tagDefinitions = describe(metadata(metadataChange({ kind: 'tagDefinitions' }, 'added')), definitions, CONTEXT);
    expect(read(tagDefinitions).heading).toBe('Tag definitions');
    expect(tagDefinitions).toMatchObject({ icon: { kind: 'tags' }, status: 'added', body: { kind: 'tagDefinitions' } });
  });

  it('shows the ignore rules as a text diff with counts', () => {
    const rules = textDiff(ROWS, FIRST_WINDOW, { ...COUNTS, ...noSides });
    const target = metadataChange({ kind: 'ignoreRules' });
    const workspace = describe(metadata(target), rules, CONTEXT);
    expect(read(workspace)).toEqual({ heading: 'Ignore rules', strip: 'Compared with the last commit · 4 lines added, 3 removed', banners: [] });
    expect(workspace).toMatchObject({ icon: { kind: 'fileCog' }, body: { kind: 'lines', word: false }, toggle: false });
    expect(read(describe(metadata(target, true), rules, CONTEXT)).strip).toBe('This version: Oct 13, 9:30 PM · 4 lines added, 3 removed');

    expect(describe(metadata(target), undefined, CONTEXT)).toMatchObject({ strip: { kind: 'loading' }, body: { kind: 'loading' } });
    expect(describe(metadata(metadataChange({ kind: 'library' })), undefined, CONTEXT).strip).toBeNull();
  });

  it('has nothing to list for a change without detail', () => {
    expect(describe(metadata(metadataChange({ kind: 'library' })), content({ kind: 'same' }, noSides), CONTEXT).body).toEqual({ kind: 'nothing' });
  });
});

group('while the diff loads', () => {
  it('shows the skeleton strip only for rows whose diff will have one', () => {
    const strip = (target: DiffTarget) => describe(target, undefined, CONTEXT).strip;
    expect(strip(changes())).toEqual({ kind: 'loading' });
    expect(strip(changes({ class: 'other', path: `${MAT}/a.pdf` }))).toBeNull();
    expect(strip(changes({ change: 'deleted', entry: null, after: null }))).toBeNull();
    expect(strip(changes({ kind: 'folder', class: 'other' }))).toBeNull();
    expect(strip(changes({ after: { size: '1', stored: false } }))).toBeNull();
    expect(strip(history({ change: 'deleted', after: null }))).toEqual({ kind: 'loading' });
    expect(describe(changes(), undefined, CONTEXT)).toMatchObject({ body: { kind: 'loading' }, tags: null, toggle: true });
  });
});

group('"This version" only for files the preview shows', () => {
  const PREVIEW: DescribeContext = { ...CONTEXT, showsVersion: previewShowsVersion };

  it('offers it for notes and code, from the row and with the content', () => {
    for (const name of ['notes.md', 'main.py', 'data.csv']) {
      const target = changes({ path: `${MAT}/${name}` });
      expect(describe(target, undefined, PREVIEW).toggle).toBe(true);
      expect(describe(target, LINES, PREVIEW).toggle).toBe(true);
      expect(describe(history({ path: `${MAT}/${name}` }), LINES, PREVIEW).toggle).toBe(true);
    }
  });

  it('does not offer it for Word files, whose previews come later, nor for text types it does not know', () => {
    const essay = changes({ class: 'word', path: `${MAT}/Essay.docx` });
    expect(describe(essay, undefined, PREVIEW).toggle).toBe(false);
    const formatting = describe(essay, textDiff([], FIRST_WINDOW, { word: true, text: { added: 0, removed: 0, changes: 0 } }), PREVIEW);
    expect(formatting).toMatchObject({ body: { kind: 'noTextChange', reason: 'formatting' }, toggle: false });
    expect(describe(essay, content({ kind: 'tooLarge', lines: 3 }), PREVIEW).toggle).toBe(false);
    expect(describe(history({ class: 'word', path: `${MAT}/Essay.docx` }), LINES, PREVIEW).toggle).toBe(false);
    // A type the library settings made text, which the preview shows as a card.
    expect(describe(changes({ path: `${MAT}/model.fig` }), LINES, PREVIEW).toggle).toBe(false);
  });
});
