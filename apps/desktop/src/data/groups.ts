// Semesters and courses (docs/specs/ipc-m1.md §7): lists in the user's order, refreshed by
// CatalogChanged when it reports `groups` or entries coming, going and moving (course file
// counts). Renaming, moving and deleting a semester or course are the entry mutations on its
// folder (`entries.ts`); settings and tags follow.
import { useQuery } from '@tanstack/react-query';
import { useCallback } from 'react';

import {
  type Course,
  type CreateCourse,
  type CreateSemester,
  ipc,
  type ReorderCourses,
  type ReorderSemesters,
  type UpdateCourse,
  type UpdateSemester,
} from '../ipc';
import { isInside, parentOf } from '../lib/paths';
import { unwrap } from './errors';
import { keys, libraryQuery } from './keys';
import { useCommandMutation } from './mutations';
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
