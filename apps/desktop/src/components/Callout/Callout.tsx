import './Callout.css';

import { CircleAlert } from 'lucide-react';

import { SIZE } from '../../tokens/tokens';

export interface CalloutProps {
  /** The field points at it with `aria-describedby`. */
  id: string;
  /**
   * The message. It is announced when the callout appears and when this text changes, so pass a
   * new text only when the error changes, never on every keystroke.
   */
  children: string;
}

/**
 * An error for a field inside a row (inline rename, new folder; library-actions handoff §2.2):
 * anchored 5 px under the field with a notch, as wide as the field up to 300 px. Render it inside a
 * positioned element that wraps the field, so it follows the field when the list scrolls.
 */
export function Callout({ id, children }: CalloutProps) {
  return (
    <div id={id} className="callout" role="alert">
      <CircleAlert aria-hidden size={SIZE.iconSmall} className="callout__icon" />
      <span>{children}</span>
    </div>
  );
}
