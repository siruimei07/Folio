import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { I18nProvider } from 'react-aria-components';

import { Announcer } from './app/announcer';
import { ErrorBoundary } from './app/ErrorBoundary';
import { Shell, type ShellProps } from './app/Shell';
import { installShortcuts } from './app/shortcuts';
import { ToastRegion } from './app/ToastRegion';
import { installWindowFailureToasts } from './app/windowErrors';
import { StartGate } from './first-run/StartGate';

/**
 * The app: React Aria in the UI language (its own hidden labels follow it), the window shell once
 * a library is open (the first run and the unavailable library before that), the toasts and the
 * live regions. The keyboard shortcuts and the window command failures are
 * app-wide, so they start here.
 */
export function App(props: ShellProps) {
  const { i18n } = useTranslation();
  useEffect(() => installShortcuts(), []);
  useEffect(() => installWindowFailureToasts(), []);

  return (
    <I18nProvider locale={i18n.language}>
      <ErrorBoundary source="shell">
        <StartGate>
          <Shell {...props} />
        </StartGate>
      </ErrorBoundary>
      <ToastRegion />
      <Announcer />
    </I18nProvider>
  );
}
