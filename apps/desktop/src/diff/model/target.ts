// What the diff pane shows (handoff workspace-history §6): a row of the Changes list or of a commit
// in History. The row is known before its diff loads, so the header, the move banners and whether
// "This version" is offered come from it (`describe.ts`); the diff itself is read by its key.
import type { DiffSource } from '../../data/diff';
import type { ChangeRow, CommitInfo, MetadataChange, VersionRef, WorkspaceItem } from '../../ipc';

/** The commit a History row belongs to; a `CommitInfo` or a `FileVersion`'s `commit` will do. */
export type CommitRef = Pick<CommitInfo, 'id' | 'timeMs'>;

/**
 * A row whose diff to show: an item or a tag or settings change of the workspace (Changes), or a
 * changed file or a tag or settings change of a commit (History, one file's history included).
 */
export type DiffTarget =
  | { kind: 'workspace'; item: WorkspaceItem }
  | { kind: 'workspaceMetadata'; change: MetadataChange }
  | { kind: 'version'; commit: CommitRef; row: ChangeRow }
  | { kind: 'versionMetadata'; commit: CommitRef; change: MetadataChange };

/** A History file row's version: its commit and the path it had there, which find its file now (ipc-m2 §8.3). */
export function versionOf(target: Extract<DiffTarget, { kind: 'version' }>): VersionRef {
  return { commit: target.commit.id, path: target.row.path };
}

/** The key that names the target's change in its diff command. */
export function keyOf(target: DiffTarget): string {
  switch (target.kind) {
    case 'workspace':
      return target.item.key;
    case 'version':
      return target.row.key;
    case 'workspaceMetadata':
    case 'versionMetadata':
      return target.change.key;
  }
}

/** Where the target's diff is read: `get_workspace_diff`, or `get_version_diff` of its commit. */
export function sourceOf(target: DiffTarget): DiffSource {
  return target.kind === 'workspace' || target.kind === 'workspaceMetadata'
    ? { source: 'workspace', key: keyOf(target) }
    : { source: 'version', commit: target.commit.id, key: keyOf(target) };
}

/**
 * The target as text: equal for the same change, so the pane starts afresh (folds, the current
 * change, the toggle) only for another one, and not when a refresh brings a new object.
 */
export function targetId(target: DiffTarget): string {
  const source = sourceOf(target);
  return source.source === 'workspace'
    ? `${target.kind} ${source.key}`
    : `${target.kind} ${source.commit} ${source.key}`;
}
