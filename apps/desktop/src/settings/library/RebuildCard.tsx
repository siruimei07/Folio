import '../../components/tone.css';

import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { reportUiError } from '../../app/log';
import { PendingButton } from '../../components/Button/PendingButton';
import { ToneIcon } from '../../components/feedback';
import { useJob, useJobActive, useRebuildCatalog } from '../../data/jobs';
import type { IpcError, Job } from '../../ipc';
import { ipcErrorOf } from '../feedback';
import { Card } from '../parts/Card';

/** What the card says under its description, by the state of the rebuild it started. */
function useOutcome(job: Job | undefined, startError: IpcError | null): { tone: 'success' | 'info' | 'danger'; text: string } | null {
  const { t } = useTranslation(['settings', 'errors']);
  if (startError?.code === 'Busy') return { tone: 'info', text: t('rebuild.busy') };
  if (startError !== null) {
    return { tone: 'danger', text: t('rebuild.startFailed', { message: t(`errors:${startError.code}`) }) };
  }
  switch (job?.status.state) {
    case 'done':
      return job.status.result.kind === 'rebuild'
        ? { tone: 'success', text: t('rebuild.done', { count: job.status.result.entries }) }
        : null;
    case 'failed':
      return { tone: 'danger', text: t('rebuild.failed', { message: t(`errors:${job.status.error.code}`) }) };
    case 'cancelled':
      return { tone: 'info', text: t('rebuild.cancelled') };
    default:
      return null;
  }
}

/**
 * "Rebuild search index" (app-shell handoff §9; ipc-m1 §13): starts the rebuild job, then says it
 * runs, and how it ended. A rebuild that is already running (from here or elsewhere) shows as
 * running; the Library's banner says the same (library-actions §9.1).
 */
export function RebuildCard() {
  const { t } = useTranslation('settings');
  const rebuild = useRebuildCatalog();
  const running = useJobActive('rebuild');
  const [jobId, setJobId] = useState<string | null>(null);
  const [startError, setStartError] = useState<IpcError | null>(null);
  const job = useJob(jobId);
  const outcome = useOutcome(running ? undefined : job, startError);
  const busy = running || rebuild.isPending;

  const start = async () => {
    setStartError(null);
    try {
      setJobId(await rebuild.mutateAsync());
    } catch (error: unknown) {
      const failure = ipcErrorOf(error);
      // Busy: a rebuild runs already; the card says so until the job list shows it running.
      if (failure.code !== 'Busy') reportUiError('command', 'settings.rebuild', failure);
      setStartError(failure);
    }
  };

  return (
    <Card
      title={t('rebuild.title')}
      description={t('rebuild.description')}
      action={
        <PendingButton
          pending={busy ? t('rebuild.running') : null}
          // Pending, not disabled: the button keeps focus while the rebuild runs.
          isPending={busy}
          onPress={() => {
            void start();
          }}
        >
          {t('rebuild.action')}
        </PendingButton>
      }
    >
      {/* Always present, so each new state is announced. */}
      <p className="settings-card__status" role="status">
        {running ? (
          t('rebuild.runningText')
        ) : outcome !== null ? (
          <>
            <ToneIcon tone={outcome.tone} size="small" />
            <span>{outcome.text}</span>
          </>
        ) : null}
      </p>
    </Card>
  );
}
