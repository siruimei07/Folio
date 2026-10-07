import './Menu.css';

import { Check, ChevronRight, type LucideIcon, Minus } from 'lucide-react';
import { createContext, isValidElement, type ReactElement, type ReactNode, useContext, useMemo, useRef } from 'react';
import { useContextMenu } from 'react-aria';
import {
  type Key,
  Keyboard,
  Menu as AriaMenu,
  MenuItem as AriaMenuItem,
  type MenuItemProps as AriaMenuItemProps,
  type MenuProps as AriaMenuProps,
  MenuSection as AriaMenuSection,
  type MenuSectionProps as AriaMenuSectionProps,
  MenuTrigger,
  Separator,
  SubmenuTrigger,
  Text,
} from 'react-aria-components';

import { SUBMENU_DELAY_MS } from '../../lib/timing';
import { SIZE, SPACE } from '../../tokens/tokens';
import { Popover } from '../Popover/Popover';

export type MenuProps<T extends object> = Omit<AriaMenuProps<T>, 'className' | 'style'>;

/**
 * Closes the `ContextMenu` a menu is in. Outside a `MenuTrigger`, React Aria gives each menu a
 * trigger state of its own that closes nothing, so a chosen item (or Enter in a submenu, which
 * React Aria chains with this) would leave the popover open.
 */
const CloseContextMenu = createContext<(() => void) | undefined>(undefined);

/** The `disabledKeys` of the menu an item is in. The items apply them, not React Aria (`MenuItem`). */
const DisabledKeys = createContext<ReadonlySet<Key>>(new Set());

/**
 * The list of a menu (library-actions handoff §2.7). Put it inside `MenuButton` or `ContextMenu`.
 * The items its `disabledKeys` names are disabled as an item's `isDisabled` makes them: still
 * focusable, but inert.
 */
export function Menu<T extends object>({ disabledKeys, ...props }: MenuProps<T>) {
  const close = useContext(CloseContextMenu);
  const disabled = useMemo(() => new Set(disabledKeys), [disabledKeys]);
  return (
    <DisabledKeys value={disabled}>
      <AriaMenu onClose={close} {...props} className="menu" />
    </DisabledKeys>
  );
}

/**
 * A disabled item (library-actions §2.7: `aria-disabled`, still focusable so it is announced).
 * React Aria's `isDisabled` makes it inert: no press, hover, action, selection toggle or closing,
 * with `aria-disabled` and `data-disabled` (the tertiary look). Alone it also takes the item out of
 * the focus, the arrow keys and type-ahead. A collection node whose props say
 * `disabledBehavior: 'selection'` keeps those: react-stately's `SelectionManager.isDisabled` and
 * react-aria's `ListKeyboardDelegate.isDisabled` leave it in, while `canSelectItem` still refuses
 * it. RAC 1.21 types no `disabledBehavior` on `MenuItem`; Menu.test.tsx holds the behaviour.
 */
const FOCUSABLE_DISABLED = { isDisabled: true, disabledBehavior: 'selection' } as const;

export interface MenuItemProps extends Omit<AriaMenuItemProps, 'className' | 'style' | 'children'> {
  /** A 16 px icon in the secondary colour; a tag dot for checkable tag items. */
  icon?: LucideIcon | ReactElement;
  children: string;
  /** Shown on the right, like "F2" or "Ctrl+Shift+C". */
  shortcut?: string;
  /**
   * A note on the right in place of the shortcut, like "From folder", which is also the item's
   * description (`aria-describedby`): a disabled item's reason.
   */
  note?: string;
  /** Label and icon in the danger colour (Delete). */
  destructive?: boolean;
  /** For a checkable item whose state is mixed across a selection: shows a minus. */
  mixed?: boolean;
}

/**
 * One item: icon, label (one line, truncated), then the note or the shortcut, or a chevron when
 * it opens a submenu. In a menu with `selectionMode`, a check column comes first
 * (`menuitemcheckbox`). A disabled item (`isDisabled`, or a key in the menu's `disabledKeys`)
 * stays in reach of the arrow keys and type-ahead, so it is announced with its note, and does
 * nothing: Enter, Space and clicks neither run it, toggle it nor close the menu.
 */
export function MenuItem({ icon, children, shortcut, note, destructive, mixed, isDisabled, ...props }: MenuItemProps) {
  const disabledKeys = useContext(DisabledKeys);
  const disabled = isDisabled === true || (props.id !== undefined && disabledKeys.has(props.id));
  return (
    <AriaMenuItem
      {...props}
      {...(disabled ? FOCUSABLE_DISABLED : undefined)}
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
          {note !== undefined && (
            <Text slot="description" className="menu-item__note">
              {note}
            </Text>
          )}
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

/** A group of items with a selection of its own, such as the checkable tags of a Tags submenu. */
export function MenuSection<T extends object>(props: Omit<AriaMenuSectionProps<T>, 'className' | 'style'>) {
  return <AriaMenuSection {...props} className="menu-section" />;
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

/** Shift+F10 alone or the Menu key: the keys that open a context menu from the keyboard (library-actions §2.7). */
export function isContextMenuKey(event: Pick<KeyboardEvent, 'key' | 'shiftKey' | 'ctrlKey' | 'altKey' | 'metaKey'>): boolean {
  const { key, shiftKey, ctrlKey, altKey, metaKey } = event;
  return (key === 'F10' && shiftKey && !ctrlKey && !altKey && !metaKey) || key === 'ContextMenu';
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
  /**
   * Names the popover, which React Aria makes a dialog when no trigger button opened it; the
   * menu's own label, such as "Actions for ps2.pdf".
   */
  label: string;
  /** The `Menu`. Give it `aria-label`. */
  children: ReactNode;
}

/**
 * A menu at a point (library-actions handoff §2.7): its top-left corner 4 px below and right of
 * the anchor, flipped to stay 8 px inside the window. React Aria has no context-menu component,
 * so a controlled popover anchors to an invisible element at the point. Its menus close it when
 * an item is chosen, as in any menu. Closing returns focus to where it was.
 */
export function ContextMenu({ anchor, onClose, label, children }: ContextMenuProps) {
  const anchorRef = useRef<HTMLSpanElement>(null);
  return (
    <CloseContextMenu value={onClose}>
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
        aria-label={label}
        onOpenChange={(isOpen) => {
          if (!isOpen) onClose();
        }}
        placement="bottom start"
        crossOffset={SPACE[4]}
      >
        {children}
      </Popover>
    </CloseContextMenu>
  );
}
