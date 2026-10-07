// The app's live regions (UI architecture §7.1): a held result keeps the polite region for a second,
// so a message that comes right after it is heard after it instead of in its place.
import { act, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { announce, Announcer, clearAnnouncements } from './announcer';

afterEach(() => {
  clearAnnouncements();
  vi.useRealTimers();
});

describe('a held announcement', () => {
  it('keeps the polite region for a second: the latest polite message waits for it, an assertive one does not', () => {
    vi.useFakeTimers();
    const { container } = render(<Announcer />);
    const polite = () => container.querySelector('[aria-live="polite"]')?.textContent;
    const assertive = () => container.querySelector('[aria-live="assertive"]')?.textContent;
    act(() => {
      announce('Committed 9 changes: MAT232: add lecture 6', 'polite', { hold: true });
      announce("Couldn't show what changed");
      announce('Change 1 of 3, lines 2 to 4');
      announce('Sync failed', 'assertive');
    });
    expect(polite()).toBe('Committed 9 changes: MAT232: add lecture 6');
    expect(assertive()).toBe('Sync failed');
    act(() => {
      vi.advanceTimersByTime(999);
    });
    expect(polite()).toBe('Committed 9 changes: MAT232: add lecture 6');
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(polite()).toBe('Change 1 of 3, lines 2 to 4');
    // Once the hold is over, a message replaces the last one at once.
    act(() => {
      announce('Saved the new message');
    });
    expect(polite()).toBe('Saved the new message');
  });

  it('gives way to a newer held message, and is let go by clearAnnouncements', () => {
    vi.useFakeTimers();
    const { container } = render(<Announcer />);
    const polite = () => container.querySelector('[aria-live="polite"]')?.textContent;
    act(() => {
      announce('Your history has started.', 'polite', { hold: true });
      announce('Committed 1 change: Notes', 'polite', { hold: true });
    });
    expect(polite()).toBe('Committed 1 change: Notes');
    act(() => {
      clearAnnouncements();
      announce('Copied the path');
    });
    expect(polite()).toBe('Copied the path');
  });
});
