import { Lock } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Banner } from '../../components/Banner/Banner';
import { useJobActive } from '../../data/jobs';
import { useLibrary } from '../../data/library';
import { dismissRecovered, useLibraryView } from '../state';

/**
 * The banners at the top of the Library panel (library-actions handoff §9.1): a read-only
 * library, a rebuild of the index, and a catalog rebuilt when the library opened. Present when
 * the view opens, they are read in place; the rebuild's appears after an action, so it speaks.
 */
export function LibraryBanners() {
  const { t } = useTranslation('library');
  const library = useLibrary();
  const dismissed = useLibraryView((state) => state.recoveredDismissed);
  const rebuilding = useJobActive('rebuild');
  const scanning = useJobActive('scan');
  if (library === null) return null;
  return (
    <>
      {library.readOnly && (
        <Banner tone="warning" icon={Lock} title={t('banners.readOnly.title')} text={t('banners.readOnly.text')} />
      )}
      {rebuilding && (
        <Banner tone="info" title={t('banners.rebuild.title')} text={t('banners.rebuild.text')} announce />
      )}
      {library.recovered && scanning && !dismissed && (
        <Banner
          tone="info"
          title={t('banners.recovered.title')}
          text={t('banners.recovered.text')}
          onDismiss={dismissRecovered}
        />
      )}
    </>
  );
}
