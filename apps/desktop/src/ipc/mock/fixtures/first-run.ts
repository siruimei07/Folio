// First run (first-run handoff §2–§5): no library on this machine yet. The folder dialog answers
// with one of the folders of handoff §4.2, which decides what `create_library` and `open_library`
// do with it.
import type { FolderContent, SyncProvider } from '../../bindings';
import { presetTags, TO_REVIEW } from './build';
import { SMALL_ROOT, smallLibrary } from './small';
import type { FolderScript, LibrarySeed } from './types';

export type FolderKind = FolderContent['kind'];

/** A folder with courses in it and no `.folio/`: the small library's files, untagged. */
function takeOver(now: number, name: string, root: string): LibrarySeed {
  const small = smallLibrary(now);
  return {
    ...small,
    name,
    root,
    tags: presetTags(),
    entries: small.entries.map((entry) => ({ ...entry, tags: [], group: null })),
    problems: [],
  };
}

/** The folder the dialog answers with, for each kind of content. */
export function folderScript(
  kind: FolderKind,
  now: number,
  syncRoot: SyncProvider | null = null,
): FolderScript {
  switch (kind) {
    case 'empty':
      return { path: 'C:\\Users\\Student\\Documents\\Folio', content: { kind }, syncRoot };
    case 'folders':
      return {
        path: 'D:\\University',
        content: { kind, folders: 4, files: 1 },
        syncRoot,
        library: () => takeOver(now, 'University', 'D:\\University'),
      };
    case 'library':
      return {
        path: SMALL_ROOT,
        content: { kind, name: 'University of Toronto' },
        syncRoot,
        library: () => smallLibrary(now),
      };
    case 'insideLibrary':
      return {
        path: `${SMALL_ROOT}\\Fall 2026`,
        content: { kind, root: SMALL_ROOT },
        syncRoot,
      };
    case 'incomplete':
      return {
        path: 'D:\\Courses',
        content: { kind, folders: 4, files: 1 },
        syncRoot,
        // `.folio/` survived with its tags, so they are kept (ipc-m1 §6).
        library: () => ({
          ...takeOver(now, 'Courses', 'D:\\Courses'),
          tags: [...presetTags(), TO_REVIEW],
        }),
      };
  }
}
