// History's commands on a commit, offered by History's entries and the Changes view's "Not synced"
// card alike (workspace-history handoff §5, §7.3, §9; ipc-m2 §8.1, §8.4): which a commit takes now
// and why not, "Edit message" (the dialog History registers as `editMessage`), "Undo commit" with
// its toasts, and "Copy commit ID". Features never import each other, so both views reach them
// here; the words are History's (`history` namespace).
import i18n from 'i18next';
import { useCallback } from 'react';

import { readCommitNow, useUncommit } from '../data/history';
import { type CommitInfo, type HistoryState, type IpcError, shortId } from '../ipc';
import { showChange } from './changeTarget';
import { copyText } from './clipboard';
import { showFailure, whenSettled } from './feedback';
import { openDialog, useCanShowView, useNavigation } from './navigation';
import { showToast } from './toasts';

/** A history a newer Folio wrote, or one Folio cannot read, takes no action on commits (§7.5). */
type StateRefusal = 'readOnly' | 'damaged';

/** Why "Edit message" is refused: a prune commit (B3), in M3 a synced commit, or the history's state. */
export type RewordRefusal = 'prune' | 'synced' | StateRefusal;

/** Why "Undo commit" is refused: also the first commit, and every commit but the newest. */
export type UncommitRefusal = 'prune' | 'synced' | 'first' | 'notHead' | StateRefusal;

function stateRefusal(state: HistoryState | undefined): StateRefusal | null {
  if (state === 'readOnly') return 'readOnly';
  if (state === 'damaged') return 'damaged';
  return null;
}

/**
 * Why "Edit message" is refused for `commit`, `null` when it is offered (ipc-m2 §8.1: commits and
 * imports, the first commit included, never a prune commit or a synced one). The commit's own
 * reason comes before the history's.
 */
export function rewordRefusal(commit: CommitInfo, state: HistoryState | undefined): RewordRefusal | null {
  if (commit.kind === 'prune') return 'prune';
  if (commit.synced) return 'synced';
  return stateRefusal(state);
}

/**
 * Why "Undo commit" is refused for `commit`, `null` when it is offered (ipc-m2 §8.1: the newest
 * commit of kind commit or import, never the first, never a synced one).
 */
export function uncommitRefusal(commit: CommitInfo, state: HistoryState | undefined): UncommitRefusal | null {
  if (commit.kind === 'prune') return 'prune';
  if (commit.synced) return 'synced';
  if (commit.first) return 'first';
  if (!commit.head) return 'notHead';
  return stateRefusal(state);
}

/**
 * Whether a refusal is the commit's own, so its hover button is not shown at all (§5, §7.3: "Undo
 * commit" only on the newest commit); a refusal of the history's state keeps it, disabled with the
 * reason.
 */
export function hidesButton(refusal: RewordRefusal | UncommitRefusal | null): boolean {
  return refusal !== null && refusal !== 'readOnly' && refusal !== 'damaged';
}

/** Why "Edit message" is refused, in words: a disabled menu item's note, a disabled button's tooltip. */
export function rewordRefusalText(refusal: RewordRefusal): string {
  return i18n.t(`history:actions.refused.reword.${refusal}`);
}

/** Why "Undo commit" is refused, in words (§7.3: "Only the newest commit can be undone."). */
export function uncommitRefusalText(refusal: UncommitRefusal): string {
  return i18n.t(`history:actions.refused.uncommit.${refusal}`);
}

/**
 * Why "Edit message" is refused, as a menu item's note: a few words, since a long note squeezes the
 * item's label in the 320 px menu (lane notes, step 2); the note is also its description.
 */
export function rewordRefusalNote(refusal: RewordRefusal): string {
  return i18n.t(`history:actions.notes.reword.${refusal}`);
}

/** Why "Undo commit" is refused, as a menu item's note ("Not the newest"). */
export function uncommitRefusalNote(refusal: UncommitRefusal): string {
  return i18n.t(`history:actions.notes.uncommit.${refusal}`);
}

/** "Edit message": the dialog History registers (§9.1). */
export function editMessage(commit: CommitInfo): void {
  openDialog('editMessage', { commit });
}

/**
 * "Edit message" of a commit known only by its id (the toast after a commit fell back to the
 * template, §4.3): the commit is read, then the dialog opens on it; a commit an edit or an undo
 * replaced meanwhile says it is gone (`NotFound`), any other failure says it could not open.
 */
export function editMessageOf(id: string): void {
  whenSettled(readCommitNow(id), 'history.editMessage', editMessage, (failure) => {
    showFailure(i18n.t('history:editMessage.openFailed'), failure.error, 'history.editMessage');
  });
}

/** A commit's summary as the toasts quote it; a prune commit has none. */
function summaryOf(commit: CommitInfo): string {
  return commit.summary ?? i18n.t('history:entry.noMessage');
}

/** Why the undo failed, as §9.2 words it, else the code's message. */
function undoFailureText(error: IpcError): string {
  if (error.code === 'NotHead') return i18n.t('history:undo.reasons.NotHead');
  if (error.code === 'CannotUncommit') return i18n.t('history:undo.reasons.CannotUncommit');
  return i18n.t(`errors:${error.code}`);
}

/** The commits being undone: a second press before the answer sends nothing. */
const undoing = new Set<string>();

/**
 * "Undo commit" (§9.2): no confirmation, since nothing is lost: the commit's changes return to the
 * workspace. Done: the information toast "Undid “…”" / "Its 3 changes are back in Changes." with
 * "Show in Changes" while that view is on the rail and not the one showing. Failed: an error toast with the reason; a
 * `NotHead` (something else moved HEAD) has refreshed the history already (`data/mutations.ts`).
 * A press while the same commit is being undone does nothing (it would only answer `NotHead`).
 */
export function useUndoCommit(): (commit: CommitInfo) => void {
  const { mutateAsync } = useUncommit();
  const changesShown = useCanShowView('changes');
  return useCallback(
    (commit: CommitInfo) => {
      if (undoing.has(commit.id)) return;
      undoing.add(commit.id);
      const summary = summaryOf(commit);
      const settled = mutateAsync({ commit: commit.id }).finally(() => {
        undoing.delete(commit.id);
      });
      whenSettled(
        settled,
        'history.uncommit',
        () => {
          // From the Changes view itself ("Not synced"), the changes are already in sight.
          const offerChanges = changesShown && useNavigation.getState().view !== 'changes';
          showToast({
            tone: 'info',
            title: i18n.t('history:undo.done', { summary }),
            body: i18n.t('history:undo.doneText', { count: commit.files + commit.folders + commit.metadata }),
            actions: offerChanges
              ? [
                  {
                    label: i18n.t('history:undo.showInChanges'),
                    onPress: () => {
                      showChange();
                    },
                  },
                ]
              : undefined,
          });
        },
        (failure) => {
          showFailure(i18n.t('history:undo.failed'), failure.error, 'history.uncommit', undoFailureText(failure.error));
        },
      );
    },
    [mutateAsync, changesShown],
  );
}

/** "Copy commit ID": the commit's whole id, and a toast that says so (or that it failed). */
export function copyCommitId(commit: CommitInfo): void {
  void copyText(commit.id).then((copied) => {
    showToast(
      copied
        ? { tone: 'info', title: i18n.t('history:actions.copiedId', { id: shortId(commit.id) }) }
        : { tone: 'danger', title: i18n.t('history:actions.copyIdFailed') },
    );
  });
}
