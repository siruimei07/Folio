// The preview's files in tests: what the `folio-file` scheme serves, entries of the fake shell by
// path, and messages from the preview's frame. Shared by the preview's and the diff pane's tests,
// which cannot import each other.
import { act } from '@testing-library/react';
import { vi } from 'vitest';

import type { EntryRef } from '../ipc';
import type { FrameMessage } from '../preview/protocol';

/** A file's bytes as a test serves them. */
export type ServedBody = string | Uint8Array<ArrayBuffer>;

/** A fetch's URL, whatever form it came in. */
export function requestUrl(input: RequestInfo | URL): string {
  return typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
}

/**
 * Stubs `fetch` as the `folio-file` scheme answers: the body `serve` gives for the URL (none for a
 * HEAD), and 404 `NotFound` when it gives none. `serve` is asked at each request.
 */
export function serveFiles(serve: (url: string) => ServedBody | undefined) {
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    await Promise.resolve();
    const body = serve(requestUrl(input));
    if (body === undefined) return new Response(null, { status: 404, headers: { 'X-Folio-Error': 'NotFound' } });
    return new Response(init?.method === 'HEAD' ? null : body, { status: 200 });
  });
  /** Every URL fetched so far. */
  const fetched = () => fetch.mock.calls.map(([input]) => requestUrl(input));
  return { fetch, fetched };
}

/** The fake shell that `renderApp` installed, for a test that picks what to render from it. */
export function fakeShell() {
  const shell = window.__FOLIO_FAKE_SHELL__;
  if (shell === undefined) throw new Error('no fake shell');
  return shell;
}

/** The entry at `path` in the fake shell that `renderApp` installed. */
export function refOf(path: string): EntryRef {
  const shell = fakeShell();
  const node = shell.library.at(path);
  if (node === undefined) throw new Error(`no ${path} in the fixture`);
  return shell.library.ref(node);
}

/**
 * Messages from the preview's frame, as its document would send them (`send`); what the page posts
 * to the frame is stubbed and recorded (`posted`).
 */
export function frameMessages() {
  const frame = document.querySelector('iframe');
  if (frame?.contentWindow == null) throw new Error('no frame');
  const target = frame.contentWindow;
  const posted = vi.spyOn(target, 'postMessage').mockImplementation(() => undefined);
  const send = (data: FrameMessage) => {
    act(() => {
      window.dispatchEvent(new MessageEvent('message', { data, origin: 'null', source: target }));
    });
  };
  return { posted, send };
}
