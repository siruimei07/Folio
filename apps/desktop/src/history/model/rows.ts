// What a file card's row shows and says (handoff workspace-history §7.2, app-shell §7; plan decision
// B2): a commit's changed file or folder, or one of its tag and settings changes, in the Changes
// list's row look without a check box. History names paths as they were in the commit. Pure, so
// the card renders it and the tests read the words without rendering.
import type { TFunction } from 'i18next';

import {
  CHANGE_ROW_TAGS,
  type ChangeRowFace,
  changeRowIcon,
  changeStatusOf,
  joinRowLabel,
  metadataTitle,
  rowPath,
  wholePath,
} from '../../components/ChangeRow/words';
import type { ChangeRow, Course, HistoryItem, MetadataChange } from '../../ipc';
import { nameOf, parentOf } from '../../lib/paths';
import { prefixOf } from '../../lib/places';

/** Rows a card shows before "Show all N files" (§7.2): `list_history` gives a commit's first four. */
export const CARD_ROWS = 4;

/** A row of a card: a changed file or folder of the commit, or one of its tag or settings changes. */
export type CardRow = { kind: 'file'; row: ChangeRow } | { kind: 'metadata'; change: MetadataChange };

/** A row's face (`ChangeRowFace`): its tooltip is the whole path, and where a moved file came from. */
export interface CardRowText extends ChangeRowFace {
  /** The accessible name: the whole path (uncut), the status, then where it was moved from. */
  label: string;
}

export interface DescribeContext {
  t: TFunction<['history', 'common']>;
  /** The UI language, for joining the parts of a name. */
  language: string;
  courses: readonly Course[];
}

/**
 * What a card shows before "Show all N files": its rows (a commit's first four files and folders,
 * or its first four tag and settings changes when it has nothing else, decision B2), and its
 * changes in all. `null` for an entry without a card: the first commit, a prune commit (B3), a
 * commit without changes, an edited message or an undone commit. A restore's card is its file.
 */
export function cardShape(item: HistoryItem): { rows: number; total: number } | null {
  if (item.kind === 'restore') return { rows: 1, total: 1 };
  if (item.kind !== 'commit') return null;
  const { commit } = item;
  if (commit.first || commit.kind === 'prune') return null;
  const changes = commit.files + commit.folders;
  const total = changes + commit.metadata;
  if (total === 0) return null;
  return { rows: changes > 0 ? item.files.length : Math.min(CARD_ROWS, commit.metadata), total };
}

/** The row's id in its card: unique within a commit, the same for the same change after a refresh. */
export function cardRowId(row: CardRow): string {
  return row.kind === 'file' ? `file ${row.row.key}` : `meta ${row.change.key}`;
}

/** The library path the row names, as it was in the commit; `null` for a change of no file or folder. */
export function cardRowPath(row: CardRow): string | null {
  if (row.kind === 'file') return row.row.path;
  const { subject } = row.change;
  return subject.kind === 'tags' || subject.kind === 'semester' || subject.kind === 'course' ? subject.path : null;
}

/**
 * The path "Copy path" copies, as the Changes view's menus do (§3.7): a changed file's or folder's
 * (the old one of a deletion), or the file or folder whose tags changed; `null` for a settings
 * change, which names no file.
 */
export function copyablePath(row: CardRow): string | null {
  if (row.kind === 'file') return row.row.path;
  return row.change.subject.kind === 'tags' ? row.change.subject.path : null;
}

/** A path in words, as a flat list prints it: "MAT232/ps2 solutions.md". */
function shown(path: string, courses: readonly Course[]): string {
  return `${prefixOf(parentOf(path), courses)}${nameOf(path)}`;
}

/** A changed file or folder (app-shell §7): its path now, struck through when deleted; a move names its old path. */
export function describeChangeRow(row: ChangeRow, context: DescribeContext): CardRowText {
  const { t } = context;
  const path = rowPath(row.path, context.courses);
  const status = changeStatusOf(row.change);
  const label = [wholePath(path), t(`common:changeStatus.${status}`)];
  let tooltip = wholePath(path);
  if (row.fromPath !== null) {
    const moved = t('cards.movedFrom', { path: shown(row.fromPath, context.courses) });
    label.push(moved);
    tooltip = `${tooltip}\n${moved}`;
  }
  return {
    icon: changeRowIcon(row),
    path,
    tagsTag: false,
    status,
    deleted: row.change === 'deleted',
    tooltip,
    label: joinRowLabel(context.language, label),
  };
}

/** A tag or settings change of the commit (decision B2): the Changes list's metadata row (§3.3). */
export function describeMetadataRow(change: MetadataChange, context: DescribeContext): CardRowText {
  const { t } = context;
  const { subject } = change;
  const status = changeStatusOf(change.change);
  const statusText = t(`common:changeStatus.${status}`);
  if (subject.kind === 'tags') {
    const path = rowPath(subject.path, context.courses);
    return {
      icon: { kind: 'tag' },
      path,
      tagsTag: true,
      status,
      deleted: false,
      tooltip: wholePath(path),
      label: joinRowLabel(context.language, [wholePath(path), t(CHANGE_ROW_TAGS), statusText]),
    };
  }
  const { icon, title: message } = metadataTitle(subject, context.courses);
  const title = t(message.key, message.values ?? {});
  return {
    icon,
    path: { label: '', prefix: '', name: title },
    tagsTag: false,
    status,
    deleted: false,
    tooltip: title,
    label: joinRowLabel(context.language, [title, statusText]),
  };
}

export function describeCardRow(row: CardRow, context: DescribeContext): CardRowText {
  return row.kind === 'file' ? describeChangeRow(row.row, context) : describeMetadataRow(row.change, context);
}
