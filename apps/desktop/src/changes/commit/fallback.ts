// The actions of "Committed with a template message" (workspace-history handoff §4.3, §11), the
// information toast after a commit with empty fields fell back to the template.
//
// Hook for feat/ui-history-view: its "Edit message" (§9.1) goes here, one entry that opens the Edit
// message dialog on the new commit (`openDialog('editMessage', …)`); the caller, useCommitBox's
// `showFallbackToast`, has the commit's id from the job's result to pass in. Until that dialog is
// on main the toast offers nothing, rather than an action that opens nothing (Sirui's decision,
// 2026-10-06); the message can also be edited in History, so the toast is never its only way.
import type { ToastAction } from '../../components/Toast/Toast';

/** What the toast offers: nothing yet (see above). */
export function fallbackToastActions(): readonly ToastAction[] {
  return [];
}
