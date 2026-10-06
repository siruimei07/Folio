import './PathHeading.css';

import type { ReactNode, Ref } from 'react';

export interface PathHeadingProps {
  /** The 16 px icon before the heading, such as `FileTypeIcon`; decorative (`aria-hidden`). */
  icon: ReactNode;
  /** The course code before the folders, "MAT232/", which stays whole (`headingPrefix`); `''` for none. */
  label?: string;
  /** The folders before the name, "Problem sets/", cut from the left first; `''` for none. */
  prefix: string;
  /** The name, or a title such as "CSC236 course settings". */
  name: string;
  /** After the name in the secondary colour, such as " · Tags". */
  suffix?: string;
  /** The heading's id, for a pane named by it (`aria-labelledby`). */
  id?: string;
  /** Where Esc and "Back" return focus: the heading takes focus from code only. */
  ref?: Ref<HTMLHeadingElement>;
}

/**
 * A pane's heading for a file or folder (workspace-history handoff §3.2, §6.1; app-shell §5, 27B):
 * the icon, then one `h2` with the course code and folders in the tertiary colour and the name in
 * 600. When it does not fit, the code stays whole, the folders are cut from the left first, then
 * the name at its end; the tooltip has the full path.
 */
export function PathHeading({ icon, label = '', prefix, name, suffix, id, ref }: PathHeadingProps) {
  return (
    <div className="path-heading">
      <span className="path-heading__icon" aria-hidden>
        {icon}
      </span>
      <h2 className="path-heading__title" id={id} ref={ref} tabIndex={-1} title={`${label}${prefix}${name}${suffix ?? ''}`}>
        {label !== '' && <span className="path-heading__label">{label}</span>}
        <span className="path-heading__rest">
          {prefix !== '' && (
            // Laid out right to left so the ellipsis cuts the start; `bdi` keeps the path itself in
            // its own order, with the final slash at the end.
            <span className="path-heading__path">
              <bdi>{prefix}</bdi>
            </span>
          )}
          <span className="path-heading__name">
            {name}
            {suffix !== undefined && <span className="path-heading__suffix">{suffix}</span>}
          </span>
        </span>
      </h2>
    </div>
  );
}
