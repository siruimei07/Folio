// Orders and file classes as the shell computes them (docs/specs/ipc-m1.md §5.3; library core
// §4.2), for the fake shell's pages.
import { extensionOf } from '../../lib/file-types';
import type { EntrySort, FileClass } from '../bindings';

/** File Explorer's name order: without case, digits by value (`hw2` before `hw10`). */
export const nameOrder = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

export interface Sortable {
  name: string;
  path: string;
  kind: 'file' | 'folder';
  size: string;
  modifiedMs: string | null;
  addedMs: string;
}

/**
 * Paths compared name by name, so a folder's contents follow it without anything in between.
 * The comparator splits each path once: a sort compares every path many times.
 */
export function pathOrder(): (a: string, b: string) => number {
  const names = new Map<string, string[]>();
  const split = (path: string): string[] => {
    let parts = names.get(path);
    if (parts === undefined) {
      parts = path.split('/');
      names.set(path, parts);
    }
    return parts;
  };
  return (a, b) => {
    const left = split(a);
    const right = split(b);
    for (let index = 0; index < Math.min(left.length, right.length); index++) {
      const order = nameOrder.compare(left[index] ?? '', right[index] ?? '');
      if (order !== 0) return order;
    }
    return left.length - right.length || (a < b ? -1 : a > b ? 1 : 0);
  };
}

/** An item with its sort key worked out once, not on each of a sort's many comparisons. */
interface Keyed<T> {
  item: T;
  /** Times and sizes as numbers; `null` for a missing modification time. */
  number: number | null;
  /** The extension, for the type order. */
  text: string;
}

/**
 * `items` in the order of `sort`. Missing modification times go last in both directions, and ties
 * go to the path, so the order is total and pages never overlap.
 */
export function sortItems<T extends Sortable>(items: readonly T[], sort: EntrySort): T[] {
  const direction = sort.descending ? -1 : 1;
  const comparePaths = pathOrder();
  const keyed: Keyed<T>[] = items.map((item) => ({
    item,
    number:
      sort.key === 'modified'
        ? item.modifiedMs === null
          ? null
          : Number(item.modifiedMs)
        : sort.key === 'size'
          ? Number(item.size)
          : sort.key === 'added'
            ? Number(item.addedMs)
            : 0,
    text: sort.key === 'type' ? extensionOf(item.name) : '',
  }));
  const primary = (a: Keyed<T>, b: Keyed<T>): number => {
    switch (sort.key) {
      case 'name':
        return nameOrder.compare(a.item.name, b.item.name);
      case 'path':
        return comparePaths(a.item.path, b.item.path);
      case 'type':
        return nameOrder.compare(a.text, b.text) || nameOrder.compare(a.item.name, b.item.name);
      default:
        return (a.number ?? 0) - (b.number ?? 0);
    }
  };
  keyed.sort((a, b) => {
    if ((a.number === null) !== (b.number === null)) return a.number === null ? 1 : -1;
    return direction * primary(a, b) || comparePaths(a.item.path, b.item.path);
  });
  return keyed.map((entry) => entry.item);
}

/** Text, markup, data and source files whose versions Folio keeps (core `VersioningRules`). */
const TEXT_EXTENSIONS = new Set(
  (
    'adoc asm bat bib c cc cfg cls cmake cmd conf cpp cs css csv dart go h hpp hs htm html ini ' +
    'ipynb java js json jsx kt latex lua m markdown md mjs ml org php pl ps1 py qmd r rb rmd rs ' +
    'rst s sass scala scss sh sql sty sv swift tex toml ts tsv tsx txt v vhd vhdl vue xml yaml yml'
  ).split(' '),
);

export function classOf(name: string, kind: 'file' | 'folder'): FileClass {
  if (kind === 'folder') return 'other';
  const extension = extensionOf(name);
  if (TEXT_EXTENSIONS.has(extension)) return 'text';
  return extension === 'docx' ? 'word' : 'other';
}
