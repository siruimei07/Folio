import { type ChildProcess, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { type Browser, type Page, test as base, chromium } from '@playwright/test';

export { expect } from '@playwright/test';

/** The debug build produced by `pnpm build:app`. Override with FOLIO_APP_PATH. */
const appPath =
  process.env.FOLIO_APP_PATH ?? path.resolve(import.meta.dirname, '../target/debug/folio-app.exe');

const connectTimeoutMs = 30_000;

interface FolioApp {
  page: Page;
  /** The isolated data directory passed to the app through FOLIO_DATA_DIR. */
  dataDir: string;
}

/**
 * Starts one Folio instance per test with its own WebView2 profile and data directory, and
 * attaches Playwright over CDP (Playwright's WebView2 guide).
 */
export const test = base.extend<{ folio: FolioApp }>({
  // Playwright requires an object pattern as the first parameter, even an empty one.
  folio: async ({}, use, testInfo) => {
    const root = await mkdtemp(path.join(tmpdir(), 'folio-e2e-'));
    const dataDir = path.join(root, 'data');
    const webview2Dir = path.join(root, 'webview2');

    let child: ChildProcess | undefined;
    let browser: Browser | undefined;
    try {
      child = await launch({
        // Port 0 lets the OS pick a free port, so parallel runs never attach to each other's
        // app. WebView2 reports the port in DevToolsActivePort.
        WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=0',
        WEBVIEW2_USER_DATA_FOLDER: webview2Dir,
        FOLIO_DATA_DIR: dataDir,
      });
      browser = await connect(path.join(webview2Dir, 'EBWebView', 'DevToolsActivePort'), child);
      testInfo.annotations.push({ type: 'WebView2', description: browser.version() });
      const context = browser.contexts()[0];
      if (!context) throw new Error('WebView2 exposed no browser context');
      const page = context.pages()[0] ?? (await context.waitForEvent('page'));
      // CDP can attach while WebView2 still shows about:blank, before Tauri's scripts exist.
      await page.waitForURL((url) => url.protocol !== 'about:');
      await use({ page, dataDir });
    } finally {
      await browser?.close();
      if (child) await stop(child);
      // WebView2 helper processes may hold files for a moment after the app exits.
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  },
});

async function launch(env: NodeJS.ProcessEnv): Promise<ChildProcess> {
  const child = spawn(appPath, [], { env: { ...process.env, ...env }, stdio: 'inherit' });
  try {
    // A process that cannot start (for example ENOENT) emits 'error' instead of 'spawn'.
    await once(child, 'spawn');
  } catch (error) {
    throw new Error(
      `Could not start Folio at ${appPath}. Build it with \`pnpm build:app\` or set FOLIO_APP_PATH.`,
      { cause: error },
    );
  }
  return child;
}

/** Waits until WebView2 has written its debugging port, then attaches over CDP. */
async function connect(portFile: string, child: ChildProcess): Promise<Browser> {
  const deadline = Date.now() + connectTimeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    if (hasExited(child)) {
      throw new Error(
        `Folio exited before Playwright could attach (${String(child.exitCode ?? child.signalCode)})`,
      );
    }
    try {
      // The first line of the file is the port.
      const port = Number.parseInt(await readFile(portFile, 'utf8'), 10);
      if (!Number.isInteger(port)) throw new Error(`No port in ${portFile} yet`);
      return await chromium.connectOverCDP(`http://127.0.0.1:${String(port)}`);
    } catch (error) {
      lastError = error;
      await delay(250);
    }
  }
  throw new Error("Could not attach to Folio's WebView2", { cause: lastError });
}

async function stop(child: ChildProcess): Promise<void> {
  if (hasExited(child)) return;
  // Listen before killing: once() also rejects if kill() fails and emits 'error'.
  const exited = once(child, 'exit');
  child.kill();
  await exited;
}

function hasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}
