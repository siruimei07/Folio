import './FieldError.css';

import { CircleAlert } from 'lucide-react';

import { SIZE } from '../../tokens/tokens';

export interface FieldErrorProps {
  /** The field points at it with `aria-describedby`, and sets `aria-invalid`. */
  id: string;
  children: string;
}

/**
 * A field's error under it: an alert icon and the message in the danger colour (library-actions
 * handoff §2.1). The field keeps its borders; its bottom edge turns the danger colour.
 */
export function FieldError({ id, children }: FieldErrorProps) {
  return (
    <p id={id} className="field-error">
      <CircleAlert aria-hidden size={SIZE.iconSmall} className="field-error__icon" />
      <span>{children}</span>
    </p>
  );
}
