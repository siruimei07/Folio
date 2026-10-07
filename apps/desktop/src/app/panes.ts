// Panes a view hosts that another lane builds (UI architecture §6.2): the preview pane of
// `feat/ui-preview`, which the Library shows in its third column (Changes and History do the same
// in M2), and the diff pane of `feat/ui-diff-viewer`, which Changes and History share. Views import
// the slot from here, never the feature, so features still never import each other.
import type { ComponentType, ReactElement } from 'react';

import { DiffPane } from '../diff/DiffPane';
import type { DiffPaneProps } from '../diff/types';
import type { EntryRef } from '../ipc';
import { PreviewPane } from '../preview/PreviewPane';

/**
 * What the preview does to its file, with the host view's own feedback (library-actions §9.3,
 * §9.4), so each action and its toasts exist once.
 */
export interface PreviewActions {
  /** "Open with default app". */
  open: (entry: EntryRef) => void;
  /** "Show in File Explorer". */
  showInExplorer: (entry: EntryRef) => void;
  /** Removes a tag from the tag row's chip ("Remove tag Notes"). */
  setTags: (entries: readonly EntryRef[], add: readonly string[], remove: readonly string[]) => void;
  /** "View history of this file" (workspace-history §7.4, §12.4): the header offers it when given. */
  viewHistory?: (entry: EntryRef) => void;
}

export interface PreviewPaneProps {
  /** The file to show. */
  entry: EntryRef;
  /** Narrow window: the header starts with "Back", which calls this (app-shell §2). */
  onBack?: () => void;
  /** The header's "More" menu: the host view's actions on the file, a `Menu` (library-actions §6). */
  moreMenu?: ReactElement;
  /** The menu of the tag row's "+ Tag" chip: the host's Tags menu for the file, a `Menu`. */
  tagMenu?: ReactElement;
  actions: PreviewActions;
}

/** The preview pane; `null` would make the views show their empty preview instead. */
export const PREVIEW_PANE: ComponentType<PreviewPaneProps> | null = PreviewPane;

export type {
  CommitRef,
  DiffActions,
  DiffBack,
  DiffPaneHandle,
  DiffPaneProps,
  DiffRestore,
  DiffTarget,
} from '../diff/types';

/**
 * The diff pane (handoff workspace-history §6): a row of Changes or of a commit in History. Its API
 * and examples for both views: `src/diff/README.md`.
 */
export const DIFF_PANE: ComponentType<DiffPaneProps> = DiffPane;

// A file's preview without its header: in its own module, which the diff pane reads too.
export {
  PREVIEW_FILE,
  type PreviewFileActions,
  type PreviewFileProps,
  type PreviewFileSource,
  previewShowsVersion,
} from './previewFile';
