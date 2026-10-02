// The frame's renderers in jsdom: decoding, the sanitiser, highlighting, image placeholders, links
// and keys. Everything that needs WebView2 (pdf.js, MathML layout, the CSP) is in e2e.
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { FrameMessage, FrameStrings, RenderMessage } from '../protocol';
import { decodeText, lineCount } from './decode';
import { installKeys } from './keys';
import { installLinks } from './links';
import { renderMarkdown } from './markdown';
import { renderText } from './text';

const strings: FrameStrings = {
  title: 'Preview',
  imageLoading: 'Loading image…',
  imageMissing: 'Not found',
  imageRemote: 'On the web:',
  code: 'Contents of the file',
};

function message(text: string | Uint8Array, renderer: RenderMessage['renderer'], language: string | null = null): RenderMessage {
  const bytes = typeof text === 'string' ? new TextEncoder().encode(text) : text;
  return {
    kind: 'render',
    renderer,
    bytes: bytes.slice().buffer,
    language,
    theme: 'light',
    reduceMotion: false,
    strings,
  };
}

/**
 * Catches what the frame sends to the window (in jsdom the window is its own parent); the
 * returned function lists it.
 */
function capture(): () => FrameMessage[] {
  const post = vi.spyOn(window, 'postMessage').mockImplementation(() => undefined);
  return () => post.mock.calls.map(([data]) => data as FrameMessage);
}

function root(): HTMLElement {
  const element = document.createElement('main');
  document.body.replaceChildren(element);
  return element;
}

afterEach(() => {
  document.body.replaceChildren();
});

describe('decodeText', () => {
  it('reads UTF-8, UTF-16 with a byte order mark, and GBK as GB18030', () => {
    expect(decodeText(new TextEncoder().encode('线性代数\r\nnotes\r').buffer)).toBe('线性代数\nnotes\n');
    expect(decodeText(new Uint8Array([0xff, 0xfe, 0x41, 0x00, 0x42, 0x00]).buffer)).toBe('AB');
    expect(decodeText(new Uint8Array([0xfe, 0xff, 0x00, 0x41]).buffer)).toBe('A');
    expect(decodeText(new Uint8Array([0xef, 0xbb, 0xbf, 0x41]).buffer)).toBe('A');
    // "线性代数" in GBK.
    expect(decodeText(new Uint8Array([0xcf, 0xdf, 0xd0, 0xd4, 0xb4, 0xfa, 0xca, 0xfd]).buffer)).toBe('线性代数');
  });

  it('refuses binary content behind a text extension', () => {
    expect(decodeText(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00]).buffer)).toBeNull();
  });

  it('counts lines without the final line break', () => {
    expect(lineCount('')).toBe(1);
    expect(lineCount('a')).toBe(1);
    expect(lineCount('a\n')).toBe(1);
    expect(lineCount('a\nb')).toBe(2);
    expect(lineCount('a\n\n')).toBe(2);
  });
});

describe('renderText', () => {
  it('numbers the lines and highlights code by its language', async () => {
    const element = root();
    await renderText(element, message('import math\nprint(math.pi)\n', 'code', 'python'));
    expect(element.querySelector('.lines__gutter')?.textContent).toBe('1\n2');
    expect(element.querySelector('.lines__gutter')?.getAttribute('aria-hidden')).toBe('true');
    expect(element.querySelector('.lines__text')?.getAttribute('aria-label')).toBe(strings.code);
    expect(element.querySelector('.hljs-keyword')?.textContent).toBe('import');
  });

  it('loads grammars outside the common set on demand', async () => {
    const element = root();
    await renderText(element, message('function y = f(x)\n  y = x;\nend\n', 'code', 'matlab'));
    expect(element.querySelector('.hljs-keyword')?.textContent).toBe('function');
  });

  it('shows text as text, markup included, and refuses binary files', async () => {
    const element = root();
    await renderText(element, message('<img src=x onerror=alert(1)>', 'text'));
    expect(element.querySelector('img')).toBeNull();
    expect(element.querySelector('.lines__text')?.textContent).toBe('<img src=x onerror=alert(1)>');
    await expect(renderText(root(), message(new Uint8Array([1, 0, 2]), 'text'))).rejects.toMatchObject({
      reason: 'unsupported',
    });
  });
});

describe('renderMarkdown', () => {
  it('renders maths as MathML, tables, highlighted fences and raw HTML a note may use', async () => {
    capture();
    const element = root();
    await renderMarkdown(
      element,
      message(
        '# Title\n\n$\\mathbb{R}^n$ and\n\n$$\\begin{pmatrix} 1 & 2 \\\\ 3 & 4 \\end{pmatrix}$$\n\n' +
          '```python\ndef f():\n    pass\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\nH<sub>2</sub>O <details><summary>Hint</summary>Use x.</details> ~~old~~\n',
        'markdown',
      ),
    );
    expect(element.querySelector('h1')?.textContent).toBe('Title');
    expect(element.querySelectorAll('math')).toHaveLength(2);
    expect(element.querySelector('math mtable')).not.toBeNull();
    expect(element.querySelector('code .hljs-keyword')?.textContent).toBe('def');
    expect(element.querySelector('table')).not.toBeNull();
    expect(element.querySelector('sub')?.textContent).toBe('2');
    expect(element.querySelector('details summary')?.textContent).toBe('Hint');
    expect(element.querySelector('s')?.textContent).toBe('old');
  });

  it('removes script, handlers, frames, forms and unsafe addresses', async () => {
    capture();
    const element = root();
    await renderMarkdown(
      element,
      message(
        '<script>window.ran = true</script><img src="data:image/png;base64,iVBORw0KGgo=" onerror="window.ran = true">' +
          '<iframe src="https://example.com"></iframe><form action="https://example.com"><input name="q"><button>Go</button></form>' +
          '<object data="x.swf"></object><embed src="x.swf"><style>body{display:none}</style><meta http-equiv="refresh" content="0">' +
          '<a href="javascript:alert(1)">js</a> <a href="file:///C:/Windows">file</a> <a href="https://example.com/x" target="_blank">web</a>\n\n' +
          '[md](javascript:alert(1)) <svg><script>alert(1)</script></svg>\n',
        'markdown',
      ),
    );
    for (const selector of ['script', 'iframe', 'form', 'input', 'button', 'object', 'embed', 'style', 'meta', 'svg']) {
      expect(element.querySelector(selector), selector).toBeNull();
    }
    expect(element.querySelector('[onerror]')).toBeNull();
    expect(element.querySelector('[target]')).toBeNull();
    const hrefs = Array.from(element.querySelectorAll('a'), (link) => link.getAttribute('href'));
    expect(hrefs).toEqual([null, null, 'https://example.com/x']);
    expect(element.querySelector('a[href]')?.getAttribute('title')).toBe('https://example.com/x');
    expect((window as unknown as { ran?: boolean }).ran).toBeUndefined();
  });

  it('asks the window for the images next to the note and swaps them in', async () => {
    const sent = capture();
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:frame/1');
    const element = root();
    const view = await renderMarkdown(
      element,
      message('![Circle](figure.png) ![Again](figure.png) ![Gone](images/gone.png) ![Web](https://example.com/a.png) ![](file:///C:/a.png)\n', 'markdown'),
    );
    expect(sent()).toEqual([{ kind: 'images', paths: ['figure.png', 'images/gone.png'] }]);
    expect(element.querySelector('[data-state="remote"]')?.textContent).toContain('https://example.com/a.png');
    expect(element.querySelectorAll('[data-state="loading"]')).toHaveLength(3);

    view.image?.({ kind: 'image', path: 'figure.png', image: { bytes: new ArrayBuffer(8), type: 'image/png' } });
    view.image?.({ kind: 'image', path: 'images/gone.png', image: null });
    expect(Array.from(element.querySelectorAll('img'), (image) => [image.alt, image.getAttribute('src')])).toEqual([
      ['Circle', 'blob:frame/1'],
      ['Again', 'blob:frame/1'],
    ]);
    expect(element.querySelectorAll('[data-state="missing"]')).toHaveLength(1);
    // A path the frame never asked for changes nothing.
    view.image?.({ kind: 'image', path: 'other.png', image: { bytes: new ArrayBuffer(8), type: 'image/png' } });
    expect(element.querySelectorAll('img')).toHaveLength(2);
  });
});

describe('links and keys', () => {
  installLinks();
  installKeys();

  it('cancels link clicks and tells the window the address', () => {
    const sent = capture();
    const element = root();
    element.innerHTML = '<a href="https://example.com/syllabus">syllabus</a>';
    const link = element.querySelector('a');
    const click = new MouseEvent('click', { bubbles: true, cancelable: true });
    link?.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(true);
    expect(sent()).toEqual([
      { kind: 'link', href: 'https://example.com/syllabus', rect: { x: 0, y: 0, width: 0, height: 0 } },
    ]);
  });

  it('scrolls to a fragment inside a note without telling the window', () => {
    const sent = capture();
    const element = root();
    element.innerHTML = '<article class="note"><h2 id="part-2">Part 2</h2><a href="#part-2">down</a></article>';
    const target = element.querySelector('h2');
    if (target === null) throw new Error('no heading');
    const scroll = vi.fn();
    target.scrollIntoView = scroll;
    const click = new MouseEvent('click', { bubbles: true, cancelable: true });
    element.querySelector('a')?.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(true);
    expect(scroll).toHaveBeenCalled();
    expect(sent()).toEqual([]);
  });

  it('forwards the window’s shortcuts and Esc, and keeps copy and typing', () => {
    const sent = capture();
    const press = (init: KeyboardEventInit) => {
      const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
      window.dispatchEvent(event);
      return event.defaultPrevented;
    };
    expect(press({ key: 'k', ctrlKey: true })).toBe(true);
    expect(press({ key: 'Escape' })).toBe(true);
    expect(press({ key: 'c', ctrlKey: true })).toBe(false);
    expect(press({ key: 'ArrowDown', ctrlKey: true })).toBe(false);
    expect(press({ key: 'a' })).toBe(false);
    expect(press({ key: 'k', ctrlKey: true, isComposing: true })).toBe(false);
    expect(sent().map((message) => (message.kind === 'shortcut' ? message.press.key : message.kind))).toEqual([
      'k',
      'Escape',
    ]);
  });
});
