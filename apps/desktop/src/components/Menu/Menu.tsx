import './Menu.css';

import { Check, ChevronRight, type LucideIcon, Minus } from 'lucide-react';
import { isValidElement, type ReactElement, type ReactNode, useRef } from 'react';
import { useContextMenu } from 'react-aria';
import {
  Keyboard,
  Menu as AriaMenu,
  MenuItem as AriaMenuItem,
  type MenuItemProps as AriaMenuItemProps,
  type MenuProps as AriaMenuProps,
  MenuTrigger,
  Separator,
  SubmenuTrigger,
  Text,
} from 'react-aria-components';

import { SUBMENU_DELAY_MS } from '../../lib/timing';
import { SIZE, SPACE } from '../../tokens/tokens';
import { Popover } from '../Popover/Popover';

export type MenuProps<T extends object> = Omit<AriaMenuProps<T>, 'className' | 'style'>;

/** The list of a menu (library-actions handoff §2.7). Put it inside `MenuButton` or `ContextMenu`. */
export function Menu<T extends object>(props: MenuProps<T>) {
  return <AriaMenu {...props} className="menu" />;
}

export interface MenuItemProps extends Omit<AriaMenuItemProps, 'className' | 'style' | 'children'> {
  /** A 16 px icon in the secondary colour; a tag dot for checkable tag items. */
  icon?: LucideIcon | ReactElement;
  children: string;
  /** Shown on the right, like "F2" or "Ctrl+Shift+C". */
  shortcut?: string;
  /** A note on the right in place of the shortcut, like "From folder". */
  note?: string;
  /** Label and icon in the danger colour (Delete). */
  destructive?: boolean;
  /** For a checkable item whose state is mixed across a selection: shows a minus. */
  mixed?: boolean;
}

/**
 * One item: icon, label (one line, truncated), then the shortcut, or a chevron when it opens a
 * submenu. In a menu with `selectionMode`, a check column comes first (`menuitemcheckbox`).
 */
export function MenuItem({ icon, children, shortcut, note, destructive, mixed, ...props }: MenuItemProps) {
  return (
    <AriaMenuItem
      {...props}
      textValue={props.textValue ?? children}
      className="menu-item"
      data-destructive={destructive === true || undefined}
    >
      {({ hasSubmenu, isSelected, selectionMode }) => (
        <>
          {selectionMode !== 'none' && (
            <span className="menu-item__check" aria-hidden>
              {mixed ? <Minus size={SIZE.iconSmall} /> : isSelected ? <Check size={SIZE.iconSmall} /> : null}
            </span>
          )}
          {icon !== undefined && (
            <span className="menu-item__icon" aria-hidden>
              <MenuIcon icon={icon} />
            </span>
          )}
          <Text slot="label" className="menu-item__label">
            {children}
          </Text>
          {note !== undefined && <span className="menu-item__note">{note}</span>}
          {shortcut !== undefined && <Keyboard className="menu-item__shortcut">{shortcut}</Keyboard>}
          {hasSubmenu && <ChevronRight aria-hidden size={SIZE.iconSmall} className="menu-item__chevron" />}
        </>
      )}
    </AriaMenuItem>
  );
}

/** Lucide icons are forwardRef objects, not functions, so React tells them from elements. */
function MenuIcon({ icon: Icon }: { icon: LucideIcon | ReactElement }) {
  return isValidElement(Icon) ? Icon : <Icon size={SIZE.icon} />;
}

export function MenuSeparator() {
  return <Separator className="menu-separator" />;
}

export interface SubmenuProps {
  /** The `MenuItem` that opens it. */
  trigger: ReactElement;
  /** The submenu's `Menu`. */
  children: ReactElement;
}

/** A submenu: opens to the right after 200 ms of hover or on Right arrow, flips left when needed. */
export function Submenu({ trigger, children }: SubmenuProps) {
  return (
    <SubmenuTrigger delay={SUBMENU_DELAY_MS}>
      {trigger}
      <Popover className="menu-popover" offset={-SPACE[4]} crossOffset={-SPACE[4]}>
        {children}
      </Popover>
    </SubmenuTrigger>
  );
}

export interface MenuButtonProps {
  /** The button that opens the menu: a RAC `Button`, such as `Button` or `IconButton`. */
  trigger: ReactElement;
  /** The `Menu`. */
  children: ReactElement;
  placement?: 'bottom start' | 'bottom end' | 'bottom';
}

/** A button that opens a menu under it: the semester menu, "More", an options chevron. */
export function MenuButton({ trigger, children, placement = 'bottom start' }: MenuButtonProps) {
  return (
    <MenuTrigger>
      {trigger}
      <Popover className="menu-popover" placement={placement}>
        {children}
      </Popover>
    </MenuTrigger>
  );
}

/** Where a context menu opens, in the window's coordinates. */
export interface MenuAnchor {
  x: number;
  y: number;
}

/**
 * Opens a context menu on right-click, Shift+F10 and the Menu key (react-aria's `useContextMenu`).
 * Spread `contextMenuProps` on the element; the anchor is where the pointer was, or the element's
 * middle for the keyboard. A view can open the menu elsewhere with `open`, such as under the name
 * of the focused row.
 */
export function useContextMenuTrigger(open: (anchor: MenuAnchor, target: Element) => void) {
  return useContextMenu({
    onContextMenu: ({ target, x, y }) => {
      const box = target.getBoundingClientRect();
      open({ x: box.left + x, y: box.top + y }, target);
    },
  });
}

export interface ContextMenuProps {
  /** Where it is open, or `null` when closed. */
  anchor: MenuAnchor | null;
  onClose: () => void;
  /** The `Menu`. Give it `aria-label`. */
  children: ReactNode;
}

/**
 * A menu at a point (library-actions handoff §2.7): its top-left corner 4 px below and right of
 * the anchor, flipped to stay 8 px inside the window. React Aria has no context-menu component,
 * so a controlled popover anchors to an invisible element at the point. Closing returns focus to
 * where it was.
 */
export function ContextMenu({ anchor, onClose, children }: ContextMenuProps) {
  const anchorRef = useRef<HTMLSpanElement>(null);
  return (
    <>
      <span
        ref={anchorRef}
        className="context-menu-anchor"
        style={anchor ? { left: anchor.x, top: anchor.y } : undefined}
        aria-hidden
      />
      <Popover
        className="menu-popover"
        triggerRef={anchorRef}
        isOpen={anchor !== null}
        onOpenChange={(isOpen) => {
          if (!isOpen) onClose();
        }}
        placement="bottom start"
        crossOffset={SPACE[4]}
      >
        {children}
      </Popover>
    </>
  );
}
