// First-run tests against the fake shell: the start gate around a stand-in for the Library view,
// with the toasts and the live regions, and every store the flow touches reset.
import { screen } from '@testing-library/react';
import { onTestFinished } from 'vitest';

import { Announcer } from '../../app/announcer';
import { useNavigation } from '../../app/navigation';
import { ToastRegion } from '../../app/ToastRegion';
import { useToasts } from '../../app/toasts';
import { NOW } from '../../test/data';
import { renderApp, type RenderAppOptions } from '../../test/render';
import { StartGate } from '../StartGate';
import { endFlow } from '../../app/startFlow';

/** What the gate shows once a library is open, in place of the Library view. */
export const LIBRARY_VIEW = 'The Library view';

export function renderStart(options: RenderAppOptions = {}) {
  useToasts.setState({ toasts: [] });
  useNavigation.setState({ view: 'library', dialog: null, revealTarget: null });
  endFlow();
  onTestFinished(() => {
    endFlow();
  });
  return renderApp(
    <>
      <StartGate>
        <p>{LIBRARY_VIEW}</p>
      </StartGate>
      <ToastRegion />
      <Announcer />
    </>,
    { now: NOW, ...options },
  );
}

/** The page's title: its one top-level heading. */
export function pageHeading(): HTMLElement {
  return screen.getByRole('heading', { level: 1 });
}

export { toastTexts } from '../../test/render';
