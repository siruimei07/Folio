import '../motion.css';
import './Popover.css';

import { Popover as AriaPopover, type PopoverProps as AriaPopoverProps } from 'react-aria-components';

import { SPACE } from '../../tokens/tokens';

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
      className={className === undefined ? 'popover' : `popover ${className}`}
    />
  );
}
