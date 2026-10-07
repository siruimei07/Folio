import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { create } from 'zustand';

import type { CommitRef, DiffRestore } from '../../app/panes';
import { ContextMenu, Menu, type MenuAnchor } from '../../components/Menu/Menu';
import { useWorkspace } from '../../data/workspace';
import { nameOf } from '../../lib/paths';
import { type CardRow, copyablePath } from '../model/rows';
import type { CurrentVersion } from '../model/timelineRows';
import { isCurrentVersion, NO_RESTORE, restoreOffer, versionOfRow } from '../restore/restorable';
import { askRestore } from '../restore/state';
import { FileMenuItems } from './FileMenuItems';

interface RowMenuState {
  anchor: MenuAnchor;
  /** The version's commit and the row whose file the menu acts on. */
  commit: CommitRef;
  row: CardRow;
  /** Opened by Shift+F10 or the Menu key: the first item takes the focus, and the browser's own `contextmenu` that follows is ignored. */
  keyboard: boolean;
  /** The row that had the focus when the menu opened, where a restore confirmation gives it back. */
  returnTo: HTMLElement | null;
}

const useRowMenu = create<{ menu: RowMenuState | null }>()(() => ({ menu: null }));

export function openRowMenu(menu: Omit<RowMenuState, 'returnTo'>): void {
  const focused = document.activeElement;
  useRowMenu.setState({ menu: { ...menu, returnTo: focused instanceof HTMLElement ? focused : null } });
}

function closeRowMenu(): void {
  useRowMenu.setState({ menu: null });
}

/** A menu Shift+F10 or the Menu key opened is up: the `contextmenu` event on the row is its echo. */
export function keyboardMenuOpen(): boolean {
  return useRowMenu.getState().menu?.keyboard === true;
}

/**
 * "Restore this version…" of the menu's row (§7.3): disabled for the version the file has now, with
 * "Current version" as its note (a menu's note stays short, decision 34); the confirmation gives the
 * focus back to the row.
 */
function useRowRestore(menu: RowMenuState | null, current: CurrentVersion | null): DiffRestore | undefined {
  const { t } = useTranslation('history');
  const historyState = useWorkspace().data?.historyState;
  if (menu === null) return undefined;
  const { commit, row, returnTo } = menu;
  const version = versionOfRow(commit, row);
  const offer = restoreOffer(row, isCurrentVersion(commit, row, current), historyState);
  if (offer === null || version === null) return undefined;
  if (offer === 'current') return { onRestore: NO_RESTORE, disabledReason: t('file.current') };
  if (offer === 'readOnly') return { onRestore: NO_RESTORE, disabledReason: t('restore.readOnlyNote') };
  if (offer === 'damaged') return { onRestore: NO_RESTORE, disabledReason: t('restore.damagedNote') };
  return {
    onRestore: () => {
      askRestore({
        version,
        versionMs: Number(commit.timeMs),
        refocus: () => {
          if (returnTo?.isConnected === true) returnTo.focus();
        },
      });
    },
  };
}

export interface RowMenuProps {
  /** One file's history: the version the file has now, whose "Restore this version…" is disabled. */
  current: CurrentVersion | null;
}

/**
 * The context menu of a card row (handoff workspace-history §7.3, library-actions §2.7): at the
 * pointer on a right-click, under the row's path on Shift+F10 or the Menu key. Closing returns
 * the focus to the row.
 */
export function RowMenu({ current }: RowMenuProps) {
  const { t } = useTranslation('history');
  const menu = useRowMenu((state) => state.menu);
  const restore = useRowRestore(menu, current);
  // Another library's screen, or the view leaving the window, closes it.
  useEffect(() => closeRowMenu, []);
  const label = t('files.menu', { name: menu === null ? '' : nameOf(copyablePath(menu.row) ?? '') });
  return (
    <ContextMenu anchor={menu?.anchor ?? null} onClose={closeRowMenu} label={label}>
      {menu !== null && (
        <Menu aria-label={label} autoFocus={menu.keyboard ? 'first' : true}>
          <FileMenuItems commit={menu.commit} row={menu.row} restore={restore} />
        </Menu>
      )}
    </ContextMenu>
  );
}
