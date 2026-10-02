import { Info } from 'lucide-react';
import type { ReactNode, RefObject } from 'react';

import { Button, type ButtonProps } from '../components/Button/Button';
import { Spinner } from '../components/Progress/Progress';
import { SIZE } from '../tokens/tokens';
import { COMMAND_ACTIONS, type StepAction, type StepFooter } from './failures';

/** "Step 1 of 2", the title and one line of intro (§4.1). */
export function StepHeader({ step, title, intro }: { step: string; title: string; intro?: string }) {
  return (
    <header className="step__header">
      <p className="step__count">{step}</p>
      <h1 className="step__title">{title}</h1>
      {intro !== undefined && <p className="step__intro">{intro}</p>}
    </header>
  );
}

/** A note on the sunken surface with an information icon (§4.1). */
export function Note({ children }: { children: ReactNode }) {
  return (
    <p className="note">
      <Info aria-hidden size={SIZE.icon} className="note__icon" />
      <span>{children}</span>
    </p>
  );
}

/** Focuses the accent button inside `container`: after a failure it is the way on (§4.4). */
export function focusAccent(container: RefObject<HTMLElement | null>): HTMLElement | null {
  const accent = container.current?.querySelector<HTMLElement>('[data-variant="accent"]') ?? null;
  accent?.focus();
  return accent;
}

export interface PendingButtonProps extends ButtonProps {
  /** While its command runs: a spinner and this label in place of the button's own (§4.4). */
  pending: string | null;
}

/** A 34 px button that shows a spinner and "Creating…" while its command runs. */
export function PendingButton({ pending, children, ...props }: PendingButtonProps) {
  return (
    <Button size="dialog" {...props}>
      {pending !== null && <Spinner size="small" />}
      {pending ?? children}
    </Button>
  );
}

export interface StepFooterRowProps {
  footer: StepFooter;
  labels: Record<StepAction, string>;
  onAction: (action: StepAction) => () => void;
  /** While a command runs: what its buttons say instead. */
  running: string | null;
  footerRef: RefObject<HTMLDivElement | null>;
}

/** The footer row of step 1 (§4.1): secondary buttons on the left, the accent button last. */
export function StepFooterRow({ footer, labels, onAction, running, footerRef }: StepFooterRowProps) {
  const button = (action: StepAction, accent: boolean) => (
    <PendingButton
      key={action}
      variant={accent ? 'accent' : 'outline'}
      pending={COMMAND_ACTIONS.has(action) ? running : null}
      onPress={onAction(action)}
    >
      {labels[action]}
    </PendingButton>
  );
  return (
    <div ref={footerRef} className="step__footer">
      <div className="step__footer-start">{footer.start.map((action) => button(action, false))}</div>
      <div className="step__footer-end">
        {footer.end.map((action, index) => button(action, index === footer.end.length - 1))}
      </div>
    </div>
  );
}
