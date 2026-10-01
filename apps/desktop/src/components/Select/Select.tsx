import '../Popover/Popover.css';
import './Select.css';

import { ChevronDown } from 'lucide-react';
import {
  Button,
  type Key,
  Label,
  ListBox,
  ListBoxItem,
  Select as AriaSelect,
  SelectValue,
} from 'react-aria-components';

import { SIZE } from '../../tokens/tokens';
import { Popover } from '../Popover/Popover';

export interface SelectOption<K extends Key> {
  id: K;
  label: string;
}

export interface SelectProps<K extends Key> {
  /** The visible label before the select. */
  label: string;
  options: readonly SelectOption<K>[];
  selected: K | null;
  onChange: (id: K) => void;
  isDisabled?: boolean;
}

/**
 * A select (app-shell handoff §9, library-actions §2.9): a 32 px button with the input borders and
 * a chevron, opening a list box under it. React Aria's `Select` gives the keyboard and the labels.
 */
export function Select<K extends Key>({ label, options, selected, onChange, isDisabled }: SelectProps<K>) {
  return (
    <AriaSelect
      className="select"
      value={selected}
      isDisabled={isDisabled}
      onChange={(key) => {
        const option = options.find(({ id }) => id === key);
        if (option) onChange(option.id);
      }}
    >
      <Label className="select__label">{label}</Label>
      <Button className="select__button">
        <SelectValue className="select__value" />
        <ChevronDown aria-hidden size={SIZE.iconSmall} className="select__chevron" />
      </Button>
      <Popover className="select-popover" placement="bottom start">
        <ListBox className="select__list" items={options}>
          {(option) => (
            <ListBoxItem id={option.id} className="select__option" textValue={option.label}>
              {option.label}
            </ListBoxItem>
          )}
        </ListBox>
      </Popover>
    </AriaSelect>
  );
}
