import '../inputs.css';
import './CourseRows.css';

import { Check, Plus, X } from 'lucide-react';
import type { KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';

import { courseBadgeText } from '../../lib/courses';
import type { PaletteColor } from '../../lib/palette';
import { SIZE } from '../../tokens/tokens';
import { Button } from '../Button/Button';
import { ColourButton } from '../ColourButton/ColourButton';
import { CourseBadge } from '../CourseBadge/CourseBadge';
import { FieldError } from '../FieldError/FieldError';
import { IconButton } from '../IconButton/IconButton';

/** One course row (first-run handoff §5): a new one, or a folder the scan found. */
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
  /** Under "Add course": how rows are added and what can change later. */
  help?: string;
  /** Waiting for the shell: the fields are read-only and the buttons do nothing. */
  busy: boolean;
}

/**
 * Course rows (CourseRowsEditor, first-run handoff §5.1): badge preview, code, name, colour and
 * remove, under the column headings. Step 2 uses it for a new library and for a folder taken
 * over; "New semester…" and "Add courses" (library-actions §8) reuse it.
 */
export function CourseRows({
  rows,
  mode,
  idPrefix,
  onChange,
  onBlur,
  onEnter,
  onRemove,
  onAdd,
  help,
  busy,
}: CourseRowsProps) {
  const { t } = useTranslation('common');
  const onKey = (key: string, field: RowField) => (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'Enter' || event.nativeEvent.isComposing) return;
    event.preventDefault();
    onEnter(key, field);
  };
  return (
    <div className="course-rows">
      <div className="course-rows__headings" aria-hidden>
        <span className="course-rows__code-heading">{t('courseRows.codeHeading')}</span>
        <span>{mode === 'new' ? t('courseRows.nameHeading') : t('courseRows.folderHeading')}</span>
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
                  className="text-input course-row__input course-row__code"
                  value={row.code}
                  placeholder={t('courseRows.codePlaceholder')}
                  aria-label={t('courseRows.codeLabel', { number })}
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
                    className="text-input course-row__input course-row__name"
                    value={row.name}
                    placeholder={t('courseRows.namePlaceholder')}
                    aria-label={t('courseRows.nameLabel', { number })}
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
                  label={t('courseRows.colourLabel', { number, colour: t(`colour.names.${row.color}`) })}
                  color={row.color}
                  badge={row.name.trim() === '' ? '' : courseBadgeText({ abbr: null, name: row.name.trim() })}
                  isDisabled={locked}
                  onChange={(color) => {
                    onChange(row.key, { color });
                  }}
                />
                {mode === 'new' &&
                  (row.done ? (
                    <span className="course-row__done">
                      <Check aria-hidden size={SIZE.iconSmall} />
                      <span className="visually-hidden">{t('courseRows.created', { number })}</span>
                    </span>
                  ) : (
                    <IconButton
                      icon={X}
                      label={t('courseRows.remove', { number })}
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
            {t('courseRows.add')}
          </Button>
          {help !== undefined && <p className="course-rows__help">{help}</p>}
        </div>
      )}
    </div>
  );
}
