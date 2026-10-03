// What the Library says after an action (library-actions handoff §9.3, §9.4): an error toast for a
// command with no place of its own, an information toast with the `NotFound` message when the
// item had moved or gone, and one warning toast for the failed items of a batch, whose "Details"
// lists every one of them (§5, UI architecture §13: nothing is dropped).
import i18n from 'i18next';

import { DETAILED, showFailure } from '../app/feedback';
import { reportUiError } from '../app/log';
import { showToast } from '../app/toasts';
import { copyErrorDetails } from '../app/windowErrors';
import type { ItemFailure } from '../ipc';
import type { FailureItem } from '../components/FailureList/FailureList';
import { openLibraryDialog } from './state';

// Shared with settings (app/feedback.tsx).
export { DETAILED, messageOf, showFailure, showGone, whenSettled } from '../app/feedback';

/** "Copy details" of a failure: what failed, then the error as the log has it. */
export const copyFailure = copyErrorDetails;

export interface BatchFeedback {
  /** Items asked for. */
  total: number;
  /** Every failed item (`BatchResult.failed`). */
  failed: readonly ItemFailure[];
  /** The toast when everything was done. */
  done: { tone: 'success' | 'info'; title: string };
  /** The title of the toast when the only item failed: "Couldn't delete ps2.pdf". */
  failedOne: string;
  /** The title when some failed: "Deleted 2 of 3 items". */
  partial: (done: number) => string;
  /** How a failed item is shown, and why it failed in words. */
  describe: (failure: ItemFailure) => FailureItem;
  source: string;
}

/** The toast after a batch command (library-actions §9.4). */
export function showBatchResult({ total, failed, done, failedOne, partial, describe, source }: BatchFeedback): void {
  if (failed.length === 0) {
    showToast({ tone: done.tone, title: done.title });
    return;
  }
  const [only] = failed;
  if (total === 1 && only !== undefined) {
    showFailure(failedOne, only.error, source, describe(only).reason);
    return;
  }
  const items = failed.map(describe);
  for (const failure of failed) if (DETAILED.has(failure.error.code)) reportUiError('command', source, failure.error);
  const title = partial(total - failed.length);
  showToast({
    tone: 'warning',
    title,
    actions: [
      {
        label: i18n.t('library:results.details'),
        onPress: () => {
          openLibraryDialog({ kind: 'failures', title, items });
        },
      },
    ],
  });
}
