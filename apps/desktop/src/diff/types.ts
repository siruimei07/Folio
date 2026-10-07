// The diff pane's API (handoff workspace-history §6), shared by the Changes and History views. Hosts
// reach the pane through `app/panes.ts` (`DIFF_PANE`), never this feature, and pass a target, their
// own actions and menu items; the pane reads the diff itself (data/diff.ts).
import type { ReactNode, Ref } from 'react';

import type { EntryRef } from '../ipc';
import type { DiffTarget } from './model/target';

export type { CommitRef, DiffTarget } from './model/target';

/** What a host can ask of the pane through its `ref`. */
export interface DiffPaneHandle {
  /**
   * Moves the focus into the diff, as Enter in the host's list does (handoff §3.6): to the lines'
   * region when they show, else to the heading.
   */
  focus: () => void;
  /**
   * Moves the focus to "Restore" (handoff §8.3: where it goes back when the host's confirmation
   * closes): the header's button, enabled or disabled, or "More" in a compact pane, which lists
   * "Restore…"; the heading when the row offers no Restore.
   */
  focusRestore: () => void;
}

/** What the pane asks its host to do, with the host's own feedback and toasts. */
export interface DiffActions {
  /**
   * "Open with default app" from a state block (load failed, not downloaded, too big) or from the
   * file's preview. The pane passes the item's entry in Changes; in History the file the version
   * belongs to now (`locate_version`).
   */
  open: (entry: EntryRef) => void;
}

/** "Back" first in the header, in a narrow window (handoff §2.2). Esc and Alt+Left in the pane go back too. */
export interface DiffBack {
  /** The accessible name: "Back to changes", "Back to history". The button reads "Back". */
  label: string;
  onBack: () => void;
}

/**
 * History's "Restore" for a stored text or Word version (handoff §8.1): a button in the header, or
 * "Restore…" in "More" when the pane is narrower than `size.diff-compact-pane`. The host decides
 * whether a row offers it (not event-only files, thinned-out versions or `.folio` paths) and runs
 * the confirmation (§8.2).
 */
export interface DiffRestore {
  /**
   * Opens the host's confirmation. Focus goes back to the button (or "More") when it closes; when
   * that control was replaced meanwhile (Restore turning disabled), the host calls
   * `DiffPaneHandle.focusRestore`.
   */
  onRestore: () => void;
  /**
   * Why it cannot be done now ("This is the version you have now.", a read-only history): the
   * button stays in the header with the shared disabled look and in the tab order, with this in its
   * tooltip; the menu item is disabled.
   */
  disabledReason?: string;
}

export interface DiffPaneProps {
  /**
   * The row whose diff to show. Another row (kind, commit and key) starts afresh: folds, the
   * current change and "Changes | This version" go back to their start.
   */
  target: DiffTarget;
  actions: DiffActions;
  /**
   * The header's "More" menu: the host's `MenuItem`s for the file (Open with default app, Show in
   * File Explorer, View history of this file, Copy path). In a pane narrower than
   * `size.diff-compact-pane` the pane adds "Show this version" / "Show the changes" and "Restore…"
   * after them. No "More" when there is nothing to put in it.
   */
  moreItems?: ReactNode;
  back?: DiffBack;
  /** History only. */
  restore?: DiffRestore;
  ref?: Ref<DiffPaneHandle>;
}
