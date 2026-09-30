import '../palette.css';
import './TagDot.css';

import { isPaletteColor } from '../../lib/palette';

/**
 * A tag's 7 px colour dot (app-shell handoff §10). Colour only: the row or chip around it names
 * the tag ("Tags: Notes, Exams"). An unknown colour draws a neutral dot.
 */
export function TagDot({ color }: { color: string }) {
  return (
    <span className="tag-dot" data-palette={isPaletteColor(color) ? color : undefined} aria-hidden />
  );
}
