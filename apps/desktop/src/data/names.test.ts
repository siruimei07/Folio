// What pages check and fill in before they ask the shell (first-run handoff §1, §8).
import { describe, expect, it } from 'vitest';

import {
  checkBadge,
  checkCourseCode,
  checkFolderName,
  checkDisplayName,
  driveOf,
  hasInvalidFolderCharacter,
  lastName,
  nextColor,
  sameFolderName,
  termOf,
} from './names';

describe('names', () => {
  it('checks a library name: 1–128 characters without control characters', () => {
    expect(checkDisplayName('University of Toronto')).toBeNull();
    expect(checkDisplayName('  ')).toBe('NameEmpty');
    expect(checkDisplayName('a\nb')).toBe('NameInvalidCharacter');
    expect(checkDisplayName('\u0085')).toBe('NameInvalidCharacter');
    expect(checkDisplayName('x'.repeat(128))).toBeNull();
    expect(checkDisplayName('x'.repeat(129))).toBe('NameTooLong');
    // Characters, not UTF-16 units: 128 emoji fit.
    expect(checkDisplayName('📚'.repeat(128))).toBeNull();
    expect(checkDisplayName('大学')).toBeNull();
  });

  it('checks a folder name as Windows does (library core §3)', () => {
    expect(checkFolderName('Fall 2026', true)).toBeNull();
    expect(checkFolderName('线性代数', false)).toBeNull();
    expect(checkFolderName(' ', false)).toBe('NameEmpty');
    for (const bad of ['a/b', 'a\\b', 'a:b', 'a*b', 'a?b', 'a"b', 'a<b', 'a>b', 'a|b', 'a\tb']) {
      expect(checkFolderName(bad, false)).toBe('NameInvalidCharacter');
    }
    expect(checkFolderName('Notes.', false)).toBe('NameTrailingDotOrSpace');
    // Spaces at the ends are trimmed, as the shell does.
    expect(checkFolderName('Notes ', false)).toBeNull();
    // Device names as the shell reads them (folio-core paths.rs): spaces before the extension too.
    for (const reserved of ['CON', 'nul', 'Com1', 'COM0', 'LPT9', 'nul.txt', 'COM¹', 'CONIN$', 'conout$', 'CON .txt', '.', '..']) {
      expect(checkFolderName(reserved, false)).toBe('NameReserved');
    }
    expect(checkFolderName('CONSOLE', false)).toBeNull();
    expect(checkFolderName('COM10', false)).toBeNull();
    expect(checkFolderName('NUL-notes.md', false)).toBeNull();
    // DEL and C1 controls as well as C0.
    expect(checkFolderName('a\u007fb', false)).toBe('NameInvalidCharacter');
    expect(checkFolderName('a\u0085b', false)).toBe('NameInvalidCharacter');
    expect(checkFolderName('.folio', true)).toBe('NameReserved');
    expect(checkFolderName('.FOLIO', true)).toBe('NameReserved');
    expect(checkFolderName('.folio', false)).toBeNull();
    expect(checkFolderName('x'.repeat(255), false)).toBeNull();
    expect(checkFolderName('x'.repeat(256), false)).toBe('NameTooLong');
    expect(hasInvalidFolderCharacter('a:b')).toBe(true);
    expect(hasInvalidFolderCharacter('Notes.')).toBe(false);
  });

  it('checks a course code, which may be empty', () => {
    expect(checkCourseCode('')).toBeNull();
    expect(checkCourseCode('  ')).toBeNull();
    expect(checkCourseCode('MAT232')).toBeNull();
    expect(checkCourseCode('x'.repeat(32))).toBeNull();
    expect(checkCourseCode('x'.repeat(33))).toBe('NameTooLong');
    expect(checkCourseCode('MAT\u0000')).toBe('NameInvalidCharacter');
  });

  it('compares folder names without case', () => {
    expect(sameFolderName('Algebra', ' algebra ')).toBe(true);
    expect(sameFolderName('Algebra', 'Algebra I')).toBe(false);
  });

  it('takes the library name and the drive from a Windows path', () => {
    expect(lastName('D:\\University')).toBe('University');
    expect(lastName('C:\\Users\\Student\\Documents\\Folio\\')).toBe('Folio');
    expect(lastName('\\\\server\\share\\Courses')).toBe('Courses');
    expect(lastName('E:\\')).toBe('E:');
    expect(driveOf('e:\\Courses')).toBe('E:');
    expect(driveOf('\\\\server\\share')).toBeNull();
  });

  it('names the term of a date as the University of Toronto does', () => {
    expect(termOf(new Date(2026, 0, 5))).toEqual({ term: 'winter', year: 2026 });
    expect(termOf(new Date(2026, 3, 30))).toEqual({ term: 'winter', year: 2026 });
    expect(termOf(new Date(2026, 4, 1))).toEqual({ term: 'summer', year: 2026 });
    expect(termOf(new Date(2026, 7, 31))).toEqual({ term: 'summer', year: 2026 });
    expect(termOf(new Date(2026, 8, 1))).toEqual({ term: 'fall', year: 2026 });
    expect(termOf(new Date(2026, 11, 31))).toEqual({ term: 'fall', year: 2026 });
  });

  it('gives a new course the first colour its semester does not use yet, then starts again', () => {
    expect(nextColor([])).toBe('red');
    expect(nextColor(['red'])).toBe('orange');
    expect(nextColor(['orange', null, 'unknown'])).toBe('red');
    const all = ['red', 'orange', 'amber', 'green', 'teal', 'blue', 'indigo', 'violet', 'pink', 'stone'];
    expect(nextColor(all)).toBe('red');
    expect(nextColor([...all, 'red'])).toBe('orange');
  });

  it('checks a course badge: empty is the default, else 1–3 graphemes without spaces', () => {
    expect(checkBadge('  ')).toBeNull();
    expect(checkBadge('Cal')).toBeNull();
    expect(checkBadge('线代')).toBeNull();
    expect(checkBadge('👩‍🔬AB')).toBeNull();
    expect(checkBadge('Calc')).toBe('NameTooLong');
    expect(checkBadge('C a')).toBe('NameInvalidCharacter');
    expect(checkBadge('a\tb')).toBe('NameInvalidCharacter');
  });
});
