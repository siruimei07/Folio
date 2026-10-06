// The words and groups of the problems list (library-actions handoff §11): which group each
// problem goes in, its row's title and explanation, and what its action copies or opens. Paths are
// library-relative as the shell sends them (ipc-m1 §14).

import type { TFunction } from 'i18next';
import {
  CaseSensitive,
  EyeOff,
  FileCog,
  FileQuestionMark,
  FileWarning,
  FolderX,
  Link,
  Lock,
  type LucideIcon,
  Tag,
  Type,
} from 'lucide-react';

import type { NameRule, Problem, ProblemItem } from '../ipc';

/** `t` of `useTranslation(['problems', 'shell', 'errors'])`. */
export type ProblemsT = TFunction<['problems', 'shell', 'errors']>;

export type ProblemKind = Problem['kind'];

/** The groups, in the order the list shows them (§11), each with its 14 px icon. */
export const GROUPS: readonly { kind: ProblemKind; icon: LucideIcon }[] = [
  { kind: 'notUnicode', icon: Type },
  { kind: 'invalidName', icon: FileWarning },
  { kind: 'notNfc', icon: Type },
  { kind: 'caseTwins', icon: CaseSensitive },
  { kind: 'unreadable', icon: Lock },
  { kind: 'link', icon: Link },
  { kind: 'special', icon: FileQuestionMark },
  { kind: 'invalidIgnoreRule', icon: EyeOff },
  { kind: 'metadata', icon: FileCog },
  { kind: 'orphanedMetadata', icon: FolderX },
  { kind: 'notRelocated', icon: Tag },
];

/** A problem in words, keyed by its id. */
export interface DescribedProblem extends ProblemRow {
  id: string;
}

export interface ProblemGroup {
  kind: ProblemKind;
  icon: LucideIcon;
  rows: DescribedProblem[];
}

/** A problem item in words. */
export type Describer = (item: ProblemItem) => DescribedProblem;

/**
 * Describes problem items in `language`, each item once: the same item gets the same row back, so
 * a memoised row leaves it alone when a page arrives. Keyed by the item, not its id: the query
 * cache keeps an unchanged problem's item across refetches, and a changed one comes back as a new
 * item with the same id, which is described anew. Rows of items nobody holds any more are freed.
 */
export function describer(t: ProblemsT, language: string): Describer {
  const described = new WeakMap<ProblemItem, DescribedProblem>();
  return (item) => {
    let row = described.get(item);
    if (row === undefined) {
      row = { id: item.id, ...describeProblem(t, item.problem, language) };
      described.set(item, row);
    }
    return row;
  };
}

/**
 * The loaded problems in words, by group, in the §11 order; groups without problems are left out.
 * Rows keep the order they came in.
 */
export function groupProblems(items: readonly ProblemItem[], describe: Describer): ProblemGroup[] {
  const byKind = new Map<ProblemKind, DescribedProblem[]>();
  for (const item of items) {
    const row = describe(item);
    const list = byKind.get(item.problem.kind);
    if (list === undefined) byKind.set(item.problem.kind, [row]);
    else list.push(row);
  }
  return GROUPS.flatMap(({ kind, icon }) => {
    const rows = byKind.get(kind);
    return rows === undefined ? [] : [{ kind, icon, rows }];
  });
}

/** What a row's button does: copy paths, or open the ignore rules in Library settings. */
export type ProblemAction = { kind: 'copy'; paths: string[]; label: string } | { kind: 'editIgnoreRules' };

export interface ProblemRow {
  /** The path, or what it names ("Line 4 of your ignore rules"). */
  title: string;
  explanation: string;
  action: ProblemAction;
}

/** The library path of `name` in `folder`; `null` is the library root. */
export function joinPath(folder: string | null, name: string): string {
  return folder === null || folder === '' ? name : `${folder}/${name}`;
}

/** Characters Windows does not allow in a name (`NameRule` `invalidCharacter`), by their key. */
const NAMED_CHARACTERS = {
  '<': 'lessThan',
  '>': 'greaterThan',
  ':': 'colon',
  '"': 'quote',
  '/': 'slash',
  '\\': 'backslash',
  '|': 'bar',
  '?': 'questionMark',
  '*': 'asterisk',
} as const;

/** Control characters: U+0000 to U+001F. */
function isControl(character: string): boolean {
  return (character.codePointAt(0) ?? 0x20) < 0x20;
}

/**
 * The characters of `name` that Windows does not allow, in the order they first appear; control
 * characters count as one, `control`.
 */
export function invalidCharacters(name: string): string[] {
  const found: string[] = [];
  for (const character of name) {
    const key = isControl(character) ? 'control' : character in NAMED_CHARACTERS ? character : null;
    if (key !== null && !found.includes(key)) found.push(key);
  }
  return found;
}

function characterSentence(t: ProblemsT, name: string, language: string): string {
  const found = invalidCharacters(name);
  const [only] = found;
  if (only === undefined) return t('explanation.invalidName.invalidCharacterUnknown');
  if (found.length === 1) {
    const key = only === 'control' ? 'control' : NAMED_CHARACTERS[only as keyof typeof NAMED_CHARACTERS];
    return t('explanation.invalidName.invalidCharacterOne', { character: t(`characters.${key}`) });
  }
  const listed = found.map((key) => (key === 'control' ? t('characters.control') : key));
  const list = new Intl.ListFormat(language, { type: 'conjunction' }).format(listed);
  return t('explanation.invalidName.invalidCharacterSeveral', { list });
}

function nameRuleSentence(t: ProblemsT, rule: NameRule, name: string, language: string): string {
  switch (rule) {
    case 'notNfc':
      return t('explanation.notNfc');
    case 'invalidCharacter':
      return t('explanation.invalidName.withEnding', { reason: characterSentence(t, name, language) });
    default:
      return t('explanation.invalidName.withEnding', { reason: t(`explanation.invalidName.${rule}`) });
  }
}

function copy(t: ProblemsT, path: string): ProblemAction {
  return { kind: 'copy', paths: [path], label: t('copy.label', { path }) };
}

/** A row's title, explanation and action (§11 table); `language` formats lists of characters. */
export function describeProblem(t: ProblemsT, problem: Problem, language: string): ProblemRow {
  switch (problem.kind) {
    case 'notUnicode':
    case 'link':
    case 'special': {
      const path = joinPath(problem.folder, problem.name);
      return { title: path, explanation: t(`explanation.${problem.kind}`), action: copy(t, path) };
    }
    case 'invalidName': {
      const path = joinPath(problem.folder, problem.name);
      return {
        title: path,
        explanation: nameRuleSentence(t, problem.rule, problem.name, language),
        action: copy(t, path),
      };
    }
    case 'notNfc': {
      const path = joinPath(problem.folder, problem.name);
      return {
        title: path,
        explanation: problem.twin ? t('explanation.notNfcTwin') : t('explanation.notNfc'),
        action: copy(t, path),
      };
    }
    case 'caseTwins': {
      const [first = '', second = ''] = problem.paths;
      const title =
        problem.paths.length > 2
          ? t('rowTitle.caseTwinsMany', { count: problem.paths.length, path: first })
          : t('rowTitle.caseTwinsTwo', { first, second });
      return {
        title,
        explanation: t('explanation.caseTwins'),
        action: { kind: 'copy', paths: [...problem.paths], label: t('copy.labelSeveral', { title }) },
      };
    }
    case 'unreadable':
      return { title: problem.path, explanation: t(`explanation.unreadable.${problem.failure}`), action: copy(t, problem.path) };
    case 'invalidIgnoreRule': {
      // Line 0 is the whole file (ipc-m1 §14). `.folio/ignore` is fixed in Library settings; a
      // .gitignore only in an editor, so its row copies its path.
      const whole = problem.line === 0;
      if (problem.file === null) {
        return {
          title: whole ? t('rowTitle.ignoreRules') : t('rowTitle.ignoreRuleLine', { line: problem.line }),
          explanation: whole ? t('explanation.ignoreRulesFile') : t('explanation.invalidIgnoreRule'),
          action: { kind: 'editIgnoreRules' },
        };
      }
      return {
        title: whole ? problem.file : t('rowTitle.gitignoreLine', { line: problem.line, file: problem.file }),
        explanation: whole ? t('explanation.gitignoreFile') : t('explanation.invalidIgnoreRule'),
        action: copy(t, problem.file),
      };
    }
    case 'metadata': {
      const { failure } = problem;
      const explanation =
        failure.kind === 'unreadable' ? t(`explanation.unreadable.${failure.failure}`) : t(`explanation.metadata.${failure.kind}`);
      return { title: problem.file, explanation, action: copy(t, problem.file) };
    }
    case 'orphanedMetadata':
      return { title: problem.folder, explanation: t('explanation.orphanedMetadata'), action: copy(t, problem.folder) };
    case 'notRelocated':
      // The item is at `to` now; that is the path worth copying.
      return {
        title: t('rowTitle.moved', { from: problem.from, to: problem.to }),
        explanation: t(`explanation.notRelocated.${problem.cause}`),
        action: copy(t, problem.to),
      };
  }
}
