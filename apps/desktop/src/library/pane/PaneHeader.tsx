import { ArrowLeft, ChevronsUpDown, LayoutGrid, List } from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { IconButton } from '../../components/IconButton/IconButton';
import { Menu, MenuItem, MenuButton, MenuSection, MenuSeparator } from '../../components/Menu/Menu';
import { SegmentedControl } from '../../components/SegmentedControl/SegmentedControl';
import { type PaneMode, setPaneMode, setSort, SORT_KEYS, usePreferences, type ViewSortKey } from '../preferences';

const ASCENDING = 'ascending';
const DESCENDING = 'descending';

/** The sort button (app-shell §5, "Date modified"): a menu of keys and the direction. */
function SortButton() {
  const { t } = useTranslation('library');
  const sort = usePreferences((state) => state.sort);
  return (
    <MenuButton
      placement="bottom end"
      trigger={
        <IconButton icon={ChevronsUpDown} label={t('pane.sort', { key: t(`pane.sortKey.${sort.key}`) })} />
      }
    >
      <Menu aria-label={t('pane.sortMenu')}>
        <MenuSection
          aria-label={t('pane.sortMenu')}
          selectionMode="single"
          disallowEmptySelection
          selectedKeys={[sort.key]}
          onSelectionChange={(keys) => {
            const [key] = keys === 'all' ? [] : [...keys];
            const found = SORT_KEYS.find((candidate) => candidate === key);
            if (found !== undefined) setSort({ ...sort, key: found });
          }}
        >
          {SORT_KEYS.map((key: ViewSortKey) => (
            <MenuItem key={key} id={key}>
              {t(`pane.sortKey.${key}`)}
            </MenuItem>
          ))}
        </MenuSection>
        <MenuSeparator />
        <MenuSection
          aria-label={t('pane.sortMenu')}
          selectionMode="single"
          disallowEmptySelection
          selectedKeys={[sort.descending ? DESCENDING : ASCENDING]}
          onSelectionChange={(keys) => {
            if (keys !== 'all') setSort({ ...sort, descending: keys.has(DESCENDING) });
          }}
        >
          <MenuItem id={ASCENDING}>{t('pane.ascending')}</MenuItem>
          <MenuItem id={DESCENDING}>{t('pane.descending')}</MenuItem>
        </MenuSection>
      </Menu>
    </MenuButton>
  );
}

/** List or grid of the files in the third column. */
function ViewToggle() {
  const { t } = useTranslation('library');
  const pane = usePreferences((state) => state.pane);
  return (
    <SegmentedControl<PaneMode>
      label={t('pane.view')}
      segments={[
        { id: 'list', label: t('pane.asList'), icon: List },
        { id: 'grid', label: t('pane.asGrid'), icon: LayoutGrid },
      ]}
      selected={pane}
      onChange={setPaneMode}
    />
  );
}

export interface PaneHeaderProps {
  /** What the column shows: icon, names and the file count. */
  children: ReactNode;
  /** Narrow window: "Back" to the list (app-shell §2). */
  onBack?: () => void;
}

/** The header of a course's, folder's or quick view's files (app-shell handoff §5). */
export function PaneHeader({ children, onBack }: PaneHeaderProps) {
  const { t } = useTranslation('library');
  return (
    <header className="pane-header">
      {onBack !== undefined && <IconButton icon={ArrowLeft} label={t('pane.back')} onPress={onBack} />}
      <h2 className="pane-header__title">{children}</h2>
      <div className="pane-header__actions">
        <SortButton />
        <ViewToggle />
      </div>
    </header>
  );
}
