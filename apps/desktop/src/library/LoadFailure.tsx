import { useQueryClient } from '@tanstack/react-query';
import { CircleX, RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Button } from '../components/Button/Button';
import { StateBlock } from '../components/StateBlock/StateBlock';
import type { IpcError } from '../ipc';
import { copyFailure, DETAILED } from './feedback';

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
  placement,
}: {
  title: string;
  error: IpcError;
  retry: () => void;
  placement: 'panel' | 'preview';
}) {
  const { t } = useTranslation(['library', 'errors']);
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
            {t('states.tryAgain')}
          </Button>
          {DETAILED.has(error.code) && (
            <Button
              onPress={() => {
                copyFailure(title, error);
              }}
            >
              {t('results.copy')}
            </Button>
          )}
        </>
      }
    />
  );
}
