import { once } from 'node:events';
import { createServer } from 'node:http';

import { expect, test } from '../fixtures';

test('the preview scheme returns 404 for a missing asset instead of the main page', async ({ folio }) => {
  const { page } = folio;
  const response = page.waitForResponse('http://folio-preview.localhost/assets/missing-wp02.js');
  await page.evaluate(`(() => {
    const frame = document.createElement('iframe');
    frame.sandbox.add('allow-scripts');
    frame.src = 'http://folio-preview.localhost/assets/missing-wp02.js';
    document.body.append(frame);
  })()`);
  const missing = await response;
  expect(missing.status()).toBe(404);
  expect(missing.headers()['content-security-policy']).toContain("default-src 'none'");
  expect(missing.headers()['content-security-policy']).not.toContain('localhost:5173');
  expect(missing.headers()['x-content-type-options']).toBe('nosniff');
  expect(missing.headers()['access-control-allow-origin']).toBeUndefined();

  const document = page.waitForResponse('http://folio-preview.localhost/preview.html');
  const script = page.waitForResponse((candidate) =>
    /\/assets\/preview-[^/]+\.js$/.test(candidate.url()),
  );
  await page.evaluate(`document.querySelector('iframe').src = 'http://folio-preview.localhost/preview.html'`);
  const preview = await document;
  expect(preview.status()).toBe(200);
  expect(preview.headers()['content-security-policy']).not.toContain('localhost:5173');
  expect(preview.headers()['access-control-allow-origin']).toBeUndefined();
  expect((await script).headers()['access-control-allow-origin']).toBe('*');
});

test('preview fetch is stopped by CSP before a local server receives it', async ({ folio }) => {
  let requests = 0;
  const server = createServer((_request, response) => {
    requests += 1;
    response.end('local CSP probe');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('no local probe port');
    const { page } = folio;
    const previewUrl = 'http://folio-preview.localhost/preview.html';
    await page.evaluate(`new Promise((resolve) => {
      const frame = document.createElement('iframe');
      frame.sandbox.add('allow-scripts');
      frame.src = ${JSON.stringify(previewUrl)};
      frame.addEventListener('load', resolve, { once: true });
      document.body.append(frame);
    })`);
    const frame = page.frames().find((candidate) => candidate.url() === previewUrl);
    if (!frame) throw new Error('preview frame did not load');
    const directive = await frame.evaluate(`new Promise((resolve) => {
      const origin = 'http://127.0.0.1:${String(address.port)}';
      const finish = (result) => {
        clearTimeout(timeout);
        document.removeEventListener('securitypolicyviolation', onViolation);
        resolve(result);
      };
      const onViolation = (event) => {
        if (event.effectiveDirective === 'connect-src' &&
            (event.blockedURI === origin || event.blockedURI.startsWith(origin + '/'))) {
          finish(event.effectiveDirective);
        }
      };
      const timeout = setTimeout(() => finish('no CSP violation'), 3000);
      document.addEventListener('securitypolicyviolation', onViolation);
      fetch(origin + '/probe', { mode: 'no-cors' }).catch(() => {});
    })`);
    expect(directive).toBe('connect-src');
    expect(requests).toBe(0);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => { if (error) reject(error); else resolve(); });
    });
  }
});
