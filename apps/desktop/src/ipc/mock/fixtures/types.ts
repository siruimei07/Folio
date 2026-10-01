// What a fixture describes: the shell's state when the fake starts, and the answers its dialogs
// give. Fixtures are functions of the current time, so "Recently added" means something whenever
// the browser pane opens them; tests pass a fixed time.
import type {
  EntryKind,
  FolderContent,
  ImportName,
  Problem,
  SyncProvider,
  Unavailable,
} from '../../bindings';

/** Settings of a semester or course folder (`.folio/meta/`), which follow it when it moves. */
export interface GroupSettings {
  /** Position among its siblings; `null`: after the ordered ones, by name. */
  order: number | null;
  archived: boolean;
  /** Courses only. */
  abbr: string | null;
  code: string | null;
  color: string | null;
}

/** An entry that another program holds or the Recycle Bin cannot take: its actions fail. */
export type BlockedBy = 'InUse' | 'NotRecyclable';

export interface SeedEntry {
  path: string;
  kind: EntryKind;
  /** Bytes, in decimal. */
  size: string;
  modifiedMs: string | null;
  addedMs: string;
  /** Own tag ids. */
  tags: string[];
  group: GroupSettings | null;
  /** Body text for search snippets. */
  text: string | null;
  blocked: BlockedBy | null;
}

export interface SeedTag {
  id: string;
  name: string;
  color: string;
}

export interface LibrarySeed {
  name: string;
  /** The library folder, for display. */
  root: string;
  readOnly: boolean;
  recovered: boolean;
  tags: SeedTag[];
  /** Parents before their children. */
  entries: SeedEntry[];
  problems: Problem[];
}

/** One answer of the folder dialog (`pick_library_folder`); `null`: the user cancels. */
export interface FolderScript {
  path: string;
  content: FolderContent;
  syncRoot: SyncProvider | null;
  /** What the folder holds once it is a library: taken over, finished, or opened. */
  library?: () => LibrarySeed;
}

/** One answer of the file dialog or one drop (`pick_import_files`, `FilesDropped`). */
export interface ImportScript {
  names: ImportName[];
  /** Every item below the source, relative to it; folders before their contents. */
  items: { path: string; kind: EntryKind; size: string }[];
}

export type FixtureStatus =
  | { state: 'none' }
  | { state: 'open' }
  | { state: 'unavailable'; reason: Unavailable };

export interface Fixture {
  status: FixtureStatus;
  /** The library that is open, or that would open (`unavailable`), or `null` (`none`). */
  library: LibrarySeed | null;
  /** Answers of the folder dialog, in order; the last one repeats. */
  folderChoices: (FolderScript | null)[];
  /** Answers of the file dialog, in order; the last one repeats. */
  importSources: (ImportScript | null)[];
}
