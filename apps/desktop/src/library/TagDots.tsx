import './TagDots.css';

import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import { TagDot } from '../components/TagDot/TagDot';
import { useTags } from '../data/tags';
import type { EntryRow, Tag } from '../ipc';

/** Tags by id. */
export type TagLookup = ReadonlyMap<string, Tag>;

/** The library's tags by id; empty until they arrive. */
export function useTagLookup(): TagLookup {
  const { data } = useTags();
  return useMemo(() => new Map((data ?? []).map((tag) => [tag.id, tag])), [data]);
}

/** At most this many dots in a row (app-shell handoff §5). */
const MAX_DOTS = 3;

/** A file's effective tags (ipc-m1 §8.2): its own, then those of the folders above it. */
export function effectiveTags(ids: readonly string[], folderIds: readonly string[]): string[] {
  return [...ids, ...folderIds.filter((id) => !ids.includes(id))];
}

/** "Notes, Exams": the names of tags, an unknown id as "Unknown tag". */
export function useTagNames(tags: TagLookup) {
  const { t } = useTranslation('library');
  return (ids: readonly string[]) => ids.map((id) => tags.get(id)?.name ?? t('tree.unknownTag')).join(', ');
}

/** A row's accessible name: its name, then its own and inherited tags ("notes.md, tags Notes"). */
export function useRowLabel(tags: TagLookup) {
  const { t } = useTranslation('library');
  const names = useTagNames(tags);
  return (row: Pick<EntryRow, 'name' | 'tags' | 'folderTags'>) => {
    const all = effectiveTags(row.tags, row.folderTags);
    return all.length === 0 ? row.name : t('tree.withTags', { name: row.name, names: names(all) });
  };
}

export interface TagDotsProps {
  ids: readonly string[];
  folderIds: readonly string[];
  tags: TagLookup;
}

/**
 * Up to three dots for a file's tags, its own first (app-shell decision 8A). Colour only: the row
 * names the tags in its accessible name, and the dots repeat them in a tooltip.
 */
export function TagDots({ ids, folderIds, tags }: TagDotsProps) {
  const { t } = useTranslation('library');
  const names = useTagNames(tags);
  const all = effectiveTags(ids, folderIds);
  if (all.length === 0) return null;
  return (
    <span className="tag-dots" title={t('tree.tags', { names: names(all) })}>
      {all.slice(0, MAX_DOTS).map((id) => (
        <TagDot key={id} color={tags.get(id)?.color ?? ''} />
      ))}
    </span>
  );
}
