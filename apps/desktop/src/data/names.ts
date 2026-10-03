// What a page checks before it sends a name the user typed (first-run handoff §8; ipc-m1 §16.3,
// library core §3), the defaults the first run and the semester dialogs fill in (§1, §4.3), and
// the colours new courses get (§1). The shell checks every name again; these only let a page flag
// a mistake before it asks. In data/ rather than lib/, because the limits are the contract's.
import { type AppError, LIMITS } from '../ipc';
import { hasControl, hasInvalidNameCharacter, type NameCode, nameProblem } from '../lib/names';
import { PALETTE, type PaletteColor } from '../lib/palette';
import { charCount } from '../lib/text';

// A character no name, or no folder name, may hold, flagged while the user types (§8).
export { hasControl, hasInvalidNameCharacter as hasInvalidFolderCharacter, type NameCode };

type Code = AppError['code'];

/** The codes of a folder name the shell can answer for a semester or course (§8). */
const FOLDER_CODES = [
  'NameEmpty',
  'NameTooLong',
  'NameInvalidCharacter',
  'NameTrailingDotOrSpace',
  'NameReserved',
  'PathTooLong',
  'AlreadyExists',
] as const satisfies readonly Code[];
export type FolderCode = (typeof FOLDER_CODES)[number];

/** The codes of a library name (§8). */
const LIBRARY_NAME_CODES = ['NameEmpty', 'NameTooLong', 'NameInvalidCharacter'] as const satisfies readonly NameCode[];
export type LibraryNameCode = (typeof LIBRARY_NAME_CODES)[number];

/** The codes of a course code, which may be empty (§8). */
export type CourseCodeCode = Exclude<LibraryNameCode, 'NameEmpty'>;

export function isFolderCode(code: string): code is FolderCode {
  return (FOLDER_CODES as readonly string[]).includes(code);
}

export function isLibraryNameCode(code: string): code is LibraryNameCode {
  return (LIBRARY_NAME_CODES as readonly string[]).includes(code);
}

/** A library, tag or device name: 1–128 characters without control characters (ipc-m1 §16.3). */
export function checkDisplayName(raw: string): LibraryNameCode | null {
  const name = raw.trim();
  if (name === '') return 'NameEmpty';
  if (hasControl(name)) return 'NameInvalidCharacter';
  if (charCount(name) > LIMITS.displayNameChars) return 'NameTooLong';
  return null;
}

/** A semester or course folder name (library core §3). `atRoot`: a semester, beside `.folio`. */
export function checkFolderName(raw: string, atRoot: boolean): NameCode | null {
  return nameProblem(raw.trim(), LIMITS.nameUnits, atRoot);
}

/** A course code: empty sends `null`, so only its length and characters are checked. */
export function checkCourseCode(raw: string): CourseCodeCode | null {
  const code = raw.trim();
  if (code === '') return null;
  if (hasControl(code)) return 'NameInvalidCharacter';
  if (charCount(code) > LIMITS.courseCodeChars) return 'NameTooLong';
  return null;
}

const graphemes = new Intl.Segmenter('en', { granularity: 'grapheme' });

/**
 * A course badge (`abbr`): empty sends `null`, the default from the course name; otherwise 1–3
 * grapheme clusters without whitespace or control characters (ipc-m1 §7).
 */
export function checkBadge(raw: string): CourseCodeCode | null {
  const badge = raw.trim();
  if (badge === '') return null;
  if (hasControl(badge) || /\s/u.test(badge)) return 'NameInvalidCharacter';
  if ([...graphemes.segment(badge)].length > LIMITS.abbrGraphemes) return 'NameTooLong';
  return null;
}

/** How NTFS compares names: without case (Folio's `AlreadyExists` is the same). */
export function sameFolderName(a: string, b: string): boolean {
  return a.trim().toUpperCase() === b.trim().toUpperCase();
}

/** The last name of a Windows path, for the library name's default: "D:\University" → "University". */
export function lastName(path: string): string {
  const names = path.split(/[\\/]/u).filter((name) => name.trim() !== '');
  return (names.at(-1) ?? '').trim();
}

/** The drive of a Windows path, like "E:", for "Free up some space on E:"; `null` for a share. */
export function driveOf(path: string): string | null {
  return /^[A-Za-z]:/u.exec(path)?.[0].toUpperCase() ?? null;
}

export type Term = 'fall' | 'winter' | 'summer';

/**
 * The University of Toronto term of a date (§1): Winter January–April, Summer May–August, Fall
 * September–December.
 */
export function termOf(date: Date): { term: Term; year: number } {
  const month = date.getMonth();
  const term: Term = month < 4 ? 'winter' : month < 8 ? 'summer' : 'fall';
  return { term, year: date.getFullYear() };
}

/**
 * The colour a new course gets (§1): the first palette colour, in palette order, that no other
 * course of its semester uses yet; after all ten, the order starts again.
 */
export function nextColor(used: readonly (string | null)[]): PaletteColor {
  const counts = new Map<string, number>();
  for (const color of used) if (color !== null) counts.set(color, (counts.get(color) ?? 0) + 1);
  const least = Math.min(...PALETTE.map((color) => counts.get(color) ?? 0));
  return PALETTE.find((color) => (counts.get(color) ?? 0) === least) ?? PALETTE[0];
}
