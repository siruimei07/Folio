import './ImportDialog.css';

import { useTranslation } from 'react-i18next';

import type { DialogComponentProps } from '../app/registry';
import { copyDetails, copyErrorDetails } from '../app/windowErrors';
import { Button } from '../components/Button/Button';
import { DialogFrame } from '../components/Dialog/Dialog';
import { failureDetails } from '../components/FailureList/details';
import { FailureList } from '../components/FailureList/FailureList';
import { importResultOf } from '../app/activity/status';
import { failureReason } from './words';

/**
 * "Details" of an import (library-actions handoff §5): a row for every file that wasn't added,
 * with why, or why the whole import failed. The shell sends the first hundred failures; when
 * there were more, the dialog says so.
 */
export function ImportResultDialog({ isOpen, params, onClose }: DialogComponentProps<'importResult'>) {
  const { t } = useTranslation(['import', 'shell', 'errors']);
  const { job, target } = params;
  const result = importResultOf(job);
  const failed = job.status.state === 'failed' ? job.status.error : null;
  const items = (result?.failures ?? []).map((failure) => ({ place: failure.name, reason: failureReason(t, failure.error) }));
  const count = result?.failureCount ?? 0;
  const failedTitle =
    target === undefined ? t('shell:activity.failedTitle.import') : t('shell:activity.failedTitle.importTo', { target });
  const title = failed === null ? t('result.title', { count }) : failedTitle;

  const copy = () => {
    if (failed === null) copyDetails(failureDetails(title, items));
    else copyErrorDetails(title, failed);
  };

  return (
    <DialogFrame
      isOpen={isOpen}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      size="medium"
      title={title}
      footer={
        <>
          <Button size="dialog" onPress={copy}>
            {t('result.copy')}
          </Button>
          <Button size="dialog" variant="accent" autoFocus onPress={onClose}>
            {t('result.close')}
          </Button>
        </>
      }
    >
      {failed !== null && <p className="import-result__text">{t(`errors:${failed.code}`)}</p>}
      {items.length > 0 && <FailureList label={t('result.list')} items={items} />}
      {count > items.length && (
        <p className="import-result__capped">{t('result.capped', { shown: items.length, count })}</p>
      )}
    </DialogFrame>
  );
}
