import { Copy, RefreshCw, Settings } from 'lucide-react';
import { memo, useEffect, useId, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';

import { copyText } from '../app/clipboard';
import { DETAILED } from '../app/feedback';
import { openDialog } from '../app/navigation';
import { showToast } from '../app/toasts';
import { copyErrorDetails } from '../app/windowErrors';
import { Banner } from '../components/Banner/Banner';
import { Button } from '../components/Button/Button';
import { IconButton } from '../components/IconButton/IconButton';
import { MiddleTruncate } from '../components/MiddleTruncate/MiddleTruncate';
import { Spinner } from '../components/Progress/Progress';
import type { IpcFailure } from '../data/errors';
import { useLibrary } from '../data/library';
import type { IpcError } from '../ipc';
import { windowsPath } from '../lib/paths';
import { SIZE } from '../tokens/tokens';
import type { ProblemAction, ProblemGroup, ProblemsT } from './describe';

export interface ProblemListProps {
  groups: readonly ProblemGroup[];
  /** More problems than the groups hold: a row at the end loads them. */
  more: boolean;
  /** Rows the groups hold. */
  loaded: number;
  /** A page that failed to load; the rows before it stay. */
  error: IpcFailure | null;
  onRetry: () => void;
  /** The end of the list came into view. */
  onEnd: () => void;
}

/** Library settings on its ignore rules. */
const IGNORE_RULES_PAGE = { page: 'ignore' };

/** Copies the absolute Windows paths, one per line, and says so (library-actions §11). */
function copyPaths(t: ProblemsT, root: string, paths: readonly string[]): void {
  const text = paths.map((path) => windowsPath(root, path)).join('\n');
  void copyText(text).then((copied) => {
    showToast(
      copied
        ? {
            tone: 'info',
            title: paths.length === 1 ? t('copy.one') : t('copy.several', { count: paths.length }),
          }
        : { tone: 'danger', title: paths.length === 1 ? t('copy.failed') : t('copy.failedSeveral') },
    );
  });
}

interface RowActionProps {
  action: ProblemAction;
  /** Copies paths; `null` while no library is open. */
  onCopy: ((paths: readonly string[]) => void) | null;
}

function RowAction({ action, onCopy }: RowActionProps) {
  const { t } = useTranslation(['problems', 'shell', 'errors']);
  if (action.kind === 'editIgnoreRules') {
    return (
      <Button
        size="compact"
        icon={Settings}
        onPress={() => {
          openDialog('librarySettings', IGNORE_RULES_PAGE);
        }}
      >
        {t('editIgnoreRules')}
      </Button>
    );
  }
  return (
    <IconButton
      icon={Copy}
      label={action.label}
      tooltipPlacement="left"
      isDisabled={onCopy === null}
      onPress={() => {
        onCopy?.(action.paths);
      }}
    />
  );
}

/** One group: its header, then its rows. Memoised: a new page or job progress leaves it alone. */
const Group = memo(function Group({ group, onCopy }: { group: ProblemGroup; onCopy: RowActionProps['onCopy'] }) {
  const { t } = useTranslation(['problems', 'shell', 'errors']);
  const headingId = useId();
  const Icon = group.icon;
  const count = group.rows.length;
  const title = t(`groups.${group.kind}`);
  return (
    <section className="problems__group" aria-labelledby={headingId}>
      {/* Named in full, so the count reads as words: "Couldn't read, 2 items". */}
      <h3 id={headingId} className="problems__group-header" aria-label={t('groupLabel', { group: title, count })}>
        <Icon aria-hidden size={SIZE.iconSmall} className="problems__group-icon" />
        <span className="problems__group-title">{title}</span>
        <span className="problems__group-count">{count}</span>
      </h3>
      <ul className="problems__rows">
        {group.rows.map((row) => (
          <li key={row.id} className="problems__row">
            <div className="problems__row-text">
              <span className="problems__row-title">
                <MiddleTruncate text={row.title} />
              </span>
              <span className="problems__row-explanation">{row.explanation}</span>
            </div>
            <RowAction action={row.action} onCopy={onCopy} />
          </li>
        ))}
      </ul>
    </section>
  );
});

/**
 * Watches the end of the list. Each time `loaded` changes it starts watching anew, which reports
 * at once whether the end is in view: a short list asks for its next page without any scrolling.
 */
function EndSentinel({ loaded, onEnd }: { loaded: number; onEnd: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const latest = useRef(onEnd);
  useEffect(() => {
    latest.current = onEnd;
  });
  useEffect(() => {
    const element = ref.current;
    if (element === null) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) latest.current();
    });
    observer.observe(element);
    return () => {
      observer.disconnect();
    };
  }, [loaded]);
  return <div ref={ref} className="problems__sentinel" aria-hidden />;
}

/** A block banner at the end of the list: what failed, why, and Try again (library-actions §9.6). */
function PageFailure({ title, error, onRetry }: { title: string; error: IpcError; onRetry: () => void }) {
  const { t } = useTranslation(['problems', 'shell', 'errors']);
  return (
    <div className="problems__failure">
      <Banner
        tone="danger"
        size="block"
        announce
        title={title}
        text={t(`errors:${error.code}`)}
        actions={
          <>
            <Button size="compact" icon={RefreshCw} onPress={onRetry}>
              {t('shell:tryAgain')}
            </Button>
            {DETAILED.has(error.code) && (
              <Button
                size="compact"
                onPress={() => {
                  copyErrorDetails(title, error);
                }}
              >
                {t('shell:copyDetails.action')}
              </Button>
            )}
          </>
        }
      />
    </div>
  );
}

/** The groups of the problems list in their §11 order, then a row that loads more or failed. */
export function ProblemList({ groups, more, loaded, error, onRetry, onEnd }: ProblemListProps) {
  const { t } = useTranslation(['problems', 'shell', 'errors']);
  const root = useLibrary()?.root;
  const onCopy = useMemo(
    () =>
      root === undefined
        ? null
        : (paths: readonly string[]) => {
            copyPaths(t, root, paths);
          },
    [t, root],
  );
  return (
    <div className="problems__list">
      {groups.map((group) => (
        <Group key={group.kind} group={group} onCopy={onCopy} />
      ))}
      {/* A later page, or the refetch after ProblemsChanged, failed: the rows above stay. */}
      {error !== null && (
        <PageFailure title={more ? t('loadMoreFailed') : t('refreshFailed')} error={error.error} onRetry={onRetry} />
      )}
      {error === null && more && (
        <div className="problems__more">
          <div className="problems__status">
            <Spinner size="small" />
            <span>{t('loadingMore')}</span>
          </div>
          <EndSentinel loaded={loaded} onEnd={onEnd} />
        </div>
      )}
    </div>
  );
}
