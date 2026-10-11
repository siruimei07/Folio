// The words of a change row (workspace-history handoff §3.2–§3.5, §6.1, §7.2): what the Changes
// list's rows, History's card rows and the diff header all say about a changed file, folder, tag
// or settings change. Pure, and free of `t`: titles are `common` keys with their values, which each
// view renders with its own `t` (the diff stores them as messages and renders them later).
import type { ParseKeys } from 'i18next';

import type { ChangeKind, Course, EntryKind, MetadataSubject } from '../../ipc';
import { courseLabel } from '../../lib/courses';
import { nameOf, parentOf } from '../../lib/paths';
import { courseIn, headingPrefix } from '../../lib/places';
import type { ChangeStatus } from '../ChangeStatusIcon/ChangeStatusIcon';

/**
 * A `common` key (the default namespace, so `ParseKeys` checks it against en) with its namespace
 * prefix, so a view's `t` (and the diff's messages) take it.
 */
function commonKey<K extends ParseKeys>(key: K): `common:${K}` {
  return `common:${key}`;
}

/** The "Tags" tag after a tag change's path, and the diff heading's " · Tags" suffix. */
export const CHANGE_ROW_TAGS = commonKey('changeRow.tags');

const TITLE_KEYS = {
  semester: commonKey('changeRow.semesterSettings'),
  course: commonKey('changeRow.courseSettings'),
  tagDefinitions: commonKey('changeRow.tagDefinitions'),
  library: commonKey('changeRow.librarySettings'),
  ignoreRules: commonKey('changeRow.ignoreRules'),
} as const;

/** A settings change's title key: "CSC236 course settings", "Ignore rules". */
export type MetadataTitleKey = (typeof TITLE_KEYS)[keyof typeof TITLE_KEYS];

/** A settings change's title: its `common` key and, for a semester or course, the place's name. */
export interface MetadataTitle {
  key: MetadataTitleKey;
  values?: { name: string };
}

/** The 16 px icon: the file's type icon, or a Lucide icon named in camel case. */
export type ChangeRowIcon =
  | { kind: 'file'; name: string }
  | { kind: 'folder' | 'folderOpen' | 'tag' | 'settings' | 'tags' | 'fileCog' };

/**
 * `PathText`'s and `PathHeading`'s parts: the course code ("MAT232/", kept whole), the folders,
 * and the name (or a title such as "Ignore rules").
 */
export interface RowPath {
  label: string;
  prefix: string;
  name: string;
}

/** What `ChangeRowParts` draws: the parts the Changes list's rows and History's card rows share. */
export interface ChangeRowFace {
  icon: ChangeRowIcon;
  path: RowPath;
  /** The path's tooltip: the whole path, or what the view says more (History's "Moved from"). */
  tooltip: string;
  /** A tag change of a file or folder: the "Tags" tag after the path. */
  tagsTag: boolean;
  status: ChangeStatus;
  /** Struck through: a deleted file or folder. */
  deleted: boolean;
}

/** A change's status icon: a move is "Renamed" (ipc-m2 §5.2). */
export function changeStatusOf(change: ChangeKind): ChangeStatus {
  return change === 'moved' ? 'renamed' : change;
}

/** A changed file's type icon; a moved folder's open folder, any other folder's folder. */
export function changeRowIcon(entry: { kind: EntryKind; path: string; change: ChangeKind }): ChangeRowIcon {
  if (entry.kind === 'file') return { kind: 'file', name: nameOf(entry.path) };
  return { kind: entry.change === 'moved' ? 'folderOpen' : 'folder' };
}

/** A library path's parts: its course's code apart (`headingPrefix`), the folders below it, the name. */
export function rowPath(path: string, courses: readonly Course[]): RowPath {
  const { label, folders } = headingPrefix(parentOf(path), courses);
  return { label, prefix: folders, name: nameOf(path) };
}

/** The parts as one string, uncut: the tooltip and the start of the accessible name. */
export function wholePath(path: RowPath): string {
  return `${path.label}${path.prefix}${path.name}`;
}

/** An accessible name from its parts, joined as a short unit list in the UI language. */
export function joinRowLabel(language: string, parts: readonly string[]): string {
  return new Intl.ListFormat(language, { type: 'unit', style: 'short' }).format(parts);
}

/**
 * A settings change's icon and title (§3.3): a semester's by its folder's name, a course's by its
 * label when the library lists its folder as a course (else by the folder's name).
 */
export function metadataTitle(
  subject: Exclude<MetadataSubject, { kind: 'tags' }>,
  courses: readonly Course[],
): { icon: ChangeRowIcon; title: MetadataTitle } {
  switch (subject.kind) {
    case 'semester':
      return { icon: { kind: 'settings' }, title: { key: TITLE_KEYS.semester, values: { name: nameOf(subject.path) } } };
    case 'course': {
      const course = courseIn(subject.path, courses);
      const name = course?.folder.path === subject.path ? courseLabel(course) : nameOf(subject.path);
      return { icon: { kind: 'settings' }, title: { key: TITLE_KEYS.course, values: { name } } };
    }
    case 'tagDefinitions':
      return { icon: { kind: 'tags' }, title: { key: TITLE_KEYS.tagDefinitions } };
    case 'library':
      return { icon: { kind: 'settings' }, title: { key: TITLE_KEYS.library } };
    case 'ignoreRules':
      return { icon: { kind: 'fileCog' }, title: { key: TITLE_KEYS.ignoreRules } };
  }
}
