// Choosing a folder and opening what it holds (first-run handoff §3, §4, §7). Every way in (the
// welcome cards and link, "Change…", "Choose another folder…", the unavailable screen's "Locate
// library…" and "Start a new library") goes through here.
import i18n from 'i18next';

import { reportUiError } from '../app/log';
import { showToast } from '../app/toasts';
import { copyErrorDetails } from '../app/windowErrors';
import { IpcFailure } from '../data/errors';
import { useLibraryStatus, useOpenLibrary, usePickLibraryFolder } from '../data/library';
import { useSession } from '../data/session';
import type { FolderChoice, IpcError } from '../ipc';
import { LIBRARY_EVENT_WAIT_MS } from '../lib/timing';
import { endFlow, type Intent, showFolder } from './state';

/**
 * The folder dialog: resolves to the choice, or `null` when the user cancelled it or it failed.
 * A failure is a bug or a broken Windows dialog: an error toast with "Copy details", and the log.
 */
export function usePickFolder(): { pick: () => Promise<FolderChoice | null>; picking: boolean } {
  const mutation = usePickLibraryFolder();
  const pick = async () => {
    try {
      return await mutation.mutateAsync();
    } catch (error: unknown) {
      if (!(error instanceof IpcFailure)) throw error;
      reportUiError('command', 'first-run.pickFolder', error.error);
      const title = i18n.t('first-run:pickFailed');
      showToast({
        tone: 'danger',
        title,
        body: i18n.t(`errors:${error.error.code}`),
        actions: [
          {
            label: i18n.t('shell:copyDetails.action'),
            onPress: () => {
              copyErrorDetails(title, error.error);
            },
          },
        ],
      });
      return null;
    }
  };
  return { pick, picking: mutation.isPending };
}

/**
 * Resolves once the cache has library `id` open. LibraryStateChanged brings it, usually before the
 * command's answer; when it is late, the status is asked instead. Asking at once would make the
 * event, when it comes, drop the queries the next page has started.
 */
export function useAwaitStatus(): (id: string) => Promise<void> {
  const status = useLibraryStatus();
  return async (id) => {
    if (useSession.getState().libraryId === id) return;
    const arrived = await new Promise<boolean>((resolve) => {
      const late = setTimeout(() => {
        stop();
        resolve(false);
      }, LIBRARY_EVENT_WAIT_MS);
      const stop = useSession.subscribe(({ libraryId }) => {
        if (libraryId !== id) return;
        clearTimeout(late);
        stop();
        resolve(true);
      });
    });
    if (!arrived) await status.refetch();
  };
}

/**
 * `open_library` for a folder that holds a library. Once it is open the first run ends, and the
 * window shows the Library. Resolves to the error, or `null` once it opened.
 */
export function useOpenChosen() {
  const mutation = useOpenLibrary();
  const awaitStatus = useAwaitStatus();
  const open = async (choice: FolderChoice): Promise<IpcError | null> => {
    try {
      const opened = await mutation.mutateAsync({ folder: choice.token });
      await awaitStatus(opened.library.id);
    } catch (error: unknown) {
      if (!(error instanceof IpcFailure)) throw error;
      return error.error;
    }
    endFlow();
    return null;
  };
  return { open, opening: mutation.isPending };
}

/**
 * The folder dialog, then step 1 for the folder it answers with (§3). After "Open your library…"
 * a folder that holds a library opens at once, without step 1; if that fails, step 1 shows the
 * error. Cancelling keeps the page, and focus goes back to what opened the dialog.
 */
export function useChooseFolder() {
  const { pick, picking } = usePickFolder();
  const { open, opening } = useOpenChosen();
  const busy = picking || opening;
  const choose = async (intent: Intent) => {
    if (busy) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const choice = await pick();
    if (choice === null) {
      opener?.focus();
      return;
    }
    if (intent === 'open' && choice.content.kind === 'library') {
      const error = await open(choice);
      if (error !== null) showFolder(choice, intent, error);
      return;
    }
    showFolder(choice, intent);
  };
  return { choose, busy };
}
