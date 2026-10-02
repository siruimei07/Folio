// Runs inside the sandboxed preview frame (preview.html; UI architecture §10.2–§10.5). It only
// ever listens to the window that embeds it: it says it is ready, takes one file, renders it with
// a renderer loaded on demand, and answers with `rendered` or `failed`.
import './seal';
import './frame.css';

import { type Appearance, isWindowMessage, type RenderMessage, SIZE_LIMITS } from '../protocol';
import { installKeys } from './keys';
import { installLinks } from './links';
import { RenderFailure, type RenderFile, send, type View } from './view';

const RENDERERS: Readonly<Record<RenderMessage['renderer'], () => Promise<RenderFile>>> = {
  text: async () => (await import('./text')).renderText,
  code: async () => (await import('./text')).renderText,
  markdown: async () => (await import('./markdown')).renderMarkdown,
  pdf: async () => (await import('./pdf')).renderPdf,
};

/** The app's theme and reduced motion, which can differ from Windows' (tokens.css reads these). */
function applyAppearance({ theme, reduceMotion }: Appearance): void {
  const root = document.documentElement;
  root.dataset.theme = theme;
  root.dataset.reduceMotion = reduceMotion ? 'on' : 'off';
}

let started = false;
let view: View | null = null;

async function render(message: RenderMessage): Promise<void> {
  applyAppearance(message);
  document.title = message.strings.title;
  try {
    const root = document.getElementById('preview');
    if (root === null) throw new Error('preview.html has no #preview element');
    if (message.bytes.byteLength > SIZE_LIMITS[message.renderer]) throw new RenderFailure('tooLarge');
    root.dataset.renderer = message.renderer;
    const renderFile = await RENDERERS[message.renderer]();
    // A note asks for its images as it finishes, and the window answers only after IPC and a
    // fetch, so the view is here before the first `image` message.
    view = await renderFile(root, message);
    send({ kind: 'rendered' });
  } catch (error) {
    if (!(error instanceof RenderFailure)) console.error('the preview renderer failed', error);
    send({ kind: 'failed', reason: error instanceof RenderFailure ? error.reason : 'renderer' });
  }
}

window.addEventListener('message', (event) => {
  if (event.source !== window.parent || !isWindowMessage(event.data)) return;
  const message = event.data;
  switch (message.kind) {
    case 'render':
      // One file per frame: the window makes a fresh frame for the next one.
      if (started) return;
      started = true;
      void render(message);
      break;
    case 'appearance':
      applyAppearance(message);
      break;
    case 'pdf':
      view?.pdf?.(message);
      break;
    case 'image':
      view?.image?.(message);
      break;
  }
});

installKeys();
installLinks();
send({ kind: 'ready' });
