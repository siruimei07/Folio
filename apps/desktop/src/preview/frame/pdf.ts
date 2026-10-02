// PDF with pdf.js (UI architecture §10.4): its viewer renders pages lazily with a text layer for
// selection and screen readers; annotations show but cannot be edited; PDF JavaScript never runs
// (no scripting manager) and XFA forms are off. Links show their address and never navigate
// (links.ts); destinations inside the document still work through the link service. The window
// draws the page and zoom pill from `pdfState` and sends `pdf` commands back.

import 'pdfjs-dist/web/pdf_viewer.css';
import './pdf.css';

import * as pdfjs from 'pdfjs-dist';

import { PDF_ZOOM_MAX, PDF_ZOOM_MIN, type PdfCommand } from '../protocol';
import { BUNDLED_URLS, BundledDataFactory } from './pdfData';
import PdfWorker from './pdfWorker?worker&inline';
import { RenderFailure, type RenderFile, send } from './view';

/** How long the worker gets to say it is ready before pdf.js runs on the frame's thread. */
const WORKER_START_MS = 3000;

/** Worker messages are pdf.js's own: `{ sourceName, targetName, action, data }`. */
function isReady(data: unknown): boolean {
  return typeof data === 'object' && data !== null && 'action' in data && data.action === 'ready';
}

/**
 * Starts the bundled worker from its `blob:` URL. If WebView2 refuses it in the sandboxed frame,
 * or it never answers, pdf.js runs on the frame's thread instead (its "fake worker"): the module
 * sets `globalThis.pdfjsWorker`, which pdf.js uses when no worker port is given.
 */
async function startWorker(): Promise<'worker' | 'main thread'> {
  try {
    const worker = new PdfWorker();
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('the pdf.js worker did not start'));
      }, WORKER_START_MS);
      const onMessage = (event: MessageEvent) => {
        if (!isReady(event.data)) return;
        clearTimeout(timer);
        worker.removeEventListener('message', onMessage);
        resolve();
      };
      worker.addEventListener('message', onMessage);
      worker.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new Error('the pdf.js worker failed to load'));
      });
    }).catch((error: unknown) => {
      worker.terminate();
      throw error;
    });
    pdfjs.GlobalWorkerOptions.workerPort = worker;
    return 'worker';
  } catch (error) {
    console.warn('pdf.js runs on the frame thread:', error);
    await import('pdfjs-dist/build/pdf.worker.mjs');
    return 'main thread';
  }
}

function failureOf(error: unknown): RenderFailure {
  if (error instanceof pdfjs.PasswordException) return new RenderFailure('unsupported');
  if (error instanceof pdfjs.InvalidPDFException) return new RenderFailure('corrupt');
  return new RenderFailure('renderer');
}

/** Opens the document once pdf.js has its worker (or runs on this thread). */
async function open(bytes: ArrayBuffer): Promise<{ document: pdfjs.PDFDocumentProxy; thread: string }> {
  const thread = await startWorker();
  try {
    const document = await pdfjs.getDocument({
      data: new Uint8Array(bytes),
      ...BUNDLED_URLS,
      useWorkerFetch: false,
      BinaryDataFactory: BundledDataFactory,
      enableXfa: false,
    }).promise;
    return { document, thread };
  } catch (error) {
    throw failureOf(error);
  }
}

export const renderPdf: RenderFile = async (root, { bytes }) => {
  // pdf_viewer.mjs reads the library from this global when it loads.
  Object.assign(globalThis, { pdfjsLib: pdfjs });
  // The worker parses the file while the viewer's module loads.
  const [{ EventBus, PDFLinkService, PDFViewer, LinkTarget }, { document: document_, thread }] = await Promise.all([
    import('pdfjs-dist/web/pdf_viewer.mjs'),
    open(bytes),
  ]);
  root.dataset.thread = thread;

  const container = document.createElement('div');
  container.className = 'pdf';
  container.tabIndex = 0;
  const pages = document.createElement('div');
  pages.className = 'pdfViewer';
  container.append(pages);
  root.replaceChildren(container);

  const eventBus = new EventBus();
  const linkService = new PDFLinkService({ eventBus, externalLinkTarget: LinkTarget.NONE });
  const viewer = new PDFViewer({
    container,
    viewer: pages,
    eventBus,
    linkService,
    textLayerMode: 1,
    annotationMode: pdfjs.AnnotationMode.ENABLE,
    annotationEditorMode: pdfjs.AnnotationEditorType.DISABLE,
  });
  linkService.setViewer(viewer);

  // pdf.js reports a preset zoom again on every refit; the window hears only changes.
  let last = '';
  const report = () => {
    const state = {
      page: viewer.currentPageNumber,
      pages: viewer.pagesCount,
      percent: Math.round(viewer.currentScale * 100),
    };
    const key = `${String(state.page)} ${String(state.pages)} ${String(state.percent)}`;
    if (key === last) return;
    last = key;
    send({ kind: 'pdfState', ...state });
  };
  const firstPage = new Promise<void>((resolve) => {
    eventBus.on('pagesinit', () => {
      // The panel's width, but no larger than 125 %, and a whole slide when pages are landscape.
      viewer.currentScaleValue = 'auto';
      report();
    });
    // A render a zoom or resize cancelled is redone; a page that fails shows pdf.js's own error
    // and the rest of the document still reads, so the file counts as shown.
    eventBus.on('pagerendered', ({ error }: { error: unknown }) => {
      if (!(error instanceof pdfjs.RenderingCancelledException)) resolve();
    });
  });
  eventBus.on('pagechanging', report);
  eventBus.on('scalechanging', report);
  viewer.setDocument(document_);
  linkService.setDocument(document_, null);

  // A preset zoom follows the pane's size, as pdf.js's own viewer does on resize.
  let refit = 0;
  new ResizeObserver(() => {
    cancelAnimationFrame(refit);
    refit = requestAnimationFrame(() => {
      const preset = viewer.currentScaleValue;
      if (preset === 'auto' || preset === 'page-width') viewer.currentScaleValue = preset;
    });
  }).observe(container);
  await firstPage;

  return {
    pdf: ({ goToPage, zoom }: PdfCommand) => {
      if (goToPage !== undefined) viewer.currentPageNumber = Math.min(goToPage, viewer.pagesCount);
      if (zoom === 'fit-width') viewer.currentScaleValue = 'page-width';
      else if (zoom !== undefined) viewer.currentScale = Math.min(PDF_ZOOM_MAX, Math.max(PDF_ZOOM_MIN, zoom)) / 100;
    },
  };
};
