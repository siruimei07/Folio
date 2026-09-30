// The error every IPC call can resolve to, and how it reads in logs and "Copy details".
import type { AppError, TransportError } from './bindings';

/** Every error an IPC call can resolve to; the UI shows the message for its `code`. */
export type IpcError = AppError | TransportError;

/** Whether a thrown or rejected value is an IPC error (`{ code, detail }`). */
export function isIpcError(value: unknown): value is IpcError {
  return typeof value === 'object' && value !== null && 'code' in value && 'detail' in value;
}

/** "Window: window.minimize not allowed": the form logs and copied details share. */
export function formatIpcError({ code, detail }: IpcError): string {
  return `${code}: ${detail}`;
}
