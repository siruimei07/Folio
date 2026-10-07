import './IconButton.css';

import type { LucideIcon } from 'lucide-react';
import type { Ref } from 'react';
import { Button, type ButtonProps, Focusable } from 'react-aria-components';

import { SIZE } from '../../tokens/tokens';
import { Tooltip, type TooltipProps } from '../Tooltip/Tooltip';

export interface IconButtonProps
  extends Omit<ButtonProps, 'className' | 'style' | 'children' | 'aria-label'> {
  icon: LucideIcon;
  /** The accessible name, also shown in the tooltip. */
  label: string;
  /** Shown in the tooltip after the label, like "Ctrl+O". */
  shortcut?: string;
  /**
   * small 24 px (toasts, list rows), medium 26 px (the hover actions of History entries and Not
   * synced commits), regular 28 px (panel headers, dialogs).
   */
  size?: 'small' | 'medium' | 'regular';
  /** ghost: no border; outline: the control border, as in the narrow window's bar. */
  variant?: 'ghost' | 'outline';
  /**
   * Why the button does nothing now (workspace-history handoff §7.3, "disabled with the reason"):
   * it stays focusable with `aria-disabled` and the disabled look, presses do nothing, and its
   * tooltip gives the label and, under it, the reason.
   */
  disabledReason?: string;
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
  disabledReason,
  tooltipPlacement,
  ref,
  ...props
}: IconButtonProps) {
  const icon = <Icon aria-hidden size={size === 'regular' ? SIZE.icon : SIZE.iconSmall} />;
  if (disabledReason !== undefined) {
    // React Aria's `isDisabled` would take it out of the focus and its tooltip with it, as the diff
    // pane's disabled Restore does not (diff/DiffHeader.tsx).
    const content = (
      <>
        {label}
        <span className="icon-button__reason">{disabledReason}</span>
      </>
    );
    return (
      <Tooltip content={content} placement={tooltipPlacement}>
        <Focusable>
          <button
            ref={ref}
            type="button"
            className="icon-button"
            data-size={size}
            data-variant={variant}
            data-disabled
            aria-disabled="true"
            aria-label={label}
          >
            {icon}
          </button>
        </Focusable>
      </Tooltip>
    );
  }
  return (
    <Tooltip content={label} shortcut={shortcut} placement={tooltipPlacement}>
      <Button {...props} ref={ref} aria-label={label} className="icon-button" data-size={size} data-variant={variant}>
        {icon}
      </Button>
    </Tooltip>
  );
}
