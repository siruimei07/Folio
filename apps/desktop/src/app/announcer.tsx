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

/** How long a held polite message keeps its region before a later one may replace it. */
const HOLD_MS = 1000;
/** Until when the polite region is held (`Date.now()` time); 0 when it is not. */
let heldUntil = 0;
/** The latest polite message waiting for a hold to end. */
let waiting: ReturnType<typeof setTimeout> | undefined;

function say(message: string, politeness: 'polite' | 'assertive'): void {
  const announcement = { id: nextId, message };
  nextId += 1;
  useAnnouncer.setState(politeness === 'polite' ? { polite: announcement } : { assertive: announcement });
}

export interface AnnounceOptions {
  /**
   * The result of something the person did, which must be heard (a commit's "Committed 9
   * changes: …"): for a second, a later polite message waits for it instead of replacing it in
   * the region, where a screen reader would most likely hear only the later one (a diff that
   * fails as the selection moves on).
   */
  hold?: boolean;
}

/** Reads `message` to screen reader users: politely, or at once for failures that need action. */
export function announce(message: string, politeness: 'polite' | 'assertive' = 'polite', { hold = false }: AnnounceOptions = {}): void {
  if (politeness === 'assertive') {
    say(message, politeness);
    return;
  }
  clearTimeout(waiting);
  waiting = undefined;
  const now = Date.now();
  if (!hold && now < heldUntil) {
    waiting = setTimeout(() => {
      waiting = undefined;
      say(message, 'polite');
    }, heldUntil - now);
    return;
  }
  heldUntil = hold ? now + HOLD_MS : 0;
  say(message, 'polite');
}

/** Empties both regions, and lets the polite one go: a test that starts afresh. */
export function clearAnnouncements(): void {
  clearTimeout(waiting);
  waiting = undefined;
  heldUntil = 0;
  useAnnouncer.setState({ polite: null, assertive: null });
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
