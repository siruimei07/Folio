// Theme and reduced motion on the root element (design/tokens/README.md "Modes" and "Motion";
// UI architecture §6.3). tokens.css switches every colour and duration on these attributes, so
// they must be set before the first render.
//
// Both are shell settings (App settings → Appearance), which `feat/core-app-settings` stores and
// the shell hands over before the first frame. Until then the app follows Windows: the defaults.

/** Light and Dark set `data-theme`; System removes it and follows Windows' app mode. */
export type ThemeSetting = 'system' | 'light' | 'dark';

/** On and Off set `data-reduce-motion`; "Use Windows setting" removes it. */
export type ReduceMotionSetting = 'system' | 'on' | 'off';

export interface Appearance {
  theme: ThemeSetting;
  reduceMotion: ReduceMotionSetting;
}

export const DEFAULT_APPEARANCE: Appearance = { theme: 'system', reduceMotion: 'system' };

export function applyAppearance(
  { theme, reduceMotion }: Appearance,
  root: HTMLElement = document.documentElement,
): void {
  if (theme === 'system') delete root.dataset.theme;
  else root.dataset.theme = theme;
  if (reduceMotion === 'system') delete root.dataset.reduceMotion;
  else root.dataset.reduceMotion = reduceMotion;
}
