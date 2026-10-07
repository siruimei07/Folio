import { useEffect } from 'react';
import { create } from 'zustand';

import { CommitContextMenu, type CommitMenuRequest, type CommitMenuTrigger, underBox } from '../../app/CommitActions';
import { useWorkspace } from '../../data/workspace';

const useEntryMenu = create<{ menu: CommitMenuRequest | null }>()(() => ({ menu: null }));

function closeEntryMenu(): void {
  useEntryMenu.setState({ menu: null });
}

/**
 * How a commit entry opens its menu (`commitMenuHandlers`): one menu for the timeline, in a store,
 * so it stays open while the entry it came from scrolls out of the virtualised range. From the
 * keyboard it opens under the entry's title.
 */
export const ENTRY_MENU: CommitMenuTrigger = {
  open: (menu) => {
    useEntryMenu.setState({ menu });
  },
  keyboardOpen: () => useEntryMenu.getState().menu?.keyboard === true,
  anchorOf: (entry) => underBox(entry.querySelector('.entry__title')),
};

/**
 * The context menu of a commit entry (handoff workspace-history §7.3): Edit message · Undo commit ·
 * ─ · Copy commit ID, the commands the commit does not take now listed, disabled with the reason.
 */
export function EntryMenu() {
  const menu = useEntryMenu((state) => state.menu);
  const historyState = useWorkspace().data?.historyState;
  // Another library's screen, or the view leaving the window, closes it.
  useEffect(() => closeEntryMenu, []);
  return <CommitContextMenu request={menu} historyState={historyState} onClose={closeEntryMenu} />;
}
