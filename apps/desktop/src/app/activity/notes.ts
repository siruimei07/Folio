// What the UI knows about jobs beyond the contract (library-actions handoff §5, §10.2): `Job`
// carries neither an import's destination nor a time, so the import dialog notes where the files
// go and how many there are, the commit box how many changes a commit commits, and the activity
// button notes when it saw each job end and that a scan has finished (`list_jobs` keeps only the
// last 20 finished jobs). After a reload all of it is gone, and the popover shows those jobs
// without it.

import { create } from 'zustand';

import type { EntryRef } from '../../ipc';

/** An import the UI started. */
export interface ImportNote {
  /** The library it adds to: its job is listed only while that library is open. */
  libraryId: string;
  /** The course or folder the files go to, for "Show". */
  target: EntryRef;
  /** Its label: "MAT232", "MAT232 / Problem sets". */
  label: string;
  /** The files `check_import` counted. */
  files: number;
}

interface JobNotes {
  imports: Readonly<Record<string, ImportNote>>;
  /** The changes each commit the UI started commits (`summarize_selection`'s items + metadata). */
  commits: Readonly<Record<string, number>>;
  /** When each job was seen to end, in ms since the epoch. */
  finishedAt: Readonly<Record<string, number>>;
  /** Imports whose result toast has shown. */
  announced: ReadonlySet<string>;
  /** Imports whose progress toast the user hid; the job goes on in the Activity popover. */
  hidden: ReadonlySet<string>;
  /** Libraries, by id, where a scan has finished. */
  scanned: ReadonlySet<string>;
}

const EMPTY: JobNotes = {
  imports: {},
  commits: {},
  finishedAt: {},
  announced: new Set(),
  hidden: new Set(),
  scanned: new Set(),
};

export const useJobNotes = create<JobNotes>()(() => EMPTY);

/** Notes an import the UI just started as job `id`. */
export function noteImport(id: string, note: ImportNote): void {
  useJobNotes.setState(({ imports }) => ({ imports: { ...imports, [id]: note } }));
}

/** Notes that commit job `id`, which the UI just started, commits `changes` changes. */
export function noteCommit(id: string, changes: number): void {
  useJobNotes.setState(({ commits }) => ({ commits: { ...commits, [id]: changes } }));
}

/** Notes that the jobs `ids` were seen to end at `at`; a job keeps the first time noted. */
export function noteFinished(ids: readonly string[], at: number): void {
  useJobNotes.setState(({ finishedAt }) => {
    const fresh = ids.filter((id) => finishedAt[id] === undefined);
    if (fresh.length === 0) return {};
    return { finishedAt: { ...finishedAt, ...Object.fromEntries(fresh.map((id) => [id, at])) } };
  });
}

/** Notes that the result of import `id` has shown, so it shows once. */
export function noteAnnounced(id: string): void {
  useJobNotes.setState(({ announced }) => ({ announced: new Set(announced).add(id) }));
}

/** Notes that the user hid the progress toast of import `id`. */
export function noteHidden(id: string): void {
  useJobNotes.setState(({ hidden }) => ({ hidden: new Set(hidden).add(id) }));
}

/** Notes that a scan of library `libraryId` has finished, so its problem count counts. */
export function noteScanned(libraryId: string): void {
  if (useJobNotes.getState().scanned.has(libraryId)) return;
  useJobNotes.setState(({ scanned }) => ({ scanned: new Set(scanned).add(libraryId) }));
}

/** Forgets everything, for a test. */
export function resetJobNotes(): void {
  useJobNotes.setState(EMPTY);
}
