// The pdf.js worker, bundled inline (`?worker&inline` in pdf.ts): the frame's opaque origin cannot
// start a worker from a URL, so Vite wraps it in a `blob:` URL, which the preview CSP admits with
// `worker-src blob:` (UI architecture §10.4). The worker inherits the frame's CSP: no network, no
// script but its own, WebAssembly only. Loading the module starts pdf.js's worker on `self`.
import 'pdfjs-dist/build/pdf.worker.mjs';
