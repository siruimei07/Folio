// Images a Markdown note shows (UI architecture §10.4; ADR-0005, product decision 1). The frame
// has no network: an image next to the note starts as a placeholder with its alt text, the window
// finds and fetches it, and the frame swaps it in from a `blob:` URL. Images on the web keep their
// placeholder with the address; `data:` images show as they are.

import { type FrameStrings, type ImageMessage, MAX_NOTE_IMAGES, MAX_PATH_CHARS } from '../protocol';
import { send } from './view';

const SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const DATA_IMAGE = /^data:image\/(?:png|jpe?g|gif|webp|avif|bmp)[;,]/i;

type PlaceholderState = 'loading' | 'missing' | 'remote';

function placeholder(alt: string, state: PlaceholderState, note: string): HTMLElement {
  const holder = document.createElement('span');
  holder.className = 'note-image';
  holder.dataset.state = state;
  const name = document.createElement('span');
  name.className = 'note-image__alt';
  name.textContent = alt;
  const status = document.createElement('span');
  status.className = 'note-image__note';
  status.textContent = note;
  holder.append(name, status);
  return holder;
}

function setState(holder: HTMLElement, state: PlaceholderState, note: string): void {
  holder.dataset.state = state;
  const status = holder.querySelector('.note-image__note');
  if (status) status.textContent = note;
}

/**
 * Turns every `<img>` of the sanitised note into what the frame can show, and asks the window for
 * the images next to the note in one `images` message. Returns what shows an image the window
 * sends, or marks it missing.
 */
export function prepareImages(root: ParentNode, strings: FrameStrings): (message: ImageMessage) => void {
  const waiting = new Map<string, HTMLElement[]>();
  for (const image of Array.from(root.querySelectorAll('img'))) {
    const src = image.getAttribute('src')?.trim() ?? '';
    const alt = image.getAttribute('alt') ?? '';
    if (DATA_IMAGE.test(src)) continue;
    if (/^https?:\/\//i.test(src) || src.startsWith('//')) {
      image.replaceWith(placeholder(alt || src, 'remote', `${strings.imageRemote} ${src}`));
      continue;
    }
    const holders = waiting.get(src);
    const unasked = holders === undefined && waiting.size >= MAX_NOTE_IMAGES;
    if (src === '' || SCHEME.test(src) || src.length > MAX_PATH_CHARS || unasked) {
      image.replaceWith(placeholder(alt || src, 'missing', strings.imageMissing));
      continue;
    }
    const holder = placeholder(alt || src, 'loading', strings.imageLoading);
    holder.dataset.alt = alt;
    image.replaceWith(holder);
    if (holders === undefined) waiting.set(src, [holder]);
    else holders.push(holder);
  }
  if (waiting.size > 0) send({ kind: 'images', paths: [...waiting.keys()] });

  return ({ path, image }) => {
    const holders = waiting.get(path);
    if (holders === undefined) return;
    waiting.delete(path);
    if (image === null) {
      for (const holder of holders) setState(holder, 'missing', strings.imageMissing);
      return;
    }
    // The URL lives as long as the frame: the window gives every file a fresh frame.
    const url = URL.createObjectURL(new Blob([image.bytes], { type: image.type }));
    for (const holder of holders) {
      const shown = document.createElement('img');
      shown.alt = holder.dataset.alt ?? '';
      shown.addEventListener(
        'error',
        () => {
          shown.replaceWith(holder);
          setState(holder, 'missing', strings.imageMissing);
        },
        { once: true },
      );
      shown.src = url;
      holder.replaceWith(shown);
    }
  };
}
