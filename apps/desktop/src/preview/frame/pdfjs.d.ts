// pdf.js ships no types for its worker module; the frame only imports it for its side effect
// (pdfWorker.ts) or, as the fallback, to set `globalThis.pdfjsWorker` (pdf.ts).
declare module 'pdfjs-dist/legacy/build/pdf.worker.mjs';
