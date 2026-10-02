// The only component that renders an <iframe> (ADR-0001 action item 5; UI architecture §10.2,
// §14 rule 2): sandboxed to scripts alone, so the frame has an opaque origin, no IPC and no
// network, loaded from the folio-preview scheme. Its parent keys it by file and version, so every
// file gets a fresh frame and script from one file never sees the next.

import { type Ref, useCallback, useEffect, useEffectEvent, useImperativeHandle, useRef } from 'react';

import { handleShortcut } from '../app/shortcuts';
import { useFrameAppearance } from './appearance';
import {
  type FailureReason,
  type FrameMessage,
  type FramePayload,
  type FrameStrings,
  isFrameMessage,
  type Renderer,
  type WindowMessage,
} from './protocol';

/** Served by `crates/folio-app/src/preview.rs`; the main CSP's `frame-src` allows nothing else. */
export const PREVIEW_URL = 'http://folio-preview.localhost/preview.html';

/** No `ready` in this long, or no `rendered` this long after `render`, shows the error state. */
export const READY_TIMEOUT_MS = 5_000;
export const RENDER_TIMEOUT_MS = 15_000;

export type PdfState = FramePayload<'pdfState'>;
export type FrameLink = FramePayload<'link'>;

/** The frame after `render`: PDF commands and the images a note asked for. */
export interface FrameHandle {
  post: (message: WindowMessage, transfer?: Transferable[]) => void;
}

export interface PreviewFrameProps {
  renderer: Renderer;
  language: string | null;
  /**
   * The file's bytes, `null` while they load: the frame starts at once and gets them when both
   * are ready. Transferred to the frame, so they are spent after `render`.
   */
  bytes: ArrayBuffer | null;
  /** The frame's words; `strings.title` also names the frame element. */
  strings: FrameStrings;
  onRendered: () => void;
  /** `timeout` when the frame did not start or finish in time. */
  onFailed: (reason: FailureReason | 'timeout') => void;
  onPdfState: (state: PdfState) => void;
  onImages: (paths: readonly string[]) => void;
  onLink: (link: FrameLink) => void;
  /** Esc inside the frame: focus goes back to the preview header (§10.5). */
  onEscape: () => void;
  ref?: Ref<FrameHandle>;
}

export function PreviewFrame({
  renderer,
  language,
  bytes,
  strings,
  onRendered,
  onFailed,
  onPdfState,
  onImages,
  onLink,
  onEscape,
  ref,
}: PreviewFrameProps) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const appearance = useFrameAppearance();
  const state = useRef({ ready: false, sent: false, done: false, imagesAsked: false });
  const renderTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const post = useCallback((message: WindowMessage, transfer: Transferable[] = []) => {
    // The frame's origin is opaque, so no other target origin can name it; `event.source` on its
    // side checks that the message comes from this window.
    frameRef.current?.contentWindow?.postMessage(message, '*', transfer);
  }, []);
  useImperativeHandle(ref, () => ({ post }), [post]);

  const fail = useEffectEvent((reason: FailureReason | 'timeout') => {
    const current = state.current;
    if (current.done) return;
    current.done = true;
    onFailed(reason);
  });

  /** Sends the file once the frame is ready and the bytes are here, whichever comes last. */
  const sendFile = useEffectEvent(() => {
    const current = state.current;
    if (!current.ready || current.sent || current.done || bytes === null) return;
    current.sent = true;
    post({ kind: 'render', renderer, bytes, language, strings, ...appearance }, [bytes]);
    renderTimer.current = setTimeout(() => {
      fail('timeout');
    }, RENDER_TIMEOUT_MS);
  });

  const handle = useEffectEvent((message: FrameMessage) => {
    const current = state.current;
    switch (message.kind) {
      case 'ready':
        current.ready = true;
        sendFile();
        return;
      case 'rendered':
        clearTimeout(renderTimer.current);
        if (current.done) return;
        current.done = true;
        onRendered();
        return;
      case 'failed':
        clearTimeout(renderTimer.current);
        fail(message.reason);
        return;
      case 'pdfState':
        onPdfState({ page: message.page, pages: message.pages, percent: message.percent });
        return;
      case 'images':
        // Only a note names images, and once; anything else is a frame bug or a hostile file.
        if (current.imagesAsked || renderer !== 'markdown') return;
        current.imagesAsked = true;
        onImages(message.paths);
        return;
      case 'link':
        onLink({ href: message.href, rect: message.rect });
        return;
      case 'shortcut':
        // The protocol accepts only Esc and the shape of the window's shortcuts.
        if (message.press.key === 'Escape') onEscape();
        else handleShortcut({ ...message.press, target: null });
        return;
    }
  });

  useEffect(() => {
    const readyTimer = setTimeout(() => {
      if (!state.current.ready) fail('timeout');
    }, READY_TIMEOUT_MS);
    const onMessage = (event: MessageEvent) => {
      const frame = frameRef.current?.contentWindow;
      if (frame === null || frame === undefined || event.source !== frame || event.origin !== 'null') return;
      if (isFrameMessage(event.data)) handle(event.data);
    };
    window.addEventListener('message', onMessage);
    return () => {
      window.removeEventListener('message', onMessage);
      clearTimeout(readyTimer);
      clearTimeout(renderTimer.current);
    };
  }, []);

  useEffect(() => {
    sendFile();
  }, [bytes]);

  // A theme or reduced-motion change while the file shows.
  const { theme, reduceMotion } = appearance;
  useEffect(() => {
    if (state.current.sent) post({ kind: 'appearance', theme, reduceMotion });
  }, [post, theme, reduceMotion]);

  return (
    <iframe
      ref={frameRef}
      className="preview-frame"
      sandbox="allow-scripts"
      src={PREVIEW_URL}
      title={strings.title}
    />
  );
}
