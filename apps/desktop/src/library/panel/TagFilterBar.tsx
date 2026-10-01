import { RefreshCw } from 'lucide-react';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '../../components/Button/Button';
import { TagToggle } from '../../components/TagChip/TagChip';
import { useTags } from '../../data/tags';
import { LIMITS } from '../../ipc';
import { useLayout } from '../../app/layout';
import { setFilter, useLibraryView } from '../state';

const NO_TAGS: readonly string[] = [];

/** The stored filter without tags that were deleted since. */
function useKnownFilter(): readonly string[] {
  const tags = useTags().data;
  const filter = useLibraryView((state) => state.filter);
  return useMemo(
    () => (tags === undefined ? filter : filter.filter((id) => tags.some((tag) => tag.id === id))),
    [tags, filter],
  );
}

/**
 * The tag filter that applies to the tree and the list: none in a narrow window, where the bar is
 * hidden and filters go through search (app-shell §2); the stored one comes back when the window
 * widens.
 */
export function useActiveFilter(): readonly string[] {
  const filter = useKnownFilter();
  return useLayout() === 'narrow' ? NO_TAGS : filter;
}

/**
 * The tag filter bar (app-shell handoff §5, 13A): "All", then every tag in order. Several tags
 * can be on, and a file must have all of them; "All" clears them. Wraps to a second row.
 */
export function TagFilterBar() {
  const { t } = useTranslation('library');
  const query = useTags();
  const filter = useKnownFilter();
  const tags = query.data;

  const full = filter.length >= LIMITS.filterTags;
  return (
    <div role="group" aria-label={t('filter.label')} className="tag-filter">
      <TagToggle
        tag={null}
        isSelected={filter.length === 0}
        onChange={() => {
          setFilter([]);
        }}
      >
        {t('filter.all')}
      </TagToggle>
      {tags?.map((tag) => {
        const on = filter.includes(tag.id);
        return (
          <TagToggle
            key={tag.id}
            tag={tag}
            isSelected={on}
            isDisabled={!on && full}
            onChange={(selected) => {
              setFilter(selected ? [...filter, tag.id] : filter.filter((id) => id !== tag.id));
            }}
          />
        );
      })}
      {full && (
        <span className="tag-filter__note" role="status">
          {t('filter.full', { count: LIMITS.filterTags })}
        </span>
      )}
      {query.status === 'error' && (
        <span className="tag-filter__failed">
          {t('states.loadTags')}
          <Button
            variant="link"
            size="compact"
            icon={RefreshCw}
            onPress={() => {
              void query.refetch();
            }}
          >
            {t('states.tryAgain')}
          </Button>
        </span>
      )}
    </div>
  );
}
