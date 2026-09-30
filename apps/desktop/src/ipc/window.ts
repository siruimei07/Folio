// Window controls for the custom title bar. The main window has no native title bar
// (crates/folio-app/tauri.conf.json), so the page draws the caption buttons and the shell puts a
// native overlay on the maximize button for Windows 11 snap layouts
// (crates/folio-app/src/window_chrome.rs). Tauri's own window commands are reached only through
// this module, like every other call to the shell (CLAUDE.md §5).
import { getCurrentWindow } from '@tauri-apps/api/window';

import { type ButtonBounds, commands, events, type MaximizeButtonChanged } from './bindings';
import { type IpcError, isIpcError } from './errors';
import { hold, subscribe } from './events';

/**
 * What failed: a caption button, dragging the title bar, or `background` work the user did not
 * start (reading the maximized state, placing the snap layouts overlay).
 */
export type WindowCommand = 'minimize' | 'maximize' | 'restore' | 'close' | 'drag' | 'background';

export interface WindowFailure {
  command: WindowCommand;
  /** Where it failed, for the log: `windowControls.<function>`. */
  source: string;
  error: IpcError;
}

type FailureHandler = (failure: WindowFailure) => void;

let onFailure: FailureHandler = ({ source, error }) => {
  console.error(`${source} failed`, error);
};

/**
 * Where window command failures go (library-actions handoff §9.5). The app shows an error toast
 * and logs them; until it sets a handler they reach the console. Returns the previous handler.
 */
export function setWindowFailureHandler(handler: FailureHandler): FailureHandler {
  const previous = onFailure;
  onFailure = handler;
  return previous;
}

/** Tauri's window API rejects with the plugin's error text; our commands resolve to `IpcError`. */
function asIpcError(error: unknown): IpcError {
  if (isIpcError(error)) return error;
  return { code: 'Window', detail: error instanceof Error ? error.message : String(error) };
}

function report(command: WindowCommand, source: string) {
  return (error: unknown) => {
    onFailure({ command, source: `windowControls.${source}`, error: asIpcError(error) });
  };
}

export const windowControls = {
  minimize: (): void => {
    getCurrentWindow().minimize().catch(report('minimize', 'minimize'));
  },

  /** Maximizes or restores; `maximized` is the state now, so a failure names the right action. */
  toggleMaximize: (maximized: boolean): void => {
    getCurrentWindow()
      .toggleMaximize()
      .catch(report(maximized ? 'restore' : 'maximize', 'toggleMaximize'));
  },

  close: (): void => {
    getCurrentWindow().close().catch(report('close', 'close'));
  },

  /** Moves the window with the pointer until the button is released (Windows' own drag loop). */
  startDragging: (): void => {
    getCurrentWindow().startDragging().catch(report('drag', 'startDragging'));
  },

  /** Reports the maximized state now and after every resize. Returns the unsubscribe function. */
  watchMaximized: (onChange: (maximized: boolean) => void): (() => void) => {
    const appWindow = getCurrentWindow();
    const failed = report('background', 'watchMaximized');
    let active = true;
    const update = () => {
      appWindow.isMaximized().then((maximized) => {
        if (active) onChange(maximized);
      }, failed);
    };
    update();
    const release = hold(appWindow.onResized(update), failed);
    return () => {
      active = false;
      release();
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
    const failed = report('background', 'trackMaximizeButton');
    const send = (bounds: ButtonBounds | null) => {
      void commands.setMaximizeButtonBounds(bounds).then((result) => {
        if (result.status === 'error') failed(result.error);
      });
    };
    const measure = () => {
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
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(button);
    const stopListening = subscribe(events.maximizeButtonChanged, onChange, failed);
    return () => {
      observer.disconnect();
      stopListening();
      send(null);
    };
  },
};
