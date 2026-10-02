import type { KeyboardEvent, ReactNode, Ref } from 'react';
import { useId } from 'react';

import { FieldError } from '../components/FieldError/FieldError';

export interface FieldProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  /** A message under the field: it turns the field's bottom edge red and describes it (§8). */
  error: string | null;
  help?: ReactNode;
  /** full: the column's width; short: `size.first-run-field` (the semester). */
  width?: 'full' | 'short';
  readOnly?: boolean;
  inputRef?: Ref<HTMLInputElement>;
  onBlur?: () => void;
  /** Enter, outside an IME composition. */
  onEnter?: () => void;
}

/** A labelled text field of a first-run step (§4.1): label, input, help and its error (§8). */
export function Field({
  label,
  value,
  onChange,
  error,
  help,
  width = 'full',
  readOnly = false,
  inputRef,
  onBlur,
  onEnter,
}: FieldProps) {
  const id = useId();
  const helpId = `${id}-help`;
  const errorId = `${id}-error`;
  const described = [error !== null ? errorId : null, help !== undefined ? helpId : null].filter(Boolean);
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'Enter' || event.nativeEvent.isComposing || onEnter === undefined) return;
    event.preventDefault();
    onEnter();
  };
  return (
    <div className="field" data-width={width}>
      <label className="field__label" htmlFor={id}>
        {label}
      </label>
      <input
        ref={inputRef}
        id={id}
        className="field__input"
        value={value}
        readOnly={readOnly}
        spellCheck={false}
        autoComplete="off"
        aria-invalid={error !== null || undefined}
        aria-describedby={described.length > 0 ? described.join(' ') : undefined}
        onChange={(event) => {
          onChange(event.target.value);
        }}
        onBlur={onBlur}
        onKeyDown={onKeyDown}
      />
      {error !== null && <FieldError id={errorId}>{error}</FieldError>}
      {help !== undefined && (
        <p id={helpId} className="field__help">
          {help}
        </p>
      )}
    </div>
  );
}
