// The focus leaving an element as Chromium does it when the person clicks text that takes no focus.
// The focus is on the page before any listener runs; the event is the person's, so no script is on
// the stack between two of its listeners, and the microtasks one listener queues (a state update,
// React's commit, a MutationObserver's callback) run before the next listener, while `window.event`
// is still the event. jsdom's `element.blur()` runs them only after the last listener. The tests of
// the parts that keep the focus (components/collections/useFocusKeeper.ts: the diff pane, its
// lines, the virtualised collections) blur with it.
import { getConfig } from '@testing-library/react';
import { onTestFinished } from 'vitest';

/** The events of a blur, which `focusBlurrer` runs listener by listener. */
const BLUR_EVENTS = new Set(['blur', 'focusout']);

/**
 * Promise turns after each listener: far more than the chains a listener starts here (a state
 * update, React's flush, its commit, a MutationObserver's callback). Only promise jobs run, as
 * between two listeners in a browser: no timer, and no task of React's scheduler.
 */
const MICROTASK_TURNS = 50;

interface Entry {
  target: EventTarget;
  type: string;
  capture: boolean;
  listener: EventListenerOrEventListenerObject;
  wrapper: EventListener;
  removed: boolean;
}

function captureOf(options: boolean | EventListenerOptions | undefined): boolean {
  return typeof options === 'boolean' ? options : options?.capture === true;
}

function invoke(entry: Entry, event: Event) {
  const { listener, target } = entry;
  if (typeof listener === 'function') listener.call(target, event);
  else listener.handleEvent(event);
}

/**
 * From now until the test ends, blur and focusout listeners are wrapped so that the returned
 * function can run them one at a time. Call it before the render: React adds its listeners when it
 * creates the root.
 */
export function focusBlurrer(): (element: HTMLElement) => Promise<void> {
  const prototype = EventTarget.prototype;
  // eslint-disable-next-line @typescript-eslint/unbound-method -- put back as they were, and called with each target as `this`
  const { addEventListener: add, removeEventListener: remove } = prototype;
  const entries: Entry[] = [];
  // The listener calls a blur has queued while it runs, in the order the dispatch made them.
  let queue: { entry: Entry; event: Event }[] | null = null;
  const find = (target: EventTarget, type: string, listener: EventListenerOrEventListenerObject, capture: boolean) =>
    entries.find(
      (entry) => entry.target === target && entry.type === type && entry.listener === listener && entry.capture === capture,
    );
  const unlist = (entry: Entry) => {
    const index = entries.indexOf(entry);
    if (index >= 0) entries.splice(index, 1);
  };
  prototype.addEventListener = function (this: EventTarget, type, listener, options) {
    if (!BLUR_EVENTS.has(type) || listener === null) {
      add.call(this, type, listener, options);
      return;
    }
    const capture = captureOf(options);
    // The same listener twice is one listener.
    if (find(this, type, listener, capture) !== undefined) return;
    const once = typeof options === 'object' && options.once === true;
    const entry: Entry = {
      target: this,
      type,
      capture,
      listener,
      removed: false,
      wrapper: (event) => {
        // The dispatch has removed a `once` listener; its queued call still runs.
        if (once) unlist(entry);
        if (queue === null) invoke(entry, event);
        else queue.push({ entry, event });
      },
    };
    entries.push(entry);
    if (typeof options === 'object') {
      options.signal?.addEventListener('abort', () => {
        entry.removed = true;
        unlist(entry);
      });
    }
    add.call(this, type, entry.wrapper, options);
  };
  prototype.removeEventListener = function (this: EventTarget, type, listener, options) {
    const entry = listener === null ? undefined : find(this, type, listener, captureOf(options));
    if (entry === undefined) {
      remove.call(this, type, listener, options);
      return;
    }
    entry.removed = true;
    unlist(entry);
    remove.call(this, type, entry.wrapper, options);
  };
  onTestFinished(() => {
    prototype.addEventListener = add;
    prototype.removeEventListener = remove;
  });

  return async (element) => {
    // Outside act, as in testing-library's `waitFor`: React schedules its work as in a browser.
    await getConfig().asyncWrapper(async () => {
      queue = [];
      element.blur();
      const calls: readonly { entry: Entry; event: Event }[] = queue;
      queue = null;
      const own = Object.getOwnPropertyDescriptor(window, 'event');
      try {
        for (const { entry, event } of calls) {
          // A listener removed by an earlier one's microtasks is not called.
          if (entry.removed) continue;
          Object.defineProperty(event, 'currentTarget', { configurable: true, value: entry.target });
          Object.defineProperty(window, 'event', { configurable: true, get: () => event });
          invoke(entry, event);
          for (let turn = 0; turn < MICROTASK_TURNS; turn += 1) await Promise.resolve();
        }
      } finally {
        if (own === undefined) Reflect.deleteProperty(window, 'event');
        else Object.defineProperty(window, 'event', own);
      }
    });
  };
}
