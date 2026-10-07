// What a row of the changes list shows and says (workspace-history handoff §3.2–§3.5): its icon,
// path or title, the "Tags" tag, its count, its marks, its change status, and its accessible name
// and description; and a place's header when grouped by course. Pure: the rows and the list
// render it.
import type { TFunction } from 'i18next';

import type { ChangeStatus } from '../../components/ChangeStatusIcon/ChangeStatusIcon';
import type { ChangeKind, Course, MetadataChange, MetadataSubject, SummaryGroup, WorkspaceItem } from '../../ipc';
import { courseCode, courseLabel, courseNameAfterCode, courseTitle } from '../../lib/courses';
import { formatNumber } from '../../lib/format';
import { nameOf, parentOf } from '../../lib/paths';
import { courseIn, headingPrefix } from '../../lib/places';
import { includabilityOf } from '../inclusion';
import { type PlaceCheck, placeOfItem, type PlaceRef } from './grouped';

/** The 16 px icon: the file's type icon, or a Lucide icon. */
export type RowIcon =
  | { kind: 'file'; name: string }
  | { kind: 'folder' | 'folderOpen' | 'tag' | 'settings' | 'tags' | 'fileCog' };

/** A 14 px mark after the name, with its tooltip (§3.3, §3.4). */
export type RowMark = 'tags' | 'notLocal' | 'unreadable';

export interface RowText {
  icon: RowIcon;
  /**
   * `PathText`'s parts: the course code, the folders, the name (or a title such as "Ignore rules").
   * Grouped by course, only the folders below the row's course, semester or library (§3.5).
   */
  path: { label: string; prefix: string; name: string };
  /** The tooltip: the whole path as the flat list shows it, course code first. */
  title: string;
  /** A tag change of a file or folder: the "Tags" tag after the path. */
  tagsTag: boolean;
  /** "4 files", "Empty folder", "2 changes". */
  count: string | null;
  marks: readonly RowMark[];
  status: ChangeStatus;
  /** Struck through: a deleted file or folder. */
  deleted: boolean;
  /** For type-ahead: the file's or folder's name, or the title. */
  name: string;
  /** The accessible name: the whole path (as shown, uncut), the status, then the rest. */
  label: string;
  /**
   * The accessible description: why its box is disabled, or, for a tag or settings change, the
   * rule its hidden header's tooltip says (in every commit, waiting for a file left out).
   */
  description: string | null;
}

export interface DescribeContext {
  t: TFunction<['changes', 'common']>;
  /** The UI language, for joining the parts of a name. */
  language: string;
  courses: readonly Course[];
  /** Grouped by course: an item's row leaves out what its header says (§3.5). */
  grouped?: boolean;
}

/** A change's status icon: a move is "Renamed" (ipc-m2 §5.2). */
function statusOf(change: ChangeKind): ChangeStatus {
  return change === 'moved' ? 'renamed' : change;
}

function pathParts(path: string, courses: readonly Course[]): RowText['path'] {
  const { label, folders } = headingPrefix(parentOf(path), courses);
  return { label, prefix: folders, name: nameOf(path) };
}

function joined(context: DescribeContext, parts: readonly string[]): string {
  return new Intl.ListFormat(context.language, { type: 'unit', style: 'short' }).format(parts);
}

function whole(path: RowText['path']): string {
  return `${path.label}${path.prefix}${path.name}`;
}

/** An item's path under its group's header: the folders below its course, semester or the library. */
function groupedParts(item: WorkspaceItem): RowText['path'] {
  const { id } = placeOfItem(item);
  const parent = parentOf(item.path);
  const below = item.path === id || parent === id ? '' : id === '' ? parent : parent.slice(id.length + 1);
  return { label: '', prefix: below === '' ? '' : `${below}/`, name: nameOf(item.path) };
}

function itemIcon(item: WorkspaceItem): RowIcon {
  if (item.kind === 'file') return { kind: 'file', name: nameOf(item.path) };
  return { kind: item.change === 'moved' ? 'folderOpen' : 'folder' };
}

function itemCount(item: WorkspaceItem, t: DescribeContext['t']): string | null {
  if (item.parts.length > 0) return t('rows.changes', { count: 1 + item.parts.length });
  if (item.kind !== 'folder') return null;
  return item.files === 0 ? t('rows.emptyFolder') : t('rows.files', { count: item.files });
}

function itemMarks(item: WorkspaceItem): RowMark[] {
  const marks: RowMark[] = [];
  if (item.tagsChanged) marks.push('tags');
  if (item.readiness === 'notLocal' || item.readiness === 'unreadable') marks.push(item.readiness);
  return marks;
}

function itemDescription(item: WorkspaceItem, t: DescribeContext['t']): string | null {
  switch (includabilityOf(item)) {
    case 'required':
      return t('rows.required');
    case 'blocked':
      return item.readiness === 'notLocal' ? t('rows.notLocal') : t('rows.unreadable');
    case 'includable':
      return null;
  }
}

/** A workspace item's row (§3.2, §3.4). */
export function describeItem(item: WorkspaceItem, context: DescribeContext): RowText {
  const { t } = context;
  const path = pathParts(item.path, context.courses);
  const status = statusOf(item.change);
  const count = itemCount(item, t);
  const label = [whole(path), t(`common:changeStatus.${status}`)];
  if (count !== null) label.push(count);
  if (item.tagsChanged) label.push(t('rows.tagsChangedPart'));
  return {
    icon: itemIcon(item),
    path: context.grouped === true ? groupedParts(item) : path,
    title: whole(path),
    tagsTag: false,
    count,
    marks: itemMarks(item),
    status,
    deleted: item.change === 'deleted',
    name: path.name,
    label: joined(context, label),
    description: itemDescription(item, t),
  };
}

function subjectTitle(subject: Exclude<MetadataSubject, { kind: 'tags' }>, context: DescribeContext): { icon: RowIcon; title: string } {
  const { t } = context;
  switch (subject.kind) {
    case 'semester':
      return { icon: { kind: 'settings' }, title: t('rows.semesterSettings', { name: nameOf(subject.path) }) };
    case 'course': {
      const course = courseIn(subject.path, context.courses);
      const name = course?.folder.path === subject.path ? courseLabel(course) : nameOf(subject.path);
      return { icon: { kind: 'settings' }, title: t('rows.courseSettings', { name }) };
    }
    case 'tagDefinitions':
      return { icon: { kind: 'tags' }, title: t('rows.tagDefinitions') };
    case 'library':
      return { icon: { kind: 'settings' }, title: t('rows.librarySettings') };
    case 'ignoreRules':
      return { icon: { kind: 'fileCog' }, title: t('rows.ignoreRules') };
  }
}

/** A tag or settings change's row (§3.3): no check box, in every commit unless its file is left out. */
export function describeMetadata(change: MetadataChange, context: DescribeContext): RowText {
  const { t } = context;
  const { subject } = change;
  const status = statusOf(change.change);
  const common = { count: null, marks: [], status, deleted: false, description: t('rows.metadata') };
  if (subject.kind === 'tags') {
    const path = pathParts(subject.path, context.courses);
    return {
      ...common,
      icon: { kind: 'tag' },
      path,
      title: whole(path),
      tagsTag: true,
      name: path.name,
      label: joined(context, [whole(path), t('rows.tags'), t(`common:changeStatus.${status}`)]),
    };
  }
  const { icon, title } = subjectTitle(subject, context);
  return {
    ...common,
    icon,
    path: { label: '', prefix: '', name: title },
    title,
    tagsTag: false,
    name: title,
    label: joined(context, [title, t(`common:changeStatus.${status}`)]),
  };
}

/** What a place's header shows and says when grouped by course (§3.5). */
export interface PlaceText {
  /** A course's badge; `null` for a semester or the library. */
  badge: Pick<Course, 'abbr' | 'code' | 'name' | 'color' | 'folder'> | null;
  /** In 600: the course code, else the whole name (a semester's, "Library"). */
  code: string;
  /** A course's name after its code, in the secondary colour; `''` for none. */
  name: string;
  /** Its changes, every item in it, as the header shows it ("12"); `null` before a summary names it. */
  count: string | null;
  /** The accessible name: the place in full, then the count. */
  label: string;
  /**
   * How many of its changes can be committed when only some can, then what Space does there; or why
   * it does nothing, with how many are always in when the rest wait.
   */
  description: string;
}

/** The course at `id`, as the library lists it or, for a folder it no longer lists, as the summary names it. */
function courseAt(id: string, group: SummaryGroup | undefined, courses: readonly Course[]): NonNullable<PlaceText['badge']> {
  const listed = courses.find((course) => course.folder.path === id);
  if (listed !== undefined) return listed;
  const place = group?.place.kind === 'course' ? group.place : null;
  return {
    abbr: null,
    code: place?.code ?? null,
    name: place?.name ?? nameOf(id),
    color: null,
    folder: place?.folder ?? { id: '', path: id },
  };
}

/** A place's header: its course badge, code and name, or its semester's name, or "Library". */
export function describePlace(place: PlaceRef, group: SummaryGroup | undefined, check: PlaceCheck, context: DescribeContext): PlaceText {
  const { t } = context;
  let text: Pick<PlaceText, 'badge' | 'code' | 'name'> & { title: string };
  if (place.kind === 'course') {
    const course = courseAt(place.id, group, context.courses);
    const code = courseCode(course);
    text = { badge: course, code: code ?? course.name, name: code === null ? '' : courseNameAfterCode(course), title: courseTitle(course) };
  } else {
    const name = place.kind === 'library' ? t('group.library') : group?.place.kind === 'semester' ? group.place.name : nameOf(place.id);
    text = { badge: null, code: name, name: '', title: name };
  }
  const { count, committable } = check;
  let description = t('group.toggle');
  if (check.disabled) {
    // Nothing to change: its required items are in every commit, its blocked ones in none. On with
    // only some committable, those are the required ones, and the rest wait.
    if (check.state !== true) description = t('group.blocked');
    else description = committable === null ? t('group.always') : t('group.alwaysSome', { count: committable });
  } else if (check.state === 'mixed') description = t('group.mixed');
  if (!check.disabled && committable !== null) description = `${t('group.committable', { count: committable })} ${description}`;
  return {
    badge: text.badge,
    code: text.code,
    name: text.name,
    count: count === null ? null : formatNumber(count, context.language),
    label: count === null ? text.title : t('group.label', { place: text.title, count }),
    description,
  };
}
