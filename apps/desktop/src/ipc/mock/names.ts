// Names the user types (docs/specs/ipc-m1.md §16.3; library core §3). The shell trims both ends
// and converts to NFC, then checks; the fake applies the same rules (lib/names.ts) and codes.
import { hasControl, nameProblem } from '../../lib/names';
import { charCount } from '../../lib/text';
import { LIMITS } from '../bindings';
import { fail } from './failure';

function typed(raw: string): string {
  return raw.trim().normalize('NFC');
}

/** A file or folder name: `create_folder`, `rename_entry`, `create_semester`, `create_course`. */
export function fileName(raw: string, { atRoot = false } = {}): string {
  const name = typed(raw);
  const problem = nameProblem(name, LIMITS.nameUnits, atRoot);
  if (problem !== null) fail(problem, `"${name}": ${problem}`);
  return name;
}

/** Text of 1 to `limit` characters without control characters. */
function plainText(raw: string, limit: number): string {
  const text = typed(raw);
  if (text === '') fail('NameEmpty', 'the text is empty');
  if (charCount(text) > limit) fail('NameTooLong', `over ${String(limit)} characters`);
  if (hasControl(text)) fail('NameInvalidCharacter', 'a control character');
  return text;
}

/** A library or tag name: 1–128 characters, no control characters. */
export function displayName(raw: string): string {
  return plainText(raw, LIMITS.displayNameChars);
}

const graphemes = new Intl.Segmenter('en', { granularity: 'grapheme' });

/** A course badge: 1–3 grapheme clusters without whitespace or control characters. */
export function badge(raw: string | null): string | null {
  if (raw === null) return null;
  const text = typed(raw);
  if (text === '') fail('NameEmpty', 'the badge is empty');
  if ([...graphemes.segment(text)].length > LIMITS.abbrGraphemes) {
    fail('NameTooLong', 'over abbrGraphemes');
  }
  if (hasControl(text) || /\s/u.test(text)) fail('NameInvalidCharacter', 'whitespace or control');
  return text;
}

/** A course code: 1–32 characters without control characters. */
export function courseCode(raw: string | null): string | null {
  return raw === null ? null : plainText(raw, LIMITS.courseCodeChars);
}

/** A palette key: the core checks only its form (ipc-m1 §7). */
export function paletteKey(raw: string): string {
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(raw)) fail('InvalidArgument', `"${raw}" is not a palette key`);
  return raw;
}
