import '../motion.css';
import './Tooltip.css';

import type { ReactElement, ReactNode } from 'react';
import {
  Tooltip as AriaTooltip,
  type TooltipProps as AriaTooltipProps,
  TooltipTrigger,
} from 'react-aria-components';

import { TOOLTIP_DELAY_MS } from '../../lib/timing';
import { SPACE } from '../../tokens/tokens';

export interface TooltipProps {
  /** The tooltip's text; a shortcut, when there is one, goes in `shortcut`. */
  content: ReactNode;
  /** Shown after the text in a key cap, like "Ctrl+1". */
  shortcut?: string;
  placement?: AriaTooltipProps['placement'];
  /** One focusable React Aria element, such as a Button, or a `Focusable`. */
  children: ReactElement;
}

/**
 * A tooltip on hover (after `TOOLTIP_DELAY_MS`, the Windows default) and at once on keyboard focus
 * (library-actions handoff §13). The trigger keeps its own accessible name: the tooltip only
 * repeats it or adds the shortcut.
 */
export function Tooltip({ content, shortcut, placement = 'bottom', children }: TooltipProps) {
  return (
    <TooltipTrigger delay={TOOLTIP_DELAY_MS} closeDelay={0}>
      {children}
      <AriaTooltip
        className="tooltip"
        placement={placement}
        offset={SPACE[6]}
        containerPadding={SPACE[8]}
      >
        <span className="tooltip__text">{content}</span>
        {shortcut !== undefined && <kbd className="tooltip__shortcut">{shortcut}</kbd>}
      </AriaTooltip>
    </TooltipTrigger>
  );
}
