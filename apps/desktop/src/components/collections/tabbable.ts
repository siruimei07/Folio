// The elements Tab reaches outside a container, for keys that leave it at once: the WAI-ARIA feed's
// Ctrl+End and Ctrl+Home move the focus past the feed or before it, however many entries (and the
// controls in them) Tab would cross on the way.

const CANDIDATES = 'a[href], button, input, select, textarea, [tabindex]';

/** Whether Tab stops at `element`: in the tab order, enabled, not inert, and displayed. */
function isTabbable(element: HTMLElement): boolean {
  if (element.tabIndex < 0 || element.matches(':disabled') || element.closest('[inert]') !== null) return false;
  if (getComputedStyle(element).visibility === 'hidden') return false;
  // A view hidden in React's `<Activity>` is `display: none` on an element around it.
  for (let node: HTMLElement | null = element; node !== null; node = node.parentElement) {
    if (getComputedStyle(node).display === 'none') return false;
  }
  return true;
}

/**
 * The first element Tab reaches after `container` (`side` "after"), or the nearest one before it
 * ("before"), in the document's order; `null` when there is none.
 */
export function tabbableBeside(container: Element, side: 'before' | 'after'): HTMLElement | null {
  const position = side === 'after' ? Node.DOCUMENT_POSITION_FOLLOWING : Node.DOCUMENT_POSITION_PRECEDING;
  const beside = [...container.ownerDocument.querySelectorAll<HTMLElement>(CANDIDATES)].filter(
    (element) => !container.contains(element) && (container.compareDocumentPosition(element) & position) !== 0,
  );
  if (side === 'before') beside.reverse();
  return beside.find(isTabbable) ?? null;
}
