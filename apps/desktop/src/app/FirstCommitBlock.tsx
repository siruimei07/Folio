import './FirstCommitBlock.css';

import { CircleX, FolderSearch, FolderX, History, RefreshCw } from 'lucide-react';
import { useCallback, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '../components/Button/Button';
import { useFocusKeeper } from '../components/collections/useFocusKeeper';
import { ProgressBar } from '../components/Progress/Progress';
import { StateBlock } from '../components/StateBlock/StateBlock';
import { useCourses } from '../data/groups';
import { sizeProgressParts } from '../lib/format';
import { DETAILED } from './feedback';
import { useFileActions } from './fileActions';
import { type FirstCommitState, tooLargeText, useFirstCommit, useStartFirstCommit } from './firstCommit';
import { copyErrorDetails } from './windowErrors';

type Running = NonNullable<Extract<FirstCommitState, { kind: 'running' }>['progress']>;

function sameProgress(a: Running | null, b: Running | null): boolean {
  return a?.percent === b?.percent && a?.bytes?.done === b?.bytes?.done && a?.bytes?.total === b?.bytes?.total;
}

/**
 * The job's progress to show: the latest, and once the job is done, the last one until the
 * workspace says the history has started (the block then goes).
 */
function useShownProgress(state: FirstCommitState | null): Running | null {
  const live = state?.kind === 'running' ? state.progress : null;
  const [kept, setKept] = useState<Running | null>(null);
  const wanted = state?.kind === 'running' ? (live ?? kept) : null;
  if (!sameProgress(wanted, kept)) setKept(wanted);
  return wanted;
}

export interface FirstCommitBlockProps {
  /** The view's sentence while the history starts: what shows up there once it has (§10). */
  text: string;
}

/**
 * The first commit's state block (workspace-history handoff §10), which the Changes and History
 * views show in place of their content while the history has not started: "Starting your history"
 * with the view's sentence and a 260 px progress bar, indeterminate with "Waiting for the scan to
 * finish" until the job reads files, then "1.2 GB of 3.4 GB"; "Your history hasn't started" with
 * "Start history" after a cancel; "Couldn't start your history" with the reason and "Try again"
 * after a failure. Nothing once the history has started. A start moves the focus to the block,
 * since its button goes. A history too large to keep (ipc-m2 §6.1, §19 item 5) shows here too, as
 * "History is off for this library", a warning: the folder that holds too many files named as a
 * place, with "Show in File Explorer", or the library as a whole without a button; no "Try again"
 * or "Start history", since Folio tries again by itself when the library changes, and no promise
 * of that for a `HEAD` too large to show. A button that goes while it has the focus without being
 * pressed (Show in File Explorer once a change ends `tooLarge`) leaves it to the block (WCAG 2.4.3,
 * `useFocusKeeper`), not to the page.
 */
export function FirstCommitBlock({ text }: FirstCommitBlockProps) {
  const { t, i18n } = useTranslation(['shell', 'errors']);
  const state = useFirstCommit();
  const start = useStartFirstCommit();
  const files = useFileActions();
  const courses = useCourses().data ?? [];
  const progress = useShownProgress(state);
  const root = useRef<HTMLDivElement | null>(null);
  const keepFocus = useFocusKeeper(() => root.current?.focus());
  const rootRef = useCallback(
    (element: HTMLDivElement | null) => {
      root.current = element;
      const stop = keepFocus(element);
      return () => {
        root.current = null;
        stop?.();
      };
    },
    [keepFocus],
  );
  if (state === null) return null;

  const restart = () => {
    start();
    root.current?.focus();
  };

  const block = () => {
    switch (state.kind) {
      case 'waiting':
      case 'running': {
        const bytes = progress?.bytes ?? null;
        const parts = bytes === null ? null : sizeProgressParts(Number(bytes.done), Number(bytes.total), i18n.language);
        const line =
          state.kind === 'waiting'
            ? t('firstCommit.waiting')
            : parts === null
              ? null
              : t(`firstCommit.bytes.${parts.unit}`, { done: parts.done, total: parts.total });
        return (
          <StateBlock tone="info" icon={History} title={t('firstCommit.title')} text={text}>
            <div className="first-commit__progress">
              <ProgressBar
                label={t('firstCommit.title')}
                value={state.kind === 'waiting' ? null : progress === null ? 100 : progress.percent}
              />
              {line !== null && <p className="first-commit__line">{line}</p>}
            </div>
          </StateBlock>
        );
      }
      case 'cancelled':
        return (
          <StateBlock
            tone="info"
            icon={History}
            title={t('firstCommit.cancelled.title')}
            text={t('firstCommit.cancelled.text')}
            actions={
              <Button variant="accent" onPress={restart}>
                {t('firstCommit.start')}
              </Button>
            }
          />
        );
      case 'failed': {
        const title = t('firstCommit.failed.title');
        const { error } = state;
        return (
          <StateBlock
            tone="danger"
            icon={CircleX}
            title={title}
            text={t('firstCommit.failed.text', { reason: t(`errors:${error.code}`) })}
            actions={
              <>
                <Button icon={RefreshCw} onPress={restart}>
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
      case 'tooLarge': {
        const { folder } = state;
        return (
          <StateBlock
            tone="warning"
            icon={FolderX}
            title={t('firstCommit.tooLarge.title')}
            text={tooLargeText(state, courses, t)}
            actions={
              folder === null ? undefined : (
                <Button
                  icon={FolderSearch}
                  onPress={() => {
                    files.showFolderInExplorer(folder);
                  }}
                >
                  {t('fileActions.reveal')}
                </Button>
              )
            }
          />
        );
      }
    }
  };

  return (
    <div ref={rootRef} className="first-commit" tabIndex={-1}>
      {block()}
    </div>
  );
}
