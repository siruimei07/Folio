import { useEffect, useState } from 'react';

import { SEARCH_PAUSE_MS } from '../lib/timing';

/**
 * The text to search for: `text` once typing pauses for `SEARCH_PAUSE_MS`, never while an IME
 * composes (UI architecture §9). Clearing the field settles at once, so the results go with it.
 */
export function useSettledText(text: string, composing: boolean): string {
  const [settled, setSettled] = useState(text);
  const cleared = text.trim() === '';
  if (cleared && settled !== text) setSettled(text);
  useEffect(() => {
    if (composing || cleared) return;
    const timer = window.setTimeout(() => {
      setSettled(text);
    }, SEARCH_PAUSE_MS);
    return () => {
      window.clearTimeout(timer);
    };
  }, [text, composing, cleared]);
  return settled;
}
