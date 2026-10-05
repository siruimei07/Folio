// URLs of the shell's read-only `folio-file` scheme (docs/specs/ipc-m1.md §11.2, ipc-m2.md §11),
// which serves file bytes, thumbnails and stored versions for previews: they never travel in IPC
// messages.
import { type EntryRef, FILE_ERROR_CODES, FILE_ERROR_HEADER } from './bindings';
import { hexOf } from './ids';

const ORIGIN = 'http://folio-file.localhost';

/** Thumbnail sizes the scheme serves, in pixels. */
export const THUMBNAIL_SIZES = [64, 128, 256] as const;
export type ThumbnailSize = (typeof THUMBNAIL_SIZES)[number];

/** An `AppError` code a failed `folio-file` response names; each has its message in `errors`. */
export type FileErrorCode = (typeof FILE_ERROR_CODES)[number];

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

/**
 * The bytes of a stored version in history (`VersionSide.hash` of a version that is stored and
 * not pruned). `name` is the file's name, which gives the content type.
 */
export function versionUrl(version: { hash: string }, name: string): string {
  return `${ORIGIN}/version/${hexOf(version.hash)}/${encodeURIComponent(name)}`;
}

/**
 * Why a `folio-file` request failed: `null` when it did not. A failure without a code the scheme
 * sends is `Internal`. `<img>`, `<audio>` and `<video>` cannot read their response: after their
 * `error` event, ask again with `fetch(url, { method: 'HEAD' })`. A `fetch` that rejects never
 * reached the scheme, which is a `Transport` error.
 */
export function fileError(response: Response): FileErrorCode | null {
  if (response.ok) return null;
  const code = response.headers.get(FILE_ERROR_HEADER);
  return FILE_ERROR_CODES.find((known) => known === code) ?? 'Internal';
}
