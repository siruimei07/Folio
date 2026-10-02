// Semesters and courses (docs/specs/ipc-m1.md §7): lists in the user's order, refreshed by
// CatalogChanged when it reports `groups` or entries coming, going and moving (course file
// counts). Renaming, moving and deleting a semester or course are the entry mutations on its
// folder (`entries.ts`); settings and tags follow.
import { useQuery } from '@tanstack/react-query';
import { useCallback, useMemo } from 'react';

import {
  type Course,
  type CreateCourse,
  type CreateSemester,
  type EntrySort,
  ipc,
  type ReorderCourses,
  type ReorderSemesters,
  type Semester,
  type UpdateCourse,
  type UpdateSemester,
} from '../ipc';
import { isInside, parentOf } from '../lib/paths';
import { NO_FILTER, useFiles } from './entries';
import { unwrap } from './errors';
import { keys, libraryQuery } from './keys';
import { useCommandMutation } from './mutations';
import { LIST_PAGE } from './paged';
import { useLibraryId } from './session';

/** Folders directly in the library, semesters or other groups such as "Personal", in order. */
export function useSemesters() {
  return useQuery(libraryQuery(useLibraryId(), keys.semesters, () => unwrap(ipc.listSemesters())));
}

/**
 * Every semester's courses, by semester. Paths show course codes in place of course folders
 * (ipc-m1 §7), so one list of them all is cached, and narrower lists are selections of it.
 */
function coursesQuery(libraryId: string | null) {
  return libraryQuery(libraryId, keys.courses, () => unwrap(ipc.listCourses({ semester: null })));
}

/** The courses of every semester, by semester; with `semesterPath`, that semester's only. */
export function useCourses(semesterPath: string | null = null) {
  const select = useCallback(
    (courses: Course[]) =>
      semesterPath === null
        ? courses
        : courses.filter((course) => parentOf(course.folder.path) === semesterPath),
    [semesterPath],
  );
  return useQuery({ ...coursesQuery(useLibraryId()), select });
}

/** The course `path` is in, or is, for showing its code in paths; `undefined` outside courses. */
export function useCourseOf(path: string | null): Course | undefined {
  const select = useCallback(
    (courses: Course[]) =>
      path === null ? undefined : courses.find((course) => isInside(path, course.folder.path)),
    [path],
  );
  const { data } = useQuery({ ...coursesQuery(useLibraryId()), select });
  return data;
}

const NEWEST_FIRST: EntrySort = { key: 'modified', descending: true };
const FIRST_PAGE = { start: 0, end: 0 };

/**
 * The semester to show when none is chosen (ui-architecture §6.1, first-run handoff §5.2): the one
 * holding the most recently modified file among the first page of the newest, else the last one
 * that is not archived, else the last. `undefined` while disabled, loading, or without semesters.
 * The Library and the first run both use it, so they agree.
 */
export function useDefaultSemester(semesters: readonly Semester[] | undefined, enabled = true): Semester | undefined {
  const asked = enabled && semesters !== undefined && semesters.length > 0;
  const newest = useFiles(null, NO_FILTER, NEWEST_FIRST, FIRST_PAGE, { enabled: asked });
  return useMemo(() => {
    if (!asked || newest.status === 'pending') return undefined;
    const byPath = new Map(semesters.map((semester) => [semester.folder.path, semester]));
    const total = Math.min(newest.total ?? 0, LIST_PAGE);
    for (let index = 0; index < total; index++) {
      const path = newest.rowAt(index)?.path ?? '';
      const slash = path.indexOf('/');
      const holding = slash < 0 ? undefined : byPath.get(path.slice(0, slash));
      if (holding !== undefined) return holding;
    }
    return semesters.filter((semester) => !semester.archived).at(-1) ?? semesters.at(-1);
  }, [asked, newest, semesters]);
}

/** A new semester folder, last in the order; resolves to the semester. */
export function useCreateSemester() {
  return useCommandMutation((request: CreateSemester) => ipc.createSemester(request));
}

/** Archives a semester or brings it back. */
export function useUpdateSemester() {
  return useCommandMutation((request: UpdateSemester) => ipc.updateSemester(request), {
    entries: (request) => [request.semester],
  });
}

/** The new order of every semester, each exactly once. */
export function useReorderSemesters() {
  return useCommandMutation((request: ReorderSemesters) => ipc.reorderSemesters(request), {
    entries: (request) => request.semesters,
  });
}

/** A new course folder in a semester, last in its order; resolves to the course. */
export function useCreateCourse() {
  return useCommandMutation((request: CreateCourse) => ipc.createCourse(request), {
    entries: (request) => [request.semester],
  });
}

/** Replaces a course's badge, code, colour and archived state: send what the dialog shows. */
export function useUpdateCourse() {
  return useCommandMutation((request: UpdateCourse) => ipc.updateCourse(request), {
    entries: (request) => [request.course],
  });
}

/** The new order of a semester's courses, each exactly once. */
export function useReorderCourses() {
  return useCommandMutation((request: ReorderCourses) => ipc.reorderCourses(request), {
    entries: (request) => [request.semester, ...request.courses],
  });
}
