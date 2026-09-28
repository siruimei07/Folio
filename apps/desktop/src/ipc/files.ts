// URLs of the shell's read-only `folio-file` scheme (docs/specs/ipc-m1.md §11.2), which serves
// file bytes and thumbnails for previews: they never travel in IPC messages. The preview lane
// implements the scheme; until then these URLs load nothing.
import type { EntryRef } from './bindings';

const ORIGIN = 'http://folio-file.localhost';

/** Thumbnail sizes the scheme serves, in pixels. */
export const THUMBNAIL_SIZES = [64, 128, 256] as const;
export type ThumbnailSize = (typeof THUMBNAIL_SIZES)[number];

/** The entry's path with each name percent-encoded as UTF-8, `/` kept between them. */
function encodePath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/');
}

/** The file's bytes. The scheme answers `Range` requests, for audio, video and PDF. */
export function contentUrl(entry: EntryRef): string {
  return `${ORIGIN}/content/${encodeURIComponent(entry.id)}/${encodePath(entry.path)}`;
}

/** A PNG thumbnail of the file. */
export function thumbnailUrl(entry: EntryRef, size: ThumbnailSize): string {
  return `${ORIGIN}/thumbnail/${encodeURIComponent(entry.id)}/${String(size)}/${encodePath(entry.path)}`;
}
