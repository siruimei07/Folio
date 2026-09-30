import { Laptop, Settings } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from 'react-aria-components';

import { Tooltip } from '../components/Tooltip/Tooltip';
import { SIZE } from '../tokens/tokens';
import type { Layout } from './layout';
import { openDialog, showView, useNavigation } from './navigation';
import type { DialogRegistry, ViewDefinition } from './registry';
import { LIBRARY_SETTINGS_KEYS, useShortcutLabel, viewKeys } from './shortcuts';

export interface RailProps {
  views: readonly ViewDefinition[];
  dialogs: DialogRegistry;
  layout: Layout;
  /** This computer's name, for the avatar; `null` until the app settings know it. */
  deviceName: string | null;
}

/**
 * The rail (app-shell handoff §4, 6A): outlined square buttons for the views, the gear (Library
 * settings) and the avatar (App settings) at the bottom. The active view has `aria-current="page"`
 * and a bar at the window's left edge.
 */
export function Rail({ views, dialogs, layout, deviceName }: RailProps) {
  const { t } = useTranslation('shell');
  const shortcut = useShortcutLabel();
  const active = useNavigation((state) => state.view);
  const dialog = useNavigation((state) => state.dialog?.kind ?? null);
  const iconSize = layout === 'narrow' ? SIZE.icon : SIZE.iconRail;
  const initial = deviceName === null ? null : (Array.from(deviceName.trim())[0]?.toLocaleUpperCase('en') ?? null);

  return (
    <nav className="rail" aria-label={t('rail.label')}>
      {views.map(({ id, icon: Icon, label, key }) => (
        <div key={id} className="rail__slot">
          {id === active && <span className="rail__indicator" aria-hidden />}
          <Tooltip content={t(label)} shortcut={shortcut(viewKeys(key))} placement="end">
            <Button
              className="rail__button"
              aria-label={t(label)}
              aria-current={id === active ? 'page' : undefined}
              data-active={id === active || undefined}
              onPress={() => {
                showView(id);
              }}
            >
              <Icon aria-hidden size={iconSize} />
            </Button>
          </Tooltip>
        </div>
      ))}
      <div className="rail__spacer" />
      {dialogs.librarySettings && (
        <Tooltip content={t('rail.librarySettings')} shortcut={shortcut(LIBRARY_SETTINGS_KEYS)} placement="end">
          <Button
            className="rail__button"
            aria-label={t('rail.librarySettings')}
            aria-haspopup="dialog"
            aria-expanded={dialog === 'librarySettings'}
            data-active={dialog === 'librarySettings' || undefined}
            onPress={() => {
              openDialog('librarySettings');
            }}
          >
            <Settings aria-hidden size={iconSize} />
          </Button>
        </Tooltip>
      )}
      {dialogs.appSettings && (
        <Tooltip
          content={deviceName === null ? t('rail.appSettings') : t('rail.appSettingsOn', { device: deviceName })}
          placement="end"
        >
          <Button
            className="rail__avatar"
            aria-label={deviceName === null ? t('rail.appSettings') : t('rail.appSettingsOn', { device: deviceName })}
            aria-haspopup="dialog"
            aria-expanded={dialog === 'appSettings'}
            data-active={dialog === 'appSettings' || undefined}
            onPress={() => {
              openDialog('appSettings');
            }}
          >
            {initial ?? <Laptop aria-hidden size={SIZE.icon} />}
          </Button>
        </Tooltip>
      )}
    </nav>
  );
}
