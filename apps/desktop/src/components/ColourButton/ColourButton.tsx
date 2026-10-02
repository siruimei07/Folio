import '../inputs.css';
import '../palette.css';
import './ColourButton.css';

import { ChevronDown } from 'lucide-react';
import { type KeyboardEvent, type MouseEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button as AriaButton, Dialog, DialogTrigger, RadioButton, RadioField, RadioGroup } from 'react-aria-components';

import { isPaletteColor, PALETTE, type PaletteColor } from '../../lib/palette';
import { SIZE } from '../../tokens/tokens';
import { Popover } from '../Popover/Popover';

export interface ColourButtonProps {
  /** The button's accessible name, which names the colour: "Course 1 colour: Teal". */
  label: string;
  color: PaletteColor;
  onChange: (color: PaletteColor) => void;
  /** The badge text the colour goes with, for the popover's footer; `''`: a tag or no name yet. */
  badge?: string;
  isDisabled?: boolean;
}

/**
 * A course's or tag's colour (first-run handoff §5.1): a button with the colour's dot, and its
 * popover, a radio group of the ten palette colours. Arrow keys move and select; Enter, Space or
 * a click closes it, and Esc closes it; focus returns to the button.
 */
export function ColourButton({ label, color, onChange, badge = '', isDisabled = false }: ColourButtonProps) {
  const { t } = useTranslation('common');
  const [open, setOpen] = useState(false);
  const colourName = (key: PaletteColor) => t(`colour.names.${key}`);
  // Arrow keys only move the selection; Enter, Space or a click on a swatch, the selected one
  // too, closes. Captured, because the radios' own press handling stops these events.
  const onKeyDownCapture = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      setOpen(false);
    }
  };
  const onClickCapture = (event: MouseEvent<HTMLElement>) => {
    if (event.target instanceof Element && event.target.closest('label') !== null) setOpen(false);
  };
  return (
    <DialogTrigger isOpen={open} onOpenChange={setOpen}>
      <AriaButton className="colour-button" aria-label={label} isDisabled={isDisabled}>
        <span className="colour-button__dot" data-palette={color} aria-hidden />
        <ChevronDown aria-hidden size={SIZE.iconTiny} className="colour-button__chevron" />
      </AriaButton>
      <Popover placement="bottom end">
        <Dialog className="colour-popover__dialog" aria-label={t('colour.caption')}>
          {/* Not a control: it only sees the keys that close the popover. */}
          <div className="colour-popover__content" onKeyDownCapture={onKeyDownCapture} onClickCapture={onClickCapture}>
            <p className="colour-popover__caption" aria-hidden>
              {t('colour.caption')}
            </p>
            <RadioGroup
              className="colour-popover__swatches"
              aria-label={t('colour.caption')}
              value={color}
              onChange={(value) => {
                if (isPaletteColor(value)) onChange(value);
              }}
            >
              {PALETTE.map((key) => (
                <RadioField
                  key={key}
                  value={key}
                  aria-label={colourName(key)}
                  // The popover opens on the selected colour (§9).
                  autoFocus={key === color}
                >
                  <RadioButton className="swatch">
                    <span className="swatch__dot" data-palette={key} title={colourName(key)} />
                  </RadioButton>
                </RadioField>
              ))}
            </RadioGroup>
            <p className="colour-popover__footer">
              {badge === ''
                ? t('colour.footerNoBadge', { colour: colourName(color) })
                : t('colour.footer', { colour: colourName(color), badge })}
            </p>
          </div>
        </Dialog>
      </Popover>
    </DialogTrigger>
  );
}
