// Where the first run is (first-run handoff §2). The start gate shows what `library_status` says,
// except while this store holds a page of the flow: step 1 for a chosen folder (from the welcome
// screen, the unavailable screen's "Start a new library", or Library settings' "Change…"), and
// step 2, which runs with the new library already open. The flow ends where it says so: Back, a
// library opened, step 2 done; it never infers that from the status, since only its own commands
// open a library. In app/, so that settings can start step 1 without importing the first run.
import { create } from 'zustand';

import type { FolderChoice, IpcError } from '../ipc';

/**
 * Which choice opened the folder dialog (§3): the next page depends on the folder, not on it.
 * `change` is Library settings' "Change…", which expects no particular kind of folder.
 */
export type Intent = 'new' | 'existing' | 'open' | 'change';

export interface FolderPage {
  page: 'folder';
  choice: FolderChoice;
  intent: Intent;
  /** An error `open_library` gave before the page showed ("Open your library…", §3). */
  error: IpcError | null;
}

export interface CoursesPage {
  page: 'courses';
  /** The library step 2 sets up: it shows once the status has this library open. */
  libraryId: string;
  /** The scan `create_library` started, for the take-over's progress strip (§5.2). */
  scan: string;
  /** A folder taken over with semester folders in it (§5.2); otherwise a new library (§5.1). */
  takeOver: boolean;
  /** A folder taken over that had only files at its top level: §5.1 with its own intro. */
  noFolders: boolean;
}

interface FlowState {
  /** `null`: the gate follows the library status alone (welcome, unavailable or the Library). */
  flow: FolderPage | CoursesPage | null;
}

const INITIAL: FlowState = { flow: null };

export const useFirstRun = create<FlowState>()(() => INITIAL);

/** Step 1 for a chosen folder. */
export function showFolder(choice: FolderChoice, intent: Intent, error: IpcError | null = null): void {
  useFirstRun.setState({ flow: { page: 'folder', choice, intent, error } });
}

/** `create_library` answered: step 2 for the new library. */
export function showCourses(page: Omit<CoursesPage, 'page'>): void {
  useFirstRun.setState({ flow: { page: 'courses', ...page } });
}

/**
 * Step 1's Back, step 2's end, or a library that opened: the gate shows what the library status
 * says, the welcome screen or the unavailable screen the flow started from, or the Library.
 */
export function endFlow(): void {
  useFirstRun.setState(INITIAL);
}
