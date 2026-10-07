import { Lock } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Banner } from '../../components/Banner/Banner';
import { useJobActive } from '../../data/jobs';
import type { HistoryState } from '../../ipc';

/**
 * The banners under the list's header (workspace-history handoff §3.8): the first scan still
 * running, the index rebuilding (`Busy`), a history a newer Folio wrote, a history Folio cannot
 * read. The rebuild starts after the view opens, so it speaks; the others are read in place.
 */
export function ListBanners({ historyState }: { historyState: HistoryState | undefined }) {
  const { t } = useTranslation('changes');
  const scanning = useJobActive('scan');
  const rebuilding = useJobActive('rebuild');
  return (
    <>
      {historyState === 'damaged' && <Banner tone="danger" title={t('banners.damaged.title')} text={t('banners.damaged.text')} />}
      {historyState === 'readOnly' && (
        <Banner tone="warning" icon={Lock} title={t('banners.readOnly.title')} text={t('banners.readOnly.text')} />
      )}
      {rebuilding && <Banner tone="info" title={t('banners.rebuilding.title')} text={t('banners.rebuilding.text')} announce />}
      {scanning && <Banner tone="info" title={t('banners.scanning.title')} text={t('banners.scanning.text')} />}
    </>
  );
}
