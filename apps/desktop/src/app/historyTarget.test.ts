import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { useSession } from '../data/session';
import type { FileRef } from '../ipc';
import {
  showHistory,
  showHistoryTimeline,
  takeHistoryTarget,
  takeHistoryTimeline,
  usePendingHistoryTarget,
  usePendingHistoryTimeline,
} from './historyTarget';
import { useNavigation } from './navigation';

const REVIEW: FileRef = {
  kind: 'entry',
  entry: { id: '42', path: 'Fall 2026/MAT232/Exams/Midterm/Midterm review.md' },
};
const VERSION: FileRef = { kind: 'version', commit: `b3:${'1'.repeat(64)}`, path: 'Fall 2026/MAT232/week 2 notes.md' };

beforeEach(() => {
  useNavigation.setState({ view: 'library', dialog: null, revealTarget: null });
  useSession.setState({ libraryId: 'library-a' });
});

afterEach(() => {
  takeHistoryTarget();
  takeHistoryTimeline();
  useSession.setState({ libraryId: null });
});

describe('showHistory', () => {
  it('shows History, which takes the file once', () => {
    const { result } = renderHook(() => usePendingHistoryTarget());
    expect(result.current).toBeNull();

    act(() => {
      showHistory(REVIEW);
    });

    expect(useNavigation.getState().view).toBe('history');
    expect(result.current).toEqual(REVIEW);
    let taken: FileRef | null = null;
    act(() => {
      taken = takeHistoryTarget();
    });
    expect(taken).toEqual(REVIEW);
    expect(result.current).toBeNull();
    expect(takeHistoryTarget()).toBeNull();
  });

  it('keeps the latest file asked for', () => {
    showHistory(REVIEW);
    showHistory(VERSION);

    expect(takeHistoryTarget()).toEqual(VERSION);
    expect(takeHistoryTarget()).toBeNull();
  });

  it('drops a file of a library that is no longer open', () => {
    showHistory(REVIEW);
    useSession.setState({ libraryId: 'library-b' });

    expect(takeHistoryTarget()).toBeNull();

    // Not even when the first library opens again: the target was handled.
    useSession.setState({ libraryId: 'library-a' });
    expect(takeHistoryTarget()).toBeNull();
  });

  it('does nothing while no library is open', () => {
    useSession.setState({ libraryId: null });

    showHistory(REVIEW);

    expect(useNavigation.getState().view).toBe('library');
    useSession.setState({ libraryId: 'library-a' });
    expect(takeHistoryTarget()).toBeNull();
  });
});

describe('showHistoryTimeline', () => {
  it('shows History, which takes the whole history once', () => {
    const { result } = renderHook(() => usePendingHistoryTimeline());
    expect(result.current).toBe(false);

    act(() => {
      showHistoryTimeline();
    });

    expect(useNavigation.getState().view).toBe('history');
    expect(result.current).toBe(true);
    let taken = false;
    act(() => {
      taken = takeHistoryTimeline();
    });
    expect(taken).toBe(true);
    expect(result.current).toBe(false);
    expect(takeHistoryTimeline()).toBe(false);
  });

  it('gives way to a file asked for later, and a file to it', () => {
    showHistoryTimeline();
    showHistory(REVIEW);
    expect(takeHistoryTimeline()).toBe(false);
    expect(takeHistoryTarget()).toEqual(REVIEW);

    showHistory(REVIEW);
    showHistoryTimeline();
    expect(takeHistoryTarget()).toBeNull();
    expect(takeHistoryTimeline()).toBe(true);
  });

  it('drops a request of a library that is no longer open, and asks nothing without one', () => {
    showHistoryTimeline();
    useSession.setState({ libraryId: 'library-b' });
    expect(takeHistoryTimeline()).toBe(false);

    useNavigation.setState({ view: 'library' });
    useSession.setState({ libraryId: null });
    showHistoryTimeline();
    expect(useNavigation.getState().view).toBe('library');
    expect(takeHistoryTimeline()).toBe(false);
  });
});
