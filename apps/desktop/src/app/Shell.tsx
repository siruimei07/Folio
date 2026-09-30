import './Shell.css';

import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';

import { TitleBar } from '../titlebar/TitleBar';
import { DialogHost } from './DialogHost';
import { useLayout } from './layout';
import { openDialog, showView } from './navigation';
import { Rail } from './Rail';
import { REGISTRY, type ShellRegistry } from './registry';
import { LIBRARY_SETTINGS_KEYS, registerShortcut, SEARCH_KEYS, useShortcut, viewKeys } from './shortcuts';
import { Toolbar } from './Toolbar';
import { ViewHost } from './ViewHost';

export interface ShellProps {
  /** What the shell hosts; the app's registry by default. */
  registry?: ShellRegistry;
  /** This computer's name for the avatar; `null` until the app settings provide it. */
  deviceName?: string | null;
}

/**
 * The window with a library open (app-shell handoff §2): title bar and toolbar, or one 40 px bar
 * in a narrow window; the rail; the content region with the active view; and the dialogs.
 */
export function Shell({ registry = REGISTRY, deviceName = null }: ShellProps) {
  const { t } = useTranslation('common');
  const layout = useLayout();
  const narrow = layout === 'narrow';
  const { views, dialogs } = registry;

  // Ctrl+<key> shows a view; not inside a dialog (UI architecture §6.4).
  useEffect(() => {
    const stops = views.map(({ id, key }) =>
      registerShortcut(viewKeys(key), () => {
        showView(id);
      }),
    );
    return () => {
      stops.forEach((stop) => {
        stop();
      });
    };
  }, [views]);
  useShortcut(
    SEARCH_KEYS,
    dialogs.search
      ? () => {
          openDialog('search');
        }
      : null,
    { inInputs: true },
  );
  useShortcut(
    LIBRARY_SETTINGS_KEYS,
    dialogs.librarySettings
      ? () => {
          openDialog('librarySettings');
        }
      : null,
  );

  return (
    <div className="shell">
      {/* The page's one top heading, for screen readers' heading navigation; the bar shows the name. */}
      <h1 className="visually-hidden">{t('app.name')}</h1>
      <TitleBar variant={narrow ? 'narrow' : 'standard'}>
        {narrow && <Toolbar registry={registry} compact />}
      </TitleBar>
      {!narrow && <Toolbar registry={registry} compact={false} />}
      <div className="shell__body">
        <Rail views={views} dialogs={dialogs} layout={layout} deviceName={deviceName} />
        <main className="shell__content">
          <ViewHost views={views} />
        </main>
      </div>
      <DialogHost dialogs={dialogs} />
    </div>
  );
}
