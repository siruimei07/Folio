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

/**
 * How long a commit that has just arrived keeps its soft background in "Not synced" and History
 * (workspace-history handoff §14): reduced motion fades it at once, but never sooner.
 */
export const FRESH_COMMIT_MS = 2000;

/** The pause in typing after which search asks for the text (UI architecture §9). */
export const SEARCH_PAUSE_MS = 120;

/** Characters typed within this long find a row by its name together (UI architecture §7.2). */
export const TYPEAHEAD_MS = 500;

/**
 * Windows' double-click time: a second click on a selected row's name renames it once this long
 * has passed without a double-click (library-actions §7.1).
 */
export const DOUBLE_CLICK_MS = 500;

/** How long the window shows only the title bar before "Opening your library…" (first-run §2). */
export const OPENING_DELAY_MS = 400;

/** Screen readers hear the first run's scan strip at most this often (first-run handoff §9). */
export const SCAN_ANNOUNCE_MS = 5000;

/** How long the first run waits for LibraryStateChanged after a library opens before it asks. */
export const LIBRARY_EVENT_WAIT_MS = 1000;

/** A collapsed course or folder under a dragged item or file this long opens (library-actions §3, §7.3). */
export const EXPAND_AFTER_MS = 700;
