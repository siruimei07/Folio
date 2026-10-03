// What a view says when a command or a read fails (library-actions handoff §9.4, §9.6), shared by
// the Library and settings: an error toast for a command with no place of its own, an information
// toast with the `NotFound` message when the item had moved or gone, and the state block of a
// region whose data failed to load. Codes that point at a bug offer "Copy details" and go to the
// log.
import { useQueryClient } from '@tanstack/react-query';
import i18n from 'i18next';
import { CircleX, RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Button } from '../components/Button/Button';
import { StateBlock } from '../components/StateBlock/StateBlock';
import { IpcFailure } from '../data/errors';
import type { IpcError } from '../ipc';
import { reportUiError } from './log';
import { showToast } from './toasts';
import { copyErrorDetails } from './windowErrors';

/**
 * Gives a command's feedback when it settles: pass `mutation.mutateAsync(variables)`. The
 * callbacks of `mutate` run only while the component that called it is mounted, and a menu closes
 * as soon as an item is chosen, so the feedback follows the promise instead. Anything else that
 * fails here is a bug, and goes to the log under `source`.
 */
export function whenSettled<T>(
  command: Promise<T>,
  source: string,
  onSuccess: (result: T) => void,
  onError: (failure: IpcFailure) => void,
): void {
  command
    .then(onSuccess, (error: unknown) => {
      if (!(error instanceof IpcFailure)) throw error;
      onError(error);
    })
    .catch((error: unknown) => {
      reportUiError('uncaught', source, error);
    });
}

/** Codes that point at a bug or a broken state: the toast offers "Copy details", and the log has it. */
export const DETAILED: ReadonlySet<string> = new Set(['Internal', 'FileSystem', 'InvalidArgument', 'Transport']);

/** The generic message of an error code (`errors`). */
export function messageOf(error: IpcError): string {
  return i18n.t(`errors:${error.code}`);
}

/** A `NotFound` answer: the item moved or went away (the data layer has refreshed the view). */
export function showGone(error: IpcError): void {
  showToast({ tone: 'info', title: messageOf(error) });
}

/**
 * An error toast for a failed command: the title says what failed, the body the code's message.
 * A `NotFound` says the item moved or went away instead.
 */
export function showFailure(title: string, error: IpcError, source: string, body = messageOf(error)): void {
  if (error.code === 'NotFound') {
    showGone(error);
    return;
  }
  const detailed = DETAILED.has(error.code);
  if (detailed) reportUiError('command', source, error);
  showToast({
    tone: 'danger',
    title,
    body,
    actions: detailed
      ? [
          {
            label: i18n.t('shell:copyDetails.action'),
            onPress: () => {
              copyErrorDetails(title, error);
            },
          },
        ]
      : undefined,
  });
}

/**
 * "Try again" for a region: every query on screen that failed is asked again, since a region often
 * needs several (the semesters, the courses, the newest file) and each may have failed.
 */
export function useRetryFailed(): () => void {
  const client = useQueryClient();
  return () => {
    void client.refetchQueries({ type: 'active', predicate: (query) => query.state.status === 'error' });
  };
}

/** A region whose data failed (library-actions §9.6): what is missing, why, and Try again. */
export function LoadFailure({
  title,
  error,
  retry,
  placement = 'panel',
}: {
  title: string;
  error: IpcError;
  retry: () => void;
  placement?: 'panel' | 'preview';
}) {
  const { t } = useTranslation(['shell', 'errors']);
  return (
    <StateBlock
      tone="danger"
      icon={CircleX}
      placement={placement}
      title={title}
      text={t(`errors:${error.code}`)}
      actions={
        <>
          <Button icon={RefreshCw} onPress={retry}>
            {t('tryAgain')}
          </Button>
          {DETAILED.has(error.code) && (
            <Button
              onPress={() => {
                copyErrorDetails(title, error);
              }}
            >
              {t('copyDetails.action')}
            </Button>
          )}
        </>
      }
    />
  );
}
