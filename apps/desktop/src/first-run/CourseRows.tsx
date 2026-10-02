import '../components/palette.css';

import { Check, ChevronDown, Plus, X } from 'lucide-react';
import { type KeyboardEvent, type MouseEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button as AriaButton, Dialog, DialogTrigger, RadioButton, RadioField, RadioGroup } from 'react-aria-components';

import { Button } from '../components/Button/Button';
import { CourseBadge } from '../components/CourseBadge/CourseBadge';
import { FieldError } from '../components/FieldError/FieldError';
import { IconButton } from '../components/IconButton/IconButton';
import { Popover } from '../components/Popover/Popover';
import { courseBadgeText } from '../lib/courses';
import { isPaletteColor, PALETTE, type PaletteColor } from '../lib/palette';
import { SIZE } from '../tokens/tokens';

/** One course of step 2 (first-run handoff §5): a new one, or a folder the scan found. */
export interface CourseRow {
  /** Stable while the row lives: a counter for new rows, the folder path for found ones. */
  key: string;
  code: string;
  /** What the user typed (new), or the folder's name (found, read-only). */
  name: string;
  color: PaletteColor;
  /** Created (new rows): read-only, with a check in place of the remove button. */
  done: boolean;
  /** Messages under the row's name and code (§8). */
  nameError: string | null;
  codeError: string | null;
}

/** Which field of a row, for focusing it. */
export type RowField = 'code' | 'name';

/** The input of `field` in the row `key`, so a page can move focus to it. */
export function rowInputId(prefix: string, key: string, field: RowField): string {
  return `${prefix}-${key}-${field}`;
}

interface ColourButtonProps {
  number: number;
  row: CourseRow;
  onChange: (color: PaletteColor) => void;
  isDisabled: boolean;
}

/**
 * A row's colour (§5.1): the button with the colour's dot, and its popover, a radio group of the
 * ten palette colours. Arrow keys move and select; Enter, Space or a click closes it, and Esc
 * closes it; focus returns to the button.
 */
function ColourButton({ number, row, onChange, isDisabled }: ColourButtonProps) {
  const { t } = useTranslation('first-run');
  const [open, setOpen] = useState(false);
  const colourName = (color: PaletteColor) => t(`colour.names.${color}`);
  const badge = row.name.trim() === '' ? '' : courseBadgeText({ abbr: null, name: row.name.trim() });
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
      <AriaButton
        className="colour-button"
        aria-label={t('courses.colourLabel', { number, colour: colourName(row.color) })}
        isDisabled={isDisabled}
      >
        <span className="colour-button__dot" data-palette={row.color} aria-hidden />
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
              value={row.color}
              onChange={(value) => {
                if (isPaletteColor(value)) onChange(value);
              }}
            >
              {PALETTE.map((color) => (
                <RadioField
                  key={color}
                  value={color}
                  aria-label={colourName(color)}
                  // The popover opens on the selected colour (§9).
                  autoFocus={color === row.color}
                >
                  <RadioButton className="swatch">
                    <span className="swatch__dot" data-palette={color} title={colourName(color)} />
                  </RadioButton>
                </RadioField>
              ))}
            </RadioGroup>
            <p className="colour-popover__footer">
              {badge === ''
                ? t('colour.footerNoBadge', { colour: colourName(row.color) })
                : t('colour.footer', { colour: colourName(row.color), badge })}
            </p>
          </div>
        </Dialog>
      </Popover>
    </DialogTrigger>
  );
}

export interface CourseRowsProps {
  rows: readonly CourseRow[];
  /** new: names typed, rows added and removed (§5.1); found: names are folders (§5.2). */
  mode: 'new' | 'found';
  /** Prefix of the inputs' ids (`rowInputId`). */
  idPrefix: string;
  onChange: (key: string, change: Partial<Pick<CourseRow, 'code' | 'name' | 'color'>>) => void;
  /** Blur of a field: its rules that wait until the user leaves it (§8). */
  onBlur?: (key: string, field: RowField) => void;
  /** Enter in a field of a row. */
  onEnter: (key: string, field: RowField) => void;
  onRemove?: (key: string) => void;
  onAdd?: () => void;
  /** Waiting for the shell: the fields are read-only and the buttons do nothing. */
  busy: boolean;
}

/**
 * Course rows (CourseRowsEditor, first-run handoff §5.1): badge preview, code, name, colour and
 * remove, under the column headings. Step 2 uses it for a new library and for a folder taken
 * over; "New semester…" and "Add courses" (library-actions §8) are to reuse it.
 */
export function CourseRows({ rows, mode, idPrefix, onChange, onBlur, onEnter, onRemove, onAdd, busy }: CourseRowsProps) {
  const { t } = useTranslation('first-run');
  const onKey = (key: string, field: RowField) => (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'Enter' || event.nativeEvent.isComposing) return;
    event.preventDefault();
    onEnter(key, field);
  };
  return (
    <div className="course-rows">
      <div className="course-rows__headings" aria-hidden>
        <span className="course-rows__code-heading">{t('courses.codeHeading')}</span>
        <span>{mode === 'new' ? t('courses.nameHeading') : t('courses.folderHeading')}</span>
      </div>
      <ol className="course-rows__list">
        {rows.map((row, index) => {
          const number = index + 1;
          const codeId = rowInputId(idPrefix, row.key, 'code');
          const nameId = rowInputId(idPrefix, row.key, 'name');
          const locked = busy || row.done;
          return (
            <li key={row.key} className="course-row" data-done={row.done || undefined}>
              <div className="course-row__fields">
                {row.name.trim() === '' ? (
                  <span className="course-row__placeholder" aria-hidden />
                ) : (
                  <CourseBadge
                    course={{ abbr: null, name: row.name.trim(), color: row.color, folder: { id: '', path: row.name } }}
                  />
                )}
                <input
                  id={codeId}
                  className="course-row__input course-row__code"
                  value={row.code}
                  placeholder={t('courses.codePlaceholder')}
                  aria-label={t('courses.codeLabel', { number })}
                  aria-invalid={row.codeError !== null || undefined}
                  // A found row's code is described by its folder, which names the course (§5.2).
                  aria-describedby={
                    [mode === 'found' ? nameId : null, row.codeError !== null ? `${codeId}-error` : null]
                      .filter(Boolean)
                      .join(' ') || undefined
                  }
                  readOnly={locked}
                  spellCheck={false}
                  autoComplete="off"
                  onChange={(event) => {
                    onChange(row.key, { code: event.target.value });
                  }}
                  onBlur={() => onBlur?.(row.key, 'code')}
                  onKeyDown={onKey(row.key, 'code')}
                />
                {mode === 'new' ? (
                  <input
                    id={nameId}
                    className="course-row__input course-row__name"
                    value={row.name}
                    placeholder={t('courses.namePlaceholder')}
                    aria-label={t('courses.nameLabel', { number })}
                    aria-invalid={row.nameError !== null || undefined}
                    aria-describedby={row.nameError !== null ? `${nameId}-error` : undefined}
                    readOnly={locked}
                    spellCheck={false}
                    autoComplete="off"
                    onChange={(event) => {
                      onChange(row.key, { name: event.target.value });
                    }}
                    onBlur={() => onBlur?.(row.key, 'name')}
                    onKeyDown={onKey(row.key, 'name')}
                  />
                ) : (
                  <span id={nameId} className="course-row__folder">
                    {row.name}
                  </span>
                )}
                <ColourButton
                  number={number}
                  row={row}
                  isDisabled={locked}
                  onChange={(color) => {
                    onChange(row.key, { color });
                  }}
                />
                {mode === 'new' &&
                  (row.done ? (
                    <span className="course-row__done">
                      <Check aria-hidden size={SIZE.iconSmall} />
                      <span className="visually-hidden">{t('courses.created', { number })}</span>
                    </span>
                  ) : (
                    <IconButton
                      icon={X}
                      label={t('courses.remove', { number })}
                      isDisabled={busy}
                      onPress={() => onRemove?.(row.key)}
                    />
                  ))}
              </div>
              {row.codeError !== null && <FieldError id={`${codeId}-error`}>{row.codeError}</FieldError>}
              {row.nameError !== null && <FieldError id={`${nameId}-error`}>{row.nameError}</FieldError>}
            </li>
          );
        })}
      </ol>
      {mode === 'new' && onAdd !== undefined && (
        <div className="course-rows__add">
          <Button id={`${idPrefix}-add`} icon={Plus} isDisabled={busy} onPress={onAdd}>
            {t('courses.add')}
          </Button>
          <p className="course-rows__help">{t('courses.help')}</p>
        </div>
      )}
    </div>
  );
}
