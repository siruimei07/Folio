// How a course shows: its colour, badge text and label (app-shell handoff 12B, 23A, 26C, 27B;
// first-run handoff §1). The same rules everywhere: tree, grid headers, settings, paths.

import type { Course } from '../ipc';
import { isPaletteColor, PALETTE, type PaletteColor } from './palette';
import { nameOf } from './paths';

const graphemes = new Intl.Segmenter('en', { granularity: 'grapheme' });
const utf8 = new TextEncoder();

/** Letters and digits of every script; the badge skips spaces and punctuation. */
const LETTER = /[\p{L}\p{N}]/u;

/** Scripts whose characters are about twice as wide as Latin letters. */
const WIDE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

/**
 * The course's palette colour: its own, else the colour at FNV-1a 32-bit of its folder name's
 * UTF-8 bytes, mod 10, so every device shows the same one.
 */
export function courseColor(course: Pick<Course, 'color' | 'folder'>): PaletteColor {
  if (course.color !== null && isPaletteColor(course.color)) return course.color;
  let hash = 0x811c9dc5;
  for (const byte of utf8.encode(nameOf(course.folder.path))) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return PALETTE[hash % PALETTE.length] ?? 'stone';
}

/**
 * The badge text: the course's own abbreviation, else the first three letters of its name with
 * the first in upper case ("Cal" for Calculus of Several Variables). Names that start in a wide
 * script (Chinese, Japanese, Korean) take two characters, which fit the badge.
 */
export function courseBadgeText(course: Pick<Course, 'abbr' | 'name'>): string {
  if (course.abbr !== null && course.abbr !== '') return course.abbr;
  const letters = Array.from(graphemes.segment(course.name), ({ segment }) => segment).filter(
    (segment) => LETTER.test(segment),
  );
  const first = letters[0];
  if (first === undefined) return '';
  if (WIDE.test(first)) return letters.slice(0, 2).join('');
  return first.toLocaleUpperCase('en') + letters.slice(1, 3).join('').toLocaleLowerCase('en');
}

/** The course's code, or `null` when it has none (an empty code counts as none). */
export function courseCode(course: Pick<Course, 'code'>): string | null {
  return course.code === null || course.code === '' ? null : course.code;
}

/**
 * The course's name as it shows after its code (26C): a folder named "MAT232 Calculus of Several
 * Variables" with the code MAT232 shows "Calculus of Several Variables", not the code twice.
 * Without a code, or when the name is only the code, the whole name.
 */
export function courseNameAfterCode(course: Pick<Course, 'code' | 'name'>): string {
  const code = courseCode(course);
  if (code === null || course.name.length <= code.length) return course.name;
  if (course.name.slice(0, code.length).toLocaleLowerCase('en') !== code.toLocaleLowerCase('en')) return course.name;
  const rest = course.name.slice(code.length).replace(/^[\s\-–—:_·]+/u, '');
  return rest === '' || rest.length === course.name.length - code.length ? course.name : rest;
}

/** The course in full, for accessible names and tooltips: "MAT232 Calculus of Several Variables". */
export function courseTitle(course: Pick<Course, 'code' | 'name'>): string {
  const code = courseCode(course);
  return code === null ? course.name : `${code} ${courseNameAfterCode(course)}`;
}

/** The course in paths, search locations and commit titles: its code, else its name (27B). */
export function courseLabel(course: Pick<Course, 'code' | 'name'>): string {
  return courseCode(course) ?? course.name;
}
