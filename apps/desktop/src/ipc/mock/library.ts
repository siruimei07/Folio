// The fake shell's library: an in-memory tree with the catalog's ids, revision, tags, semester and
// course settings and problems. Commands read and change it through the methods here. Lists are
// filtered and sorted once per revision, so paging through 50,000 entries stays cheap.
import { nameOf, parentOf } from '../../lib/paths';
import {
  type Course,
  type EntryFilter,
  type EntryKind,
  type EntryRef,
  type EntryRow,
  type EntrySort,
  LIMITS,
  type LibraryInfo,
  type Page,
  type PageRequest,
  type ProblemItem,
  type Semester,
  type Tag,
} from '../bindings';
import { fail } from './failure';
import { groupSettings } from './fixtures/build';
import type { BlockedBy, GroupSettings, LibrarySeed, SeedEntry, SeedTag } from './fixtures/types';
import { classOf, nameOrder, sortItems } from './order';

export interface FakeNode {
  id: string;
  name: string;
  /** `''` for the root. */
  path: string;
  kind: EntryKind;
  parent: FakeNode | null;
  /** By name; empty for files. */
  children: Map<string, FakeNode>;
  size: string;
  modifiedMs: string | null;
  addedMs: string;
  tags: string[];
  group: GroupSettings | null;
  text: string | null;
  blocked: BlockedBy | null;
}

export type NodeFields = Pick<
  FakeNode,
  'kind' | 'size' | 'modifiedMs' | 'addedMs' | 'tags' | 'group' | 'text' | 'blocked'
>;

/** A new entry made through the shell at `now`. */
export function freshFields(kind: EntryKind, now: number, size = '0'): NodeFields {
  return {
    kind,
    size: kind === 'folder' ? '0' : size,
    modifiedMs: String(now),
    addedMs: String(now),
    tags: [],
    group: null,
    text: null,
    blocked: null,
  };
}

export function joinPath(parent: string, name: string): string {
  return parent === '' ? name : `${parent}/${name}`;
}

/** Names in a path: 0 for the root, 1 for a semester, 2 for a course. */
function depthOf(path: string): number {
  if (path === '') return 0;
  let depth = 1;
  for (const char of path) if (char === '/') depth++;
  return depth;
}

/** Checks a page request as the shell does (ipc-m1 §4.1, §5.3). */
export function checkPage(page: PageRequest, limit: number = LIMITS.pageSize): void {
  const valid = (value: number) => Number.isInteger(value) && value >= 0 && value <= 0xffff_ffff;
  if (!valid(page.offset) || !valid(page.limit) || page.limit > limit) {
    fail('InvalidArgument', `page ${JSON.stringify(page)} is outside the limits`);
  }
}

/** A file and the tags it gets from folders above it (ipc-m1 §8.2), from one walk. */
export interface FileWithTags {
  node: FakeNode;
  folderTags: readonly string[];
}

export class FakeLibrary {
  info: LibraryInfo;
  readonly root: FakeNode;
  readonly byId = new Map<string, FakeNode>();
  private readonly byPath = new Map<string, FakeNode>();
  tags: SeedTag[];
  problems: ProblemItem[] = [];
  /** The text of `.folio/ignore`. */
  ignoreRules: string;
  revision = 0;
  private nextId = 1;
  private nextProblem = 1;
  /** Filtered and sorted lists, and the tag order, at the current revision. */
  private readonly lists = new Map<string, FakeNode[]>();
  private tagOrder: Map<string, number> | null = null;

  constructor(id: string, seed: LibrarySeed) {
    this.info = {
      id,
      name: seed.name,
      root: seed.root,
      readOnly: seed.readOnly,
      recovered: seed.recovered,
    };
    this.tags = seed.tags.map((tag) => ({ ...tag }));
    this.ignoreRules = seed.ignoreRules ?? '';
    this.root = {
      id: '0',
      name: '',
      path: '',
      kind: 'folder',
      parent: null,
      children: new Map(),
      size: '0',
      modifiedMs: null,
      addedMs: '0',
      tags: [],
      group: null,
      text: null,
      blocked: null,
    };
    this.byPath.set('', this.root);
    for (const entry of seed.entries) {
      if (this.addSeed(entry) === undefined) {
        throw new Error(`fixture entry before its folder, or twice: ${entry.path}`);
      }
    }
    for (const problem of seed.problems) this.addProblem(problem);
  }

  // ---- revisions and problems

  /** Records a committed change: the next revision; lists are filtered and sorted again. */
  commit(): void {
    this.revision = (this.revision + 1) >>> 0;
    this.lists.clear();
    this.tagOrder = null;
  }

  addProblem(problem: ProblemItem['problem']): void {
    const id = String(this.nextProblem++);
    this.problems.push({ id, problem, detail: `fake problem ${id} (${problem.kind})` });
  }

  // ---- finding entries

  at(path: string): FakeNode | undefined {
    return this.byPath.get(path);
  }

  /** The entry a reference names: its id must be at its path, case included (ipc-m1 §5.1). */
  resolve(ref: EntryRef): FakeNode {
    const node = this.byId.get(ref.id);
    if (node?.path !== ref.path || node === this.root) {
      fail('NotFound', `no entry ${ref.id} at "${ref.path}"`);
    }
    return node;
  }

  /** A folder reference, `null` for the root; a file is `InvalidArgument`. */
  resolveFolder(ref: EntryRef | null): FakeNode {
    const node = ref === null ? this.root : this.resolve(ref);
    if (node.kind !== 'folder') fail('InvalidArgument', `"${node.path}" is not a folder`);
    return node;
  }

  depth(node: FakeNode): number {
    return depthOf(node.path);
  }

  isSemester(node: FakeNode): boolean {
    return node.kind === 'folder' && this.depth(node) === 1;
  }

  isCourse(node: FakeNode): boolean {
    return node.kind === 'folder' && this.depth(node) === 2;
  }

  /** A semester or course folder: it has settings, and no tags (library core §4.1). */
  isGroup(node: FakeNode): boolean {
    return node.kind === 'folder' && this.depth(node) <= 2;
  }

  /** The sibling whose name matches ignoring case, as Windows would refuse it. */
  clash(folder: FakeNode, name: string, except?: FakeNode): FakeNode | undefined {
    const lower = name.toLowerCase();
    for (const child of folder.children.values()) {
      if (child !== except && child.name.toLowerCase() === lower) return child;
    }
    return undefined;
  }

  /** Everything below `node`, parents before children. */
  walk(node: FakeNode): FakeNode[] {
    const found: FakeNode[] = [];
    const stack = [...node.children.values()].reverse();
    for (let next = stack.pop(); next !== undefined; next = stack.pop()) {
      found.push(next);
      if (next.children.size > 0) stack.push(...[...next.children.values()].reverse());
    }
    return found;
  }

  /**
   * Every file below `scope` with the tags it gets from folders above it inside its course,
   * carried down one walk instead of looked up per file.
   */
  filesWithTags(scope: FakeNode): FileWithTags[] {
    const above = new Set<string>();
    for (let folder: FakeNode | null = scope; folder !== null; folder = folder.parent) {
      if (this.depth(folder) >= 3) for (const tag of folder.tags) above.add(tag);
    }
    const found: FileWithTags[] = [];
    const visit = (folder: FakeNode, inherited: readonly string[]) => {
      for (const child of folder.children.values()) {
        if (child.kind === 'file') found.push({ node: child, folderTags: inherited });
        else {
          const own = this.depth(child) >= 3 ? child.tags.filter((tag) => !inherited.includes(tag)) : [];
          visit(child, own.length === 0 ? inherited : [...inherited, ...own]);
        }
      }
    };
    visit(scope, [...above]);
    return found;
  }

  // ---- rows

  ref(node: FakeNode): EntryRef {
    return { id: node.id, path: node.path };
  }

  /** Tag ids in the user's order of tags; ids nobody defined go last. */
  private inTagOrder(ids: Iterable<string>): string[] {
    const order = (this.tagOrder ??= new Map(this.tags.map((tag, index) => [tag.id, index])));
    return [...new Set(ids)].sort(
      (a, b) => (order.get(a) ?? Infinity) - (order.get(b) ?? Infinity),
    );
  }

  /** Tags a file gets from the folders above it inside its course (ipc-m1 §8.2). */
  folderTags(node: FakeNode): string[] {
    const found = new Set<string>();
    for (let folder = node.parent; folder !== null; folder = folder.parent) {
      if (this.depth(folder) >= 3) for (const tag of folder.tags) found.add(tag);
    }
    for (const tag of node.tags) found.delete(tag);
    return this.inTagOrder(found);
  }

  row(node: FakeNode): EntryRow {
    return {
      id: node.id,
      path: node.path,
      name: node.name,
      kind: node.kind,
      class: classOf(node.name, node.kind),
      size: node.size,
      modifiedMs: node.modifiedMs,
      addedMs: node.addedMs,
      tags: this.inTagOrder(node.tags),
      folderTags: this.folderTags(node),
    };
  }

  // ---- lists

  private cached(key: string, build: () => FakeNode[]): FakeNode[] {
    let list = this.lists.get(key);
    if (list === undefined) {
      list = build();
      this.lists.set(key, list);
    }
    return list;
  }

  /** A folder's children, folders first, then in `sort` order. */
  children(folder: FakeNode, sort: EntrySort): FakeNode[] {
    return this.cached(`children:${folder.id}:${JSON.stringify(sort)}`, () => {
      const all = [...folder.children.values()];
      return [
        ...sortItems(all.filter((node) => node.kind === 'folder'), sort),
        ...sortItems(all.filter((node) => node.kind === 'file'), sort),
      ];
    });
  }

  /** Files at any depth below `scope` that pass `filter`, in no particular order (a count). */
  filtered(scope: FakeNode, filter: EntryFilter): FakeNode[] {
    return this.cached(`filtered:${scope.id}:${JSON.stringify(filter)}`, () => {
      const after = filter.addedAfterMs === null ? null : Number(filter.addedAfterMs);
      const tags = filter.tags;
      const passes = (node: FakeNode, folderTags: readonly string[]) => {
        if (after !== null && Number(node.addedMs) <= after) return false;
        if (tags === null) return true;
        const effective = new Set([...node.tags, ...folderTags]);
        return tags.kind === 'untagged'
          ? effective.size === 0
          : tags.tags.every((tag) => effective.has(tag));
      };
      return this.filesWithTags(scope)
        .filter(({ node, folderTags }) => passes(node, folderTags))
        .map(({ node }) => node);
    });
  }

  /** Files at any depth below `scope` that pass `filter`, in `sort` order (ipc-m1 §9.1). */
  files(scope: FakeNode, filter: EntryFilter, sort: EntrySort): FakeNode[] {
    const key = `files:${scope.id}:${JSON.stringify(filter)}:${JSON.stringify(sort)}`;
    return this.cached(key, () => sortItems(this.filtered(scope, filter), sort));
  }

  /** A page of `list`; `list` is only built when the page has rows (a count needs none). */
  page(list: () => FakeNode[], total: number, request: PageRequest): Page<EntryRow> {
    const items =
      request.limit === 0
        ? []
        : list()
            .slice(request.offset, request.offset + request.limit)
            .map((node) => this.row(node));
    return { items, offset: request.offset, total, revision: this.revision };
  }

  // ---- semesters, courses, tags

  /** Folders in their user order: ordered ones first, then the others by name (ipc-m1 §7). */
  groupsIn(folder: FakeNode): FakeNode[] {
    return [...folder.children.values()]
      .filter((node) => node.kind === 'folder')
      .sort((a, b) => {
        const left = a.group?.order ?? null;
        const right = b.group?.order ?? null;
        if (left !== null && right !== null) return left - right;
        if (left !== null || right !== null) return left === null ? 1 : -1;
        return nameOrder.compare(a.name, b.name);
      });
  }

  semester(node: FakeNode): Semester {
    return { folder: this.ref(node), name: node.name, archived: node.group?.archived ?? false };
  }

  course(node: FakeNode): Course {
    return {
      folder: this.ref(node),
      name: node.name,
      abbr: node.group?.abbr ?? null,
      code: node.group?.code ?? null,
      color: node.group?.color ?? null,
      archived: node.group?.archived ?? false,
      files: this.walk(node).filter((below) => below.kind === 'file').length,
    };
  }

  /** Settings of a semester or course, made when it gets its first. */
  settings(node: FakeNode): GroupSettings {
    node.group ??= groupSettings();
    return node.group;
  }

  /** Numbers `nodes` in this order; every other folder of their parent follows them. */
  reorder(nodes: FakeNode[]): void {
    nodes.forEach((node, index) => {
      this.settings(node).order = index + 1;
    });
  }

  tagList(): Tag[] {
    const usage = new Map<string, number>();
    for (const node of this.walk(this.root)) {
      for (const tag of node.tags) usage.set(tag, (usage.get(tag) ?? 0) + 1);
    }
    return this.tags.map((tag) => ({ ...tag, usage: usage.get(tag.id) ?? 0 }));
  }

  // ---- changes

  add(parent: FakeNode, name: string, fields: NodeFields): FakeNode {
    const node: FakeNode = {
      id: String(this.nextId++),
      name,
      path: joinPath(parent.path, name),
      parent,
      children: new Map(),
      ...fields,
    };
    parent.children.set(name, node);
    this.byId.set(node.id, node);
    this.byPath.set(node.path, node);
    return node;
  }

  /**
   * Adds an entry a fixture or a scan describes, below its folder; `undefined` when that folder
   * is not there or the path is taken.
   */
  addSeed(entry: SeedEntry): FakeNode | undefined {
    const parent = this.at(parentOf(entry.path));
    if (parent?.kind !== 'folder' || this.at(entry.path) !== undefined) return undefined;
    return this.add(parent, nameOf(entry.path), {
      ...entry,
      tags: [...entry.tags],
      group: entry.group && { ...entry.group },
    });
  }

  /** Moves or renames `node`; everything below it gets its new path. */
  move(node: FakeNode, parent: FakeNode, name: string): void {
    const moved = [node, ...this.walk(node)];
    for (const below of moved) this.byPath.delete(below.path);
    node.parent?.children.delete(node.name);
    node.parent = parent;
    node.name = name;
    parent.children.set(name, node);
    for (const below of moved) {
      below.path = joinPath(below.parent?.path ?? '', below.name);
      this.byPath.set(below.path, below);
    }
  }

  remove(node: FakeNode): void {
    node.parent?.children.delete(node.name);
    for (const below of [node, ...this.walk(node)]) {
      this.byId.delete(below.id);
      this.byPath.delete(below.path);
    }
  }

  /** A rebuilt catalog numbers its entries anew (ipc-m1 §13): old references go stale. */
  renumber(): number {
    const nodes = this.walk(this.root);
    this.byId.clear();
    for (const node of nodes) {
      node.id = String(this.nextId++);
      this.byId.set(node.id, node);
    }
    return nodes.length;
  }
}
