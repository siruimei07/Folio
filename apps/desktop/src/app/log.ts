// Reports UI errors to the console and to the shell's log (`log_ui_error`, ipc-m1 §16.4). Only
// error text travels: never file content, search text or names the user typed.

import { formatIpcError, ipc, isIpcError, LIMITS, type UiErrorKind } from '../ipc';

const SOURCE = /^[A-Za-z0-9._-]{1,64}$/;

/**
 * Well-formed text (lone surrogates become U+FFFD, as `toWellFormed` does) of at most
 * `LIMITS.logChars` characters, never cut inside a surrogate pair.
 */
export function logText(text: string): string {
  return Array.from(text.toWellFormed()).slice(0, LIMITS.logChars).join('');
}

/** The message and stack of anything thrown. */
export function describeError(error: unknown): { message: string; stack: string | null } {
  if (error instanceof Error) return { message: `${error.name}: ${error.message}`, stack: error.stack ?? null };
  if (isIpcError(error)) return { message: formatIpcError(error), stack: null };
  return { message: String(error), stack: null };
}

/**
 * Reports what nothing caught: script errors and rejected promises in the window. Returns the
 * function that stops it.
 */
export function reportUncaughtErrors(target: Window = window): () => void {
  const onError = (event: ErrorEvent) => {
    reportUiError('uncaught', 'window.error', event.error ?? event.message);
  };
  const onRejection = (event: PromiseRejectionEvent) => {
    reportUiError('uncaught', 'window.unhandledrejection', event.reason);
  };
  target.addEventListener('error', onError);
  target.addEventListener('unhandledrejection', onRejection);
  return () => {
    target.removeEventListener('error', onError);
    target.removeEventListener('unhandledrejection', onRejection);
  };
}

/**
 * Writes one UI error to the console and the shell's log. `source` names where it happened, like
 * `windowControls.minimize` or `view.library`. When the log cannot be written, the console has it
 * and nothing more happens: the UI never shows an error about logging.
 */
export function reportUiError(kind: UiErrorKind, source: string, error: unknown, componentStack?: string): void {
  console.error(`[${kind}] ${source}`, error);
  if (!SOURCE.test(source)) {
    console.error(`log source ${JSON.stringify(source)} is not a valid name`);
    return;
  }
  const { message, stack } = describeError(error);
  const fullStack = [stack, componentStack].filter((part) => part !== null && part !== undefined && part !== '');
  void ipc
    .logUiError({
      kind,
      source,
      message: logText(message),
      stack: fullStack.length === 0 ? null : logText(fullStack.join('\n')),
    })
    .then((result) => {
      if (result.status === 'error') console.error('writing the UI error to the log failed', result.error);
    });
}
