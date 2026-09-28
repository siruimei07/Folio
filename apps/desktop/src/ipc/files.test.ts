import { describe, expect, it } from 'vitest';

import { contentUrl, thumbnailUrl } from './files';

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
