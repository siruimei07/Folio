// The actions on a commit where a commit is listed (workspace-history handoff §5, §7.3): History's
// entries and the Changes view's "Not synced" card. Outline icon buttons that show while the
// pointer is over the commit or the focus is in it, and the items of the commit's context menu.
// They act through `historyCommands.ts`.
import './CommitActions.css';

import { Copy, Pencil, Undo2 } from 'lucide-react';
import { type KeyboardEvent, type MouseEvent, type ReactNode, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { IconButton } from '../components/IconButton/IconButton';
import { ContextMenu, isContextMenuKey, Menu, type MenuAnchor, MenuItem, MenuSeparator } from '../components/Menu/Menu';
import type { CommitInfo, HistoryState } from '../ipc';
import { useCanOpenDialog } from './navigation';
import {
  copyCommitId,
  editMessage,
  hidesButton,
  rewordRefusal,
  rewordRefusalNote,
  rewordRefusalText,
  uncommitRefusal,
  uncommitRefusalNote,
  uncommitRefusalText,
  useUndoCommit,
} from './historyCommands';

/**
 * The class of the element whose hover or focus-within shows its commit's buttons: an entry, a
 * commit row. Until then the buttons are unseen but stay in the tab order (CommitActions.css), so
 * Tab reaches them in their place and a dialog they opened can give the focus back to them (§7.6;
 * actions.test.tsx checks the stylesheet). The Not synced card alone takes them out of the layout
 * until shown (NotSynced.css), and Edit message gives the focus to the commit's row there.
 */
export const COMMIT_ACTIONS_HOST = 'commit-actions-host';

/** On each host: the commit's id, for `focusCommit`. */
export const COMMIT_ATTRIBUTE = 'data-commit';

/**
 * Puts the focus on the shown element of commit `id` (a History entry, a Not synced commit), as
 * Edit message does once the commit has its new id and the element it came from has gone. Returns
 * whether one took the focus: a hidden view's elements are not shown, and one the browser refuses
 * it to (History's list under a narrow window's diff, `visibility: hidden`) does not count.
 */
export function focusCommit(id: string): boolean {
  const hosts = document.querySelectorAll<HTMLElement>(`.${COMMIT_ACTIONS_HOST}[${COMMIT_ATTRIBUTE}="${CSS.escape(id)}"]`);
  for (const host of hosts) {
    if (isHidden(host)) continue;
    host.focus();
    if (document.activeElement === host) return true;
  }
  return false;
}

/** How long `focusCommitWhenShown` waits for the commit's element: the refresh that brings it. */
const COMMIT_SHOWN_WAIT_MS = 3000;

/**
 * `focusCommit` once the commit's element shows, as long as the focus is still where the dialog that
 * changed the commit left it: the history may still be refreshing when that dialog has closed. That
 * is the page, or the element React Aria gave the focus back to (the commit's old element, which the
 * refresh replaces); when that element goes, wherever a list's own focus keeper moved the focus
 * meanwhile still counts, so the answer and the refresh may arrive in either order. Gives up as soon
 * as the person puts the focus somewhere else, or after a few seconds, when `otherwise` gives the
 * focus somewhere if it is still on the page (the commit never showed: a type filter leaves it out,
 * or its element cannot take the focus).
 */
export function focusCommitWhenShown(id: string, otherwise?: () => void): void {
  const active = document.activeElement;
  const origin = active === null || active === document.body ? null : active;
  // The person moved the focus from `origin` while it stayed in the page (a removed element also
  // sends `focusout`, while it is still connected: decided once it is gone).
  let moved = false;
  const onFocusOut = () => {
    queueMicrotask(() => {
      if (origin?.isConnected === true && document.activeElement !== origin) moved = true;
    });
  };
  const ours = () => {
    if (moved) return false;
    const now = document.activeElement;
    if (now === null || now === document.body) return true;
    return origin !== null && (now === origin || !origin.isConnected);
  };
  if (!ours() || focusCommit(id)) return;
  origin?.addEventListener('focusout', onFocusOut);
  const observer = new MutationObserver(() => {
    if (!ours() || focusCommit(id)) stop();
  });
  const timer = window.setTimeout(() => {
    stop();
    const now = document.activeElement;
    if (!moved && (now === null || now === document.body)) otherwise?.();
  }, COMMIT_SHOWN_WAIT_MS);
  function stop() {
    observer.disconnect();
    origin?.removeEventListener('focusout', onFocusOut);
    window.clearTimeout(timer);
  }
  observer.observe(document.body, { childList: true, subtree: true });
}

/** Whether an element or one around it is not displayed: a view hidden in React's `<Activity>`. */
function isHidden(element: HTMLElement): boolean {
  for (let node: HTMLElement | null = element; node !== null; node = node.parentElement) {
    if (getComputedStyle(node).display === 'none') return true;
  }
  return false;
}

export interface CommitActionsProps {
  commit: CommitInfo;
  /** The history's state (`get_workspace`): read-only or damaged keeps the buttons, disabled. */
  historyState: HistoryState | undefined;
}

/**
 * "Edit message" (`pencil`) and "Undo commit" (`undo-2`), 26 px outline icon buttons (§5, §7.3):
 * only those the commit takes (no Undo commit but on the newest commit, none on a prune commit),
 * disabled with the reason in their tooltip while the history is read-only or damaged. Edit
 * message only while its dialog is registered, as everywhere (app/registry.ts).
 */
export function CommitActionButtons({ commit, historyState }: CommitActionsProps) {
  const { t } = useTranslation('history');
  const undo = useUndoCommit();
  const canEdit = useCanOpenDialog('editMessage');
  const reword = rewordRefusal(commit, historyState);
  const uncommit = uncommitRefusal(commit, historyState);
  const edits = canEdit && !hidesButton(reword);
  if (!edits && hidesButton(uncommit)) return null;
  return (
    <span className="commit-actions">
      {edits && (
        <IconButton
          size="medium"
          variant="outline"
          icon={Pencil}
          label={t('actions.editMessage')}
          disabledReason={reword === null ? undefined : rewordRefusalText(reword)}
          onPress={() => {
            editMessage(commit);
          }}
        />
      )}
      {!hidesButton(uncommit) && (
        <IconButton
          size="medium"
          variant="outline"
          icon={Undo2}
          label={t('actions.undoCommit')}
          disabledReason={uncommit === null ? undefined : uncommitRefusalText(uncommit)}
          onPress={() => {
            undo(commit);
          }}
        />
      )}
    </span>
  );
}

/**
 * A commit's context menu items (§7.3): Edit message · Undo commit · ─ · Copy commit ID. Both
 * commands stay listed, disabled with the reason as their note and description, in a few words
 * ("Not the newest"): menu items have no tooltip, and a sentence would squeeze the label. Edit
 * message only while its dialog is registered. Put them in a `Menu`.
 */
export function CommitMenuItems({ commit, historyState }: CommitActionsProps) {
  const { t } = useTranslation('history');
  const undo = useUndoCommit();
  const canEdit = useCanOpenDialog('editMessage');
  const reword = rewordRefusal(commit, historyState);
  const uncommit = uncommitRefusal(commit, historyState);
  return (
    <>
      {canEdit && (
        <MenuItem
          id="editMessage"
          icon={Pencil}
          isDisabled={reword !== null}
          note={reword === null ? undefined : rewordRefusalNote(reword)}
          onAction={() => {
            if (reword === null) editMessage(commit);
          }}
        >
          {t('actions.editMessage')}
        </MenuItem>
      )}
      <MenuItem
        id="undoCommit"
        icon={Undo2}
        isDisabled={uncommit !== null}
        note={uncommit === null ? undefined : uncommitRefusalNote(uncommit)}
        onAction={() => {
          if (uncommit === null) undo(commit);
        }}
      >
        {t('actions.undoCommit')}
      </MenuItem>
      <MenuSeparator />
      <MenuItem
        id="copyCommitId"
        icon={Copy}
        onAction={() => {
          copyCommitId(commit);
        }}
      >
        {t('actions.copyId')}
      </MenuItem>
    </>
  );
}

/** A commit's context menu, open: where, on which commit, and whether the keyboard opened it. */
export interface CommitMenuRequest {
  anchor: MenuAnchor;
  commit: CommitInfo;
  /** Shift+F10 or the Menu key: the first item takes the focus, and the browser's `contextmenu` that follows is its echo. */
  keyboard: boolean;
}

export interface CommitContextMenuProps {
  /** The menu to show, or `null` when it is closed. */
  request: CommitMenuRequest | null;
  historyState: HistoryState | undefined;
  onClose: () => void;
}

/** A commit's context menu at a point (§7.3), "Actions for “…”"; closing returns the focus where it was. */
export function CommitContextMenu({ request, historyState, onClose }: CommitContextMenuProps) {
  const { t } = useTranslation('history');
  const label = t('actions.menu', { summary: request?.commit.summary ?? t('entry.noMessage') });
  return (
    <ContextMenu anchor={request?.anchor ?? null} onClose={onClose} label={label}>
      {request !== null && (
        <Menu aria-label={label} autoFocus={request.keyboard ? 'first' : true}>
          <CommitMenuItems commit={request.commit} historyState={historyState} />
        </Menu>
      )}
    </ContextMenu>
  );
}

export interface CommitMenuTrigger {
  /** Opens the menu. */
  open: (request: CommitMenuRequest) => void;
  /** Whether a menu the keyboard opened is up: the `contextmenu` event that follows Shift+F10 is its echo. */
  keyboardOpen: () => boolean;
  /** Where the keyboard opens it: under the commit's title in `element`. */
  anchorOf: (element: HTMLElement) => MenuAnchor;
}

/**
 * The handlers that open a commit's context menu on the element that shows it: right-click,
 * Shift+F10 and the Menu key (library-actions §2.7). An event a menu inside handled first (a file
 * card's row marks it handled) is left alone.
 */
export function commitMenuHandlers(commit: CommitInfo, { open, keyboardOpen, anchorOf }: CommitMenuTrigger) {
  return {
    onKeyDown: (event: KeyboardEvent<HTMLElement>) => {
      if (!isContextMenuKey(event) || event.defaultPrevented) return;
      event.preventDefault();
      open({ anchor: anchorOf(event.currentTarget), commit, keyboard: true });
    },
    onContextMenu: (event: MouseEvent<HTMLElement>) => {
      if (event.defaultPrevented) return;
      event.preventDefault();
      if (keyboardOpen()) return;
      open({ anchor: { x: event.clientX, y: event.clientY }, commit, keyboard: false });
    },
  };
}

/** Under an element's box: where a menu the keyboard opened goes. */
export function underBox(element: Element | null): MenuAnchor {
  const box = element?.getBoundingClientRect();
  return { x: box?.left ?? 0, y: box?.bottom ?? 0 };
}

/**
 * A commit context menu owned by one component, for a short list of commits (the Not synced card):
 * spread `handlersFor(commit)` on each commit's element and render `menu` once.
 */
export function useCommitContextMenu(
  historyState: HistoryState | undefined,
  anchorOf: (element: HTMLElement) => MenuAnchor = underBox,
): { handlersFor: (commit: CommitInfo) => ReturnType<typeof commitMenuHandlers>; menu: ReactNode } {
  const [request, setRequest] = useState<CommitMenuRequest | null>(null);
  const shown = useRef<CommitMenuRequest | null>(null);
  const trigger: CommitMenuTrigger = {
    open: (next) => {
      shown.current = next;
      setRequest(next);
    },
    keyboardOpen: () => shown.current?.keyboard === true,
    anchorOf,
  };
  const close = () => {
    shown.current = null;
    setRequest(null);
  };
  return {
    handlersFor: (commit) => commitMenuHandlers(commit, trigger),
    menu: <CommitContextMenu request={request} historyState={historyState} onClose={close} />,
  };
}
