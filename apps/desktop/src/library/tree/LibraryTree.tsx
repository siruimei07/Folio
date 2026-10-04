import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Banner } from '../../components/Banner/Banner';
import { Button } from '../../components/Button/Button';
import type { IndexRange } from '../../components/collections/useVirtualRows';
import { Skeleton } from '../../components/Skeleton/Skeleton';
import { useFiles } from '../../data/entries';
import type { Course, EntryRow, Semester } from '../../ipc';
import { tagFilterOf } from '../filters';
import { LoadFailure } from '../LoadFailure';
import { setPanelMode } from '../preferences';
import { FILTER_CAP, FilteredLayout } from './filtered';
import { TreeView } from './TreeView';
import { useTreeData } from './useTreeData';

/** Files in path order, for building the tree from flat pages (ipc-m1 §5.3). */
const PATH_ORDER = { key: 'path', descending: false } as const;

export interface BrowseTreeProps {
  semester: Semester;
  courses: readonly Course[];
  quickViews: boolean;
}

/** The tree without a filter: expand courses and folders one page at a time (§8.2). */
export function BrowseTree({ semester, courses, quickViews }: BrowseTreeProps) {
  const { t } = useTranslation('library');
  const [range, setRange] = useState<IndexRange | null>(null);
  const layout = useTreeData({ semester, courses, quickViews, range });
  return <TreeView model={layout} semester={semester.folder} label={t('tree.label', { semester: semester.name })} onRangeChange={setRange} />;
}

export interface FilteredTreeProps extends BrowseTreeProps {
  filter: readonly string[];
}

/** Name order of the UI language, digits by value, as the shell sorts names (ipc-m1 §5.3). */
function useNameOrder() {
  const { i18n } = useTranslation();
  return useMemo(() => {
    const collator = new Intl.Collator(i18n.language, { numeric: true, sensitivity: 'base' });
    return (a: string, b: string) => collator.compare(a, b);
  }, [i18n.language]);
}

/**
 * The tree with a tag filter (§8.2): the semester's matching files, the first 5,000 of them,
 * with every course and folder that holds one expanded.
 */
export function FilteredTree({ semester, courses, quickViews, filter }: FilteredTreeProps) {
  const { t } = useTranslation('library');
  const compare = useNameOrder();
  const tagFilter = tagFilterOf(filter);
  // Page 0 first, which carries the total; then the pages up to the total or the cap, so three
  // matches cost one request and not 25. A new filter starts from page 0 again.
  const filterKey = filter.join(',');
  const [wanted, setWanted] = useState({ filterKey, end: 0 });
  const files = useFiles(semester.folder, tagFilter, PATH_ORDER, { start: 0, end: wanted.end });
  const total = files.total;
  const end = total === undefined ? 0 : Math.max(0, Math.min(total, FILTER_CAP) - 1);
  if (wanted.filterKey !== filterKey) setWanted({ filterKey, end: 0 });
  else if (total !== undefined && wanted.end !== end) setWanted({ filterKey, end });
  // The list keeps its identity while its pages do, so this runs when the matches change.
  const layout = useMemo(() => {
    const rows: EntryRow[] = [];
    for (let index = 0; index < Math.min(files.total ?? 0, FILTER_CAP); index++) {
      const row = files.rowAt(index);
      if (row !== undefined) rows.push(row);
    }
    return new FilteredLayout({ quickViews, courses, semesterPath: semester.folder.path, rows, compare });
  }, [files, quickViews, courses, semester.folder.path, compare]);

  if (files.status === 'error' && files.error !== null) {
    return (
      <LoadFailure title={t('states.loadFiles', { semester: semester.name })} error={files.error.error} retry={files.retry} placement="panel" />
    );
  }
  if (total === undefined) return <Skeleton rows={8} />;
  return (
    <>
      {total > FILTER_CAP && (
        <Banner
          tone="info"
          title={t('filter.capped', { count: FILTER_CAP })}
          text={
            <Button
              variant="link"
              size="compact"
              onPress={() => {
                setPanelMode('list');
              }}
            >
              {t('filter.showList')}
            </Button>
          }
        />
      )}
      <TreeView model={layout} semester={semester.folder} label={t('tree.label', { semester: semester.name })} />
    </>
  );
}
