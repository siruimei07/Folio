import { act, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { registerShortcut } from '../app/shortcuts';
import { PREVIEW_URL, PreviewFrame, type PreviewFrameProps, READY_TIMEOUT_MS, RENDER_TIMEOUT_MS } from './PreviewFrame';
import type { FrameMessage } from './protocol';

const strings = { title: 'Preview of a.md', imageLoading: 'Loading', imageMissing: 'Missing', imageRemote: 'Web', code: 'Contents' };

function setUp(overrides: Partial<PreviewFrameProps> = {}) {
  const props: PreviewFrameProps = {
    renderer: 'markdown',
    language: null,
    bytes: new ArrayBuffer(3),
    strings,
    onRendered: vi.fn(),
    onFailed: vi.fn(),
    onPdfState: vi.fn(),
    onImages: vi.fn(),
    onLink: vi.fn(),
    onEscape: vi.fn(),
    ...overrides,
  };
  const view = render(<PreviewFrame {...props} />);
  const frame = view.container.querySelector('iframe');
  if (frame?.contentWindow == null) throw new Error('no frame window');
  const target = frame.contentWindow;
  const posted = vi.spyOn(target, 'postMessage').mockImplementation(() => undefined);
  /** A message as the frame would send it; `origin` and `source` decide whether it counts. */
  const send = (data: FrameMessage | Record<string, unknown>, from: { origin?: string; source?: Window | null } = {}) => {
    act(() => {
      window.dispatchEvent(new MessageEvent('message', { data, origin: from.origin ?? 'null', source: from.source ?? target }));
    });
  };
  return { props, frame, posted, send, ...view };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('PreviewFrame', () => {
  it('is a frame sandboxed to scripts alone, on the preview scheme, named after the file', () => {
    const { frame } = setUp();
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts');
    expect(frame.getAttribute('src')).toBe(PREVIEW_URL);
    expect(frame.title).toBe('Preview of a.md');
  });

  it('sends the file once the frame is ready, and only once', () => {
    const bytes = new ArrayBuffer(3);
    const { send, posted, props } = setUp({ bytes, renderer: 'code', language: 'python' });
    send({ kind: 'ready' });
    send({ kind: 'ready' });
    expect(posted).toHaveBeenCalledTimes(1);
    expect(posted).toHaveBeenCalledWith(
      { kind: 'render', renderer: 'code', bytes, language: 'python', strings, theme: 'light', reduceMotion: false },
      '*',
      [bytes],
    );
    send({ kind: 'rendered' });
    expect(props.onRendered).toHaveBeenCalledTimes(1);
  });

  it('starts before the bytes are here and sends them when both are ready', () => {
    const bytes = new ArrayBuffer(3);
    const { send, posted, rerender, props } = setUp({ bytes: null });
    send({ kind: 'ready' });
    expect(posted).not.toHaveBeenCalled();
    rerender(<PreviewFrame {...props} bytes={bytes} />);
    expect(posted).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ kind: 'render', bytes }), '*', [bytes]);
  });

  it('ignores messages from other windows, other origins and of the wrong shape', () => {
    const { send, posted, props } = setUp();
    send({ kind: 'ready' }, { source: window });
    send({ kind: 'ready' }, { origin: 'http://tauri.localhost' });
    send({ kind: 'ready', extra: 1 });
    send({ kind: 'link', href: 'x'.repeat(3000), rect: { x: 0, y: 0, width: 1, height: 1 } });
    expect(posted).not.toHaveBeenCalled();
    expect(props.onLink).not.toHaveBeenCalled();
  });

  it('takes images only from a note', () => {
    const { send, props } = setUp({ renderer: 'pdf' });
    send({ kind: 'ready' });
    send({ kind: 'images', paths: ['a.png'] });
    expect(props.onImages).not.toHaveBeenCalled();
  });

  it('passes PDF state, links, failures and one images message to the pane', () => {
    const { send, props } = setUp();
    send({ kind: 'ready' });
    send({ kind: 'pdfState', page: 2, pages: 9, percent: 125 });
    send({ kind: 'link', href: 'https://example.com/', rect: { x: 1, y: 2, width: 3, height: 4 } });
    send({ kind: 'images', paths: ['a.png'] });
    send({ kind: 'images', paths: ['b.png'] });
    send({ kind: 'failed', reason: 'corrupt' });
    send({ kind: 'failed', reason: 'renderer' });
    expect(props.onPdfState).toHaveBeenCalledWith({ page: 2, pages: 9, percent: 125 });
    expect(props.onLink).toHaveBeenCalledWith({ href: 'https://example.com/', rect: { x: 1, y: 2, width: 3, height: 4 } });
    expect(props.onImages).toHaveBeenCalledExactlyOnceWith(['a.png']);
    expect(props.onFailed).toHaveBeenCalledExactlyOnceWith('corrupt');
  });

  it('runs the window’s shortcuts pressed in the frame, and Esc returns focus', () => {
    const run = vi.fn();
    const unregister = registerShortcut({ key: 'k', ctrl: true }, run, { inInputs: true });
    const { send, props } = setUp();
    const press = { ctrlKey: true, shiftKey: false, altKey: false, metaKey: false };
    send({ kind: 'shortcut', press: { key: 'k', ...press } });
    send({ kind: 'shortcut', press: { key: 'Escape', ...press, ctrlKey: false } });
    // Only the shape of a window shortcut counts: not Delete, not keys without Ctrl.
    const other = vi.fn();
    const unregisterOther = registerShortcut({ key: 'Delete' }, other);
    send({ kind: 'shortcut', press: { key: 'Delete', ...press, ctrlKey: false } });
    unregisterOther();
    expect(other).not.toHaveBeenCalled();
    expect(run).toHaveBeenCalledTimes(1);
    expect(props.onEscape).toHaveBeenCalledTimes(1);
    unregister();
  });

  it('fails when the frame does not start or finish in time', () => {
    vi.useFakeTimers();
    const first = setUp();
    act(() => {
      vi.advanceTimersByTime(READY_TIMEOUT_MS);
    });
    expect(first.props.onFailed).toHaveBeenCalledExactlyOnceWith('timeout');
    first.unmount();

    const second = setUp();
    second.send({ kind: 'ready' });
    act(() => {
      vi.advanceTimersByTime(RENDER_TIMEOUT_MS);
    });
    expect(second.props.onFailed).toHaveBeenCalledExactlyOnceWith('timeout');
  });

  it('tells the frame when the window’s theme changes', async () => {
    const { send, posted } = setUp();
    send({ kind: 'ready' });
    document.documentElement.dataset.theme = 'dark';
    await vi.waitFor(() => {
      expect(posted).toHaveBeenLastCalledWith({ kind: 'appearance', theme: 'dark', reduceMotion: false }, '*', []);
    });
    delete document.documentElement.dataset.theme;
  });
});
