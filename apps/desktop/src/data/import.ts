// Import (docs/specs/ipc-m1.md §12; library-actions handoff §3–§5). Files come from the file
// dialog or a drop as a choice token; `check_import` says what adding them to a folder would do,
// and `import_files` starts the job that adds them, whose progress and result arrive as
// JobChanged (`jobs.ts`) and whose files arrive as CatalogChanged. Until `feat/core-import`
// lands, only the fake shell answers these commands.
import { useQuery } from '@tanstack/react-query';
import { useEffect, useEffectEvent, useState } from 'react';

import {
  type EntryRef,
  type FilesDropped,
  type ImportFiles,
  ipc,
  type Point,
  shellEvents,
} from '../ipc';
import { unwrap } from './errors';
import { keys, libraryQuery, NO_ENTRY } from './keys';
import { useCommandMutation } from './mutations';
import { useLibraryId } from './session';

/** "Add files": the file dialog; resolves to the chosen files' source, or `null` when cancelled. */
export function usePickImportFiles() {
  return useCommandMutation(() => ipc.pickImportFiles());
}

/**
 * What adding the files of `source` (a choice token) to the folder `target` would do: counts,
 * size, what is left out and the name clashes. Asked again when what the target holds changes,
 * which keeps the clashes current. The check does not use up the token, `import_files` does: the
 * dialog that sends it passes `null` from then on, or closes, since asked again (as the import's
 * own CatalogChanged would have it) the check would answer `ChoiceExpired`.
 */
export function useImportCheck(source: string | null, target: EntryRef | null) {
  const libraryId = useLibraryId();
  const request = { source: source ?? '', target: target ?? NO_ENTRY };
  return useQuery(
    libraryQuery(
      source === null || target === null ? null : libraryId,
      (library) => keys.importCheck(library, request),
      () => unwrap(ipc.checkImport(request)),
    ),
  );
}

/**
 * Starts adding the files of a source to a folder, with the one clash policy the user chose for
 * all of them; resolves to the job's id. Fails with `ChoiceExpired` for a used or expired token.
 */
export function useImportFiles() {
  return useCommandMutation((request: ImportFiles) => ipc.importFiles(request), {
    entries: (request) => [request.target],
  });
}

/** Calls `onDrop` with every drop of files or folders on the window while mounted. */
export function useFilesDropped(onDrop: (drop: FilesDropped) => void): void {
  const handle = useEffectEvent(onDrop);
  useEffect(
    () =>
      shellEvents.onFilesDropped((drop) => {
        handle(drop);
      }),
    [],
  );
}

/** Where files are dragged over the window, in CSS pixels; `null` while none are. */
export function useDropHover(): Point | null {
  const [position, setPosition] = useState<Point | null>(null);
  useEffect(
    () =>
      shellEvents.onDropHover((hover) => {
        setPosition(hover.position);
      }),
    [],
  );
  return position;
}
