import { Plus, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { openDialog, useCanOpenDialog } from '../app/navigation';
import type { ToolbarControlProps } from '../app/registry';
import { SemesterButton } from '../app/Toolbar';
import { Menu, MenuItem, MenuSection, MenuSeparator, Submenu } from '../components/Menu/Menu';
import { useLibrary } from '../data/library';
import { useCurrentSemesterInfo } from './semester';
import { openLibraryDialog, showSemester } from './state';

/** A semester's menu key; the menu's own items (`new`, `delete`) never look like one. */
const SEMESTER_KEY = 'semester:';

/**
 * The semester button in the toolbar's centre (app-shell handoff §3): the current semester, and a
 * menu to switch, with archived semesters in a submenu (brief §5.1), "New semester…" once its
 * dialog is registered, and deleting the current semester, which asks first (library-actions §7.4).
 */
export function SemesterControl({ compact }: ToolbarControlProps) {
  const { t } = useTranslation('library');
  const library = useLibrary();
  const { semesters = [], semester } = useCurrentSemesterInfo();
  const canCreate = useCanOpenDialog('newSemester');
  if (library === null || (semesters.length === 0 && !canCreate)) return null;
  const current = semester?.folder.path ?? null;
  const open = semesters.filter((candidate) => !candidate.archived);
  const archived = semesters.filter((candidate) => candidate.archived);
  const selectedKeys = current === null ? [] : [SEMESTER_KEY + current];
  const items = (list: typeof semesters) =>
    list.map((candidate) => (
      <MenuItem key={candidate.folder.path} id={SEMESTER_KEY + candidate.folder.path}>
        {candidate.name}
      </MenuItem>
    ));
  const choose = (keys: 'all' | Set<unknown>) => {
    if (keys === 'all') return;
    const [key] = [...keys];
    if (typeof key === 'string' && key.startsWith(SEMESTER_KEY)) showSemester(key.slice(SEMESTER_KEY.length));
  };

  return (
    <SemesterButton name={semester?.name ?? t('semester.none')} compact={compact}>
      <Menu
        aria-label={t('semester.menu')}
        onAction={(key) => {
          if (key === 'new') openDialog('newSemester');
          else if (key === 'delete' && semester !== null) openLibraryDialog({ kind: 'deleteSemester', semester: semester.folder });
        }}
      >
        <MenuSection
          aria-label={t('semester.menu')}
          selectionMode="single"
          selectedKeys={selectedKeys}
          onSelectionChange={choose}
        >
          {items(open)}
        </MenuSection>
        {archived.length > 0 && (
          <Submenu trigger={<MenuItem>{t('semester.archived')}</MenuItem>}>
            <Menu
              aria-label={t('semester.archived')}
              selectionMode="single"
              selectedKeys={selectedKeys}
              onSelectionChange={choose}
            >
              {items(archived)}
            </Menu>
          </Submenu>
        )}
        {(canCreate || semester !== null) && <MenuSeparator />}
        {canCreate && (
          <MenuItem id="new" icon={Plus}>
            {t('semester.new')}
          </MenuItem>
        )}
        {semester !== null && (
          <MenuItem id="delete" icon={Trash2} destructive>
            {t('semester.delete', { name: semester.name })}
          </MenuItem>
        )}
      </Menu>
    </SemesterButton>
  );
}
