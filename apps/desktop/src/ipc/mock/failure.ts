// How the fake shell fails: a handler throws a `ShellFailure`, and the dispatcher rejects the call
// with its plain `{ code, detail }` object, as the real shell does (ipc-m1 §16).
import { type AppError, type BatchResult, type EntryRef, type ItemFailure, LIMITS } from '../bindings';
import { formatIpcError } from '../errors';

export type ErrorCode = AppError['code'];

export class ShellFailure extends Error {
  override readonly name = 'ShellFailure';
  readonly appError: AppError;

  constructor(appError: AppError) {
    super(formatIpcError(appError));
    this.appError = appError;
  }
}

/** The `AppError` with this code, as the shell sends it. */
export function appError(code: ErrorCode, detail: string): AppError {
  return { code, detail } as AppError;
}

/** Fails the command with `code`; `detail` is for logs, as in the real shell. */
export function fail(code: ErrorCode, detail: string): never {
  throw new ShellFailure(appError(code, detail));
}

/**
 * A batch command (ipc-m1 §5.4): at most `LIMITS.batch` items, each done on its own, and every
 * item that failed listed with its error.
 */
export function eachItem(entries: EntryRef[], action: (entry: EntryRef) => void): BatchResult {
  if (entries.length > LIMITS.batch) fail('InvalidArgument', 'over LIMITS.batch');
  const failed: ItemFailure[] = [];
  for (const entry of entries) {
    try {
      action(entry);
    } catch (error) {
      if (!(error instanceof ShellFailure)) throw error;
      failed.push({ entry, error: error.appError });
    }
  }
  return { done: entries.length - failed.length, failed };
}
