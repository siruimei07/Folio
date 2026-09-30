// Waiting times that are not motion. They stay the same under reduced motion, so they are UI
// constants here, never duration tokens (which reduced motion sets to 0 ms; library-actions
// handoff §13, design/tokens/README.md "Motion").

/** How long the pointer rests on a control before its tooltip opens; keyboard focus opens it at once. */
export const TOOLTIP_DELAY_MS = 500;

/** How long success and information toasts stay, paused while the pointer or focus is inside. */
export const TOAST_DISMISS_MS = 6000;

/** How long the pointer rests on a submenu item before the submenu opens. */
export const SUBMENU_DELAY_MS = 200;

/** How long the activity button stays after the last job finished (library-actions §10.1). */
export const ACTIVITY_LINGER_MS = 10_000;

/** How long a region waits for data before it shows skeleton rows (UI architecture §13). */
export const LOADING_DELAY_MS = 150;
