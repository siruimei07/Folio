// The UI reaches the shell only through this module (ADR-0001 §3), so tests can mock it and a
// change of transport stays local. `bindings.ts` is generated from the Rust types by
// `cargo test -p folio-app export_bindings`; never edit it by hand. Its commands never reject:
// a command error and a failed call both resolve to `{ status: 'error', error }`.
//
// The contract is docs/specs/ipc-m1.md and ipc-m2.md. Commands they plan but the shell does not
// implement yet are typed here, and calling one resolves to a `Transport` error (ipc-m1 §3).
export type * from './bindings';
export { DEFAULT_AI_ENDPOINT, DEFAULT_IGNORE_RULES, commands as ipc, LIMITS } from './bindings';
export { formatIpcError, type IpcError, isIpcError } from './errors';
export { shellEvents } from './events';
export {
  contentUrl,
  fileError,
  type FileErrorCode,
  THUMBNAIL_SIZES,
  type ThumbnailSize,
  thumbnailUrl,
  versionUrl,
} from './files';
export { shortId } from './ids';
export {
  setWindowFailureHandler,
  type WindowCommand,
  windowControls,
  type WindowFailure,
} from './window';
