// Rendering the History view in tests: the fake shell at the data tests' time, a window wide enough
// for the panel's greatest width, and the view's preferences and store as a new computer has them.
import { act, fireEvent, screen } from '@testing-library/react';
import { beforeEach, onTestFinished, vi } from 'vitest';

import { Announcer, clearAnnouncements } from '../../app/announcer';
import { DialogHost } from '../../app/DialogHost';
import { HostedDialogs, HostedViews } from '../../app/navigation';
import { NOW } from '../../test/data';
import { renderApp, type RenderAppOptions } from '../../test/render';
import { SIZE } from '../../tokens/tokens';
import { EditMessageDialog } from '../EditMessageDialog';
import historyViewSheet from '../HistoryView.css?raw';
import { HistoryView } from '../HistoryView';
import { resetPanelWidth, setHistoryTypes } from '../preferences';
import { resetHistoryView } from '../state';

/** A window this wide leaves room for the panel at `size.history-panel-max` beside the diff. */
export const WIDE = { width: 1400, height: 800 };

/** The box elements report in a narrow window (`narrowWindow`). */
export const NARROW = { width: 680, height: 720 };

/** The window's width as the layout reads it (`app/layout.ts`), crossing the breakpoint or not. */
export function resizeWindow(to: number): void {
  act(() => {
    window.innerWidth = to;
    window.dispatchEvent(new Event('resize'));
  });
}

/** A window below `size.narrow-breakpoint` for the rest of the test; render with `layout: NARROW`. */
export function narrowWindow(): void {
  const width = window.innerWidth;
  resizeWindow(SIZE.narrowBreakpoint - 80);
  onTestFinished(() => {
    resizeWindow(width);
  });
}

/**
 * For the rest of the test, the view's stylesheet in the page and `focus()` refused to an element
 * that is not visible, as Chromium refuses it (jsdom does neither): the list under a narrow window's
 * diff (`visibility: hidden`) cannot take the focus then.
 */
export function refuseFocusWhenHidden(): void {
  const style = document.createElement('style');
  style.textContent = historyViewSheet;
  document.head.append(style);
  // eslint-disable-next-line @typescript-eslint/unbound-method -- called below with the element as `this`
  const focus = HTMLElement.prototype.focus;
  const refused = vi.spyOn(HTMLElement.prototype, 'focus').mockImplementation(function focusIfVisible(this: HTMLElement, options) {
    if (getComputedStyle(this).visibility !== 'hidden') focus.call(this, options);
  });
  onTestFinished(() => {
    refused.mockRestore();
    style.remove();
  });
}

/** Call once at the top level of a test file: every test starts with the defaults. */
export function resetHistoryPreferences(): void {
  beforeEach(() => {
    localStorage.clear();
    resetPanelWidth();
    setHistoryTypes(null);
    resetHistoryView();
  });
}

export function renderHistory(options: RenderAppOptions = {}) {
  return renderApp(<HistoryView />, { now: NOW, layout: WIDE, ...options });
}

/** The History view with the app's live regions, emptied first, which `renderHistory` does not mount. */
export function renderAnnounced(options: RenderAppOptions = {}) {
  clearAnnouncements();
  return renderApp(
    <>
      <HistoryView />
      <Announcer />
    </>,
    { now: NOW, layout: WIDE, ...options },
  );
}

export { politeText } from '../../test/render';

/** What the History view's dialog host registers: its Edit message dialog. */
const DIALOGS = { editMessage: EditMessageDialog };

/**
 * The History view as the app hosts it: the Edit message dialog registered and hosted, the Changes
 * view on the rail, so "Edit message", "Go to Changes" and "Show in Changes" show, and the app's
 * live regions, emptied first.
 */
export function renderHostedHistory(options: RenderAppOptions = {}) {
  clearAnnouncements();
  return renderApp(
    <HostedDialogs value={new Set(['editMessage'] as const)}>
      <HostedViews value={new Set(['changes', 'history'] as const)}>
        <HistoryView />
        <DialogHost dialogs={DIALOGS} />
        <Announcer />
      </HostedViews>
    </HostedDialogs>,
    { now: NOW, layout: WIDE, ...options },
  );
}

/** The feed once its first page has arrived. */
export function findFeed(): Promise<HTMLElement> {
  return screen.findByRole('feed', { name: 'History, newest first' });
}

/** The element the timeline scrolls in. */
export function timelineScroller(): HTMLElement {
  const element = document.querySelector<HTMLElement>('.timeline');
  if (element === null) throw new Error('no timeline');
  return element;
}

/**
 * Holds the answers to `command` from now until `release()`: the shell still acts at once and
 * sends its events, so what it changes is refreshed while the answer waits. `invoke` is the spy,
 * for the requests asked.
 */
export function holdAnswers(shell: ReturnType<typeof renderHistory>['shell'], command: string) {
  let release: () => void = () => undefined;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const answer = shell.invoke.bind(shell);
  const invoke = vi.spyOn(shell, 'invoke').mockImplementation(async (name, payload) => {
    if (name !== command) return answer(name, payload);
    const answered = answer(name, payload);
    // A refusal waits too, without being reported as unhandled meanwhile.
    answered.catch(() => undefined);
    await released;
    return answered;
  });
  return {
    invoke,
    release: () => {
      act(() => {
        release();
      });
    },
  };
}

/** Scrolls the timeline as the person would: the offset, then its scroll event. */
export function scrollTimelineTo(top: number): void {
  act(() => {
    timelineScroller().scrollTop = top;
    fireEvent.scroll(timelineScroller());
  });
}
