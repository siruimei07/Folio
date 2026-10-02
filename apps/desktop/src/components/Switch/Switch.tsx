import './Switch.css';

import { SwitchButton, SwitchField } from 'react-aria-components';

export interface SwitchProps {
  /** The accessible name; the visible label is the row's, which says the same. */
  label: string;
  isSelected: boolean;
  onChange: (isSelected: boolean) => void;
  isDisabled?: boolean;
  /** The ids of the row's description, which describes the switch. */
  'aria-describedby'?: string;
}

/**
 * A switch (app-shell handoff §9): 36 × 20, off a transparent track with a border and knob in
 * `color.toggle.off`, on a `color.toggle.on` track with the knob in the text-on-accent colour.
 * Switches apply at once.
 */
export function Switch({ label, isSelected, onChange, isDisabled, ...describing }: SwitchProps) {
  return (
    <SwitchField aria-label={label} isSelected={isSelected} onChange={onChange} isDisabled={isDisabled} {...describing}>
      <SwitchButton className="switch">
        <span className="switch__track" aria-hidden>
          <span className="switch__knob" />
        </span>
      </SwitchButton>
    </SwitchField>
  );
}
