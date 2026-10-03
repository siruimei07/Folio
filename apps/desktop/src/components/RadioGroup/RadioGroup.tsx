import './RadioGroup.css';

import { Label, RadioButton, RadioField, RadioGroup as AriaRadioGroup, Text } from 'react-aria-components';

export interface RadioChoice<K extends string> {
  id: K;
  label: string;
  /** One line under the label, which describes the radio to screen readers. */
  description?: string;
}

export interface RadioGroupProps<K extends string> {
  /** Names the group; read only by screen readers when `hideLabel`. */
  label: string;
  hideLabel?: boolean;
  choices: readonly RadioChoice<K>[];
  selected: K;
  onChange: (selected: K) => void;
  isDisabled?: boolean;
}

/**
 * Radio buttons with a label and a one-line description each (library-actions handoff §4.1): a
 * 16 px circle in a 24 px hit area, the accent ring and dot when chosen. One tab stop; the arrow
 * keys choose.
 */
export function RadioGroup<K extends string>({
  label,
  hideLabel = false,
  choices,
  selected,
  onChange,
  isDisabled,
}: RadioGroupProps<K>) {
  return (
    <AriaRadioGroup
      className="radio-group"
      value={selected}
      isDisabled={isDisabled}
      onChange={(value) => {
        const found = choices.find((choice) => choice.id === value);
        if (found !== undefined) onChange(found.id);
      }}
    >
      <Label className={hideLabel ? 'visually-hidden' : 'radio-group__label'}>{label}</Label>
      {choices.map((choice) => (
        <RadioField key={choice.id} value={choice.id} className="radio">
          <RadioButton className="radio__button">
            <span className="radio__hit" aria-hidden>
              <span className="radio__circle" />
            </span>
            <span className="radio__label">{choice.label}</span>
          </RadioButton>
          {choice.description !== undefined && (
            <Text slot="description" className="radio__description">
              {choice.description}
            </Text>
          )}
        </RadioField>
      ))}
    </AriaRadioGroup>
  );
}
