import '../components/motion.css';
import './first-run.css';

import { type ReactNode, type RefObject, useEffect, useLayoutEffect } from 'react';
import { useTranslation } from 'react-i18next';

import { TitleBar } from '../titlebar/TitleBar';

export interface FrameProps {
  /** The window title ("Welcome to Folio", "Start a new library — Folio"); `null`: "Folio". */
  windowTitle: string | null;
  /** What gets focus when the page shows (handoff §9), so screen readers announce it. */
  focus?: RefObject<HTMLElement | null>;
  /** welcome: the split body; step: the centred column; state: the centred full-window state. */
  layout: 'welcome' | 'step' | 'state';
  /** Waiting for the shell: the page ignores input (§4.4). */
  busy?: boolean;
  children?: ReactNode;
}

/**
 * A first-run page (first-run handoff §2–§7): the title bar alone, no toolbar or rail since no
 * library is open, then the page. Each page sets the window title and moves focus, so the
 * change of page is announced.
 */
export function Frame({ windowTitle, focus, layout, busy = false, children }: FrameProps) {
  const { t } = useTranslation('common');
  const title = windowTitle ?? t('app.name');

  useEffect(() => {
    document.title = title;
  }, [title]);
  useEffect(
    () => () => {
      document.title = t('app.name');
    },
    [t],
  );
  useLayoutEffect(() => {
    focus?.current?.focus();
  }, [focus]);

  return (
    <div className="first-run">
      <TitleBar />
      <main className="first-run__body" data-layout={layout} aria-busy={busy || undefined}>
        {children}
      </main>
    </div>
  );
}
