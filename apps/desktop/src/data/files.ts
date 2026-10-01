// Opening files (docs/specs/ipc-m1.md §11.1) and finding the files a note names (§9.1). None of
// these changes the catalog. File bytes come through `folio-file` URLs (`contentUrl` in `ipc`).
import { useQuery } from '@tanstack/react-query';

import { type EntryRef, type EntryRow, ipc, LIMITS, type OpenEntry, type RevealEntry } from '../ipc';
import { charCount } from '../lib/text';
import { unwrap } from './errors';
import { keys, libraryQuery, NO_ENTRY } from './keys';
import { useCommandMutation } from './mutations';
import { useLibraryId } from './session';

/**
 * Opens an entry with its default program, a folder in File Explorer; resolves to how it opened
 * (`editor`: a script, opened for editing). Programs and scripts never run: `Blocked`.
 */
export function useOpenEntry() {
  return useCommandMutation((request: OpenEntry) => ipc.openEntry(request), {
    entries: (request) => [request.entry],
  });
}

/** "Show in File Explorer": opens File Explorer with the entry selected. */
export function useRevealEntry() {
  return useCommandMutation((request: RevealEntry) => ipc.revealEntry(request), {
    entries: (request) => [request.entry],
  });
}

/**
 * Whether the shell can take a path at all: it refuses the whole call for a path over
 * `LIMITS.relativePathChars`, and its JSON parser for text that is not well formed (a lone
 * surrogate). Such a path names nothing, so it answers `null` without asking.
 */
function isAskable(path: string): boolean {
  // UTF-16 units are never fewer than characters, so most paths need no count.
  const fits = path.length <= LIMITS.relativePathChars || charCount(path) <= LIMITS.relativePathChars;
  return fits && path.isWellFormed();
}

async function resolvePaths(base: EntryRef, paths: readonly string[]) {
  const askable = paths.map(isAskable);
  const asked = paths.filter((_path, index) => askable[index]);
  const calls: Promise<(EntryRow | null)[]>[] = [];
  for (let start = 0; start < asked.length; start += LIMITS.resolvePaths) {
    const chunk = asked.slice(start, start + LIMITS.resolvePaths);
    calls.push(unwrap(ipc.resolvePaths({ base, paths: chunk })));
  }
  const rows = (await Promise.all(calls)).flat();
  let next = 0;
  return askable.map((ok) => (ok ? (rows[next++] ?? null) : null));
}

/**
 * The files that `paths`, relative paths a note writes (percent-decoded, without `?` and `#`
 * parts), name next to the note `base`: one row or `null` per path, in order. `null` for
 * anything absolute, outside the library, a folder or not catalogued. Asked again whenever the
 * catalog changes, since the paths may name anything. `null` asks for nothing.
 */
export function useResolvedPaths(base: EntryRef | null, paths: readonly string[]) {
  const libraryId = useLibraryId();
  const request = { base: base ?? NO_ENTRY, paths };
  return useQuery(
    libraryQuery(
      base === null ? null : libraryId,
      (library) => keys.resolve(library, request),
      () => resolvePaths(request.base, paths),
    ),
  );
}
