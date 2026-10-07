import './Checkbox.css';

import { Check, Minus } from 'lucide-react';
import type { MouseEvent } from 'react';
import { CheckboxButton, CheckboxField } from 'react-aria-components';

import { SIZE } from '../../tokens/tokens';

/** On, off, or mixed: some of what it stands for is on (a select-all box). */
export type CheckState = boolean | 'mixed';

type CheckboxNaming =
  /** The visible label after the box, which is also its accessible name. */
  | { children: string; 'aria-label'?: undefined }
  /** No visible label: the accessible name, such as "Include all changes" for a header's box. */
  | { children?: undefined; 'aria-label': string };

export type CheckboxProps = CheckboxNaming & {
  isSelected: boolean;
  /** Mixed: drawn with a dash; a press turns it on (`onChange(true)`). */
  isIndeterminate?: boolean;
  onChange: (isSelected: boolean) => void;
  isDisabled?: boolean;
};

/** The box itself, 15 px: the accent fill with a check when on, a dash when mixed. */
function Box({ state }: { state: CheckState }) {
  return (
    <span className="checkbox__box">
      {state === 'mixed' ? <Minus size={SIZE.iconTiny} /> : state && <Check size={SIZE.iconTiny} />}
    </span>
  );
}

/**
 * A checkbox (library-actions handoff §12): a 15 px box in a 24 px hit area, the accent fill and
 * a check when selected, a dash when mixed, and its label after it or only an accessible name.
 */
export function Checkbox({ children, 'aria-label': ariaLabel, isSelected, isIndeterminate = false, onChange, isDisabled }: CheckboxProps) {
  return (
    <CheckboxField
      isSelected={isSelected}
      isIndeterminate={isIndeterminate}
      onChange={onChange}
      isDisabled={isDisabled}
      aria-label={ariaLabel}
    >
      <CheckboxButton className="checkbox">
        <span className="checkbox__hit" aria-hidden>
          <Box state={isIndeterminate ? 'mixed' : isSelected} />
        </span>
        {children !== undefined && <span className="checkbox__label">{children}</span>}
      </CheckboxButton>
    </CheckboxField>
  );
}

export interface CheckboxMarkProps {
  state: CheckState;
  isDisabled?: boolean;
  /** A click on the box or its hit area, with its modifier keys (Shift for a range). */
  onPress: (event: MouseEvent<HTMLSpanElement>) => void;
}

/**
 * The box of a row whose own element carries the state, as an option with `aria-checked` does
 * (workspace-history handoff §3.6): drawn like `Checkbox` in its 24 px hit area, hidden from
 * screen readers and out of the tab order. A click on it goes to `onPress` alone: the row around
 * it keeps the focus and the selection, and hears nothing of it.
 */
export function CheckboxMark({ state, isDisabled = false, onPress }: CheckboxMarkProps) {
  return (
    <span
      className="checkbox checkbox--mark"
      aria-hidden
      data-selected={state === true || undefined}
      data-indeterminate={state === 'mixed' || undefined}
      data-disabled={isDisabled || undefined}
      onMouseDown={(event) => {
        // The focus stays where it is: the box is not where the keyboard goes.
        event.preventDefault();
      }}
      onClick={(event) => {
        event.stopPropagation();
        if (!isDisabled) onPress(event);
      }}
    >
      <span className="checkbox__hit">
        <Box state={state} />
      </span>
    </span>
  );
}
