// Wide or narrow window (app-shell handoff §2; UI architecture §6.3). Media queries cannot read
// custom properties, so the breakpoint comes from the generated token constants. The layout is
// also an attribute on the root element, so stylesheets select on `[data-layout='narrow']`.

import { useSyncExternalStore } from 'react';

import { SIZE } from '../tokens/tokens';

export type Layout = 'wide' | 'narrow';

/** A media query for `useSyncExternalStore`: whether it matches, and its changes. */
export interface WindowQuery {
  subscribe: (onChange: () => void) => () => void;
  matches: () => boolean;
}

/** One query list for `query`, made on first use, then kept. */
export function windowQuery(query: string): WindowQuery {
  let list: MediaQueryList | undefined;
  const listOf = () => (list ??= window.matchMedia(query));
  return {
    subscribe: (onChange) => {
      const current = listOf();
      current.addEventListener('change', onChange);
      return () => {
        current.removeEventListener('change', onChange);
      };
    },
    matches: () => listOf().matches,
  };
}

/** The whole app's layout: narrow below `size.narrow-breakpoint` (760 px). */
const narrow = windowQuery(`(width < ${String(SIZE.narrowBreakpoint)}px)`);

export function currentLayout(): Layout {
  return narrow.matches() ? 'narrow' : 'wide';
}

/** The layout now, re-rendering when the window crosses the breakpoint. */
export function useLayout(): Layout {
  return useSyncExternalStore(narrow.subscribe, currentLayout);
}

/**
 * Keeps `data-layout` on `root` in step with the window until the returned function runs. Call it
 * before the first render, so the first frame already has the right layout.
 */
export function watchLayout(root: HTMLElement = document.documentElement): () => void {
  const apply = () => {
    root.dataset.layout = currentLayout();
  };
  apply();
  return narrow.subscribe(apply);
}
