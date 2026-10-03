import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';

import type { ToastAction, ToastTone } from '../../components/Toast/Toast';
import { useCancelJob, useJobs } from '../../data/jobs';
import { useLibraryId } from '../../data/session';
import type { Job } from '../../ipc';
import { isActiveJob } from '../../lib/jobs';
import { openDialog, reveal } from '../navigation';
import { removeToast, showToast } from '../toasts';
import { cancelWithFeedback } from './ActivityControl';
import { describeJob, type JobLook } from './describe';
import { noteAnnounced, noteHidden, useJobNotes } from './notes';

const TONES: Readonly<Record<JobLook, ToastTone>> = {
  running: 'progress',
  queued: 'progress',
  success: 'success',
  warning: 'warning',
  danger: 'danger',
  cancelled: 'info',
};

/**
 * The toast of every import the UI started (library-actions handoff §5): while it waits or runs,
 * a progress toast with Cancel and Hide; when it ends, the same toast turns into the result, with
 * "Show" or "Details". Hiding the progress keeps the job running in the Activity popover, and the
 * result still shows. Rendered by the activity control, which the toolbar always shows while a
 * library is open; renders nothing itself.
 */
export function ImportToasts() {
  const { t, i18n } = useTranslation(['import', 'shell', 'errors']);
  const { t: shellT } = useTranslation(['shell', 'errors']);
  const jobs = useJobs().data;
  const libraryId = useLibraryId();
  const imports = useJobNotes((state) => state.imports);
  // Stable across renders, unlike the mutation object.
  const cancelAsync = useCancelJob().mutateAsync;
  /** The job each toast last showed: a job that did not change keeps its object (`applyJob`). */
  const shown = useRef(new Map<string, Job>());

  useEffect(() => {
    if (jobs === undefined) return;
    const { announced, hidden } = useJobNotes.getState();
    for (const [id, note] of Object.entries(imports)) {
      if (announced.has(id)) continue;
      const key = `import:${id}`;
      if (note.libraryId !== libraryId) {
        // Another library: its jobs are gone, and so is their progress.
        removeToast(key);
        noteAnnounced(id);
        continue;
      }
      // Not listed yet: its JobChanged is on the way.
      const job = jobs.find((candidate) => candidate.id === id);
      if (job === undefined) continue;
      const active = isActiveJob(job);
      if (shown.current.get(id) === job || (active && hidden.has(id))) continue;
      shown.current.set(id, job);
      if (!active) noteAnnounced(id);

      const row = describeJob(shellT, { job, target: note.label, files: note.files }, Date.now(), i18n.language);
      let body = row.meta ?? undefined;
      let actions: ToastAction[] = [];
      if (active) {
        // "7 of 12 · Lecture 7 Lagrange Examples.pptx" while it runs; queued, the row's meta.
        if (job.status.state === 'running') {
          const { done, total } = job.status.progress;
          const count = { done, total: total ?? note.files };
          body =
            row.current === null
              ? t('progress.bodyCount', count)
              : t('progress.body', { ...count, current: row.current });
        }
        actions = [
          {
            label: t('progress.cancel'),
            onPress: () => {
              cancelWithFeedback(cancelAsync, job);
            },
          },
        ];
      } else if (row.hasDetails) {
        actions = [
          {
            label: t('progress.details'),
            onPress: () => {
              openDialog('importResult', { job, target: note.label });
            },
          },
        ];
      } else if (row.look === 'success') {
        actions = [
          {
            label: t('progress.show'),
            onPress: () => {
              reveal(note.target);
            },
          },
        ];
      }
      showToast({
        key,
        tone: TONES[row.look],
        title: row.title,
        body,
        progress: row.look === 'running' ? row.percent : undefined,
        actions,
        ...(active && {
          dismissLabel: 'hide' as const,
          onDismiss: () => {
            noteHidden(id);
          },
        }),
      });
    }
  }, [jobs, imports, libraryId, t, shellT, i18n.language, cancelAsync]);

  return null;
}
