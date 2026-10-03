import './ProblemsDialog.css';

import { CircleCheck, LoaderCircle } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useJobNotes } from '../app/activity/notes';
import { LoadFailure } from '../app/feedback';
import type { DialogComponentProps } from '../app/registry';
import { Button } from '../components/Button/Button';
import { CountPill } from '../components/CountPill/CountPill';
import { DialogFrame } from '../components/Dialog/Dialog';
import { StateBlock } from '../components/StateBlock/StateBlock';
import { useJobs } from '../data/jobs';
import { LIST_PAGE } from '../data/paged';
import { useProblems } from '../data/problems';
import type { Job, ProblemItem } from '../ipc';
import { formatShortDate, formatTime, isSameDay } from '../lib/format';
import { groupProblems, type ProblemsT } from './describe';
import { ProblemList } from './ProblemList';

/** When the newest scan that finished was seen to end, if the UI saw it (job notes). */
function lastScanAt(jobs: readonly Job[] | undefined, finishedAt: Readonly<Record<string, number>>): number | null {
  let newest: number | null = null;
  for (const job of jobs ?? []) {
    const at = finishedAt[job.id];
    if (job.kind !== 'scan' || job.status.state !== 'done' || at === undefined) continue;
    if (newest === null || at > newest) newest = at;
  }
  return newest;
}

/**
 * The footer's line: when the last scan finished. On its own, so job progress re-renders only it,
 * not the list.
 */
function ScanTime() {
  const { t, i18n } = useTranslation(['problems', 'shell', 'errors']);
  const scannedAt = lastScanAt(useJobs().data, useJobNotes((state) => state.finishedAt));
  return <p className="problems-dialog__footer-text">{scanTimeText(t, scannedAt, i18n.language)}</p>;
}

/** "at 5:03 PM" today, "on Sep 27" before, against the clock at each render. */
function scanTimeText(t: ProblemsT, scannedAt: number | null, language: string): string {
  if (scannedAt === null) return t('footer.unknown');
  return isSameDay(scannedAt, Date.now())
    ? t('footer.at', { time: formatTime(scannedAt, language) })
    : t('footer.on', { date: formatShortDate(scannedAt, language) });
}

/** The rows loaded so far, from the first: the list shows no gaps while later pages load. */
function loadedRows(rowAt: (index: number) => ProblemItem | undefined, count: number): ProblemItem[] {
  const rows: ProblemItem[] = [];
  for (let index = 0; index < count; index++) {
    const row = rowAt(index);
    if (row === undefined) break;
    rows.push(row);
  }
  return rows;
}

/**
 * The problems list (library-actions handoff §11), opened by the Activity popover's "View
 * problems": what the last scans left out or couldn't finish, grouped by kind, each row with why
 * and "Copy path" (or "Edit ignore rules"). Pages load as the list scrolls; ProblemsChanged
 * refetches them (data layer). Focus starts on the title, so the description is read first.
 */
export function ProblemsDialog({ isOpen, onClose }: DialogComponentProps<'problems'>) {
  const { t, i18n } = useTranslation(['problems', 'shell', 'errors']);
  // Rows asked for: a page more each time the end of the list comes into view.
  const [wanted, setWanted] = useState(LIST_PAGE);
  const list = useProblems(isOpen ? { start: 0, end: wanted - 1 } : null, { enabled: isOpen });
  const total = list.total;
  const shown = total === undefined ? 0 : Math.min(wanted, total);
  const rows = useMemo(() => loadedRows(list.rowAt, shown), [list.rowAt, shown]);
  const groups = useMemo(() => groupProblems(t, rows, i18n.language), [t, rows, i18n.language]);

  const loadMore = () => {
    if (total !== undefined && rows.length === shown && wanted < total) setWanted(wanted + LIST_PAGE);
  };

  const error = list.status === 'error' ? list.error : null;
  let body;
  if (error !== null && rows.length === 0) {
    body = <LoadFailure title={t('loadFailed')} error={error.error} retry={list.retry} />;
  } else if (total === undefined) {
    body = <StateBlock icon={LoaderCircle} spinning title={t('loading')} />;
  } else if (total === 0) {
    body = <StateBlock tone="success" icon={CircleCheck} title={t('empty.title')} text={t('empty.text')} />;
  } else {
    body = (
      <ProblemList
        groups={groups}
        // Rows the shown pages hold but haven't arrived yet, or rows past them.
        more={rows.length < total}
        loaded={rows.length}
        error={error}
        onRetry={list.retry}
        onEnd={loadMore}
      />
    );
  }

  return (
    <DialogFrame
      isOpen={isOpen}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      size="large"
      flush
      title={t('title')}
      titleAside={total === undefined || total === 0 ? undefined : <CountPill count={total} label={t('count', { count: total })} />}
      focusTitle
      // With nothing listed, the empty state says it all.
      description={total === 0 ? undefined : t('intro')}
      footer={
        <>
          <ScanTime />
          <Button size="dialog" onPress={onClose}>
            {t('close')}
          </Button>
        </>
      }
    >
      {body}
    </DialogFrame>
  );
}
