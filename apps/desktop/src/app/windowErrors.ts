// Failed window commands (library-actions handoff §9.5): each shows an error toast with "Copy
// details", replacing an earlier toast for the same command, and goes to the log. Failures in the
// background (maximized state, snap layouts overlay) show once per session.

import i18n from 'i18next';

import { formatIpcError, setWindowFailureHandler, type WindowFailure } from '../ipc';
import { copyText } from './clipboard';
import { reportUiError } from './log';
import { showToast } from './toasts';

let backgroundShown = false;

/** Copies `details` and says so; a failed copy gets its own toast. */
export function copyDetails(details: string): void {
  void copyText(details).then((copied) => {
    showToast(
      copied
        ? { key: 'copyDetails', tone: 'info', title: i18n.t('shell:copyDetails.copied') }
        : { key: 'copyDetails', tone: 'danger', title: i18n.t('shell:copyDetails.failed') },
    );
  });
}

export function showWindowFailure({ command, source, error }: WindowFailure): void {
  reportUiError('command', source, error);
  if (command === 'background') {
    if (backgroundShown) return;
    backgroundShown = true;
  }
  const title = i18n.t(`shell:windowErrors.${command}.title`);
  showToast({
    key: `window.${command}`,
    tone: 'danger',
    title,
    body: i18n.t(`shell:windowErrors.${command}.text`),
    actions: [
      {
        label: i18n.t('shell:copyDetails.action'),
        onPress: () => {
          copyDetails([title, source, formatIpcError(error)].join('\n'));
        },
      },
    ],
  });
}

/** Routes window command failures to toasts and the log until the returned function runs. */
export function installWindowFailureToasts(): () => void {
  const previous = setWindowFailureHandler(showWindowFailure);
  return () => {
    setWindowFailureHandler(previous);
  };
}

/** For tests: the background toast shows again. */
export function resetWindowFailures(): void {
  backgroundShown = false;
}
