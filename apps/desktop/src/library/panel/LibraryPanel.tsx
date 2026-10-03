import './Panel.css';

import { FolderOpen, FunnelX, GraduationCap, List, ListTree, LoaderCircle, Plus } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useLayout } from '../../app/layout';
import { openDialog, useCanOpenDialog } from '../../app/navigation';
import { useShortcut, useShortcutLabel } from '../../app/shortcuts';
import { Button } from '../../components/Button/Button';
import type { IndexRange } from '../../components/collections/useVirtualRows';
import { IconButton } from '../../components/IconButton/IconButton';
import { Panel } from '../../components/Panel/Panel';
import { SegmentedControl } from '../../components/SegmentedControl/SegmentedControl';
import { Skeleton } from '../../components/Skeleton/Skeleton';
import { StateBlock } from '../../components/StateBlock/StateBlock';
import { useFiles } from '../../data/entries';
import { useCourses } from '../../data/groups';
import { useJobActive } from '../../data/jobs';
import { useCount } from '../../data/paged';
import { useTags } from '../../data/tags';
import type { Course, EntryRef, Semester } from '../../ipc';
import { useAddFiles } from '../addFiles';
import { NO_FILTER, tagFilterOf } from '../filters';
import { LoadFailure, useRetryFailed } from '../LoadFailure';
import { KEYS } from '../menus/EntryMenu';
import { EntriesView } from '../pane/EntriesView';
import { courseIn } from '../places';
import { type PanelMode, setPanelMode, usePreferences } from '../preferences';
import type { CurrentSemester } from '../../data/semester';
import { setFilter, useLibraryView } from '../state';
import { DropPanel } from '../drop/DropPanel';
import { BrowseTree, FilteredTree } from '../tree/LibraryTree';
import { LibraryBanners } from './LibraryBanners';
import { TagFilterBar, useActiveFilter } from './TagFilterBar';


/** A state block in the tree area, under the quick views when they show (library-actions §2.5). */
function TreeArea({ children, overlay }: { children?: ReactNode; overlay?: ReactNode }) {
  return (
    <div className="tree-area">
      {children}
      {overlay !== undefined && <div className="tree-area__overlay">{overlay}</div>}
    </div>
  );
}

/** The panel's List mode: the semester's files in one list, with where each one is. */
function LibraryList({ semester, filter }: { semester: Semester; filter: readonly string[] }) {
  const { t } = useTranslation('library');
  const sort = usePreferences((state) => state.sort);
  const [range, setRange] = useState<IndexRange | null>(null);
  const tagFilter = tagFilterOf(filter);
  const list = useFiles(semester.folder, tagFilter, sort, range);
  if (list.status === 'error' && list.error !== null) {
    return (
      <LoadFailure title={t('states.loadFiles', { semester: semester.name })} error={list.error.error} retry={list.retry} placement="panel" />
    );
  }
  if (list.total === undefined) return <Skeleton rows={8} />;
  if (list.total === 0) {
    return (
      <TreeArea
        overlay={
          filter.length > 0 ? (
            <NoMatch semester={semester} filter={filter} />
          ) : (
            <StateBlock icon={FolderOpen} title={t('states.noFiles.title', { semester: semester.name })} text={t('states.noFiles.text')} />
          )
        }
      />
    );
  }
  return (
    <EntriesView
      label={filter.length === 0 ? t('list.label', { semester: semester.name }) : t('list.labelFiltered', { semester: semester.name })}
      list={list}
      mode="list"
      region="panel"
      onRangeChange={setRange}
      folder={null}
      showPlace
    />
  );
}

/** "No files match" (library-actions §8), naming the tags of the filter. */
function NoMatch({ semester, filter }: { semester: Semester; filter: readonly string[] }) {
  const { t, i18n } = useTranslation('library');
  const tags = useTags().data ?? [];
  const names = filter.map((id) => tags.find((tag) => tag.id === id)?.name ?? t('tree.unknownTag'));
  const [only] = names;
  const list = new Intl.ListFormat(i18n.language, { type: 'conjunction' }).format(names);
  return (
    <StateBlock
      icon={FunnelX}
      title={t('states.noMatch.title')}
      text={
        names.length === 1 && only !== undefined
          ? t('states.noMatch.textOne', { semester: semester.name, tag: only })
          : t('states.noMatch.textMany', { semester: semester.name, tags: list })
      }
      actions={
        <Button
          onPress={() => {
            setFilter([]);
          }}
        >
          {t('states.noMatch.action')}
        </Button>
      }
    />
  );
}

/** The course to add files to from the panel: the shown course or folder, else the selected file's course. */
export function currentFolderOf(courses: readonly Course[]): EntryRef | null {
  const active = useLibraryView.getState().active;
  if (active?.kind === 'folder') return active.entry;
  if (active?.kind === 'file') return courseIn(active.entry.path, courses)?.folder ?? null;
  return null;
}

function PanelContent({ info, filter }: { info: CurrentSemester; filter: readonly string[] }) {
  const { t } = useTranslation('library');
  const panel = usePreferences((state) => state.panel);
  const { semester } = info;
  const courses = useCourses(semester?.folder.path ?? null);
  const scanning = useJobActive('scan');
  const canNewSemester = useCanOpenDialog('newSemester');
  const canAddCourses = useCanOpenDialog('addCourses');
  const retry = useRetryFailed();

  if (info.status === 'error' && info.error !== null) {
    return <LoadFailure title={t('states.loadCourses')} error={info.error.error} retry={retry} placement="panel" />;
  }
  if (info.status === 'pending') return <Skeleton rows={8} />;
  // A taken-over library's first scan may not have found a semester folder yet.
  const reading = <StateBlock icon={LoaderCircle} spinning title={t('states.reading.title')} text={t('states.reading.text')} />;
  if (semester === null) {
    return (
      <TreeArea
        overlay={
          scanning ? (
            reading
          ) : (
            <StateBlock
              icon={GraduationCap}
              title={t('states.noSemesters.title')}
              text={t('states.noSemesters.text')}
              actions={
                canNewSemester ? (
                  <Button
                    variant="accent"
                    icon={Plus}
                    onPress={() => {
                      openDialog('newSemester');
                    }}
                  >
                    {t('states.noSemesters.action')}
                  </Button>
                ) : undefined
              }
            />
          )
        }
      />
    );
  }
  if (courses.status === 'error') {
    return (
      <LoadFailure title={t('states.loadCourses')} error={courses.error.error} retry={retry} placement="panel" />
    );
  }
  if (courses.status === 'pending') return <Skeleton rows={8} />;
  const list = courses.data;

  if (list.length === 0) {
    return (
      <TreeArea
        overlay={
          scanning ? (
            reading
          ) : (
            <StateBlock
              icon={GraduationCap}
              title={t('states.noCourses.title', { semester: semester.name })}
              text={t('states.noCourses.text', { semester: semester.name })}
              hint={t('states.noCourses.hint')}
              actions={
                canAddCourses ? (
                  <Button
                    variant="accent"
                    icon={Plus}
                    onPress={() => {
                      openDialog('addCourses', { semester: semester.folder });
                    }}
                  >
                    {t('states.noCourses.action')}
                  </Button>
                ) : undefined
              }
            />
          )
        }
      />
    );
  }
  if (panel === 'list') return <LibraryList semester={semester} filter={filter} />;
  if (filter.length > 0) {
    return (
      <FilteredContent semester={semester} courses={list} filter={filter} />
    );
  }
  return (
    <TreeArea>
      <BrowseTree semester={semester} courses={list} quickViews />
    </TreeArea>
  );
}

/** The filtered tree, with "No files match" under the quick views when nothing matches. */
function FilteredContent({ semester, courses, filter }: { semester: Semester; courses: readonly Course[]; filter: readonly string[] }) {
  const tagFilter = tagFilterOf(filter);
  const matches = useCount({ of: 'files', scope: semester.folder, filter: tagFilter });
  return (
    <TreeArea overlay={matches.data === 0 ? <NoMatch semester={semester} filter={filter} /> : undefined}>
      <FilteredTree semester={semester} courses={courses} filter={filter} quickViews />
    </TreeArea>
  );
}

/**
 * The Library panel (app-shell handoff §5): the header with the file count, List or Tree and
 * "Add files"; the banners; the tag filter bar; then the tree or list, or the state the
 * semester is in. In a narrow window the tag filter bar hides (§2).
 */
export function LibraryPanel({ info }: { info: CurrentSemester }) {
  const { t } = useTranslation('library');
  const narrow = useLayout() === 'narrow';
  const panel = usePreferences((state) => state.panel);
  const shortcut = useShortcutLabel();
  const addFiles = useAddFiles();
  const semester = info.semester;
  const courses = useCourses(semester?.folder.path ?? null).data ?? [];
  const count = useCount({ of: 'files', scope: semester?.folder ?? null, filter: NO_FILTER });
  const filter = useActiveFilter();
  const add = addFiles === null ? null : () => {
    addFiles(currentFolderOf(courses));
  };
  // Ctrl+O adds files anywhere in the Library view (library-actions §6).
  useShortcut(KEYS.addFiles, add);

  return (
    <Panel
      title={t('panel.title')}
      count={semester === null ? 0 : count.data}
      countLabel={semester === null || count.data === undefined ? undefined : t('panel.count', { count: count.data, semester: semester.name })}
      className="library-panel"
      actions={
        <>
          <SegmentedControl<PanelMode>
            label={t('panel.mode')}
            segments={[
              { id: 'list', label: t('panel.list'), icon: List },
              { id: 'tree', label: t('panel.tree'), icon: ListTree },
            ]}
            selected={panel}
            onChange={setPanelMode}
          />
          {add !== null && <IconButton icon={Plus} label={t('panel.addFiles')} shortcut={shortcut(KEYS.addFiles)} onPress={add} />}
        </>
      }
    >
      <LibraryBanners />
      {!narrow && semester !== null && courses.length > 0 && <TagFilterBar />}
      <PanelContent info={info} filter={filter} />
      <DropPanel region="panel" />
    </Panel>
  );
}
