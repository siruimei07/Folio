// Keeping the focus in the diff when React removes the element that has it (WCAG 2.4.3): a fold that
// turns into its lines, a "Try again" whose row, block or banner goes as its read starts or
// succeeds, the lines' region that a refresh turns into a state block. The browser then focuses the
// page; once the DOM has changed, the part puts the focus back. Focus the person moved elsewhere
// (Tab, a click on text or on another pane) stays where they put it.
//
// It watches the part's DOM rather than renders, so a removal is seen whichever component made it
// (the lookup behind a file's preview renders on its own). Whether the element that lost the focus
// was removed or the person moved the focus is known only once it is, or is not, out of the page:
// Chrome sends `focusout` while it removes an element, before it is gone. So `focusout` notes the
// element and decides in a microtask, and until then a change that finds the focus on the page
// restores it only if that element has gone. `useVirtualRows` keeps the focus the same way.
//
// Parts nest (the lines' region in the pane), so they listen in the capture phase: the outer part
// hears the focus leave before the inner one. When the person moves the focus, Chromium runs the
// microtasks a listener queues before the next listener; an inner part that heard it first would
// let its element go (`onLeave`), React would remove it in those microtasks, and the outer part,
// not told yet, would take the focus back from where the person put it.
import { useCallback, useLayoutEffect, useRef } from 'react';

/**
 * A callback ref for the part of the pane that keeps the focus: when the focus was last in it and
 * a change to its DOM leaves the focus on the page, with the element that had it gone, `restore`
 * puts it back. `onLeave` runs once the focus has really left the part. Elements React renders
 * elsewhere (a menu's popover) are not the part's.
 */
export function useFocusKeeper(restore: () => void, onLeave?: () => void): (part: HTMLElement | null) => (() => void) | undefined {
  const latest = useRef({ restore, onLeave });
  useLayoutEffect(() => {
    latest.current = { restore, onLeave };
  });
  return useCallback((part: HTMLElement | null) => {
    if (part === null) return undefined;
    let holds = part.contains(document.activeElement);
    // The element that last gave the focus up, until its microtask has decided why.
    let leaving: Element | null = null;
    const onFocusIn = () => {
      holds = true;
      leaving = null;
    };
    const onFocusOut = (event: FocusEvent) => {
      const left = event.target;
      if (!(left instanceof Element)) return;
      leaving = left;
      queueMicrotask(() => {
        // The focus came back, or moved on within the part.
        if (leaving !== left) return;
        leaving = null;
        // A removed element did not give its focus away; one still in the page did.
        if (left.isConnected && !part.contains(document.activeElement)) {
          holds = false;
          latest.current.onLeave?.();
        }
      });
    };
    const observer = new MutationObserver(() => {
      const active = document.activeElement;
      if (!holds || (active !== null && active !== document.body)) return;
      // Still in the page: the person moved the focus, and the microtask has not said so yet.
      if (leaving?.isConnected === true) return;
      latest.current.restore();
    });
    part.addEventListener('focusin', onFocusIn, true);
    part.addEventListener('focusout', onFocusOut, true);
    observer.observe(part, { childList: true, subtree: true });
    return () => {
      part.removeEventListener('focusin', onFocusIn, true);
      part.removeEventListener('focusout', onFocusOut, true);
      observer.disconnect();
    };
  }, []);
}
