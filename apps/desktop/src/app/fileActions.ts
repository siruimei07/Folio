// What any view does to a file or folder of the library, with the same feedback everywhere
// (library-actions handoff §6, §9.3): open it with its default app, show it in File Explorer, and
// copy absolute paths. The Library's menus and preview, the Changes view's rows and its diff's
// "More" use them, and so can History's file rows. A course is named by its label in messages.
import i18n from 'i18next';

import { useOpenEntry, useRevealEntry } from '../data/files';
import { useCourses } from '../data/groups';
import { useLibrary } from '../data/library';
import type { EntryRef } from '../ipc';
import { displayName } from '../lib/courses';
import { windowsPath } from '../lib/paths';
import { copyText } from './clipboard';
import { showFailure, whenSettled } from './feedback';
import type { KeyCombo } from './shortcuts';
import { showToast } from './toasts';

/** Ctrl+Shift+C: "Copy path" (library-actions §6), wherever a view offers it. */
export const COPY_PATH_KEYS: KeyCombo = { key: 'C', ctrl: true, shift: true };

export interface FileActions {
  /**
   * "Open with default app"; a folder or course opens in File Explorer ("Open in File Explorer").
   * A script opens in its editor and says so; a program does not open, and the warning offers to
   * show it in File Explorer instead (§9.3).
   */
  open: (entry: EntryRef) => void;
  /** "Show in File Explorer": File Explorer with the entry selected. */
  showInExplorer: (entry: EntryRef) => void;
  /**
   * "Copy path": the absolute Windows paths of `paths` (below the library root), one per line, and
   * an information toast; a deleted file has a path but no entry.
   */
  copyPaths: (paths: readonly string[]) => void;
}

export function useFileActions(): FileActions {
  const library = useLibrary();
  const courses = useCourses().data ?? [];
  const openEntry = useOpenEntry();
  const revealEntry = useRevealEntry();
  const name = (entry: EntryRef) => displayName(entry, courses);

  const showInExplorer = (entry: EntryRef) => {
    whenSettled(
      revealEntry.mutateAsync({ entry }),
      'file.reveal',
      () => undefined,
      (failure) => {
        showFailure(i18n.t('shell:fileActions.revealFailed', { name: name(entry) }), failure.error, 'file.reveal');
      },
    );
  };

  const open = (entry: EntryRef) => {
    whenSettled(
      openEntry.mutateAsync({ entry }),
      'file.open',
      ({ mode }) => {
        if (mode !== 'editor') return;
        showToast({
          tone: 'info',
          title: i18n.t('shell:fileActions.editor', { name: name(entry) }),
          body: i18n.t('shell:fileActions.editorText'),
        });
      },
      (failure) => {
        if (failure.error.code !== 'Blocked') {
          showFailure(i18n.t('shell:fileActions.openFailed', { name: name(entry) }), failure.error, 'file.open');
          return;
        }
        showToast({
          tone: 'warning',
          title: i18n.t('shell:fileActions.blocked'),
          body: i18n.t('shell:fileActions.blockedText', { name: name(entry) }),
          actions: [
            {
              label: i18n.t('shell:fileActions.reveal'),
              onPress: () => {
                showInExplorer(entry);
              },
            },
          ],
        });
      },
    );
  };

  const copyPaths = (paths: readonly string[]) => {
    if (library === null || paths.length === 0) return;
    const text = paths.map((path) => windowsPath(library.root, path)).join('\n');
    void copyText(text).then((copied) => {
      showToast(
        copied
          ? { tone: 'info', title: i18n.t('shell:fileActions.copied', { count: paths.length }) }
          : { tone: 'danger', title: i18n.t('shell:fileActions.copyFailed') },
      );
    });
  };

  return { open, showInExplorer, copyPaths };
}
