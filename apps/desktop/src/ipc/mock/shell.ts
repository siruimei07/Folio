// FakeShell: the shell's state and machinery for the fake (docs/specs/ui-architecture.md §11.1).
// It answers commands through the handlers in `commands/`, emits the shell's events through the
// generated `events.*.emit`, runs jobs on timers and issues choice tokens. It reproduces the
// contract of docs/specs/ipc-m1.md, not the file system: nothing here touches the disk.
import {
  type AppError,
  type AppSettings,
  type EntryChange,
  events,
  type FilesDropped,
  type IgnoreRules,
  type Job,
  type JobKind,
  type JobResult,
  LIMITS,
  type LibraryStatus,
  type Point,
  type Problem,
  type Unavailable,
} from '../bindings';
import { createHandlers } from './commands';
import type { CommandName, Handlers } from './contract';
import { appError, type ErrorCode, fail, ShellFailure } from './failure';
import type {
  Fixture,
  FolderScript,
  ImportScript,
  LibrarySeed,
  SeedEntry,
} from './fixtures/types';
import { FakeLibrary } from './library';
import { randomHex } from './random';

export interface Failure {
  command: CommandName;
  code: ErrorCode;
}

export interface FakeShellOptions {
  fixture: Fixture;
  /** The time new entries get; defaults to the clock. */
  now?: () => number;
  /** Delay before every answer, to see loading states. */
  latencyMs?: number;
  /** Commands that always fail with a code, to see error states. */
  failures?: Failure[];
  /** Time between job steps; each step is one JobChanged. */
  jobStepMs?: number;
  /** Delay before a CatalogChanged; changes within it are merged into one event. */
  eventDelayMs?: number;
  /** What "Try again" (`library_status` while unavailable) does. */
  retry?: 'open' | 'unavailable';
}

/** How long a choice token lives (ipc-m1 §4.2). */
const TOKEN_LIFETIME_MS = 10 * 60_000;
/** App settings of a fixture that names none: Windows' appearance, and a computer called G16. */
export const DEFAULT_APP_SETTINGS: AppSettings = {
  deviceName: 'G16',
  theme: 'system',
  reduceMotion: 'system',
};
/** Finished jobs `list_jobs` returns after the active ones. */
const FINISHED_KEPT = 20;

type ShellState =
  | { kind: 'none' }
  | { kind: 'open'; library: FakeLibrary }
  | { kind: 'unavailable'; reason: Unavailable; seed: LibrarySeed };

/** What a token stands for: a folder for a library, or files to import (ipc-m1 §4.2). */
type Chosen = { kind: 'library'; script: FolderScript } | { kind: 'import'; script: ImportScript };
type Choice = Chosen & { expires: number };

interface JobSpec {
  cancellable: boolean;
  /** Items to work through; `null`: unknown until done (one step). */
  total: number | null;
  /** Items per step. */
  step?: number;
  /** Runs as the job works through items `from` to `to`. */
  onStep?: (from: number, to: number) => void;
  /** Runs when every item is done; its result finishes the job. */
  finish: () => JobResult;
  /** Runs when the job is cancelled after it started: what it did before it stopped (imports). */
  stopped?: () => JobResult;
  /** The item in progress once `done` items are done, for display (imports). */
  current?: (done: number) => string | null;
}

interface JobRun extends JobSpec {
  job: Job;
  done: number;
  cancelRequested: boolean;
}

interface PendingEvent {
  entries: EntryChange[];
  complete: boolean;
  tags: boolean;
  groups: boolean;
}

/** A copy as JSON would carry it across IPC, so neither side shares objects with the other. */
function overIpc<T>(value: T): T {
  return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);
}

function hasIllFormedText(value: unknown): boolean {
  if (typeof value === 'string') return !value.isWellFormed();
  if (typeof value !== 'object' || value === null) return false;
  return Object.values(value).some(hasIllFormedText);
}

/** Tauri's window plugin, which the title bar calls. */
function windowPlugin(command: string): unknown {
  return /\|is_(maximized|minimized|fullscreen)$/.test(command) ? false : null;
}

export class FakeShell {
  private state: ShellState;
  private readonly options: Required<Omit<FakeShellOptions, 'fixture' | 'failures'>>;
  private readonly handlers: Handlers;
  private readonly failures = new Map<string, ErrorCode>();
  private readonly tokens = new Map<string, Choice>();
  private readonly folderChoices: (FolderScript | null)[];
  private readonly importSources: (ImportScript | null)[];
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private active: JobRun[] = [];
  private finished: Job[] = [];
  private jobTimer: ReturnType<typeof setTimeout> | null = null;
  private pending: PendingEvent | null = null;
  private pendingScheduled = false;
  private disposed = false;
  /** `log_ui_error` reports, oldest first. */
  readonly log: { kind: string; source: string; message: string; stack: string | null }[] = [];
  /** App settings on this computer (ipc-m1 §22); they outlive library changes. */
  private settings: AppSettings;

  constructor(options: FakeShellOptions) {
    this.options = {
      now: options.now ?? (() => Date.now()),
      latencyMs: options.latencyMs ?? 0,
      jobStepMs: options.jobStepMs ?? 250,
      eventDelayMs: options.eventDelayMs ?? 0,
      retry: options.retry ?? 'unavailable',
    };
    for (const failure of options.failures ?? []) this.failures.set(failure.command, failure.code);
    const { fixture } = options;
    this.settings = { ...(fixture.appSettings ?? DEFAULT_APP_SETTINGS) };
    this.folderChoices = [...fixture.folderChoices];
    this.importSources = [...fixture.importSources];
    this.state =
      fixture.status.state === 'none' || fixture.library === null
        ? { kind: 'none' }
        : fixture.status.state === 'open'
          ? { kind: 'open', library: new FakeLibrary(randomHex(8), fixture.library) }
          : { kind: 'unavailable', reason: fixture.status.reason, seed: fixture.library };
    this.handlers = createHandlers(this);
  }

  // ---- dispatch

  /** Answers one IPC call, as `mockIPC` hands it over. */
  async invoke(command: string, payload?: unknown): Promise<unknown> {
    if (command.startsWith('plugin:window|')) return windowPlugin(command);
    const handler = (this.handlers as Partial<Record<string, (...args: unknown[]) => unknown>>)[
      command
    ];
    if (handler === undefined || hasIllFormedText(payload)) {
      // Tauri refuses a command the window may not call, or a body it cannot parse, with a
      // plain string: the UI sees a `Transport` error.
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
      return Promise.reject(`${command} not allowed or malformed (fake shell)`);
    }
    const forced = this.failures.get(command);
    let answer: { data: unknown } | { error: AppError };
    try {
      if (forced !== undefined) fail(forced, `${command} set to fail by the fake shell`);
      const args: unknown[] =
        typeof payload === 'object' && payload !== null ? Object.values(payload) : [];
      answer = { data: overIpc(await handler(...overIpc(args))) };
    } catch (error) {
      if (!(error instanceof ShellFailure)) throw error;
      answer = { error: error.appError };
    }
    // The shell reads and acts at once; its answer then takes the latency to arrive, and the
    // events of this command overtake it, as they can in the app (ui-architecture §5.4).
    await this.wait(this.options.latencyMs);
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
    if ('error' in answer) return Promise.reject(answer.error);
    return answer.data;
  }

  /** Not a tracked timer: a call waiting when the shell is disposed still answers. */
  private wait(ms: number): Promise<void> {
    if (ms <= 0) return Promise.resolve();
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private later(ms: number, action: () => void): ReturnType<typeof setTimeout> {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      if (!this.disposed) action();
    }, ms);
    this.timers.add(timer);
    return timer;
  }

  /** Stops every timer; nothing is emitted afterwards. */
  dispose(): void {
    this.disposed = true;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
  }

  /** Makes `command` fail with `code`, or answer again (`null`). */
  setFailure(command: CommandName, code: ErrorCode | null): void {
    if (code === null) this.failures.delete(command);
    else this.failures.set(command, code);
  }

  now(): number {
    return this.options.now();
  }

  // ---- library state

  status(): LibraryStatus {
    switch (this.state.kind) {
      case 'none':
        return { state: 'none' };
      case 'open':
        return { state: 'open', library: { ...this.state.library.info } };
      case 'unavailable':
        return { state: 'unavailable', root: this.state.seed.root, reason: this.state.reason };
    }
  }

  /** The open library; `NoLibrary` otherwise. */
  get library(): FakeLibrary {
    if (this.state.kind !== 'open') fail('NoLibrary', 'no library is open');
    return this.state.library;
  }

  private checkOpen(): void {
    if (this.state.kind !== 'open') fail('NoLibrary', 'no library is open');
  }

  /** The open library for a write: `Busy` while the catalog is rebuilt (ipc-m1 §13). */
  writable(): FakeLibrary {
    const library = this.library;
    if (this.active.some((run) => run.job.kind === 'rebuild')) {
      fail('Busy', 'the catalog is being rebuilt');
    }
    return library;
  }

  /** The open library for a metadata write: also `ReadOnly` (ADR-0002 §3). */
  editable(): FakeLibrary {
    const library = this.writable();
    if (library.info.readOnly) fail('ReadOnly', 'a newer Folio wrote the metadata');
    return library;
  }

  /** Opens `seed` as this machine's library, and says so (LibraryStateChanged). */
  openLibrary(seed: LibrarySeed): FakeLibrary {
    const library = new FakeLibrary(randomHex(8), seed);
    this.changeState({ kind: 'open', library });
    return library;
  }

  /** "Try again" on the unavailable screen (ipc-m1 §6). */
  retryOpen(): void {
    if (this.state.kind !== 'unavailable' || this.options.retry !== 'open') return;
    this.openLibrary(this.state.seed);
    this.startScan();
  }

  /** The library becomes unavailable while Folio runs (its folder went away). */
  makeUnavailable(reason: Unavailable): void {
    if (this.state.kind !== 'open') return;
    const { library } = this.state;
    this.changeState({ kind: 'unavailable', reason, seed: seedOf(library) });
  }

  /** From now on, "Try again" opens the library. */
  makeReachable(): void {
    this.options.retry = 'open';
  }

  private changeState(state: ShellState): void {
    this.state = state;
    // Tokens, pending events and jobs belong to the library that was open (library-state.md).
    this.tokens.clear();
    this.pending = null;
    this.active = [];
    this.finished = [];
    this.emit(() => events.libraryStateChanged.emit({ status: this.status() }));
  }

  // ---- catalog changes

  /** Commits changes: the next revision, and a CatalogChanged soon after the answer. */
  changed(entries: EntryChange[], flags: { tags?: boolean; groups?: boolean } = {}): void {
    this.library.commit();
    const pending = (this.pending ??= { entries: [], complete: true, tags: false, groups: false });
    pending.entries.push(...entries);
    pending.tags ||= flags.tags ?? false;
    pending.groups ||= flags.groups ?? false;
    this.scheduleCatalogEvent();
  }

  /** Everything changed (a rebuilt catalog): `complete: false`. */
  changedEverything(): void {
    this.changed([], { tags: true, groups: true });
    if (this.pending) this.pending.complete = false;
  }

  private scheduleCatalogEvent(): void {
    if (this.pending === null || this.pendingScheduled) return;
    this.pendingScheduled = true;
    this.later(this.options.eventDelayMs, () => {
      this.pendingScheduled = false;
      this.flushCatalogEvent();
    });
  }

  private flushCatalogEvent(): void {
    const pending = this.pending;
    if (pending === null || this.state.kind !== 'open') return;
    this.pending = null;
    const complete = pending.complete && pending.entries.length <= LIMITS.eventEntries;
    const payload = {
      revision: this.state.library.revision,
      entries: complete ? pending.entries : [],
      complete,
      tags: pending.tags,
      groups: pending.groups,
    };
    this.emit(() => events.catalogChanged.emit(payload));
  }

  /**
   * Emits any merged CatalogChanged now; resolves once listeners have it and every event queued
   * before it (events go out in order, one timer tick after they are queued).
   */
  async flush(): Promise<void> {
    this.flushCatalogEvent();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  /**
   * Emits an event after the current command has answered: the shell's events travel apart from
   * command answers, while the mocked event plugin would run listeners inside the handler.
   * Events keep their order.
   */
  private emit(send: () => Promise<void>): void {
    this.later(0, () => {
      send().catch((error: unknown) => {
        console.error('fake shell: emitting an event failed', error);
      });
    });
  }

  /** Replaces the problem list; ProblemsChanged reports the new total. */
  setProblems(problems: Problem[]): void {
    this.library.problems = [];
    this.addProblems(problems);
  }

  /** Adds problems a scan found; the others keep their ids (ipc-m1 §14). */
  addProblems(problems: Problem[]): void {
    const library = this.library;
    for (const problem of problems) library.addProblem(problem);
    const total = library.problems.length;
    this.emit(() => events.problemsChanged.emit({ total }));
  }

  // ---- settings

  get appSettings(): AppSettings {
    return { ...this.settings };
  }

  /** Stores App settings; a change goes out as AppSettingsChanged. */
  saveAppSettings(next: AppSettings): void {
    const changed = (Object.keys(next) as (keyof AppSettings)[]).some(
      (key) => next[key] !== this.settings[key],
    );
    this.settings = { ...next };
    if (changed) {
      const settings = this.appSettings;
      this.emit(() => events.appSettingsChanged.emit({ settings }));
    }
  }

  /** Stores the library's new ignore rules: IgnoreRulesChanged, then the scan the watcher starts. */
  saveIgnoreRules(rules: IgnoreRules): void {
    this.library.ignoreRules = rules.text;
    const copy = overIpc(rules);
    this.emit(() => events.ignoreRulesChanged.emit({ rules: copy }));
    this.startScan();
  }

  // ---- choices and dialogs

  /** A new token for `choice`, which it stands for until it is used or expires. */
  private issue(choice: Chosen): string {
    const token = randomHex(16);
    this.tokens.set(token, { ...choice, expires: this.now() + TOKEN_LIFETIME_MS });
    return token;
  }

  /** The folder dialog's next answer, with its token. */
  pickFolder(): { token: string; script: FolderScript } | null {
    const script = next(this.folderChoices);
    return script === null ? null : { token: this.issue({ kind: 'library', script }), script };
  }

  /** The file dialog's next answer, or `script` for a drop, with its token. */
  pickImport(script: ImportScript | null = next(this.importSources)) {
    return script === null ? null : { token: this.issue({ kind: 'import', script }), script };
  }

  /** The choice a token stands for; single use when `consume` (ipc-m1 §4.2). */
  choice<K extends Choice['kind']>(token: string, kind: K, consume: boolean) {
    const choice = this.tokens.get(token);
    if (choice !== undefined && choice.expires < this.now()) this.tokens.delete(token);
    // A token of the other kind stays valid for its own kind.
    if (choice?.kind !== kind || choice.expires < this.now()) {
      fail('ChoiceExpired', 'the choice is unknown, used, expired or of another kind');
    }
    if (consume) this.tokens.delete(token);
    return choice as Extract<Choice, { kind: K }>;
  }

  /** Drops files on the window: DropHover, then FilesDropped with a new import token. */
  dropFiles(script?: ImportScript, position: Point = { x: 480, y: 320 }): void {
    const picked = this.pickImport(script);
    if (picked === null) return;
    const { token, script: dropped } = picked;
    const payload: FilesDropped = { source: importSource(token, dropped), position };
    this.emit(() => events.dropHover.emit({ position }));
    this.emit(() => events.dropHover.emit({ position: null }));
    this.emit(() => events.filesDropped.emit(payload));
  }

  /** Drags files over the window to `position`, or out of it (`null`): DropHover only. */
  dragOver(position: Point | null): void {
    this.emit(() => events.dropHover.emit({ position }));
  }

  /** A drop the shell rejects (too many items, an unreadable one): no token, only DropFailed. */
  dropFails(error: AppError, position: Point = { x: 480, y: 320 }): void {
    this.emit(() => events.dropHover.emit({ position }));
    this.emit(() => events.dropHover.emit({ position: null }));
    this.emit(() => events.dropFailed.emit({ error }));
  }

  // ---- jobs

  /** Queued and running jobs, then the last finished ones, newest first. */
  jobs(): Job[] {
    this.checkOpen();
    return [...this.active.map((run) => run.job), ...this.finished];
  }

  /** Queues a job; one of each kind runs at a time (ipc-m1 §13). */
  startJob(kind: JobKind, spec: JobSpec): string {
    const job: Job = { id: randomHex(8), kind, cancellable: spec.cancellable, status: { state: 'queued' } };
    this.active.push({ ...spec, job, done: 0, cancelRequested: false });
    this.jobChanged(job);
    this.scheduleJobs();
    return job.id;
  }

  cancelJob(id: string): void {
    this.checkOpen();
    const run = this.active.find((candidate) => candidate.job.id === id);
    if (run === undefined) fail('NotFound', `no queued or running job ${id}`);
    if (!run.job.cancellable) fail('InvalidArgument', `job ${id} cannot be cancelled`);
    if (run.job.status.state === 'queued') this.finishJob(run, { state: 'cancelled', result: null });
    else run.cancelRequested = true;
  }

  /** Runs every job to its end now, without waiting for the timers. */
  finishJobs(): void {
    for (let guard = 0; this.active.length > 0 && guard < 100_000; guard++) this.stepJobs();
  }

  /** The scan (and hashing) a library runs after it opens. */
  startScan(found: SeedEntry[] = []): string {
    let changes = 0;
    const scan = this.startJob('scan', {
      cancellable: true,
      total: found.length === 0 ? null : found.length,
      step: Math.max(1, Math.ceil(found.length / 12)),
      onStep: (from, to) => {
        changes += this.addFound(found.slice(from, to));
      },
      finish: () => {
        this.startJob('hash', {
          cancellable: true,
          total: Math.max(1, Math.min(found.length, 400)),
          step: 40,
          finish: () => ({ kind: 'hash', hashed: found.length, deferred: 0 }),
        });
        return { kind: 'scan', changes, problems: this.library.problems.length };
      },
    });
    return scan;
  }

  /** Entries a scan finds, parents first: added to the catalog and reported. */
  private addFound(entries: SeedEntry[]): number {
    const library = this.library;
    const changes: EntryChange[] = [];
    let groups = false;
    for (const entry of entries) {
      const node = library.addSeed(entry);
      if (node === undefined) continue;
      changes.push({ kind: 'added', entry: library.ref(node) });
      groups ||= library.isGroup(node);
    }
    if (changes.length > 0) this.changed(changes, { groups });
    return changes.length;
  }

  private scheduleJobs(): void {
    if (this.jobTimer !== null || this.active.length === 0) return;
    this.jobTimer = this.later(this.options.jobStepMs, () => {
      this.jobTimer = null;
      this.stepJobs();
      this.scheduleJobs();
    });
  }

  /** Moves every job one step on now: queued ones start, running ones work through a step. */
  stepJobs(): void {
    const runningKinds = new Set<JobKind>();
    for (const run of [...this.active]) {
      if (run.job.status.state === 'queued') {
        if (runningKinds.has(run.job.kind)) continue;
        runningKinds.add(run.job.kind);
        this.setJob(run, {
          state: 'running',
          progress: { done: 0, total: run.total, permille: null, current: null },
        });
        continue;
      }
      runningKinds.add(run.job.kind);
      if (run.cancelRequested) {
        this.finishJob(run, { state: 'cancelled', result: run.stopped?.() ?? null });
        continue;
      }
      const total = run.total ?? 1;
      const to = Math.min(total, run.done + (run.step ?? total));
      run.onStep?.(run.done, to);
      run.done = to;
      if (to >= total) {
        try {
          this.finishJob(run, { state: 'done', result: run.finish() });
        } catch (error) {
          const failure = error instanceof ShellFailure ? error.appError : internal(error);
          this.finishJob(run, { state: 'failed', error: failure });
        }
      } else {
        this.setJob(run, {
          state: 'running',
          progress: {
            done: to,
            total: run.total,
            permille: run.total === null ? null : Math.round((to / total) * 1000),
            current: run.current?.(to) ?? null,
          },
        });
      }
    }
  }

  private setJob(run: JobRun, status: Job['status']): void {
    run.job = { ...run.job, status };
    this.jobChanged(run.job);
  }

  private finishJob(run: JobRun, status: Job['status']): void {
    this.active = this.active.filter((candidate) => candidate !== run);
    run.job = { ...run.job, status };
    this.finished = [run.job, ...this.finished].slice(0, FINISHED_KEPT);
    this.jobChanged(run.job);
  }

  private jobChanged(job: Job): void {
    const copy = overIpc(job);
    this.emit(() => events.jobChanged.emit({ job: copy }));
  }
}

function internal(error: unknown): AppError {
  return appError('Internal', String(error));
}

/** The next scripted answer; the last one repeats. */
function next<T>(answers: T[]): T | null {
  const answer = answers.length > 1 ? answers.shift() : answers[0];
  return answer ?? null;
}

export function importSource(token: string, script: ImportScript) {
  const top = script.items.filter((item) => !item.path.includes('/'));
  return {
    token,
    files: top.filter((item) => item.kind === 'file').length,
    folders: top.filter((item) => item.kind === 'folder').length,
    names: script.names.slice(0, 10),
  };
}

/** A library's current content as a seed, to open it again later. */
function seedOf(library: FakeLibrary): LibrarySeed {
  return {
    name: library.info.name,
    root: library.info.root,
    readOnly: library.info.readOnly,
    recovered: false,
    tags: library.tags.map((tag) => ({ ...tag })),
    entries: [...library.walk(library.root)].map((node) => ({
      path: node.path,
      kind: node.kind,
      size: node.size,
      modifiedMs: node.modifiedMs,
      addedMs: node.addedMs,
      tags: [...node.tags],
      group: node.group && { ...node.group },
      text: node.text,
      blocked: node.blocked,
    })),
    problems: library.problems.map((item) => item.problem),
    ignoreRules: library.ignoreRules,
  };
}
