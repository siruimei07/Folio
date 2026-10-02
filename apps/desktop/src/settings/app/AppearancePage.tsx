import '../../components/palette.css';

import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { applyAppearance } from '../../app/appearance';
import { SegmentedControl } from '../../components/SegmentedControl/SegmentedControl';
import { Select } from '../../components/Select/Select';
import { Skeleton } from '../../components/Skeleton/Skeleton';
import { useAppSettings, useUpdateAppSettings } from '../../data/settings';
import type { ReduceMotion, Theme, UpdateAppSettings } from '../../ipc';
import { PALETTE } from '../../lib/palette';
import { ipcErrorOf, LoadFailure, showFailure, useRetryFailed } from '../feedback';
import { Card, Page, Row, Rows } from '../parts/Card';

const THEMES = ['light', 'dark', 'system'] as const satisfies readonly Theme[];
const MOTIONS = ['system', 'on', 'off'] as const satisfies readonly ReduceMotion[];

/**
 * App settings → Appearance (app-shell handoff §9; ipc-m1 §22.1): the theme and reduce motion,
 * which apply at once (`data-theme`, `data-reduce-motion`), and the ten course and tag colours.
 * Each control saves its own field; a failed save puts the control back and says so.
 */
export function AppearancePage() {
  const { t } = useTranslation(['settings', 'common']);
  const settings = useAppSettings();
  const update = useUpdateAppSettings();
  const retry = useRetryFailed();
  // The choice made, shown until the save answers.
  const [pending, setPending] = useState<Partial<Pick<UpdateAppSettings, 'theme' | 'reduceMotion'>>>({});
  // Counts each control's saves: only the latest one restyles the page and ends its pending value.
  const saves = useRef({ theme: 0, reduceMotion: 0 });

  if (settings.error !== null) {
    return (
      <Page>
        <LoadFailure title={t('general.loadFailed')} error={settings.error.error} retry={retry} />
      </Page>
    );
  }
  if (settings.data === undefined) {
    return (
      <Page>
        <Skeleton rows={3} />
      </Page>
    );
  }

  const change = (field: 'theme' | 'reduceMotion', value: Theme | ReduceMotion) => {
    setPending((current) => ({ ...current, [field]: value }));
    saves.current[field] += 1;
    const save = saves.current[field];
    const latest = () => save === saves.current[field];
    const request: UpdateAppSettings = { deviceName: null, theme: null, reduceMotion: null, [field]: value };
    update
      .mutateAsync(request)
      .then(
        // The page restyles at once; AppSettingsChanged says the same a moment later.
        (saved) => {
          if (latest()) applyAppearance(saved);
        },
        (failure: unknown) => {
          showFailure(t('appearance.failed'), ipcErrorOf(failure), 'settings.appearance');
        },
      )
      .finally(() => {
        if (latest()) setPending((current) => ({ ...current, [field]: undefined }));
      });
  };

  const theme = pending.theme ?? settings.data.theme;
  const motion = pending.reduceMotion ?? settings.data.reduceMotion;

  return (
    <Page>
      <Rows>
        <Row
          label={t('appearance.theme.label')}
          description={t('appearance.theme.description')}
          control={() => (
            <SegmentedControl
              label={t('appearance.theme.label')}
              segments={THEMES.map((id) => ({ id, label: t(`appearance.theme.${id}`) }))}
              selected={theme}
              onChange={(id) => {
                change('theme', id);
              }}
            />
          )}
        />
        <Row
          label={t('appearance.motion.label')}
          description={t('appearance.motion.description')}
          control={({ description }) => (
            <Select
              label={t('appearance.motion.label')}
              labelHidden
              aria-describedby={description}
              options={MOTIONS.map((id) => ({ id, label: t(`appearance.motion.${id}`) }))}
              selected={motion}
              onChange={(id) => {
                change('reduceMotion', id);
              }}
            />
          )}
        />
      </Rows>
      <Card title={t('appearance.colours.title')} description={t('appearance.colours.description')}>
        <ul className="settings-swatches" aria-label={t('appearance.colours.label')}>
          {PALETTE.map((color) => (
            <li key={color} className="settings-swatch">
              <span className="settings-swatch__dot" data-palette={color} aria-hidden />
              <span className="settings-swatch__name">{t(`common:colour.names.${color}`)}</span>
            </li>
          ))}
        </ul>
      </Card>
    </Page>
  );
}
