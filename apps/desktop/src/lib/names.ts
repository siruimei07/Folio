// Windows' rules for a file or folder name the user types (library core §3), as the shell applies
// them (folio-core `paths.rs`). The page's own checks (data/names.ts, the rename field) and the fake
// shell (ipc/mock/names.ts) share them, so all three answer like the real shell.
import type { AppError } from '../ipc';

/** The codes a file or folder name breaks before it reaches the disk (ipc-m1 §16.3). */
export type NameCode = Extract<
  AppError['code'],
  'NameEmpty' | 'NameTooLong' | 'NameInvalidCharacter' | 'NameTrailingDotOrSpace' | 'NameReserved'
>;

/** Control characters, which no typed name may hold (C0, DEL and C1). */
// eslint-disable-next-line no-control-regex -- control characters are what it finds
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/u;
/** Characters Windows never allows in a file or folder name. */
const NOT_IN_NAMES = /[\\/:*?"<>|]/u;
/**
 * Device names Windows reserves, in any case and with any extension, also after spaces (`nul.txt`,
 * `CON .txt`); `CONIN$` and `CONOUT$` name the console.
 */
const DEVICE_NAMES = /^(con|prn|aux|nul|conin\$|conout\$|com[0-9¹²³]|lpt[0-9¹²³]) *(\..*)?$/iu;

/** Whether the text holds a control character. */
export function hasControl(text: string): boolean {
  return CONTROL.test(text);
}

/** Whether the text holds a character a file or folder name may not: also flagged while typing. */
export function hasInvalidNameCharacter(text: string): boolean {
  return CONTROL.test(text) || NOT_IN_NAMES.test(text);
}

/**
 * The first rule a trimmed file or folder name breaks, or `null`. `maxUnits` is the contract's
 * `LIMITS.nameUnits` (UTF-16 units); `atRoot`: a semester, beside `.folio`.
 */
export function nameProblem(name: string, maxUnits: number, atRoot = false): NameCode | null {
  if (name === '') return 'NameEmpty';
  if (hasInvalidNameCharacter(name)) return 'NameInvalidCharacter';
  if (name === '.' || name === '..') return 'NameReserved';
  if (name.length > maxUnits) return 'NameTooLong';
  if (name.endsWith('.')) return 'NameTrailingDotOrSpace';
  if (DEVICE_NAMES.test(name)) return 'NameReserved';
  if (atRoot && name.toLowerCase() === '.folio') return 'NameReserved';
  return null;
}
