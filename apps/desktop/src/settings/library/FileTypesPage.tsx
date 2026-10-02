import { Info } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { SIZE } from '../../tokens/tokens';
import { Card, Page } from '../parts/Card';

/**
 * Examples of each class (library core §4.2): every library starts with the core's text formats
 * and Word, which keep full versions, and everything else keeps the latest copy. Examples only,
 * so the page never claims a full list the shell does not send.
 */
const FULL_VERSIONS = ['.md', '.txt', '.tex', '.py', '.java', '.cpp', '.csv', '.docx'] as const;
const LATEST_COPY = ['.pdf', '.pptx', '.xlsx', '.jpg', '.png', '.m4a', '.mp4', '.zip'] as const;

function Extensions({ label, list }: { label: string; list: readonly string[] }) {
  return (
    <ul className="settings-chips" aria-label={label}>
      {list.map((extension) => (
        <li key={extension} className="settings-chip">
          {extension}
        </li>
      ))}
    </ul>
  );
}

/**
 * Library settings → File types (app-shell handoff §9), read-only in M1: which files get full
 * versions and which only the latest copy, and the 10 MB rule for text. Changing them needs its
 * own contract (ipc-m1 §1), so there is no "Add type" yet.
 */
export function FileTypesPage() {
  const { t } = useTranslation('settings');
  return (
    <Page>
      <Card title={t('fileTypes.full.title')} description={t('fileTypes.full.description')}>
        <Extensions label={t('fileTypes.full.examples')} list={FULL_VERSIONS} />
      </Card>
      <Card title={t('fileTypes.latest.title')} description={t('fileTypes.latest.description')}>
        <Extensions label={t('fileTypes.latest.examples')} list={LATEST_COPY} />
      </Card>
      <p className="settings-note">
        <Info aria-hidden size={SIZE.icon} className="settings-note__icon" />
        <span>{t('fileTypes.note')}</span>
      </p>
    </Page>
  );
}
