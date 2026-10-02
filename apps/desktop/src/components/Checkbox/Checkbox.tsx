import './Checkbox.css';

import { Check } from 'lucide-react';
import { CheckboxButton, CheckboxField } from 'react-aria-components';

import { SIZE } from '../../tokens/tokens';

export interface CheckboxProps {
  /** The visible label after the box, which is also its accessible name. */
  children: string;
  isSelected: boolean;
  onChange: (isSelected: boolean) => void;
  isDisabled?: boolean;
}

/**
 * A checkbox with its label (library-actions handoff §12): a 15 px box in a 24 px hit area, the
 * accent fill and a check when selected.
 */
export function Checkbox({ children, isSelected, onChange, isDisabled }: CheckboxProps) {
  return (
    <CheckboxField isSelected={isSelected} onChange={onChange} isDisabled={isDisabled}>
      <CheckboxButton className="checkbox">
        <span className="checkbox__hit" aria-hidden>
          <span className="checkbox__box">{isSelected && <Check size={SIZE.iconTiny} />}</span>
        </span>
        <span className="checkbox__label">{children}</span>
      </CheckboxButton>
    </CheckboxField>
  );
}
