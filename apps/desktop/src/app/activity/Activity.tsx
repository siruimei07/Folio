import '../../components/tone.css';
import './Activity.css';

import {
  CircleX,
  FileCog,
  FolderSearch,
  GitCommitHorizontal,
  History,
  Import,
  type LucideIcon,
  RefreshCw,
  X,
} from 'lucide-react';
import { type KeyboardEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button as AriaButton, Dialog, DialogTrigger, Heading } from 'react-aria-components';

import { Button } from '../../components/Button/Button';
import { ToneIcon } from '../../components/feedback';
import { IconButton } from '../../components/IconButton/IconButton';
import { MiddleTruncate } from '../../components/MiddleTruncate/MiddleTruncate';
import { Popover } from '../../components/Popover/Popover';
import { ProgressBar, ProgressRing, Spinner } from '../../components/Progress/Progress';
import { Tooltip } from '../../components/Tooltip/Tooltip';
import type { Job, JobKind } from '../../ipc';
import { isActiveJob } from '../../lib/jobs';
import { SIZE } from '../../tokens/tokens';
import { describeJob, describeStatus, type JobRow } from './describe';
import type { ActivityJob, ActivityStatus } from './status';
import { useActivityStatus } from './useActivityStatus';

export interface ActivityProps {
  /** Active jobs first, then the finished ones `list_jobs` returns, newest first. */
  jobs: readonly ActivityJob[];
  /** Problems the last scan left; `null` before a scan has finished. */
  problems: number | null;
  onCancel: (job: Job) => void;
  /** Opens the result dialog of an import that left files out or failed (library-actions §5). */
  onDetails: (job: Job) => void;
  /** Opens the problems list; without it, the footer only counts them (no problems dialog yet). */
  onViewProblems?: () => void;
  /** The narrow window's bar: a 28 px button with only the ring or icon. */
  compact?: boolean;
}

const QUEUED_ICONS: Readonly<Record<JobKind, LucideIcon>> = {
  scan: FolderSearch,
  hash: FileCog,
  import: Import,
  rebuild: RefreshCw,
  commit: GitCommitHorizontal,
  firstCommit: History,
};

/** The button's icon: the progress ring while jobs run, else the result or the warning. */
function StatusIcon({ status }: { status: ActivityStatus }) {
  switch (status.kind) {
    case 'waiting':
      return <ProgressRing value={0} />;
    case 'running':
      return <ProgressRing value={status.percent} />;
    case 'several':
      return <ProgressRing value={null} />;
    case 'done':
      return <ToneIcon tone={status.withProblems ? 'warning' : 'success'} size="small" className="activity__icon" />;
    case 'problems':
    case 'hidden':
      return <ToneIcon tone="warning" size="small" className="activity__icon" />;
  }
}

/**
 * The activity button in the toolbar, left of search, and its popover (library-actions handoff
 * §10, decision 29A). Hidden when nothing runs, nothing ended in the last 10 s and the last scan
 * left no problems.
 */
export function Activity({ jobs, problems, onCancel, onDetails, onViewProblems, compact = false }: ActivityProps) {
  const { t } = useTranslation(['shell', 'errors']);
  const [open, setOpen] = useState(false);
  const status = useActivityStatus(
    jobs.map(({ job }) => job),
    problems,
  );
  const words = describeStatus(t, status);
  if (words === null) {
    // Hidden under an open popover: close it, so it does not open by itself when a job starts.
    if (open) setOpen(false);
    return null;
  }
  const warningDot =
    (status.kind === 'waiting' || status.kind === 'running' || status.kind === 'several') && status.problems > 0;

  const button = (
    <AriaButton
      className="activity__button"
      data-compact={compact || undefined}
      aria-label={words.aria}
      aria-haspopup="dialog"
    >
      <StatusIcon status={status} />
      {!compact && <span className="activity__label">{words.label}</span>}
      {warningDot && <span className="activity__dot" aria-hidden />}
    </AriaButton>
  );

  return (
    <DialogTrigger isOpen={open} onOpenChange={setOpen}>
      {compact ? <Tooltip content={words.aria}>{button}</Tooltip> : button}
      <Popover className="activity__popover" placement="bottom end">
        <ActivityPanel
          jobs={jobs}
          problems={problems}
          onCancel={onCancel}
          onDetails={onDetails}
          onViewProblems={
            onViewProblems &&
            (() => {
              setOpen(false);
              onViewProblems();
            })
          }
          onClose={() => {
            setOpen(false);
          }}
        />
      </Popover>
    </DialogTrigger>
  );
}

interface ActivityPanelProps extends Omit<ActivityProps, 'compact'> {
  onClose: () => void;
}

/** The popover's content: running and queued jobs, earlier ones, and the problems footer. */
export function ActivityPanel({ jobs, problems, onCancel, onDetails, onViewProblems, onClose }: ActivityPanelProps) {
  const { t, i18n } = useTranslation(['shell', 'errors']);
  // Finish times read "today" against the moment the popover opened.
  const [now] = useState(() => Date.now());
  const rows = jobs.map((item) => ({ item, row: describeJob(t, item, now, i18n.language) }));
  const running = rows.filter(({ item }) => isActiveJob(item.job));
  const earlier = rows.filter(({ item }) => !isActiveJob(item.job));
  // Focus starts on the first control: a cancel button, else "View problems".
  const firstCancel = running.find(({ row }) => row.cancelLabel !== null)?.item.job.id;
  const items = (list: typeof rows) =>
    list.map(({ item, row }) => (
      <JobItem
        key={item.job.id}
        row={row}
        kind={item.job.kind}
        autoFocus={item.job.id === firstCancel}
        onCancel={() => {
          onCancel(item.job);
        }}
        onDetails={() => {
          onDetails(item.job);
        }}
      />
    ));

  // Tab past the last control, or Shift+Tab before the first, closes the popover.
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== 'Tab') return;
    const controls = [...event.currentTarget.querySelectorAll<HTMLElement>('button:not([disabled])')];
    const edge = event.shiftKey ? controls[0] : controls.at(-1);
    if (edge !== undefined && document.activeElement === edge) {
      event.preventDefault();
      onClose();
    }
  };

  return (
    <Dialog className="activity__panel" aria-label={t('activity.title')}>
      {/* Not a control: it only sees Tab leaving the popover's last button. */}
      <div className="activity__content" onKeyDown={onKeyDown}>
        <Heading slot="title" className="activity__heading">
          {t('activity.title')}
        </Heading>
        {running.length > 0 && (
          <ul className="activity__list" aria-label={t('activity.runningList')}>
            {items(running)}
          </ul>
        )}
        {earlier.length > 0 && (
          <>
            <p className="activity__earlier" aria-hidden>
              {t('activity.earlier')}
            </p>
            <ul className="activity__list" aria-label={t('activity.earlier')}>
              {items(earlier)}
            </ul>
          </>
        )}
        {problems !== null && (
          <footer className="activity__footer">
            {problems > 0 ? (
              <>
                <ToneIcon tone="warning" className="activity__icon" />
                <span className="activity__footer-text">{t('activity.footerProblems', { count: problems })}</span>
                {onViewProblems && (
                  <Button size="compact" autoFocus={firstCancel === undefined} onPress={onViewProblems}>
                    {t('activity.viewProblems')}
                  </Button>
                )}
              </>
            ) : (
              <>
                <ToneIcon tone="success" className="activity__icon" />
                <span className="activity__footer-text">{t('activity.footerNoProblems')}</span>
              </>
            )}
          </footer>
        )}
      </div>
    </Dialog>
  );
}

interface JobItemProps {
  row: JobRow;
  kind: JobKind;
  autoFocus?: boolean;
  onCancel: () => void;
  onDetails: () => void;
}

/** A job's icon: turning while it runs, its kind while it waits, else its result. */
function JobIcon({ row, kind }: { row: JobRow; kind: JobKind }) {
  switch (row.look) {
    case 'running':
      return <Spinner className="activity__icon" />;
    case 'queued': {
      const Icon = QUEUED_ICONS[kind];
      return <Icon aria-hidden size={SIZE.icon} className="activity__icon" />;
    }
    case 'cancelled':
      return <CircleX aria-hidden size={SIZE.icon} className="activity__icon" />;
    default:
      return <ToneIcon tone={row.look} className="activity__icon" />;
  }
}

function JobItem({ row, kind, autoFocus = false, onCancel, onDetails }: JobItemProps) {
  const { t } = useTranslation('shell');
  return (
    <li className="activity__job">
      <JobIcon row={row} kind={kind} />
      <div className="activity__job-body">
        <div className="activity__job-head">
          <span className="activity__job-title">{row.title}</span>
          {row.look === 'running' && row.percent !== null && (
            <span className="activity__job-aside">{t('activity.percent', { percent: row.percent })}</span>
          )}
          {row.time !== null && <span className="activity__job-aside">{row.time}</span>}
        </div>
        {row.meta !== null && <span className="activity__job-meta">{row.meta}</span>}
        {row.look === 'running' && (
          <div className="activity__job-bar">
            <ProgressBar label={row.title} value={row.percent} />
          </div>
        )}
        {row.current !== null && (
          <span className="activity__job-current">
            <MiddleTruncate text={row.current} />
          </span>
        )}
      </div>
      {row.hasDetails && (
        <Button variant="link" onPress={onDetails}>
          {t('activity.details')}
        </Button>
      )}
      {row.cancelLabel !== null && (
        <IconButton icon={X} label={row.cancelLabel} size="small" autoFocus={autoFocus} onPress={onCancel} />
      )}
    </li>
  );
}
