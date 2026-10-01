// What the Library does to entries (library-actions handoff §6, §7, §9): open, show in File
// Explorer, copy paths, delete, move and tag, each with its feedback; and the keys the tree, list
// and grid share (§6 "Library shortcuts", §12): F2, Del, Ctrl+Shift+N, Ctrl+Shift+C, Shift+F10 and
// the Menu key. None fires during IME composition; a dialog's keys never reach the collections.
import i18n from 'i18next';
import type { KeyboardEvent, MouseEvent } from 'react';

import { copyText } from '../app/clipboard';
import { showToast } from '../app/toasts';
import { useDeleteEntries, useMoveEntries } from '../data/entries';
import { useOpenEntry, useRevealEntry } from '../data/files';
import { useCourses } from '../data/groups';
import { useLibrary } from '../data/library';
import { useSetEntryTags } from '../data/tags';
import type { Course, EntryRef } from '../ipc';
import { courseLabel } from '../lib/courses';
import { nameOf, windowsPath } from '../lib/paths';
import { messageOf, showBatchResult, showFailure, whenSettled } from './feedback';
import { placeOf } from './places';
import type { SelectableRows } from './selecting';
import {
  openLibraryDialog,
  openMenu,
  type Region,
  type Selected,
  selectOnly,
  startNewFolder,
  startRename,
  useLibraryView,
} from './state';

/** The name of an entry in messages: a course's label, else its name. */
export function displayName(entry: EntryRef, courses: readonly Course[]): string {
  const course = courses.find((candidate) => candidate.folder.id === entry.id);
  return course === undefined ? nameOf(entry.path) : courseLabel(course);
}

/** The codes whose reason library-actions §9.4 words for deleting. */
const DELETE_REASONS = ['InUse', 'NotFound', 'NotRecyclable'] as const;

function isDeleteReason(code: string): code is (typeof DELETE_REASONS)[number] {
  return (DELETE_REASONS as readonly string[]).includes(code);
}

export function useLibraryCommands() {
  const library = useLibrary();
  const courses = useCourses().data ?? [];
  const openEntry = useOpenEntry();
  const revealEntry = useRevealEntry();
  const deleteNow = useDeleteNow();
  const moveEntries = useMoveEntries();
  const setEntryTags = useSetEntryTags();
  const name = (entry: EntryRef) => displayName(entry, courses);
  const place = (path: string) => placeOf(path, courses);

  const showInExplorer = (entry: EntryRef) => {
    whenSettled(
      revealEntry.mutateAsync({ entry }),
      'library.reveal',
      () => undefined,
      (failure) => {
        showFailure(i18n.t('library:open.revealFailed', { name: name(entry) }), failure.error, 'library.reveal');
      },
    );
  };

  return {
    /** "Open with default app"; a folder or course opens in File Explorer. */
    open: (entry: EntryRef) => {
      whenSettled(
        openEntry.mutateAsync({ entry }),
        'library.open',
        ({ mode }) => {
          if (mode === 'editor') {
            showToast({
              tone: 'info',
              title: i18n.t('library:open.editor', { name: name(entry) }),
              body: i18n.t('library:open.editorText'),
            });
          }
        },
        (failure) => {
          if (failure.error.code === 'Blocked') {
            showToast({
              tone: 'warning',
              title: i18n.t('library:open.blocked'),
              body: i18n.t('library:open.blockedText', { name: name(entry) }),
              actions: [
                {
                  label: i18n.t('library:menu.reveal'),
                  onPress: () => {
                    showInExplorer(entry);
                  },
                },
              ],
            });
          } else {
            showFailure(i18n.t('library:open.failed', { name: name(entry) }), failure.error, 'library.open');
          }
        },
      );
    },

    showInExplorer,

    /** The absolute Windows paths, one per line (library-actions §6). */
    copyPaths: (entries: readonly EntryRef[]) => {
      if (library === null || entries.length === 0) return;
      const text = entries.map((entry) => windowsPath(library.root, entry.path)).join('\n');
      void copyText(text).then((copied) => {
        showToast(
          copied
            ? {
                tone: 'info',
                title:
                  entries.length === 1
                    ? i18n.t('library:copy.one')
                    : i18n.t('library:copy.several', { count: entries.length }),
              }
            : { tone: 'danger', title: i18n.t('library:copy.failed') },
        );
      });
    },

    /** Files and folders go to the Recycle Bin at once; a course asks first (§7.4). */
    remove: (entries: readonly Selected[]) => {
      if (entries.length === 0) return;
      const [only] = entries;
      if (entries.length === 1 && only?.kind === 'course') {
        openLibraryDialog({ kind: 'deleteCourse', course: only });
      } else if (entries.some((entry) => entry.kind === 'course')) {
        openLibraryDialog({ kind: 'deleteItems', entries });
      } else {
        deleteNow(entries);
      }
    },

    /** Moves entries into a course or folder (§7.3). */
    move: (entries: readonly EntryRef[], to: EntryRef) => {
      const [only] = entries;
      const failedOne = i18n.t('library:move.failedOne', { name: only === undefined ? '' : name(only) });
      whenSettled(
        moveEntries.mutateAsync({ entries: [...entries], to }),
        'library.move',
        (result) => {
          showBatchResult({
            total: entries.length,
            failed: result.failed,
            done: {
              tone: 'success',
              title:
                entries.length === 1 && only !== undefined
                  ? i18n.t('library:move.done', { name: name(only), place: place(to.path) })
                  : i18n.t('library:move.doneSeveral', { count: entries.length, place: place(to.path) }),
            },
            failedOne,
            partial: (done) => i18n.t('library:move.partial', { done, total: entries.length }),
            describe: (failure) => ({
              place: place(failure.entry.path),
              reason:
                failure.error.code === 'InvalidMove' ? i18n.t('library:move.invalid') : messageOf(failure.error),
            }),
            source: 'library.move',
          });
        },
        (failure) => {
          // The whole request failed (a target that is gone, a rebuild): name what was moved.
          showFailure(
            entries.length === 1 ? failedOne : i18n.t('library:move.failedSeveral', { count: entries.length }),
            failure.error,
            'library.move',
          );
        },
      );
    },

    /** Adds and removes tags on every entry (§6, Tags ▸). */
    setTags: (entries: readonly EntryRef[], add: readonly string[], remove: readonly string[]) => {
      const [only] = entries;
      const failedOne = i18n.t('library:tags.failedOne', { name: only === undefined ? '' : name(only) });
      whenSettled(
        setEntryTags.mutateAsync({ entries: [...entries], add: [...add], remove: [...remove] }),
        'library.tags',
        (result) => {
          if (result.failed.length === 0) return;
          showBatchResult({
            total: entries.length,
            failed: result.failed,
            done: { tone: 'success', title: '' },
            failedOne,
            partial: (done) => i18n.t('library:tags.partial', { done, total: entries.length }),
            describe: (failure) => ({ place: place(failure.entry.path), reason: messageOf(failure.error) }),
            source: 'library.tags',
          });
        },
        (failure) => {
          showFailure(failedOne, failure.error, 'library.tags');
        },
      );
    },
  };
}

/** Deletes without asking: what the confirmation dialogs call once they have closed. */
export function useDeleteNow() {
  const courses = useCourses().data ?? [];
  const deleteEntries = useDeleteEntries();
  return (entries: readonly EntryRef[]) => {
    const [only] = entries;
    const name = only === undefined ? '' : displayName(only, courses);
    const failedOne = i18n.t('library:delete.failedOne', { name });
    whenSettled(
      deleteEntries.mutateAsync({ entries: [...entries] }),
      'library.delete',
      (result) => {
        showBatchResult({
          total: entries.length,
          failed: result.failed,
          done: {
            tone: 'info',
            title:
              entries.length === 1
                ? i18n.t('library:delete.done', { name })
                : i18n.t('library:delete.doneSeveral', { count: entries.length }),
          },
          failedOne,
          partial: (done) => i18n.t('library:delete.partial', { done, total: entries.length }),
          describe: (failure) => ({
            place: placeOf(failure.entry.path, courses),
            reason: isDeleteReason(failure.error.code)
              ? i18n.t(`library:delete.reasons.${failure.error.code}`)
              : messageOf(failure.error),
          }),
          source: 'library.delete',
        });
      },
      (failure) => {
        showFailure(
          entries.length === 1 ? failedOne : i18n.t('library:delete.failedSeveral', { count: entries.length }),
          failure.error,
          'library.delete',
        );
      },
    );
  };
}

/** The entries an action applies to: the selection, else the focused row's entry. */
export function targetsOf(region: Region, rows: SelectableRows): Selected[] {
  const selection = useLibraryView.getState()[region];
  if (selection.entries.size > 0) return [...selection.entries.values()];
  const index = selection.focus === null ? null : rows.indexOfKey(selection.focus.key);
  const entry = index === null ? null : rows.entryAt(index);
  return entry === null ? [] : [entry];
}

/** Where a menu opened from the keyboard goes: under the focused row's name (library-actions §2.7). */
function anchorUnder(row: Element | null): { x: number; y: number } {
  const target = row?.querySelector('[data-menu-anchor]') ?? row;
  const box = target?.getBoundingClientRect();
  return box === undefined ? { x: 0, y: 0 } : { x: box.left, y: box.bottom };
}

export interface EntryKeys {
  onKeyDown: (event: KeyboardEvent<HTMLElement>, index: number | null) => void;
  contextMenu: (index: number, event: MouseEvent) => void;
  backgroundMenu: (event: MouseEvent) => void;
  openFile: (entry: EntryRef) => void;
}

/**
 * The shortcuts and menus of a collection (library-actions §6, §12). `folderAt` names the course
 * or folder a new folder goes into from a row: the row itself, or the folder it is in.
 */
export function useEntryKeys(
  region: Region,
  rows: SelectableRows,
  folderAt: (index: number) => EntryRef | null = () => null,
): EntryKeys {
  const commands = useLibraryCommands();

  const renameTarget = (index: number): Selected | null => {
    const targets = targetsOf(region, rows);
    const [only] = targets;
    if (targets.length === 1 && only !== undefined) return only;
    return rows.entryAt(index);
  };

  const menuAt = (anchor: { x: number; y: number }, keyboard: boolean) => {
    const targets = targetsOf(region, rows).map((entry) => ({
      ...entry,
      ...(rows.tagsOf(entry.id) ?? { tags: [], folderTags: [] }),
    }));
    openMenu({ anchor, region, targets, keyboard });
  };

  return {
    onKeyDown: (event, index) => {
      if (index === null || event.nativeEvent.isComposing) return;
      const { key, ctrlKey, shiftKey, altKey, metaKey } = event;
      const plain = !ctrlKey && !shiftKey && !altKey && !metaKey;
      const ctrlShift = ctrlKey && shiftKey && !altKey && !metaKey;
      if (key === 'F2' && plain) {
        const target = renameTarget(index);
        if (target === null) return;
        startRename(target.id, region);
      } else if (key === 'Delete' && plain) {
        commands.remove(targetsOf(region, rows));
      } else if (ctrlShift && key.toLowerCase() === 'n') {
        const folder = folderAt(index);
        if (folder === null) return;
        startNewFolder(folder);
      } else if (ctrlShift && key.toLowerCase() === 'c') {
        commands.copyPaths(targetsOf(region, rows));
      } else if ((key === 'F10' && shiftKey && !ctrlKey && !altKey) || key === 'ContextMenu') {
        if (rows.entryAt(index) === null) return;
        const row = event.target instanceof Element ? event.target.closest('[data-index]') : null;
        menuAt(anchorUnder(row), true);
      } else {
        return;
      }
      event.preventDefault();
    },

    contextMenu: (index, event) => {
      event.preventDefault();
      // Shift+F10 and the Menu key open the menu on keydown, and the browser then fires
      // `contextmenu` on the focused row too: while that menu is open, this is its echo. A
      // right-click elsewhere closes it first (on pointer up), so it still opens a menu.
      if (useLibraryView.getState().menu?.keyboard === true) return;
      const entry = rows.entryAt(index);
      // Quick views, separators and placeholders have no menu (§6).
      if (entry === null) return;
      if (!useLibraryView.getState()[region].entries.has(entry.id)) selectOnly(region, rows.keyAt(index), index, entry);
      menuAt({ x: event.clientX, y: event.clientY }, false);
    },

    backgroundMenu: (event) => {
      event.preventDefault();
      openMenu({ anchor: { x: event.clientX, y: event.clientY }, region, targets: [], keyboard: false });
    },

    openFile: (entry) => {
      commands.open(entry);
    },
  };

}
