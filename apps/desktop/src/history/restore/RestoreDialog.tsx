import './RestoreDialog.css';

import type { TFunction } from 'i18next';
import { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { showChange } from '../../app/changeTarget';
import { DETAILED, whenSettled } from '../../app/feedback';
import { reportUiError } from '../../app/log';
import { useCanShowView } from '../../app/navigation';
import { showToast } from '../../app/toasts';
import { copyErrorDetails } from '../../app/windowErrors';
import { Banner } from '../../components/Banner/Banner';
import { Button } from '../../components/Button/Button';
import { PendingButton } from '../../components/Button/PendingButton';
import { DialogFrame } from '../../components/Dialog/Dialog';
import { skeletonWidth, useLoadingDelay } from '../../components/Skeleton/Skeleton';
import { useCourses } from '../../data/groups';
import { useRestorePlan, useRestoreVersion } from '../../data/history';
import type { Course, IpcError, RestorePlan } from '../../ipc';
import { formatDate, formatDateTime } from '../../lib/format';
import { nameOf, parentOf } from '../../lib/paths';
import { placeOf } from '../../lib/places';
import { Refocus } from '../Refocus';
import { type AskedRestore, closeRestore, dropFresh, resetRestore, settleFresh, startFresh, useRestore } from './state';

type RestoreT = TFunction<['history', 'errors', 'shell']>;

const NO_COURSES: readonly Course[] = [];

/** The codes a restore names its own reason for (§8.3); any other says `errors.<code>`. */
const REASONS = ['InUse', 'NotLocal', 'NotRecyclable', 'AccessDenied', 'DiskFull', 'NotStored', 'Pruned', 'FileChanged'] as const;
type Reason = (typeof REASONS)[number];

function isReason(code: string): code is Reason {
  return (REASONS as readonly string[]).includes(code);
}

/**
 * Whether the failure block offers "Copy details": the codes that point at a bug or a broken state
 * (library-actions §9.6), and a damaged history, whose details go to the developer (§7.5).
 */
export function offersDetails(code: string): boolean {
  return !isReason(code) && (DETAILED.has(code) || code === 'HistoryDamaged');
}

/** Why it failed, ending "Nothing was changed." (§8.3). */
export function failureText(t: RestoreT, error: IpcError): string {
  const reason = isReason(error.code) ? t(`restore.reasons.${error.code}`) : t(`errors:${error.code}`);
  return t('restore.failedText', { reason });
}

/** Where the version goes, by the planned outcome (§8.2): "Folio puts the version from Oct 13, 9:30 PM back in MAT232 / Exams." */
export function whereText(t: RestoreT, plan: RestorePlan, when: string, courses: readonly Course[]): string {
  const folder = parentOf(plan.target);
  const place = folder === '' ? t('restore.where.library') : placeOf(folder, courses);
  switch (plan.outcome) {
    case 'replace':
      return t('restore.where.replace', { when, place });
    case 'recreate':
      return t('restore.where.recreate', { name: nameOf(plan.target), when, place });
    case 'beside':
      return t('restore.where.beside', { when, target: nameOf(plan.target) });
    case 'unchanged':
      return '';
  }
}

/** "Nothing to restore": the plan, or the restore itself, found the file with this version's content. */
function showNothingToRestore(t: RestoreT, name: string): void {
  showToast({ tone: 'info', title: t('restore.unchanged.title'), body: t('restore.unchanged.body', { name }) });
}

/** The body while the plan loads: placeholder lines, announced once as "Loading…"; nothing moves. */
function PlanSkeleton() {
  const { t } = useTranslation('common');
  return (
    <div className="restore-dialog__skeleton" role="status" aria-label={t('loading')}>
      {[0, 1, 2].map((index) => (
        <span key={index} className="skeleton__bar" style={{ width: skeletonWidth(index) }} aria-hidden />
      ))}
    </div>
  );
}

/** What the dialog shows of the plan: the latest one while it waits for the person, then held. */
interface PlanView {
  plan: RestorePlan | null;
  error: IpcError | null;
}

type Phase = 'idle' | 'restoring' | 'done';

export interface RestoreDialogProps {
  asked: AskedRestore;
  /** The restore entries the timeline lists now (`restoreKeys`), so the new one can be told apart. */
  knownRestores: () => ReadonlySet<string>;
}

/**
 * The restore confirmation (handoff workspace-history §8.2, §8.3; plan decision 5): an alert dialog
 * (440 px, the confirmation placement) titled with the file's name and the version's date. It asks
 * `plan_restore` as it is asked for and shows once the plan answers, or after 150 ms with a
 * skeleton and "Restore version" pending; a plan of "unchanged" that answers sooner shows only the
 * "Nothing to restore" toast. The body says where the version goes (it replaces the file,
 * recreates it, or goes beside the file that took its name), then "stays in History", or the
 * warning that the file as it is now goes to the Recycle Bin, which puts the focus on Cancel.
 * "Restore version" turns pending ("Restoring…") until `restore_version` answers: done closes with
 * the success toast, `Unchanged` with the information toast; a failure keeps the dialog with the
 * danger block under the header and "Try again", the History view as it was. A plan that failed
 * shows the same block, and "Try again" asks it again. The plan shown is held from the moment
 * "Restore version" is pressed: the restore's own events make the plan say "unchanged".
 */
export function RestoreDialog({ asked, knownRestores }: RestoreDialogProps) {
  const { t, i18n } = useTranslation(['history', 'errors', 'shell']);
  const { request, serial, open } = asked;
  const { version, versionMs } = request;
  const name = nameOf(version.path);
  const language = i18n.language;
  // Today as of when it was asked for, for the year of a date.
  const [now] = useState(() => Date.now());
  const date = formatDate(versionMs, language, now);
  const messageId = useId();
  const bannerId = useId();
  const cancelRef = useRef<HTMLButtonElement>(null);
  const primaryRef = useRef<HTMLButtonElement>(null);
  const courses = useCourses().data ?? NO_COURSES;
  const planQuery = useRestorePlan(open ? version : null);
  const restore = useRestoreVersion();
  const changesShown = useCanShowView('changes');
  const waited = useLoadingDelay();
  const [phase, setPhase] = useState<Phase>('idle');
  const [failure, setFailure] = useState<IpcError | null>(null);

  const latest = planQuery.data ?? null;
  const live = open && phase === 'idle';
  const current: PlanView = { plan: latest?.outcome === 'unchanged' ? null : latest, error: planQuery.error?.error ?? null };
  const [view, setView] = useState<PlanView>(current);
  if (live && (view.plan !== current.plan || view.error !== current.error)) setView(current);
  // Shown once there is something to confirm or to say, or after the wait with the skeleton.
  const [shown, setShown] = useState(false);
  const ready = current.plan !== null || current.error !== null;
  if (open && !shown && (ready || (waited && latest?.outcome !== 'unchanged'))) setShown(true);

  // The file already has this version's content: nothing to confirm (§8.3).
  const unchanged = live && latest?.outcome === 'unchanged';
  useEffect(() => {
    if (!unchanged) return;
    showNothingToRestore(t, name);
    closeRestore(serial);
  }, [unchanged, serial, name, t]);

  const { plan } = view;
  const warn = plan?.recycle === true;
  // The warning block takes the focus off "Restore version" (§8.2), however late the plan says so.
  useEffect(() => {
    if (warn && document.activeElement === primaryRef.current) cancelRef.current?.focus();
  }, [warn]);

  const busy = phase !== 'idle';
  const error = failure ?? view.error;
  // A plan that failed is asked again first; a restore that failed is tried again.
  const retryPlan = failure === null && view.error !== null;

  const doRestore = () => {
    if (plan === null || busy) return;
    setPhase('restoring');
    setFailure(null);
    startFresh(version, knownRestores());
    whenSettled(
      restore.mutateAsync(version),
      'history.restore',
      ({ target }) => {
        settleFresh();
        setPhase('done');
        showToast({
          tone: 'success',
          title: t('restore.done.title', { name }),
          body: t('restore.done.body', { date }),
          // "Show in Changes" selects the restored file's row there (§8.3).
          actions: changesShown
            ? [
                {
                  label: t('restore.done.show'),
                  onPress: () => {
                    showChange(target);
                  },
                },
              ]
            : undefined,
        });
        closeRestore(serial);
      },
      (rejected) => {
        dropFresh();
        if (rejected.error.code === 'Unchanged') {
          setPhase('done');
          showNothingToRestore(t, name);
          closeRestore(serial);
          return;
        }
        if (DETAILED.has(rejected.error.code)) reportUiError('command', 'history.restore', rejected.error);
        setFailure(rejected.error);
        setPhase('idle');
        primaryRef.current?.focus();
      },
    );
  };

  const title = t('restore.failed', { name });
  const banner =
    error === null ? undefined : (
      <div id={bannerId}>
        <Banner
          tone="danger"
          size="block"
          announce={failure !== null}
          title={title}
          text={failureText(t, error)}
          actions={
            offersDetails(error.code) ? (
              <Button
                size="compact"
                onPress={() => {
                  copyErrorDetails(title, error);
                }}
              >
                {t('shell:copyDetails.action')}
              </Button>
            ) : undefined
          }
        />
      </div>
    );

  return (
    <DialogFrame
      isOpen={open && shown}
      role="alertdialog"
      aria-describedby={plan === null && error !== null ? bannerId : messageId}
      onOpenChange={(isOpen) => {
        if (!isOpen && !busy) closeRestore(serial);
      }}
      title={t('restore.title', { name, date })}
      banner={banner}
      flush={plan === null && error !== null}
      footer={
        <>
          <Button
            ref={cancelRef}
            size="dialog"
            autoFocus={warn}
            isDisabled={busy}
            onPress={() => {
              closeRestore(serial);
            }}
          >
            {t('restore.cancel')}
          </Button>
          <PendingButton
            ref={primaryRef}
            variant="accent"
            autoFocus={!warn}
            pending={busy ? t('restore.restoring') : null}
            isPending={(plan === null && error === null) || (retryPlan && planQuery.isFetching)}
            onPress={
              retryPlan
                ? () => {
                    void planQuery.refetch();
                  }
                : doRestore
            }
          >
            {error === null ? t('restore.confirm') : t('restore.tryAgain')}
          </PendingButton>
        </>
      }
    >
      <div id={messageId} className="restore-dialog__message">
        {plan === null ? (
          error === null && <PlanSkeleton />
        ) : (
          <>
            <p className="restore-dialog__text">{whereText(t, plan, formatDateTime(versionMs, language, now), courses)}</p>
            {warn ? (
              <Banner tone="warning" size="block" title={t('restore.recycle.title')} text={t('restore.recycle.text')} />
            ) : (
              plan.outcome === 'replace' && <p className="restore-dialog__kept">{t('restore.kept')}</p>
            )}
          </>
        )}
      </div>
      <Refocus refocus={request.refocus} />
    </DialogFrame>
  );
}

/**
 * The restore confirmation asked for on this History screen, which stays while it fades out; a
 * new one starts afresh. The screen going (another library) closes it and lets go of the highlight.
 */
export function RestoreHost({ knownRestores }: Pick<RestoreDialogProps, 'knownRestores'>) {
  const asked = useRestore((state) => state.asked);
  useEffect(() => resetRestore, []);
  return asked === null ? null : <RestoreDialog key={asked.serial} asked={asked} knownRestores={knownRestores} />;
}
