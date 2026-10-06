import { useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Skeleton } from '../../components/Skeleton/Skeleton';
import { Switch } from '../../components/Switch/Switch';
import { aiService, useAiSettings, useUpdateAiSettings } from '../../data/ai';
import { ipcErrorOf, LoadFailure, showFailure, useRetryFailed } from '../feedback';
import { Card, Page, Row, Rows } from '../parts/Card';
import { KeyCard } from './ai/KeyCard';
import { ServiceCard } from './ai/ServiceCard';

/** The switches on this page, each saving its own field. */
type SwitchField = 'enabled' | 'sendContent';

/**
 * App settings → AI (app-shell handoff §9; ipc-m2 §12; versioning §12): whether AI writes commit
 * messages, the service and model (`ServiceCard`), the write-only API key (`KeyCard`), and whether
 * changed text is sent. Each switch saves its own field and shows the choice
 * until the save answers; a failed save puts the switch back and says so. The controls stay usable
 * while AI is off (Sirui, 2026-10-05).
 */
export function AiPage() {
  const { t } = useTranslation('settings');
  const settings = useAiSettings();
  const update = useUpdateAiSettings();
  const retry = useRetryFailed();
  const enabledDescription = useId();
  // The choice made, shown until the save answers.
  const [pending, setPending] = useState<Partial<Record<SwitchField, boolean>>>({});
  // Counts each switch's saves: only the latest one ends its pending value.
  const saves = useRef<Record<SwitchField, number>>({ enabled: 0, sendContent: 0 });
  // The endpoint on which the user chose "OpenAI-compatible service" in the select, before its
  // address is saved. The choice holds only while that endpoint is stored: saving the address (or
  // any change of endpoint, here or elsewhere) ends it. Saving DeepSeek's own address changes no
  // endpoint, so ServiceCard ends the choice itself then.
  const [otherAt, setOtherAt] = useState<string | null>(null);

  if (settings.error !== null) {
    return (
      <Page>
        <LoadFailure title={t('ai.loadFailed')} error={settings.error.error} retry={retry} />
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

  if (otherAt !== null && otherAt !== settings.data.endpoint) setOtherAt(null);
  const endpoint = settings.data.endpoint;
  // The whole page speaks for the service the select shows, saved or not.
  const choosingOther = otherAt === endpoint;
  const shown = choosingOther ? 'other' : aiService(settings.data);

  const change = (field: SwitchField, value: boolean) => {
    setPending((current) => ({ ...current, [field]: value }));
    saves.current[field] += 1;
    const save = saves.current[field];
    update
      .mutateAsync({ [field]: value })
      // An answer goes into the cache (useUpdateAiSettings), which the switch then shows.
      .catch((failure: unknown) => {
        showFailure(t(`ai.${field}.${value ? 'failedOn' : 'failedOff'}`), ipcErrorOf(failure), 'settings.ai');
      })
      .finally(() => {
        if (save === saves.current[field]) setPending((current) => ({ ...current, [field]: undefined }));
      });
  };

  const enabled = pending.enabled ?? settings.data.enabled;
  const sendContent = pending.sendContent ?? settings.data.sendContent;
  const service = t(`ai.service.${shown}`);

  return (
    <Page>
      <Card
        title={t('ai.enabled.label')}
        description={<span id={enabledDescription}>{t('ai.enabled.description', { service })}</span>}
        action={
          <Switch
            label={t('ai.enabled.label')}
            aria-describedby={enabledDescription}
            isSelected={enabled}
            onChange={(value) => {
              change('enabled', value);
            }}
          />
        }
      />
      <ServiceCard
        settings={settings.data}
        choosingOther={choosingOther}
        onChooseOther={(choosing) => {
          setOtherAt(choosing ? endpoint : null);
        }}
      />
      {choosingOther ? (
        // A key goes with the address it was saved for (ipc-m2 §12.2): none until there is one.
        <Card title={t('ai.key.title.other')} description={t('ai.key.addressFirst')} />
      ) : (
        // Keyed by endpoint: a change of service drops a typed key and any message about it.
        <KeyCard key={endpoint} settings={settings.data} />
      )}
      <Rows>
        <Row
          label={t('ai.sendContent.label')}
          description={t('ai.sendContent.description')}
          control={({ description }) => (
            <Switch
              label={t('ai.sendContent.label')}
              aria-describedby={description}
              isSelected={sendContent}
              onChange={(value) => {
                change('sendContent', value);
              }}
            />
          )}
        />
      </Rows>
    </Page>
  );
}
