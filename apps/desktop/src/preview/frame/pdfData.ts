// pdf.js's CMaps (Chinese, Japanese and Korean text), standard fonts and wasm decoders without a
// network (UI architecture §10.4): the frame's CSP has no `connect-src`, so pdf.js cannot fetch
// them. Each file is bundled as its own lazily imported module holding a `data:` URL (`import()`
// is `script-src 'self'`), and this factory hands pdf.js the bytes when its worker asks.

type Loader = () => Promise<string>;

const GLOBS = {
  cMapUrl: import.meta.glob<string>('../../../node_modules/pdfjs-dist/cmaps/*.bcmap', {
    query: '?url&inline',
    import: 'default',
  }),
  standardFontDataUrl: import.meta.glob<string>(
    ['../../../node_modules/pdfjs-dist/standard_fonts/*.pfb', '../../../node_modules/pdfjs-dist/standard_fonts/*.ttf'],
    { query: '?url&inline', import: 'default' },
  ),
  // JPEG 2000, JBIG2 and ICC colour; not quickjs-eval.wasm, which runs PDF JavaScript (never here).
  wasmUrl: import.meta.glob<string>('../../../node_modules/pdfjs-dist/wasm/{openjpeg,jbig2,qcms_bg}.wasm', {
    query: '?url&inline',
    import: 'default',
  }),
};

type Kind = keyof typeof GLOBS;

/** Loaders by kind and file name ("UniGB-UCS2-H.bcmap"). */
const FILES = new Map<Kind, Map<string, Loader>>(
  (Object.keys(GLOBS) as Kind[]).map((kind) => [
    kind,
    new Map(Object.entries(GLOBS[kind]).map(([path, load]) => [path.slice(path.lastIndexOf('/') + 1), load])),
  ]),
);

/** The URLs pdf.js is given; only this factory reads them, and only their file names count. */
export const BUNDLED_URLS = {
  cMapUrl: 'bundled:cmaps/',
  standardFontDataUrl: 'bundled:standard_fonts/',
  wasmUrl: 'bundled:wasm/',
};

function bytesOf(dataUrl: string): Uint8Array {
  const comma = dataUrl.indexOf(',');
  const header = dataUrl.slice(0, comma);
  const body = dataUrl.slice(comma + 1);
  if (header.endsWith(';base64')) {
    const binary = atob(body);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
    return bytes;
  }
  return new TextEncoder().encode(decodeURIComponent(body));
}

/** pdf.js's `BinaryDataFactory`: `useWorkerFetch: false` routes every request here. */
export class BundledDataFactory {
  async fetch({ kind, filename }: { kind: string; filename: string }): Promise<Uint8Array> {
    const load = FILES.get(kind as Kind)?.get(filename);
    if (load === undefined) throw new Error(`pdf.js asked for ${kind} ${filename}, which is not bundled`);
    return bytesOf(await load());
  }
}
