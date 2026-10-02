import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { announce } from '../../app/announcer';
import { Banner } from '../../components/Banner/Banner';
import { Button } from '../../components/Button/Button';
import { PendingButton } from '../../components/Button/PendingButton';
import { ColourButton } from '../../components/ColourButton/ColourButton';
import { DialogFrame } from '../../components/Dialog/Dialog';
import { Field } from '../../components/Field/Field';
import { checkDisplayName, nextColor } from '../../data/names';
import { useCreateTag, useUpdateTag } from '../../data/tags';
import type { IpcError, Tag } from '../../ipc';
import { isPaletteColor, type PaletteColor } from '../../lib/palette';
import { ipcErrorOf, showGone } from '../feedback';
import { useNameMessage } from '../names';

export interface TagDialogProps {
  /** The tag to edit; `null` for a new tag. */
  tag: Tag | null;
  /** Every tag, to flag a name that is taken and to give a new tag an unused colour. */
  tags: readonly Tag[];
  onClose: () => void;
}

/**
 * "New tag" and "Edit…" (app-shell handoff §9, ipc-m1 §8): the tag's name and colour. A name that
 * another tag has, ignoring case, is flagged before anything is sent; the shell checks again.
 */
export function TagDialog({ tag, tags, onClose }: TagDialogProps) {
  const { t } = useTranslation(['settings', 'errors', 'common']);
  const message = useNameMessage();
  const create = useCreateTag();
  const update = useUpdateTag();
  const [name, setName] = useState(tag?.name ?? '');
  const [color, setColor] = useState<PaletteColor>(() =>
    tag !== null && isPaletteColor(tag.color) ? tag.color : nextColor(tags.map((other) => other.color)),
  );
  const [error, setError] = useState<string | null>(null);
  const [banner, setBanner] = useState<IpcError | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const saving = create.isPending || update.isPending;

  const save = async () => {
    if (saving) return;
    const typed = name.trim();
    const taken = tags.some((other) => other.id !== tag?.id && other.name.toLocaleLowerCase('en') === typed.toLocaleLowerCase('en'));
    const code = checkDisplayName(name) ?? (taken ? 'AlreadyExists' : null);
    if (code !== null) {
      setError(message('tag', code, { name: typed }));
      input.current?.focus();
      return;
    }
    setBanner(null);
    try {
      if (tag === null) await create.mutateAsync({ name, color });
      else await update.mutateAsync({ id: tag.id, name, color });
    } catch (failure: unknown) {
      const shellError = ipcErrorOf(failure);
      if (shellError.code === 'NotFound') {
        // The tag went away meanwhile: the list has been refreshed (library-actions §9.4).
        showGone(shellError);
        onClose();
        return;
      }
      const under = message('tag', shellError.code, { name: typed });
      if (under === null) setBanner(shellError);
      else {
        setError(under);
        input.current?.focus();
      }
      return;
    }
    announce(tag === null ? t('tagDialog.created', { tag: typed }) : t('tagDialog.saved', { tag: typed }));
    onClose();
  };

  return (
    <DialogFrame
      isOpen
      onOpenChange={(open) => {
        if (!open && !saving) onClose();
      }}
      title={tag === null ? t('tagDialog.newTitle') : t('tagDialog.editTitle', { tag: tag.name })}
      banner={
        banner === null ? undefined : (
          <Banner
            tone="danger"
            size="block"
            announce
            title={tag === null ? t('tagDialog.createFailed') : t('tagDialog.saveFailed')}
            text={t(`errors:${banner.code}`)}
          />
        )
      }
      footer={
        <>
          <Button size="dialog" onPress={onClose} isDisabled={saving}>
            {t('cancel')}
          </Button>
          <PendingButton
            variant="accent"
            pending={saving ? (tag === null ? t('tagDialog.creating') : t('saving')) : null}
            onPress={() => {
              void save();
            }}
          >
            {tag === null ? t('tagDialog.create') : t('save')}
          </PendingButton>
        </>
      }
    >
      <div className="settings-dialog-row" data-colour>
        <Field
          label={t('tagDialog.name')}
          value={name}
          onChange={(value) => {
            setName(value);
            setError(null);
          }}
          error={error}
          readOnly={saving}
          inputRef={input}
          autoFocus
          onEnter={() => {
            void save();
          }}
        />
        <div className="settings-colour-field">
          <span className="field__label" aria-hidden>
            {t('tagDialog.colour')}
          </span>
          <ColourButton
            label={t('tagDialog.colourLabel', { colour: t(`common:colour.names.${color}`) })}
            color={color}
            onChange={setColor}
            isDisabled={saving}
          />
        </div>
      </div>
    </DialogFrame>
  );
}
