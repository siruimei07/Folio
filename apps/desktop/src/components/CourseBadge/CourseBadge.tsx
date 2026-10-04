import '../palette.css';
import './CourseBadge.css';

import type { Course } from '../../ipc';
import { courseBadgeText, courseColor } from '../../lib/courses';

export interface CourseBadgeProps {
  course: Pick<Course, 'abbr' | 'code' | 'name' | 'color' | 'folder'>;
  /**
   * regular 22 px; compact 20 px with smaller letters (the narrow window); mini, below 20 px, a
   * colour square without text in a 16 px box (23A).
   */
  size?: 'regular' | 'compact' | 'mini';
}

/**
 * A course's badge: its colour as a tinted square with up to three letters in the palette's text
 * colour (app-shell handoff 12B, 23A). Decorative: the course's label next to it names the course.
 */
export function CourseBadge({ course, size = 'regular' }: CourseBadgeProps) {
  return (
    <span className="course-badge" data-palette={courseColor(course)} data-size={size} aria-hidden>
      {size === 'mini' ? null : courseBadgeText(course)}
    </span>
  );
}
