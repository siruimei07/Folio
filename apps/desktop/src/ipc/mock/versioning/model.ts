// The fake shell's history and workspace (docs/specs/ipc-m2.md §5–§11; versioning.md §6–§11): a
// chain of commits with their changes and file versions, the operation log, the workspace's items
// and metadata changes. It reproduces the contract's rules (fingerprints, selections, keys, the
// reword and uncommit rules, restore's outcomes), not the store: versions keep their text in
// memory, and hashes are short fingerprints of it. Changes made through M1's commands (rename,
// move, delete, import) do not reach the workspace; the console helpers below stand in for them.
import { hasControl } from '../../../lib/names';
import { isBelow, isInside, movePath, nameOf, parentOf } from '../../../lib/paths';
import { charCount } from '../../../lib/text';
import {
  type ChangeCounts,
  type ChangeKind,
  type ChangeRow,
  type CommitInfo,
  type CommitKind,
  type Device,
  type Diff,
  type DiffContent,
  type DiffSide,
  type DiffWindow,
  type EncodingChange,
  type EntryChange,
  type EntryKind,
  type EntryRow,
  type FileRef,
  type FileVersion,
  type HistoryItem,
  type HistoryState,
  type HistoryType,
  type ItemPart,
  type LineEndingChange,
  LIMITS,
  type MetadataChange,
  type MetadataDetail,
  type MetadataSubject,
  type Page,
  type PageRequest,
  type Place,
  type Readiness,
  type RestoreEntry,
  type RestorePlan,
  type Restored,
  type Selection,
  type SelectionSummary,
  type SummaryGroup,
  type TagChange,
  type VersionRef,
  type VersionSide,
  type WorkspaceItem,
  type WorkspaceSummary,
} from '../../bindings';
import { fingerprint as cyrb } from '../contract';
import { type ErrorCode, fail } from '../failure';
import { checkPage, type FakeLibrary, type FakeNode, freeName, freshFields, joinPath } from '../library';
import { classOf, pathOrder } from '../order';
import { randomHex } from '../random';
import { type FoldedDiff, textDiff } from './text';

// ---- versions and changes

/** One version of a file: its hash, size, whether history keeps it, and its text when it is text. */
export interface Version {
  hash: string;
  size: number;
  stored: boolean;
  pruned: boolean;
  /** Lines of text, paragraphs of a Word document; `null` for other files. */
  lines: string[] | null;
}

/** What a change is, as a commit records it and as the workspace lists it. */
interface ChangeFields {
  change: ChangeKind;
  kind: EntryKind;
  path: string;
  fromPath: string | null;
  before: Version | null;
  after: Version | null;
  /** A content kind a fixture forces, beyond what the versions say (ipc-m2 §9.2). */
  content: 'binary' | 'tooLarge' | 'notLocal' | 'unreadable' | null;
  lineEndings: LineEndingChange | null;
  encoding: EncodingChange | null;
}

export interface FakeChange extends ChangeFields {
  key: string;
}

export interface FakeItem extends ChangeFields {
  key: string;
  readiness: Readiness;
  files: number;
  parts: ItemPart[];
  required: boolean;
  tags: TagChange | null;
}

export interface FakeMeta {
  key: string;
  change: ChangeKind;
  subject: MetadataSubject;
  /** Tags and settings; `null` for the ignore rules, whose diff is text. */
  detail: MetadataDetail | null;
  text: { before: string[]; after: string[] } | null;
}

export interface FakeCommit {
  id: string;
  kind: CommitKind;
  /** Whole seconds, in milliseconds. */
  timeMs: number;
  summary: string | null;
  body: string | null;
  device: Device;
  changes: FakeChange[];
  metadata: FakeMeta[];
  pruned: number;
}

export type FakeOp =
  | { kind: 'reword'; id: string; timeMs: number; commit: FakeCommit; previous: string }
  | { kind: 'uncommit'; id: string; timeMs: number; commit: FakeCommit }
  | { kind: 'restore'; id: string; timeMs: number; commit: FakeCommit; path: string; target: string; recycled: boolean };

/** What a history starts with. Every object belongs to the model from then on. */
export interface VersioningSeed {
  state: HistoryState;
  /** Oldest first. */
  commits: FakeCommit[];
  ops: FakeOp[];
  items: FakeItem[];
  metadata: FakeMeta[];
}

/** A library without history: what libraries opened in the fake start with. */
export function noHistory(): VersioningSeed {
  return { state: 'none', commits: [], ops: [], items: [], metadata: [] };
}

/** What the model tells the shell, which turns it into events and catalog changes. */
export interface VersioningHooks {
  now(): number;
  /** This computer's name, for new commits. */
  deviceName(): string;
  workspaceChanged(): void;
  historyChanged(): void;
  catalogChanged(changes: EntryChange[]): void;
}

/** A commit the job will make: what it resolved when it started (ipc-m2 §7.1). */
export interface CommitPlan {
  first: boolean;
  items: FakeItem[];
  metadata: FakeMeta[];
  summary: string;
  body: string | null;
  /** The paths of the files it reads, and their bytes, for the job's progress. */
  reads: string[];
  bytes: number;
  /** Items the first commit leaves out (not local, unreadable). */
  left: FakeItem[];
  /** A selected item that cannot be read: the job fails on it, naming it. */
  blocked: { code: ErrorCode; file: string } | null;
}

// ---- helpers

/** A fake content hash: equal text gives an equal hash. */
export function hashOf(content: string): string {
  return `b3:${cyrb(content).repeat(5).slice(0, 64)}`;
}

export function commitId(): string {
  return `b3:${randomHex(32)}`;
}

const encoder = new TextEncoder();

/** A version of a text file. */
export function textVersion(text: string, stored = true): Version {
  return { hash: hashOf(text), size: encoder.encode(text).length, stored, pruned: false, lines: text.split('\n') };
}

/** A version of a Word document: its paragraphs. `seed` tells formatting-only versions apart. */
export function wordVersion(paragraphs: string[], size: number, seed = ''): Version {
  return { hash: hashOf(`docx${seed}\n${paragraphs.join('\n')}`), size, stored: true, pruned: false, lines: [...paragraphs] };
}

/** A version of another file: change events only. */
export function blobVersion(size: number, seed: string): Version {
  return { hash: hashOf(`${seed}:${String(size)}`), size, stored: false, pruned: false, lines: null };
}

/** A fixture file's content as a version: text from its body text, Word from its name, else a blob. */
export function nodeVersion(node: FakeNode): Version {
  const cls = classOf(node.name, 'file');
  if (cls === 'text') return textVersion(node.text ?? `${node.name}\n`, Number(node.size) <= 10 * 1024 * 1024);
  if (cls === 'word') return wordVersion([node.name, node.text ?? 'Document text.'], Number(node.size), node.path);
  return blobVersion(Number(node.size), node.path);
}

type ChangeInput = Partial<ChangeFields> & Pick<ChangeFields, 'change' | 'kind' | 'path'>;

/** Exactly the fields of a change, so an item's or a commit's other fields never come along. */
function changeFields(fields: ChangeInput): ChangeFields {
  return {
    change: fields.change,
    kind: fields.kind,
    path: fields.path,
    fromPath: fields.fromPath ?? null,
    before: fields.before ?? null,
    after: fields.after ?? null,
    content: fields.content ?? null,
    lineEndings: fields.lineEndings ?? null,
    encoding: fields.encoding ?? null,
  };
}

export function change(fields: ChangeInput): FakeChange {
  return { key: `change:${fields.path}`, ...changeFields(fields) };
}

type ItemOptions = Partial<Pick<FakeItem, 'readiness' | 'files' | 'parts' | 'required' | 'tags'>>;

export function item(fields: ChangeInput & ItemOptions): FakeItem {
  return {
    key: `item:${fields.change}:${fields.path}`,
    readiness: fields.readiness ?? 'ready',
    files: fields.files ?? 0,
    parts: fields.parts ?? [],
    required: fields.required ?? false,
    tags: fields.tags ?? null,
    ...changeFields(fields),
  };
}

/** The changes of every file and folder a library holds, as its first commit adds them. */
export function firstChanges(library: FakeLibrary, versions: ReadonlyMap<string, Version> = new Map()): {
  added: FakeChange[];
  /** Files another program holds: the first commit leaves them out. */
  left: FakeNode[];
} {
  const added: FakeChange[] = [];
  const left: FakeNode[] = [];
  for (const node of library.walk(library.root)) {
    if (node.blocked === 'InUse') left.push(node);
    else {
      const after = node.kind === 'file' ? (versions.get(node.path) ?? nodeVersion(node)) : null;
      added.push(change({ change: 'added', kind: node.kind, path: node.path, after }));
    }
  }
  return { added, left };
}

function seconds(ms: number): number {
  return Math.floor(ms / 1000) * 1000;
}

/** A page of `list`, mapping only the rows it holds. */
function pageOf<T, R>(list: readonly T[], page: PageRequest, revision: number, row: (entry: T) => R): Page<R> {
  checkPage(page);
  return { items: list.slice(page.offset, page.offset + page.limit).map(row), offset: page.offset, total: list.length, revision };
}

function byPath<T extends { path: string }>(list: T[]): T[] {
  const compare = pathOrder();
  return list.sort((a, b) => compare(a.path, b.path));
}

/** Running maxima of the times: effective times (versioning §5.4, ipc-m2 §4). */
function effectiveTimes(list: readonly { timeMs: number }[]): number[] {
  let previous = 0;
  return list.map((entry) => (previous = Math.max(previous, entry.timeMs)));
}

/** One timeline entry before it becomes a row: when, whether an operation, its place in its list. */
interface Timed<T> {
  at: number;
  op: boolean;
  order: number;
  row: () => T;
}

/** Newest first; at equal times an operation, which names an earlier commit, comes first. */
function newestFirst<T>(a: Timed<T>, b: Timed<T>): number {
  return b.at - a.at || Number(b.op) - Number(a.op) || b.order - a.order;
}

function allows(types: HistoryType[] | null, type: HistoryType): boolean {
  return types === null || types.includes(type);
}

function opFields(op: FakeOp, effective: number) {
  return { id: op.id, timeMs: String(op.timeMs), effectiveMs: String(effective) };
}

function restoreEntry(op: Extract<FakeOp, { kind: 'restore' }>, effective: number): RestoreEntry {
  return {
    ...opFields(op, effective),
    commit: op.commit.id,
    path: op.path,
    versionMs: String(op.commit.timeMs),
    target: op.target,
    recycled: op.recycled,
  };
}

const isIncludable = (entry: FakeItem) => entry.readiness === 'ready' || entry.readiness === 'hashing';

/** A disk side's size: `"0"` while its content is not on this disk (ipc-m2 §6.2). */
function diskSize(entry: FakeItem, version: Version): string {
  return entry.readiness === 'notLocal' ? '0' : String(version.size);
}

const EMPTY_FINGERPRINT = '0'.repeat(32);

/** Message rules (ipc-m2 §7.2): normalized, then checked in the spec's order. */
function normalizeMessage(summary: string, body: string | null): { summary: string; body: string | null } {
  const cleanSummary = summary.trim();
  let cleanBody: string | null = (body ?? '').replace(/\r\n?/g, '\n').replace(/\s+$/u, '').replace(/^\n+/, '');
  if (cleanBody === '') cleanBody = null;
  if (cleanSummary === '') fail('SummaryEmpty', 'the summary is empty');
  if (charCount(cleanSummary) > LIMITS.summaryChars) fail('SummaryTooLong', 'over LIMITS.summaryChars');
  if (hasControl(cleanSummary)) fail('SummaryInvalid', 'a control character');
  if (cleanBody !== null) {
    if (charCount(cleanBody) > LIMITS.bodyChars) fail('BodyTooLong', 'over LIMITS.bodyChars');
    // Control characters but tab and line feed.
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/u.test(cleanBody)) fail('BodyInvalid', 'a control character');
  }
  return { summary: cleanSummary, body: cleanBody };
}

const COMMIT_ID = /^b3:[0-9a-f]{64}$/;

function checkKeys(keys: readonly string[]): void {
  if (keys.length > LIMITS.batch) fail('InvalidArgument', 'over LIMITS.batch keys');
  if (keys.some((key) => charCount(key) > LIMITS.keyChars)) fail('InvalidArgument', 'a key over LIMITS.keyChars');
}

/**
 * Where a change takes a file's path, from the old side to the new: its new path, `null` when it
 * deletes the file or a folder above it, `undefined` when it does not concern it.
 */
function forward(path: string, entry: ChangeFields): string | null | undefined {
  if (entry.change === 'deleted' && isInside(path, entry.path)) return null;
  if (entry.change !== 'moved' || entry.fromPath === null) return undefined;
  if (entry.kind === 'file') return entry.fromPath === path ? entry.path : undefined;
  return isBelow(path, entry.fromPath) ? movePath(path, entry.fromPath, entry.path) : undefined;
}

/** Where a folder move among `changes` had a path below it before; the path when none did. */
function backThroughFolderMove(path: string, changes: readonly ChangeFields[]): string {
  const folder = changes.find((entry) => entry.kind === 'folder' && entry.change === 'moved' && isBelow(path, entry.path));
  return folder?.fromPath == null ? path : movePath(path, folder.path, folder.fromPath);
}

/** A diff's side of a version in history, or of the disk (`at` null). */
function diffSide(version: Version | null, at: FakeCommit | null, path: string): DiffSide | null {
  return (
    version && {
      commit: at?.id ?? null,
      timeMs: at === null ? null : String(at.timeMs),
      path,
      size: String(version.size),
      hash: version.hash,
      stored: version.stored,
      pruned: version.pruned,
    }
  );
}

// ---- the model

/** Diffs kept per model: paging and unfolding ask for one diff many times. */
const DIFFS_KEPT = 8;

export class FakeVersioning {
  state: HistoryState;
  readonly commits: FakeCommit[];
  readonly ops: FakeOp[];
  items: FakeItem[];
  metadata: FakeMeta[];
  /** A commit, reword, uncommit or restore runs (`HistoryBusy`). */
  busy = false;
  readonly deviceId = randomHex(16);
  private readonly library: FakeLibrary;
  private readonly hooks: VersioningHooks;
  /** Each commit's changes by path, sorted once: a commit never changes its changes. */
  private readonly sorted = new WeakMap<FakeCommit, ChangeRow[]>();
  private readonly diffs = new Map<string, FoldedDiff>();

  constructor(seed: VersioningSeed, library: FakeLibrary, hooks: VersioningHooks) {
    this.state = seed.state;
    this.commits = seed.commits;
    this.ops = seed.ops;
    this.items = byPath(seed.items);
    this.metadata = seed.metadata;
    this.library = library;
    this.hooks = hooks;
  }

  /** The history as it is, to open the library again with it (after "Try again"). */
  snapshot(): VersioningSeed {
    return { state: this.state === 'starting' ? 'none' : this.state, commits: this.commits, ops: this.ops, items: this.items, metadata: this.metadata };
  }

  get head(): FakeCommit | null {
    return this.commits.at(-1) ?? null;
  }

  /** Items while the history is ready; nothing before the first commit (ipc-m2 §6.1). */
  private listed(): { items: FakeItem[]; metadata: FakeMeta[] } {
    return this.state === 'none' || this.state === 'starting'
      ? { items: [], metadata: [] }
      : { items: this.items, metadata: this.metadata };
  }

  private changed(history: boolean): void {
    this.library.commit();
    if (history) this.hooks.historyChanged();
    this.hooks.workspaceChanged();
  }

  // ---- workspace (ipc-m2 §6)

  fingerprint(): string {
    const { items, metadata } = this.listed();
    if (items.length === 0 && metadata.length === 0) return EMPTY_FINGERPRINT;
    const text = [
      ...items.map((entry) => `${entry.key}|${isIncludable(entry) ? '1' : '0'}`),
      ...metadata.map((entry) => entry.key),
    ]
      .sort()
      .join('\n');
    return `${cyrb(text)}${cyrb(`#${text}`)}`.padEnd(32, '0').slice(0, 32);
  }

  summary(): WorkspaceSummary {
    const { items, metadata } = this.listed();
    const count = (readiness: Readiness) => items.filter((entry) => entry.readiness === readiness).length;
    return {
      revision: this.library.revision,
      historyState: this.state,
      head: this.head?.id ?? null,
      fingerprint: this.fingerprint(),
      items: items.length,
      metadata: metadata.length,
      includable: items.filter(isIncludable).length,
      hashing: count('hashing'),
      notLocal: count('notLocal'),
      unreadable: count('unreadable'),
    };
  }

  /** The badge's count: items plus metadata changes. */
  total(): number {
    const { items, metadata } = this.listed();
    return items.length + metadata.length;
  }

  itemPage(page: PageRequest): Page<WorkspaceItem> {
    return pageOf(this.listed().items, page, this.library.revision, (entry) => this.itemRow(entry));
  }

  metadataPage(page: PageRequest): Page<MetadataChange> {
    return pageOf(this.listed().metadata, page, this.library.revision, (entry) => metaRow(entry, true));
  }

  private itemRow(entry: FakeItem): WorkspaceItem {
    const files = entry.kind === 'file';
    return {
      key: entry.key,
      change: entry.change,
      kind: entry.kind,
      path: entry.path,
      fromPath: entry.fromPath,
      entry: entry.change === 'deleted' ? null : this.library.refAt(entry.path),
      class: classOf(nameOf(entry.path), entry.kind),
      contentChanged:
        entry.change === 'modified' || (entry.change === 'moved' && entry.before?.hash !== entry.after?.hash),
      before: files && entry.before ? { size: String(entry.before.size), stored: entry.before.stored } : null,
      after: files && entry.after ? { size: diskSize(entry, entry.after), stored: entry.after.stored } : null,
      readiness: entry.readiness,
      files: entry.files,
      parts: entry.parts,
      required: entry.required,
      tagsChanged: entry.tags !== null,
    };
  }

  /** The items a selection names (ipc-m2 §5.1): limits, then the fingerprint, then the keys. */
  resolve(selection: Selection, fingerprint: string): FakeItem[] {
    checkKeys(selection.keys);
    if (fingerprint !== this.fingerprint()) fail('WorkspaceChanged', 'the fingerprint changed');
    const { items } = this.listed();
    const keys = new Set(selection.keys);
    const known = new Set(items.map((entry) => entry.key));
    for (const key of keys) if (!known.has(key)) fail('InvalidArgument', `no item ${key}`);
    return items.filter((entry) =>
      entry.required || (selection.kind === 'allExcept' ? isIncludable(entry) && !keys.has(entry.key) : keys.has(entry.key)),
    );
  }

  summarize(selection: Selection, fingerprint: string): SelectionSummary {
    const selected = new Set(this.resolve(selection, fingerprint));
    const { items, metadata } = this.listed();
    const groups = new Map<string, SummaryGroup>();
    const group = (path: string, kind: EntryKind): SummaryGroup => {
      const place = this.placeOf(path, kind);
      const id = place.kind === 'library' ? '' : place.path;
      let found = groups.get(id);
      if (found === undefined) {
        const counts = (): ChangeCounts => ({ added: 0, modified: 0, deleted: 0, moved: 0 });
        found = { place, files: counts(), folders: counts(), tags: 0, settings: false, items: 0, available: 0, selected: 0, required: 0 };
        groups.set(id, found);
      }
      return found;
    };
    for (const entry of items) {
      const target = group(entry.path, entry.kind);
      target.items += 1;
      if (entry.required) target.required += 1;
      // A required item counts whatever its readiness: every selection includes it (ipc-m2 §6.4).
      if (entry.required || isIncludable(entry)) target.available += 1;
      const included = selected.has(entry);
      // Left out, a modified or moved entry keeps its new tags; an added one's wait (ipc-m2 §6.4).
      const keepsEntry = entry.change === 'modified' || entry.change === 'moved';
      if (entry.tags !== null && (included || keepsEntry)) target.tags += 1;
      if (!included) continue;
      target.selected += 1;
      (entry.kind === 'file' ? target.files : target.folders)[entry.change] += 1;
    }
    for (const { subject } of metadata) {
      if (subject.kind === 'tags') group(subject.path, subject.entryKind).tags += 1;
      if (subject.kind === 'semester' || subject.kind === 'course') group(subject.path, 'folder').settings = true;
    }
    const compare = pathOrder();
    const ordered = [...groups.entries()].sort(([a], [b]) => (a === '' ? -1 : b === '' ? 1 : compare(a, b)));
    return {
      items: selected.size,
      metadata: metadata.length,
      groups: ordered.map(([, value]) => value),
      tagDefinitions: metadata.some((entry) => entry.subject.kind === 'tagDefinitions'),
      library: metadata.some((entry) => entry.subject.kind === 'library'),
      ignoreRules: metadata.some((entry) => entry.subject.kind === 'ignoreRules'),
    };
  }

  /**
   * Where a change belongs: its course, else its semester, else the library root. A semester or
   * course folder belongs to itself.
   */
  private placeOf(path: string, kind: EntryKind): Place {
    const names = path.split('/');
    const isFolderAt = (depth: number) => names.length > depth || (names.length === depth && kind === 'folder');
    if (isFolderAt(2)) {
      const coursePath = names.slice(0, 2).join('/');
      return {
        kind: 'course',
        path: coursePath,
        folder: this.library.refAt(coursePath),
        name: nameOf(coursePath),
        code: this.library.at(coursePath)?.group?.code ?? null,
      };
    }
    if (isFolderAt(1)) {
      const semesterPath = names[0] ?? '';
      return { kind: 'semester', path: semesterPath, folder: this.library.refAt(semesterPath), name: semesterPath };
    }
    return { kind: 'library' };
  }

  // ---- commits (ipc-m2 §7)

  private checkWritable(): void {
    if (this.state === 'readOnly') fail('HistoryReadOnly', 'a newer Folio wrote the history');
    if (this.state === 'damaged') fail('HistoryDamaged', 'HEAD cannot be read');
    if (this.busy) fail('HistoryBusy', 'another history operation runs');
  }

  /** The plan of a commit; from here the history is held until the job ends (`HistoryBusy`). */
  private begin(first: boolean, items: FakeItem[], metadata: FakeMeta[], message: { summary: string; body: string | null }, left: FakeItem[]): CommitPlan {
    const read = items.filter((entry) => entry.after?.stored === true);
    const blocked = items.find((entry) => !isIncludable(entry));
    this.busy = true;
    if (first) {
      this.state = 'starting';
      this.changed(false);
    }
    return {
      first,
      items,
      metadata,
      ...message,
      reads: read.map((entry) => entry.path),
      bytes: read.reduce((sum, entry) => sum + (entry.after?.size ?? 0), 0),
      left,
      blocked:
        blocked === undefined
          ? null
          : { code: blocked.readiness === 'notLocal' ? 'NotLocal' : 'AccessDenied', file: blocked.path },
    };
  }

  /** Checks a commit and resolves what it commits (ipc-m2 §7.1); the job then records it. */
  beginCommit(request: { selection: Selection; fingerprint: string; base: string | null; summary: string; body: string | null }): CommitPlan {
    const message = normalizeMessage(request.summary, request.body);
    this.checkWritable();
    if (this.state === 'none' || this.state === 'starting') fail('NothingToCommit', 'the history has not started');
    const items = this.resolve(request.selection, request.fingerprint);
    if (request.base !== (this.head?.id ?? null)) fail('WorkspaceChanged', 'HEAD changed');
    if (items.length === 0 && this.metadata.length === 0) fail('NothingToCommit', 'nothing selected');
    return this.begin(false, items, [...this.metadata], message, []);
  }

  /** The first commit: every ready file of the library (versioning §7.7). */
  beginFirstCommit(summary: string): CommitPlan {
    const message = normalizeMessage(summary, null);
    if (this.head !== null || this.state === 'starting') fail('HistoryExists', 'the history has started');
    this.checkWritable();
    const { added, left } = firstChanges(this.library);
    const items = added.map((entry) => item(entry));
    const leftItems = left.map((node) => item({ change: 'added', kind: 'file', path: node.path, after: nodeVersion(node), readiness: 'unreadable' }));
    return this.begin(true, items, [], message, leftItems);
  }

  /** Records the commit a job made, and lets go of the history. */
  recordCommit(plan: CommitPlan): FakeCommit {
    const commit: FakeCommit = {
      id: commitId(),
      kind: 'commit',
      timeMs: seconds(this.hooks.now()),
      summary: plan.summary,
      body: plan.body,
      device: { id: this.deviceId, name: this.hooks.deviceName() },
      changes: plan.items.map((entry) => change(entry)),
      metadata: plan.metadata.map((entry) => ({ ...entry, subject: historySubject(entry.subject) })),
      pruned: 0,
    };
    this.commits.push(commit);
    const committed = new Set<unknown>([...plan.items, ...plan.metadata]);
    this.items = byPath([...this.items.filter((entry) => !committed.has(entry)), ...plan.left]);
    this.metadata = this.metadata.filter((entry) => !committed.has(entry));
    if (this.state === 'starting') this.state = 'ready';
    this.busy = false;
    this.changed(true);
    return commit;
  }

  /** A commit job that failed or was cancelled: nothing changed, the history is free again. */
  abortCommit(plan: CommitPlan): void {
    this.busy = false;
    if (plan.first) {
      this.state = 'none';
      this.changed(false);
    }
  }

  // ---- history (ipc-m2 §8)

  /** A commit of HEAD's chain by its id; any other id is `NotFound`. */
  private commitAt(id: string): { index: number; commit: FakeCommit } {
    if (!COMMIT_ID.test(id)) fail('InvalidArgument', `"${id}" is not a commit id`);
    const index = this.commits.findIndex((commit) => commit.id === id);
    const commit = this.commits[index];
    if (commit === undefined) fail('NotFound', `no commit ${id} in HEAD's chain`);
    return { index, commit };
  }

  private readable(): void {
    if (this.state === 'damaged') fail('HistoryDamaged', 'HEAD cannot be read');
  }

  private commitInfo(index: number, effective: readonly number[]): CommitInfo {
    const commit = this.commits[index];
    if (commit === undefined) fail('NotFound', 'no such commit');
    let files = 0;
    for (const entry of commit.changes) if (entry.kind === 'file') files++;
    return {
      id: commit.id,
      parent: this.commits[index - 1]?.id ?? null,
      kind: commit.kind,
      first: index === 0,
      head: index === this.commits.length - 1,
      synced: false,
      timeMs: String(commit.timeMs),
      effectiveMs: String(effective[index] ?? commit.timeMs),
      summary: commit.summary,
      body: commit.body,
      device: commit.device,
      files,
      folders: commit.changes.length - files,
      metadata: commit.metadata.length,
      pruned: commit.pruned,
    };
  }

  getCommit(id: string): CommitInfo {
    this.readable();
    return this.commitInfo(this.commitAt(id).index, effectiveTimes(this.commits));
  }

  private changeRows(commit: FakeCommit): ChangeRow[] {
    let rows = this.sorted.get(commit);
    if (rows === undefined) {
      rows = byPath([...commit.changes]).map(changeRow);
      this.sorted.set(commit, rows);
    }
    return rows;
  }

  historyPage(page: PageRequest, types: HistoryType[] | null): Page<HistoryItem> {
    this.readable();
    const effective = effectiveTimes(this.commits);
    const commits: Timed<HistoryItem>[] = allows(types, 'commit')
      ? this.commits.map((commit, index) => ({
          at: effective[index] ?? 0,
          op: false,
          order: index,
          row: () => ({ kind: 'commit', commit: this.commitInfo(index, effective), files: this.changeRows(commit).slice(0, 4) }),
        }))
      : [];
    const opEffective = effectiveTimes(this.ops);
    const ops = this.ops.flatMap((op, index): Timed<HistoryItem>[] => {
      const at = opEffective[index] ?? 0;
      return allows(types, op.kind) ? [{ at, op: true, order: index, row: () => opItem(op, at) }] : [];
    });
    const entries = [...commits, ...ops].sort(newestFirst);
    return pageOf(entries, page, this.library.revision, (entry) => entry.row());
  }

  changesPage(id: string, page: PageRequest): Page<ChangeRow> {
    this.readable();
    return pageOf(this.changeRows(this.commitAt(id).commit), page, this.library.revision, (row) => row);
  }

  commitMetadataPage(id: string, page: PageRequest): Page<MetadataChange> {
    this.readable();
    return pageOf(this.commitAt(id).commit.metadata, page, this.library.revision, (entry) => metaRow(entry, false));
  }

  /**
   * The file a version of commit `index` at `path` belongs to: the last commit that has it and its
   * path there, and its path on the disk (`null` when it was deleted since).
   */
  private lineForward(index: number, path: string): { index: number; path: string; disk: string | null } {
    let current = path;
    let last = index;
    for (let next = index + 1; next < this.commits.length; next++) {
      for (const entry of this.commits[next]?.changes ?? []) {
        const moved = forward(current, entry);
        if (moved === null) return { index: next - 1, path: current, disk: null };
        if (moved !== undefined) {
          current = moved;
          break;
        }
      }
      last = next;
    }
    let disk: string | null = current;
    for (const entry of this.items) {
      if (disk === null) break;
      const moved = forward(disk, entry);
      if (moved !== undefined) disk = moved;
    }
    return { index: last, path: current, disk };
  }

  /** A file's versions from commit `index` back to where it was added (versioning §9.3). */
  private lineBack(index: number, path: string): { index: number; change: FakeChange }[] {
    const found: { index: number; change: FakeChange }[] = [];
    let current = path;
    for (let at = index; at >= 0; at--) {
      const changes = this.commits[at]?.changes ?? [];
      const own = changes.find((entry) => entry.kind === 'file' && entry.change !== 'deleted' && entry.path === current);
      if (own === undefined) {
        current = backThroughFolderMove(current, changes);
        continue;
      }
      found.push({ index: at, change: own });
      if (own.change === 'added') break;
      if (own.change === 'moved' && own.fromPath !== null) current = own.fromPath;
    }
    return found;
  }

  private findVersion(ref: VersionRef): { index: number; commit: FakeCommit; change: FakeChange } {
    const { index, commit } = this.commitAt(ref.commit);
    const found = commit.changes.find((entry) => entry.path === ref.path && entry.change !== 'deleted');
    if (found === undefined) fail('NotFound', `no version of "${ref.path}" in ${ref.commit}`);
    return { index, commit, change: found };
  }

  /** The content hash of the file on the disk now; `null` when it is gone or not hashed. */
  private diskHash(disk: string | null, headVersion: Version | null): string | null {
    if (disk === null) return null;
    const changed = this.items.find((entry) => entry.path === disk && entry.change !== 'deleted');
    if (changed === undefined) return headVersion?.hash ?? null;
    return changed.readiness === 'ready' ? (changed.after?.hash ?? null) : null;
  }

  fileHistory(file: FileRef, page: PageRequest, types: HistoryType[] | null): Page<FileVersion> {
    this.readable();
    let start: { index: number; path: string; disk: string | null } | null;
    if (file.kind === 'entry') {
      const node = this.library.resolve(file.entry);
      const changed = this.items.find((entry) => entry.path === node.path && entry.change !== 'deleted');
      start =
        changed?.change === 'added'
          ? null
          : {
              index: this.commits.length - 1,
              path: changed?.fromPath ?? backThroughFolderMove(node.path, this.items),
              disk: node.path,
            };
    } else {
      const version = this.findVersion(file);
      start = this.lineForward(version.index, version.change.path);
    }
    const line = start === null ? [] : this.lineBack(start.index, start.path);
    const disk = this.diskHash(start?.disk ?? null, line[0]?.change.after ?? null);
    const currentIndex = line.findIndex(({ change: own }) => disk !== null && own.after?.hash === disk);
    const effective = effectiveTimes(this.commits);
    const commits: Timed<FileVersion>[] = allows(types, 'commit')
      ? line.map(({ index, change: own }, position) => ({
          at: effective[index] ?? 0,
          op: false,
          order: index,
          row: () => ({
            kind: 'commit',
            commit: this.commitInfo(index, effective),
            change: changeRow(own),
            others: (this.commits[index]?.changes.filter((entry) => entry.kind === 'file').length ?? 1) - 1,
            current: position === currentIndex,
          }),
        }))
      : [];
    const versions = new Set(line.map(({ index, change: own }) => `${this.commits[index]?.id ?? ''}|${own.path}`));
    const opEffective = effectiveTimes(this.ops);
    const restores = this.ops.flatMap((op, index): Timed<FileVersion>[] => {
      const at = opEffective[index] ?? 0;
      return allows(types, 'restore') && op.kind === 'restore' && versions.has(`${op.commit.id}|${op.path}`)
        ? [{ at, op: true, order: index, row: () => ({ kind: 'restore', ...restoreEntry(op, at) }) }]
        : [];
    });
    return pageOf([...commits, ...restores].sort(newestFirst), page, this.library.revision, (entry) => entry.row());
  }

  locate(ref: VersionRef): EntryRow | null {
    this.readable();
    const version = this.findVersion(ref);
    if (version.change.kind !== 'file') fail('InvalidArgument', 'a folder has no file');
    const { disk } = this.lineForward(version.index, version.change.path);
    const node = disk === null ? undefined : this.library.at(disk);
    return node?.kind === 'file' ? this.library.row(node) : null;
  }

  reword(id: string, summary: string, body: string | null): string {
    const message = normalizeMessage(summary, body);
    this.checkWritable();
    const { index, commit } = this.commitAt(id);
    if (commit.kind === 'prune') fail('CannotReword', 'a prune commit has no message');
    if (commit.summary === message.summary && commit.body === message.body) return commit.id;
    const previous = commit.id;
    commit.summary = message.summary;
    commit.body = message.body;
    // The commit and every later one are written again (versioning §8.3).
    for (const later of this.commits.slice(index)) later.id = commitId();
    this.ops.push({ kind: 'reword', id: randomHex(8), timeMs: seconds(this.hooks.now()), commit, previous });
    this.changed(true);
    return commit.id;
  }

  uncommit(id: string): void {
    this.checkWritable();
    const { index, commit } = this.commitAt(id);
    if (index !== this.commits.length - 1) fail('NotHead', `${id} is not HEAD`);
    if (index === 0 || commit.kind === 'prune') fail('CannotUncommit', 'the first commit or a prune commit');
    this.commits.pop();
    for (const own of commit.changes) this.returnChange(own);
    this.items = byPath(this.items);
    this.metadata.push(...commit.metadata);
    this.ops.push({ kind: 'uncommit', id: randomHex(8), timeMs: seconds(this.hooks.now()), commit });
    this.changed(true);
  }

  /** A change an uncommit takes back returns to the workspace, merged with a later edit of its path. */
  private returnChange(own: FakeChange): void {
    const later = this.items.findIndex((entry) => entry.path === own.path && entry.kind === own.kind);
    const returned = item(own);
    if (later < 0) {
      this.items.push(returned);
      return;
    }
    const merged = { ...returned, after: this.items[later]?.after ?? returned.after };
    if (merged.before?.hash !== undefined && merged.before.hash === merged.after?.hash && merged.fromPath === null) {
      this.items.splice(later, 1);
    } else {
      this.items.splice(later, 1, merged);
    }
  }

  // ---- diffs (ipc-m2 §9)

  workspaceDiff(key: string, window: DiffWindow): Diff {
    checkKeys([key]);
    const { items, metadata } = this.listed();
    const found = items.find((entry) => entry.key === key);
    if (found !== undefined) {
      const after = diffSide(found.after, null, found.path);
      return {
        revision: this.library.revision,
        before: this.head && diffSide(found.before, this.head, found.fromPath ?? found.path),
        after: after && found.after && {
          ...after,
          size: diskSize(found, found.after),
          hash: found.readiness === 'ready' ? after.hash : null,
          pruned: false,
        },
        content: this.contentOf(found, window, found.readiness),
        tags: found.tags,
      };
    }
    const meta = metadata.find((entry) => entry.key === key);
    if (meta === undefined) fail('NotFound', `no change ${key} in the workspace`);
    return { revision: this.library.revision, before: null, after: null, content: this.metaContent(meta, window), tags: null };
  }

  versionDiff(id: string, key: string, window: DiffWindow): Diff {
    this.readable();
    checkKeys([key]);
    const { index, commit } = this.commitAt(id);
    const own = commit.changes.find((entry) => entry.key === key);
    if (own !== undefined) {
      return {
        revision: this.library.revision,
        before: diffSide(own.before, this.commits[index - 1] ?? null, own.fromPath ?? own.path),
        after: diffSide(own.after, commit, own.path),
        content: this.contentOf(own, window, 'ready'),
        tags: null,
      };
    }
    const meta = commit.metadata.find((entry) => entry.key === key);
    if (meta === undefined) fail('NotFound', `no change ${key} in ${id}`);
    return { revision: this.library.revision, before: null, after: null, content: this.metaContent(meta, window), tags: null };
  }

  private metaContent(meta: FakeMeta, window: DiffWindow): DiffContent {
    if (meta.text !== null) return { kind: 'text', text: textDiff(meta.text.before, meta.text.after, window) };
    return meta.detail === null ? { kind: 'same' } : { kind: 'metadata', detail: meta.detail };
  }

  /** What a change's diff shows (ipc-m2 §9.2), from its versions and what the fixture forces. */
  private contentOf(own: ChangeFields, window: DiffWindow, readiness: Readiness): DiffContent {
    if (own.kind === 'folder') return { kind: 'folder' };
    const blocked = own.content ?? (readiness === 'notLocal' || readiness === 'unreadable' ? readiness : null);
    switch (blocked) {
      case 'binary':
        return { kind: 'binary' };
      case 'tooLarge':
        return { kind: 'tooLarge', lines: null };
      case 'notLocal':
        return { kind: 'notLocal' };
      case 'unreadable':
        return { kind: 'unreadable', error: { code: 'InUse', detail: `${own.path} is in use (fake shell)` } };
      case null:
        break;
    }
    const { before, after } = own;
    if (before !== null && after !== null && before.hash === after.hash) return { kind: 'same' };
    const cls = classOf(nameOf(own.path), 'file');
    const sides = [before, after].filter((version): version is Version => version !== null);
    if (cls === 'other' || sides.some((version) => !version.stored || version.lines === null)) return { kind: 'notStored' };
    if (sides.some((version) => version.pruned)) return { kind: 'pruned' };
    const text = textDiff(before?.lines ?? [], after?.lines ?? [], window, {
      lineEndings: own.lineEndings,
      encoding: own.encoding,
      cache: { diffs: this.diffs, key: `${before?.hash ?? '-'} ${after?.hash ?? '-'}`, kept: DIFFS_KEPT },
    });
    return cls === 'word' ? { kind: 'word', text } : { kind: 'text', text };
  }

  // ---- restore (ipc-m2 §10)

  /** What `restore_version` would do now, with the versions it needs to do it. */
  planRestore(ref: VersionRef): RestorePlan & { version: Version; headVersion: Version | null; commit: FakeCommit } {
    this.readable();
    if (isInside(ref.path, '.folio')) fail('InvalidArgument', 'paths under .folio/ cannot be restored');
    const { index, commit, change: own } = this.findVersion(ref);
    const version = own.after;
    if (own.kind !== 'file' || version === null) fail('InvalidArgument', 'only a file version can be restored');
    if (!version.stored) fail('NotStored', 'that version was not kept');
    if (version.pruned) fail('Pruned', 'that version was thinned out');
    const line = this.lineForward(index, own.path);
    const headVersion = this.lineBack(line.index, line.path)[0]?.change.after ?? null;
    const node = line.disk === null ? undefined : this.library.at(line.disk);
    const versions = { version, headVersion, commit };
    if (node?.kind === 'file') {
      if (this.items.some((entry) => entry.path === node.path && entry.readiness === 'notLocal')) {
        fail('NotLocal', 'the current file is not on this disk');
      }
      const current = this.library.row(node);
      const disk = this.diskHash(node.path, headVersion);
      if (disk === version.hash) return { outcome: 'unchanged', target: node.path, recycle: false, current, ...versions };
      // The file there goes to the Recycle Bin unless a version of the chain keeps its content.
      const kept =
        disk !== null &&
        this.commits.some((other) => other.changes.some((entry) => entry.after?.hash === disk && entry.after.stored && !entry.after.pruned));
      return { outcome: 'replace', target: node.path, recycle: !kept, current, ...versions };
    }
    const parent = this.library.at(parentOf(line.path));
    if (this.library.at(line.path) === undefined || parent === undefined) {
      return { outcome: 'recreate', target: line.path, recycle: false, current: null, ...versions };
    }
    const target = joinPath(parent.path, freeName(this.library, parent, nameOf(line.path)));
    return { outcome: 'beside', target, recycle: false, current: null, ...versions };
  }

  restore(ref: VersionRef): Restored {
    this.checkWritable();
    const plan = this.planRestore(ref);
    if (plan.outcome === 'unchanged') fail('Unchanged', 'the file already has this content');
    const version = { ...plan.version };
    const catalog: EntryChange[] = [];
    if (plan.outcome === 'replace') {
      const existing = this.items.find((entry) => entry.path === plan.target && entry.change !== 'deleted');
      if (existing === undefined) {
        this.items.push(item({ change: 'modified', kind: 'file', path: plan.target, before: plan.headVersion, after: version }));
      } else if (existing.change === 'modified' && existing.before?.hash === version.hash) {
        this.items = this.items.filter((entry) => entry !== existing);
      } else {
        existing.after = version;
      }
      const node = this.library.at(plan.target);
      if (node !== undefined) {
        node.size = String(version.size);
        catalog.push({ kind: 'modified', entry: this.library.ref(node) });
      }
    } else {
      this.items = this.items.filter((entry) => !(entry.change === 'deleted' && entry.path === plan.target));
      this.items.push(item({ change: 'added', kind: 'file', path: plan.target, after: version }));
      catalog.push({ kind: 'added', entry: this.library.ref(this.addFile(plan.target, version.size)) });
    }
    this.items = byPath(this.items);
    this.ops.push({
      kind: 'restore',
      id: randomHex(8),
      timeMs: seconds(this.hooks.now()),
      commit: plan.commit,
      path: ref.path,
      target: plan.target,
      recycled: plan.recycle,
    });
    this.hooks.catalogChanged(catalog);
    this.changed(true);
    return { target: plan.target, recycled: plan.recycle };
  }

  /** Adds a file to the fake library, with the folders it needs. */
  private addFile(path: string, size: number): FakeNode {
    let parent = this.library.root;
    for (const name of path.split('/').slice(0, -1)) {
      parent = parent.children.get(name) ?? this.library.add(parent, name, freshFields('folder', this.hooks.now()));
    }
    return this.library.add(parent, nameOf(path), freshFields('file', this.hooks.now(), String(size)));
  }

  // ---- changes made in other programs (console helpers, ipc-m2 §17)

  /** The version HEAD has of the file at `path`, if any. */
  private headVersionAt(path: string): Version | null {
    return this.lineBack(this.commits.length - 1, backThroughFolderMove(path, this.items))[0]?.change.after ?? null;
  }

  /** The file at `path` was saved in another program: a modified item, or a later edit of one. */
  editFile(path: string): void {
    const node = this.library.at(path);
    if (node?.kind !== 'file') return;
    const existing = this.items.find((entry) => entry.path === path && entry.change !== 'deleted');
    const base = existing?.after ?? this.headVersionAt(path) ?? nodeVersion(node);
    const text = [...(base.lines ?? []), `Edited at ${new Date(this.hooks.now()).toISOString()}`].join('\n');
    const next = classOf(node.name, 'file') === 'other' ? blobVersion(base.size + 1024, text) : textVersion(text);
    if (existing !== undefined) existing.after = next;
    else this.items = byPath([...this.items, item({ change: 'modified', kind: 'file', path, before: base, after: next })]);
    node.size = String(next.size);
    this.hooks.catalogChanged([{ kind: 'modified', entry: this.library.ref(node) }]);
    this.changed(false);
  }

  /** A new text file appeared at `path`. */
  addNewFile(path: string, text = 'New file\n'): void {
    if (this.library.at(path) !== undefined) return;
    const version = textVersion(text);
    const node = this.addFile(path, version.size);
    this.items = byPath([...this.items, item({ change: 'added', kind: 'file', path, after: version, readiness: 'hashing' })]);
    this.hooks.catalogChanged([{ kind: 'added', entry: this.library.ref(node) }]);
    this.changed(false);
  }

  /** The file at `path` was deleted in another program. */
  deleteFile(path: string): void {
    const node = this.library.at(path);
    if (node?.kind !== 'file') return;
    const ref = this.library.ref(node);
    const headVersion = this.headVersionAt(path);
    this.items = this.items.filter((entry) => entry.path !== path);
    if (headVersion !== null) this.items = byPath([...this.items, item({ change: 'deleted', kind: 'file', path, before: headVersion })]);
    this.library.remove(node);
    this.hooks.catalogChanged([{ kind: 'removed', entry: ref }]);
    this.changed(false);
  }

  /** A cloud placeholder finished downloading: its item becomes includable (and stays left out). */
  downloadFile(path: string): void {
    const found = this.items.find((entry) => entry.path === path && entry.readiness !== 'ready');
    if (found === undefined) return;
    found.readiness = 'ready';
    this.changed(false);
  }
}

// ---- rows

function changeRow(own: FakeChange): ChangeRow {
  const folder = own.kind === 'folder';
  const side = (version: Version | null): VersionSide | null =>
    folder || version === null ? null : { hash: version.hash, size: String(version.size), stored: version.stored, pruned: version.pruned };
  return {
    key: own.key,
    change: own.change,
    kind: own.kind,
    path: own.path,
    fromPath: own.fromPath,
    class: classOf(nameOf(own.path), own.kind),
    before: side(own.before),
    after: side(own.after),
  };
}

function opItem(op: FakeOp, effective: number): HistoryItem {
  switch (op.kind) {
    case 'reword':
      return { kind: 'reword', ...opFields(op, effective), commit: op.commit.id, previous: op.previous };
    case 'uncommit':
      return { kind: 'uncommit', ...opFields(op, effective), commit: op.commit.id, summary: op.commit.summary ?? '' };
    case 'restore':
      return { kind: 'restore', ...restoreEntry(op, effective) };
  }
}

/** History names paths as they were: no references (ipc-m2 §6.3). */
function historySubject(subject: MetadataSubject): MetadataSubject {
  switch (subject.kind) {
    case 'tags':
      return { ...subject, entry: null };
    case 'semester':
    case 'course':
      return { ...subject, folder: null };
    default:
      return subject;
  }
}

function metaRow(meta: FakeMeta, workspace: boolean): MetadataChange {
  return { key: meta.key, change: meta.change, subject: workspace ? meta.subject : historySubject(meta.subject) };
}
