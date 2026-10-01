import './DeskIllustration.css';

import { SIZE } from '../../tokens/tokens';

/**
 * The "desk corner" of the empty preview (app-shell decision 9C), as the Cowork canvas draws it:
 * stacked books, a pencil and a steaming cup, in the `color.illustration.*` colours of the theme.
 * Decorative: the words next to it say what to do.
 */
export function DeskIllustration() {
  // Stroke widths are in the drawing's own units, like its coordinates.
  return (
    <svg
      className="desk-illustration"
      width={SIZE.illustrationWidth}
      height={SIZE.illustrationHeight}
      viewBox="0 0 240 170"
      aria-hidden
    >
      <g className="desk-illustration__lines" strokeWidth="1.5">
        <path d="M18 150h204" />
        <rect className="desk-illustration__fill" x="34" y="124" width="116" height="26" rx="4" />
        <path d="M48 124v26M138 124v26" />
        <rect className="desk-illustration__soft" x="44" y="100" width="98" height="24" rx="4" />
        <path d="M56 100v24M130 100v24" />
        <rect className="desk-illustration__fill" x="38" y="78" width="92" height="22" rx="4" />
        <path d="M50 78v22" />
        <path className="desk-illustration__bar" d="M64 89h44" strokeWidth="5" />
        <path d="M50 70l66-7" strokeWidth="8" />
        <path className="desk-illustration__accent" d="M51 70l64-7" strokeWidth="4.5" />
        <path className="desk-illustration__tip" d="M119 62.5l9-1-8.2 5z" />
        <path className="desk-illustration__fill" d="M162 106h38v36a8 8 0 0 1-8 8h-22a8 8 0 0 1-8-8z" />
        <path d="M200 114h5a8 8 0 0 1 0 16h-5" />
        <path d="M173 94c-4-6 4-9 0-15M183 94c-4-6 4-9 0-15M193 94c-4-6 4-9 0-15" />
      </g>
    </svg>
  );
}
