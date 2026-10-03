import i18n from 'i18next';
import { describe, expect, it } from 'vitest';

import { clashSentence, failureReason, type ImportT, keepBothName, moreItems } from './words';

// The same function `useTranslation(['import', 'common', 'errors'])` gives.
const t = i18n.getFixedT(null, ['import', 'common', 'errors']) as unknown as ImportT;

const TARGET = 'Fall 2026/MAT232';
const clash = (path: string) => ({ path: `${TARGET}/${path}` });

describe('import wording', () => {
  it('names the clashing paths relative to the target, then how many more', () => {
    const three = [clash('Lecture 7 notes.md'), clash('Formula sheet.pdf'), clash('Week 7 problems/Problem 2.pdf')];
    expect(clashSentence(t, three.slice(0, 1), 1, TARGET)).toBe('Lecture 7 notes.md');
    expect(clashSentence(t, three.slice(0, 2), 2, TARGET)).toBe('Lecture 7 notes.md and Formula sheet.pdf');
    expect(clashSentence(t, three, 3, TARGET)).toBe('Lecture 7 notes.md, Formula sheet.pdf and Week 7 problems/Problem 2.pdf');
    expect(clashSentence(t, three, 11, TARGET)).toBe('Lecture 7 notes.md, Formula sheet.pdf and 9 more');
  });

  it('says what keep-both calls a copy', () => {
    expect(keepBothName(`${TARGET}/Lecture 7 notes.md`)).toBe('Lecture 7 notes (2).md');
    expect(keepBothName(`${TARGET}/Makefile`)).toBe('Makefile (2)');
    expect(keepBothName(`${TARGET}/.gitignore`)).toBe('.gitignore (2)');
  });

  it('lists the fourth item by name when it is the last, else how many more', () => {
    const names = ['a', 'b', 'c', 'd', 'e'].map((name) => ({ name, kind: 'file' as const }));
    expect(moreItems(t, names, 3)).toBeNull();
    expect(moreItems(t, names, 4)).toBe('and d');
    expect(moreItems(t, names, 10)).toBe('and 7 more');
  });

  it('words why a file was not added, and falls back to the message of its code', () => {
    expect(failureReason(t, { code: 'InUse', detail: '' })).toBe('Another app is using it.');
    expect(failureReason(t, { code: 'NameReserved', detail: '' })).toBe("Its name isn't allowed on Windows.");
    expect(failureReason(t, { code: 'NotRecyclable', detail: '' })).toMatch(/^Folio couldn't move this to the Recycle Bin/);
  });
});
