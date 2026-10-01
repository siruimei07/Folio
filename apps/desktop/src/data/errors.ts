// Commands never reject (ADR-0001 §4d): they resolve to `{ status, data | error }`. TanStack Query
// learns about a failure only from a throw, so query and mutation functions unwrap the result and
// throw an `IpcFailure` that carries the typed error (docs/specs/ui-architecture.md §5.1).
import { formatIpcError, type IpcError } from '../ipc';

/** A failed IPC call in Query's error channel; `error.code` picks the message from `errors`. */
export class IpcFailure extends Error {
  override readonly name = 'IpcFailure';
  readonly error: IpcError;

  constructor(error: IpcError, options?: ErrorOptions) {
    super(formatIpcError(error), options);
    this.error = error;
  }
}

declare module '@tanstack/react-query' {
  interface Register {
    // Every query and mutation function throws through `unwrap`, so this is the only error type.
    defaultError: IpcFailure;
  }
}

/** What every generated command resolves to. */
export type IpcResult<T> = { status: 'ok'; data: T } | { status: 'error'; error: IpcError };

/**
 * The data of a command, or its error thrown as an `IpcFailure`. A call that throws instead of
 * resolving is a bug below the bindings; it is reported as `Transport`, like a failed call.
 */
export async function unwrap<T>(call: Promise<IpcResult<T>>): Promise<T> {
  let result: IpcResult<T>;
  try {
    result = await call;
  } catch (cause) {
    throw new IpcFailure({ code: 'Transport', detail: String(cause) }, { cause });
  }
  if (result.status === 'error') throw new IpcFailure(result.error);
  return result.data;
}
