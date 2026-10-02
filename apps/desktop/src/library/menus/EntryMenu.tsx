import {
  Copy,
  ExternalLink,
  FolderOutput,
  FolderPlus,
  FolderSearch,
  Pencil,
  Plus,
  Settings,
  Tag as TagIcon,
  Trash2,
} from 'lucide-react';
import { type ReactElement, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Key, Selection } from 'react-aria-components';

import { openDialog, useCanOpenDialog } from '../../app/navigation';
import { useShortcutLabel } from '../../app/shortcuts';
import { Menu, MenuItem, MenuSection, MenuSeparator, Submenu } from '../../components/Menu/Menu';
import { TagDot } from '../../components/TagDot/TagDot';
import { useCourses } from '../../data/groups';
import { useLibrary } from '../../data/library';
import { useTags } from '../../data/tags';
import type { EntryRef, Tag } from '../../ipc';
import { useAddFiles } from '../addFiles';
import { displayName, useLibraryCommands } from '../commands';
import {
  type MenuTarget,
  openLibraryDialog,
  type Region,
  startNewFolder,
  startRename,
} from '../state';

const TAGS_PAGE = { page: 'tags' };
const NO_TAG_LIST: readonly Tag[] = [];
const COURSES_PAGE = { page: 'courses' };
/** Without a current course, "Add files…" in the tree's empty space is disabled (§6). */
const NO_ADD = ['addFiles'];

/** The shortcuts menus print (library-actions §6). */
export const KEYS = {
  addFiles: { key: 'O', ctrl: true },
  newFolder: { key: 'N', ctrl: true, shift: true },
  rename: { key: 'F2' },
  copyPath: { key: 'C', ctrl: true, shift: true },
  delete: { key: 'Del' },
} as const;

type TagState = 'all' | 'some' | 'none';

interface TagsSubmenuProps {
  targets: readonly MenuTarget[];
}

/**
 * Tags ▸ (library-actions §6): every tag, checked when all targets have it, a minus when some do;
 * a tag every target gets from a folder above is checked, disabled and says "From folder".
 * Choosing an unchecked or mixed tag adds it to all, a checked one removes it from all. Space and
 * clicks keep the menu open, Enter closes it (React Aria's multiple-selection menus).
 */
export function TagsSubmenu({ targets }: TagsSubmenuProps) {
  const { t } = useTranslation('library');
  const tags = useTags().data ?? NO_TAG_LIST;
  const commands = useLibraryCommands();
  const canEdit = useCanOpenDialog('librarySettings');
  // What the menu set on the targets' own tags while open: the rows update when the catalog event
  // arrives, the menu now.
  const [changed, setChanged] = useState<ReadonlyMap<string, boolean>>(new Map());
  // Each tag's state over every target (up to `LIMITS.batch` of them), counted once. A tag every
  // target gets from a folder above stays whatever the menu does to their own tags.
  const states = useMemo(() => {
    const result = new Map<string, { state: TagState; fromFolder: boolean }>();
    for (const tag of tags) {
      let having = 0;
      let inherited = 0;
      for (const target of targets) {
        const inherits = target.folderTags.includes(tag.id);
        if (inherits) inherited++;
        if (inherits || (changed.get(tag.id) ?? target.tags.includes(tag.id))) having++;
      }
      const state: TagState = having === 0 ? 'none' : having === targets.length ? 'all' : 'some';
      result.set(tag.id, { state, fromFolder: inherited === targets.length });
    }
    return result;
  }, [tags, targets, changed]);
  const stateOf = (id: string): TagState => states.get(id)?.state ?? 'none';
  const fromFolder = (id: string) => states.get(id)?.fromFolder === true;
  const selected = tags.filter((tag) => stateOf(tag.id) === 'all').map((tag) => tag.id);

  const onSelectionChange = (keys: Selection) => {
    if (keys === 'all') return;
    for (const tag of tags) {
      const now = keys.has(tag.id);
      const before = selected.includes(tag.id);
      if (now === before) continue;
      commands.setTags(targets, now ? [tag.id] : [], now ? [] : [tag.id]);
      setChanged((previous) => new Map(previous).set(tag.id, now));
    }
  };

  return (
    <Menu
      aria-label={t('menu.tags')}
      onAction={(key) => {
        if (key === 'editTags') openDialog('librarySettings', TAGS_PAGE);
      }}
    >
      <MenuSection
        aria-label={t('menu.tags')}
        selectionMode="multiple"
        selectedKeys={selected}
        onSelectionChange={onSelectionChange}
      >
        {tags.map((tag) => (
          <MenuItem
            key={tag.id}
            id={tag.id}
            icon={<TagDot color={tag.color} />}
            mixed={stateOf(tag.id) === 'some'}
            isDisabled={fromFolder(tag.id)}
            note={fromFolder(tag.id) ? t('menu.fromFolder') : undefined}
          >
            {tag.name}
          </MenuItem>
        ))}
      </MenuSection>
      {canEdit && <MenuSeparator />}
      {canEdit && (
        <MenuSection aria-label={t('menu.editTags')}>
          <MenuItem id="editTags" icon={Settings}>
            {t('menu.editTags')}
          </MenuItem>
        </MenuSection>
      )}
    </Menu>
  );
}

/** The name of a menu: "Actions for ps2.pdf", "Actions for 3 items", or the empty space's. */
export function useMenuLabel() {
  const { t } = useTranslation('library');
  const courses = useCourses().data ?? [];
  return (targets: readonly EntryRef[]) => {
    const [only] = targets;
    if (only === undefined) return t('menu.labelBackground');
    return targets.length > 1
      ? t('menu.labelSeveral', { count: targets.length })
      : t('menu.label', { name: displayName(only, courses) });
  };
}

export interface EntryMenuProps {
  targets: readonly MenuTarget[];
  region: Region;
  /** The empty space of the tree: add files to the current course, or a new course. */
  currentFolder?: EntryRef | null;
  /** The preview header's "More": only rename, move, copy path and delete (§6). */
  more?: boolean;
  /** Focus the first item: a menu opened from the keyboard. */
  focusFirst?: boolean;
}

/**
 * The menu of an entry, several entries or the tree's empty space (library-actions handoff §6),
 * as the `Menu` a context menu or the "More" button shows. Items that open a dialog another lane
 * builds show once that dialog is registered.
 */
export function EntryMenu({
  targets,
  region,
  currentFolder = null,
  more = false,
  focusFirst = false,
}: EntryMenuProps): ReactElement | null {
  const { t } = useTranslation('library');
  const shortcut = useShortcutLabel();
  const commands = useLibraryCommands();
  const addFiles = useAddFiles();
  const canSettings = useCanOpenDialog('librarySettings');
  const library = useLibrary();
  const menuLabel = useMenuLabel();
  const readOnly = library?.readOnly === true;
  const [single] = targets;
  const several = targets.length > 1;
  const openCourses = () => {
    openDialog('librarySettings', COURSES_PAGE);
  };

  const actions: Record<string, () => void> = {
    open: () => {
      if (single !== undefined) commands.open(single);
    },
    // A file shows in its folder; a course or folder opens itself ("Open in File Explorer").
    reveal: () => {
      if (single === undefined) return;
      if (single.kind === 'file') commands.showInExplorer(single);
      else commands.open(single);
    },
    rename: () => {
      if (single !== undefined) startRename(single.id, region);
    },
    move: () => {
      openLibraryDialog({ kind: 'move', entries: targets });
    },
    copy: () => {
      commands.copyPaths(targets);
    },
    delete: () => {
      commands.remove(targets);
    },
    addFiles: () => {
      addFiles?.(single ?? currentFolder);
    },
    newFolder: () => {
      if (single !== undefined) startNewFolder(single);
    },
    courseSettings: openCourses,
    newCourse: openCourses,
  };
  const onAction = (key: Key) => actions[String(key)]?.();

  const tagsItem = readOnly ? (
    <MenuItem id="tags" icon={TagIcon} isDisabled>
      {t('menu.readOnlyTags')}
    </MenuItem>
  ) : (
    <Submenu trigger={<MenuItem icon={TagIcon}>{t('menu.tags')}</MenuItem>}>
      <TagsSubmenu targets={targets} />
    </Submenu>
  );
  const renameItem = (
    <MenuItem id="rename" icon={Pencil} shortcut={shortcut(KEYS.rename)}>
      {t('menu.rename')}
    </MenuItem>
  );
  const copyItem = (
    <MenuItem id="copy" icon={Copy} shortcut={several ? undefined : shortcut(KEYS.copyPath)}>
      {several ? t('menu.copyPaths') : t('menu.copyPath')}
    </MenuItem>
  );
  const moveItem = (
    <MenuItem id="move" icon={FolderOutput}>
      {several ? t('menu.moveSeveral', { count: targets.length }) : t('menu.moveTo')}
    </MenuItem>
  );
  const deleteItem = (label: string) => (
    <MenuItem id="delete" icon={Trash2} shortcut={shortcut(KEYS.delete)} destructive>
      {label}
    </MenuItem>
  );
  /** Rename, move, copy path, then delete: how a file's, a folder's and "More" end. */
  const tail = (
    <>
      {renameItem}
      {moveItem}
      {copyItem}
      <MenuSeparator />
      {deleteItem(t('menu.delete'))}
    </>
  );
  const addFilesItem = addFiles !== null && (
    <MenuItem id="addFiles" icon={Plus} shortcut={shortcut(KEYS.addFiles)}>
      {t('menu.addFiles')}
    </MenuItem>
  );
  const addItems = (
    <>
      {addFilesItem}
      <MenuItem id="newFolder" icon={FolderPlus} shortcut={shortcut(KEYS.newFolder)}>
        {t('menu.newFolder')}
      </MenuItem>
      <MenuSeparator />
      <MenuItem id="reveal" icon={FolderSearch}>
        {t('menu.openFolder')}
      </MenuItem>
      <MenuSeparator />
    </>
  );
  const label = menuLabel(targets);
  const autoFocus = focusFirst ? 'first' : true;

  if (single === undefined) {
    if (addFiles === null && !canSettings) return null;
    return (
      <Menu aria-label={label} onAction={onAction} autoFocus={autoFocus} disabledKeys={currentFolder === null ? NO_ADD : []}>
        {addFilesItem}
        {canSettings && (
          <MenuItem id="newCourse" icon={Settings}>
            {t('menu.newCourse')}
          </MenuItem>
        )}
      </Menu>
    );
  }

  if (more) {
    return (
      <Menu aria-label={label} onAction={onAction} autoFocus={autoFocus}>
        {tail}
      </Menu>
    );
  }

  if (several) {
    const withCourse = targets.some((target) => target.kind === 'course');
    return (
      <Menu aria-label={label} onAction={onAction} autoFocus={autoFocus}>
        {!withCourse && tagsItem}
        {!withCourse && moveItem}
        {copyItem}
        <MenuSeparator />
        {deleteItem(t('menu.deleteSeveral', { count: targets.length }))}
      </Menu>
    );
  }

  if (single.kind === 'course') {
    return (
      <Menu aria-label={label} onAction={onAction} autoFocus={autoFocus}>
        {addItems}
        {canSettings && (
          <MenuItem id="courseSettings" icon={Settings}>
            {t('menu.courseSettings')}
          </MenuItem>
        )}
        {renameItem}
        <MenuSeparator />
        {deleteItem(t('menu.deleteCourse'))}
      </Menu>
    );
  }

  if (single.kind === 'folder') {
    return (
      <Menu aria-label={label} onAction={onAction} autoFocus={autoFocus}>
        {addItems}
        {tagsItem}
        {tail}
      </Menu>
    );
  }

  return (
    <Menu aria-label={label} onAction={onAction} autoFocus={autoFocus}>
      <MenuItem id="open" icon={ExternalLink}>
        {t('menu.open')}
      </MenuItem>
      <MenuItem id="reveal" icon={FolderSearch}>
        {t('menu.reveal')}
      </MenuItem>
      <MenuSeparator />
      {tagsItem}
      {tail}
    </Menu>
  );
}
