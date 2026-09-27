import './TitleBar.css';

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { type MaximizeButtonChanged, windowControls } from '../ipc';

// Segoe Fluent Icons caption glyphs (ChromeMinimize, ChromeMaximize, ChromeRestore, ChromeClose):
// the ones Windows 11 draws its own caption buttons with.
const GLYPHS = {
  minimize: '\u{E921}',
  maximize: '\u{E922}',
  restore: '\u{E923}',
  close: '\u{E8BB}',
};

/**
 * Title bar of the frameless main window (ADR-0001, spike 4b). The mechanics are final; the look
 * is a placeholder until the design handoff.
 */
export function TitleBar() {
  const { t } = useTranslation();
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

  return (
    <header className="title-bar">
      <div className="title-bar__drag" data-tauri-drag-region>
        {t('app.name')}
      </div>
      <div className="title-bar__controls">
        <button
          type="button"
          className="title-bar__button"
          aria-label={t('titleBar.minimize')}
          onClick={windowControls.minimize}
        >
          <span aria-hidden="true">{GLYPHS.minimize}</span>
        </button>
        {/* The shell's snap layouts overlay covers this button and reports hover and press. */}
        <button
          ref={maximizeButton}
          type="button"
          className="title-bar__button"
          aria-label={t(maximized ? 'titleBar.restore' : 'titleBar.maximize')}
          data-hovered={pointer.hovered || undefined}
          data-pressed={pointer.pressed || undefined}
          onClick={windowControls.toggleMaximize}
        >
          <span aria-hidden="true">{maximized ? GLYPHS.restore : GLYPHS.maximize}</span>
        </button>
        <button
          type="button"
          className="title-bar__button title-bar__button--close"
          aria-label={t('titleBar.close')}
          onClick={windowControls.close}
        >
          <span aria-hidden="true">{GLYPHS.close}</span>
        </button>
      </div>
    </header>
  );
}
