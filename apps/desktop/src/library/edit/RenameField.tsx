import i18n from 'i18next';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useCreateFolder, useRenameEntry } from '../../data/entries';
import { useCourses } from '../../data/groups';
import type { AppError, EntryRef } from '../../ipc';
import { extensionOf } from '../../lib/file-types';
import { nameOf, parentOf } from '../../lib/paths';
import { messageOf, showGone, whenSettled } from '../feedback';
import { placeOf } from '../places';
import { refOf } from '../selecting';
import { openLibraryDialog, type Region, type Selected, setReveal, stopNewFolder, stopRename } from '../state';
import { NameField } from './NameField';

/** Where a failure is logged from. */
const RENAME_SOURCE = 'library.rename';
const NEW_FOLDER_SOURCE = 'library.newFolder';

/** The codes whose callout library-actions §7.1 words for renaming. */
const RENAME_CODES = [
  'NameInvalidCharacter',
  'NameTrailingDotOrSpace',
  'NameReserved',
  'NameTooLong',
  'PathTooLong',
  'NameEmpty',
  'AlreadyExists',
  'InUse',
  'ReadOnly',
  'AccessDenied',
  'NotFound',
] as const;

function isRenameCode(code: string): code is (typeof RENAME_CODES)[number] {
  return (RENAME_CODES as readonly string[]).includes(code);
}

/** The callout for a name the shell refused: the action's words, else the code's message. */
export function nameError(error: AppError | { code: 'Transport'; detail: string }, name: string, folder: string): string {
  return isRenameCode(error.code) ? i18n.t(`library:rename.errors.${error.code}`, { name, folder }) : messageOf(error);
}

/** Whether renaming `from` to `to` changes the extension, which asks first (§7.1). */
export function changesExtension(from: string, to: string): boolean {
  return extensionOf(from) !== extensionOf(to);
}

export interface RenameFieldProps {
  entry: Selected;
  region: Region;
  /** Puts focus back on the row, after Enter or Esc. */
  onDone: () => void;
}

/** Inline rename of a row or tile (library-actions handoff §7.1). */
export function RenameField({ entry, region, onDone }: RenameFieldProps) {
  const { t } = useTranslation('library');
  const rename = useRenameEntry();
  const courses = useCourses().data ?? [];
  const [error, setError] = useState<string | null>(null);
  const current = nameOf(entry.path);
  const finish = (refocus: boolean) => {
    stopRename();
    if (refocus) onDone();
  };

  return (
    <NameField
      initial={current}
      file={entry.kind === 'file'}
      label={t('rename.label', { name: current })}
      error={error}
      busy={rename.isPending}
      onCancel={() => {
        finish(true);
      }}
      onSubmit={(name, via) => {
        const refocus = via === 'enter';
        if (name === current) {
          finish(refocus);
          return;
        }
        if (entry.kind === 'file' && changesExtension(current, name)) {
          stopRename();
          openLibraryDialog({ kind: 'extension', entry, name, region });
          return;
        }
        setError(null);
        whenSettled(
          rename.mutateAsync({ entry, name }),
          RENAME_SOURCE,
          () => {
            finish(refocus);
          },
          (failure) => {
            if (failure.error.code === 'NotFound') {
              finish(refocus);
              showGone(failure.error);
              return;
            }
            setError(nameError(failure.error, name, placeOf(parentOf(entry.path), courses)));
          },
        );
      }}
    />
  );
}

export interface NewFolderFieldProps {
  parent: EntryRef;
  /** The names already in the parent, lower case, for "New folder (2)". */
  taken: () => ReadonlySet<string>;
  onDone: () => void;
}

/** The first free "New folder" name: "New folder", "New folder (2)", … (§7.2). */
export function freeFolderName(taken: ReadonlySet<string>): string {
  const base = i18n.t('library:rename.newFolder');
  if (!taken.has(base.toLowerCase())) return base;
  for (let number = 2; ; number++) {
    const name = i18n.t('library:rename.newFolderNumbered', { number });
    if (!taken.has(name.toLowerCase())) return name;
  }
}

/** The field of a new folder (§7.2): Enter creates it, Esc removes the row and creates nothing. */
export function NewFolderField({ parent, taken, onDone }: NewFolderFieldProps) {
  const { t } = useTranslation('library');
  const create = useCreateFolder();
  const courses = useCourses().data ?? [];
  const [error, setError] = useState<string | null>(null);
  const [initial] = useState(() => freeFolderName(taken()));
  const finish = (refocus: boolean) => {
    stopNewFolder();
    if (refocus) onDone();
  };

  return (
    <NameField
      initial={initial}
      file={false}
      label={t('tree.newFolder')}
      error={error}
      busy={create.isPending}
      onCancel={() => {
        finish(true);
      }}
      onSubmit={(name, via) => {
        setError(null);
        whenSettled(
          create.mutateAsync({ parent, name }),
          NEW_FOLDER_SOURCE,
          (row) => {
            stopNewFolder();
            // The new folder is selected and focused once the catalog lists it.
            setReveal(refOf(row));
          },
          (failure) => {
            if (failure.error.code === 'NotFound') {
              finish(via === 'enter');
              showGone(failure.error);
              return;
            }
            setError(nameError(failure.error, name, placeOf(parent.path, courses)));
          },
        );
      }}
    />
  );
}
