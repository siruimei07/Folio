import { describe, expect, it } from 'vitest';

import { isFrameMessage, isWindowMessage, MAX_NOTE_IMAGES, MAX_PATH_CHARS } from './protocol';

const strings = { title: 'Preview of a.md', imageLoading: 'Loading', imageMissing: 'Missing', imageRemote: 'Web', code: 'Contents' };
const render = {
  kind: 'render',
  renderer: 'markdown',
  bytes: new ArrayBuffer(4),
  language: null,
  theme: 'dark',
  reduceMotion: false,
  strings,
};

describe('window → frame messages', () => {
  it('accepts each message as the window sends it', () => {
    expect(isWindowMessage(render)).toBe(true);
    expect(isWindowMessage({ ...render, renderer: 'code', language: 'python' })).toBe(true);
    expect(isWindowMessage({ kind: 'appearance', theme: 'light', reduceMotion: true })).toBe(true);
    expect(isWindowMessage({ kind: 'pdf', goToPage: 3 })).toBe(true);
    expect(isWindowMessage({ kind: 'pdf', zoom: 'fit-width' })).toBe(true);
    expect(isWindowMessage({ kind: 'pdf', zoom: 150 })).toBe(true);
    expect(isWindowMessage({ kind: 'image', path: 'a.png', image: { bytes: new ArrayBuffer(1), type: 'image/png' } })).toBe(true);
    expect(isWindowMessage({ kind: 'image', path: 'a.png', image: null })).toBe(true);
  });

  it('refuses anything else', () => {
    for (const message of [
      null,
      'render',
      [],
      { ...render, extra: 1 },
      { ...render, renderer: 'html' },
      { ...render, bytes: new Uint8Array(4) },
      { ...render, theme: 'sepia' },
      { kind: 'appearance', theme: 'light', reduceMotion: 'yes' },
      { kind: 'pdf', zoom: 'fit-page' },
      { ...render, strings: { ...strings, title: '' } },
      { ...render, strings: { ...strings, more: 'x' } },
      { kind: 'pdf', goToPage: 0 },
      { kind: 'pdf', zoom: 5000 },
      { kind: 'pdf', zoom: 1.5 },
      { kind: 'image', path: '', image: null },
      { kind: 'image', path: 'a'.repeat(MAX_PATH_CHARS + 1), image: null },
      { kind: 'image', path: 'a.svg', image: { bytes: new ArrayBuffer(1), type: 'text/html' } },
      { kind: 'nope' },
    ]) {
      expect(isWindowMessage(message), JSON.stringify(message)).toBe(false);
    }
  });
});

describe('frame → window messages', () => {
  it('accepts each message as the frame sends it', () => {
    expect(isFrameMessage({ kind: 'ready' })).toBe(true);
    expect(isFrameMessage({ kind: 'rendered' })).toBe(true);
    expect(isFrameMessage({ kind: 'failed', reason: 'corrupt' })).toBe(true);
    expect(isFrameMessage({ kind: 'pdfState', page: 1, pages: 4, percent: 100 })).toBe(true);
    expect(isFrameMessage({ kind: 'images', paths: ['a.png', 'images/b.png'] })).toBe(true);
    expect(
      isFrameMessage({ kind: 'link', href: 'https://example.com/', rect: { x: 1, y: 2, width: 30, height: 12 } }),
    ).toBe(true);
    expect(
      isFrameMessage({
        kind: 'shortcut',
        press: { key: 'k', ctrlKey: true, shiftKey: false, altKey: false, metaKey: false },
      }),
    ).toBe(true);
  });

  it('refuses malformed, oversized and repeated content', () => {
    for (const message of [
      { kind: 'ready', extra: true },
      { kind: 'failed', reason: 'boom' },
      { kind: 'pdfState', page: -1, pages: 4, percent: 100 },
      { kind: 'pdfState', page: 1.5, pages: 4, percent: 100 },
      { kind: 'images', paths: Array.from({ length: MAX_NOTE_IMAGES + 1 }, (_, index) => `${String(index)}.png`) },
      { kind: 'images', paths: ['a.png', 'a.png'] },
      { kind: 'images', paths: [42] },
      { kind: 'link', href: '', rect: { x: 0, y: 0, width: 1, height: 1 } },
      { kind: 'link', href: 'https://example.com/', rect: { x: Number.NaN, y: 0, width: 1, height: 1 } },
      { kind: 'link', href: 'https://example.com/', rect: { x: 0, y: 0, width: 1 } },
      { kind: 'shortcut', press: { key: 'k', ctrlKey: 'yes', shiftKey: false, altKey: false, metaKey: false } },
      // Only Esc and the shape of the window's shortcuts: not Delete, not Ctrl+C, not Ctrl+arrows.
      { kind: 'shortcut', press: { key: 'Delete', ctrlKey: false, shiftKey: false, altKey: false, metaKey: false } },
      { kind: 'shortcut', press: { key: 'c', ctrlKey: true, shiftKey: false, altKey: false, metaKey: false } },
      { kind: 'shortcut', press: { key: 'ArrowDown', ctrlKey: true, shiftKey: false, altKey: false, metaKey: false } },
      { kind: 'shortcut', press: { key: 'k', ctrlKey: true, shiftKey: false, altKey: false, metaKey: true } },
    ]) {
      expect(isFrameMessage(message), JSON.stringify(message)).toBe(false);
    }
  });
});
