import { type ChildProcess, spawn } from 'node:child_process';
import { once } from 'node:events';
import { access, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import AxeBuilder from '@axe-core/playwright';
import { type Browser, type Locator, type Page, test as base, chromium, expect } from '@playwright/test';

import firstRun from '../apps/desktop/src/i18n/locales/en/first-run.json' with { type: 'json' };
import library from '../apps/desktop/src/i18n/locales/en/library.json' with { type: 'json' };
import type { AppError, FolderChoice, Job, LibraryOpened } from '../apps/desktop/src/ipc/bindings';

export { expect };

/** The debug build produced by `pnpm build:app`. Override with FOLIO_APP_PATH. */
const appPath =
  process.env.FOLIO_APP_PATH ?? path.resolve(import.meta.dirname, '../target/debug/folio-app.exe');

const connectTimeoutMs = 30_000;

interface FolioApp {
  page: Page;
  /** The app process, whose native windows shell specs inspect. */
  processId: number;
  /** The isolated data directory passed to the app through FOLIO_DATA_DIR. */
  dataDir: string;
  /** A fresh folder supplied to the debug native picker, only when explicitly enabled. */
  libraryDir: string | undefined;
  /** Closes through the shell, waits for a clean process exit, then reuses the same local data. */
  restart: () => Promise<Page>;
}

/**
 * Starts one Folio instance per test with its own WebView2 profile and data directory, and
 * attaches Playwright over CDP (Playwright's WebView2 guide).
 */
export const test = base.extend<{ folio: FolioApp; libraryFolder: boolean }>({
  libraryFolder: [false, { option: true }],
  folio: async ({ libraryFolder }, use, testInfo) => {
    const root = await mkdtemp(path.join(tmpdir(), 'folio-e2e-'));
    const dataDir = path.join(root, 'data');
    const webview2Dir = path.join(root, 'webview2');
    const libraryDir = libraryFolder ? path.join(root, 'library') : undefined;

    let child: ChildProcess | undefined;
    let browser: Browser | undefined;
    async function start(): Promise<{ page: Page; processId: number }> {
      child = await launch({
        // Port 0 lets the OS pick a free port, so parallel runs never attach to each other's
        // app. WebView2 reports the port in DevToolsActivePort.
        WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=0',
        WEBVIEW2_USER_DATA_FOLDER: webview2Dir,
        FOLIO_DATA_DIR: dataDir,
        FOLIO_TEST_LIBRARY_FOLDER: libraryDir,
      });
      browser = await connect(path.join(webview2Dir, 'EBWebView', 'DevToolsActivePort'), child);
      testInfo.annotations.push({ type: 'WebView2', description: browser.version() });
      const context = browser.contexts()[0];
      if (!context) throw new Error('WebView2 exposed no browser context');
      const page = context.pages()[0] ?? (await context.waitForEvent('page'));
      // CDP can attach while WebView2 still shows about:blank, before Tauri's scripts exist.
      await page.waitForURL((url) => url.protocol !== 'about:');
      // WebView2 drops input that arrives before the page's first frame is on screen, so a key
      // pressed right away can vanish. Two animation frames mean one has been presented. A
      // hidden or fully covered window renders no frames, so fail fast instead of hanging.
      await page.evaluate(`new Promise((resolve, reject) => {
        setTimeout(() => reject(new Error('Folio rendered no frame in 10 s')), 10000);
        requestAnimationFrame(() => requestAnimationFrame(resolve));
      })`);
      if (child.pid === undefined) throw new Error('Folio has no process id');
      return { page, processId: child.pid };
    }

    try {
      if (libraryDir) await mkdir(libraryDir);
      const app: FolioApp = {
        ...(await start()),
        dataDir,
        libraryDir,
        restart: async () => {
          if (!child || !browser) throw new Error('Folio is not running');
          const closed = app.page.waitForEvent('close');
          await app.page.evaluate(`setTimeout(() => {
            void window.__TAURI_INTERNALS__.invoke('plugin:window|close');
          }, 0)`);
          await closed;
          if (!hasExited(child)) {
            await once(child, 'exit', { signal: AbortSignal.timeout(15_000) });
          }
          if (child.exitCode !== 0) {
            throw new Error(`Folio did not exit cleanly (${String(child.exitCode ?? child.signalCode)})`);
          }
          await browser.close();
          // A stale port file could attach to a WebView2 helper that is still shutting down.
          await rm(path.join(webview2Dir, 'EBWebView', 'DevToolsActivePort'), { force: true });
          Object.assign(app, await start());
          return app.page;
        },
      };
      await use(app);
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

/**
 * Serious and critical axe violations, as `rule: targets`, in the page or in the part that
 * `include` selects. A page or a dialog fades in (first-run §10), and axe would measure contrast
 * halfway through, so it waits for the animations that end.
 */
export async function blockingViolations(page: Page, include?: string): Promise<string[]> {
  await expect
    .poll(() =>
      page.evaluate<boolean>(
        'document.getAnimations().every((animation) => animation.effect?.getTiming().iterations === Infinity)',
      ),
    )
    .toBe(true);
  const axe = new AxeBuilder({ page });
  const { violations } = await (include === undefined ? axe : axe.include(include)).analyze();
  return violations
    .filter(({ impact }) => impact === 'serious' || impact === 'critical')
    .map(({ id, nodes }) => `${id}: ${nodes.map(({ target }) => target.join(' ')).join(', ')}`);
}

/** Whether a file or folder is there. */
export async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

const previousPicker = process.env.FOLIO_TEST_IMPORT_FILES;

/**
 * Answers the import file picker of the apps started from now on (debug builds read
 * FOLIO_TEST_IMPORT_FILES at start, in Windows' path-list format); `null` restores what was set.
 */
export function answerImportPicker(paths: readonly string[] | null): void {
  if (paths !== null) process.env.FOLIO_TEST_IMPORT_FILES = paths.join(';');
  else if (previousPicker === undefined) delete process.env.FOLIO_TEST_IMPORT_FILES;
  else process.env.FOLIO_TEST_IMPORT_FILES = previousPicker;
}

/** Calls a command in the page, as the UI's IPC module does; a command error rejects. */
export function invoke<T>(page: Page, command: string, args: Record<string, unknown> = {}): Promise<T> {
  return page.evaluate<T>(`window.__TAURI_INTERNALS__.invoke(${JSON.stringify(command)}, ${JSON.stringify(args)})`);
}

/** Calls a command in the page and resolves with its error, or `null` if it succeeded. */
export function rejection(page: Page, command: string, args: Record<string, unknown> = {}): Promise<AppError | null> {
  return page.evaluate<AppError | null>(
    `window.__TAURI_INTERNALS__.invoke(${JSON.stringify(command)}, ${JSON.stringify(args)})
      .then(() => null, error => error)`,
  );
}

/**
 * Counts the page's calls of a command. Tauri's invoke cannot be wrapped (the shell makes it
 * read-only), so this counts the IPC requests WebView2 sends (`http://ipc.localhost/<command>`).
 */
export function countCalls(page: Page, command: string): () => number {
  let count = 0;
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === `/${command}`) count += 1;
  });
  return () => count;
}

/**
 * Makes the isolated library folder (`libraryFolder: true`) this machine's library through IPC,
 * with the preset tags the first run names, and resolves once it has opened. The window then
 * shows the Library instead of the first run.
 */
export async function createLibrary(page: Page, name = 'E2E library'): Promise<LibraryOpened> {
  const choice = await invoke<FolderChoice | null>(page, 'pick_library_folder');
  if (!choice) throw new Error('The isolated folder choice was cancelled');
  return invoke<LibraryOpened>(page, 'create_library', {
    request: { folder: choice.token, name, presetTags: firstRun.presetTags },
  });
}

/**
 * `createLibrary` over what the folder already holds, once its first scan has finished; `poll`
 * tunes that wait (a timing run polls more often, for longer).
 */
export async function openLibrary(
  page: Page,
  name?: string,
  poll?: { timeout?: number; intervals?: number[] },
): Promise<LibraryOpened> {
  const opened = await createLibrary(page, name);
  await expect
    .poll(async () => (await invoke<Job[]>(page, 'list_jobs')).find((job) => job.id === opened.scan)?.status.state, poll)
    .toBe('done');
  return opened;
}

/** The Library's tree of a semester. */
export function libraryTree(page: Page, semester = 'Fall 2026'): Locator {
  return page.getByRole('tree', { name: library.tree.label.replace('{{semester}}', semester) });
}

/** A row of that tree by the start of its name (the name, then its count or tags). */
export function treeRow(page: Page, name: string, semester?: string): Locator {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return libraryTree(page, semester).getByRole('treeitem', { name: new RegExp(`^${escaped}`) });
}
