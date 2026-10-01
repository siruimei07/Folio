import './CourseLabel.css';

import type { Course } from '../../ipc';
import { courseCode, courseNameAfterCode } from '../../lib/courses';

export interface CourseLabelProps {
  course: Pick<Course, 'code' | 'name'>;
}

/**
 * A course in the tree, grid headers and settings (26C): the code in 600 with tabular figures,
 * then the name in the secondary colour. A course without a code shows its name in 600. Long
 * names truncate; the container gives the full text in its accessible name and tooltip.
 */
export function CourseLabel({ course }: CourseLabelProps) {
  const code = courseCode(course);
  return (
    <span className="course-label">
      {code === null ? (
        <span className="course-label__code course-label__code--name">{course.name}</span>
      ) : (
        <>
          <span className="course-label__code">{code}</span>
          <span className="course-label__name">{courseNameAfterCode(course)}</span>
        </>
      )}
    </span>
  );
}
