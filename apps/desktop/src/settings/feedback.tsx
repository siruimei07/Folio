// What settings say when something fails (library-actions handoff §9.4, §9.6): a field's own
// codes go under the field; anything else is an error toast, or a state block where a page's
// data could not load. The toasts and the state block are the Library's (app/feedback.tsx).
import { IpcFailure } from '../data/errors';
import type { IpcError } from '../ipc';

export { LoadFailure, showFailure, showGone, useRetryFailed } from '../app/feedback';

/** The error of a failed mutation; anything else is a bug and is thrown on. */
export function ipcErrorOf(error: unknown): IpcError {
  if (error instanceof IpcFailure) return error.error;
  throw error;
}
