// The words of every problem kind and cause (library-actions handoff §11 table), the §11 group
// order, and the characters an `invalidCharacter` row names.
import i18n from 'i18next';
import { describe, expect, it } from 'vitest';

import type { Problem, ProblemItem } from '../ipc';
import { describeProblem, GROUPS, groupProblems, invalidCharacters, joinPath, type ProblemsT } from './describe';

const t = i18n.getFixedT(null, ['problems', 'shell', 'errors']) as unknown as ProblemsT;

function row(problem: Problem) {
  return describeProblem(t, problem, 'en');
}

function item(id: string, problem: Problem): ProblemItem {
  return { id, problem, detail: '' };
}

const RENAME = 'Rename it on the device that made it; until then Folio leaves it out.';

describe('joinPath', () => {
  it('puts a name in its folder, or at the root', () => {
    expect(joinPath('MAT232/lab', 'a.pdf')).toBe('MAT232/lab/a.pdf');
    expect(joinPath(null, 'a.pdf')).toBe('a.pdf');
    expect(joinPath('', 'a.pdf')).toBe('a.pdf');
  });
});

describe('groupProblems', () => {
  it('lists the groups in the §11 order, leaving out empty ones, rows in the order they came', () => {
    const groups = groupProblems(t, [
      item('1', { kind: 'notRelocated', from: 'a', to: 'b', cause: 'tooLong' }),
      item('2', { kind: 'link', folder: null, name: 'x' }),
      item('3', { kind: 'notUnicode', folder: null, name: '�' }),
      item('4', { kind: 'link', folder: null, name: 'y' }),
    ], 'en');
    expect(groups.map((group) => group.kind)).toEqual(['notUnicode', 'link', 'notRelocated']);
    expect(groups[1]?.rows.map((row) => [row.id, row.title])).toEqual([
      ['2', 'x'],
      ['4', 'y'],
    ]);
  });

  it('has a group for every kind, each once', () => {
    const kinds: Problem['kind'][] = [
      'notUnicode',
      'invalidName',
      'notNfc',
      'caseTwins',
      'unreadable',
      'link',
      'special',
      'invalidIgnoreRule',
      'metadata',
      'orphanedMetadata',
      'notRelocated',
    ];
    expect(GROUPS.map((group) => group.kind)).toEqual(kinds);
    for (const kind of kinds) expect(t(`groups.${kind}`)).not.toBe(`groups.${kind}`);
  });
});

describe('invalidCharacters', () => {
  it('names each character once, in the order it first appears; control characters as one', () => {
    expect(invalidCharacters('a:b?c:d')).toEqual([':', '?']);
    expect(invalidCharacters('tab\there\u0001')).toEqual(['control']);
    expect(invalidCharacters('plain.txt')).toEqual([]);
  });
});

describe('describeProblem', () => {
  it('notUnicode: the path with � as the shell sent it, and Copy path', () => {
    expect(row({ kind: 'notUnicode', folder: 'MAT232', name: 'r�sum�.pdf' })).toEqual({
      title: 'MAT232/r�sum�.pdf',
      explanation:
        "Its name has characters Windows stores incorrectly. Rename it in File Explorer; until then Folio leaves it out.",
      action: { kind: 'copy', paths: ['MAT232/r�sum�.pdf'], label: 'Copy path of MAT232/r�sum�.pdf' },
    });
  });

  it.each([
    ['trailingDotOrSpace', 'Ends with a dot or a space.'],
    ['reservedName', 'Uses a name Windows reserves, like CON or NUL.'],
    ['dotName', 'Is named . or .., which Windows reserves.'],
    ['tooLong', 'Its name is longer than Windows allows.'],
    ['pathTooLong', 'Its full path is longer than Windows allows. Shorten the folders above it.'],
    ['empty', 'Has no name.'],
  ] as const)('invalidName %s', (rule, reason) => {
    const described = row({ kind: 'invalidName', folder: 'ECO101', name: 'Summary ', rule });
    expect(described.title).toBe('ECO101/Summary ');
    expect(described.explanation).toBe(`${reason} ${RENAME}`);
    expect(described.action).toEqual({ kind: 'copy', paths: ['ECO101/Summary '], label: 'Copy path of ECO101/Summary ' });
  });

  it('invalidName invalidCharacter: names the one character found, or lists several', () => {
    const one = row({ kind: 'invalidName', folder: 'CSC207/lab2', name: 'notes:v2.md', rule: 'invalidCharacter' });
    expect(one.explanation).toBe(`Has a colon ( : ). ${RENAME}`);
    const several = row({ kind: 'invalidName', folder: null, name: 'a:b?.md', rule: 'invalidCharacter' });
    expect(several.explanation).toBe(`Has characters Windows doesn't allow ( : and ? ). ${RENAME}`);
    const three = row({ kind: 'invalidName', folder: null, name: '*a|b\u0002', rule: 'invalidCharacter' });
    expect(three.explanation).toBe(
      `Has characters Windows doesn't allow ( *, |, and a hidden control character ). ${RENAME}`,
    );
    const control = row({ kind: 'invalidName', folder: null, name: 'a\u0007', rule: 'invalidCharacter' });
    expect(control.explanation).toBe(`Has a hidden control character. ${RENAME}`);
    const unknown = row({ kind: 'invalidName', folder: null, name: 'fine', rule: 'invalidCharacter' });
    expect(unknown.explanation).toBe(`Has characters Windows doesn't allow. ${RENAME}`);
  });

  it.each([
    ['<', 'a less-than sign ( < )'],
    ['>', 'a greater-than sign ( > )'],
    ['"', 'a double quote ( " )'],
    ['/', 'a slash ( / )'],
    ['\\', 'a backslash ( \\ )'],
    ['|', 'a vertical bar ( | )'],
    ['?', 'a question mark ( ? )'],
    ['*', 'an asterisk ( * )'],
  ])('invalidName invalidCharacter names %s', (character, words) => {
    const described = row({ kind: 'invalidName', folder: null, name: `a${character}b`, rule: 'invalidCharacter' });
    expect(described.explanation).toBe(`Has ${words}. ${RENAME}`);
  });

  it('invalidName notNfc reads as a notNfc row', () => {
    expect(row({ kind: 'invalidName', folder: null, name: 'Café', rule: 'notNfc' }).explanation).toBe(
      row({ kind: 'notNfc', folder: null, name: 'Café', twin: false }).explanation,
    );
  });

  it('notNfc: rename to the same text; with a twin, rename one of them', () => {
    expect(row({ kind: 'notNfc', folder: 'Fall 2026', name: 'Café.md', twin: false })).toMatchObject({
      title: 'Fall 2026/Café.md',
      explanation:
        'Its name uses a Unicode form Windows treats differently, common for names typed on a Mac or iPad. Rename it in File Explorer, even to the same text, and Folio adds it.',
    });
    expect(row({ kind: 'notNfc', folder: 'Fall 2026', name: 'Café.md', twin: true }).explanation).toBe(
      'Its name uses a Unicode form Windows treats differently, common for names typed on a Mac or iPad. Another item here has the same name in the standard form. Rename one of them.',
    );
  });

  it('caseTwins: two paths by name, three or more by count; Copy path copies all of them', () => {
    expect(row({ kind: 'caseTwins', paths: ['MAT232/Lecture 3.pdf', 'MAT232/lecture 3.pdf'] })).toEqual({
      title: 'MAT232/Lecture 3.pdf and MAT232/lecture 3.pdf',
      explanation: "iCloud and your other devices can't keep both. Rename one of them.",
      action: {
        kind: 'copy',
        paths: ['MAT232/Lecture 3.pdf', 'MAT232/lecture 3.pdf'],
        label: 'Copy paths of MAT232/Lecture 3.pdf and MAT232/lecture 3.pdf',
      },
    });
    const three = row({ kind: 'caseTwins', paths: ['MAT232/Lecture 3.pdf', 'MAT232/lecture 3.pdf', 'MAT232/LECTURE 3.pdf'] });
    expect(three.title).toBe('3 items like MAT232/Lecture 3.pdf');
    expect(three.action).toMatchObject({ paths: expect.arrayContaining(['MAT232/LECTURE 3.pdf']) as unknown });
  });

  it.each([
    ['denied', 'Windows denied access. Folio keeps what it already knew about it.'],
    ['inUse', 'Another app is using it. Folio tries again on the next scan.'],
    ['tooLarge', "It's too large for Folio to read."],
    ['other', 'Something went wrong reading it. Folio tries again on the next scan.'],
  ] as const)('unreadable %s, and a metadata file unreadable the same way', (failure, explanation) => {
    expect(row({ kind: 'unreadable', path: 'STA256/rec.m4a', failure })).toEqual({
      title: 'STA256/rec.m4a',
      explanation,
      action: { kind: 'copy', paths: ['STA256/rec.m4a'], label: 'Copy path of STA256/rec.m4a' },
    });
    expect(
      row({ kind: 'metadata', file: '.folio/meta/tags.json', failure: { kind: 'unreadable', failure } }).explanation,
    ).toBe(explanation);
  });

  it('link and special', () => {
    expect(row({ kind: 'link', folder: 'CSC207/lab1', name: '.venv' })).toMatchObject({
      title: 'CSC207/lab1/.venv',
      explanation: 'It links to another place, so Folio skips it.',
    });
    expect(row({ kind: 'special', folder: null, name: 'pipe' })).toMatchObject({
      title: 'pipe',
      explanation: 'Folio skips devices, pipes and other special items.',
    });
  });

  it('invalidIgnoreRule in your ignore rules: the line, and Edit ignore rules', () => {
    expect(row({ kind: 'invalidIgnoreRule', file: null, line: 4 })).toEqual({
      title: 'Line 4 of your ignore rules',
      explanation: "It isn't a valid pattern, so Folio skips that line. The other lines still apply.",
      action: { kind: 'editIgnoreRules' },
    });
    expect(row({ kind: 'invalidIgnoreRule', file: null, line: 0 })).toEqual({
      title: 'Your ignore rules',
      explanation: "Folio couldn't read your ignore rules, so none of them apply.",
      action: { kind: 'editIgnoreRules' },
    });
  });

  it('invalidIgnoreRule in a .gitignore: the line of that file, and Copy path of the file', () => {
    expect(row({ kind: 'invalidIgnoreRule', file: 'MAT232/project/.gitignore', line: 1204 })).toEqual({
      title: 'Line 1,204 of MAT232/project/.gitignore',
      explanation: "It isn't a valid pattern, so Folio skips that line. The other lines still apply.",
      action: {
        kind: 'copy',
        paths: ['MAT232/project/.gitignore'],
        label: 'Copy path of MAT232/project/.gitignore',
      },
    });
    expect(row({ kind: 'invalidIgnoreRule', file: 'MAT232/.gitignore', line: 0 })).toMatchObject({
      title: 'MAT232/.gitignore',
      explanation: "Folio couldn't read this file, so none of its rules apply.",
    });
  });

  it('metadata newer and invalid', () => {
    expect(row({ kind: 'metadata', file: '.folio/meta/tags.json', failure: { kind: 'newer' } })).toEqual({
      title: '.folio/meta/tags.json',
      explanation: 'A newer version of Folio saved it. Update Folio.',
      action: { kind: 'copy', paths: ['.folio/meta/tags.json'], label: 'Copy path of .folio/meta/tags.json' },
    });
    expect(row({ kind: 'metadata', file: '.folio/meta/x.json', failure: { kind: 'invalid' } }).explanation).toBe(
      "It's damaged. Folio uses your other settings and leaves this one alone.",
    );
  });

  it('orphanedMetadata', () => {
    expect(row({ kind: 'orphanedMetadata', folder: 'Fall 2024' })).toEqual({
      title: 'Fall 2024',
      explanation:
        "Folio has tags and settings for this folder, which isn't there anymore. They stay in case it comes back.",
      action: { kind: 'copy', paths: ['Fall 2024'], label: 'Copy path of Fall 2024' },
    });
  });

  it.each([
    ['readOnly', 'A newer version of Folio made your settings read-only. Update Folio, and the tags follow on the next scan.'],
    ['folderTags', "It became a semester or course folder, which can't have tags."],
    ['tooLong', "Its new path is too long for Folio's settings."],
    ['unreadable', "A settings file couldn't be read."],
  ] as const)('notRelocated %s: from → to, and Copy path copies where it is now', (cause, explanation) => {
    expect(row({ kind: 'notRelocated', from: 'Personal/a.pdf', to: 'MAT232/a.pdf', cause })).toEqual({
      title: 'Personal/a.pdf → MAT232/a.pdf',
      explanation,
      action: { kind: 'copy', paths: ['MAT232/a.pdf'], label: 'Copy path of MAT232/a.pdf' },
    });
  });
});
