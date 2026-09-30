import '../motion.css';
import './Progress.css';

import { LoaderCircle } from 'lucide-react';
import { ProgressBar as AriaProgressBar } from 'react-aria-components';

import { SIZE } from '../../tokens/tokens';

export interface ProgressBarProps {
  /** Names the work, like "Adding 12 files to MAT232". */
  label: string;
  /** 0–100; `null` while the total is unknown. */
  value: number | null;
}

/**
 * A 4 px bar: the fill as wide as the value, or, while the total is unknown, a segment sweeping
 * from left to right that stands still under reduced motion (library-actions handoff §2.6).
 */
export function ProgressBar({ label, value }: ProgressBarProps) {
  const indeterminate = value === null;
  return (
    <AriaProgressBar
      aria-label={label}
      className="progress-bar"
      value={value ?? 0}
      isIndeterminate={indeterminate}
    >
      {({ percentage }) => (
        <span className="progress-bar__track">
          <span
            className="progress-bar__fill"
            data-indeterminate={indeterminate || undefined}
            style={indeterminate ? undefined : { width: `${String(percentage ?? 0)}%` }}
          />
        </span>
      )}
    </AriaProgressBar>
  );
}

/** Ring geometry on its 14-unit grid: radius 5.5 around the centre, 2 units of stroke. */
const RING_RADIUS = 5.5;
const RING_LENGTH = 2 * Math.PI * RING_RADIUS;

/**
 * The activity button's 14 px ring: the value as an arc from 12 o'clock, clockwise; unknown, a
 * quarter arc that turns (still under reduced motion). Decorative: the button's label has the
 * number.
 */
export function ProgressRing({ value }: { value: number | null }) {
  const share = value === null ? 0.25 : Math.min(Math.max(value, 0), 100) / 100;
  return (
    <svg
      aria-hidden
      className={value === null ? 'progress-ring spinning' : 'progress-ring'}
      width={SIZE.iconSmall}
      height={SIZE.iconSmall}
      viewBox="0 0 14 14"
    >
      <circle className="progress-ring__track" cx="7" cy="7" r={RING_RADIUS} />
      <circle
        className="progress-ring__arc"
        cx="7"
        cy="7"
        r={RING_RADIUS}
        transform="rotate(-90 7 7)"
        strokeDasharray={`${String(share * RING_LENGTH)} ${String(RING_LENGTH)}`}
      />
    </svg>
  );
}

export interface SpinnerProps {
  size?: 'small' | 'regular';
  /** Places it, like `toast__icon`. */
  className?: string;
}

/** The `loader-circle` icon turning once per `motion.duration.spin`; still under reduced motion. */
export function Spinner({ size = 'regular', className }: SpinnerProps) {
  return (
    <LoaderCircle
      aria-hidden
      className={className === undefined ? 'spinner spinning' : `spinner spinning ${className}`}
      size={size === 'small' ? SIZE.iconSmall : SIZE.icon}
    />
  );
}
