import { Lock } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Banner } from '../../components/Banner/Banner';
import { useLibrary } from '../../data/library';

/**
 * A read-only library (`LibraryInfo.readOnly`, library-actions §9.1): courses and tags cannot
 * change until Folio is updated, so the page says why its controls are off.
 */
export function ReadOnlyBanner() {
  const { t } = useTranslation('settings');
  const library = useLibrary();
  if (library?.readOnly !== true) return null;
  return <Banner tone="warning" icon={Lock} size="block" title={t('readOnly.title')} text={t('readOnly.text')} />;
}
