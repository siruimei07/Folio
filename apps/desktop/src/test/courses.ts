// Courses built for the pure tests of paths and titles: a course with a code, kept apart from the
// folders below it, and a course without one, whose Chinese name stays with them.
import type { Course } from '../ipc';

/** A course at `path`, with no badge, colour or files. */
export function course(path: string, code: string | null, name: string): Course {
  return { folder: { id: path, path }, name, abbr: null, code, color: null, archived: false, files: 0 };
}

export const MAT = course('Fall 2026/MAT232 Calculus of Several Variables', 'MAT232', 'MAT232 Calculus of Several Variables');

export const LINEAR = course('Fall 2026/线性代数', null, '线性代数');
