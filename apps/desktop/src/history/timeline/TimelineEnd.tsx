import { useTranslation } from 'react-i18next';

import { Button } from '../../components/Button/Button';
import { Spinner } from '../../components/Progress/Progress';
import type { HistoryPages } from '../../data/history';

export interface TimelineEndProps {
  list: Pick<HistoryPages<unknown>, 'error' | 'hasMore' | 'isLoadingMore' | 'loadMoreFailed' | 'retry'>;
  /** The last entry is the first commit. */
  atStart: boolean;
}

/**
 * What follows the last entry (handoff workspace-history §7.5): "Loading earlier entries…" while
 * more pages follow, "That's the start of your history." after the first commit, or the next
 * page's failure (in one file's history, the first commit's) with Try again, which keeps it while
 * the retry reads (`useRetriedFailure`). Outside the feed, which owns only articles.
 */
export function TimelineEnd({ list, atStart }: TimelineEndProps) {
  const { t } = useTranslation(['history', 'shell']);
  if (list.loadMoreFailed && list.error !== null) {
    return (
      <div className="timeline-end" data-kind="failed" role="alert">
        <span>{t('states.earlierFailed')}</span>
        <Button variant="link" onPress={list.retry}>
          {t('shell:tryAgain')}
        </Button>
      </div>
    );
  }
  // A failed refresh says so in its banner, and loads nothing more until Try again.
  if (list.error !== null) return null;
  if (list.hasMore || list.isLoadingMore) {
    return (
      <div className="timeline-end" data-kind="loading" role="status">
        <Spinner size="small" />
        <span>{t('loadingEarlier')}</span>
      </div>
    );
  }
  if (atStart) {
    return (
      <p className="timeline-end" data-kind="start">
        {t('start')}
      </p>
    );
  }
  return null;
}
