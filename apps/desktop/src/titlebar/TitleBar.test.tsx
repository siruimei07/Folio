import { emit } from '@tauri-apps/api/event';
import { mockIPC } from '@tauri-apps/api/mocks';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import titlebar from '../i18n/locales/en/titlebar.json';
import { TitleBar } from './TitleBar';

/**
 * Scripts the shell and records every command the page sends to it, and the bounds it sends for
 * the snap layouts overlay.
 */
function mockShell({ maximized = false } = {}) {
  const commands: string[] = [];
  const bounds: unknown[] = [];
  mockIPC(
    (command, args) => {
      commands.push(command);
      if (command === 'set_maximize_button_bounds') {
        bounds.push((args as { bounds: unknown }).bounds);
      }
      return command === 'plugin:window|is_maximized' ? maximized : undefined;
    },
    { shouldMockEvents: true },
  );
  return { commands, bounds };
}

describe('TitleBar', () => {
  it('sends the caption buttons to the window', () => {
    const { commands } = mockShell();
    render(<TitleBar />);

    fireEvent.click(screen.getByRole('button', { name: titlebar.minimize }));
    fireEvent.click(screen.getByRole('button', { name: titlebar.maximize }));
    fireEvent.click(screen.getByRole('button', { name: titlebar.close }));

    expect(commands).toEqual(
      expect.arrayContaining([
        'plugin:window|minimize',
        'plugin:window|toggle_maximize',
        'plugin:window|close',
      ]),
    );
  });

  it('offers to restore a maximized window', async () => {
    mockShell({ maximized: true });
    render(<TitleBar />);

    expect(await screen.findByRole('button', { name: titlebar.restore })).toBeVisible();
  });

  it('tells the shell where the maximize button is, for the snap layouts overlay', () => {
    const { bounds } = mockShell();
    // jsdom lays nothing out: give every element the box of a 46 × 32 button left of the close
    // button.
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue(
      DOMRect.fromRect({ x: window.innerWidth - 92, y: 0, width: 46, height: 32 }),
    );
    render(<TitleBar />);

    expect(bounds).toEqual([{ right: 46, top: 0, width: 46, height: 32 }]);
  });

  it('hides the snap layouts overlay while the button has no box and when it goes away', () => {
    const { bounds } = mockShell();
    // jsdom lays nothing out, so the button has no box.
    const { unmount } = render(<TitleBar />);
    unmount();

    expect(bounds).toEqual([null, null]);
  });

  it('shows the hover and press the overlay reports on the maximize button', async () => {
    mockShell();
    render(<TitleBar />);
    const maximize = screen.getByRole('button', { name: titlebar.maximize });

    await act(() => emit('maximize-button-changed', { hovered: true, pressed: true }));

    expect(maximize).toHaveAttribute('data-hovered');
    expect(maximize).toHaveAttribute('data-pressed');
  });
});
