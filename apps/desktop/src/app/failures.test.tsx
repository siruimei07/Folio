import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import shell from '../i18n/locales/en/shell.json';
import { ipc } from '../ipc';
import { ErrorBoundary } from './ErrorBoundary';
import { useToasts } from './toasts';
import { ToastRegion } from './ToastRegion';
import { resetWindowFailures, showWindowFailure } from './windowErrors';

vi.mock('../ipc', { spy: true });

beforeEach(() => {
  useToasts.setState({ toasts: [] });
  resetWindowFailures();
  vi.mocked(ipc.logUiError).mockResolvedValue({ status: 'ok', data: null });
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

const failure = { code: 'Window' as const, detail: 'window.minimize not allowed' };

describe('failed window commands', () => {
  it('shows an error toast with the command words and logs the failure', () => {
    render(<ToastRegion />);
    act(() => {
      showWindowFailure({ command: 'minimize', source: 'windowControls.minimize', error: failure });
    });
    const toast = screen.getByRole('alert');
    expect(toast).toHaveTextContent(shell.windowErrors.minimize.title);
    expect(toast).toHaveTextContent(shell.windowErrors.minimize.text);
    expect(ipc.logUiError).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'command', source: 'windowControls.minimize' }),
    );
  });

  it('replaces the earlier toast of the same command', () => {
    render(<ToastRegion />);
    act(() => {
      showWindowFailure({ command: 'close', source: 'windowControls.close', error: failure });
      showWindowFailure({ command: 'close', source: 'windowControls.close', error: failure });
      showWindowFailure({ command: 'drag', source: 'windowControls.startDragging', error: failure });
    });
    expect(screen.getAllByRole('alert').map((toast) => toast.querySelector('.toast__title')?.textContent)).toEqual([
      shell.windowErrors.close.title,
      shell.windowErrors.drag.title,
    ]);
  });

  it('shows the background failure once per session', () => {
    render(<ToastRegion />);
    act(() => {
      showWindowFailure({ command: 'background', source: 'windowControls.watchMaximized', error: failure });
    });
    act(() => {
      useToasts.setState({ toasts: [] });
      showWindowFailure({ command: 'background', source: 'windowControls.trackMaximizeButton', error: failure });
    });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(ipc.logUiError).toHaveBeenCalledTimes(2);
  });

  it('copies the details for a bug report', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    render(<ToastRegion />);
    act(() => {
      showWindowFailure({ command: 'maximize', source: 'windowControls.toggleMaximize', error: failure });
    });
    await userEvent.click(screen.getByRole('button', { name: shell.copyDetails.action }));
    expect(writeText).toHaveBeenCalledWith(
      `${shell.windowErrors.maximize.title}\nwindowControls.toggleMaximize\nWindow: window.minimize not allowed`,
    );
    expect(await screen.findByText(shell.copyDetails.copied)).toBeInTheDocument();
  });

  it('says when the clipboard refuses the details', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: vi.fn().mockRejectedValue(new Error('denied')) },
      configurable: true,
    });
    render(<ToastRegion />);
    act(() => {
      showWindowFailure({ command: 'maximize', source: 'windowControls.toggleMaximize', error: failure });
    });
    await userEvent.click(screen.getByRole('button', { name: shell.copyDetails.action }));
    expect(await screen.findByText(shell.copyDetails.failed)).toBeInTheDocument();
  });
});

function Bomb({ explode }: { explode: boolean }) {
  if (explode) throw new Error('view crashed');
  return <p>Library ready</p>;
}

describe('ErrorBoundary', () => {
  it('shows that the view stopped working, and reloads it from scratch', async () => {
    function Host() {
      const [explode, setExplode] = useState(true);
      return (
        <>
          <button
            type="button"
            onClick={() => {
              setExplode(false);
            }}
          >
            Fix
          </button>
          <ErrorBoundary source="view.library">
            <Bomb explode={explode} />
          </ErrorBoundary>
        </>
      );
    }
    render(<Host />);
    expect(screen.getByRole('heading', { name: shell.viewError.title })).toBeInTheDocument();
    expect(screen.getByText(shell.viewError.text)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Fix' }));
    await userEvent.click(screen.getByRole('button', { name: shell.viewError.reload }));
    expect(screen.getByText('Library ready')).toBeInTheDocument();
  });

  it('names the preview when the preview stopped working', () => {
    render(
      <ErrorBoundary source="preview" kind="preview">
        <Bomb explode />
      </ErrorBoundary>,
    );
    expect(screen.getByRole('heading', { name: shell.viewError.previewTitle })).toBeInTheDocument();
  });
});
