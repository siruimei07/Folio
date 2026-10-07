// The menus of a change (workspace-history handoff §3.7, §6.1): the row's context menu
// (right-click, Shift+F10, the Menu key) and the diff's "More", by what the row is: a file, a
// deleted file or folder, a folder that moved or was added, or a tag or settings change. They act
// through the app's file actions (`app/fileActions.ts`) and the row's check box.
//
// "View history of this file" (History's, `showHistory` in app/historyTarget.ts) comes after "Show
// in File Explorer" for a file, first for a deleted file and for a file's tags, never for folders;
// in both menus, while History is on the rail; disabled with its reason for an added file that no
// commit holds yet (§3.7).
import { Copy, ExternalLink, FolderSearch, History, Square, SquareCheck } from 'lucide-react';
import type { ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';

import { COPY_PATH_KEYS, type FileActions, useFileActions } from '../../app/fileActions';
import { showHistory } from '../../app/historyTarget';
import { useCanShowView } from '../../app/navigation';
import { type KeyCombo, useShortcutLabel } from '../../app/shortcuts';
import { Menu, MenuItem, MenuSeparator } from '../../components/Menu/Menu';
import { useWorkspace } from '../../data/workspace';
import type { FileRef, WorkspaceItem } from '../../ipc';
import { includabilityOf } from '../inclusion';
import type { ChangeRowOf } from '../list/rows';

/** Space, which includes or leaves out the focused row, as menus print it. */
const SPACE_KEYS: KeyCombo = { key: 'Space' };

type ChangesT = TFunction<'changes'>;
type ShortcutLabel = (combo: KeyCombo) => string;

/**
 * The path "Copy path" copies: an item's (the old one of a deletion), or the file or folder whose
 * tags changed; `null` for a settings change, which names no file.
 */
export function copyablePath(row: ChangeRowOf): string | null {
  if (row.kind === 'item') return row.item.path;
  return row.change.subject.kind === 'tags' ? row.change.subject.path : null;
}

/** Whether a row has a context menu: every item does (its check box), a tag change too (its path). */
export function hasMenu(row: ChangeRowOf): boolean {
  return row.kind === 'item' || copyablePath(row) !== null;
}

/** "Open with default app" and "Show in File Explorer", or a folder's "Open in File Explorer". */
function fileItems(item: WorkspaceItem, files: FileActions, t: ChangesT): ReactElement[] {
  const { entry } = item;
  if (entry === null || item.change === 'deleted') return [];
  if (item.kind === 'folder') {
    return [
      <MenuItem
        key="openFolder"
        id="openFolder"
        icon={FolderSearch}
        onAction={() => {
          files.open(entry);
        }}
      >
        {t('menu.openFolder')}
      </MenuItem>,
    ];
  }
  return [
    <MenuItem
      key="open"
      id="open"
      icon={ExternalLink}
      onAction={() => {
        files.open(entry);
      }}
    >
      {t('menu.open')}
    </MenuItem>,
    <MenuItem
      key="reveal"
      id="reveal"
      icon={FolderSearch}
      onAction={() => {
        files.showInExplorer(entry);
      }}
    >
      {t('menu.reveal')}
    </MenuItem>,
  ];
}

/**
 * The file whose history "View history of this file" shows (§3.7): a file's entry; a deleted file's
 * version in HEAD (its old path); a file's tags, its entry. `notCommitted` for an added file, which
 * no commit holds yet; `null` for folders and settings, which have none.
 */
export function historyFileOf(row: ChangeRowOf, head: string | null): FileRef | 'notCommitted' | null {
  if (row.kind === 'metadata') {
    const { subject } = row.change;
    if (subject.kind !== 'tags' || subject.entryKind !== 'file') return null;
    if (subject.entry !== null) return { kind: 'entry', entry: subject.entry };
    return head === null ? null : { kind: 'version', commit: head, path: subject.path };
  }
  const { item } = row;
  if (item.kind !== 'file') return null;
  if (item.change === 'added') return 'notCommitted';
  if (item.change === 'deleted' || item.entry === null) return head === null ? null : { kind: 'version', commit: head, path: item.path };
  return { kind: 'entry', entry: item.entry };
}

/** "View history of this file", while History is on the rail (`shown`). */
function historyItems(row: ChangeRowOf, head: string | null, shown: boolean, t: ChangesT): ReactElement[] {
  const file = shown ? historyFileOf(row, head) : null;
  if (file === null) return [];
  const notCommitted = file === 'notCommitted';
  return [
    <MenuItem
      key="viewHistory"
      id="viewHistory"
      icon={History}
      isDisabled={notCommitted}
      note={notCommitted ? t('menu.notCommitted') : undefined}
      onAction={() => {
        if (!notCommitted) showHistory(file);
      }}
    >
      {t('menu.viewHistory')}
    </MenuItem>,
  ];
}

/** What "View history of this file" needs: HEAD (a deleted file's version) and whether History is on the rail. */
function useHistoryItems(): (row: ChangeRowOf, t: ChangesT) => ReactElement[] {
  const head = useWorkspace().data?.head ?? null;
  const shown = useCanShowView('history');
  return (row, t) => historyItems(row, head, shown, t);
}

function copyItems(row: ChangeRowOf, files: FileActions, t: ChangesT, shortcut: ShortcutLabel): ReactElement[] {
  const path = copyablePath(row);
  if (path === null) return [];
  return [
    <MenuItem
      key="copy"
      id="copy"
      icon={Copy}
      shortcut={shortcut(COPY_PATH_KEYS)}
      onAction={() => {
        files.copyPaths([path]);
      }}
    >
      {t('menu.copyPath')}
    </MenuItem>,
  ];
}

/** What the context menu's check box item does for its row. */
export interface InclusionAction {
  included: boolean;
  /** Why no box can change for now: a commit runs (§3.8). */
  waitReason: string | null;
  onToggle: () => void;
}

/**
 * "Include in this commit" / "Leave out of this commit" (Space). A row whose box cannot change
 * keeps the item, disabled, with the reason as its note: the shared menu still reaches it.
 */
function inclusionItem(item: WorkspaceItem, action: InclusionAction, t: ChangesT, shortcut: ShortcutLabel): ReactElement {
  const kind = includabilityOf(item);
  const note =
    kind === 'required'
      ? t('menu.required')
      : kind === 'blocked'
        ? t(item.readiness === 'notLocal' ? 'menu.notLocal' : 'menu.unreadable')
        : (action.waitReason ?? undefined);
  return (
    <MenuItem
      key="include"
      id="include"
      icon={action.included ? Square : SquareCheck}
      isDisabled={note !== undefined}
      note={note}
      shortcut={note === undefined ? shortcut(SPACE_KEYS) : undefined}
      onAction={action.onToggle}
    >
      {action.included ? t('menu.leaveOut') : t('menu.include')}
    </MenuItem>
  );
}

/** The groups that have items, with separators between them. */
function separated(groups: readonly (readonly ReactElement[])[]): ReactElement[] {
  return groups
    .filter((group) => group.length > 0)
    .flatMap((group, at) => (at === 0 ? group : [<MenuSeparator key={`separator-${String(at)}`} />, ...group]));
}

export interface ChangeMenuProps {
  row: ChangeRowOf;
  /** The row's check box; `null` for a tag or settings change, which has none. */
  inclusion: InclusionAction | null;
  /** "Actions for ps2.pdf". */
  label: string;
  /** Opened from the keyboard: the first item takes the focus. */
  focusFirst: boolean;
}

/**
 * The row's context menu (§3.7): the file actions, the check box, then "Copy path", in groups.
 * Put it in a `ContextMenu`; rows without one are not given a menu (`hasMenu`).
 */
export function ChangeMenu({ row, inclusion, label, focusFirst }: ChangeMenuProps) {
  const { t } = useTranslation('changes');
  const files = useFileActions();
  const shortcut = useShortcutLabel();
  const history = useHistoryItems();
  const items = separated([
    row.kind === 'item' ? [...fileItems(row.item, files, t), ...history(row, t)] : [],
    row.kind === 'item' && inclusion !== null ? [inclusionItem(row.item, inclusion, t, shortcut)] : [],
    // A tag row's "View history of this file" goes with its "Copy path" (§3.7).
    [...(row.kind === 'metadata' ? history(row, t) : []), ...copyItems(row, files, t, shortcut)],
  ]);
  return (
    <Menu aria-label={label} autoFocus={focusFirst ? 'first' : true}>
      {items}
    </Menu>
  );
}

/**
 * The diff's "More" for the selected change (§6.1): the file actions and "Copy path", without the
 * check box; `undefined` when there is none, so the pane shows no "More".
 */
export function useDiffMoreItems(row: ChangeRowOf | null): ReactElement[] | undefined {
  const { t } = useTranslation('changes');
  const files = useFileActions();
  const shortcut = useShortcutLabel();
  const history = useHistoryItems();
  if (row === null) return undefined;
  const items = [...(row.kind === 'item' ? fileItems(row.item, files, t) : []), ...history(row, t), ...copyItems(row, files, t, shortcut)];
  return items.length === 0 ? undefined : items;
}
