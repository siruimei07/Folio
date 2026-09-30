// The UI reaches the shell only through this module (ADR-0001 §3), so tests can mock it and a
// change of transport stays local. `bindings.ts` is generated from the Rust types by
// `cargo test -p folio-app export_bindings`; never edit it by hand. Its commands never reject:
// a command error and a failed call both resolve to `{ status: 'error', error }`.
//
// The contract is docs/specs/ipc-m1.md. Commands it plans but the shell does not implement yet
// are typed here, and calling one resolves to a `Transport` error (spec §3).
import type { AppError, TransportError } from './bindings';

export type * from './bindings';
export { commands as ipc, LIMITS } from './bindings';
export { shellEvents } from './events';
export {
  contentUrl,
  fileError,
  type FileErrorCode,
  THUMBNAIL_SIZES,
  type ThumbnailSize,
  thumbnailUrl,
} from './files';
export { windowControls } from './window';

/** Every error an IPC call can resolve to; the UI shows the message for its `code`. */
export type IpcError = AppError | TransportError;
