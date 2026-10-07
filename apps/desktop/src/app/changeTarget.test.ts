import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { useSession } from '../data/session';
import { showChange, takeChangeTarget, usePendingChangeTarget } from './changeTarget';
import { useNavigation } from './navigation';

const REVIEW = 'Fall 2026/MAT232/Exams/Midterm/Midterm review.md';

beforeEach(() => {
  useNavigation.setState({ view: 'library', dialog: null, revealTarget: null });
  useSession.setState({ libraryId: 'library-a' });
});

afterEach(() => {
  takeChangeTarget();
  useSession.setState({ libraryId: null });
});

describe('showChange', () => {
  it('shows Changes, which takes the path once', () => {
    const { result } = renderHook(() => usePendingChangeTarget());
    expect(result.current).toBeNull();
    act(() => {
      showChange(REVIEW);
    });
    expect(useNavigation.getState().view).toBe('changes');
    expect(result.current).toBe(REVIEW);
    let taken: string | null = null;
    act(() => {
      taken = takeChangeTarget();
    });
    expect(taken).toBe(REVIEW);
    expect(result.current).toBeNull();
    expect(takeChangeTarget()).toBeNull();
  });

  it('shows Changes without a path, and leaves an earlier path pending', () => {
    showChange(REVIEW);
    useNavigation.setState({ view: 'history' });
    showChange();
    expect(useNavigation.getState().view).toBe('changes');
    expect(takeChangeTarget()).toBe(REVIEW);
  });

  it('drops a path asked for in a library that is no longer open', () => {
    showChange(REVIEW);
    useSession.setState({ libraryId: 'library-b' });
    expect(takeChangeTarget()).toBeNull();
  });

  it('does nothing without a library open', () => {
    useSession.setState({ libraryId: null });
    showChange(REVIEW);
    expect(useNavigation.getState().view).toBe('library');
    expect(takeChangeTarget()).toBeNull();
  });
});
