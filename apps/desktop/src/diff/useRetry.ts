// "Try again" for a failure that can still show when the read settles (WCAG 4.1.3): a refresh banner
// over the last answer, a file that is still unreadable, a block or row whose read fails again.
// The button keeps the focus while the read runs (a block or row that goes leaves it to the diff,
// `useFocusKeeper`), so nothing on screen changes when the failure stays: the failure is read again
// instead, as the library's Unavailable page reads its title again (`useRetryAnnouncement`).
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

import { announce } from '../app/announcer';

/** Where a read stands, as `useRetry` follows it. */
export interface RetriedRead {
  /** Changes each time the read settles, with an answer or a failure (`DiffWindowAnswer.settled`). */
  settled: string;
  /** A fetch is under way. */
  fetching: boolean;
  /** The failure "Try again" answers still shows. */
  failing: boolean;
}

interface RetryState {
  id: string;
  /** `settled` when "Try again" was pressed, until the read settles again; `null` when no retry runs. */
  from: string | null;
  failedAgain: number;
}

export interface Retry {
  /** Reads again. */
  retry: () => void;
  /**
   * How many retries settled with the failure still showing. It grows in the render that shows the
   * result, so a failure that stays reads its title again and one that comes back reads it once.
   */
  failedAgain: number;
}

/** "Try again" through `start`, followed until the read settles. Another `id` (another change) starts afresh. */
export function useRetry(id: string, read: RetriedRead, start: () => void): Retry {
  const [state, setState] = useState<RetryState>({ id, from: null, failedAgain: 0 });
  let current = state;
  if (current.id !== id) {
    current = { id, from: null, failedAgain: 0 };
    setState(current);
  } else if (current.from !== null && !read.fetching && read.settled !== current.from) {
    current = { id, from: null, failedAgain: current.failedAgain + (read.failing ? 1 : 0) };
    setState(current);
  }
  const settled = useRef(read.settled);
  useLayoutEffect(() => {
    settled.current = read.settled;
  });
  const retry = useCallback(() => {
    setState((previous) => (previous.id === id ? { ...previous, from: settled.current } : previous));
    start();
  }, [id, start]);
  return { retry, failedAgain: current.failedAgain };
}

/**
 * Reads `message` each time `failedAgain` grows, unless `quiet` (another part reads it), and when the
 * failure first shows with `onAppear`. An effect that runs again reads nothing: `<Activity>` showing
 * the diff again after "This version", a count that starts afresh for other content.
 */
export function useRetryAnnouncement(
  message: string,
  failedAgain: number,
  { onAppear = false, quiet = false }: { onAppear?: boolean; quiet?: boolean } = {},
): void {
  // The count last seen; `null` until the failure has shown.
  const seen = useRef<number | null>(null);
  useEffect(() => {
    const last = seen.current;
    seen.current = failedAgain;
    if (last === null ? onAppear : failedAgain > last && !quiet) announce(message);
  }, [message, failedAgain, onAppear, quiet]);
}
