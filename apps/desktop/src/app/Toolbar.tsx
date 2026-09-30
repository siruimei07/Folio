import { CalendarDays, ChevronDown, Search } from 'lucide-react';
import type { ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from 'react-aria-components';

import { IconButton } from '../components/IconButton/IconButton';
import { KeyCap } from '../components/KeyCap/KeyCap';
import { MenuButton } from '../components/Menu/Menu';
import { SIZE } from '../tokens/tokens';
import { openDialog } from './navigation';
import type { ShellRegistry } from './registry';
import { SEARCH_KEYS, useShortcutLabel } from './shortcuts';

export interface ToolbarProps {
  registry: ShellRegistry;
  /** In the narrow window's 40 px bar: icon-only controls. */
  compact: boolean;
}

/**
 * The toolbar (app-shell handoff §3, 18C3): the sync area on the left (empty until M3), the
 * semester button in the centre, the activity button and search on the right. In a narrow window
 * the same controls, compact, sit in the title bar (§2). Controls a lane has not registered yet
 * stay out.
 */
export function Toolbar({ registry, compact }: ToolbarProps) {
  const { t } = useTranslation('shell');
  const shortcut = useShortcutLabel();
  const { sync: Sync, semester: Semester, activity: ActivityControl } = registry.toolbar;
  const search = registry.dialogs.search !== undefined;
  const openSearch = () => {
    openDialog('search');
  };

  return (
    <div className="toolbar" data-compact={compact || undefined}>
      <div className="toolbar__start">{Sync && <Sync compact={compact} />}</div>
      <div className="toolbar__centre">{Semester && <Semester compact={compact} />}</div>
      <div className="toolbar__end">
        {ActivityControl && <ActivityControl compact={compact} />}
        {search &&
          (compact ? (
            <IconButton
              icon={Search}
              label={t('toolbar.search')}
              shortcut={shortcut(SEARCH_KEYS)}
              variant="outline"
              onPress={openSearch}
            />
          ) : (
            <Button
              className="toolbar__search"
              aria-label={t('toolbar.search')}
              onPress={openSearch}
            >
              <Search aria-hidden size={SIZE.icon} />
              <span className="toolbar__search-text">{t('toolbar.searchPlaceholder')}</span>
              <KeyCap keys={shortcut(SEARCH_KEYS, ' ')} />
            </Button>
          ))}
      </div>
    </div>
  );
}

export interface SemesterButtonProps {
  /** The current semester's name, like "Fall 2026". */
  name: string;
  compact: boolean;
  /** The semester menu: new semester, archived semesters (a `Menu`). */
  children: ReactElement;
}

/**
 * The semester button (app-shell handoff §3): calendar icon, the semester in 600 and a chevron;
 * opens the semester menu. Compact in the narrow bar: 28 px, no icon.
 */
export function SemesterButton({ name, compact, children }: SemesterButtonProps) {
  const { t } = useTranslation('shell');
  return (
    <MenuButton
      placement="bottom"
      trigger={
        <Button className="semester-button" data-compact={compact || undefined} aria-label={t('toolbar.semester', { name })}>
          {!compact && <CalendarDays aria-hidden size={SIZE.icon} />}
          <span className="semester-button__name">{name}</span>
          <ChevronDown aria-hidden size={SIZE.iconSmall} className="semester-button__chevron" />
        </Button>
      }
    >
      {children}
    </MenuButton>
  );
}
