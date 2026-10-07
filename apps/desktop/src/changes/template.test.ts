// The template message (workspace-history handoff §4.6, versioning §8.1).
import { describe, expect, it } from 'vitest';

import type { ChangeCounts, Place, SelectionSummary, SummaryGroup } from '../ipc';
import { charCount } from '../lib/text';
import { templateMessage } from './template';

const NONE: ChangeCounts = { added: 0, modified: 0, deleted: 0, moved: 0 };

function course(code: string | null, name = `${code ?? 'Course'} Long Name`): Place {
  return { kind: 'course', path: `Fall 2026/${name}`, folder: null, name, code };
}

function semester(name: string): Place {
  return { kind: 'semester', path: name, folder: null, name };
}

/** A place with included changes; counts left out are none. */
function group(
  place: Place,
  { files = {}, folders = {}, tags = 0, settings = false }: { files?: Partial<ChangeCounts>; folders?: Partial<ChangeCounts>; tags?: number; settings?: boolean } = {},
): SummaryGroup {
  const included = { ...NONE, ...files };
  const includedFolders = { ...NONE, ...folders };
  const selected = Object.values(included).reduce((sum, n) => sum + n, 0) + Object.values(includedFolders).reduce((sum, n) => sum + n, 0);
  return { place, files: included, folders: includedFolders, tags, settings, items: selected, available: selected, selected, required: 0 };
}

function summary(groups: SummaryGroup[], flags: Partial<Pick<SelectionSummary, 'tagDefinitions' | 'library' | 'ignoreRules'>> = {}): SelectionSummary {
  const items = groups.reduce((sum, entry) => sum + entry.selected, 0);
  const metadata =
    groups.reduce((sum, entry) => sum + entry.tags + (entry.settings ? 1 : 0), 0) +
    Number(flags.tagDefinitions ?? false) +
    Number(flags.library ?? false) +
    Number(flags.ignoreRules ?? false);
  return { items, metadata, groups, tagDefinitions: false, library: false, ignoreRules: false, ...flags };
}

describe('templateMessage', () => {
  it('writes one clause per place, its verbs in the order add, update, move, delete, tag', () => {
    expect(
      templateMessage(
        summary([
          group(course('MAT232'), { files: { deleted: 1, moved: 3, modified: 1, added: 2 }, tags: 4 }),
          group(course('CSC207'), { files: { deleted: 1 } }),
        ]),
      ),
    ).toBe('MAT232: add 2 files, update 1 file, move 3 files, delete 1 file, tag 4 files; CSC207: delete 1 file');
  });

  it('names a course by its code, else its name; other places by the semester or "Library"', () => {
    expect(
      templateMessage(
        summary([
          group({ kind: 'library' }, { files: { added: 1 } }),
          group(semester('Fall 2026'), { files: { modified: 2 } }),
          group(course(null, 'Reading group'), { files: { added: 1 } }),
        ]),
      ),
    ).toBe('Library: add 1 file; Fall 2026: update 2 files; Reading group: add 1 file');
  });

  it('counts folders beside files under the same verb', () => {
    expect(templateMessage(summary([group(course('MAT232'), { files: { added: 2 }, folders: { added: 1, deleted: 2 } })]))).toBe(
      'MAT232: add 2 files and 1 folder, delete 2 folders',
    );
  });

  it('leaves out places with nothing included', () => {
    const left = { ...group(course('PHY101'), {}), available: 3 };
    expect(templateMessage(summary([left, group(course('MAT232'), { files: { added: 1 } })]))).toBe('MAT232: add 1 file');
  });

  it('ends with "and N more" after three places', () => {
    const codes = ['MAT232', 'CSC207', 'MAT224', 'ECO101', 'PHY101'];
    expect(templateMessage(summary(codes.map((code) => group(course(code), { files: { added: 1 } }))))).toBe(
      'MAT232: add 1 file; CSC207: add 1 file; MAT224: add 1 file; and 2 more',
    );
  });

  it('writes a tag-only commit as tagging', () => {
    expect(templateMessage(summary([group(course('MAT232'), { tags: 3 })]))).toBe('MAT232: tag 3 files');
    expect(templateMessage(summary([group(course('MAT232'), { tags: 1 })]))).toBe('MAT232: tag 1 file');
  });

  it('writes a settings-only commit as one sentence', () => {
    expect(templateMessage(summary([group(course('MAT232'), { settings: true })]))).toBe('Update course settings');
    expect(templateMessage(summary([], { library: true }))).toBe('Update library settings');
    expect(templateMessage(summary([], { tagDefinitions: true }))).toBe('Update tags');
    expect(templateMessage(summary([], { ignoreRules: true }))).toBe('Update ignore rules');
    expect(
      templateMessage(
        summary([group(course('MAT232'), { settings: true }), group(course('CSC207'), { settings: true }), group(semester('Fall 2026'), { settings: true })], {
          library: true,
          tagDefinitions: true,
        }),
      ),
    ).toBe('Update course settings, semester settings, library settings and tags');
  });

  it("adds a place's settings to its clause, and library-wide changes as a clause, when files are included too", () => {
    expect(
      templateMessage(summary([group(course('MAT232'), { files: { added: 1 }, settings: true })], { tagDefinitions: true })),
    ).toBe('MAT232: add 1 file, update course settings; update tags');
  });

  it('formats large counts with separators', () => {
    expect(templateMessage(summary([group(course('MAT232'), { files: { added: 12_345 } })]))).toBe('MAT232: add 12,345 files');
  });

  it('is empty when nothing is included', () => {
    expect(templateMessage(summary([]))).toBe('');
  });

  it('cuts at a clause boundary to 256 characters, the places past the cut joining "and N more"', () => {
    const name = (letter: string) => `${letter.repeat(100)} Seminar`;
    const message = templateMessage(
      summary(['A', 'B', 'C'].map((letter) => group(course(null, name(letter)), { files: { added: 1 } }))),
    );
    expect(message).toBe(`${name('A')}: add 1 file; ${name('B')}: add 1 file; and 1 more`);
    expect(charCount(message)).toBeLessThanOrEqual(256);
  });

  it('cuts one clause too long by itself at its last space, keeping "and N more"', () => {
    const long = Array.from({ length: 60 }, (_, at) => `word${String(at)}`).join(' ');
    const message = templateMessage(
      summary([group(course(null, long), { files: { added: 1 } }), group(course('CSC207'), { files: { added: 1 } })]),
    );
    expect(charCount(message)).toBeLessThanOrEqual(256);
    expect(message).toMatch(/^word0 word1 .* word\d+; and 1 more$/);

    const alone = templateMessage(summary([group(course(null, long), { files: { added: 1 } })]));
    expect(charCount(alone)).toBeLessThanOrEqual(256);
    expect(alone).toMatch(/^word0 .*word\d+$/);
  });

  it('counts characters as the shell does: a name of CJK and emoji characters', () => {
    const name = '微观经济学😀'.repeat(60);
    const message = templateMessage(summary([group(course(null, name), { files: { added: 1 } })]));
    expect(charCount(message)).toBe(256);
    expect(message.isWellFormed()).toBe(true);
  });
});
