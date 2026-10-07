// The template message (workspace-history handoff §4.6, versioning §8.1): the summary Folio writes
// from a selection's summary when nobody typed one and no AI message is used. One clause per place,
// by course code (or name), the semester's name, or "Library", with the counts in the verb order
// add, update, move, delete, tag: "MAT232: add 2 files, update 1 file; CSC207: delete 1 file". The
// phrases are strings in `changes`, read in English whatever the UI language: the summary is
// stored in history and synced (handoff §16).
import i18n, { type TFunction } from 'i18next';

import { type ChangeCounts, LIMITS, type Place, type SelectionSummary, type SummaryGroup } from '../ipc';
import { charCount } from '../lib/text';

type ChangesT = TFunction<'changes'>;

/** The verbs of a clause, in their order, by the change each counts. */
const VERBS = [
  ['added', 'add'],
  ['modified', 'update'],
  ['moved', 'move'],
  ['deleted', 'delete'],
] as const satisfies readonly (readonly [keyof ChangeCounts, string])[];

/** Places named before "and N more" (§4.6). */
const PLACES_SHOWN = 3;
const PHRASE_SEPARATOR = ', ';
const CLAUSE_SEPARATOR = '; ';

/** The strings the template is written with: English, whatever the UI language. */
function englishT(): ChangesT {
  return i18n.getFixedT<'changes'>('en', 'changes');
}

/** "2 files", "1 folder", "2 files and 1 folder"; `null` for none. */
function itemsPhrase(files: number, folders: number, t: ChangesT): string | null {
  const filesText = files > 0 ? t('template.files', { count: files }) : null;
  const foldersText = folders > 0 ? t('template.folders', { count: folders }) : null;
  if (filesText !== null && foldersText !== null) return t('template.both', { first: filesText, second: foldersText });
  return filesText ?? foldersText;
}

/** "a", "a and b", "a, b and c". */
function listOf(parts: readonly string[], t: ChangesT): string {
  if (parts.length <= 1) return parts[0] ?? '';
  return t('template.both', { first: parts.slice(0, -1).join(PHRASE_SEPARATOR), second: parts.at(-1) ?? '' });
}

function placeName(place: Place, t: ChangesT): string {
  switch (place.kind) {
    case 'library':
      return t('template.library');
    case 'semester':
      return place.name;
    case 'course':
      return place.code ?? place.name;
  }
}

/** What changed in a place's own settings: "course settings", "semester settings". */
function settingsOf(group: SummaryGroup, t: ChangesT): string | null {
  if (!group.settings || group.place.kind === 'library') return null;
  return group.place.kind === 'course' ? t('template.courseSettings') : t('template.semesterSettings');
}

/** Whether a place has included items or tag changes, not only its own settings. */
function hasItems(group: SummaryGroup): boolean {
  return group.tags > 0 || VERBS.some(([change]) => group.files[change] + group.folders[change] > 0);
}

/** "MAT232: add 2 files, tag 1 file, update course settings"; `null` when nothing of it is included. */
function placeClause(group: SummaryGroup, t: ChangesT): string | null {
  const phrases: string[] = [];
  for (const [change, verb] of VERBS) {
    const what = itemsPhrase(group.files[change], group.folders[change], t);
    if (what !== null) phrases.push(t(`template.${verb}`, { what }));
  }
  if (group.tags > 0) phrases.push(t('template.tag', { what: t('template.files', { count: group.tags }) }));
  const settings = settingsOf(group, t);
  if (settings !== null) phrases.push(t('template.update', { what: settings }));
  if (phrases.length === 0) return null;
  return t('template.clause', { place: placeName(group.place, t), changes: phrases.join(PHRASE_SEPARATOR) });
}

/** The library-wide changes: "library settings", "tags", "ignore rules". */
function libraryParts(summary: SelectionSummary, t: ChangesT): string[] {
  return [
    ...(summary.library ? [t('template.librarySettings')] : []),
    ...(summary.tagDefinitions ? [t('template.tagDefinitions')] : []),
    ...(summary.ignoreRules ? [t('template.ignoreRules')] : []),
  ];
}

/**
 * Settings only (§4.6): "Update course settings", "Update library settings", "Update tags", or
 * several of them in one sentence; `null` when an item or a tag change is included.
 */
function settingsOnly(summary: SelectionSummary, t: ChangesT): string | null {
  if (summary.groups.some(hasItems)) return null;
  const places = new Set(summary.groups.flatMap((group) => settingsOf(group, t) ?? []));
  const parts = [...places, ...libraryParts(summary, t)];
  return parts.length === 0 ? null : t('template.updateOnly', { what: listOf(parts, t) });
}

/**
 * `text` cut to at most `limit` characters at its last space (versioning §8.1), with no white space
 * or separator left at its end; at `limit` when it has no space to cut at.
 */
function cutAtSpace(text: string, limit: number): string {
  const characters = Array.from(text);
  if (characters.length <= limit) return text;
  const head = characters.slice(0, limit).join('');
  const space = characters[limit] === ' ' ? head.length : head.lastIndexOf(' ');
  const cut = (space > 0 ? head.slice(0, space) : head).replace(/[\s,;:]+$/u, '');
  return cut === '' ? head : cut;
}

/** The clauses joined, then "and N more" for the places left out. */
function joined(clauses: readonly string[], more: number, t: ChangesT): string {
  const all = more > 0 ? [...clauses, t('template.more', { count: more })] : clauses;
  return all.join(CLAUSE_SEPARATOR);
}

/**
 * The template message for a selection's summary (§4.6): at most `LIMITS.summaryChars`
 * characters, cut at a clause boundary (places past the cut join "and N more"), or within the one
 * clause left at its last space. `''` when the summary includes nothing.
 */
export function templateMessage(summary: SelectionSummary, t: ChangesT = englishT()): string {
  const only = settingsOnly(summary, t);
  if (only !== null) return cutAtSpace(only, LIMITS.summaryChars);
  const library = libraryParts(summary, t);
  const clauses = [
    ...summary.groups.flatMap((group) => placeClause(group, t) ?? []),
    ...(library.length > 0 ? [t('template.update', { what: listOf(library, t) })] : []),
  ];
  if (clauses.length === 0) return summary.items + summary.metadata > 0 ? t('template.fallback') : '';
  let shown = Math.min(clauses.length, PLACES_SHOWN);
  let text = joined(clauses.slice(0, shown), clauses.length - shown, t);
  while (charCount(text) > LIMITS.summaryChars && shown > 1) {
    shown -= 1;
    text = joined(clauses.slice(0, shown), clauses.length - shown, t);
  }
  if (charCount(text) <= LIMITS.summaryChars) return text;
  // One clause too long by itself (a long course name): cut inside it, keeping "and N more".
  const more = clauses.length - shown;
  const suffix = more > 0 ? `${CLAUSE_SEPARATOR}${t('template.more', { count: more })}` : '';
  return `${cutAtSpace(clauses[0] ?? '', LIMITS.summaryChars - charCount(suffix))}${suffix}`;
}
