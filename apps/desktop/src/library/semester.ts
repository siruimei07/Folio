// The semester the Library shows (ui-architecture §6.1): the one chosen on this computer, kept
// per library in the session store. Until one is chosen, or after the chosen one is gone, it is
// the semester holding the most recently modified file (first-run handoff §5.2), else the last
// semester in the user's order that is not archived.
import { useEffect } from 'react';

import { useFiles } from '../data/entries';
import { useSemesters } from '../data/groups';
import { setCurrentSemester, useCurrentSemester } from '../data/session';
import type { Semester } from '../ipc';
import { NO_FILTER } from './filters';

const NEWEST_FIRST = { key: 'modified', descending: true } as const;
const FIRST_PAGE = { start: 0, end: 0 };

function fallback(semesters: readonly Semester[]): Semester | null {
  const open = semesters.filter((semester) => !semester.archived);
  return open.at(-1) ?? semesters.at(-1) ?? null;
}

export interface CurrentSemester {
  semesters: readonly Semester[] | undefined;
  /** `null` once loaded when the library has no semester. */
  semester: Semester | null;
  status: 'pending' | 'error' | 'success';
  error: ReturnType<typeof useSemesters>['error'];
}

export function useCurrentSemesterInfo(): CurrentSemester {
  const query = useSemesters();
  const chosen = useCurrentSemester();
  const semesters = query.data;
  const known = semesters?.find((semester) => semester.folder.path === chosen) ?? null;
  const needsDefault = semesters !== undefined && semesters.length > 0 && known === null;
  const newest = useFiles(null, NO_FILTER, NEWEST_FIRST, FIRST_PAGE, { enabled: needsDefault });

  let semester = known;
  if (semester === null && semesters !== undefined && newest.status !== 'pending') {
    const total = newest.total ?? 0;
    for (let index = 0; index < Math.min(total, 200) && semester === null; index++) {
      const path = newest.rowAt(index)?.path;
      const top = path?.split('/')[0];
      if (path?.includes('/') === true) semester = semesters.find((candidate) => candidate.folder.path === top) ?? null;
    }
    semester ??= fallback(semesters);
  }

  // Keep the default, so the view does not change when newer files arrive.
  const path = semester?.folder.path ?? null;
  useEffect(() => {
    if (needsDefault && path !== null) setCurrentSemester(path);
  }, [needsDefault, path]);

  return {
    semesters,
    semester,
    // The default waits for the newest file.
    status: query.status === 'success' && needsDefault && semester === null ? 'pending' : query.status,
    error: query.error,
  };
}
