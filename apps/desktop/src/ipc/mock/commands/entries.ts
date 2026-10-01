// Entries (docs/specs/ipc-m1.md §9): listing, one entry, paths relative to a note, and changes.
// References must name an id at its path (§5.1); batches report every item that failed (§5.4).
import { isBelow } from '../../../lib/paths';
import { type EntryChange, type EntryRow, LIMITS } from '../../bindings';
import type { GroupHandlers } from '../contract';
import { eachItem, fail } from '../failure';
import { checkPage, type FakeLibrary, type FakeNode, freshFields } from '../library';
import { charCount } from '../../../lib/text';
import { fileName } from '../names';
import type { FakeShell } from '../shell';

function checkUnblocked(node: FakeNode): void {
  if (node.blocked !== null) fail(node.blocked, `"${node.path}" is held (fake shell)`);
}

/**
 * Whether `node` may move or be renamed: no other program holds it, and it carries no tags or
 * settings that a read-only library could not let follow it (§9.2).
 */
function checkMovable(library: FakeLibrary, node: FakeNode): void {
  checkUnblocked(node);
  if (!library.info.readOnly) return;
  const carries =
    node.group !== null || [node, ...library.walk(node)].some((below) => below.tags.length > 0);
  if (carries) fail('ReadOnly', 'tags or settings would have to follow');
}

/** `resolve_paths` for one path (§9.1): the file it names, or `null`. */
function resolveRelative(library: FakeLibrary, base: FakeNode, text: string): EntryRow | null {
  if (/^[a-z][a-z0-9+.-]*:/i.test(text) || /^[/\\]/.test(text)) return null;
  const names: string[] = base.path.split('/').slice(0, -1);
  for (const raw of text.split(/[/\\]/)) {
    if (raw === '' || raw === '.') continue;
    if (raw === '..') {
      if (names.pop() === undefined) return null;
      continue;
    }
    names.push(raw.normalize('NFC'));
  }
  let node: FakeNode | undefined = library.root;
  for (const name of names) {
    const exact: FakeNode | undefined = node.children.get(name);
    if (exact !== undefined) {
      node = exact;
      continue;
    }
    // Windows matches names without case; case twins without an exact match are ambiguous.
    const twins: FakeNode[] = [...node.children.values()].filter(
      (child) => child.name.toLowerCase() === name.toLowerCase(),
    );
    node = twins.length === 1 ? twins[0] : undefined;
    if (node === undefined) return null;
  }
  return node.kind === 'file' && node !== library.root ? library.row(node) : null;
}

export function entryCommands(
  shell: FakeShell,
): GroupHandlers<
  | 'list_children'
  | 'list_files'
  | 'get_entry'
  | 'resolve_paths'
  | 'create_folder'
  | 'rename_entry'
  | 'move_entries'
  | 'delete_entries'
> {
  return {
    list_children: (request) => {
      const library = shell.library;
      checkPage(request.page);
      const folder = library.resolveFolder(request.folder);
      const list = () => library.children(folder, request.sort);
      return library.page(list, folder.children.size, request.page);
    },

    list_files: (request) => {
      const library = shell.library;
      checkPage(request.page);
      const { tags } = request.filter;
      if (tags?.kind === 'withAll' && (tags.tags.length === 0 || tags.tags.length > LIMITS.filterTags)) {
        fail('InvalidArgument', 'a tag filter holds 1 to LIMITS.filterTags tags');
      }
      if (request.filter.addedAfterMs !== null && !/^\d+$/.test(request.filter.addedAfterMs)) {
        fail('InvalidArgument', '`addedAfterMs` is not a decimal time');
      }
      const scope = library.resolveFolder(request.scope);
      // A count (limit 0) needs the filtered files only, not their order.
      const list = () => library.files(scope, request.filter, request.sort);
      return library.page(list, library.filtered(scope, request.filter).length, request.page);
    },

    get_entry: (request) => {
      const library = shell.library;
      return library.row(library.resolve(request.entry));
    },

    resolve_paths: (request) => {
      const library = shell.library;
      const tooLong = request.paths.some((path) => charCount(path) > LIMITS.relativePathChars);
      if (request.paths.length > LIMITS.resolvePaths || tooLong) {
        fail('InvalidArgument', 'over LIMITS.resolvePaths or LIMITS.relativePathChars');
      }
      const base = library.resolve(request.base);
      if (base.kind !== 'file') fail('InvalidArgument', '`base` is a folder');
      return request.paths.map((path) => resolveRelative(library, base, path));
    },

    create_folder: (request) => {
      const library = shell.writable();
      const parent = library.resolveFolder(request.parent);
      if (library.depth(parent) < 2) fail('InvalidArgument', 'folders go inside a course');
      const name = fileName(request.name);
      if (library.clash(parent, name)) fail('AlreadyExists', `"${name}" is taken`);
      const node = library.add(parent, name, freshFields('folder', shell.now()));
      shell.changed([{ kind: 'added', entry: library.ref(node) }]);
      return library.row(node);
    },

    rename_entry: (request) => {
      const library = shell.writable();
      const node = library.resolve(request.entry);
      const parent = node.parent ?? library.root;
      const name = fileName(request.name, { atRoot: parent === library.root });
      if (library.clash(parent, name, node)) fail('AlreadyExists', `"${name}" is taken`);
      checkMovable(library, node);
      if (name === node.name) return library.row(node);
      const from = node.path;
      library.move(node, parent, name);
      shell.changed([{ kind: 'moved', entry: library.ref(node), from }], {
        groups: library.isGroup(node),
      });
      return library.row(node);
    },

    move_entries: (request) => {
      const library = shell.writable();
      const target = library.resolveFolder(request.to);
      const changes: EntryChange[] = [];
      const stranded: { from: string; to: string }[] = [];
      let groups = false;
      const result = eachItem(request.entries, (entry) => {
        const node = library.resolve(entry);
        if (library.isSemester(node)) fail('InvalidMove', 'rename a semester instead');
        if (node === target || isBelow(target.path, node.path)) {
          fail('InvalidMove', 'a folder cannot go into itself');
        }
        if (node.parent === target) return;
        if (library.clash(target, node.name)) fail('AlreadyExists', `"${node.name}" is taken`);
        checkMovable(library, node);
        const from = node.path;
        const wasGroup = library.isGroup(node);
        library.move(node, target, node.name);
        const isGroup = library.isGroup(node);
        // A folder that becomes a semester or course cannot keep its own tags (§9.2).
        if (isGroup && node.tags.length > 0) {
          node.tags = [];
          stranded.push({ from, to: node.path });
        }
        groups ||= wasGroup || isGroup;
        changes.push({ kind: 'moved', entry: library.ref(node), from });
      });
      if (changes.length > 0) shell.changed(changes, { groups });
      if (stranded.length > 0) {
        shell.addProblems(
          stranded.map((move) => ({ kind: 'notRelocated', ...move, cause: 'folderTags' })),
        );
      }
      return result;
    },

    delete_entries: (request) => {
      const library = shell.writable();
      const changes: EntryChange[] = [];
      let groups = false;
      const result = eachItem(request.entries, (entry) => {
        const node = library.resolve(entry);
        for (const below of [node, ...library.walk(node)]) checkUnblocked(below);
        groups ||= library.isGroup(node);
        library.remove(node);
        changes.push({ kind: 'removed', entry: { ...entry } });
      });
      if (changes.length > 0) shell.changed(changes, { groups });
      return result;
    },
  };
}
