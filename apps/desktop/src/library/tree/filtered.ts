// The tree with a tag filter on (app-shell handoff §5; UI architecture §8.2): only the files that
// have every selected tag, in their courses and folders, which all show expanded. The files come
// from `list_files` over the semester; the tree is built from their paths, so folders between a
// course and its files are known by path only. Up to `FILTER_CAP` files; beyond, the List mode
// shows them all.
import type { Course, EntryRef, EntryRow } from '../../ipc';
import { parentOf } from '../../lib/paths';
import { courseIn } from '../places';
import { type EntryRange, entriesOf } from '../selecting';
import { entryOf, keyOf, QUICK_VIEWS, SEPARATOR_KEYS, type TreeItem, type TreeModel } from './layout';

/** Files the filtered tree loads (25 pages); UI architecture §17 item 3. */
export const FILTER_CAP = 5000;

interface FolderTrie {
  folders: Map<string, FolderTrie>;
  files: EntryRow[];
}

function trie(): FolderTrie {
  return { folders: new Map(), files: [] };
}

export interface FilteredInput {
  quickViews: boolean;
  courses: readonly Course[];
  /** The semester's folder: files directly in it are its loose files. */
  semesterPath: string;
  /** The matching files that arrived. */
  rows: readonly EntryRow[];
  /** Name order of the UI language, digits by value. */
  compare: (a: string, b: string) => number;
}

export class FilteredLayout implements TreeModel {
  readonly collapsible = false;
  readonly separators = new Set<number>();
  readonly count: number;
  private readonly items: TreeItem[] = [];
  private readonly keys = new Map<string, number>();
  private readonly folders = new Map<number, EntryRef | null>();

  constructor({ quickViews, courses, semesterPath, rows, compare }: FilteredInput) {
    const byCourse = new Map<string, FolderTrie>();
    const counts = new Map<string, number>();
    const loose: EntryRow[] = [];
    for (const row of rows) {
      if (parentOf(row.path) === semesterPath) {
        loose.push(row);
        continue;
      }
      const course = courseIn(row.path, courses);
      if (course === undefined) continue;
      let node: FolderTrie = byCourse.get(course.folder.id) ?? trie();
      byCourse.set(course.folder.id, node);
      counts.set(course.folder.id, (counts.get(course.folder.id) ?? 0) + 1);
      const names = row.path.slice(course.folder.path.length + 1).split('/');
      names.pop();
      for (const name of names) {
        const next: FolderTrie = node.folders.get(name) ?? trie();
        node.folders.set(name, next);
        node = next;
      }
      node.files.push(row);
    }

    const shown = courses.filter((course) => byCourse.has(course.folder.id));
    const topSize = (quickViews ? QUICK_VIEWS.length : 0) + shown.length + loose.length;
    let position = 1;
    if (quickViews) {
      for (const view of QUICK_VIEWS) {
        this.push({ kind: 'quick', key: keyOf.quick(view), view, level: 1, posinset: position++, setsize: topSize }, null);
      }
      if (shown.length > 0 || loose.length > 0) {
        this.push({ kind: 'separator', key: SEPARATOR_KEYS.quick, level: 1, posinset: 0, setsize: 0 }, null);
      }
    }
    for (const course of shown) {
      this.push(
        {
          kind: 'course',
          key: keyOf.entry(course.folder.id),
          course,
          expanded: true,
          count: counts.get(course.folder.id) ?? 0,
          level: 1,
          posinset: position++,
          setsize: topSize,
        },
        null,
      );
      const node = byCourse.get(course.folder.id);
      if (node !== undefined) this.walk(node, course.folder.path, 2, course.folder, compare);
    }
    if (loose.length > 0) {
      this.push({ kind: 'separator', key: SEPARATOR_KEYS.loose, level: 1, posinset: 0, setsize: 0 }, null);
      for (const row of [...loose].sort((a, b) => compare(a.name, b.name))) {
        this.push(
          { kind: 'entry', key: keyOf.entry(row.id), row, expanded: undefined, level: 1, posinset: position++, setsize: topSize },
          null,
        );
      }
    }
    this.count = this.items.length;
  }

  private push(item: TreeItem, folder: EntryRef | null): void {
    if (item.kind === 'separator') this.separators.add(this.items.length);
    this.keys.set(item.key, this.items.length);
    this.folders.set(this.items.length, folder);
    this.items.push(item);
  }

  /** Folders first, then files, each by name; `course` is where a new folder from a file would go. */
  private walk(
    node: FolderTrie,
    path: string,
    level: number,
    course: EntryRef | null,
    compare: (a: string, b: string) => number,
  ): void {
    const folders = [...node.folders.keys()].sort(compare);
    const files = [...node.files].sort((a, b) => compare(a.name, b.name));
    const setsize = folders.length + files.length;
    let position = 1;
    for (const name of folders) {
      const folderPath = `${path}/${name}`;
      this.push({ kind: 'pathFolder', key: `path:${folderPath}`, path: folderPath, level, posinset: position++, setsize }, null);
      const below = node.folders.get(name);
      // Folders known only by path take no new folders.
      if (below !== undefined) this.walk(below, folderPath, level + 1, null, compare);
    }
    for (const row of files) {
      this.push({ kind: 'entry', key: keyOf.entry(row.id), row, expanded: undefined, level, posinset: position++, setsize }, course);
    }
  }

  rowAt(index: number): TreeItem {
    const item = this.items[index];
    if (item === undefined) throw new RangeError(`no tree row ${String(index)}`);
    return item;
  }

  indexOfKey(key: string): number | null {
    return this.keys.get(key) ?? null;
  }

  folderAt(index: number): EntryRef | null {
    const item = this.items[index];
    if (item?.kind === 'course') return item.course.folder;
    return this.folders.get(index) ?? null;
  }

  childNames(): Set<string> {
    return new Set();
  }

  /** Every match is loaded, so a range is known at once. */
  entriesBetween(from: number, to: number, limit: number): EntryRange {
    const rows = (function* (items: readonly TreeItem[]) {
      for (let index = from; index <= to; index++) {
        const item = items[index];
        yield item === undefined ? null : entryOf(item);
      }
    })(this.items);
    return entriesOf(rows, limit) as EntryRange;
  }
}
