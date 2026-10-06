// What the diff pane says about a row (handoff workspace-history §6.1, §6.2, §6.8): the heading,
// its icon and change status, the summary strip, the event banners, which body shows and whether
// "Changes | This version" is offered (§6.7). Pure: messages are i18n keys of the `diff` namespace
// (sizes are `common`'s) with their values, dates and sizes already in the UI language; the pane
// renders them and words the bodies itself.
//
// The row is known before its diff loads, so the header, the move and bound-part banners and the
// toggle come from it at once; the content decides the rest when the first window answers.
import type { ParseKeys, TFunction } from 'i18next';

import type { ChangeStatus } from '../../components/ChangeStatusIcon/ChangeStatusIcon';
import type {
  AppError,
  ChangeKind,
  Course,
  Diff,
  DiffContent,
  EncodingChange,
  EntryKind,
  FileClass,
  ItemPart,
  LineEndingChange,
  MetadataDetail,
  MetadataSubject,
  SettingChange,
  TagChange,
  TagDefinitionChange,
  TextDiff,
} from '../../ipc';
import { courseLabel } from '../../lib/courses';
import { type FileType, fileTypeOf } from '../../lib/file-types';
import { formatDateTime, sizeParts } from '../../lib/format';
import { isBelow, nameOf, parentOf } from '../../lib/paths';
import { courseIn, placeOf, prefixOf } from '../../lib/places';
import type { DiffTarget } from './target';

/** A key of the `diff` namespace, or of another namespace with its prefix (`common:size.bytes`). */
export type DiffKey = ParseKeys<['diff', 'common']>;

export type MessageValue = string | number | Message;

/** A string to show: its key and values; a value that is a message is rendered first. */
export interface Message {
  key: DiffKey;
  values?: Readonly<Record<string, MessageValue>>;
}

/** A message as text, with `useTranslation(['diff', 'common'])`'s `t`. */
export function renderMessage(t: TFunction<['diff', 'common']>, message: Message): string {
  const values: Record<string, string | number> = {};
  for (const [name, value] of Object.entries(message.values ?? {})) {
    values[name] = typeof value === 'object' ? renderMessage(t, value) : value;
  }
  return t(message.key, values);
}

export interface DescribeContext {
  /** The UI language, for dates and sizes (`i18n.language`). */
  language: string;
  /** Now, in milliseconds: a date of another year shows its year. */
  now: number;
  /** The library's courses, whose labels stand for their folders in paths ("MAT232/"). */
  courses: readonly Course[];
  /**
   * Whether the preview shows a stored version of a file with this name rather than a card
   * (`previewShowsVersion` of `app/previewFile.ts`): "This version" is offered only then (§6.7), so
   * Word files get it once their previews come.
   */
  showsVersion: (name: string) => boolean;
}

/** The heading's 16 px icon: the file's type icon, or a Lucide icon named in camel case. */
export type HeadingIcon =
  | { kind: 'file'; name: string }
  | { kind: 'folder' | 'folderOpen' | 'tag' | 'settings' | 'tags' | 'fileCog' };

/** The heading: a library path (course label, folders, name), or a title such as "Ignore rules". */
export type DiffHeading =
  /** `suffix`: after the name in `color.text.secondary`, " · Tags" for a tag change. */
  | { kind: 'path'; path: string; suffix: Message | null }
  | { kind: 'title'; title: Message };

/**
 * The summary strip (§6.2): a skeleton bar while a diff that will have one loads, or its parts,
 * joined with `strip.separator`. `changes` > 0: "Change 2 of 5" and the two buttons.
 */
export type DiffStrip = { kind: 'loading' } | { kind: 'parts'; parts: readonly Message[]; changes: number };

/** An event banner (§6.8): a sentence with the change status icon of what it says. */
export interface EventBanner {
  status: ChangeStatus;
  message: Message;
}

/** Whose preview shows: the file on the disk (Changes), the stored version, or the file a version belongs to now. */
export type PreviewSource = 'disk' | 'version' | 'located';

/** What fills the body under the banners (§6.3–§6.8); the pane words each block. */
export type DiffBody =
  /** 14 skeleton lines, `aria-busy`. */
  | { kind: 'loading' }
  /** Lines (§6.3–§6.6); paragraphs in the Word font when `word`. */
  | { kind: 'lines'; text: TextDiff; word: boolean }
  /** The text is the same: only formatting (Word), the line endings or the encoding changed. */
  | {
      kind: 'noTextChange';
      reason: 'formatting' | 'lineEndings' | 'encoding';
      lineEndings: LineEndingChange | null;
      encoding: EncodingChange | null;
    }
  /** Over the limits; `lines` changed when known. */
  | { kind: 'tooLarge'; lines: number | null; word: boolean }
  | { kind: 'binary' }
  | { kind: 'notLocal' }
  | { kind: 'unreadable'; error: AppError }
  /** A side was thinned out (M3). */
  | { kind: 'pruned' }
  /** A text file over the size limit: "No preview for files this large". */
  | { kind: 'overLimit' }
  /** The file's preview: event-only files, moves without edits. */
  | { kind: 'preview'; source: PreviewSource }
  /** Changes: a deleted file or folder, in the Recycle Bin. */
  | { kind: 'deleted'; name: string; folder: boolean; files: number }
  /** History: a deleted file whose versions were not kept: nothing to show. */
  | { kind: 'gone' }
  /** A folder item: moved (with `files` in Changes), added empty, or deleted (History). */
  | { kind: 'folder'; change: ChangeKind; files: number | null }
  /** Only the tags of a file or folder changed. */
  | { kind: 'tags'; tags: TagChange; folder: boolean; history: boolean }
  | { kind: 'settings'; changes: readonly SettingChange[] }
  | { kind: 'tagDefinitions'; changes: readonly TagDefinitionChange[] }
  /** A tag or settings change with nothing to list. */
  | { kind: 'nothing' };

export interface DiffDescription {
  icon: HeadingIcon;
  heading: DiffHeading;
  /** The change status icon after the heading (20A). */
  status: ChangeStatus;
  /** `null`: no strip. */
  strip: DiffStrip | null;
  /** In order: the move, each bound part, then what the content says. */
  banners: readonly EventBanner[];
  body: DiffBody;
  /** The entry's tag change, shown under the body ("Content and tags"). */
  tags: TagChange | null;
  /** "Changes | This version" is offered. */
  toggle: boolean;
}

const LOADING_STRIP: DiffStrip = { kind: 'loading' };
const LOADING_BODY: DiffBody = { kind: 'loading' };

/** Content that "This version" cannot show, or whose body already is the preview. */
const NO_TOGGLE = new Set<DiffContent['kind']>(['binary', 'notStored', 'notLocal', 'folder', 'metadata', 'same']);

/** Event-only files the banners name by type ("slides", "spreadsheets"); others are "files like this". */
type EventType = Extract<FileType, 'pdf' | 'powerpoint' | 'excel' | 'image' | 'audio' | 'video' | 'archive'> | 'other';
const EVENT_TYPES = new Set<FileType>(['pdf', 'powerpoint', 'excel', 'image', 'audio', 'video', 'archive']);

function eventTypeOf(name: string): EventType {
  const type = fileTypeOf(name);
  return EVENT_TYPES.has(type) ? (type as EventType) : 'other';
}

/** A change's status icon: a move is "Renamed" (ipc-m2 §5.2). */
export function statusOf(change: ChangeKind): ChangeStatus {
  return change === 'moved' ? 'renamed' : change;
}

function banner(status: ChangeStatus, message: Message): EventBanner {
  return { status, message };
}

function dateTime(ms: string, context: DescribeContext): string {
  return formatDateTime(Number(ms), context.language, context.now);
}

function sizeMessage(bytes: string, context: DescribeContext): Message {
  const { value, unit } = sizeParts(Number(bytes), context.language);
  return { key: `common:size.${unit}`, values: { value } };
}

// ---- files and folders

/** A workspace item or a commit's changed file, as the description needs it. */
interface FileChange {
  history: boolean;
  change: ChangeKind;
  kind: EntryKind;
  path: string;
  fromPath: string | null;
  class: FileClass;
  parts: readonly ItemPart[];
  /** Changes: the files a folder item covers; `null` in History. */
  files: number | null;
  /** The content changed, as far as the row knows: not a move without edits. */
  edited: boolean;
  /** No side of the row is unstored or thinned out. */
  kept: boolean;
  /** The version this row shows is kept: History's stored version, Changes' file a commit would store. */
  stored: boolean;
  /** Changes: the file is on this disk and readable; always in History. */
  readable: boolean;
}

function fileChange(target: Extract<DiffTarget, { kind: 'workspace' | 'version' }>): FileChange {
  if (target.kind === 'workspace') {
    const { item } = target;
    return {
      history: false,
      change: item.change,
      kind: item.kind,
      path: item.path,
      fromPath: item.fromPath,
      class: item.class,
      parts: item.parts,
      files: item.files,
      edited: item.change !== 'moved' || item.contentChanged,
      kept: (item.before?.stored ?? true) && (item.after?.stored ?? true),
      stored: item.after?.stored === true && item.entry !== null,
      readable: item.readiness === 'ready' || item.readiness === 'hashing',
    };
  }
  const { row } = target;
  return {
    history: true,
    change: row.change,
    kind: row.kind,
    path: row.path,
    fromPath: row.fromPath,
    class: row.class,
    parts: [],
    files: null,
    edited: row.change !== 'moved' || row.before?.hash !== row.after?.hash,
    kept: [row.before, row.after].every((side) => side === null || (side.stored && !side.pruned)),
    stored: row.after !== null && row.after.stored && !row.after.pruned,
    readable: true,
  };
}

function isVersioned(change: FileChange): boolean {
  return change.kind === 'file' && (change.class === 'text' || change.class === 'word');
}

/** Whether the row's diff will have a strip, so a skeleton bar shows while it loads. */
function expectsStrip(change: FileChange): boolean {
  if (!change.history && change.change === 'deleted') return false;
  return isVersioned(change) && change.edited && change.kept && change.readable;
}

/**
 * Whether the row offers "This version": a stored text or Word version that is still there, of a
 * type the preview can show ("for every file the preview can show at that version", §6.7).
 */
function offersVersion(change: FileChange, context: DescribeContext): boolean {
  return (
    isVersioned(change) &&
    change.change !== 'deleted' &&
    change.edited &&
    change.stored &&
    change.readable &&
    context.showsVersion(nameOf(change.path))
  );
}

function fileIcon(change: FileChange): HeadingIcon {
  if (change.kind === 'file') return { kind: 'file', name: nameOf(change.path) };
  return { kind: change.change === 'moved' ? 'folderOpen' : 'folder' };
}

/** "Renamed from …", "Moved from …/", or both at once. */
function moveBanner(from: string, to: string, context: DescribeContext): EventBanner {
  const folder = parentOf(from);
  if (folder === parentOf(to)) return banner('renamed', { key: 'banner.renamed', values: { name: nameOf(from) } });
  if (nameOf(from) === nameOf(to)) {
    return banner(
      'renamed',
      folder === ''
        ? { key: 'banner.movedFromTop' }
        : { key: 'banner.moved', values: { folder: prefixOf(folder, context.courses) } },
    );
  }
  return banner('renamed', {
    key: 'banner.movedAndRenamed',
    values: { path: `${prefixOf(folder, context.courses)}${nameOf(from)}` },
  });
}

/** One banner per part of a bound item (versioning §6.3), by how the part touches the item. */
function partBanner(item: FileChange, part: ItemPart, context: DescribeContext): EventBanner {
  if (part.kind === 'versioningRules') return banner('modified', { key: 'banner.part.versioningRules' });
  const status = statusOf(part.change);
  const folderPart = part.entryKind === 'folder';
  const at = (key: DiffKey, name?: string) => banner(status, name === undefined ? { key } : { key, values: { name } });
  // A file replaced by another, or by a folder that now holds the item.
  if (part.change === 'deleted' && (part.path === item.path || isBelow(item.path, part.path))) {
    return at(folderPart ? 'banner.part.replacesFolder' : 'banner.part.replacesFile');
  }
  if (part.change === 'moved' && part.fromPath !== null) {
    const from = nameOf(part.fromPath);
    if (part.fromPath === item.path && part.path === item.fromPath) return at('banner.part.swapped', nameOf(part.path));
    if (item.kind === 'folder' && isBelow(part.fromPath, item.path)) return at('banner.part.movedOut', from);
    if (part.path === item.fromPath) return at('banner.part.movedWhereItWas', from);
    if (part.path === item.path) return at('banner.part.movedInItsPlace', from);
  }
  if (part.change === 'deleted' && item.kind === 'folder' && isBelow(part.path, item.path)) {
    return at('banner.part.deletedFromFolder', nameOf(part.path));
  }
  if (part.change === 'added' && part.path === item.fromPath) {
    return at(folderPart ? 'banner.part.addedFolderWhereItWas' : 'banner.part.addedFileWhereItWas');
  }
  if (part.change === 'added' && part.path === item.path) {
    return at(folderPart ? 'banner.part.addedFolderInItsPlace' : 'banner.part.addedFileInItsPlace');
  }
  const path = placeOf(part.path, context.courses);
  if (part.change === 'moved') {
    const from = placeOf(part.fromPath ?? part.path, context.courses);
    return banner(status, { key: 'banner.part.other.moved', values: { path, from } });
  }
  return banner(status, { key: `banner.part.other.${part.change}`, values: { path } });
}

/** The body for lines of text: the block of an unchanged text, or the lines. */
function textBody(text: TextDiff, word: boolean, diff: Diff): DiffBody {
  // Lines with no change between two versions; an added or deleted empty file still shows lines.
  if (text.changes === 0 && diff.before !== null && diff.after !== null) {
    const reason = text.lineEndings !== null ? 'lineEndings' : text.encoding !== null ? 'encoding' : 'formatting';
    return { kind: 'noTextChange', reason, lineEndings: text.lineEndings, encoding: text.encoding };
  }
  return { kind: 'lines', text, word };
}

function detailBody(detail: MetadataDetail, folder: boolean, history: boolean): DiffBody {
  switch (detail.kind) {
    case 'tags':
      return { kind: 'tags', tags: { added: detail.added, removed: detail.removed, now: detail.now }, folder, history };
    case 'settings':
      return { kind: 'settings', changes: detail.changes };
    case 'tagDefinitions':
      return { kind: 'tagDefinitions', changes: detail.changes };
  }
}

interface Content {
  body: DiffBody;
  /** What the content says as a banner, after the move and the parts. */
  banner: EventBanner | null;
}

function folderContent(change: FileChange): Content {
  const body: DiffBody = { kind: 'folder', change: change.change, files: change.files };
  switch (change.change) {
    case 'added':
      return {
        body,
        banner: banner('added', {
          key: change.history ? 'banner.history.addedEmptyFolder' : 'banner.addedEmptyFolder',
        }),
      };
    case 'deleted':
      return { body, banner: banner('deleted', { key: 'banner.history.deletedFolder' }) };
    case 'moved':
    case 'modified':
      return { body, banner: null };
  }
}

/** A side that is not kept: an event-only file, or a text file over the size limit. */
function notStoredContent(change: FileChange, diff: Diff, context: DescribeContext): Content {
  const { before, after } = diff;
  if (after === null) {
    return { body: { kind: 'gone' }, banner: banner('deleted', { key: 'banner.history.deleted' }) };
  }
  const overLimit = change.class === 'text';
  const type = eventTypeOf(nameOf(change.path));
  const scope = change.history ? 'banner.history' : 'banner';
  let message: Message;
  if (before === null) {
    message = { key: overLimit ? `${scope}.overLimit.added` : `${scope}.eventOnly.added.${type}` };
  } else {
    message = {
      key: overLimit ? `${scope}.overLimit.modified` : `${scope}.eventOnly.modified.${type}`,
      values: { before: sizeMessage(before.size, context), after: sizeMessage(after.size, context) },
    };
  }
  const own: PreviewSource = change.history ? 'version' : 'disk';
  const body: DiffBody = overLimit
    ? after.stored
      ? { kind: 'preview', source: own }
      : { kind: 'overLimit' }
    : { kind: 'preview', source: change.history ? 'located' : 'disk' };
  return { body, banner: banner(before === null ? 'added' : 'modified', message) };
}

function fileContent(change: FileChange, diff: Diff, context: DescribeContext): Content {
  // Changes shows a deletion as its own block, whatever the content (§6.8 "Deleted (any file)").
  if (!change.history && change.change === 'deleted') {
    const folder = change.kind === 'folder';
    const files = change.files ?? 0;
    let message: Message = { key: 'banner.deleted' };
    if (folder) message = files > 0 ? { key: 'banner.deletedFolder', values: { count: files } } : { key: 'banner.deletedEmptyFolder' };
    return { body: { kind: 'deleted', name: nameOf(change.path), folder, files }, banner: banner('deleted', message) };
  }
  const { content } = diff;
  switch (content.kind) {
    case 'text':
    case 'word':
      return { body: textBody(content.text, content.kind === 'word', diff), banner: null };
    case 'folder':
      return folderContent(change);
    case 'same': {
      const source: PreviewSource = !change.history ? 'disk' : change.stored ? 'version' : 'located';
      return { body: { kind: 'preview', source }, banner: null };
    }
    case 'notStored':
      return notStoredContent(change, diff, context);
    case 'pruned':
      return { body: { kind: 'pruned' }, banner: null };
    case 'notLocal':
      return { body: { kind: 'notLocal' }, banner: null };
    case 'unreadable':
      return { body: { kind: 'unreadable', error: content.error }, banner: null };
    case 'binary':
      return { body: { kind: 'binary' }, banner: null };
    case 'tooLarge':
      return { body: { kind: 'tooLarge', lines: content.lines, word: change.class === 'word' }, banner: null };
    case 'metadata':
      return { body: detailBody(content.detail, change.kind === 'folder', change.history), banner: null };
  }
}

/** How the counts read: compared, new in Changes, a first version, or deleted in History. */
type CountMode = 'compare' | 'new' | 'first' | 'deleted';

function countsMessage(text: TextDiff, word: boolean, mode: CountMode): Message | null {
  const unit = word ? 'paragraphs' : 'lines';
  switch (mode) {
    case 'new':
      return { key: `strip.${unit}.added`, values: { count: text.added } };
    case 'first':
      return { key: `strip.${unit}.total`, values: { count: text.added } };
    case 'deleted':
      return { key: `strip.${unit}.removed`, values: { count: text.removed } };
    case 'compare':
      break;
  }
  if (text.changes === 0) {
    if (text.lineEndings !== null) return { key: 'strip.lineEndingsOnly' };
    return { key: text.encoding !== null ? 'strip.encodingOnly' : 'strip.noTextChange' };
  }
  if (text.added > 0 && text.removed > 0) {
    return { key: `strip.${unit}.both`, values: { count: text.added, removed: text.removed } };
  }
  if (text.added > 0) return { key: `strip.${unit}.added`, values: { count: text.added } };
  if (text.removed > 0) return { key: `strip.${unit}.removed`, values: { count: text.removed } };
  return null;
}

/** What is compared: "Compared with the last commit (…)", "This version: … · compared with …". */
function comparedParts(target: DiffTarget, diff: Diff, context: DescribeContext): { parts: Message[]; mode: CountMode } {
  if (target.kind === 'workspace' || target.kind === 'workspaceMetadata') {
    if (target.kind === 'workspace' && diff.before === null) return { parts: [{ key: 'strip.new' }], mode: 'new' };
    const time = diff.before?.timeMs ?? null;
    return {
      parts: [time === null ? { key: 'strip.comparedNoTime' } : { key: 'strip.compared', values: { when: dateTime(time, context) } }],
      mode: 'compare',
    };
  }
  const when = dateTime(target.commit.timeMs, context);
  if (target.kind === 'version' && diff.before === null) {
    return { parts: [{ key: 'strip.firstVersion', values: { when } }], mode: 'first' };
  }
  if (target.kind === 'version' && diff.after === null) {
    return { parts: [{ key: 'strip.deletedVersion', values: { when } }], mode: 'deleted' };
  }
  const parts: Message[] = [{ key: 'strip.thisVersion', values: { when } }];
  const before = diff.before?.timeMs ?? null;
  if (before !== null) parts.push({ key: 'strip.comparedWith', values: { when: dateTime(before, context) } });
  return { parts, mode: 'compare' };
}

/** The strip of a diff with lines or a too-large change; `null` for every other content. */
function stripOf(target: DiffTarget, diff: Diff, word: boolean, context: DescribeContext): DiffStrip | null {
  const { content } = diff;
  if (content.kind !== 'text' && content.kind !== 'word' && content.kind !== 'tooLarge') return null;
  const { parts, mode } = comparedParts(target, diff, context);
  if (content.kind === 'tooLarge') {
    if (content.lines !== null) {
      parts.push({ key: `strip.${word ? 'paragraphs' : 'lines'}.tooLarge`, values: { count: content.lines } });
    }
    return { kind: 'parts', parts, changes: 0 };
  }
  const counts = countsMessage(content.text, content.kind === 'word', mode);
  return { kind: 'parts', parts: counts === null ? parts : [...parts, counts], changes: content.text.changes };
}

function describeFile(
  target: Extract<DiffTarget, { kind: 'workspace' | 'version' }>,
  diff: Diff | undefined,
  context: DescribeContext,
): DiffDescription {
  const change = fileChange(target);
  const banners: EventBanner[] = [];
  if (change.change === 'moved' && change.fromPath !== null) banners.push(moveBanner(change.fromPath, change.path, context));
  for (const part of change.parts) banners.push(partBanner(change, part, context));
  const common = {
    icon: fileIcon(change),
    heading: { kind: 'path', path: change.path, suffix: null },
    status: statusOf(change.change),
  } as const;
  if (diff === undefined) {
    return {
      ...common,
      strip: expectsStrip(change) ? LOADING_STRIP : null,
      banners,
      body: LOADING_BODY,
      tags: null,
      toggle: offersVersion(change, context),
    };
  }
  const content = fileContent(change, diff, context);
  const deletedHere = !change.history && change.change === 'deleted';
  return {
    ...common,
    strip: deletedHere ? null : stripOf(target, diff, change.class === 'word', context),
    banners: content.banner === null ? banners : [...banners, content.banner],
    body: content.body,
    tags: content.body.kind === 'tags' ? null : diff.tags,
    toggle: offersVersion(change, context) && !NO_TOGGLE.has(diff.content.kind),
  };
}

// ---- tag and settings changes

function metadataHeading(subject: MetadataSubject, courses: readonly Course[]): { icon: HeadingIcon; heading: DiffHeading } {
  switch (subject.kind) {
    case 'tags':
      return {
        icon: { kind: 'tag' },
        heading: { kind: 'path', path: subject.path, suffix: { key: 'heading.tags' } },
      };
    case 'semester':
      return {
        icon: { kind: 'settings' },
        heading: { kind: 'title', title: { key: 'heading.semesterSettings', values: { name: nameOf(subject.path) } } },
      };
    case 'course': {
      const course = courseIn(subject.path, courses);
      const name = course?.folder.path === subject.path ? courseLabel(course) : nameOf(subject.path);
      return {
        icon: { kind: 'settings' },
        heading: { kind: 'title', title: { key: 'heading.courseSettings', values: { name } } },
      };
    }
    case 'tagDefinitions':
      return { icon: { kind: 'tags' }, heading: { kind: 'title', title: { key: 'heading.tagDefinitions' } } };
    case 'library':
      return { icon: { kind: 'settings' }, heading: { kind: 'title', title: { key: 'heading.librarySettings' } } };
    case 'ignoreRules':
      return { icon: { kind: 'fileCog' }, heading: { kind: 'title', title: { key: 'heading.ignoreRules' } } };
  }
}

function metadataBody(diff: Diff, subject: MetadataSubject, history: boolean): DiffBody {
  const { content } = diff;
  switch (content.kind) {
    case 'metadata':
      return detailBody(content.detail, subject.kind === 'tags' && subject.entryKind === 'folder', history);
    case 'text':
    case 'word':
      return textBody(content.text, content.kind === 'word', diff);
    case 'unreadable':
      return { kind: 'unreadable', error: content.error };
    case 'tooLarge':
      return { kind: 'tooLarge', lines: content.lines, word: false };
    case 'binary':
      return { kind: 'binary' };
    case 'pruned':
    case 'notLocal':
    case 'notStored':
    case 'folder':
    case 'same':
      return { kind: 'nothing' };
  }
}

function describeMetadata(
  target: Extract<DiffTarget, { kind: 'workspaceMetadata' | 'versionMetadata' }>,
  diff: Diff | undefined,
  context: DescribeContext,
): DiffDescription {
  const { change, subject } = target.change;
  const common = { ...metadataHeading(subject, context.courses), status: statusOf(change), banners: [], tags: null, toggle: false };
  if (diff === undefined) {
    return { ...common, strip: subject.kind === 'ignoreRules' ? LOADING_STRIP : null, body: LOADING_BODY };
  }
  return {
    ...common,
    strip: stripOf(target, diff, false, context),
    body: metadataBody(diff, subject, target.kind === 'versionMetadata'),
  };
}

/**
 * What the pane shows for `target`: from the row alone while `diff` (its first window's answer) is
 * `undefined`, and from both once it has arrived.
 */
export function describe(target: DiffTarget, diff: Diff | undefined, context: DescribeContext): DiffDescription {
  return target.kind === 'workspace' || target.kind === 'version'
    ? describeFile(target, diff, context)
    : describeMetadata(target, diff, context);
}

