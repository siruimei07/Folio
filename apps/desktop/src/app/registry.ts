// What the shell hosts: rail views, dialogs and toolbar controls. Each lane registers its own with
// a one-line edit here, so views never import each other and the shell stays the same
// (UI architecture §6.2). A view or dialog that is not registered does not exist yet: its rail
// button, toolbar button and shortcut stay hidden, not disabled (ADR-0005, product decision 3).

import { LibraryBig, type LucideIcon } from 'lucide-react';
import type { ComponentType } from 'react';

import { LibraryView } from '../library/LibraryView';
import { SemesterControl } from '../library/SemesterControl';
import type { DialogKind, DialogParams, ViewId } from './navigation';

export interface ViewDefinition {
  id: ViewId;
  icon: LucideIcon;
  /** Its name on the rail, a key of the `shell` namespace. */
  label: 'rail.library' | 'rail.changes' | 'rail.history';
  /** Ctrl+<key> shows it: 1 Library, 2 Changes, 3 History. */
  key: string;
  component: ComponentType;
}

/** The rail views, top to bottom. */
export const VIEWS: readonly ViewDefinition[] = [
  { id: 'library', icon: LibraryBig, label: 'rail.library', key: '1', component: LibraryView },
];

export interface DialogComponentProps<K extends DialogKind> {
  isOpen: boolean;
  /** What it was last opened with: the host mounts a dialog only once it has opened. */
  params: DialogParams[K];
  /** Closes it through the navigation store; focus returns to where it was. */
  onClose: () => void;
}

export type DialogRegistry = { [K in DialogKind]?: ComponentType<DialogComponentProps<K>> };

/**
 * The dialogs the navigation store opens. Registering `search` shows the toolbar's search button
 * and Ctrl+K; `librarySettings` the rail's gear and Ctrl+,; `appSettings` the avatar.
 */
export const DIALOGS: DialogRegistry = {};

/** Toolbar controls a lane provides; `compact` in the narrow window's 40 px bar. */
export interface ToolbarControlProps {
  compact: boolean;
}

export interface ToolbarControls {
  /** Left: the sync chip, counts and Sync button (M3). */
  sync?: ComponentType<ToolbarControlProps>;
  /** Centre: the semester button and its menu (`SemesterButton`). */
  semester?: ComponentType<ToolbarControlProps>;
  /** Right, before search: the activity button (`Activity`), wired to the jobs. */
  activity?: ComponentType<ToolbarControlProps>;
}

export const TOOLBAR: ToolbarControls = { semester: SemesterControl };

/** Everything the shell hosts, passed as one value so tests can host their own. */
export interface ShellRegistry {
  views: readonly ViewDefinition[];
  dialogs: DialogRegistry;
  toolbar: ToolbarControls;
}

export const REGISTRY: ShellRegistry = { views: VIEWS, dialogs: DIALOGS, toolbar: TOOLBAR };
