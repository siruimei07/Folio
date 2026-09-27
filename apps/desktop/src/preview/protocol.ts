/**
 * Messages between the window and the preview frame. The frame runs in
 * `<iframe sandbox="allow-scripts">` with an opaque origin and no network, so the window sends
 * it the file's bytes and the frame answers once it has rendered them.
 */

/** Window → frame: a file to show. */
export interface PreviewRequest {
  kind: 'text';
  bytes: ArrayBuffer;
}

/** Frame → window. */
export interface PreviewResponse {
  kind: 'rendered';
}

export function isPreviewRequest(value: unknown): value is PreviewRequest {
  return (
    typeof value === 'object' &&
    value !== null &&
    'kind' in value &&
    value.kind === 'text' &&
    'bytes' in value &&
    value.bytes instanceof ArrayBuffer
  );
}
