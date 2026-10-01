// Panes a view hosts that another lane builds (UI architecture §6.2): the preview pane of
// `feat/ui-preview`, which the Library shows in its third column (Changes and History do the same
// in M2). Views import the slot from here, never the feature, so features still never import each
// other; the preview lane sets it with a one-line edit.
import type { ComponentType, ReactElement } from 'react';

import type { EntryRef } from '../ipc';

export interface PreviewPaneProps {
  /** The file to show. */
  entry: EntryRef;
  /** Narrow window: the header starts with "Back", which calls this (app-shell §2). */
  onBack?: () => void;
  /** The header's "More" menu: the host view's actions on the file, a `Menu` (library-actions §6). */
  moreMenu?: ReactElement;
}

/** The preview pane; `null` until `feat/ui-preview` lands, and the views show their empty preview. */
export const PREVIEW_PANE = null as ComponentType<PreviewPaneProps> | null;
