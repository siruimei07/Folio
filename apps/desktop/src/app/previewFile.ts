// A file's preview without its header (UI architecture §10), as a slot like those in `panes.ts`:
// the body of `PREVIEW_PANE`, and what the diff pane shows for "This version" and for files whose
// versions Folio does not keep (handoff workspace-history §6.7, §6.8). It lives apart from
// `panes.ts` because the diff pane reads it and `panes.ts` imports the diff pane: one file holding
// both would make the two modules import each other. `panes.ts` re-exports it for the views.
import type { ComponentType } from 'react';

import type { EntryRef, VersionRef, VersionSide } from '../ipc';
import { PreviewFile, showsVersion } from '../preview/PreviewFile';
import type { PreviewActions } from './panes';

/**
 * What a file's preview shows (UI architecture §10): a file in the library, or a version stored in
 * history (handoff workspace-history §6.7), whose bytes come from the `folio-file` version route
 * (ipc-m2 §11).
 */
export type PreviewFileSource =
  | { kind: 'entry'; entry: EntryRef }
  | {
      kind: 'version';
      /** The commit and the path the file had in it, which find the file it belongs to now. */
      version: VersionRef;
      /** That version, one that can be shown: `stored` and not `pruned` (ipc-m2 §5.2). */
      side: Pick<VersionSide, 'hash' | 'size'>;
    };

/**
 * "Open with default app" in the preview's cards and failures. For a version it opens the file the
 * version belongs to now (`locate_version`), as History's Open does, and is not offered when there
 * is none.
 */
export type PreviewFileActions = Pick<PreviewActions, 'open'>;

export interface PreviewFileProps {
  source: PreviewFileSource;
  actions: PreviewFileActions;
  /** Esc in the frame, or the link popover closing: focus goes to the host's heading (§10.5). */
  onEscape: () => void;
}

/**
 * A file's preview without its header and tags: the body of `PREVIEW_PANE`, and "This version" in
 * the diff pane. A new file, a new version of it, or another stored version starts afresh.
 */
export const PREVIEW_FILE: ComponentType<PreviewFileProps> = PreviewFile;

/**
 * Whether `PREVIEW_FILE` shows a stored version of a file with this name, not just a card with
 * "Open with default app" (Word files until their previews come): the diff pane offers "This
 * version" only then (handoff §6.7).
 */
export const previewShowsVersion: (name: string) => boolean = showsVersion;
