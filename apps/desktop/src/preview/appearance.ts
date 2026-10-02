// The theme and reduced motion the window shows, for the frame (UI architecture §10.2): App
// settings can differ from Windows' (`app/appearance.ts` sets them on the root), and the frame
// cannot see the window's root, so it gets them in its messages.

import { useSyncExternalStore } from 'react';

import type { Appearance } from './protocol';

let queries: { dark: MediaQueryList; reduce: MediaQueryList } | undefined;

function media() {
  queries ??= {
    dark: window.matchMedia('(prefers-color-scheme: dark)'),
    reduce: window.matchMedia('(prefers-reduced-motion: reduce)'),
  };
  return queries;
}

/** What the root's attributes say, else Windows' setting, as `tokens.css` reads them. */
function isDark(): boolean {
  const { theme } = document.documentElement.dataset;
  return theme === 'dark' || (theme !== 'light' && media().dark.matches);
}

function reducesMotion(): boolean {
  const { reduceMotion } = document.documentElement.dataset;
  return reduceMotion === 'on' || (reduceMotion !== 'off' && media().reduce.matches);
}

function subscribe(onChange: () => void): () => void {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributeFilter: ['data-theme', 'data-reduce-motion'] });
  const { dark, reduce } = media();
  for (const query of [dark, reduce]) query.addEventListener('change', onChange);
  return () => {
    observer.disconnect();
    for (const query of [dark, reduce]) query.removeEventListener('change', onChange);
  };
}

/** The window's theme and reduced motion, updated when either changes. */
export function useFrameAppearance(): Appearance {
  const dark = useSyncExternalStore(subscribe, isDark);
  const reduceMotion = useSyncExternalStore(subscribe, reducesMotion);
  return { theme: dark ? 'dark' : 'light', reduceMotion };
}
