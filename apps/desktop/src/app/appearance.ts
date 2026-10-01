// Theme and reduce motion on the root element (design/tokens/README.md "Modes" and "Motion";
// UI architecture §6.3). tokens.css switches every colour and duration on these attributes, so
// they must be set before the first render.
//
// Both are App settings → Appearance, which the shell stores (ipc-m1 §22): `startAppearance`
// applies the stored choice before the first render and every change after it. The shell has
// already painted the window background in the stored theme, so the first frame matches.

import { type AppSettings, ipc, shellEvents } from '../ipc';
import { reportUiError } from './log';

/**
 * Light and Dark set `data-theme`, System removes it and follows Windows' app mode; On and Off
 * set `data-reduce-motion`, "Use Windows setting" removes it.
 */
export type Appearance = Pick<AppSettings, 'theme' | 'reduceMotion'>;

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

/**
 * Applies the stored appearance, then every `AppSettingsChanged`, until the returned function
 * runs. When the shell cannot read the settings, Windows' own settings apply and the log has why.
 */
export async function startAppearance(
  root: HTMLElement = document.documentElement,
): Promise<() => void> {
  // Subscribed first, so a change made while the settings load is not lost; that change is
  // newer than what the load returns.
  const change = { seen: false };
  const stop = shellEvents.onAppSettingsChanged(({ settings }) => {
    change.seen = true;
    applyAppearance(settings, root);
  });
  const stored = await ipc.getAppSettings();
  if (!change.seen) {
    if (stored.status === 'ok') {
      applyAppearance(stored.data, root);
    } else {
      applyAppearance(DEFAULT_APPEARANCE, root);
      reportUiError('command', 'appearance.load', stored.error);
    }
  }
  return stop;
}
