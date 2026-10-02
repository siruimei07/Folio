import './LibraryView.css';

import { FolderX } from 'lucide-react';
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';

import { useLayout } from '../app/layout';
import { takeRevealTarget, useNavigation } from '../app/navigation';
import { Panel } from '../components/Panel/Panel';
import { Skeleton } from '../components/Skeleton/Skeleton';
import { StateBlock } from '../components/StateBlock/StateBlock';
import { useCourses } from '../data/groups';
import { useLibrary, useLibraryStatus } from '../data/library';
import { openPathsTo, parentOf } from '../lib/paths';
import { LibraryDialogs } from './dialogs/LibraryDialogs';
import { LoadFailure } from './LoadFailure';
import { LibraryMenu } from './menus/LibraryMenu';
import { LibraryPane } from './pane/LibraryPane';
import { LibraryPanel } from './panel/LibraryPanel';
import { type CurrentSemester, useCurrentSemesterInfo } from '../data/semester';
import { expandAll, setActive, setReveal, showSemester, showWholeTree, useLibraryView } from './state';

/**
 * Takes the reveal target of the navigation store (UI architecture §8.2; search, "Show"): its
 * semester becomes current, the filter clears, its course and folders expand, and the tree selects
 * and shows it once its row has arrived. A file at the top of the library is only shown.
 */
function useRevealTarget(info: CurrentSemester) {
  const pending = useNavigation((state) => state.revealTarget);
  const semesters = info.semesters;
  useEffect(() => {
    if (pending === null || semesters === undefined) return;
    const target = takeRevealTarget();
    if (target === null) return;
    const [top] = target.path.split('/');
    const semester = semesters.find((candidate) => candidate.folder.path === top);
    if (semester === undefined) {
      // A file at the top of the library, beside the semesters: only shown.
      setActive({ kind: 'file', entry: target });
      return;
    }
    showSemester(semester.folder.path);
    // A semester itself is shown by becoming the current one.
    if (!target.path.includes('/')) return;
    showWholeTree();
    expandAll(openPathsTo(parentOf(target.path)));
    setReveal(target);
  }, [pending, semesters]);
}

function LibraryScreen() {
  const info = useCurrentSemesterInfo();
  const narrow = useLayout() === 'narrow';
  const covered = useLibraryView((state) => state.covered);
  const courses = useCourses(info.semester?.folder.path ?? null);
  useRevealTarget(info);
  const noCourses = info.status === 'success' && (info.semester === null || courses.data?.length === 0);
  return (
    <div className="library-view" data-covered={(narrow && covered) || undefined}>
      <LibraryPanel info={info} />
      <LibraryPane noCourses={noCourses} />
      <LibraryMenu />
      <LibraryDialogs />
    </div>
  );
}

/**
 * The Library view (app-shell handoff §5): the Library panel with the tree, and the third column
 * with the files of what is selected or a file's preview. Without an open library it says so;
 * the first-run flow (`feat/ui-first-run`) takes that place once it lands.
 */
export function LibraryView() {
  const { t } = useTranslation('library');
  const library = useLibrary();
  const status = useLibraryStatus();
  if (library !== null) return <LibraryScreen key={library.id} />;
  return (
    <div className="library-view">
      <Panel title={t('panel.title')} className="library-panel">
        {status.isPending ? (
          <Skeleton rows={6} />
        ) : status.isError ? (
          <LoadFailure
            title={t('noLibrary.failed')}
            error={status.error.error}
            retry={() => {
              void status.refetch();
            }}
            placement="panel"
          />
        ) : (
          <StateBlock icon={FolderX} title={t('noLibrary.title')} text={t('noLibrary.text')} />
        )}
      </Panel>
      <LibraryPane noCourses />
    </div>
  );
}
