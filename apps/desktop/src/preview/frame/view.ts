// What every renderer in the frame gets and gives back.

import type { FailureReason, FrameMessage, ImageMessage, PdfCommand, RenderMessage } from '../protocol';

/** Sends a message to the window, the only place the frame may talk to. */
export function send(message: FrameMessage): void {
  // The window's origin differs between dev and release builds, and its own check of
  // `event.source` decides; nothing the frame sends is secret from the window.
  window.parent.postMessage(message, '*');
}

/** A file the frame cannot show, and why; anything else a renderer throws is a `renderer` bug. */
export class RenderFailure extends Error {
  constructor(readonly reason: FailureReason) {
    super(reason);
    this.name = 'RenderFailure';
  }
}

/** A rendered file, and how it takes the messages that follow `render`. */
export interface View {
  pdf?: (command: PdfCommand) => void;
  image?: (message: ImageMessage) => void;
}

export type RenderFile = (root: HTMLElement, message: RenderMessage) => Promise<View>;
