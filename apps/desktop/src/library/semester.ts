// The semester the Library shows (ui-architecture §6.1): the one chosen on this computer, kept
// per library in the session store. Until one is chosen, or after the chosen one is gone, it is
// the semester holding the most recently modified file (first-run handoff §5.2), else the last
// semester in the user's order that is not archived.
import { useEffect } from 'react';

import { useDefaultSemester, useSemesters } from '../data/groups';
import { setCurrentSemester, useCurrentSemester } from '../data/session';
import type { Semester } from '../ipc';

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
  const fallback = useDefaultSemester(semesters, needsDefault);
  const semester = known ?? fallback ?? null;

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
