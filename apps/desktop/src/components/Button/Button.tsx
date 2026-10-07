import './Button.css';

import type { LucideIcon } from 'lucide-react';
import { type ReactNode, type Ref, useEffect, useId, useState } from 'react';
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
  /** For moving focus back to it, as after a cancelled native dialog. */
  ref?: Ref<HTMLButtonElement>;
}

/**
 * How long after a button goes its announcement may still arrive: React Aria adds the window's
 * first announcement 100 ms late, once its live region is in the page.
 */
const LATE_ANNOUNCEMENT_MS = 200;

/**
 * React Aria announces a focused button turning pending or back with a node in its live region
 * (`[data-live-announcer]`) labelled by the button, kept for 7 s. A button that goes meanwhile (a
 * first-run step or a dialog replaced) would leave that node naming nothing (axe `role-img-alt`),
 * so the node goes with the button, and one that arrives late follows it. Only a button that has
 * been pending can have one.
 */
function useAnnouncementGoesWithButton(id: string, isPending: boolean): void {
  const [pended, setPended] = useState(false);
  if (isPending && !pended) setPended(true);
  useEffect(() => {
    if (!pended) return undefined;
    return () => {
      const remove = () => {
        const log = document.querySelector('[data-live-announcer]');
        for (const node of log?.querySelectorAll(`[aria-labelledby~="${CSS.escape(id)}"]`) ?? []) node.remove();
      };
      remove();
      window.setTimeout(remove, LATE_ANNOUNCEMENT_MS);
    };
  }, [pended, id]);
}

/** A text button (app-shell handoff §10, library-actions §2). */
export function Button({ variant = 'outline', size = 'regular', icon: Icon, children, id: givenId, ...props }: ButtonProps) {
  const ownId = useId();
  const id = givenId ?? ownId;
  useAnnouncementGoesWithButton(id, props.isPending === true);
  return (
    <AriaButton {...props} id={id} className="button" data-variant={variant} data-size={size}>
      {Icon && <Icon aria-hidden size={SIZE.iconSmall} className="button__icon" />}
      {children}
    </AriaButton>
  );
}
