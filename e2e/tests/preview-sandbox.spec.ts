import type { Frame, Page } from '@playwright/test';

import { expect, test } from '../fixtures';

// ADR-0001 security baseline: previews render untrusted files in a sandboxed frame that the
// folio-preview scheme serves (crates/folio-app/src/preview.rs). The app shows no previews yet,
// so these tests embed the frame the way the window will. Strings run in the page because this
// package has no DOM types.

const previewUrl = 'http://folio-preview.localhost/preview.html';

async function embedPreview(page: Page): Promise<Frame> {
  await page.evaluate(`new Promise((resolve) => {
    const frame = document.createElement('iframe');
    frame.sandbox.add('allow-scripts');
    frame.src = ${JSON.stringify(previewUrl)};
    frame.addEventListener('load', resolve, { once: true });
    document.body.append(frame);
  })`);
  const frame = page.frames().find((candidate) => candidate.url() === previewUrl);
  if (!frame) throw new Error(`no frame loaded ${previewUrl}`);
  return frame;
}

test('the preview frame renders what the window sends it', async ({ folio }) => {
  const frame = await embedPreview(folio.page);
  const reply = folio.page.evaluate(`new Promise((resolve) => {
    window.addEventListener('message', (event) => resolve(event.data), { once: true });
    const bytes = new TextEncoder().encode('线性代数 notes').buffer;
    document.querySelector('iframe').contentWindow.postMessage({ kind: 'text', bytes }, '*', [bytes]);
  })`);
  await expect(reply).resolves.toEqual({ kind: 'rendered' });
  await expect(frame.locator('pre')).toHaveText('线性代数 notes');
});

test('the preview frame cannot reach the shell, the window or the network', async ({
  folio,
}, testInfo) => {
  const { page } = folio;
  const consoleMessages: string[] = [];
  page.on('console', (message) => consoleMessages.push(`${message.type()}: ${message.text()}`));
  const frame = await embedPreview(page);

  // Tauri answers every IPC message it receives by running script in the window: a message it
  // cannot parse becomes a console error there, and an answer to a call the window never made a
  // "Couldn't find callback id" warning. Control: a message from the window itself shows up.
  await page.evaluate("window.ipc.postMessage('{}')");
  await expect.poll(() => consoleMessages.join('\n')).toContain('missing field');
  consoleMessages.length = 0;

  // On Windows, wry injects Tauri's IPC script, key included, into every frame, and Tauri treats
  // pages of app-registered schemes as local. Each probe reports "allowed: <result>" or
  // "blocked: <reason>"; a call that gets no answer counts as blocked. `policy` reports a violation
  // of the given CSP directive, so the result does not depend on whether a network is there.
  const probes = (await frame.evaluate(`(async () => {
    const attempt = async (action) => {
      try {
        const timeout = new Promise((_, reject) =>
          setTimeout(() => reject(new Error('no answer in 3 s')), 3000));
        return 'allowed: ' + JSON.stringify(await Promise.race([action(), timeout]));
      } catch (error) {
        return 'blocked: ' + (error instanceof Error ? error.message : String(error));
      }
    };
    const policy = (directive, action) => new Promise((resolve) => {
      const finish = (result) => {
        document.removeEventListener('securitypolicyviolation', onViolation);
        clearTimeout(timer);
        resolve(result);
      };
      const onViolation = (event) => {
        if (event.effectiveDirective.startsWith(directive)) {
          finish('blocked: CSP ' + event.effectiveDirective);
        }
      };
      const timer = setTimeout(
        () => finish('allowed: no ' + directive + ' violation in 1 s; title ' + document.title),
        1000);
      document.addEventListener('securitypolicyviolation', onViolation);
      action().catch(() => {});
    });
    return {
      origin: self.origin,
      tauriScript: typeof window.__TAURI_INTERNALS__,
      webviewMessage: await attempt(async () => {
        window.chrome.webview.postMessage('{}');
        return 'sent';
      }),
      invoke: await attempt(() => window.__TAURI_INTERNALS__.invoke('app_info')),
      ipcFetch: await attempt(() =>
        fetch('http://ipc.localhost/app_info', { method: 'POST', body: '{}' }).then((r) => r.status)),
      windowDocument: await attempt(async () => window.parent.document.title),
      storage: await attempt(async () => localStorage.length),
      network: await policy('connect-src', () => fetch('https://example.com/', { mode: 'no-cors' })),
      // What a renderer does with a file's markup: inline handlers must not run.
      markupScript: await policy('script-src', async () => {
        const holder = document.createElement('div');
        holder.innerHTML = '<img src="data:," onerror="document.title = \\'ran\\'">';
        document.body.append(holder);
      }),
      evalString: await attempt(async () => eval('1 + 1')),
      webrtc: typeof window.RTCPeerConnection,
      webrtcInChildFrame: await attempt(async () =>
        typeof document.body.appendChild(document.createElement('iframe')).contentWindow
          .RTCPeerConnection),
      topNavigation: await attempt(async () => {
        window.top.location.href = 'https://example.com/';
        return 'requested';
      }),
    };
  })()`)) as Record<string, string>;
  testInfo.annotations.push({ type: 'probes', description: JSON.stringify(probes) });

  expect(probes.origin).toBe('null');
  for (const probe of ['invoke', 'ipcFetch', 'windowDocument', 'storage', 'topNavigation']) {
    expect(probes[probe], probe).toMatch(/^blocked/);
  }
  expect(probes.network).toBe('blocked: CSP connect-src');
  expect(probes.markupScript).toMatch(/^blocked: CSP script-src/);
  expect(probes.evalString).toMatch(/^blocked: .*'unsafe-eval'/);
  // No CSP directive covers WebRTC: the frame removes it, and a child frame cannot hand it back.
  expect(probes.webrtc).toBe('undefined');
  expect(probes.webrtcInChildFrame).toMatch(/^blocked/);
  // Nothing the frame sent reached Tauri: no parse error and no stray answer in the window.
  expect(consoleMessages.join('\n')).not.toMatch(/missing field|Couldn't find callback id/);
  // The window stays where it was, and still reaches the shell.
  expect(page.url()).toMatch(/^http:\/\/tauri\.localhost\//);
  await expect(page.evaluate("window.__TAURI_INTERNALS__.invoke('app_info')")).resolves.toMatchObject(
    { dataDir: folio.dataDir },
  );
});
