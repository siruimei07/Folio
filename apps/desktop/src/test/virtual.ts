// Virtualised collections in jsdom (docs/specs/ui-architecture.md §11.4). jsdom has no layout, so
// every element measures 0 × 0 and a virtualiser renders no rows. An `initialRect` alone does not
// help: TanStack Virtual measures its scroll element (`offsetWidth` / `offsetHeight`) as soon as it
// mounts and replaces the initial size with 0 × 0. So tests give elements a box instead. Real
// scrolling is covered in e2e.

import { onTestFinished } from 'vitest';

export interface Size {
  width: number;
  height: number;
}

/** The size every element reports in view tests: a window of 800 × 600 CSS pixels. */
export const TEST_VIEWPORT: Size = { width: 800, height: 600 };

const SIZES = ['offsetWidth', 'offsetHeight'] as const;

/** Layouts in force, and jsdom's own descriptors, saved by the first. */
let active = 0;
let saved: (PropertyDescriptor | undefined)[] = [];

/**
 * Makes every element report `size` as its `offsetWidth` and `offsetHeight`, so a virtualised list
 * renders the rows that fit (600 / 32 ≈ 19, plus overscan). Returns the function that undoes it;
 * nested calls (two renders in one test) restore jsdom's sizes when the last one is undone.
 */
export function mockLayout(size: Size = TEST_VIEWPORT): () => void {
  const prototype = HTMLElement.prototype;
  if (active++ === 0) {
    saved = SIZES.map((property) => Object.getOwnPropertyDescriptor(prototype, property));
  }
  Object.defineProperty(prototype, 'offsetWidth', { configurable: true, get: () => size.width });
  Object.defineProperty(prototype, 'offsetHeight', { configurable: true, get: () => size.height });
  let undone = false;
  return () => {
    if (undone) return;
    undone = true;
    if (--active > 0) return;
    SIZES.forEach((property, index) => {
      const descriptor = saved[index];
      if (descriptor) Object.defineProperty(prototype, property, descriptor);
    });
  };
}

/** The farthest an element scrolls, as a browser has it: its content's height less its own. */
export function maxScroll(element: HTMLElement): number {
  return Math.max(0, element.scrollHeight - element.clientHeight);
}

/**
 * jsdom has no Element.scrollTo and no scroll sizes, so the virtualiser cannot move the view: until
 * the test ends, the content is as tall as the virtualiser's sizer, the box as tall as the 600 px
 * every element reports (`mockLayout`), and scrollTo moves the view within it and sends the scroll
 * event a task later, as a browser does. The diff's region and the virtualised lists use it.
 */
export function mockScrolling() {
  const prototype = HTMLElement.prototype;
  Object.defineProperties(prototype, {
    clientHeight: {
      configurable: true,
      get(this: HTMLElement) {
        return this.offsetHeight;
      },
    },
    scrollHeight: {
      configurable: true,
      get(this: HTMLElement) {
        const sizer = this.firstElementChild;
        const content = sizer instanceof HTMLElement ? Number.parseFloat(sizer.style.height) : Number.NaN;
        return Math.max(this.offsetHeight, Number.isNaN(content) ? 0 : content);
      },
    },
    scrollTo: {
      configurable: true,
      writable: true,
      value(this: HTMLElement, options?: ScrollToOptions) {
        if (options?.top === undefined) return;
        this.scrollTop = Math.min(Math.max(0, options.top), maxScroll(this));
        setTimeout(() => {
          this.dispatchEvent(new Event('scroll'));
        }, 0);
      },
    },
  });
  onTestFinished(() => {
    for (const property of ['clientHeight', 'scrollHeight', 'scrollTo']) Reflect.deleteProperty(prototype, property);
  });
}
