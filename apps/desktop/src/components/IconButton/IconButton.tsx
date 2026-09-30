import './IconButton.css';

import type { LucideIcon } from 'lucide-react';
import type { Ref } from 'react';
import { Button, type ButtonProps } from 'react-aria-components';

import { SIZE } from '../../tokens/tokens';
import { Tooltip, type TooltipProps } from '../Tooltip/Tooltip';

export interface IconButtonProps
  extends Omit<ButtonProps, 'className' | 'style' | 'children' | 'aria-label'> {
  icon: LucideIcon;
  /** The accessible name, also shown in the tooltip. */
  label: string;
  /** Shown in the tooltip after the label, like "Ctrl+O". */
  shortcut?: string;
  /** small 24 px (toasts, list rows), regular 28 px (panel headers, dialogs). */
  size?: 'small' | 'regular';
  /** ghost: no border; outline: the control border, as in the narrow window's bar. */
  variant?: 'ghost' | 'outline';
  tooltipPlacement?: TooltipProps['placement'];
  ref?: Ref<HTMLButtonElement>;
}

/** A square button with only an icon; its label shows in a tooltip (app-shell handoff §10). */
export function IconButton({
  icon: Icon,
  label,
  shortcut,
  size = 'regular',
  variant = 'ghost',
  tooltipPlacement,
  ...props
}: IconButtonProps) {
  return (
    <Tooltip content={label} shortcut={shortcut} placement={tooltipPlacement}>
      <Button {...props} aria-label={label} className="icon-button" data-size={size} data-variant={variant}>
        <Icon aria-hidden size={size === 'small' ? SIZE.iconSmall : SIZE.icon} />
      </Button>
    </Tooltip>
  );
}
