// "Add files" (library-actions handoff §4, §6): the file dialog, then the import dialog of
// `feat/ui-import` with the folder as the target. Until that dialog is registered, nothing in the
// Library offers it (`useCanOpenDialog('import')`).
import i18n from 'i18next';

import { openDialog, useCanOpenDialog } from '../app/navigation';
import { usePickImportFiles } from '../data/import';
import type { EntryRef } from '../ipc';
import { showFailure, whenSettled } from './feedback';

/** Adds files to `target`, or `null` while there is no folder to add to; `null` when it cannot. */
export function useAddFiles(): ((target: EntryRef | null) => void) | null {
  const canImport = useCanOpenDialog('import');
  const pick = usePickImportFiles();
  if (!canImport) return null;
  return (target) => {
    whenSettled(
      pick.mutateAsync(),
      'library.addFiles',
      (source) => {
        // `null`: the dialog was cancelled, and nothing opens.
        if (source !== null) openDialog('import', { source, target });
      },
      (failure) => {
        showFailure(i18n.t('library:menu.addFilesFailed'), failure.error, 'library.addFiles');
      },
    );
  };
}
