// View tests against the fake shell (docs/specs/ui-architecture.md §11.3): a fresh query client,
// the app's providers, and a fake shell with a fixture. Small components keep `vi.mock('../ipc')`.
//
//   const { user, shell } = renderApp(<LibraryView />, { scenario: 'small' });
//   shell.setFailure('list_children', 'Internal');
//
//   const { result, rerender } = renderAppHook((range) => useChildren(null, sort, range), {
//     initialProps: { start: 0, end: 20 },
//   });
import { mockIPC } from '@tauri-apps/api/mocks';
import { act, render, renderHook } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import type { ReactElement, ReactNode } from 'react';
import { I18nProvider } from 'react-aria-components';
import { onTestFinished, vi } from 'vitest';

import { useToasts } from '../app/toasts';
import { createQueryClient } from '../data/client';
import { DataProvider } from '../data/DataProvider';
import { changeLibrary } from '../data/library';
import { useSession } from '../data/session';
import { type Fixture, installFakeShell, type Scenario, scenarioFixture } from '../ipc/mock';
import type { Failure, FakeShellOptions } from '../ipc/mock/shell';
import { mockLayout, type Size, TEST_VIEWPORT } from './virtual';

export interface RenderAppOptions
  extends Partial<Omit<FakeShellOptions, 'fixture' | 'failures' | 'now'>> {
  /** A named starting state (default `small`); `fixture` replaces it. */
  scenario?: Scenario;
  fixture?: Fixture;
  /** Commands that fail with a code, besides the scenario's own. */
  fail?: Failure[];
  /**
   * The time fixtures count from, new entries get and `Date` starts at (it keeps running); defaults
   * to the clock at render.
   */
  now?: number;
  /** The box every element reports, so virtualised lists render rows; `false` keeps jsdom's 0 × 0. */
  layout?: Size | false;
}

/** The shared setup's stand-in shell (src/test/setup.ts): every command answers with nothing. */
export function restoreStandInShell(): void {
  delete window.__FOLIO_FAKE_SHELL__;
  mockIPC(() => undefined, { shouldMockEvents: true });
}

/**
 * Starts the page's clock at `now` until the test ends, so dates the UI works out ("Recently
 * added") match the fixtures. Only `Date` is faked and it keeps running, so timers and elapsed
 * times behave as with the real clock; a test's own fake timers only move to `now`.
 */
function startClockAt(now: number): void {
  if (vi.isFakeTimers()) {
    vi.setSystemTime(now);
    return;
  }
  vi.useFakeTimers({ toFake: ['Date'], now, shouldAdvanceTime: true });
  onTestFinished(() => {
    vi.useRealTimers();
  });
}

/** The fake shell, a query client and the providers; everything is undone when the test ends. */
function setUpApp({ scenario, fixture, fail = [], now: start, layout, ...options }: RenderAppOptions) {
  if (start !== undefined) startClockAt(start);
  const now = start ?? Date.now();
  const named = fixture ? { fixture, failures: [] } : scenarioFixture(scenario ?? 'small', now);
  const shell = installFakeShell({
    ...options,
    fixture: named.fixture,
    failures: [...named.failures, ...fail],
    now: () => now,
    // Short steps, so a job finishes within `findBy…` / `waitFor` timeouts.
    jobStepMs: options.jobStepMs ?? 5,
  });

  // Page queries keep their own `gcTime` (`data/paged.ts`); `client.clear()` below ends them.
  const client = createQueryClient();
  client.setDefaultOptions({
    ...client.getDefaultOptions(),
    queries: { ...client.getDefaultOptions().queries, gcTime: Infinity },
  });
  // The app has asked `library_status` by the time a view renders.
  useSession.setState({ semesters: {} });
  changeLibrary(client, shell.status());

  const restoreLayout = layout === false ? () => undefined : mockLayout(layout ?? TEST_VIEWPORT);
  onTestFinished(() => {
    shell.dispose();
    client.clear();
    restoreLayout();
    restoreStandInShell();
  });

  function Providers({ children }: { children: ReactNode }) {
    return (
      <DataProvider client={client}>
        <I18nProvider locale="en">{children}</I18nProvider>
      </DataProvider>
    );
  }
  return { shell, client, wrapper: Providers };
}

/** Renders `ui` as the app would, against a fake shell. `rerender` keeps the providers. */
export function renderApp(ui: ReactElement, options: RenderAppOptions = {}) {
  const { shell, client, wrapper } = setUpApp(options);
  return { ...render(ui, { wrapper }), shell, client, user: userEvent.setup() };
}

/**
 * `renderApp` for a hook: `result.current` is what it returned at the latest render. Query results
 * re-render only for the properties read during render, so read in the hook what the test checks.
 */
export function renderAppHook<Result, Props = undefined>(
  hook: (props: Props) => Result,
  options: RenderAppOptions & { initialProps?: Props } = {},
) {
  const { initialProps, ...appOptions } = options;
  const { shell, client, wrapper } = setUpApp(appOptions);
  const rendered = renderHook(hook, { wrapper, initialProps: initialProps as Props });
  return { ...rendered, shell, client };
}

/** The texts of the toasts on screen. */
export function toastTexts(): string[] {
  return useToasts.getState().toasts.filter((toast) => !toast.leaving).map((toast) => [toast.title, toast.body].filter(Boolean).join(' — '));
}

/** Lets the focus keepers, which act once the DOM has changed, have their turn. */
export async function settle(): Promise<void> {
  await act(() => new Promise((resolve) => setTimeout(resolve, 50)));
}

/**
 * What the app's polite live region (`app/announcer.tsx`, mounted by the test) says now. React Aria's
 * own announcer, which its first announcement puts first in the page and leaves there for the rest
 * of the file, also has `[data-live-announcer]` and a polite log, but no `aria-atomic`.
 */
export function politeText(): string {
  return document.querySelector('[data-live-announcer] > [aria-live="polite"][aria-atomic="true"]')?.textContent ?? '';
}
