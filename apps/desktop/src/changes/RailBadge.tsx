import { useTranslation } from 'react-i18next';

import { isHistoryStarting, useAutoStartFirstCommit } from '../app/firstCommit';
import type { RailBadge, RailBadgeProps } from '../app/registry';
import { useWorkspace } from '../data/workspace';
import { formatNumber } from '../lib/format';

/** The badge shows up to this count, then "999+" (workspace-history handoff §2.1). */
const MOST_SHOWN = 999;

/**
 * The Changes rail button's badge (workspace-history handoff §2.1, app-shell §4): the workspace's
 * items plus its tag and settings changes, "1" to "999", then "999+", in the button's name too
 * ("Changes, 10 changes"); hidden at zero, while the workspace has not said, and while the first
 * commit runs. Mounted while the shell is, it also starts the first commit by itself, once per
 * library session (handoff §10, `app/firstCommit.ts`). A workspace the shell cannot read leaves
 * the badge as it was: the view says why.
 */
export function ChangesRailBadge({ children }: RailBadgeProps) {
  const { t, i18n } = useTranslation('changes');
  useAutoStartFirstCommit();
  const summary = useWorkspace().data;
  const count = summary === undefined || isHistoryStarting(summary.historyState) ? 0 : summary.items + summary.metadata;
  const badge: RailBadge | null =
    count === 0
      ? null
      : {
          text: count > MOST_SHOWN ? t('railBadge.overflow', { count: MOST_SHOWN }) : formatNumber(count, i18n.language),
          label: t('railBadge.label', { count }),
        };
  return children(badge);
}
