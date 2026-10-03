// Import (docs/specs/ipc-m1.md §12; library-actions handoff §4): the file dialog and drops give a
// token for scripted files; `check_import` reports what would happen; `import_files` runs a job
// that adds them, with the one clash policy the user chose for all.
import { nameOf, parentOf } from '../../../lib/paths';
import type { EntryChange, ImportFailure, ImportResult, JobResult } from '../../bindings';
import type { GroupHandlers } from '../contract';
import { fail } from '../failure';
import type { ImportScript } from '../fixtures/types';
import { type FakeLibrary, type FakeNode, freshFields, joinPath } from '../library';
import { importSource, type FakeShell } from '../shell';

/** What the library's ignore rules leave out (library scan §5), and special files. */
const IGNORED = new Set(['node_modules', '.git', '.ds_store', 'thumbs.db', 'desktop.ini']);

function isIgnored(path: string): boolean {
  return path.split('/').some((name) => IGNORED.has(name.toLowerCase()));
}

/** The entry at `path` below `folder`, matching names without case as Windows does. */
function find(library: FakeLibrary, folder: FakeNode, path: string): FakeNode | undefined {
  let node: FakeNode | undefined = folder;
  for (const name of path.split('/')) node = node && library.clash(node, name);
  return node;
}

/** `name (2).ext`, `name (3).ext`, …: the first name free in `folder`. */
function freeName(library: FakeLibrary, folder: FakeNode, name: string): string {
  const dot = name.lastIndexOf('.');
  const [stem, extension] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
  for (let copy = 2; ; copy++) {
    const candidate = `${stem} (${String(copy)})${extension}`;
    if (!library.clash(folder, candidate)) return candidate;
  }
}

export function importCommands(
  shell: FakeShell,
): GroupHandlers<'pick_import_files' | 'check_import' | 'import_files'> {
  return {
    pick_import_files: () => {
      const picked = shell.pickImport();
      return picked === null ? null : importSource(picked.token, picked.script);
    },

    check_import: (request) => {
      const { script } = shell.choice(request.source, 'import', false);
      const library = shell.library;
      const target = library.resolveFolder(request.target);
      const kept = script.items.filter((item) => !isIgnored(item.path));
      const conflicts = kept
        .filter((item) => item.kind === 'file' && find(library, target, item.path)?.kind === 'file')
        .map((item) => ({ path: joinPath(target.path, item.path) }));
      return {
        files: kept.filter((item) => item.kind === 'file').length,
        folders: kept.filter((item) => item.kind === 'folder').length,
        bytes: String(kept.reduce((sum, item) => sum + Number(item.size), 0)),
        skipped: script.items.length - kept.length,
        conflicts: conflicts.slice(0, 100),
        conflictCount: conflicts.length,
      };
    },

    import_files: (request) => {
      const library = shell.writable();
      if (request.tags.some((id) => !library.tags.some((tag) => tag.id === id))) {
        fail('InvalidArgument', '`tags` names a tag that is not defined');
      }
      if (request.tags.length > 0 && library.info.readOnly) {
        fail('ReadOnly', 'a newer Folio wrote the metadata');
      }
      const target = library.resolveFolder(request.target);
      const { script } = shell.choice(request.source, 'import', true);
      return startImport(shell, library, target, script, request);
    },
  };
}

function startImport(
  shell: FakeShell,
  library: FakeLibrary,
  target: FakeNode,
  script: ImportScript,
  request: { tags: string[]; onConflict: 'replace' | 'keepBoth' | 'skip'; deleteOriginals: boolean },
): string {
  const items = script.items;
  const result: ImportResult = {
    imported: 0,
    replaced: 0,
    renamed: 0,
    skipped: 0,
    originalsDeleted: 0,
    failures: [],
    failureCount: 0,
  };
  const failures: ImportFailure[] = [];
  /** Where each source folder landed in the library. */
  const placed = new Map<string, FakeNode>();
  /** Top-level sources with something skipped or failed stay where they are. */
  const incomplete = new Set<string>();

  const importItem = (item: ImportScript['items'][number], changes: EntryChange[]) => {
    const top = item.path.split('/')[0] ?? item.path;
    if (isIgnored(item.path)) {
      result.skipped++;
      incomplete.add(top);
      return;
    }
    const above = parentOf(item.path);
    const parent = above === '' ? target : placed.get(above);
    if (parent === undefined) return; // below a folder that was skipped
    let name = nameOf(item.path);
    const existing = library.clash(parent, name);
    const tags = above === '' ? [...request.tags] : [];
    if (item.kind === 'folder' && existing?.kind === 'folder') {
      placed.set(item.path, existing); // folders merge (§12)
      return;
    }
    if (existing !== undefined) {
      if (item.kind === 'file' && existing.kind === 'file' && request.onConflict === 'skip') {
        result.skipped++;
        incomplete.add(top);
        return;
      }
      if (item.kind === 'file' && existing.kind === 'file' && request.onConflict === 'replace') {
        if (existing.blocked !== null) {
          failures.push({ name: item.path, error: { code: existing.blocked, detail: 'held' } });
          incomplete.add(top);
          return;
        }
        tags.push(...existing.tags);
        changes.push({ kind: 'removed', entry: library.ref(existing) });
        library.remove(existing);
        result.replaced++;
      } else {
        name = freeName(library, parent, name);
        result.renamed++;
      }
    }
    const node = library.add(parent, name, {
      ...freshFields(item.kind, shell.now(), item.size),
      tags: [...new Set(tags)],
    });
    if (item.kind === 'folder') placed.set(item.path, node);
    else result.imported++;
    changes.push({ kind: 'added', entry: library.ref(node) });
  };

  /** The job's result; originals go to the Recycle Bin only once everything is copied. */
  const report = (complete: boolean): JobResult => {
    if (complete && request.deleteOriginals) {
      const tops = new Set(items.map((item) => item.path.split('/')[0] ?? item.path));
      result.originalsDeleted = [...tops].filter((top) => !incomplete.has(top)).length;
    }
    result.failures = failures.slice(0, 100);
    result.failureCount = failures.length;
    return { kind: 'import', ...result };
  };

  // Progress counts files, as the shell's does: a step of files takes the folders before them.
  const files: string[] = [];
  const positions: number[] = [];
  items.forEach((item, at) => {
    if (item.kind !== 'file' || isIgnored(item.path)) return;
    files.push(item.path);
    positions.push(at);
  });
  let next = 0;
  return shell.startJob('import', {
    cancellable: true,
    total: files.length,
    step: Math.max(1, Math.ceil(files.length / 8)),
    onStep: (_from, to) => {
      const changes: EntryChange[] = [];
      const until = positions[to] ?? items.length;
      for (; next < until; next++) {
        const item = items[next];
        if (item !== undefined) importItem(item, changes);
      }
      if (changes.length > 0) shell.changed(changes);
    },
    current: (done) => files[done] ?? null,
    finish: () => report(true),
    stopped: () => report(false),
  });
}
