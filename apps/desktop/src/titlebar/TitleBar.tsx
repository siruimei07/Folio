import './TitleBar.css';

import { type MouseEvent, type ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { TOP_LAYER_ATTRIBUTE, WINDOW_BAR_ATTRIBUTE } from '../components/Dialog/Dialog';
import { type MaximizeButtonChanged, windowControls } from '../ipc';
import { SIZE } from '../tokens/tokens';
import appMark from './app-mark.svg';

// Segoe Fluent Icons caption glyphs (ChromeMinimize, ChromeMaximize, ChromeRestore, ChromeClose):
// the ones Windows 11 draws its own caption buttons with.
const GLYPHS = {
  minimize: '\u{E921}',
  maximize: '\u{E922}',
  restore: '\u{E923}',
  close: '\u{E8BB}',
};

/** Clicks on these never move the window. */
const INTERACTIVE = 'button, a, input, select, textarea, [role="button"], [tabindex]:not([tabindex="-1"])';

export interface TitleBarProps {
  /**
   * standard: 32 px with the app mark and "Folio" (app-shell handoff §3); narrow: the 40 px bar of
   * a narrow window, which also holds the toolbar's controls (§2).
   */
  variant?: 'standard' | 'narrow';
  /** The narrow bar's controls, between the app mark and the caption buttons. */
  children?: ReactNode;
}

/**
 * Title bar of the frameless main window (ADR-0001, spike 4b). Everything but its buttons is the
 * drag region: a press moves the window, a double-click maximizes or restores it. The page starts
 * both itself instead of Tauri's drag-region script, so a failure reaches the error toast.
 */
export function TitleBar({ variant = 'standard', children }: TitleBarProps) {
  const { t } = useTranslation(['titlebar', 'common']);
  const maximizeButton = useRef<HTMLButtonElement>(null);
  const [maximized, setMaximized] = useState(false);
  const [pointer, setPointer] = useState<MaximizeButtonChanged>({
    hovered: false,
    pressed: false,
  });

  useEffect(() => windowControls.watchMaximized(setMaximized), []);
  useLayoutEffect(() => {
    const button = maximizeButton.current;
    return button ? windowControls.trackMaximizeButton(button, setPointer) : undefined;
  }, []);
  // Before paint, so the bar and every scrim below it take their height from the same variant.
  useLayoutEffect(() => {
    const root = document.documentElement;
    root.dataset.windowBar = variant;
    return () => {
      delete root.dataset.windowBar;
    };
  }, [variant]);

  const onMouseDown = (event: MouseEvent<HTMLElement>) => {
    if (event.button !== 0 || !(event.target instanceof Element)) return;
    if (event.target.closest(INTERACTIVE)) return;
    // No text cursor or selection while dragging.
    event.preventDefault();
    if (event.detail === 2) windowControls.toggleMaximize(maximized);
    else if (event.detail === 1) windowControls.startDragging();
  };

  return (
    <header
      className="title-bar"
      data-variant={variant}
      {...{ [WINDOW_BAR_ATTRIBUTE]: '' }}
      onMouseDown={onMouseDown}
    >
      <span className="title-bar__mark">
        <img src={appMark} alt="" width={SIZE.icon} height={SIZE.icon} draggable={false} />
      </span>
      {variant === 'standard' ? (
        <span className="title-bar__title">{t('common:app.name')}</span>
      ) : (
        <div className="title-bar__content">{children}</div>
      )}
      {/* Usable over dialogs, which make the rest of the window inert. */}
      <div className="title-bar__controls" {...{ [TOP_LAYER_ATTRIBUTE]: '' }}>
        <button
          type="button"
          className="title-bar__button"
          aria-label={t('minimize')}
          onClick={windowControls.minimize}
        >
          <span aria-hidden="true">{GLYPHS.minimize}</span>
        </button>
        {/* The shell's snap layouts overlay covers this button and reports hover and press. */}
        <button
          ref={maximizeButton}
          type="button"
          className="title-bar__button"
          aria-label={t(maximized ? 'restore' : 'maximize')}
          data-hovered={pointer.hovered || undefined}
          data-pressed={pointer.pressed || undefined}
          onClick={() => {
            windowControls.toggleMaximize(maximized);
          }}
        >
          <span aria-hidden="true">{maximized ? GLYPHS.restore : GLYPHS.maximize}</span>
        </button>
        <button
          type="button"
          className="title-bar__button title-bar__button--close"
          aria-label={t('close')}
          onClick={windowControls.close}
        >
          <span aria-hidden="true">{GLYPHS.close}</span>
        </button>
      </div>
    </header>
  );
}
