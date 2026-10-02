// The window's half of images next to a note (UI architecture §10.4; ADR-0005, product decision
// 1): the frame names the relative paths of its images, the window checks each one, asks the shell
// which catalogued files they are (`resolve_paths`), fetches the images among them within the size
// limits and hands each to the frame as it arrives. Everything else is `missing`.

import { useEffect, useMemo, useRef, useState } from 'react';

import { useResolvedPaths } from '../data/files';
import { contentUrl, type EntryRef } from '../ipc';
import { fetchBytes } from './content';
import { imageTypeOf } from './kinds';
import { IMAGE_LIMITS, type ImageMessage } from './protocol';

/**
 * The library path text a note's image path names, or `null` for one the window never asks
 * about: after dropping `?…` and `#…` and percent-decoding, anything absolute (`/…`, `\…`, `C:…`)
 * or with a scheme. `..` stays: the shell resolves it and refuses what leaves the library.
 */
export function notePath(raw: string): string | null {
  const [bare = ''] = raw.split(/[?#]/, 1);
  let path: string;
  try {
    path = decodeURIComponent(bare).trim();
  } catch {
    return null;
  }
  if (path === '' || /^[/\\]/.test(path) || /^[a-z][a-z0-9+.-]*:/i.test(path)) return null;
  return path;
}

type Post = (message: ImageMessage, transfer?: Transferable[]) => void;

/**
 * Answers the frame's `images` message for `note`: returns the handler for it. `post` sends to
 * the frame; every path gets exactly one `image` message. A catalog change asks the shell again,
 * and fetches already running carry on.
 */
export function useNoteImages(note: EntryRef, post: Post): (paths: readonly string[]) => void {
  const [asked, setAsked] = useState<readonly string[]>([]);
  const decoded = useMemo(() => asked.map(notePath), [asked]);
  const askable = useMemo(() => [...new Set(decoded.filter((path) => path !== null))], [decoded]);
  // Only the reference: a row's tags or dates changing must not ask again.
  const { id, path: notePathText } = note;
  const base = useMemo(() => ({ id, path: notePathText }), [id, notePathText]);
  const resolved = useResolvedPaths(asked.length === 0 ? null : base, askable);
  /** Paths answered or being fetched; the bytes the note may still have. */
  const handled = useRef(new Set<string>());
  const budget = useRef<number>(IMAGE_LIMITS.note);
  const fetches = useRef(new AbortController());

  useEffect(() => {
    const controller = new AbortController();
    fetches.current = controller;
    return () => {
      controller.abort();
    };
  }, []);

  const rows = resolved.data;
  const failed = resolved.isError;
  useEffect(() => {
    const answer = (path: string, image: ImageMessage['image']) => {
      post({ kind: 'image', path, image }, image === null ? [] : [image.bytes]);
    };
    asked.forEach((path, index) => {
      const named = decoded[index] ?? null;
      // Paths the window refuses, and every path once resolving failed, are missing at once.
      if (handled.current.has(path) || (named !== null && !failed && rows === undefined)) return;
      handled.current.add(path);
      const row = named === null || failed ? null : (rows?.[askable.indexOf(named)] ?? null);
      const type = row === null ? null : imageTypeOf(row.name);
      const size = row === null ? Infinity : Number(row.size);
      if (row === null || type === null || size > IMAGE_LIMITS.image || size > budget.current) {
        answer(path, null);
        return;
      }
      budget.current -= size;
      void fetchBytes(contentUrl(row), fetches.current.signal).then(
        (result) => {
          // The file may have grown since the catalog saw it.
          const extra = result.state === 'ready' ? result.bytes.byteLength - size : 0;
          if (result.state === 'ready' && result.bytes.byteLength <= IMAGE_LIMITS.image && extra <= budget.current) {
            budget.current -= extra;
            answer(path, { bytes: result.bytes, type });
          } else {
            budget.current += size;
            answer(path, null);
          }
        },
        () => {
          // Aborted: the frame is gone.
        },
      );
    });
  }, [asked, decoded, askable, rows, failed, post]);

  return setAsked;
}
