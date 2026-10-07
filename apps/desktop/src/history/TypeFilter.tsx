import { ChevronDown, Funnel } from 'lucide-react';
import { Button as AriaButton, type Selection } from 'react-aria-components';
import { useTranslation } from 'react-i18next';

import { Menu, MenuButton, MenuItem, MenuSection, MenuSeparator } from '../components/Menu/Menu';
import { SIZE } from '../tokens/tokens';
import { filterOf, HISTORY_TYPES, shownTypes } from './model/filter';
import { useHistoryPreferences } from './preferences';
import { showTypes } from './state';

/**
 * The type filter of the History header (handoff workspace-history §7.1): an outline button, "All
 * types" or "2 types" with the selected look while it filters, and its checkable menu. Every kind
 * shown is checked; toggling keeps the menu open, "Show all types" closes it. The choice is
 * remembered on this computer.
 */
export function TypeFilter() {
  const { t } = useTranslation('history');
  const filter = useHistoryPreferences((state) => state.types);
  const shown = shownTypes(filter);
  const label = filter === null ? t('filter.all') : t('filter.some', { count: filter.length });

  const onSelectionChange = (keys: Selection) => {
    showTypes(keys === 'all' ? null : filterOf(keys));
  };

  return (
    <MenuButton
      placement="bottom end"
      trigger={
        <AriaButton className="history-filter" data-filtering={filter !== null || undefined} aria-label={t('filter.name', { label })}>
          <Funnel aria-hidden size={SIZE.iconSmall} />
          <span>{label}</span>
          <ChevronDown aria-hidden size={SIZE.iconTiny} className="history-filter__chevron" />
        </AriaButton>
      }
    >
      {/* The menu is named by its button, which says what the filter shows. */}
      <Menu>
        <MenuSection aria-label={t('filter.menu')} selectionMode="multiple" selectedKeys={shown} onSelectionChange={onSelectionChange}>
          {HISTORY_TYPES.map((type) => (
            <MenuItem key={type} id={type}>
              {t(`filter.types.${type}`)}
            </MenuItem>
          ))}
        </MenuSection>
        <MenuSeparator />
        <MenuSection aria-label={t('filter.showAll')}>
          <MenuItem
            id="showAll"
            icon={Funnel}
            onAction={() => {
              showTypes(null);
            }}
          >
            {t('filter.showAll')}
          </MenuItem>
        </MenuSection>
      </Menu>
    </MenuButton>
  );
}
