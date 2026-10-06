import { type Ref, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { announce } from '../../../app/announcer';
import { Button } from '../../../components/Button/Button';
import { PendingButton } from '../../../components/Button/PendingButton';
import { DialogFrame } from '../../../components/Dialog/Dialog';
import { Field } from '../../../components/Field/Field';
import { Select } from '../../../components/Select/Select';
import { type AiService, aiService, aiServiceAt, removesKey, useUpdateAiSettings } from '../../../data/ai';
import { type AiSettings, DEFAULT_AI_ENDPOINT } from '../../../ipc';
import { ipcErrorOf, showFailure } from '../../feedback';
import { Card } from '../../parts/Card';

/** The fields a Save button saves, each with the code the shell names it by. */
type SavedField = 'address' | 'model';
const FIELD_CODE: Record<SavedField, 'AiEndpointInvalid' | 'AiModelInvalid'> = {
  address: 'AiEndpointInvalid',
  model: 'AiModelInvalid',
};

/** A change of service waiting for the user to confirm that the saved key goes. */
interface Confirming {
  to: AiService;
  /** The select sends DeepSeek's endpoint; the Address field sends what was typed. */
  via: 'select' | 'address';
}

interface ServiceCardProps {
  settings: AiSettings;
  /** The user chose the OpenAI-compatible service and has not saved its address yet. */
  choosingOther: boolean;
  /** Starts or ends that choice; AiPage keeps it, so the key card follows the select too. */
  onChooseOther: (choosing: boolean) => void;
}

/**
 * The service, its address and the model (ipc-m2 §12.1). The service follows the stored endpoint:
 * DeepSeek is exactly `DEFAULT_AI_ENDPOINT`, anything else an OpenAI-compatible service with its
 * own address. Choosing DeepSeek saves at once; choosing the other service shows the address,
 * which its Save button saves. A key belongs to its server, so a change that would delete a saved
 * key asks first (Sirui, 2026-10-05): any endpoint on another origin, whichever service the
 * select shows, since the shell deletes the key in the same update. A change of path on the same
 * origin keeps the key and asks nothing. DeepSeek's own address typed into the Address field, in
 * any spelling the shell stores as `DEFAULT_AI_ENDPOINT`, is a switch to DeepSeek: it asks, words
 * and announces it as one, and leaves focus on the select.
 */
export function ServiceCard({ settings, choosingOther, onChooseOther }: ServiceCardProps) {
  const { t } = useTranslation(['settings', 'errors']);
  const serviceHelp = useId();
  const stored = aiService(settings);
  // What the user typed into each field; `null` until they type.
  const [drafts, setDrafts] = useState<Record<SavedField, string | null>>({ address: null, model: null });
  const [errors, setErrors] = useState<Record<SavedField, string | null>>({ address: null, model: null });
  const [confirming, setConfirming] = useState<Confirming | null>(null);
  const toDeepSeek = useUpdateAiSettings();
  const address = useUpdateAiSettings();
  const model = useUpdateAiSettings();
  const selectRow = useRef<HTMLDivElement>(null);
  const addressInput = useRef<HTMLInputElement>(null);
  const modelInput = useRef<HTMLInputElement>(null);

  const service: AiService = toDeepSeek.isPending ? 'deepseek' : choosingOther ? 'other' : stored;
  const values: Record<SavedField, string> = {
    address: drafts.address ?? (stored === 'other' ? settings.endpoint : ''),
    model: drafts.model ?? settings.model,
  };
  const storedValues: Record<SavedField, string> = { address: settings.endpoint, model: settings.model };
  const changed = (field: SavedField) => {
    const draft = drafts[field]?.trim() ?? null;
    if (draft === null) return false;
    // While the other service is chosen the field starts empty, so any address is a change, even
    // DeepSeek's own (which saves as a switch back to DeepSeek).
    if (field === 'address' && choosingOther) return draft !== '';
    return draft !== storedValues[field];
  };
  // The Service select's button: where focus goes when the Address field leaves the page.
  const focusService = () => {
    selectRow.current?.querySelector('button')?.focus();
  };

  const type = (field: SavedField, value: string) => {
    setDrafts((current) => ({ ...current, [field]: value }));
    setErrors((current) => ({ ...current, [field]: null }));
  };
  const forget = (field: SavedField) => {
    setDrafts((current) => ({ ...current, [field]: null }));
    setErrors((current) => ({ ...current, [field]: null }));
  };
  // The answer says whether a key is still saved; only the shell knows which servers match.
  const savedMessage = (saved: string, removed: string, answer: AiSettings) =>
    settings.hasKey && !answer.hasKey ? removed : saved;
  const announceSwitched = (answer: AiSettings) => {
    announce(savedMessage(t('ai.choose.switched'), t('ai.choose.switchedKeyRemoved'), answer));
  };

  const switchToDeepSeek = async () => {
    try {
      const answer = await toDeepSeek.mutateAsync({ endpoint: DEFAULT_AI_ENDPOINT });
      forget('address');
      announceSwitched(answer);
    } catch (failure: unknown) {
      showFailure(t('ai.choose.failed'), ipcErrorOf(failure), 'settings.ai');
    }
  };

  const choose = (next: AiService) => {
    // A change of service is saving: its answer decides the service, so another pick now would be
    // overridden by it (or would end the choice whose address is saving). The select keeps showing
    // the service being saved; it stays enabled so it keeps focus.
    if (next === service || address.isPending || toDeepSeek.isPending) return;
    if (next === 'other') {
      onChooseOther(true);
      return;
    }
    if (stored === 'deepseek') {
      // Back from an address not saved yet: nothing was stored.
      onChooseOther(false);
      forget('address');
    } else if (removesKey(settings, DEFAULT_AI_ENDPOINT)) setConfirming({ to: 'deepseek', via: 'select' });
    else void switchToDeepSeek();
  };

  const save = async (field: SavedField, confirmed = false) => {
    const mutation = field === 'address' ? address : model;
    const input = field === 'address' ? addressInput : modelInput;
    if (mutation.isPending || !changed(field)) return;
    if (field === 'address' && !confirmed && removesKey(settings, drafts.address ?? '')) {
      setConfirming({ to: aiServiceAt(drafts.address ?? ''), via: 'address' });
      return;
    }
    const value = drafts[field] ?? '';
    setErrors((current) => ({ ...current, [field]: null }));
    let answer: AiSettings;
    try {
      answer = await mutation.mutateAsync(field === 'address' ? { endpoint: value } : { model: value });
    } catch (failure: unknown) {
      const error = ipcErrorOf(failure);
      if (error.code === FIELD_CODE[field]) {
        setErrors((current) => ({ ...current, [field]: t(`errors:${FIELD_CODE[field]}`) }));
        input.current?.focus();
      } else showFailure(t(`ai.${field}.failed`), error, 'settings.ai');
      return;
    }
    forget(field);
    if (field === 'address' && aiService(answer) === 'deepseek') {
      // DeepSeek's own address, in whatever spelling: the page goes back to DeepSeek and the
      // Address field leaves it, so focus moves to the select first. With the endpoint unchanged
      // (the shell stored the same address), nothing else would end the choice of the other service.
      focusService();
      onChooseOther(false);
      announceSwitched(answer);
      return;
    }
    // Save turns off once the value is saved; focus stays in the field. The field stays on screen:
    // a new endpoint ends the choice of the other service only once it reaches AiPage.
    input.current?.focus();
    if (field === 'model') {
      announce(t('ai.model.saved'));
      return;
    }
    announce(savedMessage(t('ai.address.saved'), t('ai.address.savedKeyRemoved'), answer));
  };

  return (
    <Card>
      <div className="settings-fields">
        <div className="settings-select-field">
          <div className="settings-select-field__row" ref={selectRow}>
            <Select
              label={t('ai.choose.label')}
              aria-describedby={serviceHelp}
              options={[
                { id: 'deepseek', label: t('ai.choose.options.deepseek') },
                { id: 'other', label: t('ai.choose.options.other') },
              ]}
              selected={service}
              onChange={choose}
            />
          </div>
          <p id={serviceHelp} className="field__help">
            {t('ai.choose.help')}
          </p>
        </div>
        {service === 'other' && (
          <SaveField
            label={t('ai.address.label')}
            value={values.address}
            error={errors.address}
            pending={address.isPending ? t('saving') : null}
            changed={changed('address')}
            saveLabel={t('save')}
            onChange={(value) => {
              type('address', value);
            }}
            onSave={() => {
              void save('address');
            }}
            inputRef={addressInput}
            mono
            help={settings.hasKey ? t('ai.address.helpKey') : t('ai.address.help')}
          />
        )}
        <SaveField
          label={t('ai.model.label')}
          value={values.model}
          error={errors.model}
          pending={model.isPending ? t('saving') : null}
          changed={changed('model')}
          saveLabel={t('save')}
          onChange={(value) => {
            type('model', value);
          }}
          onSave={() => {
            void save('model');
          }}
          inputRef={modelInput}
          help={t('ai.model.help')}
        />
      </div>
      {confirming !== null && (
        <ConfirmServiceDialog
          to={confirming.to}
          from={stored}
          onCancel={() => {
            setConfirming(null);
          }}
          onConfirm={() => {
            setConfirming(null);
            if (confirming.via === 'select') void switchToDeepSeek();
            else void save('address', true);
          }}
        />
      )}
    </Card>
  );
}

interface SaveFieldProps {
  label: string;
  value: string;
  error: string | null;
  /** "Saving…" while the save runs. */
  pending: string | null;
  /** Save is on only when the field differs from what is stored. */
  changed: boolean;
  saveLabel: string;
  onChange: (value: string) => void;
  onSave: () => void;
  help?: string;
  mono?: boolean;
  inputRef?: Ref<HTMLInputElement>;
}

/** A field with Save after it (app-shell handoff §9 "Fields"); Enter saves too. */
function SaveField({ pending, changed, saveLabel, onSave, ...field }: SaveFieldProps) {
  return (
    <Field
      {...field}
      readOnly={pending !== null}
      onEnter={onSave}
      trailing={
        <PendingButton variant="accent" pending={pending} isDisabled={!changed} onPress={onSave}>
          {saveLabel}
        </PendingButton>
      }
    />
  );
}

/**
 * Asks before a change of service deletes the saved key (Sirui, 2026-10-05): an alert dialog,
 * read with its description (what goes), then what to do next; Cancel has the focus, and Cancel,
 * Esc and × change nothing.
 */
function ConfirmServiceDialog({
  to,
  from,
  onCancel,
  onConfirm,
}: {
  to: AiService;
  /** The stored service, whose key goes. */
  from: AiService;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { t } = useTranslation('settings');
  const words = to === 'deepseek' ? 'toDeepSeek' : 'toOther';
  return (
    <DialogFrame
      isOpen
      role="alertdialog"
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
      title={t(`ai.choose.confirm.${words}.title`)}
      description={t(`ai.choose.confirm.removes.${from}`)}
      footer={
        <>
          <Button size="dialog" autoFocus onPress={onCancel}>
            {t('cancel')}
          </Button>
          <Button size="dialog" variant="danger" onPress={onConfirm}>
            {t('ai.choose.confirm.confirm')}
          </Button>
        </>
      }
    >
      <p className="settings-dialog-text">{t(`ai.choose.confirm.${words}.next`)}</p>
    </DialogFrame>
  );
}
