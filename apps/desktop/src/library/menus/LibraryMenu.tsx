import { useCanOpenDialog } from '../../app/navigation';
import { ContextMenu } from '../../components/Menu/Menu';
import { useCourses } from '../../data/groups';
import { useAddFiles } from '../addFiles';
import { currentFolderOf } from '../panel/LibraryPanel';
import { closeMenu, useLibraryView } from '../state';
import { EntryMenu, useMenuLabel } from './EntryMenu';

/**
 * The Library's one context menu (library-actions handoff §2.7, §6): opened at the pointer by a
 * right-click, under the focused row's name by Shift+F10 or the Menu key, for the rows the store
 * names. Closing returns focus to where it was.
 */
export function LibraryMenu() {
  const menu = useLibraryView((state) => state.menu);
  const menuLabel = useMenuLabel();
  const courses = useCourses().data ?? [];
  const addFiles = useAddFiles();
  const canSettings = useCanOpenDialog('librarySettings');
  // The empty space of the tree has a menu only when one of its items can open.
  const shown = menu !== null && (menu.targets.length > 0 || addFiles !== null || canSettings);
  return (
    <ContextMenu anchor={shown ? menu.anchor : null} onClose={closeMenu} label={menuLabel(menu?.targets ?? [])}>
      {menu !== null && (
        <EntryMenu
          targets={menu.targets}
          region={menu.region}
          currentFolder={currentFolderOf(courses)}
          focusFirst={menu.keyboard}
        />
      )}
    </ContextMenu>
  );
}
