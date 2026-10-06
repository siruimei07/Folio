// Where things are, as the Library says it (app-shell decision 27B): a course's label stands for
// the semester and course folders, so "Fall 2026/MAT232 Calculus…/Problem sets" reads
// "MAT232 / Problem sets" in messages and "MAT232/Problem sets/" before a name in lists.
import type { Course } from '../ipc';
import { courseCode, courseLabel } from './courses';
import { isInside } from './paths';

/** The course `path` is in, or is. */
export function courseIn(path: string, courses: readonly Course[]): Course | undefined {
  return courses.find((course) => isInside(path, course.folder.path));
}

/** The names of `path` as shown: the course label first when it is in a course. */
export function placeParts(path: string, courses: readonly Course[]): string[] {
  if (path === '') return [];
  const course = courseIn(path, courses);
  if (course === undefined) return path.split('/');
  const below = path.slice(course.folder.path.length + 1);
  return [courseLabel(course), ...(below === '' ? [] : below.split('/'))];
}

/** A folder or entry in messages and titles: "MAT232 / Problem sets". */
export function placeOf(path: string, courses: readonly Course[]): string {
  return placeParts(path, courses).join(' / ');
}

/** The folders before a name in a flat list: "MAT232/Problem sets/"; `''` at the top. */
export function prefixOf(parentPath: string, courses: readonly Course[]): string {
  const parts = placeParts(parentPath, courses);
  return parts.length === 0 ? '' : `${parts.join('/')}/`;
}

/**
 * `prefixOf` in two parts for a heading that truncates (app-shell 27B): the course code, which
 * stays whole, and the folders after it, which shrink first. A course without a code goes by its
 * name, which shrinks with the folders, so it is one of them: `{ label: '', folders }`.
 */
export function headingPrefix(parentPath: string, courses: readonly Course[]): { label: string; folders: string } {
  const course = parentPath === '' ? undefined : courseIn(parentPath, courses);
  const code = course === undefined ? null : courseCode(course);
  if (course === undefined || code === null) return { label: '', folders: prefixOf(parentPath, courses) };
  const below = parentPath.slice(course.folder.path.length + 1);
  return { label: `${code}/`, folders: below === '' ? '' : `${below}/` };
}
