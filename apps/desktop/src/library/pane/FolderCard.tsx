// The folders of a course or folder grid (workspace-history handoff §12.3, decision 35A): 48 px
// cards in a "Folders" group above the file tiles, each with how many files it holds.
import { Folder } from 'lucide-react';
import { type ReactNode, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { type LoadingPagedList, useCount } from '../../data/paged';
import type { EntryRow } from '../../ipc';
import { formatNumber } from '../../lib/format';
import { SIZE } from '../../tokens/tokens';
import { NO_FILTER } from '../filters';
import { refOf } from '../selecting';

/**
 * How many of a list's first rows are folders, as far as its pages have arrived: lists of
 * children put folders first (ipc-m1 §5.3).
 */
function leadingFolders(total: number, rowAt: (index: number) => EntryRow | undefined): number {
  let index = 0;
  while (index < total && rowAt(index)?.kind === 'folder') index++;
  return index;
}

/**
 * The folders at the start of a grid's list: counted while its first page is loaded, and kept while
 * it is not, as when a long folder scrolled far down drops that page from the cache, so the cards
 * never turn into tiles under the user. None when `enabled` is off (the list mode).
 */
export function useLeadingFolders(list: LoadingPagedList<EntryRow>, enabled: boolean): number {
  const total = list.total ?? 0;
  const counted = useMemo(
    () => (enabled && list.rowAt(0) !== undefined ? leadingFolders(total, list.rowAt) : null),
    [enabled, list, total],
  );
  const [kept, setKept] = useState(0);
  if (counted !== null && counted !== kept) setKept(counted);
  if (!enabled) return 0;
  return counted ?? Math.min(kept, total);
}

/** "Folders 5": a group's label row, for the eye only (the cards and tiles name themselves). */
export function GroupLabel({ name, count }: { name: string; count: number }) {
  const { i18n } = useTranslation();
  return (
    <span className="entry-group">
      <span className="entry-group__name">{name}</span>
      <span className="entry-group__count">{formatNumber(count, i18n.language)}</span>
    </span>
  );
}

export interface FolderCardProps {
  row: EntryRow;
  selected: boolean;
  /** The name, or its rename field. */
  name: ReactNode;
  /** The id of the count, which describes the card's grid cell. */
  countId: string;
}

/**
 * A folder card: its icon, then its name over how many files it holds at any depth ("5 files"),
 * nothing while that loads, or that it could not be counted.
 */
export function FolderCard({ row, selected, name, countId }: FolderCardProps) {
  const { t } = useTranslation('library');
  const count = useCount({ of: 'files', scope: refOf(row), filter: NO_FILTER });
  let text: string | null = null;
  if (count.data !== undefined) text = t('cards.folderFiles', { count: count.data });
  else if (count.status === 'error') text = t('cards.countFailed');
  return (
    <div className="folder-card" data-selected={selected || undefined}>
      <Folder aria-hidden size={SIZE.iconFolderCard} className="folder-card__icon" />
      <span className="folder-card__text">
        {name}
        {text !== null && (
          <span id={countId} className="folder-card__count">
            {text}
          </span>
        )}
      </span>
    </div>
  );
}
