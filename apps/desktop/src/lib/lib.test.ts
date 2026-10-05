import { describe, expect, it } from 'vitest';

import { courseBadgeText, courseColor, courseLabel } from './courses';
import { extensionOf, FILE_TYPE_COLOR, fileTypeOf } from './file-types';
import { formatMoment, formatNumber, percentOf, sizeParts } from './format';
import { isPaletteColor, PALETTE } from './palette';
import { isActiveJob } from './jobs';
import { isBelow, isInside, movePath, nameOf, parentOf, windowsPath } from './paths';
import { isOlderRevision, newerRevision } from './revision';

const folder = (path: string) => ({ id: '1', path });

describe('courses', () => {
  it('keeps a stored colour and derives a stable one from the folder name otherwise', () => {
    expect(courseColor({ color: 'teal', folder: folder('Fall 2026/MAT232') })).toBe('teal');
    const derived = courseColor({ color: null, folder: folder('Fall 2026/MAT232 Calculus') });
    expect(isPaletteColor(derived)).toBe(true);
    // The folder name decides, not the semester above it.
    expect(courseColor({ color: null, folder: folder('Winter 2027/MAT232 Calculus') })).toBe(derived);
    // An unknown stored colour falls back to the rule.
    expect(courseColor({ color: 'mauve', folder: folder('Fall 2026/MAT232 Calculus') })).toBe(derived);
  });

  it('hashes the UTF-8 bytes with FNV-1a', () => {
    // FNV-1a 32 of "a" is 0xe40c292c; mod 10 = 8 → pink.
    expect(courseColor({ color: null, folder: folder('a') })).toBe(PALETTE[0xe40c292c % 10]);
  });

  it('writes the badge from the first three letters of the name, or two wide characters', () => {
    const badge = (name: string, abbr: string | null = null) => courseBadgeText({ name, abbr, code: null });
    expect(badge('Calculus of Several Variables')).toBe('Cal');
    expect(badge('software design')).toBe('Sof');
    expect(badge('1 Intro')).toBe('1in');
    expect(badge('线性代数')).toBe('线性');
    expect(badge('Theory of Computation', 'ToC')).toBe('ToC');
    expect(badge('---')).toBe('');
  });

  it('writes the badge from the letters of the code first, in upper case', () => {
    const badge = (code: string | null, name = 'Calculus', abbr: string | null = null) =>
      courseBadgeText({ code, name, abbr });
    expect(badge('CSC207')).toBe('CSC');
    expect(badge('ECO101')).toBe('ECO');
    expect(badge('MAT232')).toBe('MAT');
    expect(badge('STA256')).toBe('STA');
    expect(badge('mat232')).toBe('MAT');
    // At most three letters, and only the first run of them.
    expect(badge('COMP1511')).toBe('COM');
    expect(badge('CS-101')).toBe('CS');
    expect(badge('2A03')).toBe('A');
    // A code without letters, or no code, falls back to the name.
    expect(badge('207')).toBe('Cal');
    expect(badge('')).toBe('Cal');
    expect(badge(null)).toBe('Cal');
    // A wide script takes two characters, as names do.
    expect(badge('线代101', '线性代数')).toBe('线代');
    // An explicit badge still wins.
    expect(badge('CSC207', 'Software Design', 'SD')).toBe('SD');
  });

  it('labels a course by its code, else its name', () => {
    expect(courseLabel({ code: 'MAT232', name: 'Calculus' })).toBe('MAT232');
    expect(courseLabel({ code: null, name: 'Calculus' })).toBe('Calculus');
    expect(courseLabel({ code: '', name: 'Calculus' })).toBe('Calculus');
  });
});

describe('file types', () => {
  it('maps extensions case-insensitively', () => {
    expect(fileTypeOf('Lecture 7.PDF')).toBe('pdf');
    expect(fileTypeOf('ps2.docx')).toBe('word');
    expect(fileTypeOf('notes.md')).toBe('markdown');
    expect(fileTypeOf('Makefile')).toBe('code');
    expect(fileTypeOf('.gitignore')).toBe('other');
    expect(fileTypeOf('archive.tar.gz')).toBe('archive');
    expect(fileTypeOf('constructor')).toBe('other');
    expect(extensionOf('.env')).toBe('');
  });

  it('gives every type a palette colour but other', () => {
    expect(FILE_TYPE_COLOR.pdf).toBe('red');
    expect(FILE_TYPE_COLOR.other).toBeNull();
  });
});

describe('format', () => {
  it('formats numbers and sizes in the language given', () => {
    expect(formatNumber(4210, 'en')).toBe('4,210');
    expect(sizeParts(512, 'en')).toEqual({ value: '512', unit: 'bytes' });
    expect(sizeParts(12 * 1024 + 300, 'en')).toEqual({ value: '12', unit: 'kilobytes' });
    expect(sizeParts(48.2 * 1024 * 1024, 'en')).toEqual({ value: '48.2', unit: 'megabytes' });
    expect(sizeParts(3 * 1024 ** 3, 'en')).toEqual({ value: '3.0', unit: 'gigabytes' });
  });

  it('shows the time for today and the date before', () => {
    const now = new Date(2026, 8, 30, 17, 30).getTime();
    expect(formatMoment(new Date(2026, 8, 30, 17, 12).getTime(), now, 'en')).toBe('5:12 PM');
    expect(formatMoment(new Date(2026, 8, 27, 9, 0).getTime(), now, 'en')).toBe('Sep 27');
  });

  it('never reaches 100 percent before the work is done', () => {
    expect(percentOf(0, 0)).toBe(0);
    expect(percentOf(38, 100)).toBe(38);
    expect(percentOf(999, 1000)).toBe(99);
    expect(percentOf(1000, 1000)).toBe(100);
  });
});

describe('paths', () => {
  it('splits and compares library paths exactly', () => {
    expect(parentOf('MAT232/Problem sets/ps2.pdf')).toBe('MAT232/Problem sets');
    expect(parentOf('MAT232')).toBe('');
    expect(nameOf('MAT232/Problem sets/ps2.pdf')).toBe('ps2.pdf');
    expect(isInside('MAT232/ps2.pdf', 'MAT232')).toBe(true);
    expect(isInside('MAT232', 'MAT232')).toBe(true);
    expect(isInside('MAT2320/ps2.pdf', 'MAT232')).toBe(false);
    expect(isInside('mat232/ps2.pdf', 'MAT232')).toBe(false);
    expect(isInside('anything', null)).toBe(true);
    expect(isBelow('MAT232/ps2.pdf', 'MAT232')).toBe(true);
    expect(isBelow('MAT232', 'MAT232')).toBe(false);
    expect(isBelow('MAT2320/ps2.pdf', 'MAT232')).toBe(false);
    expect(isBelow('MAT232', '')).toBe(true);
    expect(isBelow('', '')).toBe(false);
  });

  it('moves a prefix and joins Windows paths', () => {
    expect(movePath('A/B/c.md', 'A/B', 'X')).toBe('X/c.md');
    expect(movePath('A/B', 'A/B', 'X')).toBe('X');
    expect(windowsPath('D:/Courses/', 'Fall 2026/MAT232/ps2.pdf')).toBe(
      String.raw`D:/Courses\Fall 2026\MAT232\ps2.pdf`,
    );
    expect(windowsPath(String.raw`D:\Courses`, '')).toBe(String.raw`D:\Courses`);
  });
});

describe('jobs', () => {
  it('counts queued and running jobs as active', () => {
    expect(isActiveJob({ status: { state: 'queued' } })).toBe(true);
    expect(isActiveJob({ status: { state: 'running', progress: { done: 0, total: null, permille: null, bytes: null, current: null } } })).toBe(true);
    expect(isActiveJob({ status: { state: 'cancelled', result: null } })).toBe(false);
    expect(isActiveJob({ status: { state: 'failed', error: { code: 'Internal', detail: '' }, file: null } })).toBe(false);
  });
});

describe('revisions', () => {
  it('compares across the 32-bit wrap', () => {
    expect(isOlderRevision(1, 2)).toBe(true);
    expect(isOlderRevision(2, 1)).toBe(false);
    expect(isOlderRevision(5, 5)).toBe(false);
    expect(isOlderRevision(2 ** 32 - 1, 0)).toBe(true);
    expect(isOlderRevision(0, 2 ** 32 - 1)).toBe(false);
    expect(newerRevision(2 ** 32 - 2, 3)).toBe(3);
  });
});
