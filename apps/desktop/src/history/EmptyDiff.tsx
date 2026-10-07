import { useTranslation } from 'react-i18next';

import { EmptyPreview } from '../components/EmptyPreview/EmptyPreview';

/**
 * The diff column before a file row is selected (handoff workspace-history §7.5, app-shell §5): the
 * desk illustration with what to do, on the dot grid of the empty preview.
 */
export function EmptyDiff() {
  const { t } = useTranslation('history');
  return (
    <section className="history-diff" aria-label={t('diff.label')}>
      <EmptyPreview title={t('diff.empty')} />
    </section>
  );
}
