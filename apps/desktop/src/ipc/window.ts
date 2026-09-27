// Window controls for the custom title bar. The main window has no native title bar
// (crates/folio-app/tauri.conf.json), so the page draws the caption buttons and the shell puts a
// native overlay on the maximize button for Windows 11 snap layouts
// (crates/folio-app/src/window_chrome.rs). Tauri's own window commands are reached only through
// this module, like every other call to the shell (CLAUDE.md §5).
import { getCurrentWindow } from '@tauri-apps/api/window';

import { type ButtonBounds, commands, events, type MaximizeButtonChanged } from './bindings';

/** A failed window command means a missing permission: a bug, reported to the console. */
function reportError(error: unknown): void {
  console.error('window command failed', error);
}

/** Stops a Tauri listener once its registration has resolved. */
function release(unlisten: Promise<() => void>): void {
  unlisten.then((stop) => {
    stop();
  }, reportError);
}

export const windowControls = {
  minimize: (): void => {
    getCurrentWindow().minimize().catch(reportError);
  },

  toggleMaximize: (): void => {
    getCurrentWindow().toggleMaximize().catch(reportError);
  },

  close: (): void => {
    getCurrentWindow().close().catch(reportError);
  },

  /** Reports the maximized state now and after every resize. Returns the unsubscribe function. */
  watchMaximized: (onChange: (maximized: boolean) => void): (() => void) => {
    const appWindow = getCurrentWindow();
    const update = () => {
      appWindow.isMaximized().then(onChange, reportError);
    };
    update();
    const unlisten = appWindow.onResized(update);
    return () => {
      release(unlisten);
    };
  },

  /**
   * Keeps the shell's snap layouts overlay over `button`, and reports the hover and press state
   * the overlay sees: the page gets no pointer events on that button. The overlay is hidden while
   * the button has no box, and when the returned unsubscribe function runs.
   *
   * The bounds are measured from the right edge, which the shell follows on every window resize,
   * so only a change of the button's own size needs a new report. That holds while the title bar
   * stays at the top of a page that never scrolls as a whole.
   */
  trackMaximizeButton: (
    button: HTMLElement,
    onChange: (state: MaximizeButtonChanged) => void,
  ): (() => void) => {
    const send = (bounds: ButtonBounds | null) => {
      void commands.setMaximizeButtonBounds(bounds).then((result) => {
        if (result.status === 'error') reportError(result.error);
      });
    };
    const report = () => {
      const rect = button.getBoundingClientRect();
      const width = Math.round(rect.width);
      const height = Math.round(rect.height);
      send(
        width > 0 && height > 0
          ? {
              right: Math.max(0, Math.round(window.innerWidth - rect.right)),
              top: Math.max(0, Math.round(rect.top)),
              width,
              height,
            }
          : null,
      );
    };
    report();
    const observer = new ResizeObserver(report);
    observer.observe(button);
    const unlisten = events.maximizeButtonChanged.listen((event) => {
      onChange(event.payload);
    });
    return () => {
      observer.disconnect();
      release(unlisten);
      send(null);
    };
  },
};
