import { type ReactNode, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Spinner } from '../components/Progress/Progress';
import { useLibraryStatus } from '../data/library';
import { useLibraryId } from '../data/session';
import { OPENING_DELAY_MS } from '../lib/timing';
import { CoursesStep } from './CoursesStep';
import { FolderStep } from './FolderStep';
import { Frame } from './Frame';
import { ReviewStep } from './ReviewStep';
import { type CoursesPage, endFlow, useFirstRun } from './state';
import { CantStart, Unavailable } from './Unavailable';
import { Welcome } from './Welcome';

/**
 * Before `library_status` answers (§2): the title bar alone on the app surface, then, after
 * `OPENING_DELAY_MS`, a spinner and "Opening your library…".
 */
function Opening() {
  const { t } = useTranslation('first-run');
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => {
      setSlow(true);
    }, OPENING_DELAY_MS);
    return () => {
      clearTimeout(timer);
    };
  }, []);
  return (
    <Frame windowTitle={null} layout="state">
      {slow && (
        <p className="opening" role="status">
          <Spinner />
          {t('opening')}
        </p>
      )}
    </Frame>
  );
}

/**
 * Step 2 reads the new library through the data hooks, which follow the open library: until the
 * cache has it (step 1 waits for that, so only a failed status gets here), the page is empty.
 */
function StepTwo({ page }: { page: CoursesPage }) {
  if (useLibraryId() !== page.libraryId) return <Frame windowTitle={null} layout="step" busy />;
  return page.takeOver ? <ReviewStep scan={page.scan} /> : <CoursesStep noFolders={page.noFolders} />;
}

/**
 * What the window shows (first-run handoff §2): the Library (`children`) once a library is open;
 * before that the welcome screen and the first-run steps, or the full-window state of a library
 * that cannot be opened. LibraryStateChanged can change it at any time.
 */
export function StartGate({ children }: { children: ReactNode }) {
  const status = useLibraryStatus();
  const flow = useFirstRun((state) => state.flow);

  // A library that becomes unavailable during step 2 ends it (§2, §7).
  const lost = flow?.page === 'courses' && status.data?.state === 'unavailable';
  useEffect(() => {
    if (lost) endFlow();
  }, [lost]);

  if (flow?.page === 'courses' && !lost) return <StepTwo page={flow} />;
  if (flow?.page === 'folder') return <FolderStep key={flow.choice.token} page={flow} />;
  if (status.data === undefined) {
    return status.isError ? <CantStart error={status.error.error} /> : <Opening />;
  }
  switch (status.data.state) {
    case 'none':
      return <Welcome />;
    case 'unavailable':
      return <Unavailable root={status.data.root} reason={status.data.reason} />;
    case 'open':
      return children;
  }
}
