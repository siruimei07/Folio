// The fake AI service (docs/specs/ipc-m2.md §12): settings, a key the UI can set, test and clear
// but never read, the confirmation for another service, and generating a message that Stop ends.
// Nothing goes to a network: `mode` says how the "service" answers.
import { charCount } from '../../../lib/text';
import {
  type AiSettings,
  type CommitMessage,
  DEFAULT_AI_ENDPOINT,
  LIMITS,
  type SelectionSummary,
  type UpdateAiSettings,
} from '../../bindings';
import { type ErrorCode, fail } from '../failure';

/** How the fake service answers (`?ai=…`). `slow` answers after 20 seconds unless stopped. */
export const AI_MODES = [
  'ok',
  'network',
  'timeout',
  'rejected',
  'rateLimited',
  'unavailable',
  'badResponse',
  'credential',
  'slow',
] as const;
export type AiMode = (typeof AI_MODES)[number];

const FAILURES: Partial<Record<AiMode, ErrorCode>> = {
  network: 'AiNetwork',
  timeout: 'AiTimeout',
  rejected: 'AiRejected',
  rateLimited: 'AiRateLimited',
  unavailable: 'AiUnavailable',
  badResponse: 'AiBadResponse',
  credential: 'AiCredential',
};

const SLOW_MS = 20_000;
const REQUEST_ID = /^[A-Za-z0-9_-]+$/;
const VISIBLE_ASCII = /^[!-~]+$/;

export interface AiSeed {
  enabled: boolean;
  /** Whether a key is stored for the default endpoint. */
  hasKey: boolean;
}

/** A request id the UI chose (ipc-m2 §4), or `InvalidArgument`. */
export function checkRequestId(requestId: string): void {
  if (requestId === '' || charCount(requestId) > LIMITS.requestIdChars || !REQUEST_ID.test(requestId)) {
    fail('InvalidArgument', 'a request id of 1 to LIMITS.requestIdChars letters, digits, - and _');
  }
}

/** The origin of an endpoint the settings hold (always valid). */
function originOf(endpoint: string): string {
  return new URL(endpoint).origin;
}

/** An endpoint as the shell stores it, or `AiEndpointInvalid` (ipc-m2 §12.1). */
function normalizeEndpoint(raw: string): string {
  const text = raw.trim();
  if (charCount(text) > LIMITS.endpointChars) fail('AiEndpointInvalid', 'over LIMITS.endpointChars');
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    fail('AiEndpointInvalid', 'not a URL');
  }
  if (url.protocol !== 'https:' || url.hostname === '' || url.username !== '' || url.password !== '') {
    fail('AiEndpointInvalid', 'not an https address with a host and no user name');
  }
  if (url.search !== '' || url.hash !== '' || text.includes('?') || text.includes('#')) {
    fail('AiEndpointInvalid', 'a query or fragment');
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

/** The generation that runs: one at a time (ipc-m2 §12.4). */
interface Running {
  id: string;
  timer: ReturnType<typeof setTimeout>;
  resolve: (message: CommitMessage | null) => void;
}

export class FakeAi {
  mode: AiMode = 'ok';
  /** The answer of the confirmation for another service (`?confirm=…`). */
  confirm: 'allow' | 'cancel' = 'allow';
  private enabled: boolean;
  private endpoint: string = DEFAULT_AI_ENDPOINT;
  private model = 'deepseek-chat';
  private sendContent = true;
  /** The key and the origin it was stored for. Never leaves this class. */
  private key: { value: string; origin: string } | null;
  private running: Running | null = null;
  /** Every answer still to come, so `dispose` stops them all. */
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private readonly delayMs: number;
  private readonly onChange: (settings: AiSettings) => void;

  constructor(seed: AiSeed, delayMs: number, onChange: (settings: AiSettings) => void) {
    this.enabled = seed.enabled;
    this.key = seed.hasKey ? { value: 'sk-fake-key', origin: originOf(DEFAULT_AI_ENDPOINT) } : null;
    this.delayMs = delayMs;
    this.onChange = onChange;
  }

  private get hasKey(): boolean {
    return this.key !== null && this.key.origin === originOf(this.endpoint);
  }

  settings(): AiSettings {
    return {
      enabled: this.enabled,
      endpoint: this.endpoint,
      model: this.model,
      sendContent: this.sendContent,
      hasKey: this.hasKey,
    };
  }

  /** On when enabled and a key is stored for the endpoint. */
  get on(): boolean {
    return this.enabled && this.hasKey;
  }

  private changed(before: AiSettings): AiSettings {
    const after = this.settings();
    if (JSON.stringify(before) !== JSON.stringify(after)) this.onChange(after);
    return after;
  }

  update(request: UpdateAiSettings): AiSettings {
    const endpoint = request.endpoint === null ? null : normalizeEndpoint(request.endpoint);
    let model: string | null = null;
    if (request.model !== null) {
      model = request.model.trim();
      if (model === '' || charCount(model) > LIMITS.modelChars || !VISIBLE_ASCII.test(model)) {
        fail('AiModelInvalid', 'not 1 to LIMITS.modelChars visible ASCII characters');
      }
    }
    const before = this.settings();
    if (endpoint !== null) {
      // Another origin deletes the key (versioning §12.1).
      if (this.key !== null && originOf(endpoint) !== this.key.origin) this.key = null;
      this.endpoint = endpoint;
    }
    if (model !== null) this.model = model;
    if (request.enabled !== null) this.enabled = request.enabled;
    if (request.sendContent !== null) this.sendContent = request.sendContent;
    return this.changed(before);
  }

  /** `null`: the user declined the confirmation for another service (ipc-m2 §12.3). */
  setKey(raw: string): AiSettings | null {
    const key = raw.trim();
    if (key === '' || charCount(key) > LIMITS.aiKeyChars || !VISIBLE_ASCII.test(key)) {
      fail('AiKeyInvalid', 'not 1 to LIMITS.aiKeyChars visible ASCII characters');
    }
    const origin = originOf(this.endpoint);
    if (origin !== originOf(DEFAULT_AI_ENDPOINT) && this.confirm === 'cancel') return null;
    const before = this.settings();
    this.key = { value: key, origin };
    return this.changed(before);
  }

  clearKey(): AiSettings {
    const before = this.settings();
    this.key = null;
    return this.changed(before);
  }

  /** Answers after the fake service's delay, or fails as `mode` says. */
  private answer<T>(value: () => T, onStart?: (timer: ReturnType<typeof setTimeout>, resolve: (value: T) => void) => void): Promise<T> {
    const failure = FAILURES[this.mode];
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(
        () => {
          this.timers.delete(timer);
          try {
            if (failure !== undefined) fail(failure, `the fake AI service answers ${this.mode}`);
            resolve(value());
          } catch (error) {
            reject(error instanceof Error ? error : new Error(String(error)));
          }
        },
        this.mode === 'slow' ? SLOW_MS : this.delayMs,
      );
      this.timers.add(timer);
      onStart?.(timer, resolve);
    });
  }

  test(): Promise<null> {
    if (!this.hasKey) fail('AiNotConfigured', 'no key is stored for the endpoint');
    return this.answer(() => null);
  }

  /** Checks a generation request; the selection was checked by the workspace. */
  checkRequest(requestId: string, description: string): void {
    checkRequestId(requestId);
    if (charCount(description) > LIMITS.descriptionChars) fail('InvalidArgument', 'a description over LIMITS.descriptionChars');
    if (this.running?.id === requestId) fail('InvalidArgument', `request ${requestId} is running`);
    if (!this.on) fail('AiNotConfigured', 'AI is off, or no key is stored');
  }

  /** A message for `summary`; `null` once stopped. One generation runs at a time. */
  generate(requestId: string, summary: SelectionSummary): Promise<CommitMessage | null> {
    if (this.running !== null) this.cancel(this.running.id);
    const done = (run: Running | null) => {
      if (this.running === run) this.running = null;
    };
    let started: Running | null = null;
    return this.answer<CommitMessage | null>(
      () => messageFor(summary),
      (timer, resolve) => {
        started = { id: requestId, timer, resolve };
        this.running = started;
      },
    ).finally(() => {
      done(started);
    });
  }

  /** Stops a generation, which answers `null`; an id that is not running changes nothing. */
  cancel(requestId: string): void {
    const run = this.running;
    if (run?.id !== requestId) return;
    clearTimeout(run.timer);
    this.timers.delete(run.timer);
    this.running = null;
    run.resolve(null);
  }

  /** Stops every answer still to come; a running generation answers `null`. */
  dispose(): void {
    if (this.running !== null) this.cancel(this.running.id);
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
  }
}

/** What the fake service writes: valid as a commit message (ipc-m2 §12.4). */
function messageFor(summary: SelectionSummary): CommitMessage {
  const [first] = summary.groups.filter((group) => group.selected > 0 || group.tags > 0 || group.settings);
  const place =
    first === undefined || first.place.kind === 'library'
      ? 'Library'
      : first.place.kind === 'course'
        ? (first.place.code ?? first.place.name)
        : first.place.name;
  const files = summary.items;
  // A long course name must not make a summary the commit would refuse (ipc-m2 §12.4).
  const name = charCount(place) > 64 ? `${Array.from(place).slice(0, 63).join('')}…` : place;
  return {
    summary: `${name}: update ${String(files)} ${files === 1 ? 'file' : 'files'} and their notes`,
    body: files > 1 ? '- Tidy the lecture notes\n- Fix the review questions' : null,
  };
}
