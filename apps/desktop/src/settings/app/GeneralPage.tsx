import { Laptop } from 'lucide-react';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { announce } from '../../app/announcer';
import { Banner } from '../../components/Banner/Banner';
import { PendingButton } from '../../components/Button/PendingButton';
import { Field } from '../../components/Field/Field';
import { Skeleton } from '../../components/Skeleton/Skeleton';
import { checkDisplayName } from '../../data/names';
import { useAppSettings, useUpdateAppSettings } from '../../data/settings';
import type { IpcError } from '../../ipc';
import { SIZE } from '../../tokens/tokens';
import { ipcErrorOf, LoadFailure, useRetryFailed } from '../feedback';
import { useNameMessage } from '../names';
import { Card, Page } from '../parts/Card';

/** The avatar's letter: the name's first character in upper case, as on the rail (§4). */
function initialOf(name: string): string | null {
  return Array.from(name.trim())[0]?.toLocaleUpperCase('en') ?? null;
}

/**
 * App settings → General (app-shell handoff §9; ipc-m1 §22.1): this computer's name, with its
 * avatar letter and Save, and what Folio does with your data. A name the shell would refuse is
 * flagged first; M1 has no way back to the name Windows gives the computer.
 */
export function GeneralPage() {
  const { t } = useTranslation(['settings', 'errors']);
  const settings = useAppSettings();
  const update = useUpdateAppSettings();
  const retry = useRetryFailed();
  const message = useNameMessage();
  // What the user typed; `null` until they type.
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [banner, setBanner] = useState<IpcError | null>(null);
  const [saved, setSaved] = useState(false);
  const input = useRef<HTMLInputElement>(null);

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

  const storedName = settings.data.deviceName ?? '';
  const name = draft ?? storedName;
  const changed = draft !== null && draft.trim() !== storedName;
  const initial = initialOf(name);

  const save = async () => {
    if (update.isPending || !changed) return;
    const code = checkDisplayName(name);
    if (code !== null) {
      setError(message('device', code));
      input.current?.focus();
      return;
    }
    setBanner(null);
    setSaved(false);
    try {
      await update.mutateAsync({ deviceName: name, theme: null, reduceMotion: null });
    } catch (failure: unknown) {
      const shellError = ipcErrorOf(failure);
      const under = message('device', shellError.code);
      if (under === null) setBanner(shellError);
      else setError(under);
      return;
    }
    setDraft(null);
    setSaved(true);
    // Save turns off once the name is saved; focus stays in the page.
    input.current?.focus();
    announce(t('general.device.saved'));
  };

  return (
    <Page>
      <Card>
        <div className="settings-profile">
          <span className="settings-profile__avatar" aria-hidden>
            {initial ?? <Laptop size={SIZE.icon} />}
          </span>
          <div className="settings-profile__field">
            <Field
              label={t('general.device.label')}
              value={name}
              onChange={(value) => {
                setDraft(value);
                setError(null);
                setSaved(false);
              }}
              error={error}
              help={saved ? t('general.device.saved') : t('general.device.help')}
              readOnly={update.isPending}
              inputRef={input}
              onEnter={() => {
                void save();
              }}
              trailing={
                <PendingButton
                  variant="accent"
                  pending={update.isPending ? t('saving') : null}
                  isDisabled={!changed}
                  onPress={() => {
                    void save();
                  }}
                >
                  {t('save')}
                </PendingButton>
              }
            />
          </div>
        </div>
        {banner !== null && (
          <Banner tone="danger" size="block" announce title={t('general.device.failed')} text={t(`errors:${banner.code}`)} />
        )}
      </Card>
      <Card title={t('general.privacy.title')} description={t('general.privacy.text')} />
    </Page>
  );
}
