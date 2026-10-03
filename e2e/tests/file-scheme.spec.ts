import { mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { Frame, Page } from '@playwright/test';

import type { AppError, CatalogChanged, EntryRef, FolderChoice, Job, LibraryOpened } from '../../apps/desktop/src/ipc/bindings';
import { expect, invoke, test } from '../fixtures';

test.use({ libraryFolder: true });

const host = 'http://folio-file.localhost';
const encoded = (entry: EntryRef) => `${entry.id}/${entry.path.split('/').map(encodeURIComponent).join('/')}`;

interface Reply {
  status: number;
  code: string | null;
  range: string | null;
  bytes: number[];
  text: string;
  headers: Record<string, string>;
}

async function fetchFile(page: Page, url: string, method = 'GET', headers: Record<string, string> = {}): Promise<Reply> {
  const [received, reply] = await Promise.all([
    page.waitForResponse((response) => response.url() === url && response.request().method() === method),
    page.evaluate<Omit<Reply, 'headers'>>(`(async () => {
    const response = await fetch(${JSON.stringify(url)}, ${JSON.stringify({ method, headers })});
    const bytes = await response.arrayBuffer();
    return { status: response.status, code: response.headers.get('X-Folio-Error'),
      range: response.headers.get('Content-Range'), bytes: Array.from(new Uint8Array(bytes)),
      text: new TextDecoder().decode(bytes) };
  })()`),
  ]);
  return { ...reply, headers: await received.allHeaders() };
}

function inert(reply: Reply): void {
  expect(reply.headers['content-security-policy']).toBe("sandbox; default-src 'none'");
  expect(reply.headers['x-content-type-options']).toBe('nosniff');
  expect(reply.headers['cache-control']).toBe('no-store');
  expect(reply.headers['access-control-allow-origin']).toBe('http://tauri.localhost');
  expect(reply.headers['access-control-expose-headers']).toContain('X-Folio-Error');
}

async function reference(page: Page, name: string): Promise<EntryRef> {
  const find = async () => (await page.evaluate<CatalogChanged[]>('window.__folioFileEvents'))
    .flatMap((event) => event.entries).findLast((change) => change.kind === 'added' && change.entry.path === name)?.entry;
  await expect.poll(find).toBeDefined();
  const entry = await find();
  if (!entry) throw new Error(`No catalogued file ${name}`);
  return entry;
}

function bmp(): Buffer {
  const bytes = Buffer.alloc(70);
  bytes.write('BM');
  bytes.writeUInt32LE(70, 2);
  bytes.writeUInt32LE(54, 10);
  bytes.writeUInt32LE(40, 14);
  bytes.writeInt32LE(2, 18);
  bytes.writeInt32LE(2, 22);
  bytes.writeUInt16LE(1, 26);
  bytes.writeUInt16LE(24, 28);
  bytes.writeUInt32LE(16, 34);
  for (const start of [54, 57, 62, 65]) bytes[start + 2] = 255;
  return bytes;
}

async function preview(page: Page): Promise<Frame> {
  const url = 'http://folio-preview.localhost/preview.html';
  await page.evaluate(`new Promise((resolve) => {
    const frame = document.createElement('iframe');
    frame.sandbox.add('allow-scripts'); frame.src = ${JSON.stringify(url)};
    frame.addEventListener('load', resolve, { once: true }); document.body.append(frame);
  })`);
  const frame = page.frames().find((candidate) => candidate.url() === url);
  if (!frame) throw new Error('No sandboxed preview frame');
  return frame;
}

test('serves confined bytes and hash thumbnails while the opaque preview cannot load the scheme', async ({ folio }) => {
  test.setTimeout(90_000);
  const { page, libraryDir, dataDir } = folio;
  if (!libraryDir) throw new Error('This test requires a disposable library');
  const unavailable = await fetchFile(page, `${host}/content/1/missing.txt`);
  expect(unavailable).toMatchObject({ status: 503, code: 'NoLibrary', bytes: [] });
  inert(unavailable);
  await page.evaluate(`(async () => {
    window.__folioFileEvents = [];
    const { invoke, transformCallback } = window.__TAURI_INTERNALS__;
    await invoke('plugin:event|listen', { event: 'catalog-changed', target: { kind: 'Any' },
      handler: transformCallback(event => window.__folioFileEvents.push(event.payload)) });
  })()`);
  const choice = await invoke<FolderChoice | null>(page, 'pick_library_folder');
  if (!choice) throw new Error('The test folder choice was cancelled');
  const opened = await invoke<LibraryOpened>(page, 'create_library', { request: {
    folder: choice.token, name: 'File scheme library',
    presetTags: { notes: 'Notes', slides: 'Slides', homework: 'Homework', exam: 'Exam', reference: 'Reference' },
  } });
  await expect.poll(async () => (await invoke<Job[]>(page, 'list_jobs')).find((job) => job.id === opened.scan))
    .toMatchObject({ status: { state: 'done' } });
  const name = '笔记 #%.txt';
  await writeFile(path.join(libraryDir, name), '0123456789');
  const entry = await reference(page, name);
  const url = `${host}/content/${encoded(entry)}`;
  const whole = await fetchFile(page, url);
  expect(whole).toMatchObject({ status: 200, code: null, text: '0123456789' });
  inert(whole);
  for (const [range, text, contentRange] of [
    ['bytes=2-4', '234', 'bytes 2-4/10'], ['bytes=7-', '789', 'bytes 7-9/10'],
  ] as const) {
    const partial = await fetchFile(page, url, 'GET', { Range: range });
    expect(partial).toMatchObject({ status: 206, code: null, text, range: contentRange });
    inert(partial);
  }
  // Fetch requires OPTIONS for a suffix Range. The contract permits only GET/HEAD;
  // browser callers use a closed/open range, while Rust tests cover suffix parsing.
  const suffix = await page.evaluate<string>(`fetch(${JSON.stringify(url)}, { headers: { Range: 'bytes=-2' } })
    .then(() => 'loaded', () => 'blocked')`);
  expect(suffix).toBe('blocked');
  const head = await fetchFile(page, url, 'HEAD');
  expect(head).toMatchObject({ status: 200, code: null, bytes: [] });
  expect(head.headers['content-length']).toBe('10');
  const outside = await fetchFile(page, url, 'GET', { Range: 'bytes=10-' });
  expect(outside).toMatchObject({ status: 416, code: 'InvalidArgument', bytes: [], range: 'bytes */10' });
  inert(outside);
  for (const [otherUrl, status, code] of [
    [`${host}/content/${entry.id}/wrong.txt`, 404, 'NotFound'],
    [`${host}/content/${entry.id}/.folio/library.json`, 404, 'NotFound'],
    [`${host}/content/${entry.id}/a%2Fescape.txt`, 400, 'InvalidArgument'],
    [`${host}/thumbnail/${entry.id}/32/${encodeURIComponent(name)}`, 400, 'InvalidArgument'],
  ] as const) {
    const failed = await fetchFile(page, otherUrl);
    expect(failed).toMatchObject({ status, code, bytes: [] });
    inert(failed);
  }
  expect(await fetchFile(page, url, 'POST')).toMatchObject({ status: 405, code: 'InvalidArgument', bytes: [] });
  await mkdir(path.join(libraryDir, 'folder'));
  const folder = await reference(page, 'folder');
  expect(await fetchFile(page, `${host}/content/${encoded(folder)}`))
    .toMatchObject({ status: 404, code: 'NotFound', bytes: [] });

  await writeFile(path.join(libraryDir, 'image.bmp'), bmp());
  await writeFile(path.join(libraryDir, 'identical.bmp'), bmp());
  const image = await reference(page, 'image.bmp');
  const identical = await reference(page, 'identical.bmp');
  const thumbnail = `${host}/thumbnail/${image.id}/64/image.bmp`;
  const png = await fetchFile(page, thumbnail);
  expect(png).toMatchObject({ status: 200, code: null });
  expect(png.bytes.slice(0, 8)).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  expect(png.headers['content-type']).toBe('image/png');
  inert(png);
  expect(await fetchFile(page, thumbnail, 'HEAD')).toMatchObject({ status: 200, bytes: [] });
  // Thumbnails are cached under the catalog's content hash, which the hashing job stores a
  // little after a file settles; until then each request makes the image again.
  const cache = path.join(dataDir, 'cache', 'thumbnails');
  const cachedFiles = async () => {
    await fetchFile(page, thumbnail);
    return readdir(cache).catch(() => []);
  };
  await expect.poll(cachedFiles, { timeout: 30_000 }).toHaveLength(1);
  const cached = await readdir(cache);
  expect(cached[0]).toMatch(/^[0-9a-f]{64}-64\.png$/);
  expect(Array.from(await readFile(path.join(cache, cached[0]!)))).toEqual(png.bytes);
  // Identical content shares the entry.
  expect((await fetchFile(page, `${host}/thumbnail/${identical.id}/64/identical.bmp`)).bytes).toEqual(png.bytes);
  expect(await readdir(cache)).toHaveLength(1);
  await expect(page.evaluate(`new Promise((resolve, reject) => {
    const image = new Image(); image.onload = () => resolve(image.naturalWidth);
    image.onerror = () => reject(new Error('main image blocked'));
    image.src = ${JSON.stringify(thumbnail)}; document.body.append(image);
  })`)).resolves.toBeGreaterThan(0);

  const frame = await preview(page);
  const probes = await frame.evaluate<Record<string, string>>(`(async () => {
    const policy = (directive, action) => new Promise(resolve => {
      const finish = value => { clearTimeout(timer); document.removeEventListener('securitypolicyviolation', violation); resolve(value); };
      const violation = event => { if (event.effectiveDirective === directive && event.blockedURI.startsWith(${JSON.stringify(host)})) finish('blocked: ' + directive); };
      const timer = setTimeout(() => finish('no CSP block'), 1000);
      document.addEventListener('securitypolicyviolation', violation); action();
    });
    return { origin: self.origin,
      fetch: await policy('connect-src', () => { fetch(${JSON.stringify(url)}).catch(() => {}); }),
      image: await policy('img-src', () => { const image = new Image(); image.src = ${JSON.stringify(thumbnail)}; document.body.append(image); }),
      media: await policy('media-src', () => { const media = document.createElement('audio'); media.src = ${JSON.stringify(url)}; document.body.append(media); media.load(); }),
    };
  })()`);
  expect(probes).toEqual({ origin: 'null', fetch: 'blocked: connect-src', image: 'blocked: img-src', media: 'blocked: media-src' });
  await unlink(path.join(libraryDir, name));
  for (const command of ['open_entry', 'reveal_entry']) {
    const error = await page.evaluate<AppError>(`window.__TAURI_INTERNALS__.invoke(${JSON.stringify(command)}, { request: { entry: ${JSON.stringify(entry)} } }).catch(error => error)`);
    expect(error.code).toBe('NotFound');
  }
});
