// What the timeline shows, entry by entry (handoff workspace-history §7.2, §7.4): the whole history's
// entries, or one file's: its commits, each with the file's own row and the commit's other files
// counted, the restores of its versions, and, when the file came later than the first commit, that
// commit after them ("Midterm review.md wasn't in the library yet."). Pure.
import type { CommitInfo, FileVersion, HistoryItem } from '../../ipc';

export type CommitItem = Extract<HistoryItem, { kind: 'commit' }>;

/** A commit of one file's history: its card holds the file's row, with the path it had then. */
export interface VersionRow {
  kind: 'version';
  /** The commit, with the file's row as its only file. */
  item: CommitItem;
  /** The commit's other changed files: "and 2 other files in this commit". */
  others: number;
  /** The newest version with the content the file has now: "Current version". */
  current: boolean;
}

export type TimelineRow =
  /** An entry of the whole history, or a restore of the file's versions. */
  | { kind: 'entry'; item: HistoryItem }
  | VersionRow
  /** The first commit, after a file that came later: its note names the file, and it has no card. */
  | { kind: 'before'; item: CommitItem; name: string };

/** The whole history's entries as they are. */
export function wholeHistoryRows(items: readonly HistoryItem[]): TimelineRow[] {
  return items.map((item) => ({ kind: 'entry', item }));
}

/**
 * Whether a file's history, read to its end, ends with a commit after the first: the file came
 * later (ipc-m2 §8.3 follows it back to where it was added), so the first commit follows it.
 */
export function cameLater(versions: readonly FileVersion[], complete: boolean): boolean {
  const last = versions.at(-1);
  return complete && last?.kind === 'commit' && !last.commit.first;
}

export interface FileHistoryEnd {
  /** Every entry of the file's history has been read. */
  complete: boolean;
  /** The library's first commit, once read; `null` while unknown. */
  first: CommitInfo | null;
  /** The file's name, for "Midterm review.md wasn't in the library yet." */
  name: string;
}

/** One file's history, newest first, then the first commit when the file came later. */
export function fileHistoryRows(versions: readonly FileVersion[], end: FileHistoryEnd): TimelineRow[] {
  const rows = versions.map(
    (version): TimelineRow =>
      version.kind === 'restore'
        ? { kind: 'entry', item: version }
        : {
            kind: 'version',
            item: { kind: 'commit', commit: version.commit, files: [version.change] },
            others: version.others,
            current: version.current,
          },
  );
  const { first } = end;
  if (first !== null && cameLater(versions, end.complete) && !versions.some((version) => version.kind === 'commit' && version.commit.id === first.id)) {
    rows.push({ kind: 'before', item: { kind: 'commit', commit: first, files: [] }, name: end.name });
  }
  return rows;
}

/** The version of a file's history with its content on the disk now: its commit and its row's key. */
export interface CurrentVersion {
  commit: string;
  key: string;
}

export function currentVersionOf(versions: readonly FileVersion[]): CurrentVersion | null {
  const current = versions.find((version) => version.kind === 'commit' && version.current);
  return current?.kind === 'commit' ? { commit: current.commit.id, key: current.change.key } : null;
}
