// The UI reaches the shell only through this module (ADR-0001 §3), so tests can mock it and a
// change of transport stays local. `bindings.ts` is generated from the Rust types by
// `cargo test -p folio-app export_bindings`; never edit it by hand. Its commands never reject:
// a command error and a failed call both resolve to `{ status: 'error', error }`.
import type { AppError, TransportError } from './bindings';

export { commands as ipc } from './bindings';
export type { AppInfo } from './bindings';

/** Every error an IPC call can resolve to; the UI shows the message for its `code`. */
export type IpcError = AppError | TransportError;
