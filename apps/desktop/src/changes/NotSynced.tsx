import './NotSynced.css';

import { ChevronRight, CloudUpload } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { COMMIT_ACTIONS_HOST, COMMIT_ATTRIBUTE, CommitActionButtons, useCommitContextMenu } from '../app/CommitActions';
import { showHistoryTimeline } from '../app/historyTarget';
import { useCanShowView } from '../app/navigation';
import { useRetriedFailure } from '../app/useRetriedFailure';
import { Button } from '../components/Button/Button';
import { useFocusKeeper } from '../components/collections/useFocusKeeper';
import { CountPill } from '../components/CountPill/CountPill';
import { useNotSynced, useWorkspace } from '../data/workspace';
import { type CommitInfo, shortId } from '../ipc';
import { formatDateTime, formatTime, isSameDay } from '../lib/format';
import { FRESH_COMMIT_MS } from '../lib/timing';
import { SIZE } from '../tokens/tokens';

/**
 * The commit that has just arrived at the top of the card (workspace-history handoff §14): one
 * made on the newest commit the card showed before. The card's first commits, an undone commit
 * (its parent was shown already) and an edited message (it keeps its parent) do not count. It
 * stays fresh for `FRESH_COMMIT_MS`, which reduced motion does not shorten: only the fades go.
 *
 * `newest` is the newest commit, `null` with none, `undefined` while the commits load.
 */
function useFreshCommit(newest: CommitInfo | null | undefined): string | null {
  // The newest commit's id at the last render with commits; `undefined` before they first load.
  const [last, setLast] = useState<{ id: string | null } | undefined>(undefined);
  const [fresh, setFresh] = useState<string | null>(null);
  const id = newest === undefined ? undefined : (newest?.id ?? null);
  if (id !== undefined && id !== last?.id) {
    setLast({ id });
    if (last !== undefined && newest?.parent === last.id) setFresh(newest.id);
  }
  useEffect(() => {
    if (fresh === null) return;
    const timer = window.setTimeout(() => {
      setFresh(null);
    }, FRESH_COMMIT_MS);
    return () => {
      window.clearTimeout(timer);
    };
  }, [fresh]);
  return fresh;
}

/**
 * The time now, read again at each midnight: the view stays mounted for the whole session
 * (`<Activity>`), so a time read once would keep calling yesterday "Today". A view shown again
 * after a midnight passed reads it at once (its effects ran again).
 */
function useToday(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const midnight = new Date(now);
    midnight.setHours(24, 0, 0, 0);
    const timer = window.setTimeout(() => {
      setNow(Date.now());
    }, midnight.getTime() - Date.now());
    return () => {
      window.clearTimeout(timer);
    };
  }, [now]);
  return now;
}

/** "b7c1e20 · Today 5:05 PM", "a1b2c3d · Oct 13, 9:30 PM": the commit's own time (§5). */
function useMetaOf(): (commit: CommitInfo) => string {
  const { t, i18n } = useTranslation('changes');
  const now = useToday();
  return (commit) => {
    const ms = Number(commit.timeMs);
    const when = isSameDay(ms, now)
      ? t('notSynced.today', { time: formatTime(ms, i18n.language) })
      : formatDateTime(ms, i18n.language, now);
    return t('notSynced.meta', { id: shortId(commit.id), when });
  };
}

/**
 * "Not synced" (workspace-history handoff §5, decision 31A): the card under the commit box. Cloud
 * sync comes in M3, so every commit counts as not synced: the header counts them, a sentence says
 * why, and the lane shows where the next commit goes and the newest three, a commit that has just
 * arrived on a soft background for a moment. With no commits it shows only its sentence. A commit
 * with the pointer over it or the focus in it (each is a tab stop) shows Edit message and Undo
 * commit, which its context menu offers too (`app/CommitActions.tsx`); "9 more in History" under
 * the lane shows History when it lists more than three. Not shown in a narrow window (§2.2).
 */
export function NotSynced() {
  const { t } = useTranslation(['changes', 'shell']);
  const titleId = useId();
  const commitId = useId();
  const workspace = useWorkspace();
  const historyState = workspace.data?.historyState;
  const commitMenu = useCommitContextMenu(historyState);
  const historyShown = useCanShowView('history');
  const notSynced = useNotSynced(workspace.data?.head);
  const data = notSynced.data;
  const fresh = useFreshCommit(data === undefined ? undefined : (data.commits[0] ?? null));
  const metaOf = useMetaOf();
  // Its failure stays, with "Try again" and the focus, while a retry reads again; when the commits
  // come, the card's heading takes the focus the button had.
  const failure = useRetriedFailure([notSynced.error], notSynced.isFetching, t('notSynced.failed'), () => {
    void notSynced.refetch();
  });
  const heading = useRef<HTMLHeadingElement>(null);
  const keepFocus = useFocusKeeper(() => heading.current?.focus());
  const failed = workspace.isError || failure.shown !== null;

  const count = failed ? '–' : (data?.total ?? '…');
  const countLabel = failed
    ? t('notSynced.countUnknown')
    : data === undefined
      ? t('notSynced.countLoading')
      : t('notSynced.count', { count: data.total });

  return (
    <section ref={keepFocus} className="panel not-synced" aria-labelledby={titleId}>
      <header className="not-synced__header">
        <span className="not-synced__tile" aria-hidden>
          <CloudUpload size={SIZE.iconSmall} />
        </span>
        <h2 ref={heading} id={titleId} className="not-synced__title" tabIndex={-1}>
          {t('notSynced.title')}
        </h2>
        <CountPill count={count} label={countLabel} />
      </header>
      <p className="not-synced__text">{t('notSynced.text')}</p>
      {failure.shown !== null ? (
        <p className="not-synced__failed">
          {t('notSynced.failed')}{' '}
          <Button variant="link" onPress={failure.retry}>
            {t('shell:tryAgain')}
          </Button>
        </p>
      ) : (
        data !== undefined &&
        data.commits.length > 0 && (
          <div className="not-synced__lane">
            <p className="not-synced__next">
              <span className="not-synced__pill">{t('notSynced.next')}</span>
            </p>
            <ol className="not-synced__commits" aria-label={t('notSynced.commits')}>
              {data.commits.map((commit, index) => {
                const summary = commit.summary ?? t('notSynced.noMessage');
                // A tab stop, so named by its summary and described by its short id and time, as
                // History's entries are (§7.6).
                const ids = `${commitId}-${String(index)}`;
                return (
                  <li
                    key={commit.id}
                    className={`not-synced__commit ${COMMIT_ACTIONS_HOST}`}
                    {...{ [COMMIT_ATTRIBUTE]: commit.id }}
                    data-fresh={commit.id === fresh || undefined}
                    tabIndex={0}
                    aria-labelledby={`${ids}-summary`}
                    aria-describedby={`${ids}-meta`}
                    {...commitMenu.handlersFor(commit)}
                  >
                    <span className="not-synced__commit-text">
                      <span id={`${ids}-summary`} className="not-synced__summary" title={summary}>
                        {summary}
                      </span>
                      <span id={`${ids}-meta`} className="not-synced__meta">
                        {metaOf(commit)}
                      </span>
                    </span>
                    <CommitActionButtons commit={commit} historyState={historyState} />
                  </li>
                );
              })}
            </ol>
          </div>
        )
      )}
      {failure.shown === null && historyShown && data !== undefined && data.total > data.commits.length && (
        <p className="not-synced__more">
          <Button
            variant="link"
            onPress={() => {
              showHistoryTimeline();
            }}
          >
            {t('notSynced.more', { count: data.total - data.commits.length })}
            <ChevronRight aria-hidden size={SIZE.iconSmall} />
          </Button>
        </p>
      )}
      {commitMenu.menu}
    </section>
  );
}
