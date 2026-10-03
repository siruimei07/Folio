import '../motion.css';
import './Popover.css';

import { Popover as AriaPopover, type PopoverProps as AriaPopoverProps } from 'react-aria-components';

import { SPACE } from '../../tokens/tokens';

/** On every open popover, so the app can tell that a menu is open. */
export const POPOVER_ATTRIBUTE = 'data-popover';

/** Whether a menu, submenu or popover is on screen. */
export function isPopoverOpen(): boolean {
  return document.querySelector(`[${POPOVER_ATTRIBUTE}]`) !== null;
}

export interface PopoverProps extends Omit<AriaPopoverProps, 'className'> {
  /** Sizes the popover, like `menu-popover`. */
  className?: string;
}

/**
 * The surface of menus, submenus, context menus and the Activity popover (library-actions handoff
 * §2.7, §10.2): the panel with a border and `shadow.menu`, 4 px from its trigger, 8 px inside the
 * window, fading in and out.
 */
export function Popover({ className, ...props }: PopoverProps) {
  return (
    <AriaPopover
      offset={SPACE[4]}
      containerPadding={SPACE[8]}
      {...props}
      {...{ [POPOVER_ATTRIBUTE]: '' }}
      className={className === undefined ? 'popover' : `popover ${className}`}
    />
  );
}
