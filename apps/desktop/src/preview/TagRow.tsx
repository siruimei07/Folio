import { Plus } from 'lucide-react';
import { type ReactElement, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from 'react-aria-components';

import type { PreviewActions } from '../app/panes';
import { MenuButton } from '../components/Menu/Menu';
import { TagChipList } from '../components/TagChip/TagChip';
import { useLibrary } from '../data/library';
import { useTags } from '../data/tags';
import type { EntryRow, Tag } from '../ipc';
import { formatShortDate, formatTime, isSameDay, sizeParts } from '../lib/format';
import { SIZE } from '../tokens/tokens';

const NO_TAGS: readonly Tag[] = [];

/** "12 KB · Modified today at 5:18 PM", or "· Modified Sep 27" for an earlier day. */
function useMeta(row: EntryRow): string {
  const { t, i18n } = useTranslation(['preview', 'common']);
  // Today as of when the file showed; the pane remounts for every file.
  const [now] = useState(() => Date.now());
  const language = i18n.language;
  const { value, unit } = sizeParts(Number(row.size), language);
  const size = t(`common:size.${unit}`, { value });
  if (row.modifiedMs === null) return size;
  const modified = Number(row.modifiedMs);
  return isSameDay(modified, now)
    ? t('meta.today', { size, time: formatTime(modified, language) })
    : t('meta.earlier', { size, date: formatShortDate(modified, language) });
}

export interface TagRowProps {
  row: EntryRow;
  actions: PreviewActions;
  /** The menu of the dashed "+ Tag" chip: the host's Tags menu for this file. */
  tagMenu?: ReactElement;
}

/**
 * The tag row under the file header (app-shell §5): the file's tags with remove buttons, the tags
 * it gets from folders above it (removed only there), "+ Tag", and on the right the size and when
 * it was modified. A read-only library offers no editing (library-actions §9.1).
 */
export function TagRow({ row, actions, tagMenu }: TagRowProps) {
  const { t } = useTranslation('preview');
  const tags = useTags().data ?? NO_TAGS;
  const readOnly = useLibrary()?.readOnly === true;
  const meta = useMeta(row);
  const tagOf = (id: string) => tags.find((tag) => tag.id === id) ?? { id, name: t('tags.unknown'), color: 'stone' };
  const own = row.tags.map(tagOf);
  const inherited = row.folderTags.map(tagOf);

  return (
    <div className="preview-tags">
      <TagChipList
        label={t('tags.label')}
        tags={own}
        onRemove={
          readOnly
            ? undefined
            : (id) => {
                actions.setTags([row], [], [id]);
              }
        }
      >
        {inherited.length > 0 && <TagChipList label={t('tags.fromFolders')} tags={inherited} />}
        {tagMenu !== undefined && !readOnly && (
          <MenuButton
            trigger={
              <Button className="tag-chip preview-tags__add" aria-label={t('tags.addLabel')}>
                <Plus aria-hidden size={SIZE.iconSmall} />
                {t('tags.add')}
              </Button>
            }
          >
            {tagMenu}
          </MenuButton>
        )}
      </TagChipList>
      <span className="preview-tags__meta">{meta}</span>
    </div>
  );
}
