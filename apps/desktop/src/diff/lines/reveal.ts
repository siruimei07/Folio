// Scrolling the region to a change (handoff workspace-history §6.9, §14): the change's first row
// goes to the top third of the view, smoothly over `motion.duration.base` with
// `motion.easing.standard`, and at once when Reduce motion sets the durations to 0 (tokens.css).
// The tokens are read from the root, where tokens.css defines them and turns them off.

/** Where a revealed row sits: a third of the way down the view. */
export const REVEAL_AT = 1 / 3;

/** Frames the scroll keeps following the row after the motion ends, while rows above it are measured. */
const SETTLE_FRAMES = 10;

/** What the person does that takes the view back from a scroll under way. */
const TAKE_OVER = ['wheel', 'pointerdown', 'touchstart', 'keydown'] as const;

export interface Motion {
  /** In milliseconds; 0 jumps. */
  duration: number;
  /** Progress from 0 to 1 over the duration, to the share of the distance covered. */
  easing: (progress: number) => number;
}

/** A CSS time ("160ms", "0.16s") in milliseconds; 0 for anything else, such as a missing token. */
export function durationMs(value: string): number {
  const match = /^(\d*\.?\d+)(ms|s)$/.exec(value.trim());
  if (match === null) return 0;
  const amount = Number(match[1]);
  return match[2] === 's' ? amount * 1000 : amount;
}

/** `cubic-bezier(x1, y1, x2, y2)` as a function of progress, as CSS solves it. */
export function cubicBezier(x1: number, y1: number, x2: number, y2: number): (progress: number) => number {
  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * y1;
  const by = 3 * (y2 - y1) - cy;
  const ay = 1 - cy - by;
  const xAt = (t: number) => ((ax * t + bx) * t + cx) * t;
  const yAt = (t: number) => ((ay * t + by) * t + cy) * t;
  const slopeAt = (t: number) => (3 * ax * t + 2 * bx) * t + cx;
  return (progress) => {
    if (progress <= 0) return 0;
    if (progress >= 1) return 1;
    // Newton's method finds the curve's t for this x; bisection when the slope is too flat.
    let t = progress;
    for (let step = 0; step < 8; step++) {
      const error = xAt(t) - progress;
      if (Math.abs(error) < 1e-6) return yAt(t);
      const slope = slopeAt(t);
      if (Math.abs(slope) < 1e-6) break;
      t -= error / slope;
    }
    let low = 0;
    let high = 1;
    t = progress;
    while (high - low > 1e-6) {
      if (xAt(t) < progress) low = t;
      else high = t;
      t = (low + high) / 2;
    }
    return yAt(t);
  };
}

const linear = (progress: number) => Math.min(1, Math.max(0, progress));

/** A CSS easing given as `cubic-bezier(…)`; linear for anything else. */
export function easingOf(value: string): (progress: number) => number {
  const number = String.raw`\s*(-?\d*\.?\d+)\s*`;
  const match = new RegExp(`^cubic-bezier\\(${number},${number},${number},${number}\\)$`).exec(value.trim());
  if (match === null) return linear;
  const [x1, y1, x2, y2] = match.slice(1).map(Number) as [number, number, number, number];
  return cubicBezier(x1, y1, x2, y2);
}

/** The motion tokens of the page `element` is in: `--motion-duration-base`, `--motion-easing-standard`. */
export function motionOf(element: Element): Motion {
  const style = getComputedStyle(element.ownerDocument.documentElement);
  return {
    duration: durationMs(style.getPropertyValue('--motion-duration-base')),
    easing: easingOf(style.getPropertyValue('--motion-easing-standard')),
  };
}

/**
 * Scrolls `element` to the offset `target()` gives, read again each frame, so a row whose place
 * changes as the rows above it are measured is still where the scroll ends. With a duration of 0
 * it jumps at once. A wheel, a pointer, a touch or a key on the element stops it, as does the
 * function it returns.
 */
export function scrollToTarget(element: HTMLElement, target: () => number, { duration, easing }: Motion): () => void {
  const from = element.scrollTop;
  let frame = 0;
  let started: number | null = null;
  // Frames since the motion ended, and of those the last ones in a row that found the row in place.
  let followed = 0;
  let still = 0;
  const set = (top: number) => {
    element.scrollTo({ top, behavior: 'instant' });
  };
  const stop = () => {
    cancelAnimationFrame(frame);
    for (const type of TAKE_OVER) element.removeEventListener(type, stop);
  };
  const step = (now: number) => {
    started ??= now;
    const progress = duration <= 0 ? 1 : (now - started) / duration;
    const to = target();
    if (progress < 1) {
      set(from + (to - from) * easing(progress));
      frame = requestAnimationFrame(step);
      return;
    }
    // The motion ends exactly on the row; then it follows the row only when it is a pixel or more off.
    if (followed === 0 || Math.abs(element.scrollTop - to) >= 1) {
      if (element.scrollTop !== to) set(to);
      still = 0;
    } else {
      still += 1;
    }
    followed += 1;
    if (still < 2 && followed < SETTLE_FRAMES) frame = requestAnimationFrame(step);
    else stop();
  };
  if (duration <= 0) set(target());
  for (const type of TAKE_OVER) element.addEventListener(type, stop, { passive: true });
  frame = requestAnimationFrame(step);
  return stop;
}
