// The app's live regions (UI architecture §7.1): screen readers hear results that have no toast
// of their own, such as sync results and "no search results". React Aria's announcer is
// internal, so the app keeps two regions of its own: polite and assertive.

import { create } from 'zustand';

interface Announcement {
  /** Changes with every announcement, so the same words are read again. */
  id: number;
  message: string;
}

interface AnnouncerState {
  polite: Announcement | null;
  assertive: Announcement | null;
}

const useAnnouncer = create<AnnouncerState>()(() => ({ polite: null, assertive: null }));

let nextId = 1;

/** Reads `message` to screen reader users: politely, or at once for failures that need action. */
export function announce(message: string, politeness: 'polite' | 'assertive' = 'polite'): void {
  const announcement = { id: nextId, message };
  nextId += 1;
  useAnnouncer.setState(politeness === 'polite' ? { polite: announcement } : { assertive: announcement });
}

/**
 * Mount once, near the root. The regions stay in the page, so their first message is heard, and
 * React Aria keeps them audible while a dialog makes the rest of the window inert.
 */
export function Announcer() {
  const polite = useAnnouncer((state) => state.polite);
  const assertive = useAnnouncer((state) => state.assertive);
  return (
    <div className="visually-hidden" data-live-announcer="true">
      <div aria-live="polite" aria-atomic="true">
        {polite && <span key={polite.id}>{polite.message}</span>}
      </div>
      <div aria-live="assertive" aria-atomic="true">
        {assertive && <span key={assertive.id}>{assertive.message}</span>}
      </div>
    </div>
  );
}
