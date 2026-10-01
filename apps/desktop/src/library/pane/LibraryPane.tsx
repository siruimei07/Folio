import './Pane.css';

import { CircleCheck, Clock, FolderOpen, Plus, TagX } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { ErrorBoundary } from '../../app/ErrorBoundary';
import { useLayout } from '../../app/layout';
import { PREVIEW_PANE } from '../../app/panes';
import { Button } from '../../components/Button/Button';
import type { IndexRange } from '../../components/collections/useVirtualRows';
import { StateBlock } from '../../components/StateBlock/StateBlock';
import { Skeleton } from '../../components/Skeleton/Skeleton';
import { useChildren, useEntry, useFiles } from '../../data/entries';
import { useCourses } from '../../data/groups';
import { useCount } from '../../data/paged';
import type { EntryRef, EntryRow } from '../../ipc';
import { courseCode, courseNameAfterCode } from '../../lib/courses';
import { nameOf, parentOf } from '../../lib/paths';
import { SIZE } from '../../tokens/tokens';
import { useAddFiles } from '../addFiles';
import { displayName } from '../commands';
import { NO_FILTER } from '../filters';
import { EntryMenu } from '../menus/EntryMenu';
import { prefixOf } from '../places';
import { usePreferences } from '../preferences';
import { useOpenQuickFilter } from '../quick';
import { type QuickView, setCovered, useLibraryView } from '../state';
import { LoadFailure } from '../LoadFailure';
import { EmptyPreview } from './EmptyPreview';
import { EntriesView } from './EntriesView';
import { PaneHeader } from './PaneHeader';

interface FilesBodyProps {
  label: string;
  list: ReturnType<typeof useChildren>;
  setRange: (range: IndexRange) => void;
  folder: EntryRef | null;
  showPlace: boolean;
  failedTitle: string;
  empty: ReactNode;
}

/** The files of a course, folder or quick view in one of the four states (UI architecture §13). */
function FilesBody({ label, list, setRange, folder, showPlace, failedTitle, empty }: FilesBodyProps) {
  const mode = usePreferences((state) => state.pane);
  if (list.status === 'error' && list.error !== null) {
    return (
      <div className="pane-state" data-tone="danger">
        <LoadFailure title={failedTitle} error={list.error.error} retry={list.retry} placement="preview" />
      </div>
    );
  }
  if (list.total === undefined) return <Skeleton rows={6} />;
  if (list.total === 0) return <div className="pane-state">{empty}</div>;
  return (
    <EntriesView
      label={label}
      list={list}
      mode={mode}
      onRangeChange={setRange}
      folder={folder}
      showPlace={showPlace}
    />
  );
}

/** A course or folder: its header and the grid or list of what is in it (app-shell §5). */
function FolderPane({ entry, onBack }: { entry: EntryRef; onBack?: () => void }) {
  const { t } = useTranslation('library');
  const sort = usePreferences((state) => state.sort);
  const [range, setRange] = useState<IndexRange | null>(null);
  const list = useChildren(entry, sort, range);
  const courses = useCourses().data ?? [];
  const course = courses.find((candidate) => candidate.folder.id === entry.id);
  const files = useCount({ of: 'files', scope: entry, filter: NO_FILTER });
  const addFiles = useAddFiles();
  const name = displayName(entry, courses);
  const count = course?.files ?? files.data;

  const empty = (
    <StateBlock
      icon={FolderOpen}
      placement="preview"
      title={course === undefined ? t('pane.emptyFolder.title', { name }) : t('pane.emptyCourse.title', { name })}
      text={course === undefined ? t('pane.emptyFolder.text', { name }) : t('pane.emptyCourse.text', { name })}
      actions={
        addFiles === null ? undefined : (
          <Button
            variant="accent"
            icon={Plus}
            onPress={() => {
              addFiles(entry);
            }}
          >
            {t('pane.emptyCourse.action')}
          </Button>
        )
      }
    />
  );

  return (
    <>
      <PaneHeader onBack={onBack}>
        <FolderOpen aria-hidden size={SIZE.icon} className="pane-header__icon" />
        {course === undefined ? (
          <span className="pane-header__names">
            <span className="pane-header__path">{prefixOf(parentOf(entry.path), courses)}</span>
            <span className="pane-header__name">{nameOf(entry.path)}</span>
          </span>
        ) : (
          <span className="pane-header__names">
            {courseCode(course) !== null && <span className="pane-header__name">{courseCode(course)}</span>}
            <span className={courseCode(course) === null ? 'pane-header__name' : 'pane-header__course'}>
              {courseNameAfterCode(course)}
            </span>
          </span>
        )}
        {count !== undefined && <span className="pane-header__count">{t('pane.files', { count })}</span>}
      </PaneHeader>
      <FilesBody
        label={t('pane.grid', { name })}
        list={list}
        setRange={setRange}
        folder={entry}
        showPlace={false}
        failedTitle={t('states.loadFolder', { name })}
        empty={empty}
      />
    </>
  );
}

/** "Recently added" or "Untagged": the files of the whole library that match (§5). */
function QuickPane({ view, onBack }: { view: QuickView; onBack?: () => void }) {
  const { t } = useTranslation('library');
  const sort = usePreferences((state) => state.sort);
  const filter = useOpenQuickFilter(view);
  const [range, setRange] = useState<IndexRange | null>(null);
  const list = useFiles(null, filter, sort, range);
  const name = t(`tree.quick.${view}`);
  const Icon = view === 'recent' ? Clock : TagX;
  const empty =
    view === 'recent' ? (
      <StateBlock icon={Clock} placement="preview" title={t('pane.recentEmpty.title')} text={t('pane.recentEmpty.text')} />
    ) : (
      <StateBlock
        tone="success"
        icon={CircleCheck}
        placement="preview"
        title={t('pane.untaggedEmpty.title')}
        text={t('pane.untaggedEmpty.text')}
      />
    );
  return (
    <>
      <PaneHeader onBack={onBack}>
        <Icon aria-hidden size={SIZE.icon} className="pane-header__icon" />
        <span className="pane-header__names">
          <span className="pane-header__name">{name}</span>
        </span>
        {list.total !== undefined && <span className="pane-header__count">{t('pane.files', { count: list.total })}</span>}
      </PaneHeader>
      <FilesBody
        label={name}
        list={list}
        setRange={setRange}
        folder={null}
        showPlace
        failedTitle={t('states.loadFolder', { name })}
        empty={empty}
      />
    </>
  );
}

/** A file: the preview pane of `feat/ui-preview` once it lands, its empty state until then. */
function FilePane({ entry, onBack }: { entry: EntryRef; onBack?: () => void }) {
  const { t } = useTranslation('library');
  const row = useEntry(entry).data;
  if (PREVIEW_PANE === null) return <EmptyPreview title={t('pane.empty.title')} text={t('pane.empty.text')} />;
  const Preview = PREVIEW_PANE;
  const target = row === undefined ? null : targetOf(row);
  return (
    <ErrorBoundary source="preview" kind="preview">
      <Preview
        entry={entry}
        onBack={onBack}
        moreMenu={target === null ? undefined : <EntryMenu targets={[target]} region="pane" more />}
      />
    </ErrorBoundary>
  );
}

function targetOf(row: EntryRow) {
  return { id: row.id, path: row.path, kind: row.kind, tags: row.tags, folderTags: row.folderTags };
}

export interface LibraryPaneProps {
  /** The semester has no courses, or there is no semester: "Add courses to get started". */
  noCourses: boolean;
}

/**
 * The third column of the Library (app-shell handoff §5): the empty preview, the files of a
 * course, folder or quick view, or a file's preview. In a narrow window it covers the list while
 * it shows a file or a quick view, with "Back" (§2).
 */
export function LibraryPane({ noCourses }: LibraryPaneProps) {
  const { t } = useTranslation('library');
  const active = useLibraryView((state) => state.active);
  const narrow = useLayout() === 'narrow';
  const back = narrow
    ? () => {
        setCovered(false);
      }
    : undefined;

  let body;
  if (active === null) {
    body = noCourses ? (
      <EmptyPreview title={t('pane.start.title')} text={t('pane.start.text')} />
    ) : (
      <EmptyPreview title={t('pane.empty.title')} text={t('pane.empty.text')} />
    );
  } else if (active.kind === 'quick') {
    body = <QuickPane key={active.view} view={active.view} onBack={back} />;
  } else if (active.kind === 'folder') {
    body = <FolderPane key={active.entry.id} entry={active.entry} onBack={back} />;
  } else {
    body = <FilePane key={active.entry.id} entry={active.entry} onBack={back} />;
  }

  return (
    <section className="library-pane" aria-label={t('pane.label')} data-kind={active?.kind ?? 'empty'}>
      {body}
    </section>
  );
}

