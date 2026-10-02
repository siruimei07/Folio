import { useTranslation } from 'react-i18next';

import { showToast } from '../../app/toasts';
import { Button } from '../../components/Button/Button';
import { PendingButton } from '../../components/Button/PendingButton';
import { DialogFrame } from '../../components/Dialog/Dialog';
import { useDeleteTag } from '../../data/tags';
import type { Tag } from '../../ipc';
import { ipcErrorOf, showFailure } from '../feedback';

/**
 * Deleting a tag asks first (library-actions §1: what cannot be restored from the Recycle Bin
 * asks): the tag comes off every file and folder that has it; the files stay. Cancel has the
 * focus. A toast says how many lost it.
 */
export function DeleteTagDialog({ tag, onClose }: { tag: Tag; onClose: () => void }) {
  const { t } = useTranslation('settings');
  const remove = useDeleteTag();

  const confirm = async () => {
    try {
      const { assignments } = await remove.mutateAsync({ id: tag.id });
      showToast({
        tone: 'success',
        title:
          assignments === 0
            ? t('deleteTag.doneUnused', { tag: tag.name })
            : t('deleteTag.done', { tag: tag.name, count: assignments }),
      });
    } catch (failure: unknown) {
      showFailure(t('deleteTag.failed', { tag: tag.name }), ipcErrorOf(failure), 'settings.deleteTag');
    }
    onClose();
  };

  return (
    <DialogFrame
      isOpen
      onOpenChange={(open) => {
        if (!open && !remove.isPending) onClose();
      }}
      title={t('deleteTag.title', { tag: tag.name })}
      footer={
        <>
          <Button size="dialog" autoFocus onPress={onClose} isDisabled={remove.isPending}>
            {t('cancel')}
          </Button>
          <PendingButton
            variant="danger"
            pending={remove.isPending ? t('deleteTag.deleting') : null}
            onPress={() => {
              void confirm();
            }}
          >
            {t('deleteTag.confirm')}
          </PendingButton>
        </>
      }
    >
      <p className="settings-dialog-text">
        {tag.usage === 0 ? t('deleteTag.textUnused') : t('deleteTag.text', { count: tag.usage })}
      </p>
    </DialogFrame>
  );
}
