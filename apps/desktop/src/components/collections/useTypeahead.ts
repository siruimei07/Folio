import { type KeyboardEvent, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';

import { TYPEAHEAD_MS } from '../../lib/timing';

/** Whether a name starts with typed text, without case or accents, as the UI language compares. */
export type NameMatcher = (name: string, typed: string) => boolean;

/** The matcher of the UI language. */
export function useNameMatcher(): NameMatcher {
  const { i18n } = useTranslation();
  return useMemo(() => {
    const collator = new Intl.Collator(i18n.language, { sensitivity: 'base', usage: 'search' });
    return (name, typed) => collator.compare(name.slice(0, typed.length), typed) === 0;
  }, [i18n.language]);
}

/**
 * Type-ahead (UI architecture §7.2): characters typed within `TYPEAHEAD_MS` of each other are
 * one search, handed to `find` with whether it should start after the focused row (a first
 * character, so typing it again cycles through the rows it starts). Returns the key handler,
 * which says whether it used the key. IME composition never counts (Chinese input).
 */
export function useTypeahead(find: (typed: string, fromNext: boolean) => void) {
  const typed = useRef({ text: '', at: 0 });
  return (event: KeyboardEvent): boolean => {
    if (event.nativeEvent.isComposing) return false;
    if (event.ctrlKey || event.altKey || event.metaKey) return false;
    if (Array.from(event.key).length !== 1) return false;
    const state = typed.current;
    if (event.timeStamp - state.at > TYPEAHEAD_MS) state.text = '';
    // A space only continues a search, as in "Problem sets"; alone it selects.
    if (event.key === ' ' && state.text === '') return false;
    state.text += event.key;
    state.at = event.timeStamp;
    // The same letter again cycles through the rows that start with it.
    const repeated = Array.from(state.text).every((character) => character === state.text[0]);
    find(repeated ? event.key : state.text, repeated);
    return true;
  };
}

/**
 * The next item from `from` (wrapping) whose name starts with `typed`; `nameAt` gives `undefined`
 * for items type-ahead skips, such as rows that cannot take focus.
 */
export function findByName(
  count: number,
  from: number,
  typed: string,
  matches: NameMatcher,
  nameAt: (index: number) => string | undefined,
): number | null {
  for (let offset = 0; offset < count; offset++) {
    const index = (from + offset) % count;
    const name = nameAt(index);
    if (name !== undefined && matches(name, typed)) return index;
  }
  return null;
}
