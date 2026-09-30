// Keyboard shortcuts (UI architecture §6.4): one registry and one `keydown` listener on the window.
// Views and dialogs register theirs while they exist, so a lane adds its shortcut without editing
// another lane's code. The preview frame forwards its key presses to `handleShortcut`.

import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';

import { isModalOpen } from '../components/Dialog/Dialog';

export interface KeyCombo {
  /** `KeyboardEvent.key`, compared without case: "k", "1", ",", "Enter". */
  key: string;
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
}

/** Ctrl+K: search, everywhere, also from a text field. */
export const SEARCH_KEYS: KeyCombo = { key: 'k', ctrl: true };

/** Ctrl+,: Library settings. */
export const LIBRARY_SETTINGS_KEYS: KeyCombo = { key: ',', ctrl: true };

/** Ctrl+<key>: a rail view (1 Library, 2 Changes, 3 History). */
export function viewKeys(key: string): KeyCombo {
  return { key, ctrl: true };
}

export interface ShortcutOptions {
  /** Also while a text field has focus, like Ctrl+K. */
  inInputs?: boolean;
  /** Also while a modal dialog is open. Esc always belongs to the dialog. */
  inDialogs?: boolean;
}

/** The parts of a key press a shortcut looks at; the frame's forwarded presses have the same. */
export interface KeyPress {
  key: string;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  isComposing?: boolean;
  keyCode?: number;
  target?: EventTarget | null;
}

interface Registration {
  combo: KeyCombo;
  run: () => void;
  options: ShortcutOptions;
}

/** Newest last: a later registration of the same keys wins until it goes away. */
const registrations: Registration[] = [];

/** Registers a shortcut until the returned function runs. */
export function registerShortcut(combo: KeyCombo, run: () => void, options: ShortcutOptions = {}): () => void {
  const registration = { combo, run, options };
  registrations.push(registration);
  return () => {
    const index = registrations.indexOf(registration);
    if (index >= 0) registrations.splice(index, 1);
  };
}

/**
 * Registers `run` for `combo` while the component is mounted and `run` is not `null`. The latest
 * `run` is called, so it need not be memoised.
 */
export function useShortcut(combo: KeyCombo, run: (() => void) | null, options: ShortcutOptions = {}): void {
  const latest = useRef(run);
  useEffect(() => {
    latest.current = run;
  });
  const enabled = run !== null;
  const { key, ctrl, shift, alt } = combo;
  const { inInputs, inDialogs } = options;
  useEffect(() => {
    if (!enabled) return undefined;
    return registerShortcut(
      { key, ctrl, shift, alt },
      () => {
        latest.current?.();
      },
      { inInputs, inDialogs },
    );
  }, [enabled, key, ctrl, shift, alt, inInputs, inDialogs]);
}

function matches(press: KeyPress, combo: KeyCombo): boolean {
  return (
    press.key.toLowerCase() === combo.key.toLowerCase() &&
    press.ctrlKey === (combo.ctrl ?? false) &&
    press.shiftKey === (combo.shift ?? false) &&
    press.altKey === (combo.alt ?? false) &&
    !press.metaKey
  );
}

function isTextInput(target: EventTarget | null | undefined): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || target.closest('input, textarea, select') !== null;
}

/**
 * Runs the shortcut a key press names, if one applies, and says whether it did. Presses during
 * IME composition never count (Chinese input). Where the press happened is looked at only for a
 * press that matches, not for every key typed.
 */
export function handleShortcut(press: KeyPress): boolean {
  if (press.isComposing === true || press.keyCode === 229) return false;
  let where: { inInput: boolean; inDialog: boolean } | undefined;
  for (let index = registrations.length - 1; index >= 0; index -= 1) {
    const registration = registrations[index];
    if (!registration || !matches(press, registration.combo)) continue;
    where ??= { inInput: isTextInput(press.target), inDialog: isModalOpen() };
    if (where.inInput && registration.options.inInputs !== true) continue;
    if (where.inDialog && registration.options.inDialogs !== true) continue;
    registration.run();
    return true;
  }
  return false;
}

/** Listens on `target` until the returned function runs. */
export function installShortcuts(target: Window = window): () => void {
  const onKeyDown = (event: KeyboardEvent) => {
    if (handleShortcut(event)) event.preventDefault();
  };
  target.addEventListener('keydown', onKeyDown);
  return () => {
    target.removeEventListener('keydown', onKeyDown);
  };
}

/**
 * A shortcut as tooltips and menus print it, "Ctrl+K", "Ctrl+Shift+S"; with `separator: ' '` as a
 * key cap prints it, "Ctrl K".
 */
export function useShortcutLabel(): (combo: KeyCombo, separator?: string) => string {
  const { t } = useTranslation('shell');
  return ({ key, ctrl, shift, alt }, separator = '+') =>
    [
      ...(ctrl === true ? [t('keys.ctrl')] : []),
      ...(shift === true ? [t('keys.shift')] : []),
      ...(alt === true ? [t('keys.alt')] : []),
      key.length === 1 ? key.toUpperCase() : key,
    ].join(separator);
}
