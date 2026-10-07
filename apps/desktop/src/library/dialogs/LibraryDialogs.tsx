import './Dialogs.css';

import i18n from 'i18next';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { showToast } from '../../app/toasts';
import { copyDetails } from '../../app/windowErrors';
import { Button } from '../../components/Button/Button';
import { DialogFrame } from '../../components/Dialog/Dialog';
import { failureDetails } from '../../components/FailureList/details';
import { FailureList } from '../../components/FailureList/FailureList';
import { useRenameEntry } from '../../data/entries';
import { useCourses, useSemesters } from '../../data/groups';
import { useCount } from '../../data/paged';
import type { EntryRef } from '../../ipc';
import { writtenExtensionOf } from '../../lib/file-types';
import { nameOf, parentOf } from '../../lib/paths';
import { displayName, useDeleteNow, useLibraryCommands } from '../commands';
import { nameError } from '../edit/RenameField';
import { whenSettled } from '../feedback';
import { NO_FILTER } from '../filters';
import { FolderPicker } from '../move/FolderPicker';
import { placeOf } from '../places';
import { closeLibraryDialog, type LibraryDialog, startRename, useLibraryView } from '../state';


function useDialogOpen<K extends LibraryDialog['kind']>(kind: K) {
  const dialog = useLibraryView((state) => state.dialog);
  // The last request of this kind stays while the dialog plays its closing animation.
  const [last, setLast] = useState<Extract<LibraryDialog, { kind: K }> | null>(null);
  if (dialog?.kind === kind && dialog !== last) setLast(dialog as Extract<LibraryDialog, { kind: K }>);
  return { isOpen: dialog?.kind === kind, request: dialog?.kind === kind ? (dialog as Extract<LibraryDialog, { kind: K }>) : last };
}

const close = (open: boolean) => {
  if (!open) closeLibraryDialog();
};

/** "Move to…" (library-actions §7.3): the folder picker, then "Move here". */
function MoveDialog() {
  const { t } = useTranslation('library');
  const { isOpen, request } = useDialogOpen('move');
  const commands = useLibraryCommands();
  const courses = useCourses().data ?? [];
  const [chosen, setChosen] = useState<EntryRef | null>(null);
  if (request === null) return null;
  const { entries } = request;
  const [only] = entries;
  const startPath = only === undefined ? '' : only.path.split('/')[0] ?? '';
  return (
    <DialogFrame
      isOpen={isOpen}
      placement="form"
      onOpenChange={(open) => {
        if (!open) setChosen(null);
        close(open);
      }}
      title={
        entries.length === 1 && only !== undefined
          ? t('move.title', { name: nameOf(only.path) })
          : t('move.titleSeveral', { count: entries.length })
      }
      footer={
        <>
          <Button
            size="dialog"
            onPress={() => {
              setChosen(null);
              closeLibraryDialog();
            }}
          >
            {t('move.cancel')}
          </Button>
          <Button
            size="dialog"
            variant="accent"
            isDisabled={chosen === null}
            onPress={() => {
              if (chosen === null) return;
              commands.move(entries, chosen);
              setChosen(null);
              closeLibraryDialog();
            }}
          >
            {t('move.confirm')}
          </Button>
        </>
      }
    >
      <FolderPicker key={entries.map((entry) => entry.id).join(',')} semester={startPath} moving={entries} chosen={chosen} onChoose={setChosen} />
      {chosen !== null && <p className="visually-hidden" aria-live="polite">{placeOf(chosen.path, courses)}</p>}
    </DialogFrame>
  );
}

interface DeleteFrameProps {
  isOpen: boolean;
  title: string;
  text: string;
  /** What stays in Folio. */
  kept: string;
  confirm: string;
  targets: readonly EntryRef[];
}

/**
 * The confirmation of a delete that asks first (§7.4), Cancel focused. It closes at once, as Move
 * does, and the toast says how the delete went.
 */
function DeleteFrame({ isOpen, title, text, kept, confirm, targets }: DeleteFrameProps) {
  const { t } = useTranslation('library');
  const deleteNow = useDeleteNow();
  return (
    <DialogFrame
      isOpen={isOpen}
      onOpenChange={close}
      title={title}
      footer={
        <>
          <Button size="dialog" autoFocus onPress={closeLibraryDialog}>
            {t('delete.cancel')}
          </Button>
          <Button
            size="dialog"
            variant="danger"
            onPress={() => {
              closeLibraryDialog();
              deleteNow(targets);
            }}
          >
            {confirm}
          </Button>
        </>
      }
    >
      <p className="dialog-text">{text}</p>
      <p className="dialog-text dialog-text--secondary">{kept}</p>
    </DialogFrame>
  );
}

/** "Delete MAT232?" (§7.4): a course goes to the Recycle Bin only after this. */
function DeleteCourseDialog() {
  const { t } = useTranslation('library');
  const { isOpen, request } = useDialogOpen('deleteCourse');
  const courses = useCourses().data ?? [];
  if (request === null) return null;
  const course = courses.find((candidate) => candidate.folder.id === request.course.id);
  return (
    <DeleteFrame
      isOpen={isOpen}
      title={t('delete.course.title', { name: displayName(request.course, courses) })}
      text={t('delete.course.text', { folder: nameOf(request.course.path), count: course?.files ?? 0 })}
      kept={t('delete.course.kept')}
      confirm={t('delete.course.confirm')}
      targets={[request.course]}
    />
  );
}

/** "Delete Fall 2026?" (§7.4), from the semester menu. */
function DeleteSemesterDialog() {
  const { t } = useTranslation('library');
  const { isOpen, request } = useDialogOpen('deleteSemester');
  const semesters = useSemesters().data ?? [];
  const courses = useCourses(request?.semester.path ?? null).data ?? [];
  const files = useCount({ of: 'files', scope: request?.semester ?? null, filter: NO_FILTER });
  if (request === null) return null;
  const name = semesters.find((candidate) => candidate.folder.id === request.semester.id)?.name ?? nameOf(request.semester.path);
  return (
    <DeleteFrame
      isOpen={isOpen}
      title={t('delete.semester.title', { name })}
      text={t('delete.semester.text', {
        courses: t('delete.semester.courses', { count: courses.length }),
        count: files.data ?? 0,
      })}
      kept={t('delete.semester.kept')}
      confirm={t('delete.semester.confirm')}
      targets={[request.semester]}
    />
  );
}

/** Deleting a selection with a course in it asks first, as a course does (§6, §7.4). */
function DeleteItemsDialog() {
  const { t } = useTranslation('library');
  const { isOpen, request } = useDialogOpen('deleteItems');
  if (request === null) return null;
  return (
    <DeleteFrame
      isOpen={isOpen}
      title={t('delete.items.title', { count: request.entries.length })}
      text={t('delete.items.text')}
      kept={t('delete.items.kept')}
      confirm={t('delete.items.confirm')}
      targets={request.entries}
    />
  );
}

/** "Change the extension to .txt?" (§7.1): "Keep .pdf" keeps the old extension on the new name. */
function ExtensionDialog() {
  const { t } = useTranslation('library');
  const { isOpen, request } = useDialogOpen('extension');
  const rename = useRenameEntry();
  const courses = useCourses().data ?? [];
  if (request === null) return null;
  const current = nameOf(request.entry.path);
  // As written, so "Keep .PDF" keeps its case; a name that ends in a dot has no extension, and
  // keeping the old one replaces the dot ("ps2." → "ps2.pdf").
  const previous = writtenExtensionOf(current);
  const next = writtenExtensionOf(request.name);
  const base = next === '' ? request.name.replace(/\.+$/, '') : request.name.slice(0, -(next.length + 1));
  const send = (name: string) => {
    closeLibraryDialog();
    if (name === current) return;
    whenSettled(
      rename.mutateAsync({ entry: request.entry, name }),
      'library.rename',
      () => undefined,
      (failure) => {
        // The name field opens again, so the name can be fixed.
        showToast({
          tone: 'danger',
          title: i18n.t('library:rename.failed', { name: current }),
          body: nameError(failure.error, name, placeOf(parentOf(request.entry.path), courses)),
        });
        startRename(request.entry.id, request.region);
      },
    );
  };
  return (
    <DialogFrame
      isOpen={isOpen}
      onOpenChange={close}
      title={next === '' ? t('rename.extension.titleRemove', { previous }) : t('rename.extension.title', { extension: next })}
      footer={
        <>
          <Button
            size="dialog"
            autoFocus
            onPress={() => {
              send(previous === '' ? base : `${base}.${previous}`);
            }}
          >
            {t('rename.extension.keep', { previous })}
          </Button>
          <Button
            size="dialog"
            variant="accent"
            onPress={() => {
              send(request.name);
            }}
          >
            {t('rename.extension.change')}
          </Button>
        </>
      }
    >
      <p className="dialog-text">{t('rename.extension.text', { name: current })}</p>
    </DialogFrame>
  );
}

/** The items a batch could not change, every one with why (§5 "Details", UI architecture §13). */
function FailuresDialog() {
  const { t } = useTranslation('library');
  const { isOpen, request } = useDialogOpen('failures');
  if (request === null) return null;
  return (
    <DialogFrame
      isOpen={isOpen}
      onOpenChange={close}
      size="medium"
      title={t('results.title', { count: request.items.length })}
      footer={
        <>
          <Button
            size="dialog"
            onPress={() => {
              copyDetails(failureDetails(request.title, request.items));
            }}
          >
            {t('results.copy')}
          </Button>
          <Button size="dialog" variant="accent" autoFocus onPress={closeLibraryDialog}>
            {t('results.close')}
          </Button>
        </>
      }
    >
      <FailureList label={t('results.list')} items={request.items} />
    </DialogFrame>
  );
}

/** The dialogs the Library view opens itself (library-actions handoff §5, §7). */
export function LibraryDialogs() {
  return (
    <>
      <MoveDialog />
      <DeleteCourseDialog />
      <DeleteSemesterDialog />
      <DeleteItemsDialog />
      <ExtensionDialog />
      <FailuresDialog />
    </>
  );
}
