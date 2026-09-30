import { describe, expect, it } from 'vitest';

import { FILE_ERROR_HEADER } from './bindings';
import { contentUrl, fileError, thumbnailUrl } from './files';

// The shell's `folio-file` scheme parses these URLs (docs/specs/ipc-m1.md §11.2).
describe('folio-file URLs', () => {
  const entry = { id: '42', path: '2026 秋/MAT232/a#b?c%d.pdf' };

  it('percent-encodes each name as UTF-8 and keeps the slashes between names', () => {
    expect(contentUrl(entry)).toBe(
      'http://folio-file.localhost/content/42/2026%20%E7%A7%8B/MAT232/a%23b%3Fc%25d.pdf',
    );
  });

  it('puts the thumbnail size before the path', () => {
    expect(thumbnailUrl(entry, 128)).toBe(
      'http://folio-file.localhost/thumbnail/42/128/2026%20%E7%A7%8B/MAT232/a%23b%3Fc%25d.pdf',
    );
  });
});

describe('folio-file failures', () => {
  const failed = (status: number, code?: string) =>
    new Response(null, { status, headers: code ? { [FILE_ERROR_HEADER]: code } : {} });

  it('reads the code a failed response names', () => {
    expect(fileError(failed(409, 'InUse'))).toBe('InUse');
    expect(fileError(failed(409, 'NotLocal'))).toBe('NotLocal');
    expect(fileError(failed(404, 'NotFound'))).toBe('NotFound');
  });

  it('treats a failure without a known code as internal', () => {
    expect(fileError(failed(500))).toBe('Internal');
    expect(fileError(failed(404, 'Transport'))).toBe('Internal');
  });

  it('reports nothing for full and partial content', () => {
    expect(fileError(new Response('bytes', { status: 200 }))).toBeNull();
    expect(fileError(new Response('by', { status: 206 }))).toBeNull();
  });
});
