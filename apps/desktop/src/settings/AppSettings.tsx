import './settings.css';

import { Keyboard, Palette, Settings } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import type { DialogComponentProps } from '../app/registry';
import { AppearancePage } from './app/AppearancePage';
import { GeneralPage } from './app/GeneralPage';
import { KeyboardPage } from './app/KeyboardPage';
import { SettingsFrame } from './parts/SettingsFrame';
import { usePageOnOpen } from './parts/usePageOnOpen';

const PAGES = ['general', 'appearance', 'keyboard'] as const;
type AppPageId = (typeof PAGES)[number];

/**
 * App settings, the avatar's dialog (app-shell handoff §9, 25A): this computer's name, the theme
 * and reduce motion, and the keyboard shortcuts. AI, start with Windows and updates come with their
 * own contracts (ipc-m1 §22), so their pages are not here yet.
 */
export function AppSettings({ isOpen, params, onClose }: DialogComponentProps<'appSettings'>) {
  const { t } = useTranslation('settings');
  const { page, setPage, opening } = usePageOnOpen(PAGES, isOpen, params?.page);
  return (
    <SettingsFrame<AppPageId>
      key={opening}
      isOpen={isOpen}
      onClose={onClose}
      title={t('app.title')}
      page={page}
      onPageChange={setPage}
      pages={[
        { id: 'general', label: t('app.pages.general'), icon: Settings, content: <GeneralPage />, keepMounted: true },
        { id: 'appearance', label: t('app.pages.appearance'), icon: Palette, content: <AppearancePage /> },
        { id: 'keyboard', label: t('app.pages.keyboard'), icon: Keyboard, content: <KeyboardPage /> },
      ]}
    />
  );
}
