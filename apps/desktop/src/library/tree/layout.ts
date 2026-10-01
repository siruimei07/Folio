// The Library tree as one flat list of visible rows (docs/specs/ui-architecture.md §8.2): quick
// views, then the semester's courses with the children of every expanded course and folder, then
// the semester's loose files after a separator (library-actions §16 item 6). Folder children come
// in pages; rows of pages not loaded are placeholders. Each expanded folder knows the size of its
// subtree, so finding the row at an index costs O(expanded folders), not O(rows).
import { LIST_PAGE } from '../../data/paged';
import type { Course, EntryRef, EntryRow, Page } from '../../ipc';
import { nameOf, parentOf } from '../../lib/paths';
import { type EntryRange, entriesOf, refOf, type RowSource, type SelectableRows } from '../selecting';
import type { QuickView, Selected } from '../state';

/** What the tree reads of a paged list of a folder's children. */
export interface FolderList {
  total: number | undefined;
  rowAt: (index: number) => EntryRow | undefined;
  /** Loads a page as the list caches it (`useFolderChildren`). */
  loadPage: (page: number) => Promise<Page<EntryRow>>;
  status: 'pending' | 'error' | 'success';
  /** Whether the row at `index` is on a page that failed (`useFolderChildren`). */
  failedAt: (index: number) => boolean;
  retry: () => void;
}

interface Placement {
  level: number;
  posinset: number;
  setsize: number;
}

export type TreeItem = Placement &
  (
    | { kind: 'quick'; key: string; view: QuickView }
    | { kind: 'separator'; key: string }
    /** `count`: the files shown, when a filter shows fewer than the course has. */
    | { kind: 'course'; key: string; course: Course; expanded: boolean; count?: number }
    /** A folder or file of a course, or a loose file of the semester. */
    | { kind: 'entry'; key: string; row: EntryRow; expanded: boolean | undefined }
    /** A row whose page is not loaded yet. */
    | { kind: 'placeholder'; key: string }
    /** A folder whose first page has not arrived. */
    | { kind: 'loading'; key: string; folder: EntryRef }
    /** A row whose page failed, or a folder whose first page did: activating it tries again. */
    | { kind: 'failed'; key: string; retry: () => void }
    /** An expanded folder with nothing in it. */
    | { kind: 'empty'; key: string; folder: EntryRef }
    /** The name field of a new folder, first in its parent. */
    | { kind: 'newFolder'; key: string; parent: EntryRef }
    /** A folder of the filtered tree, known by its path only: always expanded, no menu. */
    | { kind: 'pathFolder'; key: string; path: string }
  );

/** What the tree view reads of its rows, browsing or filtered. */
export interface TreeModel {
  readonly count: number;
  /** Courses and folders open and close; the filtered tree shows every one open. */
  readonly collapsible: boolean;
  /** The indexes of the separator rows, which are shorter than the others. */
  readonly separators: ReadonlySet<number>;
  rowAt: (index: number) => TreeItem;
  indexOfKey: (key: string) => number | null;
  folderAt: (index: number) => EntryRef | null;
  childNames: (folderId: string) => Set<string>;
  /** The entries of rows `from` to `to`, at most `limit`, loading the pages they need. */
  entriesBetween: (from: number, to: number, limit: number) => EntryRange | Promise<EntryRange>;
}

export interface TreeInput {
  /** "Recently added" and "Untagged", then a separator. */
  quickViews: boolean;
  /** The semester's courses, in their order. */
  courses: readonly Course[];
  expanded: ReadonlySet<string>;
  /** Children of courses and folders, by folder id. */
  lists: ReadonlyMap<string, FolderList>;
  /** The semester's children: its course folders first, then its loose files. */
  semester: FolderList | undefined;
  /** The parent of a new folder being named. */
  newFolderIn: EntryRef | null;
}

export const QUICK_VIEWS: readonly QuickView[] = ['recent', 'untagged'];

/** The keys of the separator rows: after the quick views, and before a semester's loose files. */
export const SEPARATOR_KEYS = { quick: 'separator:quick', loose: 'separator:loose' } as const;

export const keyOf = {
  quick: (view: QuickView) => `quick:${view}`,
  entry: (id: string) => id,
  placeholder: (folder: string, index: number) => `placeholder:${folder}:${String(index)}`,
  loading: (folder: string) => `loading:${folder}`,
  failed: (folder: string) => `failed:${folder}`,
  empty: (folder: string) => `empty:${folder}`,
  newFolder: (parent: string) => `new:${parent}`,
};

/** An expanded course or folder and the rows below it. */
interface FolderNode {
  ref: EntryRef;
  /** The level of its children. */
  level: number;
  list: FolderList | undefined;
  /** A new folder row first. */
  pending: boolean;
  /** Expanded child folders found in the loaded pages, by their index in `list`, in order. */
  children: { index: number; node: FolderNode }[];
  /** Rows below it. */
  size: number;
  /** The flat index of its first row. */
  start: number;
  /** Its loaded rows' indexes in `list`, by entry id; built when first asked for. */
  ids?: Map<string, number>;
}

type Segment =
  | { kind: 'fixed'; item: TreeItem }
  | { kind: 'course'; item: TreeItem & { kind: 'course' }; node: FolderNode | null }
  | { kind: 'loose'; offset: number; count: number; setOffset: number };

/** Each loaded row's index in the list, by `key` of the row (its path or id). */
export function loadedIndexes(
  list: { total: number | undefined; rowAt: (index: number) => EntryRow | undefined },
  key: (row: EntryRow) => string,
  from = 0,
): Map<string, number> {
  const indexes = new Map<string, number>();
  const total = list.total ?? 0;
  // Pages hold LIST_PAGE rows; a page is loaded when one of its rows is.
  for (let start = from - (from % LIST_PAGE); start < total; start += LIST_PAGE) {
    const end = Math.min(total, start + LIST_PAGE);
    if (list.rowAt(start) === undefined && list.rowAt(end - 1) === undefined) continue;
    for (let index = Math.max(start, from); index < end; index++) {
      const row = list.rowAt(index);
      if (row !== undefined) indexes.set(key(row), index);
    }
  }
  return indexes;
}

/** A folder list's own rows: its children, a new folder row, or one "Empty" row. */
function ownRows(node: FolderNode): number {
  const total = node.list?.total;
  if (total === undefined) return 1;
  const rows = total + (node.pending ? 1 : 0);
  return rows === 0 ? 1 : rows;
}

/** Sets the flat start of `node` and the folders expanded below it. */
function placeNode(node: FolderNode, start: number): void {
  node.start = start;
  for (const child of node.children) placeNode(child.node, rowIndexIn(node, child.index) + 1);
}

/** The flat index of the row at `index` of `node`'s list. */
function rowIndexIn(node: FolderNode, index: number): number {
  let flat = node.start + (node.pending ? 1 : 0) + index;
  for (const child of node.children) {
    if (child.index >= index) break;
    flat += child.node.size;
  }
  return flat;
}

export class TreeLayout implements TreeModel {
  readonly count: number;
  readonly collapsible = true;
  private readonly segments: Segment[] = [];
  private readonly input: TreeInput;
  private readonly topSize: number;
  /** The loaded loose files' indexes in the semester's list, by entry id; built when first asked for. */
  private looseIds: Map<string, number> | undefined;
  /** Rows already built: the same row object for the same layout, so memoised rows do not re-render. */
  private readonly built = new Map<number, TreeItem>();
  /** Expanded paths by the path of their parent, so a folder finds its open children at once. */
  private readonly expandedIn = new Map<string, string[]>();
  readonly separators = new Set<number>();
  /** Every expanded folder whose list the tree reads, with the index of its row in its parent. */
  readonly folders: { node: FolderNode; parent: string | null; index: number | null }[] = [];

  constructor(input: TreeInput) {
    this.input = input;
    for (const path of input.expanded) {
      const parent = parentOf(path);
      const siblings = this.expandedIn.get(parent);
      if (siblings === undefined) this.expandedIn.set(parent, [path]);
      else siblings.push(path);
    }
    const looseCount = this.looseCount();
    this.topSize = (input.quickViews ? QUICK_VIEWS.length : 0) + input.courses.length + looseCount;
    let setPosition = 1;
    const top = (): Placement => ({ level: 1, posinset: setPosition++, setsize: this.topSize });
    if (input.quickViews) {
      for (const view of QUICK_VIEWS) {
        this.segments.push({ kind: 'fixed', item: { ...top(), kind: 'quick', key: keyOf.quick(view), view } });
      }
      this.segments.push({ kind: 'fixed', item: { level: 1, posinset: 0, setsize: 0, kind: 'separator', key: SEPARATOR_KEYS.quick } });
    }
    for (const course of input.courses) {
      const expanded = input.expanded.has(course.folder.path);
      const item = { ...top(), kind: 'course' as const, key: keyOf.entry(course.folder.id), course, expanded };
      const node = expanded ? this.node(course.folder, 2, null, null) : null;
      this.segments.push({ kind: 'course', item, node });
    }
    if (looseCount > 0) {
      this.segments.push({ kind: 'fixed', item: { level: 1, posinset: 0, setsize: 0, kind: 'separator', key: SEPARATOR_KEYS.loose } });
      this.segments.push({ kind: 'loose', offset: input.courses.length, count: looseCount, setOffset: setPosition });
    }
    let start = 0;
    for (const segment of this.segments) {
      if (segment.kind === 'course' && segment.node !== null) placeNode(segment.node, start + 1);
      if (segment.kind === 'fixed' && segment.item.kind === 'separator') this.separators.add(start);
      start += this.segmentSize(segment);
    }
    this.count = start;
  }

  /**
   * Loose files: the semester's children after its course folders. When the semester's first
   * page failed, one row says so and tries again, rather than the loose files going missing.
   */
  private looseCount(): number {
    const semester = this.input.semester;
    if (semester?.total === undefined) return semester?.status === 'error' ? 1 : 0;
    return Math.max(0, semester.total - this.input.courses.length);
  }

  private node(ref: EntryRef, level: number, parent: string | null, index: number | null): FolderNode {
    const list = this.input.lists.get(ref.id);
    const node: FolderNode = {
      ref,
      level,
      list,
      pending: this.input.newFolderIn?.id === ref.id,
      children: [],
      size: 0,
      start: 0,
    };
    this.folders.push({ node, parent, index });
    const open = this.expandedIn.get(ref.path);
    if (list?.total !== undefined && list.total > 0 && open !== undefined) {
      const loaded = loadedIndexes(list, (row) => row.path);
      for (const path of open) {
        const at = loaded.get(path);
        const row = at === undefined ? undefined : list.rowAt(at);
        if (at === undefined || row?.kind !== 'folder') continue;
        node.children.push({ index: at, node: this.node(refOf(row), level + 1, ref.id, at) });
      }
      node.children.sort((a, b) => a.index - b.index);
    }
    node.size = ownRows(node) + node.children.reduce((sum, child) => sum + child.node.size, 0);
    return node;
  }

  private segmentSize(segment: Segment): number {
    switch (segment.kind) {
      case 'fixed':
        return 1;
      case 'course':
        return 1 + (segment.node?.size ?? 0);
      case 'loose':
        return segment.count;
    }
  }

  /** The row at `index` (0 ≤ index < count). */
  rowAt(index: number): TreeItem {
    const cached = this.built.get(index);
    if (cached !== undefined) return cached;
    let rest = index;
    for (const segment of this.segments) {
      const size = this.segmentSize(segment);
      if (rest < size) {
        const item = this.segmentRow(segment, rest);
        this.built.set(index, item);
        return item;
      }
      rest -= size;
    }
    throw new RangeError(`no tree row ${String(index)}`);
  }

  private segmentRow(segment: Segment, rest: number): TreeItem {
    switch (segment.kind) {
      case 'fixed':
        return segment.item;
      case 'course':
        return rest === 0 || segment.node === null ? segment.item : this.nodeRow(segment.node, rest - 1);
      case 'loose': {
        const semester = this.input.semester;
        const placement = { level: 1, posinset: segment.setOffset + rest, setsize: this.topSize };
        const index = segment.offset + rest;
        const row = semester?.rowAt(index);
        if (semester !== undefined && row === undefined && (semester.total === undefined || semester.failedAt(index))) {
          return { ...placement, kind: 'failed', key: `${keyOf.failed('semester')}:${String(index)}`, retry: semester.retry };
        }
        // A folder here means the course list and the semester's children differ for a moment.
        if (row?.kind !== 'file') return { ...placement, kind: 'placeholder', key: `loose:${String(rest)}` };
        return { ...placement, kind: 'entry', key: keyOf.entry(row.id), row, expanded: undefined };
      }
    }
  }

  private nodeRow(node: FolderNode, rest: number): TreeItem {
    const { ref, level, list } = node;
    const total = list?.total;
    if (list === undefined || total === undefined) {
      const placement = { level, posinset: 1, setsize: 1 };
      return list?.status === 'error'
        ? { ...placement, kind: 'failed', key: keyOf.failed(ref.id), retry: list.retry }
        : { ...placement, kind: 'loading', key: keyOf.loading(ref.id), folder: ref };
    }
    const setsize = total + (node.pending ? 1 : 0);
    if (node.pending) {
      if (rest === 0) return { level, posinset: 1, setsize, kind: 'newFolder', key: keyOf.newFolder(ref.id), parent: ref };
      rest -= 1;
    } else if (total === 0) {
      return { level, posinset: 1, setsize: 1, kind: 'empty', key: keyOf.empty(ref.id), folder: ref };
    }
    const shift = node.pending ? 1 : 0;
    let cursor = 0;
    for (const child of node.children) {
      const before = child.index - cursor + 1;
      if (rest < before) return this.listRow(node, cursor + rest, setsize, shift);
      rest -= before;
      if (rest < child.node.size) return this.nodeRow(child.node, rest);
      rest -= child.node.size;
      cursor = child.index + 1;
    }
    return this.listRow(node, cursor + rest, setsize, shift);
  }

  private listRow(node: FolderNode, index: number, setsize: number, shift: number): TreeItem {
    const placement = { level: node.level, posinset: index + 1 + shift, setsize };
    const list = node.list;
    const row = list?.rowAt(index);
    if (row === undefined) {
      // Only rows of a page that failed say so; pages still loading or not asked for wait.
      return list?.failedAt(index) === true
        ? { ...placement, kind: 'failed', key: `${keyOf.failed(node.ref.id)}:${String(index)}`, retry: list.retry }
        : { ...placement, kind: 'placeholder', key: keyOf.placeholder(node.ref.id, index) };
    }
    const expanded = row.kind === 'folder' ? this.input.expanded.has(row.path) : undefined;
    return { ...placement, kind: 'entry', key: keyOf.entry(row.id), row, expanded };
  }

  /**
   * The index of the row with `key`: a quick view, a course, a loaded entry or a new folder's
   * field; `null` for anything else, such as a placeholder, whose key changes once it loads.
   */
  indexOfKey(key: string): number | null {
    let start = 0;
    for (const segment of this.segments) {
      if ((segment.kind === 'fixed' || segment.kind === 'course') && segment.item.key === key) return start;
      if (segment.kind === 'loose' && this.input.semester !== undefined) {
        this.looseIds ??= loadedIndexes(this.input.semester, (row) => row.id, segment.offset);
        const at = this.looseIds.get(key);
        if (at !== undefined) return start + at - segment.offset;
      }
      start += this.segmentSize(segment);
    }
    for (const { node } of this.folders) {
      if (node.pending && key === keyOf.newFolder(node.ref.id)) return node.start;
      if (node.list === undefined) continue;
      node.ids ??= loadedIndexes(node.list, (row) => row.id);
      const at = node.ids.get(key);
      if (at !== undefined) return rowIndexIn(node, at);
    }
    return null;
  }

  /** The names in a course or folder whose pages have arrived, lower case, for "New folder (2)". */
  childNames(folderId: string): Set<string> {
    const node = this.folders.find((folder) => folder.node.ref.id === folderId)?.node;
    const names = new Set<string>();
    if (node?.list === undefined) return names;
    for (const path of loadedIndexes(node.list, (row) => row.path).keys()) {
      names.add(nameOf(path).toLowerCase());
    }
    return names;
  }

  /**
   * The course or folder a new folder goes into from a row: a course or folder itself, else the
   * folder the row is in; `null` outside courses (quick views, loose files).
   */
  folderAt(index: number): EntryRef | null {
    const item = this.rowAt(index);
    if (item.kind === 'course') return item.course.folder;
    if (item.kind === 'entry' && item.row.kind === 'folder') return refOf(item.row);
    if (item.kind === 'newFolder') return item.parent;
    if (item.level < 2) return null;
    for (let at = index - 1; at >= 0; at--) {
      const above = this.rowAt(at);
      if (above.level === item.level - 1) {
        if (above.kind === 'course') return above.course.folder;
        if (above.kind === 'entry') return refOf(above.row);
        return null;
      }
    }
    return null;
  }

  entriesBetween(from: number, to: number, limit: number): EntryRange | Promise<EntryRange> {
    return entriesOf(this.rowsBetween(from, to), limit);
  }

  /** Each row's entry, or where a placeholder loads from. */
  private *rowsBetween(from: number, to: number): Generator<Selected | RowSource | null> {
    for (let index = from; index <= to; index++) {
      const item = this.rowAt(index);
      if (item.kind !== 'placeholder') {
        yield entryOf(item);
        continue;
      }
      const [source] = this.sources(index, index);
      const list = source === undefined ? undefined : source[0] === 'semester' ? this.input.semester : this.input.lists.get(source[0]);
      const at = source?.[1][0];
      yield list === undefined || at === undefined ? null : { list, index: at };
    }
  }

  /**
   * Where each row from `start` to `end` comes from: for every folder list (by id), the indexes
   * in it those rows show. The loose files are the semester's list, keyed `semester`.
   */
  sources(start: number, end: number): Map<string, number[]> {
    const shown = new Map<string, number[]>();
    const add = (id: string, index: number) => {
      const list = shown.get(id);
      if (list === undefined) shown.set(id, [index]);
      else list.push(index);
    };
    let first = 0;
    for (const segment of this.segments) {
      const size = this.segmentSize(segment);
      const from = Math.max(start, first);
      const to = Math.min(end, first + size - 1);
      for (let index = from; index <= to; index++) {
        const rest = index - first;
        if (segment.kind === 'loose') add('semester', segment.offset + rest);
        else if (segment.kind === 'course' && segment.node !== null && rest > 0) this.nodeSource(segment.node, rest - 1, add);
      }
      first += size;
    }
    return shown;
  }

  private nodeSource(node: FolderNode, rest: number, add: (id: string, index: number) => void): void {
    if (node.list?.total === undefined) return;
    if (node.pending) {
      if (rest === 0) return;
      rest -= 1;
    }
    let cursor = 0;
    for (const child of node.children) {
      const before = child.index - cursor + 1;
      if (rest < before) {
        add(node.ref.id, cursor + rest);
        return;
      }
      rest -= before;
      if (rest < child.node.size) {
        this.nodeSource(child.node, rest, add);
        return;
      }
      rest -= child.node.size;
      cursor = child.index + 1;
    }
    add(node.ref.id, cursor + rest);
  }
}

/** The entry a row stands for, with what it is; `null` for rows that are not entries. */
export function entryOf(item: TreeItem): Selected | null {
  if (item.kind === 'course') return { id: item.course.folder.id, path: item.course.folder.path, kind: 'course' };
  if (item.kind === 'entry') return { id: item.row.id, path: item.row.path, kind: item.row.kind };
  return null;
}

/** The tree's rows as the selection and the menus read them. */
export function selectableRows(layout: TreeModel): SelectableRows {
  return {
    keyAt: (index) => layout.rowAt(index).key,
    entryAt: (index) => entryOf(layout.rowAt(index)),
    indexOfKey: (key) => layout.indexOfKey(key),
    entriesBetween: (from, to, limit) => layout.entriesBetween(from, to, limit),
    tagsOf: (id) => {
      const index = layout.indexOfKey(id);
      const item = index === null ? null : layout.rowAt(index);
      return item?.kind === 'entry' ? { tags: item.row.tags, folderTags: item.row.folderTags } : undefined;
    },
  };
}
