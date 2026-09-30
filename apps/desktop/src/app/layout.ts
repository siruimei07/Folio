// Wide or narrow window (app-shell handoff §2; UI architecture §6.3). Media queries cannot read
// custom properties, so the breakpoint comes from the generated token constants. The layout is
// also an attribute on the root element, so stylesheets select on `[data-layout='narrow']`.

import { useSyncExternalStore } from 'react';

import { SIZE } from '../tokens/tokens';

export type Layout = 'wide' | 'narrow';

let narrowQuery: MediaQueryList | undefined;

/** One query list for the whole app, narrow below `size.narrow-breakpoint` (760 px). */
function narrow(): MediaQueryList {
  narrowQuery ??= window.matchMedia(`(width < ${String(SIZE.narrowBreakpoint)}px)`);
  return narrowQuery;
}

export function currentLayout(): Layout {
  return narrow().matches ? 'narrow' : 'wide';
}

function subscribe(onChange: () => void): () => void {
  const list = narrow();
  list.addEventListener('change', onChange);
  return () => {
    list.removeEventListener('change', onChange);
  };
}

/** The layout now, re-rendering when the window crosses the breakpoint. */
export function useLayout(): Layout {
  return useSyncExternalStore(subscribe, currentLayout);
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
  return subscribe(apply);
}
