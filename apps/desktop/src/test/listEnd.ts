// The end of a list that loads a page more when its end comes into view (the problems list's
// sentinel, React Aria's "load more" item in search). Both watch it with an IntersectionObserver,
// which jsdom lacks: src/test/setup.ts stubs a silent one. `fakeListEnd` stubs one that remembers
// its watchers and behaves as the real one does where paging depends on it:
//
// - `reach` scrolls to the end: every watcher reports the end in view.
// - The end then stays in view until rows are added above it: a list that starts watching anew
//   while it holds as many rows reports at once, as a real observer does when it starts watching
//   (reaching the end just before the list watches it anew still counts).
// - `fit` makes the whole list fit, so its end is in view whatever the list holds.
// - `watches` counts the watchers started, so a test can tell whether it reached the end before
//   the list watched it anew.
//
//   const listEnd = fakeListEnd(() => document.querySelectorAll('.problems__row').length);
//   listEnd.reach();
import { act } from '@testing-library/react';
import { beforeEach, vi } from 'vitest';

function inView(callback: IntersectionObserverCallback): void {
  callback([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver);
}

/**
 * Call once at the top level of a test file: it resets in a `beforeEach`. `rows` counts the rows
 * the list holds.
 */
export function fakeListEnd(rows: () => number) {
  const watchers = new Set<IntersectionObserverCallback>();
  let fits = false;
  /** How many rows the list held when it was last scrolled to its end. */
  let reachedAt: number | null = null;
  /** Watchers started in this test. */
  let started = 0;
  beforeEach(() => {
    fits = false;
    reachedAt = null;
    started = 0;
  });

  vi.stubGlobal(
    'IntersectionObserver',
    class {
      constructor(private readonly callback: IntersectionObserverCallback) {}
      observe() {
        started++;
        watchers.add(this.callback);
        if (fits || (reachedAt !== null && reachedAt === rows())) inView(this.callback);
      }
      unobserve() {
        // Watchers watch one element each: `disconnect` ends them.
      }
      disconnect() {
        watchers.delete(this.callback);
      }
    },
  );

  /** `reach` outside `act`, so React's pending work stays pending (a scroll in mid-commit). */
  const reachNow = () => {
    reachedAt = rows();
    for (const callback of [...watchers]) inView(callback);
  };
  return {
    reach: () => {
      act(reachNow);
    },
    reachNow,
    /** From now until the test ends. */
    fit: () => {
      fits = true;
    },
    /** How many times the list has started watching its end in this test. */
    watches: () => started,
  };
}
