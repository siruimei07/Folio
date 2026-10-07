// The commit box's behaviour (workspace-history handoff §4), shared by the wide window's box and
// the narrow window's bar: what the commit button says and whether it commits, the fields, the AI
// message and the template, the commit itself and the job it starts, its notes and the reason
// committing waits. The view owns it once, so Ctrl+Enter and the job's end are handled while either
// shows.
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';

import { noteCommit } from '../../app/activity/notes';
import { announce } from '../../app/announcer';
import { DETAILED, showFailure } from '../../app/feedback';
import { reportUiError } from '../../app/log';
import { useCanOpenDialog } from '../../app/navigation';
import type { KeyCombo } from '../../app/shortcuts';
import { showToast } from '../../app/toasts';
import type { ToastAction } from '../../components/Toast/Toast';
import { type AiService, aiService, useAiSettings } from '../../data/ai';
import { IpcFailure } from '../../data/errors';
import { useJob, useJobActive } from '../../data/jobs';
import { useLibrary } from '../../data/library';
import {
  cancelAiRequest,
  generateCommitMessage,
  newRequestId,
  type PrunedSelection,
  useCommit,
  useSelectionSummary,
  useSummarizeNow,
  useWorkspace,
} from '../../data/workspace';
import type { CommitMessage, IpcError, Job } from '../../ipc';
import { LOADING_DELAY_MS } from '../../lib/timing';
import {
  advanceRun,
  type AiNote,
  type CommitFailure,
  type CommitFallback,
  type CommitRun,
  commitDone,
  type Draft,
  dropStaleKeys,
  editDraft,
  endGenerating,
  endRun,
  fillDraft,
  isCurrentRun,
  newRunId,
  startRun,
  undoFill,
  useChangesView,
} from '../state';
import { templateMessage } from '../template';
import { fallbackToastActions } from './fallback';
import { descriptionText, isBlank, messageOf, summaryText } from './message';

/** Ctrl+Enter: commit, from anywhere in the Changes view (§3.6, UI architecture §6.4). */
export const COMMIT_KEYS: KeyCombo = { key: 'Enter', ctrl: true };

/** Why the commit button waits (§4.2, last row): the line under it says so. */
export type CommitBlock = 'busy' | 'readOnly' | 'damaged';

/** What the commit button says (§4.1, §4.2). */
export type CommitLabel =
  /** "Commit 9 changes"; `count` `null` while the selection's summary has not arrived. */
  | { kind: 'commit'; count: number | null }
  | { kind: 'nothingSelected' }
  | { kind: 'nothingToCommit' }
  /** A commit with empty fields waits for the AI's message (§4.2). */
  | { kind: 'writing' }
  /** A commit runs, for 150 ms and longer (§4.4). */
  | { kind: 'committing' };

/** The AI service, as the settings say (ipc-m2 §12.1): on when enabled with a key. */
export interface AiState {
  on: boolean;
  /** "DeepSeek" for its own endpoint, "the AI service" for any other. */
  service: AiService;
}

export interface CommitBoxModel {
  /** What the commit box runs: Generate, a commit (waiting for the AI, sent, settling), or nothing. */
  run: CommitRun['kind'];
  draft: Draft;
  /** The fields take no typing: the AI writes them, or a commit runs. */
  readOnly: boolean;
  /** The AI writes: Generate's message into the fields, or the message of a commit (§4.2). */
  writing: 'generating' | 'waiting' | null;
  label: CommitLabel;
  /** The commit button commits now. Otherwise it is pending (`aria-disabled`), still in the tab order. */
  canCommit: boolean;
  /** The message button (Generate, the template) can write the fields now. */
  canWrite: boolean;
  ai: AiState;
  /** Why committing waits, under the button. */
  block: CommitBlock | null;
  /** The workspace or the list could not be read: nothing can be committed until Try again works. */
  loadFailed: boolean;
  /** The last commit's failure: the danger note above the fields (§4.5). */
  failure: CommitFailure | null;
  /** "Written by DeepSeek…", or why Generate failed (§4.2, §4.3). */
  aiNote: AiNote | null;
  /** A commit runs: the list's check boxes do nothing; the selection still moves (§3.8). */
  committing: boolean;
  /** …and has run for 150 ms: the rows' check boxes show it (55 %); the rows keep full contrast. */
  committingShown: boolean;
  editSummary: (text: string) => void;
  editDescription: (text: string) => void;
  /** Ctrl+Z in a field: the text before the last fill; says whether there was one. */
  undo: () => boolean;
  commit: () => void;
  /** Generate, and "Try again": the AI writes both fields. */
  generate: () => void;
  /** Stop and Esc while the AI writes the fields. */
  stop: () => void;
  /**
   * "Use template": the template in the summary field; while a commit waits for the AI, the commit
   * goes on with the template (§4.3).
   */
  chooseTemplate: () => void;
}

/** The AI failures the commit box words (versioning §12.5): each falls back to the template. */
const AI_FAILURES = ['AiNetwork', 'AiTimeout', 'AiRejected', 'AiRateLimited', 'AiUnavailable', 'AiBadResponse', 'AiCredential'] as const;

/** The key of an AI failure's words (`fallbackCode`); `unknown` for any other failure. */
export type AiFailureKey = (typeof AI_FAILURES)[number] | 'unknown';

/** Whether `code` is the AI's failure, after which Folio writes the template (§4.3). */
function isAiFailureCode(code: IpcError['code']): code is (typeof AI_FAILURES)[number] {
  return (AI_FAILURES as readonly string[]).includes(code);
}

/** Whether a commit run has been running for 150 ms (§4.4): a quick commit never flashes its state. */
function useShownAfterDelay(run: CommitRun): boolean {
  const id = run.kind === 'committing' || run.kind === 'settling' || run.kind === 'waiting' ? run.id : null;
  const [shown, setShown] = useState<number | null>(null);
  useEffect(() => {
    if (id === null) return undefined;
    const timer = window.setTimeout(() => {
      setShown(id);
    }, LOADING_DELAY_MS);
    return () => {
      window.clearTimeout(timer);
    };
  }, [id]);
  return id !== null && shown === id;
}

/**
 * A commit's failure that points at a bug or a broken state: the log has it, and its note offers
 * "Copy details" (§4.5).
 */
export function hasDetails(error: IpcError): boolean {
  return DETAILED.has(error.code) || error.code === 'HistoryDamaged';
}

function noteFailure(error: IpcError): void {
  if (hasDetails(error)) reportUiError('command', 'changes.commit', error);
}

/** The AI requests of waiting commits that were sent and have not answered yet. */
const asking = new Set<string>();

/** Stops the AI request `requestId`; failing to (an id the shell refuses) is a bug. */
function cancelQuietly(requestId: string): void {
  cancelAiRequest(requestId).catch((error: unknown) => {
    reportUiError('command', 'changes.cancelAi', error);
  });
}

/**
 * The run's commit job ended: the fields clear and the result is announced (with the information
 * toast when the AI failed and the template was used), or it failed, or it was cancelled.
 */
function useJobEnd(run: CommitRun, job: Job | undefined, service: AiService): void {
  const { t } = useTranslation('changes');
  const canEdit = useCanOpenDialog('editMessage');
  useEffect(() => {
    if (run.kind !== 'committing' || job === undefined) return;
    const { status } = job;
    switch (status.state) {
      case 'done': {
        const { result } = status;
        if (!isCurrentRun(run) || result.kind !== 'commit') return;
        commitDone(run, result.commit);
        // Held: the selection moves on to the row now in the committed one's place, and that
        // row's diff may fail and say so at once (§4.4: this is the commit's only confirmation).
        announce(t('commit.done', { count: result.changes, summary: result.summary }), 'polite', { hold: true });
        if (run.fallback !== null) showFallbackToast(t, run.fallback, service, fallbackToastActions(result.commit, canEdit));
        return;
      }
      case 'failed':
        if (!isCurrentRun(run)) return;
        noteFailure(status.error);
        endRun(run, { error: status.error, file: status.file });
        return;
      case 'cancelled':
        endRun(run);
        return;
      default:
    }
  }, [run, job, service, t, canEdit]);
}

type ChangesT = TFunction<'changes'>;

/** "Committed with a template message" (§4.3): why, the message Folio wrote, and "Edit message". */
function showFallbackToast(t: ChangesT, fallback: CommitFallback, service: AiService, actions: readonly ToastAction[]): void {
  const reason = t(`commit.aiFailed.${fallbackCode(fallback.code)}.title`, { service: t(`commit.serviceStart.${service}`) });
  showToast({
    tone: 'info',
    title: t('commit.fallback.title'),
    body: t('commit.fallback.text', { reason, summary: fallback.summary }),
    actions,
  });
}

/** The key of an AI failure's words; any other failure has the general ones. */
export function fallbackCode(code: IpcError['code']): AiFailureKey {
  return isAiFailureCode(code) ? code : 'unknown';
}

/**
 * The commit box of the Changes view. `listFailed`: the list could not load, so nothing can be
 * committed from it (§3.8).
 */
export function useCommitBox(listFailed: boolean): CommitBoxModel {
  const { t } = useTranslation('changes');
  const workspace = useWorkspace();
  const summary = workspace.data;
  const selection = useChangesView((state) => state.selection);
  const selectionSummary = useSelectionSummary(selection, summary);
  const pruned = selectionSummary.data;
  const draft = useChangesView((state) => state.draft);
  const run = useChangesView((state) => state.run);
  const failure = useChangesView((state) => state.failure);
  const aiNote = useChangesView((state) => state.aiNote);
  const settings = useAiSettings().data;
  const ai: AiState = {
    on: settings !== undefined && settings.enabled && settings.hasKey,
    service: settings === undefined ? 'deepseek' : aiService(settings),
  };
  const rebuilding = useJobActive('rebuild');
  const library = useLibrary();
  const summarizeNow = useSummarizeNow();
  const commitMutation = useCommit();
  const job = useJob(run.kind === 'committing' ? run.job : null);
  const shown = useShownAfterDelay(run);
  useJobEnd(run, job, ai.service);

  // After a commit, the button counts again once the workspace after it is read and the
  // selection's summary under it has arrived (or either failed and says so).
  const caughtUp =
    run.kind === 'settling' &&
    (workspace.isError ||
      selectionSummary.isError ||
      (summary?.head === run.head && pruned?.fingerprint === summary.fingerprint));
  useEffect(() => {
    if (caughtUp) endRun(run);
  }, [caughtUp, run]);

  const historyState = summary?.historyState;
  const block: CommitBlock | null =
    historyState === 'damaged'
      ? 'damaged'
      : historyState === 'readOnly' || library?.readOnly === true
        ? 'readOnly'
        : rebuilding
          ? 'busy'
          : null;
  const total = summary === undefined ? null : summary.items + summary.metadata;
  const count = pruned === undefined ? null : pruned.summary.items + pruned.summary.metadata;
  const starting = historyState === 'none' || historyState === 'starting';
  const known = summary !== undefined && !workspace.isError && !listFailed && !starting;
  const idle = run.kind === 'idle';

  const ready: CommitLabel =
    starting || total === 0
      ? { kind: 'nothingToCommit' }
      : count === 0
        ? { kind: 'nothingSelected' }
        : { kind: 'commit', count: known ? count : null };
  const label: CommitLabel =
    run.kind === 'waiting'
      ? { kind: 'writing' }
      : (run.kind === 'committing' || run.kind === 'settling') && shown
        ? { kind: 'committing' }
        : ready;
  const writable = known && ready.kind === 'commit';
  const canCommit = writable && idle && block === null;

  // "Committing…" is the commit button's label, which React Aria reads out only while the button
  // has the focus; Ctrl+Enter from a row, a field or the diff leaves the focus there, so the waiting
  // state is said for them (WCAG 4.1.3), once per commit, as long as it takes 150 ms.
  const committingShown = run.kind === 'committing' && shown ? run.id : null;
  useEffect(() => {
    if (committingShown === null || document.activeElement?.closest('[data-commit-focus="commit"]') != null) return;
    announce(t('commit.committing'));
  }, [committingShown, t]);

  /** The summary of the selection now, its stale keys dropped from the view. */
  const summarize = async () => {
    if (summary === undefined) throw new Error('the workspace has not loaded');
    const now = await summarizeNow(selection, summary);
    dropStaleKeys(now.stale);
    return now;
  };

  /**
   * The AI's message for a commit with empty fields (§4.2): the template when "Use template" was
   * chosen meanwhile, or when the AI is off or failed (`fallback` names the failure); `null` when
   * the run was replaced. Other failures (WorkspaceChanged, NothingToCommit, …) reject. `waiting`
   * is the run's current step: when "Use template" was chosen before the summary came, the AI is
   * not asked at all.
   */
  const waitForMessage = async (
    waiting: CommitRun & { kind: 'waiting' },
    now: PrunedSelection,
    fingerprint: string,
  ): Promise<{ message: CommitMessage; fallback: CommitFallback | null; step: CommitRun } | null> => {
    const template = (): CommitMessage => ({ summary: templateMessage(now.summary), body: null });
    if (waiting.template) return { message: template(), fallback: null, step: waiting };
    let answer: CommitMessage | null = null;
    let failed: IpcError | null = null;
    asking.add(waiting.requestId);
    try {
      answer = await generateCommitMessage({ requestId: waiting.requestId, selection: now.selection, fingerprint, description: '' });
    } catch (error) {
      if (!(error instanceof IpcFailure) || !(isAiFailureCode(error.error.code) || error.error.code === 'AiNotConfigured')) throw error;
      failed = error.error;
    } finally {
      asking.delete(waiting.requestId);
    }
    const step = useChangesView.getState().run;
    if (step.kind !== 'waiting' || step.id !== waiting.id) return null;
    if (answer !== null && !step.template) return { message: answer, fallback: null, step };
    const message = template();
    const fallback = failed !== null && isAiFailureCode(failed.code) && !step.template ? { code: failed.code, summary: message.summary } : null;
    return { message, fallback, step };
  };

  const commit = () => {
    if (!canCommit) return;
    const typed = useChangesView.getState().draft;
    const id = newRunId();
    const first: CommitRun =
      ai.on && isBlank(typed)
        ? { kind: 'waiting', id, requestId: newRequestId(), template: false }
        : { kind: 'committing', id, job: null, fallback: null };
    startRun(first);
    const send = async () => {
      const now = await summarize();
      // The run as it is now, told by its id: "Use template" may have moved a waiting run on to
      // its next step while the summary was read.
      const current = useChangesView.getState().run;
      if (current.kind === 'idle' || current.id !== id) return;
      let message = messageOf(typed, () => templateMessage(now.summary));
      let sending: CommitRun = current;
      if (current.kind === 'waiting') {
        const written = await waitForMessage(current, now, summary.fingerprint);
        if (written === null) return;
        message = written.message;
        sending = { kind: 'committing', id, job: null, fallback: written.fallback };
        if (!advanceRun(written.step, sending)) return;
      }
      const jobId = await commitMutation.mutateAsync({ selection: now.selection, fingerprint: summary.fingerprint, base: summary.head, ...message });
      noteCommit(jobId, now.summary.items + now.summary.metadata);
      if (sending.kind === 'committing') advanceRun(sending, { ...sending, job: jobId });
    };
    send().catch((error: unknown) => {
      const current = useChangesView.getState().run;
      const mine = current.kind !== 'idle' && current.id === id ? current : null;
      if (mine === null) return;
      if (error instanceof IpcFailure) {
        noteFailure(error.error);
        endRun(mine, { error: error.error, file: null });
        return;
      }
      endRun(mine);
      reportUiError('uncaught', 'changes.commit', error);
    });
  };

  /** The template in the summary field, the description kept; said, since the focus stays where it is. */
  const fillTemplate = () => {
    summarize().then(
      (now) => {
        if (useChangesView.getState().run.kind !== 'idle') return;
        fillDraft({ ...useChangesView.getState().draft, summary: summaryText(templateMessage(now.summary)) });
        announce(t('commit.templateAdded'));
      },
      (error: unknown) => {
        if (!(error instanceof IpcFailure)) {
          reportUiError('uncaught', 'changes.template', error);
          return;
        }
        // A newer workspace is on its way: the fields stay as they are, and the person can ask
        // again. Any other failure says why the template did not come.
        if (error.error.code !== 'WorkspaceChanged') showFailure(t('commit.templateFailed'), error.error, 'changes.template');
      },
    );
  };

  const chooseTemplate = () => {
    if (run.kind === 'waiting') {
      if (run.template) return;
      advanceRun(run, { ...run, template: true });
      // Before the selection's summary came, the AI was not asked yet, and now never is.
      if (asking.has(run.requestId)) cancelQuietly(run.requestId);
      return;
    }
    if (writable && idle) fillTemplate();
  };

  const generate = () => {
    if (!writable || !idle) return;
    if (!ai.on) {
      fillTemplate();
      return;
    }
    const generating: CommitRun = { kind: 'generating', id: newRunId(), requestId: newRequestId() };
    startRun(generating);
    const { description } = useChangesView.getState().draft;
    generateCommitMessage({ requestId: generating.requestId, selection, fingerprint: summary.fingerprint, description }).then(
      (message) => {
        if (!isCurrentRun(generating)) return;
        endGenerating(generating);
        if (message === null) return;
        fillDraft({ summary: summaryText(message.summary), description: descriptionText(message.body ?? '') }, { kind: 'written' });
        // The status that said it is writing has gone, and the focus stays on Generate (WCAG 4.1.3).
        announce(t('commit.written', { service: t(`commit.service.${ai.service}`) }));
      },
      (error: unknown) => {
        if (!isCurrentRun(generating)) return;
        if (!(error instanceof IpcFailure)) {
          endGenerating(generating);
          reportUiError('uncaught', 'changes.generate', error);
          return;
        }
        // AI turned off meanwhile: the template, without a word about the AI (§4.2).
        if (error.error.code === 'AiNotConfigured') {
          endGenerating(generating);
          fillTemplate();
          return;
        }
        if (DETAILED.has(error.error.code)) reportUiError('command', 'changes.generate', error.error);
        endGenerating(generating, { kind: 'failed', error: error.error });
      },
    );
  };

  const stop = () => {
    if (run.kind !== 'generating') return;
    endGenerating(run);
    cancelQuietly(run.requestId);
  };

  const committing = run.kind === 'waiting' || run.kind === 'committing';
  return {
    run: run.kind,
    draft,
    readOnly: run.kind === 'generating' || committing,
    writing: run.kind === 'generating' || run.kind === 'waiting' ? run.kind : null,
    label,
    canCommit,
    canWrite: writable && idle,
    ai,
    block,
    loadFailed: workspace.isError || listFailed,
    failure,
    aiNote,
    committing,
    committingShown: committing && shown,
    editSummary: (text) => {
      editDraft({ summary: summaryText(text) });
    },
    editDescription: (text) => {
      editDraft({ description: descriptionText(text) });
    },
    undo: undoFill,
    commit,
    generate,
    stop,
    chooseTemplate,
  };
}
