import '../inputs.css';
import './Field.css';

import type { KeyboardEvent, ReactNode, Ref } from 'react';
import { useEffect, useId } from 'react';

import { FieldError } from '../FieldError/FieldError';

export interface FieldProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  /** A message under the field: it turns the field's bottom edge red and describes it (§2.1). */
  error: string | null;
  help?: ReactNode;
  /** full: the column's width; short: `size.first-run-field` (the first run's semester). */
  width?: 'full' | 'short';
  readOnly?: boolean;
  /** A button after the input, like "Change…" or "Save" (app-shell handoff §9). */
  trailing?: ReactNode;
  /** The input's font: mono for paths. */
  mono?: boolean;
  inputRef?: Ref<HTMLInputElement>;
  /** Takes focus when it mounts: the first field of a dialog. */
  autoFocus?: boolean;
  onBlur?: () => void;
  /** Enter, outside an IME composition. */
  onEnter?: () => void;
}

/**
 * A labelled text field (first-run handoff §4.1, app-shell handoff §9 "Fields"): label, input with
 * an optional button after it, help and its error (library-actions §2.1).
 */
export function Field({
  label,
  value,
  onChange,
  error,
  help,
  width = 'full',
  readOnly = false,
  trailing,
  mono = false,
  inputRef,
  autoFocus = false,
  onBlur,
  onEnter,
}: FieldProps) {
  const id = useId();
  // After the frame: a dialog opened from a menu first gets focus back to the menu's button, and
  // React Aria then focuses the dialog itself; the field takes it from there.
  useEffect(() => {
    if (!autoFocus) return;
    const frame = requestAnimationFrame(() => {
      document.getElementById(id)?.focus();
    });
    return () => {
      cancelAnimationFrame(frame);
    };
  }, [autoFocus, id]);
  const helpId = `${id}-help`;
  const errorId = `${id}-error`;
  const described = [error !== null ? errorId : null, help !== undefined ? helpId : null].filter(Boolean);
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'Enter' || event.nativeEvent.isComposing || onEnter === undefined) return;
    event.preventDefault();
    onEnter();
  };
  const input = (
    <input
      ref={inputRef}
      id={id}
      className="text-input field__input"
      data-mono={mono || undefined}
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
  );
  return (
    <div className="field" data-width={width}>
      <label className="field__label" htmlFor={id}>
        {label}
      </label>
      {trailing === undefined ? (
        input
      ) : (
        <div className="field__row">
          {input}
          {trailing}
        </div>
      )}
      {error !== null && <FieldError id={errorId}>{error}</FieldError>}
      {help !== undefined && (
        <p id={helpId} className="field__help">
          {help}
        </p>
      )}
    </div>
  );
}
