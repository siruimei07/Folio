import { Spinner } from '../Progress/Progress';
import { Button, type ButtonProps } from './Button';

export interface PendingButtonProps extends ButtonProps {
  /** While its command runs: a spinner and this label in place of the button's own. */
  pending: string | null;
}

/**
 * A button that shows a spinner and "Creating…" or "Saving…" while its command runs (first-run
 * handoff §4.4); 34 px unless `size` says otherwise.
 */
export function PendingButton({ pending, children, ...props }: PendingButtonProps) {
  return (
    <Button size="dialog" {...props}>
      {pending !== null && <Spinner size="small" />}
      {pending ?? children}
    </Button>
  );
}
