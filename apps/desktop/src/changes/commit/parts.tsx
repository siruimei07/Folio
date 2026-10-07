// The parts the commit box (wide) and the commit bar (narrow) share (workspace-history handoff
// §4.1–§4.7): the fields, the AI's status and notes, the commit button with its shortcut, the
// failure note and the line that says why committing waits.
import '../../components/messageFields.css';

import { Info, Lock, Sparkles } from 'lucide-react';
import { type KeyboardEvent, useCallback, useId, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';

import { openDialog, useCanOpenDialog } from '../../app/navigation';
import { useShortcutLabel } from '../../app/shortcuts';
import { copyErrorDetails } from '../../app/windowErrors';
import { Banner } from '../../components/Banner/Banner';
import { Button } from '../../components/Button/Button';
import { PendingButton } from '../../components/Button/PendingButton';
import { useFocusKeeper } from '../../components/collections/useFocusKeeper';
import { Spinner } from '../../components/Progress/Progress';
import { skeletonWidth } from '../../components/Skeleton/Skeleton';
import { nameOf } from '../../lib/paths';
import { SIZE } from '../../tokens/tokens';
import type { CommitFailure } from '../state';
import { COMMIT_KEYS, type CommitBlock, type CommitBoxModel, type CommitLabel, fallbackCode, hasDetails } from './useCommitBox';

type ChangesT = TFunction<['changes', 'errors', 'shell']>;

/** "AI settings…": App settings on its AI page (§4.3). */
export function openAiSettings(): void {
  openDialog('appSettings', { page: 'ai' });
}

/** Ctrl+Z after a fill puts the text before it back; otherwise the field's own undo runs. */
function onUndoKey(model: CommitBoxModel) {
  return (event: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    const { key, ctrlKey, shiftKey, altKey, metaKey } = event;
    if (key.toLowerCase() !== 'z' || !ctrlKey || shiftKey || altKey || metaKey || event.nativeEvent.isComposing) return;
    if (model.undo()) event.preventDefault();
  };
}

/** While Generate runs, skeleton bars over a field (§4.2): one in the summary, three in the description. */
function FieldSkeleton({ bars }: { bars: number }) {
  return (
    <span className="commit-field__skeleton" data-bars={bars} aria-hidden>
      {Array.from({ length: bars }, (_, index) => (
        <span key={index} className="skeleton__bar" style={{ width: skeletonWidth(index) }} />
      ))}
    </span>
  );
}

/**
 * The summary field: one line, at most 256 characters, 600 (§4.1, §4.7). Both fields are
 * components/messageFields.css's, in the frame `className` draws.
 */
export function SummaryField({ model, className }: { model: CommitBoxModel; className: string }) {
  const { t } = useTranslation('changes');
  const generating = model.writing === 'generating';
  return (
    <span className="commit-field" data-writing={generating || undefined}>
      <input
        type="text"
        className={`message-field message-field--summary ${className}`}
        aria-label={t('commit.summary')}
        aria-busy={generating || undefined}
        placeholder={t('commit.summaryPlaceholder')}
        data-commit-focus="summary"
        value={model.draft.summary}
        readOnly={model.readOnly}
        spellCheck={false}
        autoComplete="off"
        onChange={(event) => {
          model.editSummary(event.target.value);
        }}
        onKeyDown={onUndoKey(model)}
      />
      {generating && <FieldSkeleton bars={1} />}
    </span>
  );
}

/** The description: three rows that grow to six, then scroll (§4.1). */
export function DescriptionField({ model, className }: { model: CommitBoxModel; className: string }) {
  const { t } = useTranslation('changes');
  const generating = model.writing === 'generating';
  const placeholder = model.ai.on
    ? t('commit.descriptionPlaceholderAi', { service: t(`commit.service.${model.ai.service}`) })
    : t('commit.descriptionPlaceholder');
  return (
    <span className="commit-field" data-writing={generating || undefined}>
      <textarea
        className={`message-field message-field--description ${className}`}
        aria-label={t('commit.description')}
        aria-busy={generating || undefined}
        placeholder={placeholder}
        data-commit-focus="description"
        rows={3}
        value={model.draft.description}
        readOnly={model.readOnly}
        spellCheck={false}
        onChange={(event) => {
          model.editDescription(event.target.value);
        }}
        onKeyDown={onUndoKey(model)}
      />
      {generating && <FieldSkeleton bars={3} />}
    </span>
  );
}

/**
 * The ids of the commit box's words that say why a control waits (§17: a disabled control keeps
 * `aria-disabled` and a reason): the line under the commit button (`BlockLine`), the AI's status
 * (`WritingStatus`), the commit button itself, and the hidden words for changes that could not be
 * read.
 */
export interface CommitIds {
  reason: string;
  status: string;
  commit: string;
  unread: string;
}

export function useCommitIds(): CommitIds {
  const reason = useId();
  const status = useId();
  const commit = useId();
  const unread = useId();
  return { reason, status, commit, unread };
}

/**
 * Why the message button (and its options chevron) cannot write now, as an `aria-describedby`: the
 * changes could not be read, or the commit button's words ("Nothing selected", "Nothing to commit",
 * "Committing…"); nothing while it can, or while the workspace loads.
 */
export function messageReasonOf(model: CommitBoxModel, ids: CommitIds): string | undefined {
  if (model.canWrite) return undefined;
  if (model.loadFailed) return ids.unread;
  return model.label.kind === 'commit' ? undefined : ids.commit;
}

/**
 * While the AI writes (§4.2): a spinner and "DeepSeek is writing…" (a status, `id`: the commit
 * button waits for it, and says so), and, while a commit waits for it, "Use template" (decision 37).
 */
export function WritingStatus({ model, id }: { model: CommitBoxModel; id: string }) {
  const { t } = useTranslation('changes');
  if (model.writing === null) return null;
  return (
    <span className="commit-status">
      <Spinner size="small" />
      <span id={id} role="status" className="commit-status__text">
        {t('commit.writing', { service: t(`commit.serviceStart.${model.ai.service}`) })}
      </span>
      {model.writing === 'waiting' && (
        <Button variant="link" onPress={model.chooseTemplate}>
          {t('commit.useTemplate')}
        </Button>
      )}
    </span>
  );
}

/** "Written by DeepSeek. Change anything you like.", until a field is edited (§4.2). */
function WrittenNote({ model }: { model: CommitBoxModel }) {
  const { t } = useTranslation('changes');
  return (
    <p className="commit-written">
      <Sparkles aria-hidden size={SIZE.iconSmall} className="commit-written__icon" />
      <span>{t('commit.written', { service: t(`commit.service.${model.ai.service}`) })}</span>
    </p>
  );
}

/**
 * Why Generate failed (§4.3): the warning note with "Try again" (or "AI settings" when the key is
 * the problem) and "Use template"; the fields are as they were.
 */
function AiFailureNote({ model, code }: { model: CommitBoxModel; code: CommitFailure['error']['code'] }) {
  const { t } = useTranslation(['changes', 'errors', 'shell']);
  const canSettings = useCanOpenDialog('appSettings');
  const key = fallbackCode(code);
  const service = t(`commit.serviceStart.${model.ai.service}`);
  const settings = key === 'AiRejected' || key === 'AiCredential';
  return (
    <Banner
      tone="warning"
      size="block"
      announce
      title={t(`commit.aiFailed.${key}.title`, { service })}
      text={key === 'unknown' ? t(`errors:${code}`) : t(`commit.aiFailed.${key}.text`)}
      actions={
        <>
          {settings ? (
            canSettings && (
              <Button variant="link" onPress={openAiSettings}>
                {t('commit.aiSettingsLink')}
              </Button>
            )
          ) : (
            <Button variant="link" onPress={model.generate}>
              {t('shell:tryAgain')}
            </Button>
          )}
          <Button variant="link" onPress={model.chooseTemplate}>
            {t('commit.useTemplate')}
          </Button>
        </>
      }
    />
  );
}

/** The AI's note under the fields: what it wrote, or why it could not (§4.2, §4.3). */
export function AiNoteView({ model }: { model: CommitBoxModel }) {
  const { aiNote } = model;
  if (aiNote === null) return null;
  return aiNote.kind === 'written' ? <WrittenNote model={model} /> : <AiFailureNote model={model} code={aiNote.error.code} />;
}

/** The controls of the commit box and bar that take the focus back, marked `data-commit-focus`. */
export type CommitFocusTarget = 'summary' | 'description' | 'message' | 'commit';

/**
 * Where the commit box keeps the focus when the control that had it goes: Generate's Stop button
 * while it writes, the commit button while a commit runs (§4.4), otherwise the summary field.
 */
function keptTarget(run: CommitBoxModel['run']): CommitFocusTarget {
  return run === 'generating' ? 'message' : run === 'idle' ? 'summary' : 'commit';
}

/** The commit box's control that `element` is or is in (the options chevron: the message button). */
export function commitFocusTargetOf(element: Element): CommitFocusTarget | null {
  const marked = element.closest('[data-commit-focus]')?.getAttribute('data-commit-focus');
  if (marked === 'summary' || marked === 'description' || marked === 'message' || marked === 'commit') return marked;
  return element.closest('.commit-message') === null ? null : 'message';
}

/**
 * Focuses `wanted` in the commit box or bar `box` when it is there and shown (the bar's closed
 * description is not), else the control the box keeps the focus on during `run` (`keptTarget`).
 * The box and the bar mark the same controls, so the focus crosses the view's breakpoint with them.
 */
export function focusInCommitBox(box: Element, wanted: CommitFocusTarget | null, run: CommitBoxModel['run']): void {
  const find = (target: CommitFocusTarget) => box.querySelector<HTMLElement>(`[data-commit-focus="${target}"]`);
  const found = wanted === null ? null : find(wanted);
  const shown = found !== null && found.closest('.commit-bar__description:not([data-open])') === null;
  (shown ? found : find(keptTarget(run)))?.focus();
}

/**
 * Keeps the focus in the commit box (wide) or bar (narrow) when React removes the control that had
 * it (WCAG 2.4.3, `useFocusKeeper`): Generate's Stop button while it writes (a note's "Try again"),
 * the commit button while a commit runs (§4.4: the waiting commit's "Use template", the message
 * button a waiting commit hides, a failure note's "Copy details" that a new commit takes away), and
 * otherwise the summary field (a note's "Use template" wrote the template there). Without it the
 * focus falls to the page, where Esc and Ctrl+Enter no longer reach the view. A callback ref for
 * the box's element. When the whole box goes (the window crosses the view's breakpoint), the view
 * moves the focus (ChangesView).
 */
export function useCommitBoxFocus(model: CommitBoxModel): (part: HTMLElement | null) => (() => void) | undefined {
  const box = useRef<HTMLElement | null>(null);
  const keep = useFocusKeeper(() => {
    if (box.current !== null) focusInCommitBox(box.current, null, model.run);
  });
  return useCallback(
    (part: HTMLElement | null) => {
      box.current = part;
      return keep(part);
    },
    [keep],
  );
}

/** Esc stops Generate (§4.2, §13): the commit box's keys, wherever its focus is. */
export function onCommitBoxKey(model: CommitBoxModel) {
  return (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== 'Escape' || model.writing !== 'generating') return;
    event.preventDefault();
    event.stopPropagation();
    model.stop();
  };
}

function labelText(label: CommitLabel, t: ChangesT): string {
  switch (label.kind) {
    case 'commit':
      return label.count === null ? t('commit.buttonUnknown') : t('commit.button', { count: label.count });
    case 'nothingSelected':
      return t('commit.nothingSelected');
    case 'nothingToCommit':
      return t('commit.nothingToCommit');
    case 'writing':
      return t('commit.writingMessage');
    case 'committing':
      return t('commit.committing');
  }
}

/**
 * The commit button (§4.1, §4.4): "Commit 9 changes" and "Ctrl+Enter", full width; the shortcut is
 * its description. When it cannot commit it is pending, not disabled: `aria-disabled` with the
 * disabled look, still in the tab order so its words are heard, and it keeps the focus through a
 * commit (§4.2, §4.4); the shortcut, which does nothing then, goes. Its description then says why
 * (§17): the line under it while committing waits (`model.block`, `BlockLine`), the list's failure
 * title when the changes could not be read (the list shows it, with Try again), or the AI's status
 * while Generate writes the fields.
 */
export function CommitButton({ model, ids }: { model: CommitBoxModel; ids: CommitIds }) {
  const { t } = useTranslation(['changes', 'errors', 'shell']);
  const shortcut = useShortcutLabel();
  const keysId = useId();
  const { label, block } = model;
  const waits = label.kind === 'commit' && block === null;
  const keys = waits && model.canCommit;
  const describedBy = keys
    ? keysId
    : block !== null
      ? ids.reason
      : waits && model.loadFailed
        ? ids.unread
        : model.writing === 'generating'
          ? ids.status
          : undefined;
  return (
    <div className="commit-button">
      {model.loadFailed && (
        <span id={ids.unread} hidden>
          {t('states.loadFailed')}
        </span>
      )}
      <PendingButton
        id={ids.commit}
        variant="accent"
        pending={label.kind === 'committing' || label.kind === 'writing' ? labelText(label, t) : null}
        isPending={!model.canCommit}
        aria-describedby={describedBy}
        data-commit-focus="commit"
        onPress={model.commit}
      >
        <span className="commit-button__label">{labelText(label, t)}</span>
        {keys && (
          <span id={keysId} className="commit-button__keys" aria-hidden>
            {shortcut(COMMIT_KEYS)}
          </span>
        )}
      </PendingButton>
    </div>
  );
}

/** The danger note's words for a failed commit (§4.5), naming the file it failed on. */
function failureText(failure: CommitFailure, t: ChangesT): string {
  const { code } = failure.error;
  switch (code) {
    case 'FileChanged':
    case 'NotLocal':
    case 'InUse':
    case 'AccessDenied':
      return failure.file === null ? t(`errors:${code}`) : t(`commit.failed.${code}`, { name: nameOf(failure.file) });
    case 'WorkspaceChanged':
    case 'NothingToCommit':
    case 'DiskFull':
    case 'HistoryDamaged':
    case 'Busy':
      return t(`commit.failed.${code}`);
    case 'ReadOnly':
    case 'HistoryReadOnly':
      return t('commit.failed.ReadOnly');
    default:
      return t(`errors:${code}`);
  }
}

/**
 * "Couldn't commit" (§4.5): above the fields until the next commit, announced at once; "Copy
 * details" for the codes that point at a bug or a damaged history.
 */
export function FailureNote({ failure }: { failure: CommitFailure }) {
  const { t } = useTranslation(['changes', 'errors', 'shell']);
  const title = t('commit.failed.title');
  const details = hasDetails(failure.error);
  return (
    <Banner
      tone="danger"
      size="block"
      announce
      title={title}
      text={failureText(failure, t)}
      actions={
        details ? (
          <Button
            variant="link"
            onPress={() => {
              copyErrorDetails(title, failure.error);
            }}
          >
            {t('shell:copyDetails.action')}
          </Button>
        ) : undefined
      }
    />
  );
}

/**
 * Why committing waits (§4.2): a rebuild, a newer Folio, a history Folio cannot read; the commit
 * button's description (`id`).
 */
export function BlockLine({ block, id }: { block: CommitBlock; id: string }) {
  const { t } = useTranslation('changes');
  const Icon = block === 'readOnly' ? Lock : Info;
  return (
    <p id={id} className="commit-block">
      <Icon aria-hidden size={SIZE.iconSmall} className="commit-block__icon" />
      <span>{t(`commit.block.${block}`)}</span>
    </p>
  );
}
