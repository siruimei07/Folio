// The actions of "Committed with a template message" (workspace-history handoff §4.3, §11), the
// information toast after a commit with empty fields fell back to the template: "Edit message",
// which opens History's Edit message dialog on the new commit (`app/historyCommands.ts`), while
// that dialog is registered. The message can also be edited in History and in "Not synced", so the
// toast is never its only way.
import i18n from 'i18next';

import { editMessageOf } from '../../app/historyCommands';
import type { ToastAction } from '../../components/Toast/Toast';

/** What the toast offers for the new commit `commit` (its id): "Edit message" when `canEdit`. */
export function fallbackToastActions(commit: string, canEdit: boolean): readonly ToastAction[] {
  if (!canEdit) return [];
  return [
    {
      label: i18n.t('changes:commit.fallback.editMessage'),
      onPress: () => {
        editMessageOf(commit);
      },
    },
  ];
}
