// The import dialog's wording that depends on the data (library-actions handoff §4, §4.1, §5):
// the items line after the first three, the clashing paths as a sentence, the keep-both example,
// and the reasons a file was not added.
import type { TFunction } from 'i18next';

import type { AppError, ImportConflict, ImportName } from '../ipc';
import { nameOf } from '../lib/paths';

/** `t` of `useTranslation(['import', 'common', 'errors'])`. */
export type ImportT = TFunction<['import', 'common', 'errors']>;

/** Items the dialog lists by name; the rest go into one line. */
export const LISTED_ITEMS = 3;

/** Clashing paths named in the sentence before "and 9 more". */
const NAMED_CLASHES = 3;

/**
 * The line under the first three items: the fourth item's name when it is the last, else how many
 * more; `null` when there are no more. `total` counts the top-level items, `names` the first ten.
 */
export function moreItems(t: ImportT, names: readonly ImportName[], total: number): string | null {
  const more = total - LISTED_ITEMS;
  if (more <= 0) return null;
  const last = names[LISTED_ITEMS];
  return more === 1 && last !== undefined ? t('dialog.andName', { name: last.name }) : t('dialog.andMore', { count: more });
}

/** A clash's path as the dialog names it: relative to the target it would land in. */
export function clashPath(conflict: ImportConflict, targetPath: string): string {
  const prefix = `${targetPath}/`;
  return conflict.path.startsWith(prefix) ? conflict.path.slice(prefix.length) : conflict.path;
}

/**
 * The first clashing paths as a sentence: "a, b and c"; more than three: "a, b and 9 more".
 * `count` is every clash, of which `conflicts` holds the first hundred.
 */
export function clashSentence(t: ImportT, conflicts: readonly ImportConflict[], count: number, targetPath: string): string {
  const paths = conflicts.map((conflict) => clashPath(conflict, targetPath));
  const [a = '', b = '', c = ''] = paths;
  if (count > NAMED_CLASHES) return t('clashes.pathsMore', { a, b, count: count - 2 });
  if (count === 3) return t('clashes.pathsThree', { a, b, c });
  if (count === 2) return t('clashes.pathsTwo', { a, b });
  return t('clashes.pathsOne', { a });
}

/** "Lecture 7 notes (2).md": the name keep-both gives a clashing file. */
export function keepBothName(path: string): string {
  const name = nameOf(path);
  const dot = name.lastIndexOf('.');
  return dot > 0 ? `${name.slice(0, dot)} (2)${name.slice(dot)}` : `${name} (2)`;
}

/** Codes the result dialog words for a file that wasn't added; the others use `errors`. */
const REASONS = [
  'InUse',
  'AccessDenied',
  'DiskFull',
  'NameInvalidCharacter',
  'NameTrailingDotOrSpace',
  'NameReserved',
  'PathTooLong',
  'FileSystem',
] as const;

function isReason(code: string): code is (typeof REASONS)[number] {
  return (REASONS as readonly string[]).includes(code);
}

/** Why a file wasn't added, in words (library-actions §5). */
export function failureReason(t: ImportT, error: AppError): string {
  return isReason(error.code) ? t(`result.reasons.${error.code}`) : t(`errors:${error.code}`);
}
