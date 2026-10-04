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

/** The first run of letters of every script, without digits: what a code's badge is made of. */
const CODE_LETTERS = /\p{L}+/u;

/**
 * The badge text (app-shell handoff 23): the course's own abbreviation; else the first letters of
 * its code in upper case ("CSC" for CSC207, "CS" for CS-101); else, for a course without a code or
 * a code without letters, the first three letters of its name with the first in upper case ("Cal"
 * for Calculus of Several Variables). Text that starts in a wide script (Chinese, Japanese,
 * Korean) takes two characters, which fit the badge.
 */
export function courseBadgeText(course: Pick<Course, 'abbr' | 'code' | 'name'>): string {
  if (course.abbr !== null && course.abbr !== '') return course.abbr;
  const codeLetters = course.code?.match(CODE_LETTERS)?.[0];
  if (codeLetters !== undefined) {
    return firstLetters(graphemesOf(codeLetters), (three) => three.join('').toLocaleUpperCase('en'));
  }
  return firstLetters(
    graphemesOf(course.name).filter((segment) => LETTER.test(segment)),
    ([first = '', ...rest]) => first.toLocaleUpperCase('en') + rest.join('').toLocaleLowerCase('en'),
  );
}

/** Two characters when the first is in a wide script, which fit the badge; else three, cased. */
function firstLetters(letters: readonly string[], cased: (three: readonly string[]) => string): string {
  const first = letters[0];
  if (first === undefined) return '';
  return WIDE.test(first) ? letters.slice(0, 2).join('') : cased(letters.slice(0, 3));
}

function graphemesOf(text: string): string[] {
  return Array.from(graphemes.segment(text), ({ segment }) => segment);
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
