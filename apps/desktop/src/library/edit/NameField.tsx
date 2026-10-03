import './NameField.css';

import { type KeyboardEvent, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Callout } from '../../components/Callout/Callout';
import { extensionOf } from '../../lib/file-types';
import { hasInvalidNameCharacter } from '../../lib/names';

export interface NameFieldProps {
  /** The name it starts with. */
  initial: string;
  /** A file: the name before its extension starts selected; otherwise all of it. */
  file: boolean;
  /** The field's accessible name, like "New name for ps2.pdf". */
  label: string;
  /** A message from the shell for the last name sent; the field stays open with it. */
  error: string | null;
  /** Waiting for the shell: keys do nothing. */
  busy?: boolean;
  /**
   * Enter, or focus leaving (`via`): the name typed, which never holds a character Windows
   * refuses. After Enter focus goes back to the row; after a blur it stays where it went.
   */
  onSubmit: (name: string, via: 'enter' | 'blur') => void;
  /** Esc. */
  onCancel: () => void;
}

/**
 * A name typed in place, in a row or a tile (library-actions handoff §7.1, §7.2): Enter or moving
 * focus away commits, Esc cancels. Characters Windows does not allow show the callout while
 * typing and keep Enter from doing anything; the shell's own errors arrive in `error`.
 */
export function NameField({ initial, file, label, error, busy = false, onSubmit, onCancel }: NameFieldProps) {
  const { t } = useTranslation('library');
  const [value, setValue] = useState(initial);
  const [empty, setEmpty] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  const calloutId = useId();
  const invalid = hasInvalidNameCharacter(value);
  const message = invalid ? t('rename.errors.NameInvalidCharacter') : empty ? t('rename.errors.NameEmpty') : error;

  useLayoutEffect(() => {
    const field = input.current;
    if (field === null) return;
    field.focus({ preventScroll: true });
    const extension = extensionOf(initial);
    const end = file && extension !== '' ? initial.length - extension.length - 1 : initial.length;
    field.setSelectionRange(0, end);
  }, [initial, file]);

  // A new error from the shell: the field keeps focus so the name can be fixed.
  useEffect(() => {
    if (error !== null) {
      done.current = false;
      input.current?.focus({ preventScroll: true });
    }
  }, [error]);

  const submit = (via: 'enter' | 'blur') => {
    if (busy || done.current || invalid) return;
    if (value === '') {
      setEmpty(true);
      return;
    }
    done.current = true;
    onSubmit(value, via);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    // The tree, list or grid around it never sees these keys.
    event.stopPropagation();
    if (event.nativeEvent.isComposing) return;
    if (event.key === 'Enter') {
      event.preventDefault();
      submit('enter');
    } else if (event.key === 'Escape') {
      event.preventDefault();
      // While the request runs, the field stays: its answer may still need it (§7.1, §7.2).
      if (busy) return;
      done.current = true;
      onCancel();
    }
  };

  return (
    <span
      className="name-field"
      onClick={(event) => {
        event.stopPropagation();
      }}
      onPointerDown={(event) => {
        event.stopPropagation();
      }}
    >
      <input
        ref={input}
        className="name-field__input"
        aria-label={label}
        aria-invalid={message !== null || undefined}
        aria-describedby={message !== null ? calloutId : undefined}
        value={value}
        spellCheck={false}
        autoComplete="off"
        onChange={(event) => {
          setValue(event.target.value);
          setEmpty(false);
          done.current = false;
        }}
        onKeyDown={onKeyDown}
        onBlur={() => {
          submit('blur');
        }}
      />
      {message !== null && <Callout id={calloutId}>{message}</Callout>}
    </span>
  );
}
