import { emit, type Event, type UnlistenFn } from '@tauri-apps/api/event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { hold, shellEvents, subscribe } from './events';

/** An event whose listener registration the test settles by hand. */
function manualEvent<T>() {
  let handler: ((event: Event<T>) => void) | undefined;
  let settle: { resolve: (stop: UnlistenFn) => void; reject: (error: unknown) => void } | undefined;
  const registration = new Promise<UnlistenFn>((resolve, reject) => {
    settle = { resolve, reject };
  });
  const stop = vi.fn();
  return {
    listen: (listener: (event: Event<T>) => void) => {
      handler = listener;
      return registration;
    },
    fire: (payload: T) => {
      handler?.({ event: 'test', id: 1, payload });
    },
    register: () => {
      settle?.resolve(stop);
    },
    fail: (error: unknown) => {
      settle?.reject(error);
    },
    stop,
  };
}

/** Lets settled promises run their callbacks. */
const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => {
  vi.restoreAllMocks();
});

describe('subscribe', () => {
  it('delivers payloads until stopped, then releases the listener once it is registered', async () => {
    const event = manualEvent<number>();
    const onEvent = vi.fn();
    const stop = subscribe(event, onEvent);

    event.fire(1);
    stop();
    event.fire(2);
    event.register();
    await settled();

    expect(onEvent.mock.calls).toEqual([[1]]);
    expect(event.stop).toHaveBeenCalledOnce();
  });

  it('reports a failed registration once, and stopping it afterwards does nothing', async () => {
    const report = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const event = manualEvent<number>();
    const stop = subscribe(event, vi.fn());

    event.fail('not allowed');
    await settled();
    stop();
    await settled();

    expect(report.mock.calls).toEqual([['event listener failed', 'not allowed']]);
  });
});

describe('hold', () => {
  it('releases a listener whose registration already resolved', async () => {
    const stopListener = vi.fn();
    const release = hold(Promise.resolve(stopListener));

    release();
    await settled();

    expect(stopListener).toHaveBeenCalledOnce();
  });

  it('reports a release that fails, as Tauri reports it: through a promise', async () => {
    const report = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const release = hold(Promise.resolve(() => Promise.reject(new Error('not allowed'))));

    release();
    await settled();

    expect(report.mock.calls).toEqual([['event listener failed', new Error('not allowed')]]);
  });
});

describe('shellEvents', () => {
  // The shared test setup delivers emitted events in the page (src/test/setup.ts).
  it('listens to the events the shell emits, under their generated names', async () => {
    const onEvent = vi.fn();
    const stop = shellEvents.onProblemsChanged(onEvent);

    await emit('problems-changed', { total: 3 });
    stop();
    await emit('problems-changed', { total: 4 });

    expect(onEvent.mock.calls).toEqual([[{ total: 3 }]]);
  });
});
