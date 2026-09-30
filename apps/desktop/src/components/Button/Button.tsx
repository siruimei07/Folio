import './Button.css';

import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { Button as AriaButton, type ButtonProps as AriaButtonProps } from 'react-aria-components';

import { SIZE } from '../../tokens/tokens';

/**
 * primary (Sync), accent (Commit, Save, the main action of a dialog or state block), outline
 * (secondary actions), danger (the confirming button of a destructive dialog), link (actions in
 * toasts and list rows).
 */
export type ButtonVariant = 'primary' | 'accent' | 'outline' | 'danger' | 'link';

/** compact 28 px (popovers, toolbars), regular 32 px (panels, state blocks), dialog 34 px. */
export type ButtonSize = 'compact' | 'regular' | 'dialog';

export interface ButtonProps extends Omit<AriaButtonProps, 'className' | 'style' | 'children'> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** A Lucide icon before the label. */
  icon?: LucideIcon;
  children: ReactNode;
}

/** A text button (app-shell handoff §10, library-actions §2). */
export function Button({ variant = 'outline', size = 'regular', icon: Icon, children, ...props }: ButtonProps) {
  return (
    <AriaButton {...props} className="button" data-variant={variant} data-size={size}>
      {Icon && <Icon aria-hidden size={SIZE.iconSmall} className="button__icon" />}
      {children}
    </AriaButton>
  );
}
