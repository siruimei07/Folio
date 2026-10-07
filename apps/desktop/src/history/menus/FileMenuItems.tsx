import { Copy, ExternalLink, FolderSearch, History, RotateCcw } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { COPY_PATH_KEYS, useFileActions } from '../../app/fileActions';
import type { CommitRef, DiffRestore } from '../../app/panes';
import { useShortcutLabel } from '../../app/shortcuts';
import { MenuItem, MenuSeparator } from '../../components/Menu/Menu';
import { useLocatedVersion } from '../../data/diff';
import { type CardRow, copyablePath } from '../model/rows';
import { showFileHistory } from '../state';

/** Whether a row has file actions: every row that names a file or folder (not a settings change). */
export function hasFileMenu(row: CardRow): boolean {
  return copyablePath(row) !== null;
}

export interface FileMenuItemsProps {
  /** The version's commit. */
  commit: CommitRef;
  row: CardRow;
  /** In the diff's "More": "View history of this file" leaves the focus in the diff. */
  inDiff?: boolean;
  /**
   * The row's menu: "Restore this version…" after a separator (§7.3), disabled with the reason as
   * its note for the version the file has now. The diff has its own "Restore".
   */
  restore?: DiffRestore;
}

/**
 * The actions on a card row's file (handoff workspace-history §7.3), in its context menu and the
 * diff's "More": Open with default app and Show in File Explorer of the file the version belongs
 * to now (`locate_version`), View history of this file (here, in place of the whole history; from a
 * row its newest entry takes the focus, from the diff the focus stays), Copy path (the row's path as
 * it was, Ctrl+Shift+C). Open and Show stay listed, disabled with the reason as their note, while the file
 * is looked up, when it has been deleted since, or when the lookup failed (diff/README "For the
 * host lanes"). A row that deletes the file names no version to look up or follow: those three say
 * "Deleted". A folder, or a file's or folder's tags (a commit's tag rows name no version of the
 * file), has only Copy path; a settings change has none. The row's menu ends with "Restore this
 * version…" for a version History restores (`restore`). Put them in a `Menu`.
 */
export function FileMenuItems({ commit, row, inDiff = false, restore }: FileMenuItemsProps) {
  const { t } = useTranslation('history');
  const shortcut = useShortcutLabel();
  const actions = useFileActions();
  const path = copyablePath(row);
  const file = row.kind === 'file' && row.row.kind === 'file' ? row.row : null;
  const deleted = file?.change === 'deleted';
  const located = useLocatedVersion(file === null || deleted ? null : { commit: commit.id, path: file.path });
  if (path === null) return null;
  const copy = (
    <MenuItem
      id="copyPath"
      icon={Copy}
      shortcut={shortcut(COPY_PATH_KEYS)}
      onAction={() => {
        actions.copyPaths([path]);
      }}
    >
      {t('files.copyPath')}
    </MenuItem>
  );
  if (file === null) return copy;

  const found = located.data;
  const entry = found === undefined || found === null ? null : { id: found.id, path: found.path };
  let reason: string | undefined;
  if (deleted) reason = t('files.deleted');
  else if (entry === null) {
    if (located.error !== null) reason = t('files.lookupFailed');
    else if (found === null) reason = t('files.deletedSince');
    else reason = t('files.locating');
  }
  return (
    <>
      <MenuItem
        id="open"
        icon={ExternalLink}
        isDisabled={entry === null}
        note={reason}
        onAction={() => {
          if (entry !== null) actions.open(entry);
        }}
      >
        {t('files.open')}
      </MenuItem>
      <MenuItem
        id="reveal"
        icon={FolderSearch}
        isDisabled={entry === null}
        note={reason}
        onAction={() => {
          if (entry !== null) actions.showInExplorer(entry);
        }}
      >
        {t('files.reveal')}
      </MenuItem>
      <MenuItem
        id="viewHistory"
        icon={History}
        isDisabled={deleted}
        note={deleted ? reason : undefined}
        onAction={() => {
          if (!deleted) showFileHistory({ kind: 'version', commit: commit.id, path: file.path }, !inDiff);
        }}
      >
        {t('files.viewHistory')}
      </MenuItem>
      {copy}
      {restore !== undefined && (
        <>
          <MenuSeparator />
          <MenuItem
            id="restore"
            icon={RotateCcw}
            isDisabled={restore.disabledReason !== undefined}
            note={restore.disabledReason}
            onAction={restore.onRestore}
          >
            {t('files.restore')}
          </MenuItem>
        </>
      )}
    </>
  );
}
