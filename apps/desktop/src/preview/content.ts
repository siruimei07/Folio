// A file's bytes for the frame, from the `folio-file` scheme (ipc-m1 §11.2): the bytes never
// travel in IPC messages, and the frame has no network, so the window fetches and transfers them.

import { useEffect, useState } from 'react';

import { fileError, type FileErrorCode } from '../ipc';

/** Why reading a file failed: the scheme's code, or `Transport` when no answer came. */
export type ReadFailure = FileErrorCode | 'Transport';

export type Fetched = { state: 'ready'; bytes: ArrayBuffer } | { state: 'failed'; code: ReadFailure };
export type Content = { state: 'loading' } | Fetched;

/** Fetches `url` whole. Rejects only when `signal` aborted it. */
export async function fetchBytes(url: string, signal?: AbortSignal): Promise<Fetched> {
  try {
    const response = await fetch(url, { signal });
    const code = fileError(response);
    if (code !== null) return { state: 'failed', code };
    return { state: 'ready', bytes: await response.arrayBuffer() };
  } catch (error) {
    if (signal?.aborted === true) throw error;
    return { state: 'failed', code: 'Transport' };
  }
}

/**
 * Why an `<img>`, `<audio>` or `<video>` failed, which the element cannot read itself: `HEAD`
 * answers the same status and code without the bytes. `null` when the file is readable, so the
 * element could not decode it.
 */
export async function mediaFailure(url: string): Promise<ReadFailure | null> {
  try {
    return fileError(await fetch(url, { method: 'HEAD' }));
  } catch {
    return 'Transport';
  }
}

/** The bytes at `url` (`contentUrl`), fetched once: the body remounts for every file and retry. */
export function useContent(url: string): Content {
  const [content, setContent] = useState<Content>({ state: 'loading' });
  useEffect(() => {
    const controller = new AbortController();
    fetchBytes(url, controller.signal).then(setContent, () => {
      // Aborted: the preview moved on to another file.
    });
    return () => {
      controller.abort();
    };
  }, [url]);
  return content;
}
