import { act, fireEvent, render, renderHook, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ipc, LIMITS } from '../ipc';
import { TOAST_DISMISS_MS } from '../lib/timing';
import { SIZE } from '../tokens/tokens';
import { Modal } from '../components/Dialog/Dialog';
import { applyAppearance } from './appearance';
import { announce, Announcer } from './announcer';
import { currentLayout, useLayout, watchLayout } from './layout';
import { logText, reportUiError } from './log';
import {
  closeDialog,
  openDialog,
  resetNavigation,
  reveal,
  showView,
  takeRevealTarget,
  useNavigation,
} from './navigation';
import { handleShortcut, installShortcuts, registerShortcut, useShortcutLabel } from './shortcuts';
import { MAX_TOASTS, removeToast, showToast, useToasts } from './toasts';
import { ToastRegion } from './ToastRegion';

vi.mock('../ipc', { spy: true });

/** Resizes jsdom's window; the matchMedia stub in test/setup.ts follows it. */
function resizeWindow(width: number): void {
  act(() => {
    window.innerWidth = width;
    window.dispatchEvent(new Event('resize'));
  });
}

const press = (key: string, extra: Partial<KeyboardEventInit> = {}, target: EventTarget | null = document.body) => ({
  key,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  metaKey: false,
  target,
  ...extra,
});

beforeEach(() => {
  useNavigation.setState({ view: 'library', dialog: null, revealTarget: null });
  useToasts.setState({ toasts: [] });
});

describe('navigation', () => {
  it('shows views, opens one dialog at a time and hands a reveal target over once', () => {
    showView('history');
    expect(useNavigation.getState().view).toBe('history');

    openDialog('librarySettings', { page: 'tags' });
    openDialog('search');
    expect(useNavigation.getState().dialog).toEqual({ kind: 'search', params: undefined });
    closeDialog();
    expect(useNavigation.getState().dialog).toBeNull();

    const target = { id: '7', path: 'MAT232/ps2.pdf' };
    reveal(target);
    expect(useNavigation.getState().view).toBe('library');
    expect(takeRevealTarget()).toEqual(target);
    expect(takeRevealTarget()).toBeNull();
  });

  it('drops the reveal target for another library but keeps the view and dialog', () => {
    showView('history');
    openDialog('appSettings');
    reveal({ id: '7', path: 'a' });
    showView('history');
    resetNavigation();
    expect(useNavigation.getState()).toMatchObject({ view: 'history', dialog: { kind: 'appSettings' }, revealTarget: null });
  });
});

describe('shortcuts', () => {
  it('runs the newest registration of a key combination until it goes away', () => {
    const first = vi.fn();
    const second = vi.fn();
    const stopFirst = registerShortcut({ key: 'o', ctrl: true }, first);
    const stopSecond = registerShortcut({ key: 'O', ctrl: true }, second);

    expect(handleShortcut(press('o', { ctrlKey: true }))).toBe(true);
    expect(second).toHaveBeenCalledOnce();
    stopSecond();
    handleShortcut(press('o', { ctrlKey: true }));
    expect(first).toHaveBeenCalledOnce();
    stopFirst();
    expect(handleShortcut(press('o', { ctrlKey: true }))).toBe(false);
  });

  it('matches modifiers exactly', () => {
    const run = vi.fn();
    const stop = registerShortcut({ key: 's', ctrl: true, shift: true }, run);
    expect(handleShortcut(press('s', { ctrlKey: true }))).toBe(false);
    expect(handleShortcut(press('S', { ctrlKey: true, shiftKey: true }))).toBe(true);
    expect(handleShortcut(press('S', { ctrlKey: true, shiftKey: true, metaKey: true }))).toBe(false);
    stop();
  });

  it('ignores presses during IME composition', () => {
    const run = vi.fn();
    const stop = registerShortcut({ key: 'k', ctrl: true }, run, { inInputs: true });
    expect(handleShortcut(press('k', { ctrlKey: true, isComposing: true }))).toBe(false);
    expect(handleShortcut({ ...press('Process', { ctrlKey: true }), keyCode: 229 })).toBe(false);
    expect(run).not.toHaveBeenCalled();
    stop();
  });

  it('works in text fields and dialogs only when the shortcut says so', () => {
    const input = document.createElement('input');
    document.body.append(input);
    const search = vi.fn();
    const library = vi.fn();
    const stops = [
      registerShortcut({ key: 'k', ctrl: true }, search, { inInputs: true }),
      registerShortcut({ key: '1', ctrl: true }, library),
    ];
    expect(handleShortcut(press('k', { ctrlKey: true }, input))).toBe(true);
    expect(handleShortcut(press('1', { ctrlKey: true }, input))).toBe(false);

    // Any modal on screen counts, the navigation store's or a view's own confirmation.
    const { unmount } = render(
      <Modal isOpen onOpenChange={vi.fn()} aria-label="Delete MAT232?">
        <p>Sure?</p>
      </Modal>,
    );
    expect(handleShortcut(press('1', { ctrlKey: true }))).toBe(false);
    expect(handleShortcut(press('k', { ctrlKey: true }))).toBe(false);
    unmount();
    expect(handleShortcut(press('1', { ctrlKey: true }))).toBe(true);
    stops.forEach((stop) => {
      stop();
    });
    input.remove();
  });

  it('listens on the window and stops the browser from acting on handled keys', async () => {
    const run = vi.fn();
    const stopShortcut = registerShortcut({ key: 'k', ctrl: true }, run);
    const uninstall = installShortcuts();
    await userEvent.keyboard('{Control>}k{/Control}');
    expect(run).toHaveBeenCalledOnce();
    uninstall();
    await userEvent.keyboard('{Control>}k{/Control}');
    expect(run).toHaveBeenCalledOnce();
    stopShortcut();
  });

  it('prints combinations as Windows labels them', () => {
    const { result } = renderHook(() => useShortcutLabel());
    expect(result.current({ key: 'k', ctrl: true })).toBe('Ctrl+K');
    expect(result.current({ key: 's', ctrl: true, shift: true })).toBe('Ctrl+Shift+S');
    expect(result.current({ key: ',', ctrl: true })).toBe('Ctrl+,');
  });
});

describe('layout and appearance', () => {
  afterEach(() => {
    resizeWindow(1024);
    applyAppearance({ theme: 'system', reduceMotion: 'system' });
  });

  it('is narrow below the breakpoint, on the root and in components', () => {
    resizeWindow(SIZE.narrowBreakpoint);
    const stop = watchLayout();
    const { result } = renderHook(() => useLayout());
    expect(document.documentElement.dataset.layout).toBe('wide');
    expect(result.current).toBe('wide');

    resizeWindow(SIZE.narrowBreakpoint - 1);
    expect(currentLayout()).toBe('narrow');
    expect(document.documentElement.dataset.layout).toBe('narrow');
    expect(result.current).toBe('narrow');
    stop();
  });

  it('sets the theme and reduced motion on the root, and removes them for the Windows settings', () => {
    const root = document.documentElement;
    applyAppearance({ theme: 'dark', reduceMotion: 'on' });
    expect(root.dataset.theme).toBe('dark');
    expect(root.dataset.reduceMotion).toBe('on');
    applyAppearance({ theme: 'system', reduceMotion: 'system' });
    expect(root).not.toHaveAttribute('data-theme');
    expect(root).not.toHaveAttribute('data-reduce-motion');
  });
});

describe('UI error log', () => {
  it('keeps log text well formed and within the limit', () => {
    expect(logText('a\uD800b')).toBe('a�b');
    expect(logText('😀'.repeat(LIMITS.logChars + 5))).toBe('😀'.repeat(LIMITS.logChars));
  });

  it('writes errors to the console and the shell log, and only the console for a bad source', () => {
    vi.mocked(ipc.logUiError).mockResolvedValue({ status: 'ok', data: null });
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    reportUiError('command', 'windowControls.minimize', { code: 'Window', detail: 'denied' });
    expect(ipc.logUiError).toHaveBeenCalledWith({
      kind: 'command',
      source: 'windowControls.minimize',
      message: 'Window: denied',
      stack: null,
    });
    reportUiError('uncaught', 'a source with spaces', new Error('boom'));
    expect(ipc.logUiError).toHaveBeenCalledOnce();
    expect(consoleError).toHaveBeenCalled();
  });

  it('says on the console when the log cannot be written, and nothing more', async () => {
    vi.mocked(ipc.logUiError).mockResolvedValue({ status: 'error', error: { code: 'DiskFull', detail: 'full' } });
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    reportUiError('boundary', 'view.library', new Error('boom'), '\n    in Library');
    await vi.waitFor(() => {
      expect(consoleError).toHaveBeenCalledWith('writing the UI error to the log failed', expect.anything());
    });
    expect(vi.mocked(ipc.logUiError).mock.calls[0]?.[0].stack).toContain('in Library');
  });
});

describe('announcer', () => {
  it('reads messages in polite and assertive live regions', () => {
    const { container } = render(<Announcer />);
    act(() => {
      announce('Synced 2 commits to iCloud');
      announce('Sync failed', 'assertive');
    });
    expect(container.querySelector('[aria-live="polite"]')).toHaveTextContent('Synced 2 commits to iCloud');
    expect(container.querySelector('[aria-live="assertive"]')).toHaveTextContent('Sync failed');
  });
});

describe('toasts', () => {
  it('keeps at most three, replaces one with the same key, and fades removed ones out', () => {
    for (let index = 1; index <= MAX_TOASTS + 1; index += 1) showToast({ tone: 'warning', title: `Toast ${String(index)}` });
    expect(useToasts.getState().toasts.map(({ title }) => title)).toEqual(['Toast 2', 'Toast 3', 'Toast 4']);

    showToast({ key: 'job', tone: 'progress', title: 'Adding files', progress: 10 });
    showToast({ key: 'job', tone: 'progress', title: 'Adding files', progress: 60 });
    const jobs = useToasts.getState().toasts.filter(({ key }) => key === 'job');
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.progress).toBe(60);

    removeToast('job');
    expect(useToasts.getState().toasts.find(({ key }) => key === 'job')?.leaving).toBe(true);
  });

  it('closes success and information after 6 s unless held, and keeps warnings', async () => {
    vi.useFakeTimers();
    try {
      render(<ToastRegion />);
      expect(screen.getByRole('region', { name: 'Notifications' })).toBeInTheDocument();
      act(() => {
        showToast({ tone: 'success', title: 'Copied the path' });
        showToast({ tone: 'warning', title: 'Deleted 2 of 3 items' });
      });
      act(() => {
        vi.advanceTimersByTime(TOAST_DISMISS_MS);
      });
      // jsdom runs no animations, so a fading toast goes at once.
      await act(async () => {
        await vi.runAllTimersAsync();
      });
      expect(screen.queryByText('Copied the path')).not.toBeInTheDocument();
      expect(screen.getByText('Deleted 2 of 3 items')).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('waits while the pointer rests on a toast', async () => {
    vi.useFakeTimers();
    try {
      render(<ToastRegion />);
      act(() => {
        showToast({ tone: 'info', title: 'Copied the path' });
      });
      const toast = screen.getByRole('status');
      fireEvent.pointerEnter(toast);
      act(() => {
        vi.advanceTimersByTime(TOAST_DISMISS_MS * 2);
      });
      expect(screen.getByText('Copied the path')).toBeInTheDocument();
      fireEvent.pointerLeave(toast);
      act(() => {
        vi.advanceTimersByTime(TOAST_DISMISS_MS);
      });
      await act(async () => {
        await vi.runAllTimersAsync();
      });
      expect(screen.queryByText('Copied the path')).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('closes a toast from its close button and tells the caller', async () => {
    const onDismiss = vi.fn();
    render(<ToastRegion />);
    act(() => {
      showToast({ tone: 'danger', title: "Couldn't close Folio", onDismiss });
    });
    await userEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(onDismiss).toHaveBeenCalledOnce();
    await vi.waitFor(() => {
      expect(screen.queryByText("Couldn't close Folio")).not.toBeInTheDocument();
    });
  });
});
