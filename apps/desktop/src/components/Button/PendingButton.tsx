import { Spinner } from '../Progress/Progress';
import { Button, type ButtonProps } from './Button';

export interface PendingButtonProps extends ButtonProps {
  /** While its command runs: a spinner and this label in place of the button's own. */
  pending: string | null;
}

/**
 * A button that shows a spinner and "Creating…" or "Saving…" while its command runs (first-run
 * handoff §4.4); 34 px unless `size` says otherwise. While it shows its pending label it is pending
 * in React Aria's sense (workspace-history handoff §8.5): `aria-disabled`, the disabled look,
 * presses and hover ignored, focus kept, and the change announced when it has focus. `isPending`
 * alone makes it pending with its own label, as the import dialog's check does.
 */
export function PendingButton({ pending, isPending = false, children, ...props }: PendingButtonProps) {
  return (
    <Button size="dialog" {...props} isPending={isPending || pending !== null}>
      {pending !== null && <Spinner size="small" />}
      {pending ?? children}
    </Button>
  );
}
