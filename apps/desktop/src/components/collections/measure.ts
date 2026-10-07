// Measuring the items of a virtualised list whose items differ in height: the diff's lines, which
// wrap, and the History timeline's entries.
import type { Virtualizer } from '@tanstack/react-virtual';

/**
 * TanStack Virtual's `measureElement` for items of their own heights: the item's border box, or its
 * estimate while it has none (jsdom, or not laid out yet).
 */
export function measureItem(
  element: Element,
  entry: ResizeObserverEntry | undefined,
  instance: Virtualizer<HTMLDivElement, Element>,
): number {
  const size = entry?.borderBoxSize[0]?.blockSize ?? element.getBoundingClientRect().height;
  return size > 0 ? size : instance.options.estimateSize(instance.indexFromElement(element));
}
