// "Try again" on a part of a view whose read failed: the Changes list's load failure and the "Not
// synced" card's; History's load failure, refresh banner and failed earlier entries. TanStack sends
// a failed read that never had data back to `pending` while it reads again, which would take the
// failure, and the focused "Try again" with it, off the screen and drop the focus to the page (WCAG
// 2.4.3). So the failure stays shown while the retry runs, as the diff's "Try again" does
// (`diff/useRetry.ts`, UI architecture §8.3); when the read fails again, nothing on screen changes
// and the failure is read out again (WCAG 4.1.3); when it succeeds, the failure goes and the part
// that held it moves the focus on (Changes' `useViewFocus`, NotSynced's keeper, History's view
// keeper).
import { useEffect, useRef, useState } from 'react';

import { announce } from './announcer';

export interface RetriedFailure<E> {
  /** The failure to show: the reads', or the one "Try again" answers while the retry runs. */
  shown: E | null;
  /** "Try again": `start` reads again. */
  retry: () => void;
}

/** A retry under way: the failure it answers, and every failure there was when it began. */
interface Retrying<E> {
  failure: E;
  before: ReadonlySet<E>;
}

/**
 * The failure of a part's reads and its "Try again". `failures` are the reads' failures now, the
 * first one shown (each a new object for each failed attempt; a part may read several queries, which
 * TanStack moves back to pending one at a time), `reading` whether an answer is still to come,
 * `message` what is read out when a retry fails again.
 */
export function useRetriedFailure<E extends object>(
  failures: readonly (E | null)[],
  reading: boolean,
  message: string,
  start: () => void,
): RetriedFailure<E> {
  const [retrying, setRetrying] = useState<Retrying<E> | null>(null);
  const [failedAgain, setFailedAgain] = useState(0);
  const now = failures.filter((failure): failure is E => failure !== null);
  let current = retrying;
  // A failure the retry did not start with: it failed again.
  const fresh = current === null ? undefined : now.find((failure) => !current?.before.has(failure));
  if (current !== null && fresh !== undefined) {
    current = null;
    setRetrying(null);
    setFailedAgain(failedAgain + 1);
  } else if (current !== null && now.length === 0 && !reading) {
    current = null;
    setRetrying(null);
  }
  const seen = useRef(failedAgain);
  useEffect(() => {
    if (failedAgain > seen.current) announce(message);
    seen.current = failedAgain;
  }, [failedAgain, message]);
  const shown = fresh ?? current?.failure ?? now[0] ?? null;
  return {
    shown,
    retry: () => {
      // A second press while the retry runs keeps the failure it answers.
      if (shown !== null) setRetrying({ failure: shown, before: new Set(now) });
      start();
    },
  };
}
