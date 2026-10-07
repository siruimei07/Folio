import { type Ref, useImperativeHandle, useRef } from 'react';
import { useTranslation } from 'react-i18next';

import { useFileActions } from '../app/fileActions';
import { DIFF_PANE, type DiffPaneHandle } from '../app/panes';
import { useWorkspace } from '../data/workspace';
import { FileMenuItems, hasFileMenu } from './menus/FileMenuItems';
import { type HistorySelection, selectionTarget } from './model/selection';
import { NO_RESTORE, restoreOffer, versionOfRow } from './restore/restorable';
import { askRestore } from './restore/state';

export interface HistoryDiffProps {
  selection: HistorySelection;
  /** One file's history: the selected row is the version the file has now ("Current version", §7.4). */
  current?: boolean;
  /** Narrow window: "Back to history" first in the header; Esc and Alt+Left go back too (§2.2). */
  onBack?: () => void;
  ref?: Ref<DiffPaneHandle>;
}

/**
 * The diff column of History (handoff workspace-history §6, §7.2): the shared diff pane
 * (`DIFF_PANE`, diff/README.md) for the selected row's version, with History's file actions in its
 * "More" (§7.3) and "Open with default app" for the file the version belongs to now, which the pane
 * looks up. "Restore" on a stored text or Word version opens the confirmation (§8); in one file's
 * history the current version's is disabled with the reason, and every version's while the history
 * is read-only or damaged (§7.3, §7.5). The focus goes back to Restore when the confirmation closes.
 */
export function HistoryDiff({ selection, current = false, onBack, ref }: HistoryDiffProps) {
  const { t } = useTranslation('history');
  const actions = useFileActions();
  const pane = useRef<DiffPaneHandle>(null);
  useImperativeHandle(
    ref,
    () => ({
      focus: () => pane.current?.focus(),
      focusRestore: () => pane.current?.focusRestore(),
    }),
    [],
  );
  const Diff = DIFF_PANE;
  const version = versionOfRow(selection.commit, selection.row);
  const ask = () => {
    if (version === null) return;
    askRestore({
      version,
      versionMs: Number(selection.commit.timeMs),
      refocus: () => pane.current?.focusRestore(),
    });
  };
  const offer = restoreOffer(selection.row, current, useWorkspace().data?.historyState);
  return (
    <section className="history-diff" aria-label={t('diff.label')}>
      <Diff
        ref={pane}
        target={selectionTarget(selection)}
        actions={{ open: actions.open }}
        moreItems={hasFileMenu(selection.row) ? <FileMenuItems commit={selection.commit} row={selection.row} inDiff /> : undefined}
        back={onBack === undefined ? undefined : { label: t('diff.back'), onBack }}
        restore={
          offer === null
            ? undefined
            : offer === 'current'
              ? { onRestore: NO_RESTORE, disabledReason: t('file.currentRestore') }
              : offer === 'readOnly' || offer === 'damaged'
                ? { onRestore: NO_RESTORE, disabledReason: t(`restore.${offer}`) }
                : { onRestore: ask }
        }
      />
    </section>
  );
}
