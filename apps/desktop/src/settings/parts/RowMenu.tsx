import { type LucideIcon, MoreHorizontal } from 'lucide-react';

import { IconButton } from '../../components/IconButton/IconButton';
import { Menu, MenuButton, MenuItem } from '../../components/Menu/Menu';

export interface RowMenuItem {
  id: string;
  label: string;
  icon?: LucideIcon;
  /** `undefined`: shown but disabled, like Move up on the first row. */
  onAction: (() => void) | undefined;
  destructive?: boolean;
}

/** A row's "More" button and its menu (app-shell handoff §9: "more menu"). */
export function RowMenu({ label, items }: { label: string; items: readonly RowMenuItem[] }) {
  return (
    <MenuButton placement="bottom end" trigger={<IconButton icon={MoreHorizontal} label={label} size="small" />}>
      <Menu
        aria-label={label}
        disabledKeys={items.filter((item) => item.onAction === undefined).map((item) => item.id)}
        onAction={(key) => items.find((item) => item.id === key)?.onAction?.()}
      >
        {items.map(({ id, label: itemLabel, icon, destructive }) => (
          <MenuItem key={id} id={id} icon={icon} destructive={destructive}>
            {itemLabel}
          </MenuItem>
        ))}
      </Menu>
    </MenuButton>
  );
}
