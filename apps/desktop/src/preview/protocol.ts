/**
 * Messages between the window and the preview frame (UI architecture §10.3). The frame runs in
 * `<iframe sandbox="allow-scripts">` with an opaque origin and no network, so the window sends it
 * the file's bytes, and the frame answers with what it rendered and what the user did in it.
 *
 * Every message is a tagged object, and each side checks shape and source before acting: the
 * window accepts only messages from its frame's `contentWindow` with origin `"null"`, the frame
 * only messages from `window.parent`. This file is imported by both sides, so it holds no DOM or
 * React code.
 */

/** The renderers that run inside the frame. */
const RENDERERS = ['text', 'code', 'markdown', 'pdf'] as const;
export type Renderer = (typeof RENDERERS)[number];

/** How a PDF is zoomed: to the panel's width, or a percentage. */
export type PdfZoom = 'fit-width' | number;

/** Why the frame could not show a file. */
const FAILURE_REASONS = ['tooLarge', 'unsupported', 'corrupt', 'renderer'] as const;
export type FailureReason = (typeof FAILURE_REASONS)[number];

/** The words the frame shows. It has no UI strings of its own (§3 rule 4), so they come along. */
export interface FrameStrings {
  /** The frame document's title: the file it shows. */
  title: string;
  /** On an image's placeholder while it loads. */
  imageLoading: string;
  /** On the placeholder of an image the library does not have next to the note. */
  imageMissing: string;
  /** On the placeholder of an image on the web, which the frame never loads. */
  imageRemote: string;
  /** Names the text of a text or code file for screen readers; they skip its line numbers. */
  code: string;
}

const FRAME_STRING_KEYS = [
  'title',
  'imageLoading',
  'imageMissing',
  'imageRemote',
  'code',
] as const satisfies readonly (keyof FrameStrings)[];

/** The app's theme and reduced motion, which can differ from Windows' (App settings). */
export interface Appearance {
  theme: 'light' | 'dark';
  reduceMotion: boolean;
}

/** Window → frame: the file to show. Sent once, after `ready`; `bytes` is transferred. */
export interface RenderMessage extends Appearance {
  kind: 'render';
  renderer: Renderer;
  bytes: ArrayBuffer;
  /** The highlight.js language of code, from the extension; `null` otherwise. */
  language: string | null;
  strings: FrameStrings;
}

/** Window → frame: the app's theme or reduced motion changed while the file shows. */
export interface AppearanceMessage extends Appearance {
  kind: 'appearance';
}

/** Window → frame: the PDF pill's buttons. */
export interface PdfCommand {
  kind: 'pdf';
  goToPage?: number;
  zoom?: PdfZoom;
}

/** Window → frame: one image a note names, as it arrives; `null` when there is none to show. */
export interface ImageMessage {
  kind: 'image';
  /** The path exactly as the frame sent it in `images`. */
  path: string;
  image: { bytes: ArrayBuffer; type: string } | null;
}

export type WindowMessage = RenderMessage | AppearanceMessage | PdfCommand | ImageMessage;

/** A rectangle in the frame's viewport, in CSS pixels. */
export interface FrameRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A key press inside the frame that the window owns (§6.4), or Esc (§10.5). */
export interface FramePress {
  key: string;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
}

export type FrameMessage =
  | { kind: 'ready' }
  | { kind: 'rendered' }
  | { kind: 'failed'; reason: FailureReason }
  | { kind: 'pdfState'; page: number; pages: number; percent: number }
  | { kind: 'shortcut'; press: FramePress }
  | { kind: 'images'; paths: string[] }
  | { kind: 'link'; href: string; rect: FrameRect };

/** What a frame message carries besides its kind: `FramePayload<'link'>` is `{ href, rect }`. */
export type FramePayload<K extends FrameMessage['kind']> = Omit<Extract<FrameMessage, { kind: K }>, 'kind'>;

/** Ctrl combinations the frame keeps: copy, select all, and paste and cut, which do nothing there. */
const FRAME_KEYS = new Set(['c', 'a', 'v', 'x']);

/**
 * The presses the frame forwards and the window accepts: Esc, and Ctrl with one character or
 * Enter, the shape of every §6.4 shortcut. Ctrl+arrows, Ctrl+Home and the rest scroll the frame,
 * and a frame that misbehaves can press nothing else in the window.
 */
export function isForwardedPress({ key, ctrlKey, metaKey }: FramePress): boolean {
  if (key === 'Escape') return true;
  return ctrlKey && !metaKey && (key.length === 1 || key === 'Enter') && !FRAME_KEYS.has(key.toLowerCase());
}

/** At most this many images per note get a path in `images`; the rest keep their placeholders. */
export const MAX_NOTE_IMAGES = 64;

/** The longest image path or link address either side passes on. */
export const MAX_PATH_CHARS = 1024;
export const MAX_LINK_CHARS = 2048;

const MB = 1024 * 1024;

/**
 * Bytes beyond which a file shows "too large to preview" (§10.1). The window checks the size it
 * knows before fetching; the frame checks the bytes it got.
 */
export const SIZE_LIMITS: Readonly<Record<Renderer, number>> = {
  text: 5 * MB,
  code: 5 * MB,
  markdown: 2 * MB,
  pdf: 256 * MB,
};

/** The images next to a note the window hands over: per image and per note (§10.4). */
export const IMAGE_LIMITS = { image: 20 * MB, note: 100 * MB } as const;

/** Code up to this size and line count is highlighted; above, it shows as plain text. */
export const HIGHLIGHT_LIMITS = { bytes: MB, lines: 20_000 } as const;

/** PDF zoom bounds, in percent. */
export const PDF_ZOOM_MIN = 25;
export const PDF_ZOOM_MAX = 400;

type Fields = Record<string, unknown>;

function isObject(value: unknown): value is Fields {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Exactly these keys: a message with anything else is not one of ours. */
function hasKeys(value: Fields, required: readonly string[], optional: readonly string[] = []): boolean {
  const keys = Object.keys(value);
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    keys.every((key) => required.includes(key) || optional.includes(key))
  );
}

function isOneOf<T extends string>(value: unknown, options: readonly T[]): value is T {
  return typeof value === 'string' && (options as readonly string[]).includes(value);
}

function isText(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 1_000_000;
}

function isZoom(value: unknown): value is PdfZoom {
  return (
    value === 'fit-width' ||
    (typeof value === 'number' && Number.isInteger(value) && value >= PDF_ZOOM_MIN && value <= PDF_ZOOM_MAX)
  );
}

function isAppearance(value: Fields): boolean {
  return (value.theme === 'light' || value.theme === 'dark') && typeof value.reduceMotion === 'boolean';
}

function isStrings(value: unknown): value is FrameStrings {
  return (
    isObject(value) &&
    hasKeys(value, FRAME_STRING_KEYS) &&
    FRAME_STRING_KEYS.every((key) => isText(value[key], 2000))
  );
}

/** A message the frame accepts from the window. */
export function isWindowMessage(value: unknown): value is WindowMessage {
  if (!isObject(value)) return false;
  switch (value.kind) {
    case 'render':
      return (
        hasKeys(value, ['kind', 'renderer', 'bytes', 'language', 'theme', 'reduceMotion', 'strings']) &&
        isOneOf(value.renderer, RENDERERS) &&
        value.bytes instanceof ArrayBuffer &&
        (value.language === null || isText(value.language, 40)) &&
        isAppearance(value) &&
        isStrings(value.strings)
      );
    case 'appearance':
      return hasKeys(value, ['kind', 'theme', 'reduceMotion']) && isAppearance(value);
    case 'pdf':
      return (
        hasKeys(value, ['kind'], ['goToPage', 'zoom']) &&
        (value.goToPage === undefined || (isCount(value.goToPage) && value.goToPage >= 1)) &&
        (value.zoom === undefined || isZoom(value.zoom))
      );
    case 'image': {
      if (!hasKeys(value, ['kind', 'path', 'image']) || !isText(value.path, MAX_PATH_CHARS)) return false;
      const image = value.image;
      return (
        image === null ||
        (isObject(image) &&
          hasKeys(image, ['bytes', 'type']) &&
          image.bytes instanceof ArrayBuffer &&
          typeof image.type === 'string' &&
          /^image\/[a-z0-9.+-]+$/.test(image.type))
      );
    }
    default:
      return false;
  }
}

function isRect(value: unknown): value is FrameRect {
  return (
    isObject(value) &&
    hasKeys(value, ['x', 'y', 'width', 'height']) &&
    [value.x, value.y, value.width, value.height].every(
      (number) => typeof number === 'number' && Number.isFinite(number) && Math.abs(number) <= 100_000,
    )
  );
}

function isPress(value: unknown): value is FramePress {
  return (
    isObject(value) &&
    hasKeys(value, ['key', 'ctrlKey', 'shiftKey', 'altKey', 'metaKey']) &&
    isText(value.key, 32) &&
    [value.ctrlKey, value.shiftKey, value.altKey, value.metaKey].every((flag) => typeof flag === 'boolean')
  );
}

/** A message the window accepts from its frame. */
export function isFrameMessage(value: unknown): value is FrameMessage {
  if (!isObject(value)) return false;
  switch (value.kind) {
    case 'ready':
    case 'rendered':
      return hasKeys(value, ['kind']);
    case 'failed':
      return hasKeys(value, ['kind', 'reason']) && isOneOf(value.reason, FAILURE_REASONS);
    case 'pdfState':
      return (
        hasKeys(value, ['kind', 'page', 'pages', 'percent']) &&
        isCount(value.page) &&
        isCount(value.pages) &&
        isCount(value.percent)
      );
    case 'shortcut':
      return hasKeys(value, ['kind', 'press']) && isPress(value.press) && isForwardedPress(value.press);
    case 'images':
      return (
        hasKeys(value, ['kind', 'paths']) &&
        Array.isArray(value.paths) &&
        value.paths.length <= MAX_NOTE_IMAGES &&
        value.paths.every((path) => isText(path, MAX_PATH_CHARS)) &&
        new Set(value.paths).size === value.paths.length
      );
    case 'link':
      return hasKeys(value, ['kind', 'href', 'rect']) && isText(value.href, MAX_LINK_CHARS) && isRect(value.rect);
    default:
      return false;
  }
}
