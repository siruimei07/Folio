import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { destroyAnnouncer } from 'react-aria/private/live-announcer/LiveAnnouncer';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';

import { Button } from './Button';
import { PendingButton } from './PendingButton';

/** The announcement React Aria makes for a button that turns pending or back while focused. */
function announcementOf(button: HTMLElement): Element | null {
  return document.querySelector(`[aria-live="assertive"] [aria-labelledby~="${button.id}"]`);
}

describe('PendingButton', () => {
  function Save({ onPress }: { onPress: () => void }) {
    const [saving, setSaving] = useState(false);
    return (
      <>
        <PendingButton
          variant="accent"
          pending={saving ? 'Saving…' : null}
          onPress={() => {
            onPress();
            setSaving(true);
          }}
        >
          Save
        </PendingButton>
        <Button
          onPress={() => {
            setSaving(false);
          }}
        >
          Done
        </Button>
      </>
    );
  }

  it('turns pending with its label: the disabled look, focus kept, presses ignored, and says so', async () => {
    const onPress = vi.fn();
    render(<Save onPress={onPress} />);
    const button = screen.getByRole('button', { name: 'Save' });
    expect(button).not.toHaveAttribute('data-pending');
    expect(button).not.toHaveAttribute('aria-disabled');

    await userEvent.tab();
    await userEvent.keyboard('{Enter}');
    expect(onPress).toHaveBeenCalledOnce();
    expect(button).toHaveAccessibleName('Saving…');
    expect(button.querySelector('.spinner')).not.toBeNull();
    expect(button).toHaveAttribute('data-pending', 'true');
    expect(button).toHaveAttribute('aria-disabled', 'true');
    // Pending, not disabled: it keeps focus and its place in the tab order.
    expect(button).not.toBeDisabled();
    expect(button).not.toHaveAttribute('data-disabled');
    expect(button).toHaveFocus();
    expect(announcementOf(button)).not.toBeNull();

    await userEvent.keyboard('{Enter}');
    await userEvent.keyboard(' ');
    await userEvent.click(button);
    expect(onPress).toHaveBeenCalledOnce();
    expect(button).toHaveFocus();
  });

  it('shows no hover while pending', async () => {
    render(
      <>
        <PendingButton pending="Saving…">Save</PendingButton>
        <PendingButton pending={null}>Cancel</PendingButton>
      </>,
    );
    const pending = screen.getByRole('button', { name: 'Saving…' });
    const idle = screen.getByRole('button', { name: 'Cancel' });
    await userEvent.hover(pending);
    expect(pending).not.toHaveAttribute('data-hovered');
    await userEvent.hover(idle);
    expect(idle).toHaveAttribute('data-hovered', 'true');
  });

  it('is pending with its own label when the caller says isPending alone', async () => {
    const onPress = vi.fn();
    render(
      <PendingButton pending={null} isPending onPress={onPress}>
        Add 3 files
      </PendingButton>,
    );
    const button = screen.getByRole('button', { name: 'Add 3 files' });
    expect(button).toHaveAttribute('data-pending', 'true');
    expect(button).toHaveAttribute('aria-disabled', 'true');
    expect(button.querySelector('.spinner')).toBeNull();
    await userEvent.click(button);
    expect(onPress).not.toHaveBeenCalled();
  });

  it('takes its announcement along when it goes, so the live region names nothing that is gone', async () => {
    const { rerender } = render(<PendingButton pending={null}>Next</PendingButton>);
    const button = screen.getByRole('button', { name: 'Next' });
    const { id } = button;
    await userEvent.tab();
    rerender(<PendingButton pending="Opening…">Next</PendingButton>);
    expect(announcementOf(button)).not.toBeNull();

    rerender(<p>The next step</p>);
    expect(document.querySelector(`[data-live-announcer] [aria-labelledby~="${id}"]`)).toBeNull();
  });

  // Outside a test's act environment, React Aria adds the window's first announcement 100 ms late,
  // once its live region is in the page: the button may have gone by then (first run's folder step).
  // Rendered here as the app renders, with no act environment and fake timers.
  it('takes along the announcement React Aria adds late, the window’s first', () => {
    destroyAnnouncer();
    const global = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
    const actEnvironment = global.IS_REACT_ACT_ENVIRONMENT;
    global.IS_REACT_ACT_ENVIRONMENT = false;
    vi.useFakeTimers();
    const container = document.body.appendChild(document.createElement('div'));
    const root = createRoot(container);
    try {
      flushSync(() => {
        root.render(<PendingButton pending={null}>Next</PendingButton>);
      });
      const button = screen.getByRole('button', { name: 'Next' });
      const announced = () => document.querySelector(`[data-live-announcer] [aria-labelledby~="${button.id}"]`);
      flushSync(() => {
        button.focus();
      });
      flushSync(() => {
        root.render(<PendingButton pending="Opening…">Next</PendingButton>);
      });
      expect(announced()).toBeNull();

      flushSync(() => {
        root.render(<p>The next step</p>);
      });
      vi.advanceTimersByTime(100);
      expect(announced()).not.toBeNull();
      vi.advanceTimersByTime(100);
      expect(announced()).toBeNull();
    } finally {
      root.unmount();
      container.remove();
      vi.useRealTimers();
      global.IS_REACT_ACT_ENVIRONMENT = actEnvironment;
    }
  });

  it('presses again once it is no longer pending', async () => {
    const onPress = vi.fn();
    render(<Save onPress={onPress} />);
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await userEvent.click(screen.getByRole('button', { name: 'Done' }));
    const button = screen.getByRole('button', { name: 'Save' });
    expect(button).not.toHaveAttribute('data-pending');
    expect(button).not.toHaveAttribute('aria-disabled');
    await userEvent.click(button);
    expect(onPress).toHaveBeenCalledTimes(2);
  });
});
